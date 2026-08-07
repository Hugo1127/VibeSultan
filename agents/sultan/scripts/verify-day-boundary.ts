import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GameState, SceneSnapshot } from "../src/game/types.js";
import {
  createDayBoundary,
  forceReviewBeforeAllocation,
  markReviewed,
  shouldFlushTerminalReview,
  tickDayBoundary,
} from "../src/memory/dayBoundary.js";
import {
  emptyDayReviewCursor,
  runDailyReview,
} from "../src/memory/dayReview.js";
import { EpisodeStore } from "../src/memory/episodeStore.js";
import { EpisodeTracker } from "../src/memory/episodeTracker.js";
import { createMemorySession } from "../src/memory/session.js";

function state(opts: {
  day: number;
  phase?: string;
  blocking?: boolean;
  guideActive?: boolean;
  actions?: Array<{ id: string; enabled?: boolean; paramsHint?: Record<string, unknown> }>;
}): GameState {
  return {
    schemaVersion: 1,
    game: "sultan",
    screen: { id: opts.phase ?? "play", phase: opts.phase ?? "play" },
    terminal: false,
    values: {
      day: opts.day,
      turn: opts.day,
      blockingOverlay: opts.blocking === true,
      initDone: true,
      inGame: true,
      handCount: 2,
      guide: opts.guideActive
        ? { active: true, type: "MAIN_HELP", preferredOp: null }
        : { active: false },
    },
    actions: opts.actions ?? [
      {
        id: "continue",
        enabled: true,
        paramsHint: { resolvesTo: "next_day" },
      },
    ],
  };
}

function scene(phase = "play", modal?: string): SceneSnapshot {
  return {
    snapshotVersion: 1,
    scene: { id: phase, phase, modal: modal ?? null, blocking: Boolean(modal) },
    affordances: [],
  };
}

function testContinuePendingThenRiteResultThenStable(): void {
  let boundary = createDayBoundary({ intervalDays: 1 });
  const day1 = state({ day: 1 });
  const pending = state({
    day: 1,
    phase: "play",
    actions: [{ id: "continue", enabled: false }],
  });
  let tick = tickDayBoundary(boundary, {
    submittedOps: ["continue"],
    stateBefore: day1,
    stateAfter: pending,
    sceneAfter: scene("play"),
    results: [{ ok: true, op: "continue", detail: "pending_async" }],
  });
  assert.equal(tick.shouldReview, false);
  assert.ok(["armed", "draining_feedback"].includes(tick.boundary.phase));
  boundary = tick.boundary;

  const rite = state({
    day: 2,
    phase: "rite_result",
    blocking: true,
    actions: [{ id: "continue", enabled: true, paramsHint: { resolvesTo: "rite_result_next" } }],
  });
  tick = tickDayBoundary(boundary, {
    submittedOps: [],
    stateBefore: pending,
    stateAfter: rite,
    sceneAfter: scene("rite_result"),
    results: [],
  });
  assert.equal(tick.shouldReview, false);
  assert.equal(tick.boundary.phase, "draining_feedback");
  boundary = tick.boundary;

  // Dismiss rite_result into still-unstable play once.
  const almost = state({ day: 2 });
  tick = tickDayBoundary(boundary, {
    submittedOps: ["continue"],
    stateBefore: rite,
    stateAfter: almost,
    sceneAfter: scene("play"),
    results: [{ ok: true, op: "continue", detail: "continue -> rite_result_next" }],
  });
  assert.equal(tick.shouldReview, false, "needs debounce");
  boundary = tick.boundary;

  tick = tickDayBoundary(boundary, {
    submittedOps: [],
    stateBefore: almost,
    stateAfter: almost,
    sceneAfter: scene("play"),
    results: [],
  });
  assert.equal(tick.shouldReview, true);
  assert.equal(tick.reviewedDayWindow, 1);
  assert.equal(tick.boundary.phase, "review_ready");

  boundary = markReviewed(tick.boundary, 1);
  tick = tickDayBoundary(boundary, {
    submittedOps: [],
    stateBefore: almost,
    stateAfter: almost,
    sceneAfter: scene("play"),
    results: [],
  });
  assert.equal(tick.shouldReview, false, "same day must not re-review");
}

function testFingerGuideBlocksReviewReady(): void {
  let boundary = createDayBoundary({ intervalDays: 1 });
  const before = state({ day: 1 });
  const afterContinue = state({ day: 2 });
  let tick = tickDayBoundary(boundary, {
    submittedOps: ["continue"],
    stateBefore: before,
    stateAfter: afterContinue,
    sceneAfter: scene("play"),
    results: [{ ok: true, op: "continue", detail: "continue -> next_day" }],
  });
  boundary = tick.boundary;

  const guided = state({ day: 2, guideActive: true });
  tick = tickDayBoundary(boundary, {
    submittedOps: [],
    stateBefore: afterContinue,
    stateAfter: guided,
    sceneAfter: scene("play"),
    results: [],
  });
  assert.equal(tick.shouldReview, false, "guide.active must stay in drain");
  assert.equal(tick.boundary.phase, "draining_feedback");
  boundary = tick.boundary;

  // Even a second stable snapshot while guide is up must not review.
  tick = tickDayBoundary(boundary, {
    submittedOps: [],
    stateBefore: guided,
    stateAfter: guided,
    sceneAfter: scene("guide", "begin_guide"),
    results: [],
  });
  assert.equal(tick.shouldReview, false);
  assert.equal(tick.boundary.phase, "draining_feedback");
  boundary = tick.boundary;

  const clear = state({ day: 2, guideActive: false });
  tick = tickDayBoundary(boundary, {
    submittedOps: [],
    stateBefore: guided,
    stateAfter: clear,
    sceneAfter: scene("play"),
    results: [],
  });
  assert.equal(tick.shouldReview, false, "needs debounce after guide clears");
  boundary = tick.boundary;

  tick = tickDayBoundary(boundary, {
    submittedOps: [],
    stateBefore: clear,
    stateAfter: clear,
    sceneAfter: scene("play"),
    results: [],
  });
  assert.equal(tick.shouldReview, true);
  assert.equal(tick.reviewedDayWindow, 1);
  assert.equal(tick.boundary.phase, "review_ready");
}

function testDirectSudanDrawForcesPreAllocationReview(): void {
  let boundary = createDayBoundary({ intervalDays: 1 });
  const before = state({ day: 3 });
  const after = state({
    day: 4,
    phase: "sudan_draw",
    actions: [{ id: "draw_sudan_card", enabled: true }],
  });
  let tick = tickDayBoundary(boundary, {
    submittedOps: ["continue"],
    stateBefore: before,
    stateAfter: after,
    sceneAfter: scene("sudan_draw", "sudan_box"),
    results: [{ ok: true, op: "continue", detail: "continue -> next_day" }],
  });
  // May already be ready (assignment needs only 1 stable snapshot).
  if (!tick.shouldReview) {
    const forced = forceReviewBeforeAllocation(
      tick.boundary,
      after,
      scene("sudan_draw", "sudan_box"),
    );
    assert.equal(forced.shouldReview, true);
    assert.equal(forced.reviewedDayWindow, 3);
    boundary = markReviewed(forced.boundary, 3);
  } else {
    assert.equal(tick.reviewedDayWindow, 3);
    boundary = markReviewed(tick.boundary, 3);
  }

  const forcedAgain = forceReviewBeforeAllocation(
    boundary,
    after,
    scene("sudan_draw", "sudan_box"),
  );
  assert.equal(forcedAgain.shouldReview, false);
}

function testResumeCursorSkipsReviewedDay(): void {
  const boundary = createDayBoundary({ intervalDays: 1, lastReviewedDay: 2 });
  const tick = tickDayBoundary(boundary, {
    submittedOps: ["continue"],
    stateBefore: state({ day: 2 }),
    stateAfter: state({ day: 3 }),
    sceneAfter: scene("play"),
    results: [{ ok: true, op: "continue", detail: "ok" }],
  });
  // Still needs drain/stability, but interval due uses lastReviewedDay=2 and day=3.
  let b = tick.boundary;
  b = tickDayBoundary(b, {
    submittedOps: [],
    stateBefore: state({ day: 3 }),
    stateAfter: state({ day: 3 }),
    sceneAfter: scene("play"),
    results: [],
  }).boundary;
  const ready = tickDayBoundary(b, {
    submittedOps: [],
    stateBefore: state({ day: 3 }),
    stateAfter: state({ day: 3 }),
    sceneAfter: scene("play"),
    results: [],
  });
  assert.equal(ready.shouldReview, true);
  assert.equal(ready.reviewedDayWindow, 2);
}

function testTerminalFlushOnce(): void {
  let boundary = createDayBoundary({ intervalDays: 1, lastReviewedDay: null });
  boundary = {
    ...boundary,
    phase: "draining_feedback",
    dayBeforeAdvance: 5,
    targetDay: 6,
  };
  const flush = shouldFlushTerminalReview(boundary, state({ day: 5, phase: "terminal" }));
  assert.equal(flush.shouldReview, true);
  assert.equal(flush.reviewedDayWindow, 5);
  boundary = markReviewed(boundary, 5);
  const again = shouldFlushTerminalReview(boundary, state({ day: 5, phase: "terminal" }));
  assert.equal(again.shouldReview, false);
}

function testDailyReviewPersistenceAndAdjacentValidation(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sultan-day-review-"));
  const session = createMemorySession(root, "daily-1");
  let cursor = emptyDayReviewCursor(1);

  const day1State = state({ day: 1 });
  const r1 = runDailyReview({
    sessionDir: session.dir,
    runId: "runA",
    dayWindow: 1,
    state: day1State,
    traces: [{ decisionKey: "continue:continue", action: "submit_actions", rationale: "end day 1", observationIds: [] }],
    cursor,
    budgetChars: 4000,
  });
  assert.ok(r1.createdHypothesisId);
  assert.ok(r1.createdTipId, "early_explore must also create a tip");
  assert.equal(r1.dayEvidenceAppended, true);
  assert.equal(r1.cursor.lastReviewedDay, 1);
  assert.match(r1.memoryInjection, /本局每日记忆/);
  const tipsAfterDay1 = JSON.parse(
    fs.readFileSync(path.join(session.dir, "tips.json"), "utf8"),
  ) as { tips: Array<{ id: string; status: string; sourceHypothesisId?: string }> };
  assert.equal(tipsAfterDay1.tips.length, 1);
  assert.equal(tipsAfterDay1.tips[0]!.sourceHypothesisId, r1.createdHypothesisId);
  assert.ok(["candidate", "experimental"].includes(tipsAfterDay1.tips[0]!.status));
  cursor = r1.cursor;

  const day2State = {
    ...state({ day: 2 }),
    values: {
      ...state({ day: 2 }).values,
      resources: { gold: 200 },
      sudan: { remaining: 5, initLife: 7 },
      handCount: 4,
    },
  };
  const r2 = runDailyReview({
    sessionDir: session.dir,
    runId: "runA",
    dayWindow: 2,
    state: day2State,
    traces: [
      { decisionKey: "open_daily_news", action: "submit_actions", rationale: "scout", observationIds: [] },
      { decisionKey: "open_rite", action: "submit_actions", rationale: "map", observationIds: [] },
      { decisionKey: "inspect_card", action: "submit_actions", rationale: "hand", observationIds: [] },
    ],
    cursor,
    budgetChars: 4000,
  });
  assert.ok(r2.evaluatedHypothesisId);
  assert.equal(r2.cursor.lastReviewedDay, 2);
  assert.ok(fs.existsSync(path.join(session.dir, "day-evidence.jsonl")));

  const tipsAfterDay2 = JSON.parse(
    fs.readFileSync(path.join(session.dir, "tips.json"), "utf8"),
  ) as { tips: Array<{ id: string; status: string; sourceHypothesisId?: string }> };
  const settled = tipsAfterDay2.tips.find((t) => t.id === r1.createdTipId);
  assert.ok(settled);
  assert.ok(
    ["active", "rejected", "experimental"].includes(settled!.status),
    `expected tip status iterated, got ${settled!.status}`,
  );

  const outcomes = fs
    .readFileSync(path.join(session.dir, "outcomes.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(outcomes.length, 2);
  assert.match(outcomes[0]!, /runA:day1/);
  assert.match(outcomes[1]!, /runA:day2/);
}

function testEpisodeSettlementSurvivesContinueDrain(): void {
  // Day-boundary continue drain must not prevent episode settlement on later refreshes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sultan-day-episode-"));
  const tracker = new EpisodeTracker(new EpisodeStore(dir));
  tracker.recordSubmit({
    version: { gameFingerprint: "g1", configFingerprint: "cfg" },
    eventKey: "cfg:rite:9",
    riteId: 9,
    step: 1,
  });
  const pendingContinue = tickDayBoundary(createDayBoundary({ intervalDays: 1 }), {
    submittedOps: ["continue"],
    stateBefore: state({ day: 2 }),
    stateAfter: state({ day: 2, phase: "rite_result" }),
    sceneAfter: scene("rite_result"),
    results: [{ ok: true, op: "continue" }],
  });
  assert.equal(pendingContinue.shouldReview, false);

  const settlements = tracker.observeState(
    {
      ...state({ day: 2, phase: "rite_result" }),
      values: {
        ...state({ day: 2, phase: "rite_result" }).values,
        riteResult: { active: true, successCount: 2, successThreshold: 2 },
      },
    },
    { step: 2 },
  );
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]!.outcome, "positive");
}

function main(): void {
  testContinuePendingThenRiteResultThenStable();
  testFingerGuideBlocksReviewReady();
  testDirectSudanDrawForcesPreAllocationReview();
  testResumeCursorSkipsReviewedDay();
  testTerminalFlushOnce();
  testDailyReviewPersistenceAndAdjacentValidation();
  testEpisodeSettlementSurvivesContinueDrain();
  console.log("verify-day-boundary: ok");
}

main();
