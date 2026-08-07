import type {
  ExperienceRecord,
  ExperienceStore,
} from "@vibesultan/agent-learning-core";
import type {
  ActionResult,
  GameAction,
  GameState,
  SceneSnapshot,
} from "../game/types.js";
import type {
  CardFeature,
  ChoiceEventFeature,
  EventFeature,
  HandMatchHint,
  Prediction,
  SlotPreviewFeature,
  StateDelta,
  StrategySnapshot,
  StrategyVersionKey,
} from "../game/strategyTypes.js";
import {
  formatTier,
  parseTierFromText,
  tierName,
} from "../game/cardTier.js";
import { extractMetrics } from "./sultanAdapter.js";
import { choiceEventKey } from "./entityMemory.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function versionKeyFromState(
  state: GameState | null | undefined,
  gameFingerprint?: string | null,
): StrategyVersionKey {
  const values = isRecord(state?.values) ? state!.values! : {};
  // Config fingerprint comes from the in-game catalog hash (may change during
  // cold start → full catalog). Game fingerprint is the binary/build identity.
  const configFp = asString(values.fingerprint) || "unknown-config";
  return {
    gameFingerprint: gameFingerprint?.trim() || configFp,
    configFingerprint: configFp,
  };
}

export function cardFeaturesFromState(state: GameState | null | undefined): CardFeature[] {
  const values = isRecord(state?.values) ? state!.values! : {};
  const primary = Array.isArray(values.cards)
    ? values.cards
    : Array.isArray(state?.cards)
      ? state!.cards
      : [];
  const all = Array.isArray(values.cardsAll) ? values.cardsAll : [];
  const byKey = new Map<string, CardFeature>();

  const ingest = (raw: unknown, preferAll: boolean) => {
    if (!isRecord(raw)) return;
    const uid = asNumber(raw.uid);
    const cardId = asNumber(raw.id) ?? asNumber(raw.cardId);
    const key =
      uid != null
        ? `u:${uid}`
        : cardId != null
          ? `c:${cardId}`
          : `n:${asString(raw.name) ?? asString(raw.customName) ?? Math.random()}`;
    const tags = tagsFromCard(raw);
    const feature: CardFeature = {
      uid,
      cardId,
      type: asString(raw.type),
      rare: asNumber(raw.rare),
      name: asString(raw.name) ?? asString(raw.customName),
      life: asNumber(raw.life),
      tags: tags.length ? tags : undefined,
      inHand: raw.inHand === true || raw.bag === 0,
    };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, feature);
      return;
    }
    // Prefer richer tags / rare from cardsAll merge when primary lacked them.
    byKey.set(key, {
      ...existing,
      ...feature,
      tags: feature.tags?.length ? feature.tags : existing.tags,
      rare: feature.rare ?? existing.rare,
      name: feature.name ?? existing.name,
      life: feature.life ?? existing.life,
      inHand: preferAll ? existing.inHand || feature.inHand : feature.inHand || existing.inHand,
    });
  };

  for (const card of primary as unknown[]) ingest(card, false);
  for (const card of all as unknown[]) ingest(card, true);
  return [...byKey.values()];
}

function tagsFromCard(card: Record<string, unknown>): string[] {
  const rawTags = card.tags;
  if (Array.isArray(rawTags)) {
    return rawTags
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t) => t.trim());
  }
  if (!isRecord(rawTags)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(rawTags)) {
    if (!key.trim()) continue;
    if (value === 0 || value === false || value == null) continue;
    out.push(typeof value === "number" ? `${key}:${value}` : key);
  }
  return out;
}

export function eventFeaturesFromState(state: GameState | null | undefined): EventFeature[] {
  const values = isRecord(state?.values) ? state!.values! : {};
  const rites = Array.isArray(values.rites)
    ? values.rites
    : Array.isArray(state?.rites)
      ? state!.rites
      : [];
  const currentRite = isRecord(values.currentRite) ? values.currentRite : null;
  const currentRiteId = asNumber(currentRite?.id);
  const currentRiteUid = asNumber(currentRite?.uid);
  const features = (rites as unknown[])
    .filter(isRecord)
    .map((rite) => {
      const riteId = asNumber(rite.id);
      const riteUid = asNumber(rite.uid);
      const isCurrent =
        (currentRiteUid != null && currentRiteUid === riteUid) ||
        (currentRiteId != null && currentRiteId === riteId);
      const rawSlots =
        isCurrent && Array.isArray(currentRite?.slots)
          ? currentRite.slots
          : Array.isArray(rite.slots)
            ? rite.slots
            : [];
      const previewSource = Array.isArray(rite.slotPreview)
        ? rite.slotPreview
        : isCurrent && Array.isArray(currentRite?.slotPreview)
          ? currentRite.slotPreview
          : [];
      return {
        kind: "rite" as const,
        riteId,
        riteUid,
        name: asString(rite.name) ?? (isCurrent ? asString(currentRite?.name) : null),
        life: asNumber(rite.life),
        started:
          rite.start === true ||
          rite.started === true ||
          (isCurrent && currentRite?.started === true),
        slotsFilled: asNumber(rite.slotsFilled),
        canConfirm: rite.canConfirm === true || (isCurrent && currentRite?.canConfirm === true),
        remainingAppearTurns: asNumber(rite.life),
        slots: (rawSlots as unknown[])
          .filter(isRecord)
          .map((slot, index) => slotFeatureFromRaw(slot, index, state)),
        slotPreview: slotPreviewFromRaw(previewSource),
        handMatchCount:
          asNumber(rite.handMatchCount) ??
          (isCurrent ? asNumber(currentRite?.handMatchCount) : null),
        handMatchHints: handMatchHintsFromRaw(
          Array.isArray(rite.handMatchHints)
            ? rite.handMatchHints
            : isCurrent && Array.isArray(currentRite?.handMatchHints)
              ? currentRite.handMatchHints
              : [],
        ),
      };
    });
  if (
    currentRite &&
    currentRiteId != null &&
    !features.some(
      (event) =>
        event.riteId === currentRiteId ||
        (currentRiteUid != null && event.riteUid === currentRiteUid),
    )
  ) {
    const rawSlots = Array.isArray(currentRite.slots) ? currentRite.slots : [];
    features.push({
      kind: "rite",
      riteId: currentRiteId,
      riteUid: currentRiteUid,
      name: asString(currentRite.name),
      life: asNumber(currentRite.life),
      started: currentRite.started === true,
      slotsFilled: asNumber(currentRite.slotsFilled),
      canConfirm: currentRite.canConfirm === true,
      remainingAppearTurns: asNumber(currentRite.life),
      slots: (rawSlots as unknown[])
        .filter(isRecord)
        .map((slot, index) => slotFeatureFromRaw(slot, index, state)),
      slotPreview: slotPreviewFromRaw(
        Array.isArray(currentRite.slotPreview) ? currentRite.slotPreview : [],
      ),
      handMatchCount: asNumber(currentRite.handMatchCount),
      handMatchHints: handMatchHintsFromRaw(
        Array.isArray(currentRite.handMatchHints) ? currentRite.handMatchHints : [],
      ),
    });
  }
  return features;
}

export function choiceEventFromState(
  state: GameState | null | undefined,
): ChoiceEventFeature | null {
  const values = isRecord(state?.values) ? state!.values! : {};
  const current = isRecord(values.currentEvent) ? values.currentEvent : null;
  if (!current) return null;
  const rawOptions = Array.isArray(current.options)
    ? current.options
    : Array.isArray(values.events)
      ? values.events
      : [];
  const options = (rawOptions as unknown[])
    .filter(isRecord)
    .map((option, position) => ({
      index: asNumber(option.index) ?? position,
      label: asString(option.label),
      selected: option.selected === true,
      tag: asString(option.tag),
    }));
  const prompt = asString(current.prompt);
  const identitySeed = asString(current.identitySeed);
  const configFingerprint = asString(values.fingerprint) ?? "unknown-config";
  const eventKey = identitySeed
    ? `${configFingerprint}:choice:${identitySeed}`
    : choiceEventKey(
        configFingerprint,
        prompt,
        options.map((option) => option.label),
      );
  return {
    kind: "choice",
    eventKey,
    prompt,
    identitySeed: identitySeed ?? eventKey.slice(eventKey.lastIndexOf(":") + 1),
    identityQuality: current.identityQuality === "stable" ? "stable" : "derived",
    options,
  };
}

export function actionSignature(action: GameAction): string {
  const op = String(action.op ?? "unknown");
  const parts = [op];
  for (const key of ["uid", "cardId", "slotIndex", "optionIndex", "riteId", "index"] as const) {
    const value = action[key];
    if (value !== undefined && value !== null && `${value}`.length > 0) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join("|");
}

export function contextSignature(state: GameState | null | undefined): string {
  const values = isRecord(state?.values) ? state!.values! : {};
  const day = values.day ?? values.turn ?? "?";
  const phase = isRecord(state?.screen) ? state!.screen!.phase ?? "?" : "?";
  const riteId = isRecord(values.currentRite) ? values.currentRite.id ?? "?" : "?";
  const hand = values.handCount ?? "?";
  const rites = values.riteCount ?? "?";
  return `day=${day}|phase=${phase}|currentRite=${riteId}|hand=${hand}|rites=${rites}`;
}

function isSudanType(type: string | null | undefined, name?: string | null): boolean {
  const t = (type ?? "").toLowerCase();
  if (t === "sudan" || t.includes("sudan")) return true;
  return /苏丹|杀戮|纵欲|征服|奢靡/.test(name ?? "");
}

/** Per-card face countdown: remaining = initLife - life (elapsed ticks). */
function remainingFromCardLife(
  initLife: number | null,
  life: number | null,
): number | null {
  if (initLife == null || initLife <= 0 || life == null) return null;
  return Math.max(0, initLife - Math.max(0, life));
}

/**
 * Collect every held Sudan card with its face countdown.
 * executionDaysLeft should be the minimum remaining (most urgent deadline).
 */
function collectSudanCardTimers(opts: {
  state: GameState | null | undefined;
  sudan: Record<string, unknown>;
  initLife: number | null;
}): Array<{
  cardId: number | null;
  uid: number | null;
  name: string | null;
  rare: number | null;
  life: number | null;
  remaining: number | null;
  identity: string;
}> {
  const { state, sudan, initLife } = opts;
  const byUid = new Map<
    number,
    {
      cardId: number | null;
      uid: number | null;
      name: string | null;
      rare: number | null;
      life: number | null;
      remaining: number | null;
      identity: string;
    }
  >();
  const push = (raw: Record<string, unknown>) => {
    const type = asString(raw.type);
    const name = asString(raw.name) ?? asString(raw.customName);
    if (!isSudanType(type, name)) return;
    const uid = asNumber(raw.uid);
    const cardId = asNumber(raw.id) ?? asNumber(raw.cardId);
    const life = asNumber(raw.life);
    const rare = asNumber(raw.rare);
    const remaining = remainingFromCardLife(initLife, life);
    const key = uid ?? cardId;
    if (key == null) return;
    const prev = byUid.get(key);
    // Prefer richer rows (with life) when duplicates appear across card pools.
    if (prev && prev.life != null && life == null) return;
    byUid.set(key, {
      cardId,
      uid,
      name,
      rare,
      life,
      remaining,
      identity: `${cardId ?? "?"}|${uid ?? "?"}|${name ?? "?"}`,
    });
  };

  if (isRecord(sudan.currentCard)) push(sudan.currentCard);
  for (const card of cardFeaturesFromState(state)) {
    push({
      uid: card.uid,
      id: card.cardId,
      cardId: card.cardId,
      type: card.type,
      name: card.name,
      rare: card.rare,
      life: card.life,
    });
  }
  // Also scan raw cards / cardsAll in case cardFeatures filtered them out.
  const values = isRecord(state?.values) ? state!.values! : {};
  for (const poolKey of ["cards", "cardsAll"] as const) {
    const pool = values[poolKey];
    if (!Array.isArray(pool)) continue;
    for (const raw of pool) {
      if (isRecord(raw)) push(raw);
    }
  }

  return [...byUid.values()].sort((a, b) => {
    const ra = a.remaining ?? Number.POSITIVE_INFINITY;
    const rb = b.remaining ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return (a.uid ?? 0) - (b.uid ?? 0);
  });
}

export function buildStrategySnapshot(opts: {
  state: GameState | null | undefined;
  scene?: SceneSnapshot | null;
  gameFingerprint?: string | null;
  sudanRouteSummary?: StrategySnapshot["sudanRoutes"];
  rewindAvailable?: boolean;
  exchangeCircuitOpen?: boolean;
  exploreRecovery?: StrategySnapshot["exploreRecovery"];
}): StrategySnapshot {
  const { state, scene, gameFingerprint } = opts;
  const values = isRecord(state?.values) ? state!.values! : {};
  const version = versionKeyFromState(state, gameFingerprint);
  const sudan = isRecord(values.sudan) ? values.sudan : {};
  const day = asNumber(values.day);
  const initLife = asNumber(sudan.initLife);
  const currentCard = isRecord(sudan.currentCard) ? sudan.currentCard : null;
  const sudanTimers = collectSudanCardTimers({ state, sudan, initLife });
  // Most urgent card-face countdown across ALL held Sudan cards.
  let executionDaysLeft: number | null = null;
  for (const timer of sudanTimers) {
    if (timer.remaining == null) continue;
    if (executionDaysLeft == null || timer.remaining < executionDaysLeft) {
      executionDaysLeft = timer.remaining;
    }
  }
  if (executionDaysLeft == null) {
    const projected =
      asNumber(sudan.remaining) ?? asNumber(sudan.executionDaysLeft);
    if (projected != null) {
      executionDaysLeft = Math.max(0, projected);
    } else if (day != null && initLife != null && initLife > 0) {
      executionDaysLeft = Math.max(0, initLife - Math.max(1, day) + 1);
    }
  }

  const resources: Record<string, number | null> = {};
  if (isRecord(values.resources)) {
    for (const [k, v] of Object.entries(values.resources)) {
      resources[k] = asNumber(v);
    }
  }
  const counters: Record<string, number | null> = {};
  if (isRecord(values.counters)) {
    for (const [k, v] of Object.entries(values.counters)) {
      counters[k] = asNumber(v);
    }
  }
  const insight = asNumber(counters["7100005"]);

  const enabledOps = (state?.actions ?? [])
    .filter((a) => a && a.enabled !== false && typeof a.id === "string")
    .map((a) => a.id as string);

  const deadlines = [];
  if (sudanTimers.length > 0) {
    for (const timer of sudanTimers) {
      if (timer.remaining == null) continue;
      deadlines.push({
        kind: "sudan_card" as const,
        label: `${timer.name ?? "sudan"} (${timer.remaining}/${initLife ?? "?"})`,
        remaining: timer.remaining,
        critical: timer.remaining <= 2,
      });
    }
  } else if (executionDaysLeft != null) {
    deadlines.push({
      kind: "sudan_card" as const,
      label: "Current Sultan card execution window",
      remaining: executionDaysLeft,
      critical: executionDaysLeft <= 2,
    });
  }
  for (const event of eventFeaturesFromState(state)) {
    if (event.life != null) {
      deadlines.push({
        kind: "rite_life",
        label: event.name ?? `rite:${event.riteUid ?? event.riteId}`,
        remaining: event.life,
        critical: event.life <= 1,
      });
    }
  }

  const unknowns: string[] = [];
  if (!isRecord(values.resources) || Object.keys(resources).length === 0) {
    unknowns.push("resources_unknown");
  }
  if (!isRecord(values.currentRite)) {
    unknowns.push("no_open_rite_panel");
  }

  const current = isRecord(values.currentRite)
    ? {
        kind: "rite" as const,
        riteId: asNumber(values.currentRite.id),
        riteUid: asNumber(values.currentRite.uid),
        name: asString(values.currentRite.name),
        started: values.currentRite.started === true,
        canConfirm: values.currentRite.canConfirm === true,
        slots: Array.isArray(values.currentRite.slots)
          ? (values.currentRite.slots as unknown[])
              .filter(isRecord)
              .map((slot, index) => slotFeatureFromRaw(slot, index, state))
          : [],
      }
    : null;

  // Prefer most urgent timer; fall back to host currentCard / first hand sudan.
  const urgent = sudanTimers[0] ?? null;
  const currentUid = asNumber(currentCard?.uid);
  const matchedCurrent =
    currentUid != null
      ? sudanTimers.find((t) => t.uid === currentUid) ?? null
      : null;
  const primary = urgent ?? matchedCurrent;
  const redrawTimes = asNumber(sudan.redrawTimes);
  const redrawPerRound = asNumber(sudan.redrawPerRound);
  const redrawRemaining =
    asNumber(sudan.redrawRemaining) ??
    (redrawTimes != null && redrawPerRound != null
      ? Math.max(0, redrawPerRound - Math.max(0, redrawTimes))
      : null);

  const expiringOpportunity =
    opts.sudanRouteSummary?.expiringOpportunity === true ||
    eventFeaturesFromState(state).some(
      (event) =>
        event.life != null &&
        event.life <= 1 &&
        /sudan|苏丹|杀戮|纵欲|征服|奢靡|处刑/.test(event.name ?? ""),
    );

  const sudanRoutes = opts.sudanRouteSummary
    ? {
        ...opts.sudanRouteSummary,
        expiringOpportunity:
          opts.sudanRouteSummary.expiringOpportunity ?? expiringOpportunity,
        insight: opts.sudanRouteSummary.insight ?? insight,
        rewindAvailable:
          opts.sudanRouteSummary.rewindAvailable ??
          opts.rewindAvailable ??
          enabledOps.includes("prev_round"),
      }
    : {
        coverage: 0,
        readyCount: 0,
        needsSupportCount: 0,
        pendingProbes: 0,
        expiringOpportunity,
        insight,
        rewindAvailable: opts.rewindAvailable ?? enabledOps.includes("prev_round"),
      };

  const sudanCards = sudanTimers.map((t) => ({
    cardId: t.cardId,
    uid: t.uid,
    name: t.name,
    identity: t.identity,
    rare: t.rare,
    life: t.life,
    remaining: t.remaining,
    initLife,
  }));

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    version,
    day,
    turn: asNumber(values.turn),
    phase: isRecord(state?.screen) ? asString(state!.screen!.phase) : null,
    terminal: state?.terminal === true || values.terminal === true,
    executionDaysLeft,
    resources,
    counters,
    cards: cardFeaturesFromState(state),
    events: eventFeaturesFromState(state),
    currentChoiceEvent: choiceEventFromState(state),
    currentEvent: current,
    deadlines,
    enabledOps,
    unknowns,
    sceneVersion: scene?.snapshotVersion ?? null,
    sudanCard: primary
      ? {
          cardId: primary.cardId,
          uid: primary.uid,
          name: primary.name,
          identity: primary.identity,
          rare: primary.rare,
          life: primary.life,
          remaining: primary.remaining,
          initLife,
          redrawTimes,
          redrawPerRound,
          redrawRemaining,
          exchangeCircuitOpen: opts.exchangeCircuitOpen === true,
        }
      : {
          cardId: asNumber(currentCard?.id),
          uid: asNumber(currentCard?.uid),
          name: asString(currentCard?.name),
          identity: `${asNumber(currentCard?.id) ?? "?"}|${asNumber(currentCard?.uid) ?? "?"}|${asString(currentCard?.name) ?? "?"}`,
          life: asNumber(currentCard?.life),
          remaining: executionDaysLeft,
          initLife,
          redrawTimes,
          redrawPerRound,
          redrawRemaining,
          exchangeCircuitOpen: opts.exchangeCircuitOpen === true,
        },
    sudanCards,
    sudanRoutes,
    insight,
    rewindAvailable: opts.rewindAvailable ?? enabledOps.includes("prev_round"),
    exploreRecovery: opts.exploreRecovery ?? null,
  };
}

function slotPreviewFromRaw(raw: unknown): SlotPreviewFeature[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter(isRecord)
    .map((slot, index) => {
      const requiredRare =
        asNumber(slot.requiredRare) ??
        parseTierFromText(asString(slot.condition)) ??
        parseTierFromText(asString(slot.text));
      return {
        index: asNumber(slot.index) ?? index,
        slotKey: asString(slot.slotKey),
        text: asString(slot.text),
        conditionType: asString(slot.conditionType),
        condition: asString(slot.condition),
        requiredRare,
        requiredTier:
          asString(slot.requiredTier) ??
          (requiredRare != null ? tierName(requiredRare) : null),
        costMin: asNumber(slot.costMin),
        isKey: slot.isKey === true || slot.isKey === 1,
      } satisfies SlotPreviewFeature;
    });
}

function handMatchHintsFromRaw(raw: unknown): HandMatchHint[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter(isRecord)
    .map((hint) => {
      const uids = Array.isArray(hint.matchingCardUids)
        ? hint.matchingCardUids
            .map((u) => asNumber(u))
            .filter((u): u is number => u != null)
        : [];
      return {
        slotIndex: asNumber(hint.slotIndex) ?? 0,
        slotKey: asString(hint.slotKey),
        conditionType: asString(hint.conditionType),
        requiredRare: asNumber(hint.requiredRare),
        matchingCardUids: uids,
        matchKind: asString(hint.matchKind),
      } satisfies HandMatchHint;
    })
    .filter((h) => h.matchingCardUids.length > 0);
}

function slotFeatureFromRaw(
  slot: Record<string, unknown>,
  index: number,
  state: GameState | null | undefined,
) {
  const summary = isRecord(slot.cardSummary) ? slot.cardSummary : {};
  const condition = asString(slot.condition);
  const text = asString(slot.text);
  const requiredRare =
    asNumber(slot.requiredRare) ??
    parseTierFromText(condition) ??
    parseTierFromText(text);
  const cardUid = asNumber(slot.cardUid) ?? asNumber(summary.cardUid);
  const cardId = asNumber(slot.cardId) ?? asNumber(summary.id) ?? asNumber(summary.cardId);
  const cardRare = asNumber(summary.rare) ?? asNumber(slot.cardRare);
  const cardName =
    asString(slot.cardName) ??
    asString(summary.name) ??
    asString(summary.title);
  const cardTags = numericTagMap(summary.tags);
  const occupied = slot.occupied === true || cardUid != null || cardId != null;

  return {
    index: asNumber(slot.index) ?? index,
    slotKey: asString(slot.slotKey),
    text,
    condition,
    conditionType: asString(slot.conditionType),
    requiredRare,
    requiredTier:
      asString(slot.requiredTier) ??
      (requiredRare != null ? tierName(requiredRare) : null),
    isKey: slot.isKey === true || slot.isKey === 1,
    isEnemy: slot.isEnemy === true || slot.isEnemy === 1,
    occupied,
    acceptsOp: asString(slot.acceptsOp),
    occupant: occupied
      ? {
          cardUid,
          cardId,
          name: cardName,
          type: asString(summary.type) ?? asString(slot.cardType),
          rare: cardRare,
          tier:
            asString(summary.tier) ??
            asString(slot.cardTier) ??
            formatTier(cardRare),
          tags: cardTags,
          kind: occupantKind(state, cardUid, slot),
        }
      : null,
  };
}

function numericTagMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const tags: Record<string, number> = {};
  for (const key of Object.keys(value).sort()) {
    const numeric = asNumber(value[key]);
    if (numeric == null || numeric === 0) continue;
    tags[key] = numeric;
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function occupantKind(
  state: GameState | null | undefined,
  cardUid: number | null,
  slot: Record<string, unknown>,
): "builtin" | "player" | "unknown" {
  if (slot.isEnemy === true || slot.isEnemy === 1) return "builtin";
  if (cardUid == null) return "unknown";
  const values = isRecord(state?.values) ? state!.values! : {};
  const cards = Array.isArray(values.cards) ? values.cards : [];
  for (const raw of cards as unknown[]) {
    if (!isRecord(raw) || asNumber(raw.uid) !== cardUid) continue;
    if (raw.inHand === true || raw.bag === 0) return "player";
    return "builtin";
  }
  return "builtin";
}

export function parseStateDelta(raw: unknown): StateDelta | null {
  if (!isRecord(raw)) return null;
  return raw as unknown as StateDelta;
}

export function deltaLooksPositive(delta: StateDelta | null | undefined): boolean | undefined {
  if (!delta || !delta.changed) return undefined;
  let score = 0;
  if (delta.resources) {
    for (const row of Object.values(delta.resources)) {
      if (typeof row?.delta === "number") score += row.delta;
    }
  }
  if (delta.day && typeof delta.day.after === "number" && typeof delta.day.before === "number") {
    // Advancing day alone is not success.
  }
  if (delta.terminal?.after === true && delta.terminal?.before !== true) {
    return false;
  }
  if (score > 0) return true;
  if (score < 0) return false;
  if (delta.rites?.changed?.length || delta.cards?.changed?.length || delta.currentRite) {
    return true;
  }
  return undefined;
}

export function buildPrediction(opts: {
  action: GameAction;
  state: GameState | null | undefined;
  planId?: string | null;
  stepIndex?: number | null;
  gameFingerprint?: string | null;
  uncertain?: string[];
}): Prediction {
  return {
    id: `pred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    planId: opts.planId ?? null,
    stepIndex: opts.stepIndex ?? null,
    action: opts.action,
    actionSignature: actionSignature(opts.action),
    contextSignature: contextSignature(opts.state),
    version: versionKeyFromState(opts.state, opts.gameFingerprint),
    expected: {
      resourceDeltas: {},
      eventTransitions: [],
      lockTurns: opts.action.op === "start_rite" ? 1 : null,
      screenPhase: null,
    },
    uncertain: opts.uncertain ?? ["outcome_unknown"],
  };
}

export function recordActionExperience(opts: {
  store: ExperienceStore;
  stateBefore: GameState | null | undefined;
  stateAfter: GameState | null | undefined;
  action: GameAction;
  results: ActionResult[];
  prediction?: Prediction | null;
  runId?: string;
  gameFingerprint?: string | null;
}): ExperienceRecord {
  const ok = opts.results.some((r) => r.ok);
  const stateDelta =
    parseStateDelta(opts.results.find((r) => r.stateDelta)?.stateDelta) ??
    parseStateDelta(
      (opts.results.find((r) => isRecord(r.changes) && isRecord((r.changes as Record<string, unknown>).state))
        ?.changes as Record<string, unknown> | undefined)?.state,
    );
  const positive = ok ? deltaLooksPositive(stateDelta) : false;
  return opts.store.createOrAccumulate({
    version: versionKeyFromState(opts.stateBefore, opts.gameFingerprint),
    actionSignature: actionSignature(opts.action),
    contextSignature: contextSignature(opts.stateBefore),
    eventFeatures: eventFeaturesFromState(opts.stateBefore) as unknown as Record<string, unknown>[],
    cardFeatures: cardFeaturesFromState(opts.stateBefore) as unknown as Record<string, unknown>[],
    prediction: (opts.prediction as unknown as Record<string, unknown>) ?? null,
    actualDelta: (stateDelta as unknown as Record<string, unknown>) ?? null,
    metricsBefore: extractMetrics(opts.stateBefore ?? {}),
    metricsAfter: extractMetrics(opts.stateAfter ?? {}),
    positive,
    notes: [
      `op=${opts.action.op}`,
      `ok=${ok}`,
      `errors=${opts.results.map((r) => r.error ?? "").filter(Boolean).join(",") || "none"}`,
    ],
    runId: opts.runId,
  });
}
