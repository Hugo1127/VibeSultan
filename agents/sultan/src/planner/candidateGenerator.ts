import type { GameAction, GameState, SceneSnapshot } from "../game/types.js";
import type {
  CardFeature,
  EventConfiguration,
  EventFeature,
  StrategySnapshot,
} from "../game/strategyTypes.js";
import {
  isErrandEvent,
  tierMatchScore,
} from "../game/cardTier.js";

const MAX_MULTI_SLOT_COMBOS = 48;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function isContinuousEvent(event: EventFeature): boolean {
  return isErrandEvent(event);
}

/** Build complete event configurations from scene place affordances + enabled ops. */
export function generateEventConfigurations(opts: {
  snapshot: StrategySnapshot;
  state: GameState | null | undefined;
  scene: SceneSnapshot | null | undefined;
}): EventConfiguration[] {
  const { snapshot, scene } = opts;
  const configs: EventConfiguration[] = [];
  const placeAffordances = (scene?.affordances ?? []).filter(
    (a) => a?.enabled !== false && a?.mapsToOp === "place_card_on_rite" && isRecord(a.parameters),
  );

  // Group place_* affordances by slot into per-card placements.
  const bySlot = new Map<
    number,
    Array<{ uid: number; card: CardFeature; label?: string | null; count?: number | null }>
  >();
  for (const aff of placeAffordances) {
    const params = aff.parameters as Record<string, unknown>;
    const slotIndex = asNumber(params.slotIndex);
    const uid = asNumber(params.uid);
    if (slotIndex == null || uid == null) continue;
    const stateCard = findCardByUid(opts.state, uid);
    const card: CardFeature =
      stateCard ??
      ({
        cardId: asNumber(params.cardId),
        type: asString(params.cardType) ?? asString(params.type),
        rare: asNumber(params.cardRare) ?? asNumber(params.rare),
        name: asString(params.cardName) ?? asString(aff.label),
        inHand: true,
      } satisfies CardFeature);
    const count = asNumber(params.count) ?? asNumber(params.costMin);
    const list = bySlot.get(slotIndex) ?? [];
    list.push({ uid, card, label: aff.label, count });
    bySlot.set(slotIndex, list);
  }

  const current = snapshot.currentEvent;
  if (current && bySlot.size > 0) {
    // Single-slot placements.
    for (const [slotIndex, options] of bySlot) {
      for (const option of options) {
        configs.push({
          id: `cfg_place_${current.riteUid ?? current.riteId ?? "x"}_${slotIndex}_${option.uid}`,
          event: current,
          assignments: [{ slotIndex, card: option.card, uid: option.uid, count: option.count }],
          estimatedLockTurns: null,
          unknowns: current.slots?.length ? [] : ["slot_schema_partial"],
          experienceIds: [],
          baseScore: scorePlacement(snapshot, current, option.card, slotIndex),
        });
      }
    }

    // Bounded multi-slot complete configurations for the open rite.
    const slots = [...bySlot.keys()].sort((a, b) => a - b);
    if (slots.length >= 2) {
      const combos = buildMultiSlotCombos(slots, bySlot, MAX_MULTI_SLOT_COMBOS);
      for (const combo of combos) {
        const uidPart = combo.map((c) => `${c.slotIndex}:${c.uid}`).join("_");
        configs.push({
          id: `cfg_place_multi_${current.riteUid ?? current.riteId ?? "x"}_${uidPart}`,
          event: current,
          assignments: combo.map((c) => ({
            slotIndex: c.slotIndex,
            card: c.card,
            uid: c.uid,
            count: c.count,
          })),
          estimatedLockTurns: null,
          unknowns: [],
          experienceIds: [],
          baseScore:
            combo.reduce(
              (sum, c) => sum + scorePlacement(snapshot, current, c.card, c.slotIndex),
              0,
            ) + 4,
        });
      }
    }
  }

  // Domain ops that do not need card assignment.
  for (const op of snapshot.enabledOps) {
    if (
      snapshot.sudanCard?.exchangeCircuitOpen === true &&
      (op === "open_sudan_box" || op === "exchange_sudan_card")
    ) {
      continue;
    }
    if (
      op === "execute" ||
      op === "reset" ||
      op === "cancel" ||
      op === "continue" ||
      op === "draw_sudan_card" ||
      op === "open_sudan_box" ||
      op === "exchange_sudan_card" ||
      op === "select_event_option" ||
      op === "open_rite" ||
      op === "inspect_card" ||
      op === "think_card" ||
      op === "open_daily_news" ||
      op === "prev_round" ||
      // Legacy aliases if an older snapshot still advertises them.
      op === "start_rite" ||
      op === "clear_rite_submission" ||
      op === "close_rite" ||
      op === "next_day" ||
      op === "next_round"
    ) {
      configs.push({
        id: `cfg_op_${op}`,
        event: current ?? { name: op },
        assignments: [],
        estimatedLockTurns: op === "execute" || op === "start_rite" ? 1 : 0,
        unknowns:
          op === "next_day" || op === "next_round" ? ["day_opportunity_check"] : [],
        experienceIds: [],
        baseScore: scoreBareOp(snapshot, op),
      });
    }
  }

  // Map open_rite for visible rites when no panel is open.
  const openAffordances = (scene?.affordances ?? []).filter(
    (a) => a?.enabled !== false && a?.mapsToOp === "open_rite" && isRecord(a.parameters),
  );
  for (const aff of openAffordances) {
    const params = aff.parameters as Record<string, unknown>;
    const uid = asNumber(params.uid) ?? asNumber(params.riteUid);
    const fromSnap = snapshot.events.find((e) => e.riteUid === uid);
    const affMatch = asNumber(params.handMatchCount);
    const event: EventFeature = fromSnap
      ? {
          ...fromSnap,
          handMatchCount:
            fromSnap.handMatchCount != null && fromSnap.handMatchCount > 0
              ? fromSnap.handMatchCount
              : (affMatch ?? fromSnap.handMatchCount),
        }
      : {
          riteUid: uid,
          riteId: asNumber(params.id),
          name: asString(aff.label) ?? asString(params.name),
          life: asNumber(params.life),
          handMatchCount: affMatch,
          slotPreview: [],
        };
    configs.push({
      id: `cfg_open_${uid ?? "x"}`,
      event,
      assignments: [],
      estimatedLockTurns: 0,
      unknowns: [],
      experienceIds: [],
      baseScore: scoreOpenRite(snapshot, event),
    });
  }

  return configs.sort((a, b) => b.baseScore - a.baseScore);
}

export function configurationToAction(config: EventConfiguration): GameAction | null {
  if (config.id.startsWith("cfg_place_multi_") && config.assignments[0]) {
    // Multi-slot plans still execute one placement at a time.
    const a = config.assignments[0];
    return {
      op: "place_card_on_rite",
      uid: a.uid ?? undefined,
      slotIndex: a.slotIndex,
      ...(a.count != null ? { count: a.count } : {}),
    };
  }
  if (config.id.startsWith("cfg_place_") && config.assignments[0]) {
    const a = config.assignments[0];
    return {
      op: "place_card_on_rite",
      uid: a.uid ?? undefined,
      slotIndex: a.slotIndex,
      ...(a.count != null ? { count: a.count } : {}),
    };
  }
  if (config.id.startsWith("cfg_open_")) {
    return { op: "open_rite", uid: config.event.riteUid ?? undefined };
  }
  if (config.id.startsWith("cfg_op_")) {
    const op = config.id.slice("cfg_op_".length);
    return { op };
  }
  return null;
}

function buildMultiSlotCombos(
  slots: number[],
  bySlot: Map<
    number,
    Array<{ uid: number; card: CardFeature; label?: string | null; count?: number | null }>
  >,
  maxCombos: number,
): Array<Array<{ slotIndex: number; uid: number; card: CardFeature; count?: number | null }>> {
  const result: Array<
    Array<{ slotIndex: number; uid: number; card: CardFeature; count?: number | null }>
  > = [];
  const limitedSlots = slots.slice(0, 4);

  function dfs(
    index: number,
    usedCards: Set<number>,
    acc: Array<{ slotIndex: number; uid: number; card: CardFeature; count?: number | null }>,
  ): void {
    if (result.length >= maxCombos) return;
    if (index >= limitedSlots.length) {
      if (acc.length >= 2) result.push([...acc]);
      return;
    }
    const slotIndex = limitedSlots[index]!;
    const options = bySlot.get(slotIndex) ?? [];
    // Option to leave slot empty — only if we already have at least one assignment path
    // ending with multi-fill; still explore skips for breadth.
    dfs(index + 1, usedCards, acc);
    for (const option of options.slice(0, 6)) {
      if (usedCards.has(option.uid)) continue;
      usedCards.add(option.uid);
      acc.push({ slotIndex, uid: option.uid, card: option.card, count: option.count });
      dfs(index + 1, usedCards, acc);
      acc.pop();
      usedCards.delete(option.uid);
      if (result.length >= maxCombos) return;
    }
  }

  dfs(0, new Set(), []);
  return result;
}

function findCardByUid(state: GameState | null | undefined, uid: number): CardFeature | null {
  const values = isRecord(state?.values) ? state!.values! : {};
  const cards = Array.isArray(values.cards) ? values.cards : [];
  for (const card of cards) {
    if (!isRecord(card)) continue;
    if (asNumber(card.uid) === uid) {
      return {
        cardId: asNumber(card.id),
        type: asString(card.type),
        rare: asNumber(card.rare),
        name: asString(card.name) ?? asString(card.customName),
        inHand: card.inHand === true || card.bag === 0,
      };
    }
  }
  return null;
}

function scorePlacement(
  snapshot: StrategySnapshot,
  event: EventFeature,
  card: CardFeature,
  slotIndex: number,
): number {
  let score = 10;
  if (event.life != null && event.life <= 1) score += 8;
  if (isContinuousEvent(event)) score += 7;
  const type = (card.type ?? "").toLowerCase();
  if (type === "char" || type === "character" || type === "follower") score += 3;
  const slot = event.slots?.find((s) => s.index === slotIndex);
  score += tierMatchScore({
    card,
    requiredRare: slot?.requiredRare,
    errand: isErrandEvent(event),
  });
  if (slot?.isKey) score += 3;
  if (slot?.conditionType && card.type && slot.conditionType === card.type) score += 4;

  // Rolling Sudan lifecycle: boost commit/branch days and expiring opportunities;
  // do not apply fixed early-break placement penalties.
  const left = snapshot.executionDaysLeft;
  const looksSudan =
    type === "sudan" ||
    type.includes("sudan") ||
    /sudan|苏丹|杀戮|纵欲|征服|奢靡|处刑/.test(
      `${slot?.text ?? ""} ${slot?.conditionType ?? ""} ${event.name ?? ""}`,
    );
  const expiring =
    snapshot.sudanRoutes?.expiringOpportunity === true ||
    (event.life != null && event.life <= 1);
  if (looksSudan && left != null) {
    if (left <= 1) score += 14;
    else if (left === 2) score += 8;
    else if (expiring) score += 10;
    else if ((snapshot.sudanRoutes?.readyCount ?? 0) > 0) score += 3;
  } else if (left != null && left <= 2 && isContinuousEvent(event)) {
    score += left === 1 ? 2 : 4;
  }
  return score;
}

function scoreBareOp(snapshot: StrategySnapshot, op: string): number {
  const left = snapshot.executionDaysLeft;
  const redraw = snapshot.sudanCard?.redrawRemaining ?? 0;
  switch (op) {
    case "execute":
    case "start_rite":
      return 18;
    case "reset":
    case "clear_rite_submission":
      // Only valuable when a rite is already submitted/started.
      return snapshot.currentEvent?.started === true ? 16 : 1;
    case "draw_sudan_card":
      return 14;
    case "open_sudan_box":
      if (snapshot.sudanCard?.exchangeCircuitOpen === true) return 0;
      return left != null && left <= 2 ? 13 : 7;
    case "exchange_sudan_card":
      if (snapshot.sudanCard?.exchangeCircuitOpen === true) return 0;
      if (redraw <= 0) return 0;
      if (left === 2) return 15;
      if (left === 1) return 12;
      return 6;
    case "prev_round":
      return left != null && left <= 2 ? 5 : 2;
    case "select_event_option":
      return 12;
    case "open_daily_news":
      return 11;
    case "inspect_card":
      return 9;
    case "think_card":
      // Gameplay drop into 俺寻思 — prefer over plain inspect when exploring books/Sudan.
      return 11;
    case "cancel":
    case "close_rite":
      return 4;
    case "next_day":
    case "next_round":
      return snapshot.deadlines.some((d) => d.critical) ? -20 : 1;
    case "continue":
      // Panel dismiss only — never day advance.
      return 8;
    default:
      return 2;
  }
}

/** Exported for verify scripts — ranks open_rite by life/continuity/handMatch. */
export function scoreOpenRite(snapshot: StrategySnapshot, event: EventFeature): number {
  let score = 9;
  if (event.life != null && event.life <= 1) score += 10;
  if (event.started) score += 2;
  if (isContinuousEvent(event)) score += 8;
  if (snapshot.executionDaysLeft != null && snapshot.executionDaysLeft <= 2) score += 4;

  const handMatchCount = event.handMatchCount ?? 0;
  const hasPreview = (event.slotPreview?.length ?? 0) > 0;
  if (handMatchCount > 0) {
    score += 6 + Math.min(4, handMatchCount);
  }
  const sudanCard = snapshot.sudanCard;
  const sudanMatch = (event.slotPreview ?? []).some((slot) => {
    const ct = (slot.conditionType ?? "").toLowerCase();
    const blob = `${slot.condition ?? ""} ${slot.text ?? ""}`;
    if (!(ct.includes("sudan") || /sudan|苏丹|杀戮|纵欲|征服|奢靡/i.test(blob))) {
      return false;
    }
    if (!sudanCard) return true;
    if (slot.requiredRare != null && sudanCard.rare != null) {
      return slot.requiredRare === sudanCard.rare;
    }
    return true;
  });
  if (sudanMatch && sudanCard) score += 8;

  // Soft penalty: known schema, no heuristic hand match — still openable, just lower rank.
  if (hasPreview && handMatchCount <= 0 && !sudanMatch && !isContinuousEvent(event)) {
    score -= 4;
  }
  return score;
}
