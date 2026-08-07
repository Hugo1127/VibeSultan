import type { ActionResult, GameAction, GameState, SceneSnapshot } from "../game/types.js";
import { parseTierFromText } from "../game/cardTier.js";
import { riteEventKey } from "./entityMemory.js";
import {
  SudanRouteStore,
  sudanRouteKey,
  type SudanRouteRecord,
  type SudanRouteStatus,
} from "./sudanRouteStore.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function sudanCardFromState(state: GameState | null | undefined): {
  cardId: number | null;
  uid: number | null;
  name: string | null;
  rare: number | null;
  identity: string;
} {
  const values = isRecord(state?.values) ? state!.values! : {};
  const sudan = isRecord(values.sudan) ? values.sudan : {};
  const current = isRecord(sudan.currentCard) ? sudan.currentCard : null;
  const cards = Array.isArray(values.cards)
    ? (values.cards as Array<Record<string, unknown>>)
    : Array.isArray(state?.cards)
      ? (state!.cards as Array<Record<string, unknown>>)
      : [];
  const handSudan =
    cards.find((card) => {
      const type = String(card.type ?? "").toLowerCase();
      const name = String(card.name ?? "");
      return type === "sudan" || type.includes("sudan") || name.includes("苏丹");
    }) ?? null;
  const source = current ?? handSudan;
  const cardId = asNumber(source?.id) ?? asNumber(source?.cardId);
  const uid = asNumber(source?.uid);
  const name = asString(source?.name);
  const rare =
    asNumber(source?.rare) ??
    (uid != null
      ? asNumber(cards.find((c) => asNumber(c.uid) === uid)?.rare)
      : null) ??
    (cardId != null
      ? asNumber(cards.find((c) => (asNumber(c.id) ?? asNumber(c.cardId)) === cardId)?.rare)
      : null);
  return {
    cardId,
    uid,
    name,
    rare,
    identity: `${cardId ?? "?"}|${uid ?? "?"}|${name ?? "?"}`,
  };
}

function cardIdentityMatches(
  value: unknown,
  target: { cardId: number | null; uid: number | null; name: string | null },
): boolean {
  if (!isRecord(value)) return false;
  const uid = asNumber(value.uid);
  const cardId = asNumber(value.id) ?? asNumber(value.cardId);
  const name = asString(value.name) ?? asString(value.customName);
  if (target.uid != null && uid === target.uid) return true;
  if (target.cardId != null && cardId === target.cardId) return true;
  return target.name != null && name === target.name;
}

function stateContainsSudanCard(
  state: GameState | null | undefined,
  target: { cardId: number | null; uid: number | null; name: string | null },
): boolean {
  const values = isRecord(state?.values) ? state!.values! : {};
  const sudan = isRecord(values.sudan) ? values.sudan : {};
  if (cardIdentityMatches(sudan.currentCard, target)) return true;

  const cards = Array.isArray(values.cards)
    ? values.cards
    : Array.isArray(state?.cards)
      ? state!.cards
      : [];
  if (cards.some((card) => cardIdentityMatches(card, target))) return true;

  const rites = Array.isArray(values.rites)
    ? values.rites
    : Array.isArray(state?.rites)
      ? state!.rites
      : [];
  const currentRite = isRecord(values.currentRite) ? [values.currentRite] : [];
  return [...rites, ...currentRite].some((rite) => {
    if (!isRecord(rite) || !Array.isArray(rite.slots)) return false;
    return rite.slots.some((slot) => {
      if (!isRecord(slot)) return false;
      return (
        cardIdentityMatches(slot, target) ||
        cardIdentityMatches(slot.card, target) ||
        cardIdentityMatches(slot.occupant, target) ||
        cardIdentityMatches(slot.cardSummary, target)
      );
    });
  });
}

export function reliableSudanBreak(opts: {
  action: GameAction;
  result?: ActionResult | null;
  stateBefore: GameState | null | undefined;
  stateAfter: GameState | null | undefined;
}): boolean {
  if (!opts.result || opts.result.ok === false) return false;
  const op = String(opts.action.op ?? "");
  if (!["execute", "start_rite", "continue"].includes(op)) return false;

  const before = sudanCardFromState(opts.stateBefore);
  if (before.identity === "?|?|?") return false;

  const afterValues = isRecord(opts.stateAfter?.values) ? opts.stateAfter!.values! : {};
  const afterSudan = isRecord(afterValues.sudan) ? afterValues.sudan : {};
  if (isRecord(afterSudan.currentCard)) return false;

  return !stateContainsSudanCard(opts.stateAfter, before);
}

export function insightFromState(state: GameState | null | undefined): number | null {
  const values = isRecord(state?.values) ? state!.values! : {};
  const counters = isRecord(values.counters) ? values.counters : {};
  return asNumber(counters["7100005"]) ?? asNumber(counters[7100005 as unknown as string]);
}

export function detectSudanIdentityChange(opts: {
  store: SudanRouteStore;
  state: GameState | null | undefined;
  day?: number | null;
  configFingerprint: string;
}): { changed: boolean; cardId: number | null; identity: string } {
  const card = sudanCardFromState(opts.state);
  const prev = opts.store.lastSudanIdentity();
  const changed =
    !!card.identity &&
    card.identity !== "?" &&
    (prev.identity == null || prev.identity !== card.identity);
  if (changed && card.cardId != null) {
    opts.store.setLastSudanIdentity(card.cardId, card.identity);
    opts.store.markPendingProbe(`sudan:${card.cardId}`);
  } else if (card.cardId != null && prev.cardId == null) {
    opts.store.setLastSudanIdentity(card.cardId, card.identity);
  }
  return { changed, cardId: card.cardId, identity: card.identity };
}

export function enqueueMapEventProbes(opts: {
  store: SudanRouteStore;
  mapChanges: string[];
  configFingerprint: string;
}): string[] {
  const added: string[] = [];
  for (const change of opts.mapChanges) {
    if (!change.startsWith("added:")) continue;
    const probeKey = `event:${change}`;
    opts.store.markPendingProbe(probeKey);
    added.push(probeKey);
  }
  return added;
}

/** Live map rite uids from state.values.rites / state.rites. */
export function liveRiteUidsFromState(state: GameState | null | undefined): number[] {
  const values = isRecord(state?.values) ? state!.values! : {};
  const rites = Array.isArray(values.rites)
    ? values.rites
    : Array.isArray(state?.rites)
      ? state!.rites
      : [];
  const uids: number[] = [];
  for (const raw of rites) {
    if (!isRecord(raw)) continue;
    const uid = asNumber(raw.uid);
    if (uid != null) uids.push(uid);
  }
  return uids;
}

/**
 * Prune stale pending probes against the live map and current sudan card.
 */
export function pruneSudanRouteProbes(opts: {
  store: SudanRouteStore;
  state: GameState | null | undefined;
  maxPending?: number;
}): { before: number; after: number; removed: string[] } {
  const card = sudanCardFromState(opts.state);
  return opts.store.prunePendingProbes({
    liveRiteUids: liveRiteUidsFromState(opts.state),
    currentSudanCardId: card.cardId,
    maxPending: opts.maxPending,
  });
}

export function captureSudanRoutesFromScene(opts: {
  store: SudanRouteStore;
  state: GameState | null | undefined;
  scene: SceneSnapshot | null | undefined;
  configFingerprint: string;
  day?: number | null;
  evidenceId?: string;
}): SudanRouteRecord[] {
  const card = sudanCardFromState(opts.state);
  if (card.cardId == null || card.uid == null) return [];

  const values = isRecord(opts.state?.values) ? opts.state!.values! : {};
  const currentRite = isRecord(values.currentRite) ? values.currentRite : null;
  if (!currentRite) return [];

  const riteId = asNumber(currentRite.id);
  const riteUid = asNumber(currentRite.uid);
  if (riteId == null && riteUid == null) return [];

  const eventKey =
    riteId != null
      ? riteEventKey(opts.configFingerprint, riteId)
      : `${opts.configFingerprint}:riteuid:${riteUid}`;
  const eventName = asString(currentRite.name);
  const eventLife = asNumber(currentRite.life);
  const slots = Array.isArray(currentRite.slots)
    ? (currentRite.slots as Array<Record<string, unknown>>)
    : [];
  const unfilled = slots
    .map((slot, index) => ({
      index: asNumber(slot.index) ?? index,
      occupied: slot.occupied === true,
    }))
    .filter((slot) => !slot.occupied)
    .map((slot) => slot.index);

  // Resolve current sudan rare from hand/currentCard for tier gate.
  const cards = Array.isArray(values.cards)
    ? (values.cards as Array<Record<string, unknown>>)
    : Array.isArray(stateCards(opts.state))
      ? (stateCards(opts.state) as Array<Record<string, unknown>>)
      : [];
  const sudanRare =
    asNumber(
      cards.find((c) => asNumber(c.uid) === card.uid)?.rare ??
        (isRecord(values.sudan) && isRecord(values.sudan.currentCard)
          ? values.sudan.currentCard.rare
          : null),
    ) ?? null;

  const placeAffordances = (opts.scene?.affordances ?? []).filter(
    (affordance) =>
      affordance?.mapsToOp === "place_card_on_rite" && isRecord(affordance.parameters),
  );

  const updated: SudanRouteRecord[] = [];
  for (const affordance of placeAffordances) {
    const params = affordance.parameters as Record<string, unknown>;
    const uid = asNumber(params.uid);
    if (uid == null || uid !== card.uid) continue;
    const slotIndex = asNumber(params.slotIndex) ?? 0;
    const slot = slots.find((item, index) => (asNumber(item.index) ?? index) === slotIndex);
    const requiredRare =
      asNumber(slot?.requiredRare) ?? parseRequiredRareFromSlot(slot);
    let status = inferRouteStatus({
      unfilledCount: unfilled.filter((index) => index !== slotIndex).length,
      eventLife,
    });
    if (
      requiredRare != null &&
      sudanRare != null &&
      sudanRare > requiredRare
    ) {
      status = "incompatible";
    }
    const key = sudanRouteKey({
      configFingerprint: opts.configFingerprint,
      sudanCardId: card.cardId,
      eventKey,
      slotIndex,
    });
    const record = opts.store.upsert({
      key,
      configFingerprint: opts.configFingerprint,
      sudanCardId: card.cardId,
      sudanCardName: card.name,
      eventKey,
      eventName,
      riteId,
      riteUid,
      slotIndex,
      slotKey: asString(slot?.slotKey) ?? asString(params.slotKey),
      status,
      firstSeenDay: opts.day ?? null,
      lastSeenDay: opts.day ?? null,
      eventLife,
      unfilledSlots: unfilled.filter((index) => index !== slotIndex),
      estimatedPrepDays: Math.max(0, unfilled.filter((index) => index !== slotIndex).length),
      knownOutcome: "unknown",
      confidence: 0.7,
      evidenceIds: opts.evidenceId ? [opts.evidenceId] : [],
    });
    updated.push(record);
    if (status !== "incompatible") {
      opts.store.clearPendingProbe(`sudan:${card.cardId}`);
      opts.store.clearPendingProbe(`event:added:${riteUid ?? "?"}:`);
    }
  }

  if (updated.some((r) => r.status !== "incompatible")) {
    // Clear pending probes that mention this rite uid/name.
    for (const probe of opts.store.pendingProbes()) {
      if (
        (riteUid != null && probe.includes(String(riteUid))) ||
        (eventName && probe.includes(eventName))
      ) {
        opts.store.clearPendingProbe(probe);
      }
    }
  }

  return updated;
}

function stateCards(state: GameState | null | undefined): unknown[] {
  return Array.isArray(state?.cards) ? state!.cards! : [];
}

function parseRequiredRareFromSlot(slot: Record<string, unknown> | undefined): number | null {
  if (!slot) return null;
  const fromField = asNumber(slot.requiredRare);
  if (fromField != null) return fromField;
  const condition = asString(slot.condition) ?? "";
  const text = asString(slot.text) ?? "";
  const tierText = asString(slot.requiredTier) ?? "";
  return parseTierFromText(`${condition} ${text} ${tierText}`);
}

/** @deprecated use parseTierFromText; kept for tests */
export function parseTierCeilingFromCondition(combined: string): number | null {
  return parseTierFromText(combined);
}

function inferRouteStatus(opts: {
  unfilledCount: number;
  eventLife: number | null;
}): SudanRouteStatus {
  if (opts.unfilledCount <= 0) return "ready";
  if (opts.unfilledCount <= 2) return "needs_support";
  return "compatible";
}

export function formatSudanRouteBrief(store: SudanRouteStore, sudanCardId?: number | null): string {
  const summary = store.summarize({ sudanCardId });
  const best = summary.bestReady;
  const parts = [
    "[sudan-routes]",
    `coverage=${summary.compatible}/${Math.max(1, summary.total)}`,
    `ready=${summary.ready}`,
    `needs_support=${summary.needsSupport}`,
    `verified_break=${summary.verifiedBreak}`,
    `incompatible=${summary.incompatible}`,
    `pending_probes=${summary.pendingProbes}`,
    `shortest_prep_days=${summary.shortestPrepDays ?? "?"}`,
  ];
  if (best) {
    parts.push(
      `best=${best.eventName ?? best.eventKey}#${best.slotIndex}`,
      `best_life=${best.eventLife ?? "?"}`,
    );
  }
  return parts.join(" ");
}
