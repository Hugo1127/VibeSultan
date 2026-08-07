import type { EntityKnowledgeRecord, KnowledgeOutcome } from "@vibesultan/agent-learning-core";
import type {
  ActionResult,
  GameAction,
  GameState,
  SceneSnapshot,
} from "../game/types.js";
import { formatTier } from "../game/cardTier.js";
import { config } from "../config.js";
import { shouldDeferChoiceAsStrategic, type OptionAltruismScore } from "../moral/choiceHeuristics.js";
import {
  cardFeaturesFromState,
  choiceEventFromState,
  eventFeaturesFromState,
  versionKeyFromState,
} from "./experienceAdapter.js";
import {
  cardKnowledgeKey,
  interactionKnowledgeKey,
  riteEventKey,
  type SultanEntityStores,
} from "./entityMemory.js";
import type { RiteSettlement } from "./episodeTracker.js";
import { isHostSideActionError } from "./hostActionErrors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function appendUnique(values: unknown, value: string, cap = 12): string[] {
  const current = Array.isArray(values)
    ? values.filter((item): item is string => typeof item === "string")
    : [];
  return [...new Set([...current, value])].slice(-cap);
}

export interface EntityKnowledgeUpdate {
  kind: "card" | "event" | "interaction";
  key: string;
  action: "touched" | "facts" | "evidence";
}

export interface ReliableCardInspection {
  uid: number | null;
  cardId: number | null;
  description: string;
}

function resolveVersion(
  stores: SultanEntityStores,
  state: GameState | null | undefined,
  gameFingerprint?: string | null,
) {
  const raw = versionKeyFromState(state, gameFingerprint);
  const configFingerprint =
    stores.fingerprints.observe(raw.configFingerprint) ?? raw.configFingerprint;
  return {
    ...raw,
    configFingerprint,
    gameFingerprint: gameFingerprint?.trim() || configFingerprint,
  };
}

export function touchEntitiesFromState(opts: {
  stores: SultanEntityStores;
  state: GameState | null | undefined;
  gameFingerprint?: string | null;
  runId?: string;
  /**
   * full: touch all visible cards/rites (startup inventory).
   * action: touch hand cards + currentRite only (avoid encounter spam on every op).
   * none: skip automatic touches (caller touches targeted entities).
   */
  mode?: "full" | "action" | "none";
  /** When set, also touch these riteIds (e.g. open_rite targets). */
  extraRiteIds?: number[];
}): EntityKnowledgeUpdate[] {
  const mode = opts.mode ?? "full";
  if (mode === "none") return [];
  const version = resolveVersion(opts.stores, opts.state, opts.gameFingerprint);
  const updates: EntityKnowledgeUpdate[] = [];
  for (const card of cardFeaturesFromState(opts.state)) {
    if (card.cardId == null) continue;
    const key = cardKnowledgeKey(version.configFingerprint, card.cardId);
    const existing = opts.stores.cards.get(key, version);
    opts.stores.cards.touch({
      key,
      kind: "card",
      version,
      facts: {
        cardId: card.cardId,
        name: card.name,
        type: card.type,
        rare: card.rare,
        ...(existing ? {} : { unknowns: ["usage_unknown"] }),
      },
      runId: opts.runId,
    }, {
      actor: "sultan_entity_adapter",
      reason: "card_observed",
      runId: opts.runId,
    });
    updates.push({ kind: "card", key, action: "touched" });
  }

  const allEvents = eventFeaturesFromState(opts.state);
  const current = currentRite(opts.state);
  const allowedRiteIds = new Set<number>();
  if (mode === "full") {
    for (const event of allEvents) {
      if (event.riteId != null) allowedRiteIds.add(event.riteId);
    }
  } else {
    if (current?.id != null) allowedRiteIds.add(current.id);
    for (const id of opts.extraRiteIds ?? []) allowedRiteIds.add(id);
  }

  for (const event of allEvents) {
    if (event.riteId == null) continue;
    if (!allowedRiteIds.has(event.riteId)) continue;
    const key = riteEventKey(version.configFingerprint, event.riteId);
    const existing = opts.stores.events.get(key, version);
    const existingSlots = Array.isArray(existing?.facts.slots)
      ? existing.facts.slots
      : [];
    const slots =
      event.slots && event.slots.length > 0
        ? event.slots
        : existingSlots;
    opts.stores.events.touch({
      key,
      kind: "event",
      version,
      facts: {
        eventKey: key,
        eventKind: "rite",
        riteId: event.riteId,
        name: event.name,
        identityQuality: "stable",
        life: event.life,
        slots,
        ...(existing ? {} : { unknowns: ["route_unknown"] }),
      },
      runId: opts.runId,
    }, {
      actor: "sultan_entity_adapter",
      reason: "rite_observed",
      runId: opts.runId,
    });
    updates.push({ kind: "event", key, action: "touched" });

    for (const slot of event.slots ?? []) {
      const occupant = slot.occupant;
      if (!slot.occupied || occupant?.cardId == null) continue;
      const cardKey = cardKnowledgeKey(
        version.configFingerprint,
        occupant.cardId,
      );
      const existingCard = opts.stores.cards.get(cardKey, version);
      const occupantTags = isRecord(occupant.tags) ? occupant.tags : undefined;
      opts.stores.cards.touch({
        key: cardKey,
        kind: "card",
        version,
        facts: {
          cardId: occupant.cardId,
          name: occupant.name,
          type: occupant.type,
          rare: occupant.rare,
          ...(occupantTags ? { tags: occupantTags } : {}),
          ...(existingCard ? {} : { unknowns: ["usage_unknown"] }),
        },
        runId: opts.runId,
      }, {
        actor: "sultan_entity_adapter",
        reason: "rite_slot_occupant_observed",
        runId: opts.runId,
      });
      if (occupantTags) {
        opts.stores.cards.upsertFacts(cardKey, version, {
          tags: occupantTags,
        }, {
          actor: "sultan_entity_adapter",
          reason: "rite_slot_occupant_tags",
          runId: opts.runId,
        });
        updates.push({ kind: "card", key: cardKey, action: "facts" });
      }
      updates.push({ kind: "card", key: cardKey, action: "touched" });
    }
  }

  const choice = choiceEventFromState(opts.state);
  if (choice) {
    const eventKey = rewriteChoiceKey(
      choice.eventKey,
      version.configFingerprint,
      opts.stores,
    );
    const existing = opts.stores.events.get(eventKey, version);
    opts.stores.events.touch({
      key: eventKey,
      kind: "event",
      version,
      facts: {
        eventKey,
        eventKind: "choice",
        prompt: choice.prompt,
        identityQuality: choice.identityQuality,
        options: choice.options,
        ...(existing ? {} : { unknowns: ["option_outcomes_unknown"] }),
      },
      runId: opts.runId,
    }, {
      actor: "sultan_entity_adapter",
      reason: "choice_observed",
      runId: opts.runId,
    });
    updates.push({ kind: "event", key: eventKey, action: "touched" });
  }
  return updates;
}

/**
 * Accept an inspect only when the submitted action succeeded, its target can
 * be identified, and Observer returned card-specific detail rather than a HUD dump.
 */
export function reliableCardInspection(opts: {
  action: GameAction;
  result?: ActionResult | null;
  stateBefore?: GameState | null;
  sceneAfter?: SceneSnapshot | null;
}): ReliableCardInspection | null {
  if (opts.action.op !== "inspect_card" || opts.result?.ok !== true) return null;
  const fromState = cardForAction(opts.stateBefore, opts.action);
  const fromResult = cardFromInspectResult(opts.result);
  const uid = fromState?.uid ?? fromResult?.uid ?? null;
  const cardId = fromState?.cardId ?? fromResult?.cardId ?? null;
  if (uid == null && cardId == null) return null;
  const description =
    inspectSummary(opts.sceneAfter) ?? cardSummaryFromResultDetail(opts.result.detail);
  return description ? { uid, cardId, description } : null;
}

export function recordEntityKnowledge(opts: {
  stores: SultanEntityStores;
  stateBefore: GameState | null | undefined;
  stateAfter: GameState | null | undefined;
  sceneAfter?: SceneSnapshot | null;
  actions: GameAction[];
  results: ActionResult[];
  experienceIds?: string[];
  gameFingerprint?: string | null;
  runId?: string;
  socialCapitalEnabled?: boolean;
  /** Pre-resolved altruism scores for the active choice event. */
  altruismScores?: OptionAltruismScore[] | null;
}): EntityKnowledgeUpdate[] {
  const openRiteIds: number[] = [];
  for (const action of opts.actions) {
    if (action.op !== "open_rite") continue;
    const uid = asNumber(action.uid) ?? asNumber(action.riteId);
    // Prefer stable riteId from after-state map when only uid is provided.
    const rites = eventFeaturesFromState(opts.stateAfter ?? opts.stateBefore);
    const byUid = uid != null ? rites.find((r) => r.riteUid === uid) : null;
    const riteId = asNumber(action.riteId) ?? byUid?.riteId ?? null;
    if (riteId != null) openRiteIds.push(riteId);
  }
  const updates = [
    ...touchEntitiesFromState({
      stores: opts.stores,
      state: opts.stateAfter ?? opts.stateBefore,
      gameFingerprint: opts.gameFingerprint,
      runId: opts.runId,
      // Avoid +1 encounter on every continue/cancel against the whole map.
      mode: "action",
      extraRiteIds: openRiteIds,
    }),
  ];
  const version = resolveVersion(
    opts.stores,
    opts.stateBefore ?? opts.stateAfter,
    opts.gameFingerprint,
  );

  opts.actions.forEach((action, index) => {
    const result = opts.results[index] ?? opts.results[0];
    const sourceId = opts.experienceIds?.[index] ?? opts.experienceIds?.[0];
    const hostNoise =
      result?.ok === false && isHostSideActionError(result.error);
    // Host preflight / planner errors are not game outcomes — never count as negative.
    const resultOutcome: KnowledgeOutcome = hostNoise
      ? "inconclusive"
      : result?.ok === false
        ? "negative"
        : "inconclusive";

    if (action.op === "inspect_card") {
      const fromState = cardForAction(opts.stateBefore, action);
      const fromResult = cardFromInspectResult(result);
      const reliable = reliableCardInspection({
        action,
        result,
        stateBefore: opts.stateBefore,
        sceneAfter: opts.sceneAfter,
      });
      const card =
        fromState?.cardId != null
          ? fromState
          : fromResult?.cardId != null
            ? fromResult
            : fromState ?? fromResult;
      if (card?.cardId == null) return;
      const key = cardKnowledgeKey(version.configFingerprint, card.cardId);
      // Ensure rite-seat / NPC cards are touched even when not in hand.
      opts.stores.cards.touch({
        key,
        kind: "card",
        version,
        facts: {
          cardId: card.cardId,
          unknowns: ["usage_unknown"],
        },
        runId: opts.runId,
      }, {
        actor: "sultan_entity_adapter",
        reason: "inspect_card_touch",
        runId: opts.runId,
      });
      const description = reliable?.description ?? null;
      if (description) {
        const tags = tagsFromSummaryText(description);
        opts.stores.cards.upsertFacts(key, version, {
          description,
          ...(tags ? { tags } : {}),
          unknowns: [],
        }, {
          actor: "sultan_entity_adapter",
          reason: "inspect_card_text",
          runId: opts.runId,
        });
        updates.push({ kind: "card", key, action: "facts" });
      }
      addEvidence(opts.stores.cards, key, version, {
        outcome: resultOutcome,
        summary: result?.ok === false ? `inspect failed: ${result.error ?? "unknown"}` : "card inspected",
        context: { op: action.op, detailReliable: Boolean(description) },
        sourceId,
        runId: opts.runId,
      });
      updates.push({ kind: "card", key, action: "evidence" });
      return;
    }

    if (action.op === "equip_item" || action.op === "unequip_item") {
      const characterUid =
        asNumber(action.characterUid) ?? asNumber(action.charUid) ?? asNumber(action.targetUid);
      const itemUid =
        asNumber(action.itemUid) ?? asNumber(action.uid) ?? asNumber(action.cardId);
      const stateForCards = opts.stateAfter ?? opts.stateBefore;
      const characterRef = characterUid != null ? cardByReference(stateForCards, characterUid) : null;
      const itemRef = itemUid != null ? cardByReference(stateForCards, itemUid) : null;
      const characterRow = characterUid != null ? rawCardByUid(stateForCards, characterUid) : null;
      const characterCardId = characterRef?.cardId ?? null;
      const itemCardId = itemRef?.cardId ?? null;
      const slotType = asString(action.slotType);
      const ok = result?.ok !== false && !hostNoise;
      const equipOutcome: KnowledgeOutcome = hostNoise
        ? "inconclusive"
        : ok
          ? "positive"
          : "negative";
      const summary =
        action.op === "equip_item"
          ? hostNoise
            ? `equip host_reject: ${result?.error ?? "unknown"} (not game outcome)`
            : ok
              ? `equipped itemUid=${itemUid ?? "?"} on characterUid=${characterUid ?? "?"}`
              : `equip failed: ${result?.error ?? "unknown"}`
          : hostNoise
            ? `unequip host_reject: ${result?.error ?? "unknown"} (not game outcome)`
            : ok
              ? `unequipped itemUid=${itemUid ?? "?"} from characterUid=${characterUid ?? "?"}`
              : `unequip failed: ${result?.error ?? "unknown"}`;

      if (characterCardId != null) {
        const charKey = cardKnowledgeKey(version.configFingerprint, characterCardId);
        const equipped = Array.isArray(characterRow?.equipped) ? characterRow!.equipped : [];
        opts.stores.cards.upsertFacts(charKey, version, {
          equippedCount: equipped.length,
          ...(slotType ? { lastEquipSlotType: slotType } : {}),
          // Never treat catalog tag 已装备 as ownership; store relation from runtime actions.
          lastEquipRelation:
            action.op === "equip_item" && ok
              ? `wearing:itemUid=${itemUid}`
              : action.op === "unequip_item" && ok
                ? `removed:itemUid=${itemUid}`
                : undefined,
        }, {
          actor: "sultan_entity_adapter",
          reason: action.op,
          runId: opts.runId,
        });
        addEvidence(opts.stores.cards, charKey, version, {
          outcome: equipOutcome,
          summary,
          context: {
            op: action.op,
            characterUid,
            itemUid,
            itemCardId,
            slotType,
          },
          sourceId,
          runId: opts.runId,
        });
        updates.push({ kind: "card", key: charKey, action: "facts" });
        updates.push({ kind: "card", key: charKey, action: "evidence" });
      }

      if (itemCardId != null) {
        const itemKey = cardKnowledgeKey(version.configFingerprint, itemCardId);
        opts.stores.cards.upsertFacts(itemKey, version, {
          equippedOnCharacterUid: action.op === "equip_item" && ok ? characterUid : null,
          equippedOnCardId: action.op === "equip_item" && ok ? characterCardId : null,
          ...(slotType ? { equipSlotType: slotType } : {}),
        }, {
          actor: "sultan_entity_adapter",
          reason: action.op,
          runId: opts.runId,
        });
        addEvidence(opts.stores.cards, itemKey, version, {
          outcome: equipOutcome,
          summary,
          context: {
            op: action.op,
            characterUid,
            characterCardId,
            itemUid,
            slotType,
            ...(hostNoise ? { hostError: result?.error ?? null } : {}),
          },
          sourceId,
          runId: opts.runId,
        });
        updates.push({ kind: "card", key: itemKey, action: "facts" });
        updates.push({ kind: "card", key: itemKey, action: "evidence" });
      }
      return;
    }

    if (action.op === "select_event_option") {
      const choice = choiceEventFromState(opts.stateBefore);
      if (!choice) return;
      const eventKey = rewriteChoiceKey(
        choice.eventKey,
        version.configFingerprint,
        opts.stores,
      );
      const optionIndex =
        asNumber(action.optionIndex) ?? asNumber(action.index) ?? asNumber(action.optionId);
      const option = choice.options.find((item) => item.index === optionIndex);
      const effect = compareChoiceEffect(opts.stateBefore, opts.stateAfter, result);
      const socialEnabled =
        opts.socialCapitalEnabled ?? config.agentSocialCapitalEnabled;
      const optionLike = {
        index: optionIndex ?? -1,
        label: option?.label ?? null,
        tag: option?.tag ?? null,
      };
      const altruistic =
        socialEnabled &&
        shouldDeferChoiceAsStrategic(optionLike, {
          cached: opts.altruismScores,
          immediateNegative: effect.outcome === "negative",
        });
      // Defer negative attribution for altruistic spends until strategic settlement.
      const outcome =
        altruistic && effect.outcome === "negative" ? "inconclusive" : effect.outcome;
      const summary = `option ${optionIndex ?? "?"}: ${option?.label ?? "unknown"}`;
      const updatedOptions = choice.options.map((item) =>
        item.index === optionIndex
          ? {
              ...item,
              outcome,
              note: altruistic && effect.outcome === "negative"
                ? `${summary} (pending_strategic)`
                : summary,
              effect: effect.metrics,
            }
          : item,
      );
      opts.stores.events.upsertFacts(eventKey, version, {
        options: updatedOptions,
        lastEffect: effect.metrics,
        unknowns: updatedOptions.every((item) => "outcome" in item && item.outcome !== "inconclusive")
          ? []
          : ["option_outcomes_unknown"],
      }, {
        actor: "sultan_entity_adapter",
        reason: altruistic ? "choice_option_pending_strategic" : "choice_option_result",
        runId: opts.runId,
      });
      addEvidence(opts.stores.events, eventKey, version, {
        outcome,
        summary:
          altruistic && effect.outcome === "negative"
            ? `${summary} | pending_strategic`
            : summary,
        context: {
          optionIndex,
          optionLabel: option?.label ?? null,
          effect: effect.metrics,
          pendingStrategic: altruistic && effect.outcome === "negative",
        },
        sourceId,
        runId: opts.runId,
      });
      updateRouteFacts(opts.stores.events.get(eventKey, version), opts.stores.events, version, {
        outcome,
        summary,
        runId: opts.runId,
      });
      updates.push({ kind: "event", key: eventKey, action: "evidence" });
      return;
    }

    if (action.op === "place_card_on_rite") {
      const card = cardForAction(opts.stateBefore, action);
      const rite = currentRite(opts.stateBefore) ?? currentRite(opts.stateAfter);
      if (card?.cardId == null || rite?.id == null) return;
      const eventKey = riteEventKey(version.configFingerprint, rite.id);
      const slotIndex =
        asNumber(action.slotIndex) ?? asNumber(action.slotId) ?? asNumber(action.slot);
      const slot = rite.slots.find((item) => item.index === slotIndex);
      const key = interactionKnowledgeKey({
        configFingerprint: version.configFingerprint,
        cardId: card.cardId,
        eventKey,
        slotIndex,
        slotKey: slot?.slotKey,
      });
      opts.stores.interactions.touch({
        key,
        kind: "interaction",
        version,
        facts: {
          interactionKey: key,
          cardId: card.cardId,
          eventKey,
          slotIndex,
          slotKey: slot?.slotKey ?? null,
          conditions: compactConditions(opts.stateBefore),
        },
        runId: opts.runId,
      }, {
        actor: "sultan_entity_adapter",
        reason: "card_rite_assignment",
        runId: opts.runId,
      });
      addEvidence(opts.stores.interactions, key, version, {
        outcome: resultOutcome,
        summary: hostNoise
          ? `placement host_reject: ${result?.error ?? "unknown"} (not game outcome)`
          : result?.ok === false
            ? `placement failed: ${result.error ?? "unknown"}`
            : "placement accepted; awaiting rite result",
        context: {
          cardId: card.cardId,
          eventKey,
          slotIndex,
          ...(hostNoise ? { hostError: result?.error ?? null } : {}),
        },
        sourceId,
        runId: opts.runId,
      });
      updates.push({ kind: "interaction", key, action: "evidence" });

      // Mirror place → card entity so usages are not only inspect noise.
      const cardKey = cardKnowledgeKey(version.configFingerprint, card.cardId);
      opts.stores.cards.touch({
        key: cardKey,
        kind: "card",
        version,
        facts: {
          cardId: card.cardId,
          ...(card.name ? { name: card.name } : {}),
          ...(card.type ? { type: card.type } : {}),
          ...(card.rare != null ? { rare: card.rare } : {}),
        },
        runId: opts.runId,
      }, {
        actor: "sultan_entity_adapter",
        reason: "card_rite_assignment",
        runId: opts.runId,
      });
      const eventName = String(
        opts.stores.events.get(eventKey, version)?.facts.name ?? eventKey,
      );
      addEvidence(opts.stores.cards, cardKey, version, {
        outcome: resultOutcome,
        summary: hostNoise
          ? `placement host_reject on ${eventName}: ${result?.error ?? "unknown"} (not game outcome)`
          : result?.ok === false
            ? `placement failed on ${eventName}: ${result.error ?? "unknown"}`
            : `placed on ${eventName} / slot=${slot?.slotKey ?? slotIndex}; awaiting delayed outcome`,
        context: {
          cardId: card.cardId,
          eventKey,
          slotIndex,
          episodePending: true,
          ...(hostNoise ? { hostError: result?.error ?? null } : {}),
        },
        sourceId,
        runId: opts.runId,
      });
      updates.push({ kind: "card", key: cardKey, action: "evidence" });
    }
  });
  return updates;
}

/** Strip placeholder UI tips (e.g. NewText) before writing entity facts. */
export function sanitizeRiteResultForMemory(
  result: Record<string, unknown> | null | undefined,
  eventName?: string | null,
): Record<string, unknown> {
  const next = { ...(result ?? {}) };
  const tip = String(next.tip ?? "").trim();
  if (!tip || /^new\s*text$/i.test(tip)) {
    next.tip = null;
  }
  if (eventName && typeof eventName === "string") {
    next.title = eventName;
  }
  if (typeof next.summary === "string") {
    next.summary = next.summary.replace(/\bNewText\b/gi, "").trim();
  }
  return next;
}

/** Apply one deterministic rite settlement to all linked knowledge entities. */
export function applyRiteSettlement(opts: {
  stores: SultanEntityStores;
  settlement: RiteSettlement;
  runId?: string;
}): EntityKnowledgeUpdate[] {
  const { episode, outcome, summary, result } = opts.settlement;
  if (outcome === "inconclusive") return [];
  if (episode.quarantined === true || result?.titleMismatch === true) {
    return [];
  }
  const updates: EntityKnowledgeUpdate[] = [];
  const configFingerprint = opts.stores.fingerprints.resolve(
    episode.version.configFingerprint,
  );
  const version = {
    ...episode.version,
    configFingerprint,
  };
  const eventKey = opts.stores.fingerprints.rewriteKey(episode.eventKey, configFingerprint);

  const event = getWithAlias(opts.stores.events, eventKey, version, opts.stores);
  const cleanResult = sanitizeRiteResultForMemory(
    result,
    typeof event?.facts?.name === "string" ? event.facts.name : null,
  );
  if (event && !hasEvidenceSource(event, episode.id)) {
    addEvidence(opts.stores.events, event.key, event.version, {
      outcome,
      summary,
      context: {
        episodeId: episode.id,
        composition: episode.composition,
        riteResult: cleanResult,
      },
      sourceId: episode.id,
      runId: opts.runId ?? episode.runId,
    });
    updateRouteFacts(opts.stores.events.get(event.key, event.version), opts.stores.events, event.version, {
      outcome,
      summary: `${compositionSummary(episode.composition)} | ${summary}`,
      runId: opts.runId ?? episode.runId,
    });
    opts.stores.events.upsertFacts(event.key, event.version, {
      lastResult: cleanResult,
      rewardSummary: cleanResult.rewardSummary ?? null,
    }, {
      actor: "sultan_episode_settlement",
      reason: "rite_result",
      runId: opts.runId ?? episode.runId,
    });
    updates.push({ kind: "event", key: event.key, action: "evidence" });
  }

  for (const assignment of episode.composition) {
    if (assignment.empty || assignment.cardId == null || assignment.cardId === 0) {
      continue;
    }
    const interactionKey = opts.stores.fingerprints.rewriteKey(
      assignment.interactionKey,
      configFingerprint,
    );
    const interaction = getWithAlias(
      opts.stores.interactions,
      interactionKey,
      version,
      opts.stores,
    );
    if (interaction && !hasEvidenceSource(interaction, episode.id)) {
      const interactionSummary = `${summary}; slot=${assignment.slotKey ?? assignment.slotIndex}`;
      addEvidence(opts.stores.interactions, interaction.key, interaction.version, {
        outcome,
        summary: interactionSummary,
        context: { episodeId: episode.id, ...assignment },
        sourceId: episode.id,
        runId: opts.runId ?? episode.runId,
      });
      if (outcome === "positive" || outcome === "negative") {
        const field = outcome === "positive" ? "bestPractices" : "failureModes";
        opts.stores.interactions.upsertFacts(interaction.key, interaction.version, {
          [field]: appendUnique(interaction.facts[field], interactionSummary),
        }, {
          actor: "sultan_episode_settlement",
          reason: `interaction_${outcome}`,
          runId: opts.runId ?? episode.runId,
        });
      }
      updates.push({
        kind: "interaction",
        key: interaction.key,
        action: "evidence",
      });
    }

    const cardKey = cardKnowledgeKey(configFingerprint, assignment.cardId);
    const card = getWithAlias(opts.stores.cards, cardKey, version, opts.stores);
    if (!card || hasEvidenceSource(card, episode.id)) continue;
    const eventName = String(event?.facts.name ?? eventKey);
    const input = compositionSummary(episode.composition);
    const tier = formatTier(card.facts.rare);
    const usage =
      `${eventName} / slot=${assignment.slotKey ?? assignment.slotIndex}` +
      `${tier ? ` / tier=${tier}` : ""} / ${input}: ${summary}`;
    addEvidence(opts.stores.cards, card.key, card.version, {
      outcome,
      summary: usage,
      context: {
        episodeId: episode.id,
        eventKey,
        inputComposition: episode.composition,
        ...assignment,
      },
      sourceId: episode.id,
      runId: opts.runId ?? episode.runId,
    });
    if (outcome === "positive" || outcome === "negative") {
      const field = outcome === "positive" ? "usages" : "antiPatterns";
      opts.stores.cards.upsertFacts(card.key, card.version, {
        [field]: appendUnique(card.facts[field], usage),
        unknowns: [],
      }, {
        actor: "sultan_episode_settlement",
        reason: `card_${outcome}`,
        runId: opts.runId ?? episode.runId,
      });
    }
    updates.push({ kind: "card", key: card.key, action: "evidence" });
  }
  return updates;
}

export function enrichmentTargetsFromUpdates(
  stores: SultanEntityStores,
  updates: EntityKnowledgeUpdate[],
): Array<{
  entityKind: "card" | "event" | "interaction";
  key: string;
  version: EntityKnowledgeRecord["version"];
  generation: string;
  evidenceSnapshot: Record<string, unknown>;
}> {
  const seen = new Set<string>();
  const targets = [];
  for (const update of updates) {
    if (update.action === "touched") continue;
    const dedupe = `${update.kind}:${update.key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const store =
      update.kind === "card"
        ? stores.cards
        : update.kind === "event"
          ? stores.events
          : stores.interactions;
    const record = store.get(update.key);
    if (!record) continue;
    targets.push({
      entityKind: update.kind,
      key: record.key,
      version: record.version,
      generation: record.updatedAt,
      evidenceSnapshot: {
        facts: record.facts,
        status: record.status,
        sampleCount: record.sampleCount,
        positiveCount: record.positiveCount,
        negativeCount: record.negativeCount,
        recentEvidence: record.evidence.slice(-6),
      },
    });
  }
  return targets;
}

function compositionSummary(
  composition: Array<{
    cardId?: number | null;
    slotIndex: number;
    slotKey?: string | null;
    empty?: boolean;
  }>,
): string {
  return `composition=${composition
    .map((assignment) => {
      const slot = assignment.slotKey ?? assignment.slotIndex;
      if (assignment.empty || assignment.cardId == null || assignment.cardId === 0) {
        return `${slot}:empty`;
      }
      return `${slot}:${assignment.cardId}`;
    })
    .join(",") || "empty"}`;
}

function addEvidence(
  store: SultanEntityStores["cards"],
  key: string,
  version: ReturnType<typeof versionKeyFromState>,
  input: Parameters<SultanEntityStores["cards"]["addEvidence"]>[2],
): void {
  const current = store.get(key, version);
  if (current && input.sourceId && hasEvidenceSource(current, input.sourceId)) return;
  store.addEvidence(key, version, input, {
    actor: "sultan_entity_adapter",
    reason: "action_evidence",
    runId: input.runId,
  });
}

function hasEvidenceSource(record: EntityKnowledgeRecord, sourceId: string): boolean {
  return record.evidence.some((row) => row.sourceId === sourceId);
}

function updateRouteFacts(
  record: EntityKnowledgeRecord | undefined,
  store: SultanEntityStores["events"],
  version: ReturnType<typeof versionKeyFromState>,
  opts: { outcome: KnowledgeOutcome; summary: string; runId?: string },
): void {
  if (!record || opts.outcome === "inconclusive") return;
  const field = opts.outcome === "positive" ? "successfulRoutes" : "failureModes";
  store.upsertFacts(record.key, version, {
    [field]: appendUnique(record.facts[field], opts.summary),
    ...(record.facts.eventKind === "rite" ? { unknowns: [] } : {}),
  }, {
    actor: "sultan_entity_adapter",
    reason: `event_${opts.outcome}`,
    runId: opts.runId,
  });
}

export function compareChoiceEffect(
  before: GameState | null | undefined,
  after: GameState | null | undefined,
  result: ActionResult | undefined,
): { outcome: KnowledgeOutcome; metrics: Record<string, unknown> } {
  if (result?.ok === false || after?.terminal === true || after?.values?.terminal === true) {
    return {
      outcome: "negative",
      metrics: { terminal: true, actionOk: result?.ok !== false },
    };
  }
  const metrics = {
    resources: numericMapDelta(before?.values?.resources, after?.values?.resources),
    counters: numericMapDelta(before?.values?.counters, after?.values?.counters),
    cardCountDelta: listCount(after?.values?.cards) - listCount(before?.values?.cards),
    questChanged: !shallowEqual(
      before?.values?.questSummary,
      after?.values?.questSummary,
    ),
    stateDeltaChanged: result?.stateDelta?.changed === true,
  };
  let score = 0;
  for (const delta of Object.values(metrics.resources)) score += Math.sign(delta);
  for (const delta of Object.values(metrics.counters)) score += Math.sign(delta);
  score += Math.sign(metrics.cardCountDelta);
  if (metrics.questChanged) score += 0;
  if (score > 0) return { outcome: "positive", metrics };
  if (score < 0) return { outcome: "negative", metrics };
  return { outcome: "inconclusive", metrics };
}

function numericMapDelta(
  before: unknown,
  after: unknown,
): Record<string, number> {
  const a = isRecord(before) ? before : {};
  const b = isRecord(after) ? after : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, number> = {};
  for (const key of keys) {
    const left = asNumber(a[key]) ?? 0;
    const right = asNumber(b[key]) ?? 0;
    if (left !== right) out[key] = right - left;
  }
  return out;
}

function listCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function cardForAction(
  state: GameState | null | undefined,
  action: GameAction,
): {
  uid: number | null;
  cardId: number | null;
  name?: string | null;
  type?: string | null;
  rare?: number | null;
} | null {
  const uid = asNumber(action.uid) ?? asNumber(action.cardId) ?? asNumber(action.card);
  if (uid == null) return null;
  return cardByReference(state, uid) ?? {
    uid,
    cardId: asNumber(action.cardId) ?? asNumber(action.id),
  };
}

function cardFromInspectResult(
  result: ActionResult | undefined,
): { uid: number | null; cardId: number | null } | null {
  const detail = typeof result?.detail === "string" ? result.detail : "";
  const uidMatch = detail.match(/\buid=(\d+)/i);
  const idMatch = detail.match(/\bid=(\d+)/i);
  const uid = uidMatch ? Number(uidMatch[1]) : null;
  const cardId = idMatch ? Number(idMatch[1]) : null;
  if (uid == null && cardId == null) return null;
  return { uid, cardId };
}

function cardSummaryFromResultDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const match = detail.match(/cardSummary=\{([^}]*)\}/);
  if (!match?.[1]) return null;
  const text = match[1].trim();
  if (!text) return null;
  // Structured cardSummary often repeats the card name (e.g. 金币) in name/text/tags.
  // HUD detection must use the prose field only, or currency/sudan cards never verify.
  const prose = extractCardSummaryProse(text);
  if (looksLikeHudDump(prose || text)) return null;
  return text.slice(0, 600);
}

/** Prefer the human-readable `text=` field inside a cardSummary blob. */
export function extractCardSummaryProse(summary: string): string | null {
  const match = summary.match(/(?:^|;\s*)text=([^;]*)/i);
  const prose = match?.[1]?.trim();
  return prose ? prose : null;
}

/** Parse `tags=智慧:2,贵族:1` from a cardSummary detail string. */
export function tagsFromSummaryText(
  summary: string | null | undefined,
): Record<string, number> | undefined {
  if (!summary) return undefined;
  const match = summary.match(/(?:^|;\s*)tags=([^;]+)/i);
  if (!match?.[1]) return undefined;
  const tags: Record<string, number> = {};
  for (const part of match[1].split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sep = trimmed.lastIndexOf(":");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = Number(trimmed.slice(sep + 1).trim());
    if (!key || !Number.isFinite(value) || value === 0) continue;
    tags[key] = value;
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function cardByReference(
  state: GameState | null | undefined,
  reference: number,
): {
  uid: number | null;
  cardId: number | null;
  name?: string | null;
  type?: string | null;
  rare?: number | null;
} | null {
  const raw = rawCardByUid(state, reference);
  if (!raw) return null;
  return {
    uid: asNumber(raw.uid),
    cardId: asNumber(raw.id),
    name: asString(raw.name) ?? asString(raw.customName),
    type: asString(raw.type),
    rare: asNumber(raw.rare),
  };
}

function rawCardByUid(
  state: GameState | null | undefined,
  reference: number,
): Record<string, unknown> | null {
  const cards = Array.isArray(state?.values?.cards)
    ? state!.values!.cards!
    : Array.isArray(state?.cards)
      ? state!.cards
      : [];
  for (const raw of cards as unknown[]) {
    if (!isRecord(raw)) continue;
    const uid = asNumber(raw.uid);
    const cardId = asNumber(raw.id);
    if (uid !== reference && cardId !== reference) continue;
    return raw;
  }
  return null;
}

function currentRite(state: GameState | null | undefined): {
  id: number | null;
  slots: Array<{
    index: number;
    slotKey: string | null;
    cardUid: number | null;
  }>;
} | null {
  const current = state?.values?.currentRite;
  if (!isRecord(current)) return null;
  const slots = Array.isArray(current.slots)
    ? current.slots.filter(isRecord).map((slot, index) => ({
        index: asNumber(slot.index) ?? index,
        slotKey: asString(slot.slotKey),
        cardUid: asNumber(slot.cardUid),
      }))
    : [];
  return { id: asNumber(current.id), slots };
}

function compactConditions(state: GameState | null | undefined): string[] {
  const day = asNumber(state?.values?.day);
  const phase = asString(state?.screen?.phase);
  return [
    day != null ? `day=${day}` : null,
    phase ? `phase=${phase}` : null,
  ].filter((value): value is string => Boolean(value));
}

/** Only accept card-detail / 俺寻思 overlays — never full-screen HUD dumps. */
export function inspectSummary(scene: SceneSnapshot | null | undefined): string | null {
  if (!scene) return null;
  const instruction = scene.instruction;
  const source = `${instruction?.source ?? ""} ${instruction?.type ?? ""}`.toLowerCase();
  const instructionText = asString(instruction?.text);
  const instructionHint = asString(instruction?.hint);
  const instructionLooksCard =
    /card|detail|inspect|tooltip|俺寻思|说明|卡牌/.test(source) ||
    (/俺寻思|卡牌说明|卡片说明/.test(`${instructionText ?? ""} ${instructionHint ?? ""}`) &&
      !looksLikeHudDump(`${instructionText ?? ""}|${instructionHint ?? ""}`));

  const elements = (scene.elements ?? []).filter((element) => {
    const blob = [
      element.role,
      element.name,
      element.path,
      element.overlayId,
      element.text,
    ]
      .filter(Boolean)
      .join("|")
      .toLowerCase();
    return /card|detail|inspect|tooltip|俺寻思|说明/.test(blob);
  });

  const values: string[] = [];
  if (instructionLooksCard) {
    if (instructionText) values.push(instructionText);
    if (instructionHint) values.push(instructionHint);
  }
  for (const element of elements.slice(0, 6)) {
    const text = asString(element.text) ?? asString(element.name);
    if (text && !looksLikeHudDump(text)) values.push(text);
  }
  if (values.length === 0) return null;
  const joined = [...new Set(values)].join(" | ").slice(0, 600);
  return looksLikeHudDump(joined) ? null : joined;
}

function looksLikeHudDump(text: string): boolean {
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 6) return true;
  if (text.length > 420) return true;
  // Require several *distinct* HUD chrome tokens. Repeating "金币"/"苏丹" inside a
  // single card blurb is normal and must not reject inspect evidence.
  const kinds = new Set<string>();
  for (const match of text.matchAll(/金币|影响力|回合|天数|手牌|苏丹|继续|下一天/g)) {
    kinds.add(match[0]!);
  }
  return kinds.size >= 3;
}

function rewriteChoiceKey(
  eventKey: string,
  canonicalFingerprint: string,
  stores: SultanEntityStores,
): string {
  return stores.fingerprints.rewriteKey(eventKey, canonicalFingerprint);
}

function getWithAlias(
  store: SultanEntityStores["cards"],
  key: string,
  version: ReturnType<typeof versionKeyFromState>,
  stores: SultanEntityStores,
): EntityKnowledgeRecord | undefined {
  const direct = store.get(key, version);
  if (direct) return direct;
  for (const aliasKey of stores.fingerprints.expandKeys([key])) {
    for (const fp of stores.fingerprints.expand(version.configFingerprint)) {
      const candidate = store.get(aliasKey, {
        ...version,
        configFingerprint: fp,
        gameFingerprint: version.gameFingerprint,
      });
      if (candidate) return candidate;
      const loose = store.get(aliasKey);
      if (loose) return loose;
    }
  }
  return store.get(key);
}
