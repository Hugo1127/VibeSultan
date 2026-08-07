import type { ActionResult, GameAction, GameState } from "../game/types.js";
import { config } from "../config.js";
import {
  shouldDeferChoiceAsStrategic,
  type OptionAltruismScore,
} from "../moral/choiceHeuristics.js";
import { defaultStrategicTargets } from "../moral/keyFollowers.js";
import { versionKeyFromState } from "./experienceAdapter.js";
import {
  interactionKnowledgeKey,
  riteEventKey,
} from "./entityMemory.js";
import type { FingerprintAliasStore } from "./fingerprintAlias.js";
import { captureEpisodeSnapshot } from "./episodeOutcome.js";
import type { EpisodeAssignment } from "./episodeStore.js";
import type { EpisodeTracker } from "./episodeTracker.js";
import { choiceEventFromState } from "./experienceAdapter.js";
import { compareChoiceEffect } from "./entityAdapter.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function recordEpisodeActions(opts: {
  tracker: EpisodeTracker;
  stateBefore: GameState | null | undefined;
  stateAfter: GameState | null | undefined;
  actions: GameAction[];
  results: ActionResult[];
  experienceIds?: string[];
  gameFingerprint?: string | null;
  fingerprints?: FingerprintAliasStore | null;
  allocations?: Array<{ cardUid: number; riteUid: number; slotIndex: number }>;
  runId?: string;
  step?: number;
  /** When set, episode evidence is branch-scoped (rewound branches stay quarantined). */
  branchId?: string | null;
  socialCapitalEnabled?: boolean;
  /** Pre-resolved altruism scores for the active choice event. */
  altruismScores?: OptionAltruismScore[] | null;
}): void {
  const rawVersion = versionKeyFromState(
    opts.stateBefore ?? opts.stateAfter,
    opts.gameFingerprint,
  );
  const configFingerprint =
    opts.fingerprints?.observe(rawVersion.configFingerprint) ??
    rawVersion.configFingerprint;
  const version = {
    ...rawVersion,
    configFingerprint,
    gameFingerprint: opts.gameFingerprint?.trim() || configFingerprint,
  };
  const day = asNumber(opts.stateBefore?.values?.day);

  opts.actions.forEach((action, index) => {
    const result = opts.results[index] ?? opts.results[0];
    if (result?.ok === false) return;
    const experienceId = opts.experienceIds?.[index] ?? opts.experienceIds?.[0];

    if (action.op === "place_card_on_rite") {
      const rite =
        currentRite(opts.stateAfter) ??
        currentRite(opts.stateBefore) ??
        riteFromMap(opts.stateAfter, null) ??
        riteFromMap(opts.stateBefore, null);
      const card = cardForAction(opts.stateBefore, action);
      const slotIndex =
        asNumber(action.slotIndex) ?? asNumber(action.slotId) ?? asNumber(action.slot);
      if (rite?.riteId == null || card?.cardId == null || slotIndex == null) return;
      const slot = rite.slots.find((item) => item.index === slotIndex);
      const eventKey = riteEventKey(configFingerprint, rite.riteId);
      const interactionKey = interactionKnowledgeKey({
        configFingerprint,
        cardId: card.cardId,
        eventKey,
        slotIndex,
        slotKey: slot?.slotKey,
      });
      const count = asNumber(action.count) ?? card.count ?? null;
      opts.tracker.recordPlacement({
        version,
        eventKey,
        riteId: rite.riteId,
        riteUid: rite.riteUid,
        assignment: {
          cardId: card.cardId,
          cardUid: card.cardUid,
          slotIndex,
          slotKey: slot?.slotKey,
          interactionKey,
          experienceId,
          count,
        },
        day,
        runId: opts.runId,
        step: opts.step,
        branchId: opts.branchId,
      });
      return;
    }

    if (action.op === "execute" || action.op === "start_rite") {
      const rite =
        currentRite(opts.stateBefore) ??
        riteFromMap(opts.stateBefore, null) ??
        currentRite(opts.stateAfter) ??
        riteFromMap(opts.stateAfter, null);
      const latestPlacement = opts.tracker.store
        .listOpen()
        .filter((episode) => episode.phase === "placement" || episode.phase === "submitted")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const riteId = rite?.riteId ?? latestPlacement?.riteId;
      if (riteId == null) return;
      const eventKey =
        latestPlacement?.eventKey ?? riteEventKey(configFingerprint, riteId);
      const fromAllocations = compositionFromAllocations(
        opts.allocations,
        opts.stateBefore ?? opts.stateAfter,
        eventKey,
        configFingerprint,
        rite?.riteUid ?? latestPlacement?.riteUid,
      );
      const fromRite = compositionFromRite(
        rite,
        opts.stateBefore ?? opts.stateAfter,
        eventKey,
        configFingerprint,
      );
      // Freeze execute-time occupancy (including empty player slots) and merge placements.
      const composition = mergeComposition(
        latestPlacement?.composition ?? [],
        fromRite.length ? fromRite : fromAllocations,
      );
      opts.tracker.recordSubmit({
        version,
        eventKey,
        riteId,
        riteUid: rite?.riteUid ?? latestPlacement?.riteUid,
        composition,
        experienceId,
        day,
        runId: opts.runId,
        step: opts.step,
        state: opts.stateBefore ?? opts.stateAfter,
        baseline: captureEpisodeSnapshot(opts.stateBefore ?? opts.stateAfter),
        branchId: opts.branchId,
      });
      return;
    }

    if (
      action.op === "select_event_option" &&
      (opts.socialCapitalEnabled ?? config.agentSocialCapitalEnabled)
    ) {
      const choice = choiceEventFromState(opts.stateBefore);
      if (!choice) return;
      const optionIndex =
        asNumber(action.optionIndex) ?? asNumber(action.index) ?? asNumber(action.optionId);
      const option = choice.options.find((item) => item.index === optionIndex);
      const label = option?.label ?? null;
      const effect = compareChoiceEffect(opts.stateBefore, opts.stateAfter, result);
      const defer = shouldDeferChoiceAsStrategic(
        { index: optionIndex ?? -1, label, tag: option?.tag },
        {
          cached: opts.altruismScores,
          immediateNegative: effect.outcome === "negative",
        },
      );
      if (!defer) return;
      opts.tracker.recordStrategicChoice({
        version,
        eventKey: choice.eventKey,
        optionIndex,
        optionLabel: label,
        strategicTargets: defaultStrategicTargets(),
        horizonDays: 30,
        day,
        runId: opts.runId,
        step: opts.step,
        baseline: captureEpisodeSnapshot(opts.stateBefore),
        branchId: opts.branchId,
      });
    }
  });
}

function mergeComposition(
  current: EpisodeAssignment[],
  incoming: EpisodeAssignment[],
): EpisodeAssignment[] {
  const merged = new Map<string, EpisodeAssignment>();
  for (const assignment of [...current, ...incoming]) {
    merged.set(`${assignment.slotKey ?? assignment.slotIndex}`, assignment);
  }
  return [...merged.values()].sort((a, b) => a.slotIndex - b.slotIndex);
}

function currentRite(state: GameState | null | undefined): {
  riteId: number | null;
  riteUid: number | null;
  slots: Array<{
    index: number;
    slotKey: string | null;
    cardUid: number | null;
    acceptsOp: string | null;
    occupied: boolean;
  }>;
} | null {
  const current = state?.values?.currentRite;
  if (!isRecord(current)) return null;
  return {
    riteId: asNumber(current.id),
    riteUid: asNumber(current.uid),
    slots: slotsFrom(current.slots),
  };
}

function riteFromMap(
  state: GameState | null | undefined,
  riteUid: number | null,
): {
  riteId: number | null;
  riteUid: number | null;
  slots: Array<{
    index: number;
    slotKey: string | null;
    cardUid: number | null;
    acceptsOp: string | null;
    occupied: boolean;
  }>;
} | null {
  const rites = Array.isArray(state?.values?.rites) ? state!.values!.rites! : [];
  for (const raw of rites as unknown[]) {
    if (!isRecord(raw)) continue;
    const uid = asNumber(raw.uid);
    const id = asNumber(raw.id);
    const isCurrent = raw.isCurrent === true || raw.isShow === true;
    if (riteUid != null && uid !== riteUid) continue;
    if (riteUid == null && !isCurrent && !slotsFrom(raw.slots).some((s) => s.cardUid != null)) {
      continue;
    }
    return {
      riteId: id,
      riteUid: uid,
      slots: slotsFrom(raw.slots),
    };
  }
  return null;
}

function slotsFrom(rawSlots: unknown): Array<{
  index: number;
  slotKey: string | null;
  cardUid: number | null;
  acceptsOp: string | null;
  occupied: boolean;
}> {
  if (!Array.isArray(rawSlots)) return [];
  return rawSlots.filter(isRecord).map((slot, index) => ({
    index: asNumber(slot.index) ?? index,
    slotKey: asString(slot.slotKey),
    cardUid: asNumber(slot.cardUid),
    acceptsOp: asString(slot.acceptsOp),
    occupied: slot.occupied === true || asNumber(slot.cardUid) != null,
  }));
}

function compositionFromRite(
  rite: ReturnType<typeof currentRite>,
  state: GameState | null | undefined,
  eventKey: string,
  configFingerprint: string,
): EpisodeAssignment[] {
  if (!rite) return [];
  return rite.slots.flatMap((slot): EpisodeAssignment[] => {
    if (slot.cardUid != null) {
      const card = cardByReference(state, slot.cardUid);
      if (card?.cardId == null) return [];
      return [{
        cardId: card.cardId,
        cardUid: card.cardUid,
        slotIndex: slot.index,
        slotKey: slot.slotKey,
        empty: false,
        count: card.count,
        interactionKey: interactionKnowledgeKey({
          configFingerprint,
          cardId: card.cardId,
          eventKey,
          slotIndex: slot.index,
          slotKey: slot.slotKey,
        }),
      }];
    }
    // Record empty player-intervenable slots so "placed nothing" is learnable.
    const placeable =
      slot.acceptsOp === "place_card_on_rite" || slot.acceptsOp == null;
    if (!placeable) return [];
    return [{
      cardId: 0,
      cardUid: null,
      slotIndex: slot.index,
      slotKey: slot.slotKey,
      empty: true,
      interactionKey: interactionKnowledgeKey({
        configFingerprint,
        cardId: 0,
        eventKey,
        slotIndex: slot.index,
        slotKey: slot.slotKey,
      }),
    }];
  });
}

function compositionFromAllocations(
  allocations: Array<{ cardUid: number; riteUid: number; slotIndex: number; count?: number | null }> | undefined,
  state: GameState | null | undefined,
  eventKey: string,
  configFingerprint: string,
  riteUid?: number | null,
): EpisodeAssignment[] {
  if (!allocations?.length) return [];
  return allocations.flatMap((allocation) => {
    if (riteUid != null && allocation.riteUid !== riteUid) return [];
    const card = cardByReference(state, allocation.cardUid);
    if (card?.cardId == null) return [];
    const rite = riteFromMap(state, allocation.riteUid);
    const slot = rite?.slots.find((item) => item.index === allocation.slotIndex);
    return [{
      cardId: card.cardId,
      cardUid: card.cardUid,
      slotIndex: allocation.slotIndex,
      slotKey: slot?.slotKey ?? null,
      count: allocation.count ?? card.count,
      interactionKey: interactionKnowledgeKey({
        configFingerprint,
        cardId: card.cardId,
        eventKey,
        slotIndex: allocation.slotIndex,
        slotKey: slot?.slotKey,
      }),
    }];
  });
}

function cardForAction(
  state: GameState | null | undefined,
  action: GameAction,
): { cardId: number | null; cardUid: number | null; count: number | null } | null {
  const reference =
    asNumber(action.uid) ?? asNumber(action.cardId) ?? asNumber(action.card);
  return reference == null ? null : cardByReference(state, reference);
}

function cardByReference(
  state: GameState | null | undefined,
  reference: number,
): { cardId: number | null; cardUid: number | null; count: number | null } | null {
  const cards = Array.isArray(state?.values?.cards)
    ? state!.values!.cards!
    : Array.isArray(state?.cards)
      ? state!.cards
      : [];
  for (const raw of cards as unknown[]) {
    if (!isRecord(raw)) continue;
    const cardUid = asNumber(raw.uid);
    const cardId = asNumber(raw.id);
    if (cardUid === reference || cardId === reference) {
      return { cardId, cardUid, count: asNumber(raw.count) };
    }
  }
  return null;
}
