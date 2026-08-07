import type { ExperienceRecord } from "@vibesultan/agent-learning-core";
import type { GameAction, GameState, SceneSnapshot } from "../game/types.js";
import type {
  CardFeature,
  DayCandidateLedger,
  DayCloseAssignment,
  DayCloseDiffMove,
  DayCloseEvidenceCompleteness,
  DayCloseIssue,
  DayCloseReviewResult,
  EventConfiguration,
  EventFeature,
  StrategySnapshot,
} from "../game/strategyTypes.js";
import {
  isCurrencyCard,
  isStrategicTierCard,
} from "../game/cardTier.js";
import { configurationToAction, generateEventConfigurations } from "./candidateGenerator.js";
import { beamSearchDayPlans } from "./beamSearch.js";
import { improvePlanLocally } from "./localSearch.js";
import { compareScoreVectors, scorePlanVector } from "./scorer.js";
import {
  adviseExecutionTiming,
  planBreaksSudanCard,
} from "./executionTiming.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function cardInstanceKey(
  uid: number | null | undefined,
  cardId: number | null | undefined,
): string {
  return `u:${uid ?? "?"}|c:${cardId ?? "?"}`;
}

export function slotInstanceKey(
  riteUid: number | null | undefined,
  slotIndex: number | null | undefined,
): string {
  return `r:${riteUid ?? "?"}|s:${slotIndex ?? "?"}`;
}

export function emptyDayCandidateLedger(day: number | null = null): DayCandidateLedger {
  return {
    schemaVersion: 1,
    day,
    configurationsById: {},
    capturedRiteUids: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Merge place/open configs into the per-day ledger; prune vanished cards/rites. */
export function ingestConfigurationsIntoLedger(
  ledger: DayCandidateLedger,
  configurations: EventConfiguration[],
  opts?: {
    day?: number | null;
    liveCardUids?: Set<number>;
    liveRiteUids?: Set<number>;
  },
): DayCandidateLedger {
  const day = opts?.day ?? ledger.day;
  const next: DayCandidateLedger =
    day != null && ledger.day != null && day !== ledger.day
      ? emptyDayCandidateLedger(day)
      : {
          ...ledger,
          day: day ?? ledger.day,
          configurationsById: { ...ledger.configurationsById },
          capturedRiteUids: [...ledger.capturedRiteUids],
        };

  for (const cfg of configurations) {
    if (
      !cfg.id.startsWith("cfg_place_") &&
      !cfg.id.startsWith("cfg_open_") &&
      cfg.id !== "cfg_op_execute" &&
      cfg.id !== "cfg_op_start_rite"
    ) {
      continue;
    }
    next.configurationsById[cfg.id] = cfg;
    const riteUid = cfg.event.riteUid;
    if (riteUid != null && !next.capturedRiteUids.includes(riteUid)) {
      next.capturedRiteUids.push(riteUid);
    }
  }

  if (opts?.liveCardUids || opts?.liveRiteUids) {
    const pruned: Record<string, EventConfiguration> = {};
    for (const [id, cfg] of Object.entries(next.configurationsById)) {
      const riteUid = cfg.event.riteUid;
      if (
        opts.liveRiteUids &&
        riteUid != null &&
        !opts.liveRiteUids.has(riteUid) &&
        id.startsWith("cfg_place_")
      ) {
        continue;
      }
      if (opts.liveCardUids) {
        const missingCard = cfg.assignments.some(
          (a) => a.uid != null && !opts.liveCardUids!.has(a.uid),
        );
        if (missingCard) continue;
      }
      pruned[id] = cfg;
    }
    next.configurationsById = pruned;
    next.capturedRiteUids = next.capturedRiteUids.filter(
      (uid) => !opts.liveRiteUids || opts.liveRiteUids.has(uid),
    );
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

function handCards(state?: GameState | null): Array<Record<string, unknown>> {
  const values = isRecord(state?.values) ? state!.values! : {};
  const raw = Array.isArray(values.cards)
    ? values.cards
    : Array.isArray(state?.cards)
      ? state!.cards
      : [];
  return (raw as unknown[])
    .filter(isRecord)
    .filter((c) => c.inHand === true || c.bag === 0 || c.inHand == null);
}

function findCardFeature(
  state: GameState | null | undefined,
  uid: number,
): CardFeature | null {
  for (const card of handCards(state)) {
    if (asNumber(card.uid) !== uid) continue;
    return {
      cardId: asNumber(card.id) ?? asNumber(card.cardId),
      type: asString(card.type),
      rare: asNumber(card.rare),
      name: asString(card.name) ?? asString(card.customName),
      inHand: true,
    };
  }
  return null;
}

function isReusableCard(card: CardFeature): boolean {
  const type = (card.type ?? "").toLowerCase();
  if (type === "char" || type === "character" || type === "follower") return true;
  if (type === "sudan") return false;
  if (type === "item" && (isStrategicTierCard(card) || isCurrencyCard(card))) return false;
  if (type === "consumable" || type === "once") return false;
  return type !== "sudan";
}

function eventFromSnapshot(
  snapshot: StrategySnapshot,
  riteUid: number,
): EventFeature | null {
  return (
    snapshot.events.find((e) => e.riteUid === riteUid) ??
    (snapshot.currentEvent?.riteUid === riteUid ? snapshot.currentEvent : null)
  );
}

function slotOccupiedByOther(
  event: EventFeature | null | undefined,
  slotIndex: number,
  cardUid: number,
): boolean {
  const slot = event?.slots?.find((s) => s.index === slotIndex);
  if (!slot?.occupied) return false;
  const occUid = slot.occupant?.cardUid;
  if (occUid == null) return true;
  return occUid !== cardUid;
}

/** Validate a reported assignment against scene affordances + snapshot slots. */
export function validateAssignmentAgainstScene(
  assignment: DayCloseAssignment,
  scene: SceneSnapshot | null | undefined,
  snapshot: StrategySnapshot,
): string | null {
  const affordances = scene?.affordances ?? [];
  const matching = affordances.some((a) => {
    if (a?.enabled === false || a.mapsToOp !== "place_card_on_rite" || !isRecord(a.parameters)) {
      return false;
    }
    const uid = asNumber(a.parameters.uid);
    const slotIndex = asNumber(a.parameters.slotIndex);
    return uid === assignment.cardUid && slotIndex === assignment.slotIndex;
  });

  const event = eventFromSnapshot(snapshot, assignment.riteUid);
  if (slotOccupiedByOther(event, assignment.slotIndex, assignment.cardUid)) {
    return "slot_occupied_by_other";
  }

  // When the rite panel is open for this rite, require a live affordance.
  if (
    snapshot.currentEvent?.riteUid === assignment.riteUid &&
    affordances.some((a) => a.mapsToOp === "place_card_on_rite")
  ) {
    if (!matching) return "no_affordance";
  }
  return null;
}

export function allocationsToConfigurations(opts: {
  allocations: DayCloseAssignment[];
  snapshot: StrategySnapshot;
  state: GameState | null | undefined;
  scene: SceneSnapshot | null | undefined;
  pool?: EventConfiguration[];
}): {
  configurations: EventConfiguration[];
  feasible: boolean;
  infeasible: Array<{ assignment: DayCloseAssignment; reason: string }>;
} {
  const pool = opts.pool ?? [];
  const configurations: EventConfiguration[] = [];
  const infeasible: Array<{ assignment: DayCloseAssignment; reason: string }> = [];
  const usedSlots = new Set<string>();
  const usedCards = new Set<number>();

  for (const assignment of opts.allocations) {
    const slotKey = slotInstanceKey(assignment.riteUid, assignment.slotIndex);
    if (usedSlots.has(slotKey)) {
      infeasible.push({ assignment, reason: "duplicate_slot" });
      continue;
    }
    if (usedCards.has(assignment.cardUid)) {
      infeasible.push({ assignment, reason: "duplicate_card" });
      continue;
    }

    const reason = validateAssignmentAgainstScene(assignment, opts.scene, opts.snapshot);
    const fromPool = pool.find(
      (c) =>
        c.id.startsWith("cfg_place_") &&
        (c.event.riteUid ?? c.event.riteId) === assignment.riteUid &&
        c.assignments[0]?.uid === assignment.cardUid &&
        c.assignments[0]?.slotIndex === assignment.slotIndex,
    );

    const card =
      assignment.card ??
      fromPool?.assignments[0]?.card ??
      findCardFeature(opts.state, assignment.cardUid);
    if (!card) {
      infeasible.push({ assignment, reason: "card_not_found" });
      continue;
    }
    if (reason === "slot_occupied_by_other") {
      infeasible.push({ assignment, reason });
      continue;
    }

    const event =
      fromPool?.event ??
      eventFromSnapshot(opts.snapshot, assignment.riteUid) ??
      ({ riteUid: assignment.riteUid, name: `rite:${assignment.riteUid}` } satisfies EventFeature);

    usedSlots.add(slotKey);
    usedCards.add(assignment.cardUid);
    configurations.push(
      fromPool ?? {
        id: `cfg_place_${assignment.riteUid}_${assignment.slotIndex}_${assignment.cardUid}`,
        event,
        assignments: [
          {
            slotIndex: assignment.slotIndex,
            card,
            uid: assignment.cardUid,
            count: assignment.count ?? null,
          },
        ],
        estimatedLockTurns: null,
        unknowns: reason ? [reason] : [],
        experienceIds: [],
        baseScore: 10,
      },
    );
  }

  return {
    configurations,
    feasible: infeasible.length === 0,
    infeasible,
  };
}

function evidenceCompleteness(
  ledger: DayCandidateLedger,
  snapshot: StrategySnapshot,
): DayCloseEvidenceCompleteness {
  const mapRites = snapshot.events.filter((e) => e.riteUid != null);
  if (mapRites.length === 0) return "none";
  const captured = new Set(ledger.capturedRiteUids);
  const hit = mapRites.filter((e) => e.riteUid != null && captured.has(e.riteUid!)).length;
  if (hit === 0 && Object.keys(ledger.configurationsById).length === 0) return "none";
  if (hit < mapRites.length) return "partial";
  return "full";
}

function findIdleReusableWithPositiveSlot(opts: {
  snapshot: StrategySnapshot;
  state: GameState | null | undefined;
  currentConfigs: EventConfiguration[];
  pool: EventConfiguration[];
}): Array<{ cardUid: number; config: EventConfiguration }> {
  const assigned = new Set<number>();
  for (const cfg of opts.currentConfigs) {
    for (const a of cfg.assignments) {
      if (a.uid != null) assigned.add(a.uid);
    }
  }
  const hits: Array<{ cardUid: number; config: EventConfiguration }> = [];
  for (const card of opts.snapshot.cards) {
    if (!card.inHand) continue;
    if (!isReusableCard(card)) continue;
    // Prefer uid from pool configs that match this cardId.
    const place = opts.pool.find(
      (c) =>
        c.id.startsWith("cfg_place_") &&
        c.assignments[0]?.card.cardId === card.cardId &&
        c.assignments[0]?.uid != null &&
        !assigned.has(c.assignments[0]!.uid!),
    );
    if (!place || place.assignments[0]?.uid == null) continue;
    hits.push({ cardUid: place.assignments[0].uid, config: place });
  }

  // Also scan hand uids from state for instances not present as cardId-only features.
  for (const raw of handCards(opts.state)) {
    const uid = asNumber(raw.uid);
    if (uid == null || assigned.has(uid)) continue;
    const feature = findCardFeature(opts.state, uid);
    if (!feature || !isReusableCard(feature)) continue;
    const place = opts.pool.find(
      (c) =>
        c.id.startsWith("cfg_place_") &&
        c.assignments[0]?.uid === uid,
    );
    if (!place) continue;
    if (!hits.some((h) => h.cardUid === uid)) {
      hits.push({ cardUid: uid, config: place });
    }
  }
  return hits;
}

function diffMoves(
  current: EventConfiguration[],
  best: EventConfiguration[],
): DayCloseDiffMove[] {
  const currentByCard = new Map<number, { riteUid: number; slotIndex: number }>();
  for (const cfg of current) {
    for (const a of cfg.assignments) {
      if (a.uid == null) continue;
      currentByCard.set(a.uid, {
        riteUid: cfg.event.riteUid ?? cfg.event.riteId ?? -1,
        slotIndex: a.slotIndex,
      });
    }
  }
  const bestByCard = new Map<number, { riteUid: number; slotIndex: number }>();
  for (const cfg of best) {
    if (!cfg.id.startsWith("cfg_place_")) continue;
    for (const a of cfg.assignments) {
      if (a.uid == null) continue;
      bestByCard.set(a.uid, {
        riteUid: cfg.event.riteUid ?? cfg.event.riteId ?? -1,
        slotIndex: a.slotIndex,
      });
    }
  }

  const moves: DayCloseDiffMove[] = [];
  for (const [uid, to] of bestByCard) {
    const from = currentByCard.get(uid);
    if (!from) {
      moves.push({ kind: "add", cardUid: uid, to, why: "fill_idle_positive_slot" });
      continue;
    }
    if (from.riteUid !== to.riteUid || from.slotIndex !== to.slotIndex) {
      moves.push({ kind: "move", cardUid: uid, from, to, why: "better_slot" });
    }
  }
  for (const [uid, from] of currentByCard) {
    if (!bestByCard.has(uid)) {
      moves.push({ kind: "remove", cardUid: uid, from, why: "drop_low_value" });
    }
  }
  return moves;
}

function firstSuggestedAction(
  bestConfigs: EventConfiguration[],
  currentConfigs: EventConfiguration[],
): GameAction | null {
  const currentKeys = new Set(
    currentConfigs.flatMap((c) =>
      c.assignments.map((a) =>
        slotInstanceKey(c.event.riteUid ?? c.event.riteId, a.slotIndex) +
        `|${a.uid ?? "?"}`,
      ),
    ),
  );
  for (const cfg of bestConfigs) {
    if (!cfg.id.startsWith("cfg_place_") && !cfg.id.startsWith("cfg_open_")) continue;
    const keys = cfg.assignments.map(
      (a) =>
        slotInstanceKey(cfg.event.riteUid ?? cfg.event.riteId, a.slotIndex) +
        `|${a.uid ?? "?"}`,
    );
    if (keys.every((k) => currentKeys.has(k))) continue;
    return configurationToAction(cfg);
  }
  const exec = bestConfigs.find(
    (c) => c.id === "cfg_op_execute" || c.id === "cfg_op_start_rite",
  );
  return exec ? configurationToAction(exec) : null;
}

/**
 * Deterministic day-close review: compare reported allocations + scene ledger
 * against a locally optimized feasible plan before next_day.
 */
export function reviewDayCloseAllocations(opts: {
  snapshot: StrategySnapshot;
  state: GameState | null | undefined;
  scene: SceneSnapshot | null | undefined;
  allocations: DayCloseAssignment[];
  /** Explained idle cards from action-chain report; exempts hard idle for those uids. */
  idleCards?: Array<{ cardUid: number; reason: "reserved" | "no_positive_slot" }>;
  ledger?: DayCandidateLedger | null;
  experiences?: ExperienceRecord[];
  sudanBreakDone?: boolean;
  beamWidth?: number;
  maxPlans?: number;
  /** Optional action-chain for soft hints (tier regression after exchange). */
  sudanExchangeTierRegression?: {
    rareBefore: number;
    rareAfter: number;
    identityAfter: string;
  } | null;
}): DayCloseReviewResult {
  const experiences = opts.experiences ?? [];
  const ledger =
    opts.ledger ??
    ingestConfigurationsIntoLedger(
      emptyDayCandidateLedger(opts.snapshot.day ?? null),
      generateEventConfigurations({
        snapshot: opts.snapshot,
        state: opts.state,
        scene: opts.scene,
      }),
      { day: opts.snapshot.day ?? null },
    );

  const livePlaceConfigs = generateEventConfigurations({
    snapshot: opts.snapshot,
    state: opts.state,
    scene: opts.scene,
  }).filter(
    (c) =>
      c.id.startsWith("cfg_place_") ||
      c.id.startsWith("cfg_open_") ||
      c.id === "cfg_op_execute" ||
      c.id === "cfg_op_start_rite",
  );

  const mergedLedger = ingestConfigurationsIntoLedger(ledger, livePlaceConfigs, {
    day: opts.snapshot.day ?? null,
  });
  const pool = Object.values(mergedLedger.configurationsById);
  const completeness = evidenceCompleteness(mergedLedger, opts.snapshot);
  const confidence =
    completeness === "full" ? 0.85 : completeness === "partial" ? 0.55 : 0.25;

  const mapped = allocationsToConfigurations({
    allocations: opts.allocations,
    snapshot: opts.snapshot,
    state: opts.state,
    scene: opts.scene,
    pool,
  });

  const hardIssues: DayCloseIssue[] = [];
  const softIssues: DayCloseIssue[] = [];

  for (const item of mapped.infeasible) {
    hardIssues.push({
      severity: "hard",
      code: item.reason === "slot_occupied_by_other" ? "allocation_drift" : "stale_allocation",
      message: `allocation invalid: card=${item.assignment.cardUid} rite=${item.assignment.riteUid} slot=${item.assignment.slotIndex} (${item.reason})`,
      cardUid: item.assignment.cardUid,
      riteUid: item.assignment.riteUid,
      slotIndex: item.assignment.slotIndex,
    });
  }

  const currentScore = scorePlanVector({
    snapshot: opts.snapshot,
    configurations: mapped.configurations,
    experiences,
  });

  let bestPlan = beamSearchDayPlans({
    snapshot: opts.snapshot,
    configurations: pool,
    experiences,
    beamWidth: opts.beamWidth ?? 16,
    maxPlans: opts.maxPlans ?? 4,
    localImprove: true,
  })[0];

  if (!bestPlan) {
    bestPlan = improvePlanLocally({
      snapshot: opts.snapshot,
      seed: mapped.configurations,
      neighborhood: pool,
      experiences,
    });
  } else {
    // Ensure local improve also explores from current seed neighborhood.
    const improved = improvePlanLocally({
      snapshot: opts.snapshot,
      seed: bestPlan.configurations.length
        ? bestPlan.configurations
        : mapped.configurations,
      neighborhood: pool,
      experiences,
    });
    if (compareScoreVectors(improved.scoreVector, bestPlan.scoreVector) < 0) {
      bestPlan = improved;
    }
  }

  const bestScore = bestPlan.scoreVector;
  const lexCompare = compareScoreVectors(currentScore, bestScore);
  const moves = diffMoves(mapped.configurations, bestPlan.configurations);

  const explainedIdle = new Set(
    (opts.idleCards ?? []).map((i) => i.cardUid),
  );
  const idleHits = findIdleReusableWithPositiveSlot({
    snapshot: opts.snapshot,
    state: opts.state,
    currentConfigs: mapped.configurations,
    pool,
  });
  for (const hit of idleHits) {
    if (explainedIdle.has(hit.cardUid)) {
      // Agent explained reserved / no_positive_slot — keep as soft suggestion only.
      softIssues.push({
        severity: "soft",
        code: "idle_reusable_positive_slot",
        message: `reusable card ${hit.cardUid} explained idle but still has a verified positive slot`,
        cardUid: hit.cardUid,
        riteUid: hit.config.event.riteUid ?? undefined,
        slotIndex: hit.config.assignments[0]?.slotIndex,
      });
      continue;
    }
    // Only hard-block when we have a concrete place affordance in the pool.
    const issue: DayCloseIssue = {
      severity: completeness === "none" ? "soft" : "hard",
      code: "idle_reusable_positive_slot",
      message: `reusable card ${hit.cardUid} has a verified positive slot but is idle`,
      cardUid: hit.cardUid,
      riteUid: hit.config.event.riteUid ?? undefined,
      slotIndex: hit.config.assignments[0]?.slotIndex,
    };
    if (issue.severity === "hard") hardIssues.push(issue);
    else softIssues.push(issue);
  }

  const timing = adviseExecutionTiming(opts.snapshot);
  const sudanInHand = opts.snapshot.cards.some((c) => {
    const type = (c.type ?? "").toLowerCase();
    return c.inHand && (type === "sudan" || type.includes("sudan"));
  });
  const breaksNow = planBreaksSudanCard(mapped.configurations);
  const exchangeCircuitOpen = opts.snapshot.sudanCard?.exchangeCircuitOpen === true;
  const breakPath = pool.some((c) => {
    if (!c.id.startsWith("cfg_place_") && !c.id.startsWith("cfg_open_")) return false;
    return planBreaksSudanCard([c]);
  });
  // Sudan incompleteness / last-day break / exchange are advisory only — never hard-block next_day.
  if (
    sudanInHand &&
    !opts.sudanBreakDone &&
    !breaksNow &&
    (timing.policy === "commit_best" ||
      timing.policy === "emergency" ||
      timing.policy === "branch_test")
  ) {
    softIssues.push({
      severity: "soft",
      code:
        timing.policy === "branch_test"
          ? "sudan_branch_test_recommended"
          : "must_break_sudan_today",
      message: timing.hint,
      recommendedOps: breakPath
        ? ["open_rite", "place_card_on_rite", "execute"]
        : exchangeCircuitOpen
          ? ["open_rite", "place_card_on_rite", "prev_round"]
          : ["open_sudan_box", "exchange_sudan_card", "prev_round"],
    });
  }
  if (
    sudanInHand &&
    (opts.snapshot.sudanRoutes?.pendingProbes ?? 0) > 0 &&
    timing.policy === "discover_routes" &&
    (opts.snapshot.sudanRoutes?.verifiedBreakCount ?? 0) <= 0
  ) {
    softIssues.push({
      severity: "soft",
      code: "sudan_route_probe_pending",
      message: `有 ${opts.snapshot.sudanRoutes?.pendingProbes} 条苏丹路线待探测；优先打开新 event 读取 place affordance。`,
      recommendedOps: ["open_rite"],
    });
  }
  const tierRegression = opts.sudanExchangeTierRegression;
  if (sudanInHand && tierRegression) {
    softIssues.push({
      severity: "soft",
      code: "sudan_exchange_tier_regression",
      message: `换卡后苏丹品阶上升 ${tierRegression.rareBefore}→${tierRegression.rareAfter} 且尚无验证销卡路；建议 prev_round 回退保留低阶可销卡。`,
      recommendedOps: ["prev_round"],
    });
  }
  if (
    sudanInHand &&
    (opts.snapshot.sudanCard?.redrawRemaining ?? 0) > 0 &&
    timing.executionDaysLeft != null &&
    timing.executionDaysLeft <= 2 &&
    !exchangeCircuitOpen &&
    !opts.snapshot.enabledOps.includes("exchange_sudan_card")
  ) {
    softIssues.push({
      severity: "soft",
      code: "sudan_exchange_available",
      message: `换卡剩余 ${opts.snapshot.sudanCard?.redrawRemaining} 次且不重置倒计时；可用 open_sudan_box → exchange_sudan_card 试验分支。`,
      recommendedOps: ["open_sudan_box", "exchange_sudan_card"],
    });
  }

  if (lexCompare > 0 && moves.length > 0) {
    softIssues.push({
      severity: "soft",
      code: "score_improvement",
      message: `best plan improves score (lexCompare=${lexCompare}); ${moves.length} adjustment(s)`,
    });
  }

  if (completeness !== "full") {
    softIssues.push({
      severity: "soft",
      code: "evidence_incomplete",
      message:
        completeness === "none"
          ? "day-close evidence incomplete: no captured rite place configs"
          : `day-close evidence partial: captured ${mergedLedger.capturedRiteUids.length}/${opts.snapshot.events.length} rites`,
    });
  }

  // Downgrade hard idle issues when evidence is incomplete — avoid deadlock.
  if (completeness !== "full") {
    for (const issue of [...hardIssues]) {
      if (issue.code === "idle_reusable_positive_slot") {
        // Keep hard only when the specific place config came from live scene affordances.
        const live = livePlaceConfigs.some(
          (c) =>
            c.id.startsWith("cfg_place_") &&
            c.assignments[0]?.uid === issue.cardUid,
        );
        if (!live) {
          const idx = hardIssues.indexOf(issue);
          if (idx >= 0) {
            hardIssues.splice(idx, 1);
            softIssues.push({ ...issue, severity: "soft" });
          }
        }
      }
    }
  }

  const suggestedFirstAction = firstSuggestedAction(
    bestPlan.configurations,
    mapped.configurations,
  );

  const canAdvanceDay = hardIssues.length === 0;
  const bits = [
    `evidence=${completeness}`,
    `hard=${hardIssues.length}`,
    `soft=${softIssues.length}`,
    `lexCompare=${lexCompare}`,
    `moves=${moves.length}`,
  ];
  if (bestPlan.id) bits.push(`best=${bestPlan.id}`);

  return {
    schemaVersion: 1,
    day: opts.snapshot.day ?? null,
    ok: canAdvanceDay && softIssues.filter((i) => i.code === "score_improvement").length === 0,
    canAdvanceDay,
    hardIssues,
    softIssues,
    currentScore,
    bestScore,
    lexCompare,
    moves,
    suggestedFirstAction,
    evidenceCompleteness: completeness,
    confidence,
    summary: bits.join("; "),
    bestPlanId: bestPlan.id ?? null,
  };
}

export function formatDayCloseReviewBrief(result: DayCloseReviewResult): string {
  const lines = [
    "【日终分配检定】next_day 前确定性检定；硬问题禁止过天，软改进可调整或带 dayCloseReviewOverride 跳过。",
    `day=${result.day ?? "?"} canAdvanceDay=${result.canAdvanceDay} evidence=${result.evidenceCompleteness} conf=${result.confidence.toFixed(2)}`,
    `summary: ${result.summary}`,
    `score current=[${result.currentScore.map((n) => n.toFixed(1)).join(",")}] best=[${result.bestScore.map((n) => n.toFixed(1)).join(",")}] lexCompare=${result.lexCompare}`,
  ];
  if (result.hardIssues.length) {
    lines.push(
      `hard: ${result.hardIssues.map((i) => `${i.code}:${i.message}`).join(" | ")}`,
    );
  }
  if (result.softIssues.length) {
    lines.push(
      `soft: ${result.softIssues.map((i) => `${i.code}:${i.message}`).join(" | ")}`,
    );
  }
  if (result.moves.length) {
    lines.push(
      `moves: ${result.moves
        .slice(0, 6)
        .map((m) => {
          if (m.kind === "add") {
            return `+${m.cardUid}@${m.to?.riteUid}:${m.to?.slotIndex}`;
          }
          if (m.kind === "remove") {
            return `-${m.cardUid}@${m.from?.riteUid}:${m.from?.slotIndex}`;
          }
          return `~${m.cardUid}:${m.from?.riteUid}:${m.from?.slotIndex}->${m.to?.riteUid}:${m.to?.slotIndex}`;
        })
        .join("; ")}`,
    );
  }
  if (result.suggestedFirstAction) {
    lines.push(`suggestedFirstAction: ${JSON.stringify(result.suggestedFirstAction)}`);
  }
  return lines.join("\n");
}
