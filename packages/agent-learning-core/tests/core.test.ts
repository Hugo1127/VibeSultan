import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimSimilarity,
  computeAttribution,
  computeBestSoFar,
  EntityKnowledgeStore,
  evaluateSelectionGate,
  ExperimentLedger,
  findDuplicate,
  guardrailPassed,
  HypothesisStore,
  learningCurveFromOutcomes,
  newExperimentPlanId,
  primaryMetricImproved,
  selectNextExperiment,
  SkillArtifactStore,
  TipStore,
  type ConceptExtractor,
  type Hypothesis,
  type Outcome,
} from "../src/index.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-core-"));
}

function gameAFixtures(): {
  hypotheses: Hypothesis[];
  extractConcepts: ConceptExtractor;
} {
  const extractConcepts: ConceptExtractor = (text) => {
    const patterns: Array<[string, RegExp]> = [
      ["resource_boost", /resourceA|boost|expand/i],
      ["efficiency", /efficiency|optimize|reduce waste/i],
      ["exploration", /explore|scan|discover/i],
    ];
    return new Set(
      patterns.filter(([, re]) => re.test(text)).map(([name]) => name),
    );
  };

  const hypotheses: Hypothesis[] = [
    {
      id: "h_gameA_1",
      status: "candidate",
      topicKey: "resource_management",
      claim: "Boost resourceA early to expand capacity",
      rationale: "gameA observation",
      constraints: "when resourceA is low",
      sourceInstanceId: "gameA-run-1",
      sessionIndex: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      evidence: {
        observations: [],
        metrics: { score: 120, resourceA: 40 },
        notes: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      outcomeClass: "pending",
      nextAction: "await_validate",
      primaryMetric: { name: "score", direction: "increase" },
    },
    {
      id: "h_gameA_2",
      status: "candidate",
      topicKey: "resource_management",
      claim: "Expand resourceA capacity at start",
      rationale: "similar claim",
      constraints: "early phase",
      sourceInstanceId: "gameA-run-2",
      sessionIndex: 2,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      evidence: {
        observations: [],
        metrics: {},
        notes: [],
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      outcomeClass: "pending",
      nextAction: "await_validate",
      primaryMetric: { name: "score", direction: "increase" },
    },
  ];

  return { hypotheses, extractConcepts };
}

function testDedupe(): void {
  const { hypotheses, extractConcepts } = gameAFixtures();
  const duplicate = findDuplicate(
    "Boost resourceA early to expand output",
    "resource_management",
    hypotheses,
    undefined,
    0.5,
    extractConcepts,
  );
  assert.ok(duplicate);
  assert.equal(duplicate!.hypothesisId, "h_gameA_1");
  assert.ok(claimSimilarity(hypotheses[0]!.claim, hypotheses[1]!.claim, extractConcepts) > 0.4);

  const gameBOnly = hypotheses.filter((h) => h.sourceInstanceId.startsWith("gameB"));
  assert.equal(
    findDuplicate("Unrelated gameB strategy", "other_topic", gameBOnly),
    null,
  );
}

function testHypothesisCreate(): void {
  const dir = tempDir();
  const store = new HypothesisStore(dir);
  const created = store.create({
    claim: "Increase score by prioritizing resourceA",
    rationale: "gameB session",
    constraints: "mid phase",
    topicKey: "efficiency",
    sourceInstanceId: "gameB-run-1",
    sessionIndex: 3,
    primaryMetric: { name: "score", direction: "increase" },
  });
  assert.equal(created.status, "candidate");
  assert.equal(created.nextAction, "await_validate");
  assert.equal(store.list().length, 1);

  const updated = store.setStatus(created.id, "validating");
  assert.equal(updated?.status, "validating");
}

function testTipEvidence(): void {
  const dir = tempDir();
  const store = new TipStore(dir);
  const tip = store.create({
    decisionKey: "resourceA_priority",
    title: "Prioritize resourceA",
    body: "When resourceA is low, allocate workers to gather resourceA",
    sourceInstanceId: "gameA-run-3",
  });
  const enriched = store.addEvidence(tip.id, {
    observations: 2,
    positives: 1,
    negatives: 0,
    netValues: [12, 8],
    sessionIndex: 4,
  });
  assert.equal(enriched?.evidence.observationCount, 2);
  assert.equal(enriched?.evidence.positiveCount, 1);
  assert.equal(enriched?.evidence.netValueSum, 20);
  assert.equal(enriched?.evidence.lastUpdatedSessionIndex, 4);
}

function testExperimentLedger(): void {
  const dir = tempDir();
  const ledger = new ExperimentLedger(dir);
  const plan = {
    id: newExperimentPlanId(),
    hypothesisId: "h_gameA_1",
    instanceId: "gameA-run-1",
    primaryMetric: { name: "score", direction: "increase" as const },
    enqueuedAt: new Date().toISOString(),
    priority: 10,
  };
  ledger.enqueue(plan);
  assert.equal(ledger.peek()?.id, plan.id);
  assert.equal(ledger.size(), 1);
  const dequeued = ledger.dequeue();
  assert.equal(dequeued?.id, plan.id);
  assert.equal(ledger.size(), 0);

  const reloaded = new ExperimentLedger(dir);
  assert.equal(reloaded.size(), 0);
}

function testResearchAgenda(): void {
  const { hypotheses } = gameAFixtures();
  const plan = {
    id: newExperimentPlanId(),
    hypothesisId: "h_gameA_1",
    instanceId: "gameA-run-1",
    primaryMetric: { name: "score", direction: "increase" as const },
    enqueuedAt: new Date().toISOString(),
    priority: 5,
  };
  const selection = selectNextExperiment(hypotheses, [plan]);
  assert.equal(selection.plan?.hypothesisId, "h_gameA_1");
  assert.ok(selection.hypothesis);
}

function testAttribution(): void {
  const baseline = { score: 100, resourceA: 30, waste: 12 };
  const retest = { score: 118, resourceA: 35, waste: 9 };
  const attribution = computeAttribution(baseline, retest);
  assert.equal(attribution.deltas.score, 18);
  assert.equal(attribution.deltas.resourceA, 5);
  assert.equal(attribution.deltas.waste, -3);
  assert.equal(
    primaryMetricImproved(attribution, { name: "score", direction: "increase" }),
    true,
  );
  assert.equal(
    guardrailPassed(attribution, { name: "score", maxRegressionRatio: 0.1 }),
    true,
  );
}

function testLearningCurve(): void {
  const outcomes: Outcome[] = [
    {
      runId: "gameA-1",
      score: 80,
      metrics: { score: 80 },
      outcomeClass: "pending",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      runId: "gameA-2",
      score: 95,
      metrics: { score: 95 },
      outcomeClass: "positive",
      recordedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      runId: "gameB-1",
      score: null,
      metrics: { score: 90 },
      outcomeClass: "confounded",
      recordedAt: "2026-01-03T00:00:00.000Z",
    },
  ];
  const curve = learningCurveFromOutcomes(outcomes);
  assert.deepEqual(curve.map((p) => p.bestSoFar), [80, 95, 95]);
  assert.deepEqual(computeBestSoFar([50, null, 60, 55]), [50, 50, 60, 60]);
}

function testSkilloptGate(): void {
  const dir = tempDir();
  const store = new SkillArtifactStore(dir);
  const baseline = { selectionScore: 0.72, hiddenScore: 0.65 };
  const improved = { selectionScore: 0.78, hiddenScore: 0.64 };
  const accepted = evaluateSelectionGate(baseline, improved, {
    hiddenRegressionMax: 0.05,
    allowBootstrap: false,
  });
  assert.equal(accepted.accept, true);

  const regressed = evaluateSelectionGate(baseline, {
    selectionScore: 0.8,
    hiddenScore: 0.5,
  }, {
    hiddenRegressionMax: 0.05,
    allowBootstrap: false,
  });
  assert.equal(regressed.accept, false);
  assert.match(regressed.reason, /hidden_regression/);

  const candidate = store.writeCandidate({
    content: "# Skill\n\n- Prioritize resourceA\n",
    parentVersion: null,
    edits: [{ op: "add", target: "principles", rationale: "test" }],
    selectionScore: 0.78,
    hiddenScore: 0.64,
  });
  assert.equal(candidate.version, 1);
  store.promote(1);
  assert.ok(store.readBest()?.includes("resourceA"));
}

function testEntityKnowledgeStore(): void {
  const dir = tempDir();
  const version = {
    gameFingerprint: "game-a",
    configFingerprint: "config-a",
  };
  const store = new EntityKnowledgeStore(dir, {
    fileName: "cards.json",
    entityKind: "card",
  });
  const created = store.touch({
    key: "config-a:card:10",
    kind: "card",
    version,
    facts: { cardId: 10, name: "Worker" },
    runId: "run-1",
  });
  assert.equal(created.encounterCount, 1);
  assert.equal(created.status, "observed");

  const touched = store.touch({
    key: "config-a:card:10",
    kind: "card",
    version,
    facts: { type: "character" },
  });
  assert.equal(touched.id, created.id);
  assert.equal(touched.encounterCount, 2);
  assert.equal(touched.facts.name, "Worker");
  assert.equal(touched.facts.type, "character");

  store.addEvidence(created.key, version, {
    outcome: "positive",
    summary: "worked in estate",
  });
  store.addEvidence(created.key, version, {
    outcome: "positive",
    summary: "worked in court",
  });
  const validated = store.addEvidence(created.key, version, {
    outcome: "positive",
    summary: "worked again",
  });
  assert.equal(validated?.status, "validated");
  assert.equal(validated?.sampleCount, 3);
  assert.ok((validated?.confidence ?? 0) >= 0.65);

  store.touch({
    key: "config-b:card:10",
    kind: "card",
    version: { ...version, configFingerprint: "config-b" },
    facts: { cardId: 10 },
  });
  assert.equal(store.listCompatible(version).length, 1);
  assert.deepEqual(
    store.retrieveByKeys({
      version,
      keys: [created.key],
      statuses: ["validated"],
    }).map((record) => record.id),
    [created.id],
  );

  const reloaded = new EntityKnowledgeStore(dir, {
    fileName: "cards.json",
    entityKind: "card",
  });
  assert.equal(reloaded.get(created.key, version)?.positiveCount, 3);
  assert.ok(reloaded.audit.read().some((event) => event.entityKind === "card"));
}

function run(): void {
  testDedupe();
  testHypothesisCreate();
  testTipEvidence();
  testExperimentLedger();
  testResearchAgenda();
  testAttribution();
  testLearningCurve();
  testSkilloptGate();
  testEntityKnowledgeStore();
  console.log("core.test.ts: all tests passed");
}

run();
