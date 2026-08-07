import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ExperimentLedger,
  ExperienceStore,
  HypothesisStore,
  TipStore,
  computeBestSoFar,
  newExperimentPlanId,
  selectNextExperiment,
  type Outcome,
} from "@vibesultan/agent-learning-core";
import {
  buildComparisonKey,
  buildMemoryInjection,
  classifyOutcome,
  extractEvidence,
  extractMetrics,
  filterPlaybookHypotheses,
  isTerminalState,
  primaryMetricForTopic,
  selectLastEarlySnapshotPerGame,
  summarizeRun,
} from "../src/memory/sultanAdapter.js";
import {
  emptyDayReviewCursor,
  runDailyReview,
} from "../src/memory/dayReview.js";
import { refreshSkillPlaybook } from "../src/memory/skillPlaybook.js";
import { createMemorySession } from "../src/memory/session.js";
import { strategyExercised } from "../src/memory/compliance.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-agent-learning-"));
}

function sampleState(opts?: {
  terminal?: boolean;
  valuesTerminal?: boolean;
  screenPhase?: string;
  screenId?: string;
  day?: number;
  gold?: number;
  goldDice?: number;
  sudanRemaining?: number;
  initLife?: number;
  questProgress?: number;
  handCount?: number;
  riteCount?: number;
}) {
  const day = opts?.day ?? 8;
  const gold = opts?.gold ?? 120;
  const terminal = opts?.terminal === true;
  return {
    schemaVersion: 1,
    game: "sultan",
    terminal,
    screen: {
      id: opts?.screenId ?? (terminal ? "terminal" : "play"),
      phase: opts?.screenPhase ?? (terminal ? "terminal" : "play"),
    },
    values: {
      day,
      turn: day,
      terminal: opts?.valuesTerminal === true ? true : undefined,
      resources: { gold, goldDice: opts?.goldDice ?? 0 },
      counters: { questProgress: opts?.questProgress ?? 2 },
      sudan: {
        remaining: opts?.sudanRemaining ?? 1,
        initLife: opts?.initLife ?? 7,
      },
      handCount: opts?.handCount ?? 3,
      riteCount: opts?.riteCount ?? 1,
      fingerprint: "fp-test",
      cards: [{ uid: 1, id: 2000029, name: "金币", count: gold, type: "item" }],
    },
  };
}

function loadOutcomes(sessionDir: string): Outcome[] {
  const p = path.join(sessionDir, "outcomes.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Outcome);
}

function testAdapter(): void {
  const state = sampleState({ day: 8, gold: 120 });
  const metrics = extractMetrics(state);
  assert.equal(metrics.day, 8);
  assert.equal(metrics.gold, 120);
  assert.equal(metrics.sudanRemaining, 1);
  assert.equal(metrics.earlyEligible, 1);
  assert.ok(typeof metrics.earlyScore === "number");
  assert.equal(metrics.score, metrics.earlyScore);

  // Fallback: derive sudan remaining from initLife + day when remaining missing.
  const derived = extractMetrics({
    ...state,
    values: { ...state.values, sudan: { initLife: 7 }, day: 1 },
  });
  assert.equal(derived.sudanRemaining, 7);

  // Fallback: gold from cards when resources missing.
  const fromCards = extractMetrics({
    ...state,
    values: {
      ...state.values,
      resources: {},
      cards: [{ uid: 9, name: "金币", count: 4 }],
    },
  });
  assert.equal(fromCards.gold, 4);

  assert.equal(primaryMetricForTopic("rite_efficiency").name, "gold");
  assert.equal(primaryMetricForTopic("early_explore").name, "earlyScore");
  assert.equal(primaryMetricForTopic("sudan_pressure").name, "earlyScore");

  const key = buildComparisonKey(state);
  assert.match(key, /screen=play/);
  assert.match(key, /day=8/);

  const evidence = extractEvidence(state);
  assert.equal(evidence.observations.length, 1);
  assert.equal(evidence.metrics.day, 8);

  const outcome = classifyOutcome(state, metrics);
  assert.equal(outcome, "provisional_positive");

  const summary = summarizeRun(state, "test final", "max_steps");
  assert.match(summary, /对局摘要/);

  const injection = buildMemoryInjection(
    [
      { claim: "c1", constraints: "x", status: "candidate" },
      { claim: "c2", constraints: "y", status: "validated" },
    ],
    [
      { title: "t1", body: "b1", status: "candidate" },
      { title: "t2", body: "b2", status: "active" },
    ],
    4000,
  );
  assert.match(injection, /c2/);
  assert.doesNotMatch(injection, /c1/);
  assert.match(injection, /t2/);
  assert.doesNotMatch(injection, /t1/);
  assert.equal(filterPlaybookHypotheses([{ status: "candidate" }, { status: "validated" }]).length, 1);
}

function testEarlyScoreBoundaries(): void {
  // Multiple terminal encodings must all be excluded from early scoring.
  assert.equal(isTerminalState(sampleState({ terminal: true })), true);
  assert.equal(
    isTerminalState(
      sampleState({ terminal: false, valuesTerminal: true, screenPhase: "play", screenId: "play" }),
    ),
    true,
  );
  assert.equal(
    isTerminalState(
      sampleState({ terminal: false, screenPhase: "terminal", screenId: "result" }),
    ),
    true,
  );
  assert.equal(
    isTerminalState(sampleState({ terminal: false, screenPhase: "play", screenId: "terminal" })),
    true,
  );

  const terminalMetrics = extractMetrics(sampleState({ terminal: true, day: 8, gold: 999 }));
  assert.equal(terminalMetrics.earlyEligible, 0);
  assert.equal(terminalMetrics.earlyScore, null);
  assert.equal(classifyOutcome(sampleState({ terminal: true }), terminalMetrics), "negative");

  // Same day: more resources => higher earlyScore.
  const poor = extractMetrics(
    sampleState({
      day: 3,
      gold: 5,
      goldDice: 0,
      questProgress: 1,
      handCount: 3,
      riteCount: 1,
      sudanRemaining: 5,
    }),
  );
  const rich = extractMetrics(
    sampleState({
      day: 3,
      gold: 30,
      goldDice: 2,
      questProgress: 4,
      handCount: 8,
      riteCount: 4,
      sudanRemaining: 5,
    }),
  );
  assert.ok(typeof poor.earlyScore === "number");
  assert.ok(typeof rich.earlyScore === "number");
  assert.ok((rich.earlyScore as number) > (poor.earlyScore as number));

  // Survive one more day beats previous-day resource stacking (even with gold capped high).
  const day2Rich = extractMetrics(
    sampleState({
      day: 2,
      gold: 999,
      goldDice: 99,
      questProgress: 20,
      handCount: 20,
      riteCount: 20,
      sudanRemaining: 7,
    }),
  );
  const day3Poor = extractMetrics(
    sampleState({
      day: 3,
      gold: 0,
      goldDice: 0,
      questProgress: 0,
      handCount: 0,
      riteCount: 0,
      sudanRemaining: 1,
    }),
  );
  assert.ok((day3Poor.earlyScore as number) > (day2Rich.earlyScore as number));
}

function testCompliance(): void {
  assert.equal(
    strategyExercised({
      topicKey: "early_explore",
      traces: [
        { decisionKey: "open_daily_news", action: "submit_actions", rationale: "news", observationIds: [] },
        { decisionKey: "inspect_card", action: "submit_actions", rationale: "card", observationIds: [] },
      ],
    }),
    true,
  );
  assert.equal(
    strategyExercised({
      topicKey: "early_explore",
      traces: [],
    }),
    false,
  );
}

function testLearningStores(): void {
  const dir = tempDir();
  const hypothesisStore = new HypothesisStore(dir);
  const tipStore = new TipStore(dir);
  const ledger = new ExperimentLedger(dir);

  const h = hypothesisStore.create({
    claim: "Prioritize story events when sudan countdown is low",
    rationale: "observed in explore run",
    constraints: "sudanRemaining <= 3",
    topicKey: "sudan_pressure",
    sourceInstanceId: "run-test-1",
    sessionIndex: 1,
    primaryMetric: { name: "earlyScore", direction: "increase" },
  });
  assert.ok(h.id.startsWith("h_"));

  const t = tipStore.create({
    decisionKey: "prioritize_story",
    title: "Low sudan countdown",
    body: "Pick story options before rites when sudan remaining <= 3.",
    sourceInstanceId: "run-test-1",
    sourceHypothesisId: h.id,
  });
  assert.ok(t.id.length > 0);

  const planId = newExperimentPlanId();
  ledger.enqueue({
    id: planId,
    hypothesisId: h.id,
    instanceId: "run-test-1",
    primaryMetric: h.primaryMetric!,
    enqueuedAt: new Date().toISOString(),
    priority: 5,
  });
  assert.equal(ledger.size(), 1);

  const selected = selectNextExperiment(hypothesisStore.list(), ledger.list());
  assert.equal(selected.plan?.hypothesisId, h.id);
  assert.equal(selected.hypothesis?.id, h.id);

  const outcomes: Outcome[] = [
    {
      runId: "r1",
      score: 80,
      metrics: { score: 80 },
      outcomeClass: "pending",
      recordedAt: new Date().toISOString(),
    },
    {
      runId: "r2",
      score: 120,
      metrics: { score: 120 },
      outcomeClass: "provisional_positive",
      recordedAt: new Date().toISOString(),
    },
  ];
  const best = computeBestSoFar(outcomes.map((o) => o.score));
  assert.deepEqual(best, [80, 120]);

  const experienceStore = new ExperienceStore(dir);
  const exp = experienceStore.createOrAccumulate({
    version: { gameFingerprint: "g", configFingerprint: "fp-test" },
    actionSignature: "start_rite",
    contextSignature: "day=8|phase=play",
    positive: true,
  });
  assert.ok(exp.id.startsWith("exp_"));
  assert.equal(experienceStore.listCompatible({
    gameFingerprint: "g",
    configFingerprint: "fp-test",
  }).length, 1);
}

function testDailyReviewSameGame(): void {
  const root = tempDir();
  const session = createMemorySession(root, "learning-daily");
  let cursor = emptyDayReviewCursor(1);
  const r1 = runDailyReview({
    sessionDir: session.dir,
    runId: "game1",
    dayWindow: 1,
    state: sampleState({ day: 1, gold: 10, sudanRemaining: 7, initLife: 7 }),
    traces: [
      { decisionKey: "open_daily_news", action: "submit_actions", rationale: "scout", observationIds: [] },
      { decisionKey: "inspect_card", action: "submit_actions", rationale: "scout", observationIds: [] },
    ],
    cursor,
    budgetChars: 3000,
    finalText: "day1 done",
  });
  assert.ok(r1.createdHypothesisId);
  assert.ok(r1.createdTipId);
  assert.equal(r1.dayEvidenceAppended, true);
  assert.equal(r1.outcomeAppended, true);
  assert.ok(fs.existsSync(path.join(session.dir, "day-evidence.jsonl")));
  assert.equal(r1.cursor.lastReviewedDay, 1);
  cursor = r1.cursor;

  const r2 = runDailyReview({
    sessionDir: session.dir,
    runId: "game1",
    dayWindow: 2,
    state: sampleState({ day: 2, gold: 40, sudanRemaining: 6, initLife: 7 }),
    traces: [
      { decisionKey: "open_rite", action: "submit_actions", rationale: "map", observationIds: [] },
      { decisionKey: "place_card_on_rite", action: "submit_actions", rationale: "alloc", observationIds: [] },
    ],
    cursor,
    budgetChars: 3000,
    finalText: "day2 done",
  });
  assert.ok(r2.evaluatedHypothesisId);
  assert.equal(r2.cursor.lastReviewedDay, 2);
  assert.match(r2.memoryInjection, /待同局验证假设|本局每日记忆|跨局记忆/);

  const outcomes = loadOutcomes(session.dir);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]!.metrics.earlyEligible, 1);
  assert.ok(typeof outcomes[0]!.metrics.earlyScore === "number");
  assert.equal(outcomes[0]!.score, outcomes[0]!.metrics.earlyScore);

  // Day evidence written every day even when proposal is deduped.
  const evidenceLines = fs
    .readFileSync(path.join(session.dir, "day-evidence.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(evidenceLines.length, 2);
  const latestEvidence = JSON.parse(evidenceLines[1]!) as {
    entityUpdates?: { cards?: { total?: number } };
  };
  assert.ok(latestEvidence.entityUpdates);
  assert.equal(typeof latestEvidence.entityUpdates?.cards?.total, "number");

  const skill = refreshSkillPlaybook(session.dir, { gameIndex: 1 });
  assert.ok(skill.promoted || skill.path);
}

function testNoTemplateSpamWhileActive(): void {
  const root = tempDir();
  const session = createMemorySession(root, "learning-dedupe");
  let cursor = emptyDayReviewCursor(1);
  const r1 = runDailyReview({
    sessionDir: session.dir,
    runId: "g",
    dayWindow: 1,
    state: sampleState({ day: 1, gold: 5, sudanRemaining: 7 }),
    traces: [],
    cursor,
    budgetChars: 2000,
  });
  cursor = r1.cursor;
  assert.ok(r1.createdHypothesisId);

  // Empty traces => strategy_not_exercised => keep active, no new early_explore clone.
  const r2 = runDailyReview({
    sessionDir: session.dir,
    runId: "g",
    dayWindow: 2,
    state: sampleState({ day: 2, gold: 5, sudanRemaining: 6 }),
    traces: [],
    cursor,
    budgetChars: 2000,
  });
  assert.equal(r2.evaluationDecision, "inconclusive");
  assert.equal(r2.proposed, false);
  assert.equal(r2.createdHypothesisId, undefined);
  assert.equal(r2.cursor.activeHypothesisId, r1.createdHypothesisId);

  const hyps = JSON.parse(
    fs.readFileSync(path.join(session.dir, "hypotheses.json"), "utf8"),
  ) as { hypotheses: unknown[] };
  assert.equal(hyps.hypotheses.length, 1);
}

function testTerminalFlushIsolated(): void {
  const root = tempDir();
  const session = createMemorySession(root, "learning-terminal");
  let cursor = emptyDayReviewCursor(1);
  const r1 = runDailyReview({
    sessionDir: session.dir,
    runId: "gameT",
    dayWindow: 1,
    state: sampleState({ day: 1, gold: 8, sudanRemaining: 7 }),
    traces: [
      { decisionKey: "open_daily_news", action: "submit_actions", rationale: "scout", observationIds: [] },
      { decisionKey: "inspect_card", action: "submit_actions", rationale: "scout", observationIds: [] },
    ],
    cursor,
    budgetChars: 3000,
  });
  cursor = r1.cursor;
  assert.ok(r1.createdHypothesisId);
  assert.equal(r1.outcomeAppended, true);
  const hypBefore = JSON.parse(
    fs.readFileSync(path.join(session.dir, "hypotheses.json"), "utf8"),
  ) as { hypotheses: Array<{ id: string; status: string }> };
  assert.equal(hypBefore.hypotheses.length, 1);
  assert.equal(hypBefore.hypotheses[0]!.status, "candidate");

  const tipBefore = JSON.parse(
    fs.readFileSync(path.join(session.dir, "tips.json"), "utf8"),
  ) as { tips: Array<{ evidence: { observationCount: number } }> };
  const tipObsBefore = tipBefore.tips[0]?.evidence.observationCount ?? 0;

  const flush = runDailyReview({
    sessionDir: session.dir,
    runId: "gameT",
    dayWindow: 2,
    state: sampleState({ terminal: true, day: 8, gold: 999 }),
    traces: [
      { decisionKey: "open_rite", action: "submit_actions", rationale: "end", observationIds: [] },
    ],
    cursor,
    budgetChars: 3000,
    terminalFlush: true,
    finalText: "game over",
    stopReason: "terminal",
  });

  assert.equal(flush.outcomeAppended, false);
  assert.equal(flush.proposed, false);
  assert.equal(flush.createdHypothesisId, undefined);
  assert.equal(flush.evaluatedHypothesisId, undefined);
  assert.equal(flush.cursor.activeHypothesisId, r1.createdHypothesisId);
  assert.equal(flush.cursor.lastReviewedDay, 1);
  assert.equal(flush.dayEvidenceAppended, true);

  const outcomes = loadOutcomes(session.dir);
  assert.equal(outcomes.length, 1);
  assert.ok(!outcomes.some((o) => o.runId.includes(":day2")));

  const hypAfter = JSON.parse(
    fs.readFileSync(path.join(session.dir, "hypotheses.json"), "utf8"),
  ) as { hypotheses: Array<{ id: string; status: string }> };
  assert.equal(hypAfter.hypotheses.length, 1);
  assert.equal(hypAfter.hypotheses[0]!.status, "candidate");

  const tipAfter = JSON.parse(
    fs.readFileSync(path.join(session.dir, "tips.json"), "utf8"),
  ) as { tips: Array<{ evidence: { observationCount: number } }> };
  assert.equal(tipAfter.tips[0]?.evidence.observationCount ?? 0, tipObsBefore);
}

function testEarlyCurveAggregation(): void {
  const outcomes: Outcome[] = [
    {
      runId: "runA:day1",
      score: 1100,
      metrics: { earlyEligible: 1, earlyScore: 1100, dayWindow: 1, day: 1 },
      outcomeClass: "pending",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      runId: "runA:day2",
      score: 2200,
      metrics: { earlyEligible: 1, earlyScore: 2200, dayWindow: 2, day: 2 },
      outcomeClass: "pending",
      recordedAt: "2026-01-01T01:00:00.000Z",
    },
    {
      runId: "runA",
      score: null,
      metrics: { earlyEligible: 0, earlyScore: null, day: 8 },
      outcomeClass: "negative",
      recordedAt: "2026-01-01T02:00:00.000Z",
    },
    {
      runId: "runB:day1",
      score: 1050,
      metrics: { earlyEligible: 1, earlyScore: 1050, dayWindow: 1, day: 1 },
      outcomeClass: "pending",
      recordedAt: "2026-01-02T00:00:00.000Z",
    },
    // Legacy row without earlyEligible must be ignored.
    {
      runId: "legacy:day3",
      score: 9999,
      metrics: { day: 3, score: 9999 },
      outcomeClass: "pending",
      recordedAt: "2026-01-02T01:00:00.000Z",
    },
  ];

  const points = selectLastEarlySnapshotPerGame(outcomes);
  assert.equal(points.length, 2);
  assert.equal(points[0]!.baseRunId, "runA");
  assert.equal(points[0]!.earlyScore, 2200);
  assert.equal(points[0]!.dayWindow, 2);
  assert.equal(points[1]!.baseRunId, "runB");
  assert.equal(points[1]!.earlyScore, 1050);

  const actual = points.map((p) => p.earlyScore);
  const best = computeBestSoFar(actual);
  assert.deepEqual(actual, [2200, 1050]);
  assert.deepEqual(best, [2200, 2200]);
}

function main(): void {
  testAdapter();
  testEarlyScoreBoundaries();
  testCompliance();
  testLearningStores();
  testDailyReviewSameGame();
  testNoTemplateSpamWhileActive();
  testTerminalFlushIsolated();
  testEarlyCurveAggregation();
  console.log("verify:learning OK");
}

main();
