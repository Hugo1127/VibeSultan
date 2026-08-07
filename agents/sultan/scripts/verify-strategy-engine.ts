import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExperienceStore } from "@vibesultan/agent-learning-core";
import type { GameState, SceneSnapshot } from "../src/game/types.js";
import { buildStrategySnapshot, versionKeyFromState } from "../src/memory/experienceAdapter.js";
import {
  generateEventConfigurations,
  scoreOpenRite,
} from "../src/planner/candidateGenerator.js";
import type { StrategySnapshot } from "../src/game/strategyTypes.js";
import { beamSearchDayPlans } from "../src/planner/beamSearch.js";
import {
  adviseExecutionTiming,
  planBreaksSudanCard,
  scoreExecutionTiming,
  shouldDeferSudanBreakExecute,
  compositionIncludesSudanCard,
  SUDAN_BREAK_DEFERRED_ERROR,
} from "../src/planner/executionTiming.js";
import { isHostSideActionError } from "../src/memory/hostActionErrors.js";
import { scorePlanVector, compareScoreVectors } from "../src/planner/scorer.js";
import { runStrategyEngine } from "../src/planner/strategyEngine.js";
import { evaluateHypothesisRetest } from "../src/memory/evaluator.js";
import { HypothesisStore } from "@vibesultan/agent-learning-core";
import type { EventConfiguration } from "../src/game/strategyTypes.js";
import {
  createSultanEntityStores,
  interactionKnowledgeKey,
  riteEventKey,
} from "../src/memory/entityMemory.js";
import {
  ActionFailureLedger,
  exchangeContextKeyFromGameState,
} from "../src/agent/failureLedger.js";
import { RiteExploreStore } from "../src/memory/riteExploreStore.js";
import {
  annotateExploreConfigurations,
  filterBlockedExploreConfigurations,
} from "../src/planner/riteExplorePolicy.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-strategy-"));
}

function sampleState(): GameState {
  return {
    schemaVersion: 1,
    game: "sultan",
    terminal: false,
    screen: { id: "play", phase: "rite" },
    values: {
      day: 2,
      turn: 2,
      fingerprint: "cfg-a",
      handCount: 3,
      riteCount: 1,
      sudan: { initLife: 7 },
      counters: { gold: 5 },
      cards: [
        { uid: 10, id: 2001, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
        { uid: 11, id: 2002, type: "item", rare: 3, name: "RareItem", inHand: true, bag: 0 },
      ],
      rites: [{ uid: 1, id: 5001, name: "Court", life: 1, start: false, slotsFilled: 0 }],
      currentRite: {
        uid: 1,
        id: 5001,
        name: "Court",
        started: false,
        canConfirm: false,
        slots: [
          {
            index: 0,
            text: "需要角色",
            conditionType: "char",
            occupied: false,
            acceptsOp: "place_card_on_rite",
          },
        ],
      },
    },
    actions: [
      { id: "place_card_on_rite", enabled: true },
      { id: "execute", enabled: false },
      { id: "continue", enabled: true },
      { id: "cancel", enabled: true },
      { id: "reset", enabled: true },
    ],
  };
}

function sampleScene(): SceneSnapshot {
  return {
    snapshotVersion: 3,
    scene: { id: "play", phase: "rite", blocking: false },
    affordances: [
      {
        action: "place",
        targetId: "semantic:place_0_10",
        enabled: true,
        mapsToOp: "place_card_on_rite",
        parameters: { uid: 10, slotIndex: 0, cardType: "char", cardName: "Hero" },
      },
      {
        action: "place",
        targetId: "semantic:place_0_11",
        enabled: true,
        mapsToOp: "place_card_on_rite",
        parameters: { uid: 11, slotIndex: 0, cardType: "item", cardName: "RareItem" },
      },
    ],
  };
}

function testSnapshotAndConfigs(): void {
  const state = sampleState();
  const scene = sampleScene();
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "game-a" });
  assert.equal(snapshot.version.configFingerprint, "cfg-a");
  assert.equal(snapshot.version.gameFingerprint, "game-a");
  assert.equal(snapshot.executionDaysLeft, 6);
  assert.ok(snapshot.enabledOps.includes("place_card_on_rite"));

  const configs = generateEventConfigurations({ snapshot, state, scene });
  assert.ok(configs.some((c) => c.id.includes("cfg_place_")));
  assert.ok(configs.some((c) => c.id === "cfg_op_continue"));
}

function testVersionIsolationAndLearning(): void {
  const dir = tempDir();
  const store = new ExperienceStore(dir);
  const v1 = { gameFingerprint: "g1", configFingerprint: "cfg-a" };
  const v2 = { gameFingerprint: "g1", configFingerprint: "cfg-b" };

  store.createOrAccumulate({
    version: v1,
    actionSignature: "place_card_on_rite|uid=10|slotIndex=0",
    contextSignature: "day=2|phase=rite|currentRite=1|hand=3|rites=1",
    positive: true,
    eventFeatures: [{ riteId: 5001 }],
    cardFeatures: [{ cardId: 2001 }],
  });
  store.createOrAccumulate({
    version: v2,
    actionSignature: "place_card_on_rite|uid=10|slotIndex=0",
    contextSignature: "day=2|phase=rite|currentRite=1|hand=3|rites=1",
    positive: false,
    eventFeatures: [{ riteId: 5001 }],
    cardFeatures: [{ cardId: 2001 }],
  });

  const compatible = store.listCompatible(v1);
  assert.equal(compatible.length, 1);
  assert.notEqual(compatible[0]?.status, "contradicted");

  const retrieved = store.retrieveRelevant({
    version: v1,
    actionSignatures: ["place_card_on_rite"],
    eventIds: [5001],
    limit: 5,
  });
  assert.equal(retrieved.length, 1);
}

function testBeamSearchExcludesNextRoundWithWork(): void {
  const state = sampleState();
  const scene = sampleScene();
  const store = new ExperienceStore(tempDir());
  const engine = runStrategyEngine({ state, scene, store, gameFingerprint: "g1" });
  assert.ok(engine.candidates.length > 0);
  for (const plan of engine.candidates) {
    const ops = plan.steps.map((s) => s.op);
    if (ops.includes("continue") || ops.includes("next_round")) {
      assert.equal(ops.length, 1, "continue/next_round must not mix with productive work");
    }
  }
  assert.ok(engine.firstAction);
}

function testEntityKnowledgeBoostAndVersionIsolation(): void {
  const dir = tempDir();
  const store = new ExperienceStore(dir);
  const entityStores = createSultanEntityStores(dir);
  const version = { gameFingerprint: "g1", configFingerprint: "cfg-a" };
  const eventKey = riteEventKey("cfg-a", 5001);
  const interactionKey = interactionKnowledgeKey({
    configFingerprint: "cfg-a",
    cardId: 2001,
    eventKey,
    slotIndex: 0,
  });
  entityStores.interactions.touch({
    key: interactionKey,
    kind: "interaction",
    version,
    facts: {
      interactionKey,
      cardId: 2001,
      eventKey,
      slotIndex: 0,
    },
  });
  for (let i = 0; i < 3; i++) {
    entityStores.interactions.addEvidence(interactionKey, version, {
      outcome: "positive",
      summary: `success-${i}`,
    });
  }

  const engine = runStrategyEngine({
    state: sampleState(),
    scene: sampleScene(),
    store,
    entityStores,
    gameFingerprint: "g1",
  });
  const boosted = engine.candidates
    .flatMap((plan) => plan.configurations)
    .find(
      (configuration) =>
        configuration.assignments[0]?.card.cardId === 2001 &&
        configuration.assignments[0]?.slotIndex === 0,
    );
  assert.ok((boosted?.entityKnowledgeScore ?? 0) > 0);
  assert.ok((engine.builtFrom.entityKnowledgeCount ?? 0) > 0);

  const incompatibleState = sampleState();
  incompatibleState.values!.fingerprint = "cfg-b";
  const incompatible = runStrategyEngine({
    state: incompatibleState,
    scene: sampleScene(),
    store,
    entityStores,
    gameFingerprint: "g1",
  });
  assert.equal(incompatible.builtFrom.entityKnowledgeCount, 0);
}

function testMultiSlotSameRiteAndUtilization(): void {
  const state = sampleState();
  (state.values as Record<string, unknown>).currentRite = {
    uid: 1,
    id: 5001,
    name: "治理家业",
    started: false,
    canConfirm: false,
    slots: [
      { index: 0, text: "角色", conditionType: "char", occupied: false },
      { index: 1, text: "角色", conditionType: "char", occupied: false },
    ],
  };
  (state.values as Record<string, unknown>).rites = [
    { uid: 1, id: 5001, name: "治理家业", life: 99, start: false, slotsFilled: 0 },
  ];
  (state.values as Record<string, unknown>).cards = [
    { uid: 10, id: 2001, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
    { uid: 13, id: 2003, type: "char", rare: 1, name: "Aide", inHand: true, bag: 0 },
    { uid: 11, id: 2002, type: "item", rare: 3, name: "RareItem", inHand: true, bag: 0 },
  ];
  const scene: SceneSnapshot = {
    snapshotVersion: 9,
    scene: { id: "play", phase: "rite", blocking: false },
    affordances: [
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 10, slotIndex: 0, cardType: "char", cardName: "Hero" },
      },
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 13, slotIndex: 1, cardType: "char", cardName: "Aide" },
      },
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 11, slotIndex: 0, cardType: "item", cardName: "RareItem" },
      },
    ],
  };
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  const configs = generateEventConfigurations({ snapshot, state, scene });
  assert.ok(configs.some((c) => c.id.startsWith("cfg_place_multi_")));

  const store = new ExperienceStore(tempDir());
  const engine = runStrategyEngine({ state, scene, store, gameFingerprint: "g1" });
  const best = engine.candidates[0];
  assert.ok(best);
  // Same rite may receive multiple cards on different slots.
  const slotKeys = new Set(
    best!.configurations
      .filter((c) => c.id.startsWith("cfg_place_"))
      .map((c) => `${c.event.riteUid}:${c.assignments[0]?.slotIndex}`),
  );
  assert.ok(slotKeys.size >= 1, "expected at least one place configuration in best plan");
  // First action only — multi-card plans still execute one step.
  assert.ok(engine.firstAction);
  assert.ok(
    ["place_card_on_rite", "open_rite", "execute"].includes(String(engine.firstAction?.op)),
    `expected productive first action, got ${engine.firstAction?.op}`,
  );

  // Continuous estate event should outrank bare continue when productive placements exist.
  assert.notEqual(best!.id, "plan_continue_only");
}

function testEvaluator(): void {
  const dir = tempDir();
  const hs = new HypothesisStore(dir);
  const h = hs.create({
    claim: "test",
    rationale: "r",
    constraints: "c",
    topicKey: "t",
    sourceInstanceId: "run1",
    sessionIndex: 1,
    primaryMetric: { name: "score", direction: "increase" },
  });
  const baseline = sampleState();
  const retest = sampleState();
  (retest.values as Record<string, unknown>).counters = { gold: 50 };
  (retest.values as Record<string, unknown>).day = 3;
  const result = evaluateHypothesisRetest({
    hypothesis: h,
    baselineState: baseline,
    retestState: retest,
  });
  assert.ok(["accepted", "rejected", "inconclusive"].includes(result.decision));
}

function testVersionKey(): void {
  const key = versionKeyFromState(sampleState(), "game-fp");
  assert.equal(key.gameFingerprint, "game-fp");
  assert.equal(key.configFingerprint, "cfg-a");
}

function sudanBreakConfig(): EventConfiguration {
  return {
    id: "cfg_place_1_0_99",
    event: {
      riteUid: 1,
      riteId: 5001,
      name: "销卡仪式",
      slots: [{ index: 0, text: "苏丹卡", conditionType: "sudan", occupied: false }],
    },
    assignments: [
      {
        slotIndex: 0,
        uid: 99,
        card: { cardId: 9001, type: "sudan", name: "石杀戮", inHand: true, rare: 1 },
      },
    ],
    unknowns: [],
    experienceIds: [],
    baseScore: 12,
  };
}

function wealthConfig(): EventConfiguration {
  return {
    id: "cfg_place_2_0_10",
    event: { riteUid: 2, riteId: 5002, name: "治理家业" },
    assignments: [
      {
        slotIndex: 0,
        uid: 10,
        card: { cardId: 2001, type: "char", name: "Hero", inHand: true, rare: 1 },
      },
    ],
    unknowns: [],
    experienceIds: [],
    baseScore: 14,
  };
}

function testExecutionTimingRollingLifecycle(): void {
  const early = buildStrategySnapshot({
    state: {
      ...sampleState(),
      values: { ...sampleState().values, day: 2, sudan: { initLife: 7 } },
    },
    scene: sampleScene(),
    gameFingerprint: "g1",
  });
  assert.equal(early.executionDaysLeft, 6);
  assert.ok(
    adviseExecutionTiming(early).policy === "discover_routes" ||
      adviseExecutionTiming(early).policy === "accumulate_prepare",
  );
  assert.ok(planBreaksSudanCard([sudanBreakConfig()]));

  // Verified break + pending probes must NOT stay in discover_routes.
  const verifiedWithProbes = {
    ...early,
    sudanRoutes: {
      coverage: 0.8,
      readyCount: 0,
      needsSupportCount: 1,
      pendingProbes: 12,
      verifiedBreakCount: 1,
      expiringOpportunity: false,
    },
  };
  assert.equal(adviseExecutionTiming(verifiedWithProbes).policy, "accumulate_prepare");

  // preferDelayBreak window: Sudan-breaking execute plans are penalized (bounded, not fixed -18).
  const earlyBreakScore = scoreExecutionTiming({
    snapshot: early,
    configurations: [sudanBreakConfig()],
  });
  const earlyAdvice = adviseExecutionTiming(early);
  if (earlyAdvice.preferDelayBreak) {
    assert.ok(
      earlyBreakScore <= -8,
      `preferDelayBreak should penalize early sudan execute, got ${earlyBreakScore}`,
    );
  } else {
    assert.ok(
      earlyBreakScore > -8,
      `without preferDelayBreak must not use fixed early-break tax, got ${earlyBreakScore}`,
    );
  }
  assert.equal(
    shouldDeferSudanBreakExecute({
      snapshot: early,
      compositionIncludesSudan: true,
    }),
    earlyAdvice.preferDelayBreak,
  );
  assert.equal(
    shouldDeferSudanBreakExecute({
      snapshot: early,
      compositionIncludesSudan: false,
    }),
    false,
  );

  const expiringEarly = {
    ...early,
    sudanRoutes: {
      coverage: 0.8,
      readyCount: 1,
      needsSupportCount: 0,
      pendingProbes: 0,
      verifiedBreakCount: 1,
      expiringOpportunity: true,
    },
  };
  assert.equal(
    shouldDeferSudanBreakExecute({
      snapshot: expiringEarly,
      compositionIncludesSudan: true,
    }),
    false,
    "expiring opportunity must not defer",
  );
  const expiringBreakScore = scoreExecutionTiming({
    snapshot: expiringEarly,
    configurations: [sudanBreakConfig()],
  });
  assert.ok(
    expiringBreakScore > earlyBreakScore,
    "expiring high-quality route may break early",
  );

  const commitSnap = buildStrategySnapshot({
    state: {
      ...sampleState(),
      values: {
        ...sampleState().values,
        day: 6,
        sudan: {
          initLife: 7,
          remaining: 1,
          currentCard: { id: 2010001, uid: 1, name: "杀戮", type: "sudan" },
        },
      },
    },
    scene: sampleScene(),
    gameFingerprint: "g1",
  });
  assert.equal(adviseExecutionTiming(commitSnap).policy, "commit_best");
  assert.equal(
    shouldDeferSudanBreakExecute({
      snapshot: commitSnap,
      compositionIncludesSudan: true,
    }),
    false,
    "commit_best must not defer",
  );
  assert.ok(isHostSideActionError(SUDAN_BREAK_DEFERRED_ERROR));

  const sudanState: GameState = {
    ...sampleState(),
    values: {
      ...sampleState().values,
      sudan: {
        initLife: 7,
        remaining: 6,
        currentCard: { id: 2010001, uid: 99, name: "杀戮", type: "sudan", rare: 1 },
      },
      currentRite: {
        uid: 1,
        id: 5001,
        name: "权力的游戏",
        started: false,
        canConfirm: true,
        slots: [
          {
            index: 5,
            text: "sudan",
            conditionType: "sudan",
            occupied: true,
            cardUid: 99,
            cardSummary: {
              cardId: 2010001,
              id: 2010001,
              name: "杀戮",
              type: "sudan",
              rare: 1,
            },
            acceptsOp: "place_card_on_rite",
          },
        ],
      },
      cards: [
        { uid: 99, id: 2010001, type: "sudan", rare: 1, name: "杀戮", inHand: true, bag: 0 },
      ],
    },
  };
  assert.equal(compositionIncludesSudanCard(sudanState), true);
  assert.equal(compositionIncludesSudanCard(sampleState()), false);

  const branchDay = buildStrategySnapshot({
    state: {
      ...sampleState(),
      values: {
        ...sampleState().values,
        day: 6,
        sudan: { initLife: 7, redrawRemaining: 2, redrawTimes: 1, redrawPerRound: 3 },
      },
      actions: [
        ...(sampleState().actions ?? []),
        { id: "open_sudan_box", enabled: true },
        { id: "exchange_sudan_card", enabled: true },
      ],
    },
    scene: sampleScene(),
    gameFingerprint: "g1",
  });
  assert.equal(branchDay.executionDaysLeft, 2);
  assert.equal(adviseExecutionTiming(branchDay).policy, "branch_test");

  // Card-face life beats global day: day=6 but life=2 => remaining 5 (not 2).
  const cardFace = buildStrategySnapshot({
    state: {
      ...sampleState(),
      values: {
        ...sampleState().values,
        day: 6,
        sudan: {
          initLife: 7,
          currentCard: { uid: 10, id: 2010006, name: "纵欲", rare: 2, life: 2 },
          // Stale host projection must be ignored when card.life is present.
          remaining: 2,
          executionDaysLeft: 2,
        },
      },
    },
    scene: sampleScene(),
    gameFingerprint: "g1",
  });
  assert.equal(cardFace.executionDaysLeft, 5);
  assert.equal(cardFace.sudanCard?.life, 2);
  assert.notEqual(adviseExecutionTiming(cardFace).policy, "branch_test");
  assert.ok(
    ["discover_routes", "accumulate_prepare"].includes(
      adviseExecutionTiming(cardFace).policy,
    ),
    "5 days left must not enter branch_test/commit",
  );

  // Multi-card: 纵欲 6 days + 金杀戮 7 days => urgency = min = 6.
  const multi = buildStrategySnapshot({
    state: {
      ...sampleState(),
      values: {
        ...sampleState().values,
        day: 5,
        sudan: {
          initLife: 7,
          currentCard: { uid: 10, id: 2010006, name: "纵欲", rare: 2, life: 1, type: "sudan" },
          remaining: 3,
          executionDaysLeft: 3,
        },
        cards: [
          { uid: 10, id: 2010006, type: "sudan", rare: 2, name: "纵欲", life: 1, inHand: true, bag: 0 },
          { uid: 7, id: 2010004, type: "sudan", rare: 4, name: "杀戮", life: 0, inHand: true, bag: 0 },
          { uid: 29, id: 2000001, type: "char", rare: 3, name: "阿尔图", inHand: true, bag: 0 },
        ],
      },
    },
    scene: sampleScene(),
    gameFingerprint: "g1",
  });
  assert.equal(multi.executionDaysLeft, 6);
  assert.equal(multi.sudanCards?.length, 2);
  assert.deepEqual(
    multi.sudanCards?.map((c) => `${c.name}:${c.remaining}`).sort(),
    ["纵欲:6", "杀戮:7"].sort(),
  );
  assert.equal(multi.sudanCard?.name, "纵欲");
  assert.equal(multi.sudanCard?.remaining, 6);

  const exchangeScore = scoreExecutionTiming({
    snapshot: branchDay,
    configurations: [
      {
        id: "cfg_op_exchange_sudan_card",
        event: { name: "exchange" },
        assignments: [],
        unknowns: [],
        experienceIds: [],
        baseScore: 15,
      },
    ],
  });
  assert.ok(exchangeScore >= 8, "day-2 exchange branch should score well");

  const lastDay = buildStrategySnapshot({
    state: {
      ...sampleState(),
      values: { ...sampleState().values, day: 7, sudan: { initLife: 7 } },
    },
    scene: sampleScene(),
    gameFingerprint: "g1",
  });
  assert.equal(lastDay.executionDaysLeft, 1);
  assert.equal(adviseExecutionTiming(lastDay).policy, "commit_best");
  const breakPlan: EventConfiguration[] = [
    sudanBreakConfig(),
    {
      id: "cfg_op_execute",
      event: sudanBreakConfig().event,
      assignments: sudanBreakConfig().assignments,
      unknowns: [],
      experienceIds: [],
      baseScore: 18,
    },
  ];
  const continuePlan: EventConfiguration[] = [
    {
      id: "cfg_op_continue",
      event: { name: "continue" },
      assignments: [],
      unknowns: ["day_opportunity_check"],
      experienceIds: [],
      baseScore: 1,
    },
  ];
  const breakScore = scorePlanVector({
    snapshot: lastDay,
    configurations: breakPlan,
    experiences: [],
  });
  const continueScore = scorePlanVector({
    snapshot: lastDay,
    configurations: continuePlan,
    experiences: [],
  });
  assert.ok(
    compareScoreVectors(breakScore, continueScore) < 0,
    "last day must prefer sudan break over continue",
  );
}

function testExchangeCircuitStopsPlannerRecommendations(): void {
  const state = sampleState();
  (state.values as Record<string, unknown>).day = 6;
  (state.values as Record<string, unknown>).sudan = {
    initLife: 7,
    redrawRemaining: 3,
    currentCard: { uid: 19, id: 2010011, name: "奢靡" },
  };
  state.actions = [
    ...(state.actions ?? []),
    { id: "open_sudan_box", enabled: true },
    { id: "exchange_sudan_card", enabled: true },
  ];
  const contextKey = exchangeContextKeyFromGameState(state);
  const ledger = new ActionFailureLedger();
  for (let step = 1; step <= 3; step++) {
    ledger.noteFailures(
      step,
      `state-${step}`,
      [{ op: "exchange_sudan_card", ok: false, error: "exchange_not_applied" }],
      [{ op: "exchange_sudan_card" }],
      contextKey,
    );
  }
  assert.equal(ledger.isExchangeCircuitOpen(contextKey), true);

  const snapshot = buildStrategySnapshot({
    state,
    scene: sampleScene(),
    gameFingerprint: "g1",
    exchangeCircuitOpen: ledger.isExchangeCircuitOpen(contextKey),
  });
  const configs = generateEventConfigurations({ snapshot, state, scene: sampleScene() });
  assert.equal(configs.some((config) => config.id === "cfg_op_exchange_sudan_card"), false);
  assert.equal(configs.some((config) => config.id === "cfg_op_open_sudan_box"), false);
  assert.ok(
    scoreExecutionTiming({
      snapshot,
      configurations: [
        {
          id: "cfg_op_exchange_sudan_card",
          event: { name: "exchange" },
          assignments: [],
          unknowns: [],
          experienceIds: [],
          baseScore: 15,
        },
      ],
    }) < 8,
  );
}

function testEngineExposesConfigurationsAndNoNextDayWithWork(): void {
  const store = new ExperienceStore(tempDir());
  const engine = runStrategyEngine({
    state: sampleState(),
    scene: sampleScene(),
    store,
    gameFingerprint: "g1",
  });
  assert.ok((engine.configurations?.length ?? 0) > 0, "engine should expose configurations");
  assert.ok(Array.isArray(engine.experiences));
  for (const plan of engine.candidates) {
    const ops = plan.steps.map((s) => s.op);
    const hasNext = ops.includes("next_day") || ops.includes("next_round");
    if (hasNext) {
      assert.equal(ops.length, 1, "next_day must not mix with productive work");
    }
    const placeSlots = new Set<string>();
    const placeCards = new Set<number>();
    for (const cfg of plan.configurations) {
      if (!cfg.id.startsWith("cfg_place_")) continue;
      for (const a of cfg.assignments) {
        const sk = `r:${cfg.event.riteUid}|s:${a.slotIndex}`;
        assert.equal(placeSlots.has(sk), false, `duplicate slot ${sk}`);
        placeSlots.add(sk);
        if (a.uid != null) {
          assert.equal(placeCards.has(a.uid), false, `duplicate card ${a.uid}`);
          placeCards.add(a.uid);
        }
      }
    }
  }
}

function testExploreBlockedConfigsFiltered(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const explore = new RiteExploreStore(dir);
  explore.beginRun("run-x");
  const configs: EventConfiguration[] = [
    {
      id: "cfg_place_1",
      event: { riteId: 1, name: "t", life: 3 },
      assignments: [{ slotIndex: 0, card: { cardId: 1 }, uid: 1 }],
      unknowns: [],
      experienceIds: [],
      baseScore: 1,
    },
  ];
  const annotated = annotateExploreConfigurations({
    configurations: configs,
    stores,
    exploreStore: explore,
    runId: "run-x",
    state: sampleState(),
    gameFingerprint: "cfg-a",
  });
  assert.ok(
    annotated[0]?.exploreKind === "baseline" ||
      annotated[0]?.exploreKind === "novel" ||
      annotated[0]?.exploreKind === "blocked",
  );
  if (annotated[0]?.pathSignature) {
    explore.recordSubmittedTrial({
      runId: "run-x",
      eventKey: riteEventKey("cfg-a", 1),
      riteId: 1,
      signature: annotated[0].pathSignature.includes("comp:")
        ? `cfg-a:rite:1:${annotated[0].pathSignature.split("comp:")[1]}`
        : annotated[0].pathSignature,
      isNovel: true,
    });
  }
  // Force duplicate on the exact composition signature body used by gate.
  const sigBody = annotated[0]
    ? `cfg-a:rite:1:s0:P:1`
    : "cfg-a:rite:1:s0:P:1";
  explore.recordSubmittedTrial({
    runId: "run-x",
    eventKey: riteEventKey("cfg-a", 1),
    riteId: 1,
    signature: sigBody,
    isNovel: true,
  });
  const again = annotateExploreConfigurations({
    configurations: configs,
    stores,
    exploreStore: explore,
    runId: "run-x",
    state: sampleState(),
    gameFingerprint: "cfg-a",
  });
  assert.equal(again[0]?.exploreKind, "blocked");
  const filtered = filterBlockedExploreConfigurations(again);
  assert.equal(filtered.length, 0);
}

function testScoreOpenRiteHandMatch(): void {
  const baseSnap = {
    day: 1,
    executionDaysLeft: 7,
    events: [],
    cards: [],
    sudanCard: { name: "杀戮", rare: 1, identity: "2010001|1|杀戮" },
  } as StrategySnapshot;

  const matched = scoreOpenRite(baseSnap, {
    riteUid: 1,
    name: "权力的游戏",
    handMatchCount: 2,
    slotPreview: [
      { index: 5, conditionType: "sudan", requiredRare: 1, text: "苏丹卡" },
    ],
  });
  const unmatched = scoreOpenRite(baseSnap, {
    riteUid: 2,
    name: "神秘仪式",
    handMatchCount: 0,
    slotPreview: [{ index: 0, conditionType: "char", text: "人物" }],
  });
  const noPreview = scoreOpenRite(baseSnap, {
    riteUid: 3,
    name: "未知点",
    handMatchCount: 0,
    slotPreview: [],
  });
  assert.ok(matched > unmatched, `matched ${matched} should beat unmatched ${unmatched}`);
  assert.ok(matched > noPreview, `matched ${matched} should beat noPreview ${noPreview}`);
}

function main(): void {
  testSnapshotAndConfigs();
  testVersionIsolationAndLearning();
  testEntityKnowledgeBoostAndVersionIsolation();
  testBeamSearchExcludesNextRoundWithWork();
  testMultiSlotSameRiteAndUtilization();
  testExecutionTimingRollingLifecycle();
  testExchangeCircuitStopsPlannerRecommendations();
  testEngineExposesConfigurationsAndNoNextDayWithWork();
  testEvaluator();
  testVersionKey();
  testExploreBlockedConfigsFiltered();
  testScoreOpenRiteHandMatch();
  console.log("verify-strategy-engine: ok");
}

main();
