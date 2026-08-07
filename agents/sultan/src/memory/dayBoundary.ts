import type { ActionResult, GameState, SceneSnapshot } from "../game/types.js";

/** Lifecycle of an in-game day-advance → feedback-drain → pre-allocation review. */
export type DayBoundaryPhase =
  | "idle"
  | "armed"
  | "draining_feedback"
  | "review_ready"
  | "reviewed";

export interface DayBoundaryState {
  phase: DayBoundaryPhase;
  /** Game day observed just before the advancing continue. */
  dayBeforeAdvance: number | null;
  /** Game day we expect after advance (usually dayBefore + 1). */
  targetDay: number | null;
  /** Last game day that already completed a daily review. */
  lastReviewedDay: number | null;
  /** Consecutive observations that looked review-ready (debounce). */
  stableReadyCount: number;
  /** Required day delta between reviews (default 1). */
  intervalDays: number;
}

const SETTLEMENT_PHASES = new Set([
  "rite_result",
  "story",
  "confirm",
  "prompt",
  "change_name",
  "wizard",
  "option",
  "guide",
  "begin_guide",
]);

function guideActive(state: GameState | null | undefined): boolean {
  const guide = state?.values?.guide;
  if (!guide || typeof guide !== "object") return false;
  return (guide as { active?: unknown }).active === true;
}

export function createDayBoundary(opts?: {
  intervalDays?: number;
  lastReviewedDay?: number | null;
}): DayBoundaryState {
  return {
    phase: "idle",
    dayBeforeAdvance: null,
    targetDay: null,
    lastReviewedDay:
      typeof opts?.lastReviewedDay === "number" && Number.isFinite(opts.lastReviewedDay)
        ? opts.lastReviewedDay
        : null,
    stableReadyCount: 0,
    intervalDays: Math.max(1, Math.floor(opts?.intervalDays ?? 1)),
  };
}

export function dayOf(state: GameState | null | undefined): number | null {
  const values = state?.values;
  if (!values || typeof values !== "object") return null;
  const day = (values as { day?: unknown; turn?: unknown }).day;
  if (typeof day === "number" && Number.isFinite(day)) return day;
  const turn = (values as { turn?: unknown }).turn;
  if (typeof turn === "number" && Number.isFinite(turn)) return turn;
  return null;
}

function phaseOf(state: GameState | null | undefined): string {
  return (state?.screen?.phase ?? state?.screen?.id ?? "").toLowerCase();
}

function enabledOps(state: GameState | null | undefined): Set<string> {
  const set = new Set<string>();
  for (const a of state?.actions ?? []) {
    if (a?.id && a.enabled !== false) set.add(a.id);
  }
  return set;
}

function continueResolvesTo(state: GameState | null | undefined): string | null {
  const action = state?.actions?.find((a) => a?.id === "continue");
  const hint = action?.paramsHint;
  if (!hint || typeof hint !== "object") return null;
  const resolvesTo = (hint as { resolvesTo?: unknown }).resolvesTo;
  return typeof resolvesTo === "string" ? resolvesTo : null;
}

function detailHas(results: Array<Pick<ActionResult, "detail" | "ok">> | undefined, needle: string): boolean {
  return (results ?? []).some(
    (r) => typeof r?.detail === "string" && r.detail.toLowerCase().includes(needle),
  );
}

export function isSettlementInProgress(
  state: GameState | null | undefined,
  lastResults?: Array<Pick<ActionResult, "detail" | "ok">> | null,
  scene?: SceneSnapshot | null,
): boolean {
  if (!state) return false;
  if (state.values?.blockingOverlay === true) return true;
  if (guideActive(state)) return true;
  const phase = phaseOf(state);
  if (SETTLEMENT_PHASES.has(phase)) return true;
  // Scene phase/modal can expose guide/story overlays while screen.phase stays "play".
  // Do not treat all blocking modals as settlement (sudan_box is blocking but allocation).
  const scenePhase = (scene?.scene?.phase ?? "").toLowerCase();
  const sceneModal = (scene?.scene?.modal ?? "").toLowerCase();
  if (SETTLEMENT_PHASES.has(scenePhase) || SETTLEMENT_PHASES.has(sceneModal)) return true;
  if (detailHas(lastResults ?? undefined, "pending_async")) return true;
  if (detailHas(lastResults ?? undefined, "rite_result=true")) return true;
  return false;
}

/** Stable play window after settlement and before card allocation. */
export function isDayPlanningReady(
  state: GameState | null | undefined,
  scene?: SceneSnapshot | null,
): boolean {
  if (!state) return false;
  if (isSettlementInProgress(state, null, scene)) return false;
  if (phaseOf(state) !== "play") return false;
  const ops = enabledOps(state);
  if (ops.has("draw_sudan_card")) return false;
  if (ops.has("place_card_on_rite")) return false;
  if (ops.has("next_day") || ops.has("next_round")) return true;
  // Legacy plugins: continue was the day-advance affordance.
  if (!ops.has("continue")) return false;
  const resolvesTo = continueResolvesTo(state);
  return resolvesTo === "next_day" || resolvesTo == null;
}

export function isCardAssignmentPhase(
  state: GameState | null | undefined,
  scene?: SceneSnapshot | null,
): boolean {
  if (!state) return false;
  if (phaseOf(state) === "sudan_draw") return true;
  if (scene?.scene?.modal === "sudan_box" || scene?.scene?.phase === "sudan_draw") return true;
  return enabledOps(state).has("draw_sudan_card");
}

function submittedDayAdvance(
  submittedOps: string[],
  results: Array<Pick<ActionResult, "ok" | "op" | "detail">>,
): boolean {
  const dayOps = submittedOps.some(
    (op) => op === "next_day" || op === "next_round",
  );
  // Legacy: old plugins routed continue -> next_day in the result detail.
  const legacyContinueAdvance = results.some(
    (r) =>
      r?.ok !== false &&
      typeof r?.detail === "string" &&
      r.detail.includes("continue -> next_day"),
  );
  if (!dayOps && !legacyContinueAdvance) return false;
  return results.some(
    (r) =>
      r?.ok !== false &&
      (r?.op === "next_day" ||
        r?.op === "next_round" ||
        dayOps ||
        legacyContinueAdvance),
  );
}

function intervalDue(boundary: DayBoundaryState, currentDay: number | null): boolean {
  if (currentDay == null) return false;
  if (boundary.lastReviewedDay == null) return true;
  return currentDay - boundary.lastReviewedDay >= boundary.intervalDays;
}

export interface DayBoundaryTickInput {
  submittedOps: string[];
  stateBefore: GameState | null | undefined;
  stateAfter: GameState;
  sceneAfter?: SceneSnapshot | null;
  results?: Array<Pick<ActionResult, "ok" | "op" | "detail">>;
}

export interface DayBoundaryTickResult {
  boundary: DayBoundaryState;
  shouldReview: boolean;
  /** Day window that was completed (usually dayBeforeAdvance). */
  reviewedDayWindow: number | null;
  reason: string;
}

/**
 * Advance the day-boundary state machine after a submit + refresh.
 * Review fires once feedback is drained and the next day is stable
 * (or about to enter sudan card allocation).
 */
export function tickDayBoundary(
  boundary: DayBoundaryState,
  input: DayBoundaryTickInput,
): DayBoundaryTickResult {
  const next: DayBoundaryState = { ...boundary };
  const beforeDay = dayOf(input.stateBefore);
  const afterDay = dayOf(input.stateAfter);
  const settlement = isSettlementInProgress(
    input.stateAfter,
    input.results,
    input.sceneAfter,
  );
  const planningReady = isDayPlanningReady(input.stateAfter, input.sceneAfter);
  const assignment = isCardAssignmentPhase(input.stateAfter, input.sceneAfter);
  const advanced =
    beforeDay != null && afterDay != null && afterDay > beforeDay;

  // Arm on successful explicit day advance from a non-blocking play context.
  if (
    (next.phase === "idle" || next.phase === "reviewed") &&
    submittedDayAdvance(input.submittedOps, input.results ?? [])
  ) {
    const beforePhase = phaseOf(input.stateBefore);
    const wasPlayish =
      beforePhase === "play" ||
      (input.stateBefore?.values?.blockingOverlay !== true &&
        !SETTLEMENT_PHASES.has(beforePhase));
    if (wasPlayish || advanced || settlement) {
      next.phase = settlement || !advanced ? "armed" : "draining_feedback";
      next.dayBeforeAdvance = beforeDay;
      next.targetDay = afterDay ?? (beforeDay != null ? beforeDay + 1 : null);
      next.stableReadyCount = 0;
    }
  }

  if (next.phase === "armed" || next.phase === "draining_feedback") {
    if (settlement) {
      next.phase = "draining_feedback";
      next.stableReadyCount = 0;
      return {
        boundary: next,
        shouldReview: false,
        reviewedDayWindow: null,
        reason: "draining_feedback",
      };
    }

    const dayReady =
      afterDay != null &&
      (next.targetDay == null || afterDay >= next.targetDay) &&
      (advanced ||
        (next.dayBeforeAdvance != null && afterDay > next.dayBeforeAdvance) ||
        (next.targetDay != null && afterDay >= next.targetDay));

    const preAllocation = planningReady || assignment;
    if (dayReady && preAllocation && intervalDue(next, afterDay)) {
      next.stableReadyCount += 1;
      // Require two consecutive stable snapshots unless we are already at sudan_draw
      // (must review before the draw action executes).
      const need = assignment ? 1 : 2;
      if (next.stableReadyCount >= need) {
        next.phase = "review_ready";
        return {
          boundary: next,
          shouldReview: true,
          reviewedDayWindow: next.dayBeforeAdvance ?? (afterDay - 1),
          reason: assignment ? "pre_card_assignment" : "day_planning_ready",
        };
      }
      next.phase = "draining_feedback";
      return {
        boundary: next,
        shouldReview: false,
        reviewedDayWindow: null,
        reason: `stabilizing_${next.stableReadyCount}/${need}`,
      };
    }

    next.stableReadyCount = 0;
    next.phase = dayReady ? "draining_feedback" : next.phase === "armed" ? "armed" : "draining_feedback";
    return {
      boundary: next,
      shouldReview: false,
      reviewedDayWindow: null,
      reason: dayReady ? "waiting_pre_allocation" : "waiting_day_advance",
    };
  }

  if (next.phase === "review_ready") {
    return {
      boundary: next,
      shouldReview: true,
      reviewedDayWindow: next.dayBeforeAdvance ?? (afterDay != null ? afterDay - 1 : null),
      reason: "review_ready",
    };
  }

  return {
    boundary: next,
    shouldReview: false,
    reviewedDayWindow: null,
    reason: next.phase,
  };
}

export function markReviewed(boundary: DayBoundaryState, reviewedDay: number): DayBoundaryState {
  return {
    ...boundary,
    phase: "reviewed",
    lastReviewedDay: reviewedDay,
    dayBeforeAdvance: null,
    targetDay: null,
    stableReadyCount: 0,
  };
}

/**
 * Before card allocation actions, force a review if a day-advance window is
 * still open and the UI has reached a pre-allocation (or sudan_draw) state.
 */
export function forceReviewBeforeAllocation(
  boundary: DayBoundaryState,
  state: GameState | null | undefined,
  scene?: SceneSnapshot | null,
): DayBoundaryTickResult {
  const next: DayBoundaryState = { ...boundary };
  if (next.phase !== "armed" && next.phase !== "draining_feedback" && next.phase !== "review_ready") {
    return {
      boundary: next,
      shouldReview: false,
      reviewedDayWindow: null,
      reason: "no_open_window",
    };
  }
  if (next.phase === "review_ready") {
    return {
      boundary: next,
      shouldReview: true,
      reviewedDayWindow: next.dayBeforeAdvance,
      reason: "review_ready",
    };
  }

  const afterDay = dayOf(state);
  const settlement = isSettlementInProgress(state, null, scene);
  if (settlement) {
    next.phase = "draining_feedback";
    return {
      boundary: next,
      shouldReview: false,
      reviewedDayWindow: null,
      reason: "still_settling",
    };
  }

  const dayReady =
    afterDay != null &&
    (next.targetDay == null || afterDay >= next.targetDay) &&
    (next.dayBeforeAdvance == null || afterDay > next.dayBeforeAdvance || afterDay >= (next.targetDay ?? afterDay));

  if (
    dayReady &&
    (isDayPlanningReady(state, scene) || isCardAssignmentPhase(state, scene)) &&
    intervalDue(next, afterDay)
  ) {
    next.phase = "review_ready";
    next.stableReadyCount = Math.max(next.stableReadyCount, 1);
    return {
      boundary: next,
      shouldReview: true,
      reviewedDayWindow: next.dayBeforeAdvance ?? (afterDay! - 1),
      reason: "force_pre_allocation",
    };
  }

  return {
    boundary: next,
    shouldReview: false,
    reviewedDayWindow: null,
    reason: "not_ready",
  };
}

/** Terminal flush: review the unfinished day window without requiring advance. */
export function shouldFlushTerminalReview(
  boundary: DayBoundaryState,
  endState: GameState | null | undefined,
): { shouldReview: boolean; reviewedDayWindow: number | null } {
  const day = dayOf(endState);
  if (day == null) return { shouldReview: false, reviewedDayWindow: null };
  if (boundary.lastReviewedDay != null && day <= boundary.lastReviewedDay) {
    return { shouldReview: false, reviewedDayWindow: null };
  }
  // If we armed a window, flush that window; otherwise flush current day once.
  const window =
    boundary.dayBeforeAdvance != null ? boundary.dayBeforeAdvance : day;
  if (boundary.lastReviewedDay != null && window <= boundary.lastReviewedDay) {
    return { shouldReview: false, reviewedDayWindow: null };
  }
  return { shouldReview: true, reviewedDayWindow: window };
}
