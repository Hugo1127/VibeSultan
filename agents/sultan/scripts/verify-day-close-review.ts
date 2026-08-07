/**
 * Offline day-close allocation review tests (no LLM / no live game).
 */
import assert from "node:assert/strict";
import { ActionChainController } from "../src/agent/actionChain.js";
import { runTool } from "../src/agent/tools.js";
import type { GameAction, GameState, SceneSnapshot } from "../src/game/types.js";
import { buildStrategySnapshot } from "../src/memory/experienceAdapter.js";
import { generateEventConfigurations } from "../src/planner/candidateGenerator.js";
import {
  allocationsToConfigurations,
  emptyDayCandidateLedger,
  ingestConfigurationsIntoLedger,
  reviewDayCloseAllocations,
  validateAssignmentAgainstScene,
} from "../src/planner/dayCloseReview.js";
import { improvePlanLocally } from "../src/planner/localSearch.js";
import { compareScoreVectors, scorePlanVector } from "../src/planner/scorer.js";

function riteState(): GameState {
  return {
    schemaVersion: 1,
    game: "sultan",
    terminal: false,
    screen: { id: "play", phase: "rite" },
    values: {
      day: 2,
      turn: 2,
      fingerprint: "cfg-a",
      sudan: { initLife: 7 },
      cards: [
        { uid: 10, id: 2001, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
        { uid: 11, id: 2002, type: "char", rare: 3, name: "Noble", inHand: true, bag: 0 },
        { uid: 12, id: 2003, type: "char", rare: 1, name: "Aide", inHand: true, bag: 0 },
      ],
      rites: [
        { uid: 1, id: 5001, name: "治理家业", life: 99, start: false, slotsFilled: 0 },
        { uid: 2, id: 5002, name: "权力的游戏", life: 99, start: false, slotsFilled: 0 },
      ],
      currentRite: {
        uid: 1,
        id: 5001,
        name: "治理家业",
        started: false,
        canConfirm: false,
        slots: [
          {
            index: 0,
            text: "角色",
            conditionType: "char",
            occupied: false,
            acceptsOp: "place_card_on_rite",
          },
          {
            index: 1,
            text: "角色",
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
      { id: "next_day", enabled: true },
      { id: "open_rite", enabled: true },
      { id: "reset", enabled: true },
    ],
  };
}

function riteScene(): SceneSnapshot {
  return {
    snapshotVersion: 3,
    scene: { id: "play", phase: "rite", blocking: false },
    affordances: [
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 10, slotIndex: 0, cardType: "char", cardName: "Hero", cardRare: 1 },
      },
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 11, slotIndex: 0, cardType: "char", cardName: "Noble", cardRare: 3 },
      },
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 12, slotIndex: 1, cardType: "char", cardName: "Aide", cardRare: 1 },
      },
      {
        action: "open",
        mapsToOp: "open_rite",
        enabled: true,
        parameters: { uid: 2, name: "权力的游戏" },
      },
      { action: "click", mapsToOp: "next_day", enabled: true },
    ],
  };
}

function testAllocationsToConfigurationsMatchesPool(): void {
  const state = riteState();
  const scene = riteScene();
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  const pool = generateEventConfigurations({ snapshot, state, scene });
  const mapped = allocationsToConfigurations({
    allocations: [{ cardUid: 10, riteUid: 1, slotIndex: 0 }],
    snapshot,
    state,
    scene,
    pool,
  });
  assert.equal(mapped.feasible, true);
  assert.equal(mapped.configurations.length, 1);
  assert.ok(mapped.configurations[0]!.id.includes("cfg_place_"));
  assert.equal(mapped.configurations[0]!.assignments[0]?.uid, 10);
}

function testIdleReusableHardIssue(): void {
  const state = riteState();
  const scene = riteScene();
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  const ledger = ingestConfigurationsIntoLedger(
    emptyDayCandidateLedger(2),
    generateEventConfigurations({ snapshot, state, scene }),
    { day: 2 },
  );
  const review = reviewDayCloseAllocations({
    snapshot,
    state,
    scene,
    allocations: [],
    ledger,
  });
  assert.equal(review.canAdvanceDay, false);
  assert.ok(
    review.hardIssues.some((i) => i.code === "idle_reusable_positive_slot"),
    `expected idle hard issue, got ${JSON.stringify(review.hardIssues)}`,
  );
  assert.ok(review.suggestedFirstAction);
}

function testOccupiedSlotInfeasible(): void {
  const state = riteState();
  (state.values as Record<string, unknown>).currentRite = {
    uid: 1,
    id: 5001,
    name: "治理家业",
    started: false,
    slots: [
      {
        index: 0,
        occupied: true,
        occupant: { cardUid: 99, cardId: 9, name: "Other", kind: "player" },
      },
    ],
  };
  const scene = riteScene();
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  const reason = validateAssignmentAgainstScene(
    { cardUid: 10, riteUid: 1, slotIndex: 0 },
    scene,
    snapshot,
  );
  assert.equal(reason, "slot_occupied_by_other");
}

function testEvidenceIncompleteDowngrade(): void {
  const state = riteState();
  // Play phase, no open rite place affordances → empty place pool.
  state.screen = { id: "play", phase: "play" };
  delete (state.values as Record<string, unknown>).currentRite;
  const scene: SceneSnapshot = {
    snapshotVersion: 1,
    scene: { id: "play", phase: "play", blocking: false },
    affordances: [
      { action: "open", mapsToOp: "open_rite", enabled: true, parameters: { uid: 1 } },
      { action: "click", mapsToOp: "next_day", enabled: true },
    ],
  };
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  const review = reviewDayCloseAllocations({
    snapshot,
    state,
    scene,
    allocations: [],
    ledger: emptyDayCandidateLedger(2),
  });
  assert.equal(review.evidenceCompleteness === "none" || review.evidenceCompleteness === "partial", true);
  // Without verified place affordances, idle should not hard-block.
  assert.equal(
    review.hardIssues.filter((i) => i.code === "idle_reusable_positive_slot").length,
    0,
  );
}

function testLocalSearchImprovesSeed(): void {
  const state = riteState();
  const scene = riteScene();
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  const pool = generateEventConfigurations({ snapshot, state, scene }).filter((c) =>
    c.id.startsWith("cfg_place_"),
  );
  // Seed with high-tier Noble on errand slot 0 only.
  const seed = pool.filter(
    (c) => c.assignments[0]?.uid === 11 && c.assignments[0]?.slotIndex === 0,
  );
  assert.ok(seed.length > 0);
  const seedScore = scorePlanVector({ snapshot, configurations: seed, experiences: [] });
  const improved = improvePlanLocally({
    snapshot,
    seed,
    neighborhood: pool,
    experiences: [],
  });
  assert.ok(
    compareScoreVectors(improved.scoreVector, seedScore) <= 0,
    "local search must not worsen lex score",
  );
}

function testCrossRiteLedgerCapture(): void {
  const state = riteState();
  const scene = riteScene();
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  let ledger = emptyDayCandidateLedger(2);
  ledger = ingestConfigurationsIntoLedger(
    ledger,
    generateEventConfigurations({ snapshot, state, scene }),
    { day: 2 },
  );
  assert.ok(ledger.capturedRiteUids.includes(1));
  // Simulate second rite open with its own place affordances.
  const state2 = riteState();
  (state2.values as Record<string, unknown>).currentRite = {
    uid: 2,
    id: 5002,
    name: "权力的游戏",
    started: false,
    slots: [{ index: 0, text: "角色", conditionType: "char", occupied: false }],
  };
  const scene2: SceneSnapshot = {
    snapshotVersion: 4,
    scene: { id: "play", phase: "rite", blocking: false },
    affordances: [
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 10, slotIndex: 0, cardType: "char", cardName: "Hero" },
      },
    ],
  };
  const snap2 = buildStrategySnapshot({ state: state2, scene: scene2, gameFingerprint: "g1" });
  ledger = ingestConfigurationsIntoLedger(
    ledger,
    generateEventConfigurations({ snapshot: snap2, state: state2, scene: scene2 }),
    { day: 2 },
  );
  assert.ok(ledger.capturedRiteUids.includes(1));
  assert.ok(ledger.capturedRiteUids.includes(2));
  assert.ok(
    Object.keys(ledger.configurationsById).some((id) => id.includes("_2_") || id.includes("cfg_place_2")),
  );
}

async function testNextDayHardBlockedAndOverride(): Promise<void> {
  const state = riteState();
  state.screen = { id: "play", phase: "play" };
  // Keep currentRite so place affordances remain meaningful for review snapshot.
  const scene = riteScene();
  scene.scene = { id: "play", phase: "rite", blocking: false };
  const chain = new ActionChainController();
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  const ledger = ingestConfigurationsIntoLedger(
    emptyDayCandidateLedger(2),
    generateEventConfigurations({ snapshot, state, scene }),
    { day: 2 },
  );

  const submitted: GameAction[] = [];
  const ops = {
    async submitActions(actions: GameAction[]) {
      submitted.push(...actions);
      return actions.map((a) => ({ op: a.op, ok: true }));
    },
    async getState() {
      return state;
    },
    async observeScene() {
      return scene;
    },
    async publishDecision() {
      return { ok: true };
    },
  };

  const blocked = await runTool(
    ops as never,
    "submit_actions",
    JSON.stringify({
      actions: [{ op: "next_day" }],
      decision: { title: "try next day" },
    }),
    {
      latestState: state,
      latestScene: scene,
      actionChain: chain,
      dayCloseLedger: ledger,
    },
  );
  const br = blocked as {
    results: Array<{ error?: string; ok?: boolean }>;
  };
  assert.equal(br.results[0]?.ok, false);
  assert.equal(br.results[0]?.error, "day_close_hard_issue");
  assert.equal(submitted.length, 0);

  // Assign all reusable chars so hard idle clears; soft may still ask for override.
  chain.applyReport(
    {
      allocations: [
        { cardUid: 10, riteUid: 1, slotIndex: 0 },
        { cardUid: 12, riteUid: 1, slotIndex: 1 },
      ],
      idleCards: [{ cardUid: 11, reason: "reserved", detail: "preserve high tier" }],
      localImproveDone: true,
      newsChecked: true,
      reviewedCardUids: [10, 11, 12],
      reviewedRiteUids: [1, 2],
      top3: [{ title: "estate", why: "gold" }],
    },
    state,
    scene,
  );

  const softOrOk = await runTool(
    ops as never,
    "submit_actions",
    JSON.stringify({
      actions: [{ op: "next_day" }],
      dayCloseReviewOverride: "资源不足，保留高阶卡",
      decision: { title: "override soft" },
    }),
    {
      latestState: state,
      latestScene: scene,
      actionChain: chain,
      dayCloseLedger: ledger,
    },
  );
  const sr = softOrOk as { results: Array<{ error?: string; ok?: boolean }> };
  assert.equal(sr.results[0]?.error, undefined);
  assert.equal(sr.results[0]?.ok, true);
  assert.equal(submitted[0]?.op, "next_day");
}

async function testClickElementCannotBypass(): Promise<void> {
  const state = riteState();
  const scene = riteScene();
  const submitted: GameAction[] = [];
  const result = await runTool(
    {
      async submitActions(actions: GameAction[]) {
        submitted.push(...actions);
        return actions.map((a) => ({ op: a.op, ok: true }));
      },
      async getState() {
        return state;
      },
      async observeScene() {
        return scene;
      },
      async publishDecision() {
        return { ok: true };
      },
    } as never,
    "click_element",
    JSON.stringify({
      elementId: "main_next_day",
      snapshotVersion: 3,
      decision: { title: "click next" },
    }),
    {
      latestState: state,
      latestScene: {
        ...scene,
        affordances: [
          {
            action: "click",
            targetId: "main_next_day",
            mapsToOp: "next_day",
            enabled: true,
          },
        ],
      },
    },
  );
  const r = result as { results: Array<{ error?: string; ok?: boolean }> };
  assert.equal(r.results[0]?.ok, false);
  assert.equal(r.results[0]?.error, "use_explicit_next_day");
  assert.equal(submitted.length, 0);
}

function testMustBreakSudanAdvisoryOnly(): void {
  const state = riteState();
  (state.values as Record<string, unknown>).day = 7;
  (state.values as Record<string, unknown>).sudan = { initLife: 7 };
  (state.values as Record<string, unknown>).cards = [
    { uid: 10, id: 2001, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
    { uid: 99, id: 9001, type: "sudan", rare: 1, name: "石杀戮", inHand: true, bag: 0 },
  ];
  (state.values as Record<string, unknown>).currentRite = {
    uid: 1,
    id: 5001,
    name: "销卡仪式",
    started: false,
    slots: [
      {
        index: 0,
        text: "置入苏丹卡",
        conditionType: "sudan",
        occupied: false,
      },
    ],
  };
  const scene: SceneSnapshot = {
    snapshotVersion: 5,
    scene: { id: "play", phase: "rite", blocking: false },
    affordances: [
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 99, slotIndex: 0, cardType: "sudan", cardName: "石杀戮" },
      },
    ],
  };
  const snapshot = buildStrategySnapshot({ state, scene, gameFingerprint: "g1" });
  const review = reviewDayCloseAllocations({
    snapshot,
    state,
    scene,
    allocations: [],
    ledger: ingestConfigurationsIntoLedger(
      emptyDayCandidateLedger(7),
      generateEventConfigurations({ snapshot, state, scene }),
      { day: 7 },
    ),
    sudanBreakDone: false,
  });
  assert.equal(
    review.hardIssues.some((i) => i.code === "must_break_sudan_today"),
    false,
    "sudan last-day break must not hard-block next_day",
  );
  assert.ok(
    review.softIssues.some((i) => i.code === "must_break_sudan_today"),
    `expected sudan soft advisory, got ${JSON.stringify(review.softIssues)}`,
  );
  assert.equal(review.canAdvanceDay, true);

  const circuitSnapshot = buildStrategySnapshot({
    state,
    scene,
    gameFingerprint: "g1",
    exchangeCircuitOpen: true,
  });
  const circuitReview = reviewDayCloseAllocations({
    snapshot: circuitSnapshot,
    state,
    scene,
    allocations: [],
    sudanBreakDone: false,
  });
  assert.equal(
    circuitReview.softIssues.some((issue) => issue.code === "sudan_exchange_available"),
    false,
    "day-close review must not recommend exchange while its circuit is open",
  );
}

async function main(): Promise<void> {
  testAllocationsToConfigurationsMatchesPool();
  testIdleReusableHardIssue();
  testOccupiedSlotInfeasible();
  testEvidenceIncompleteDowngrade();
  testLocalSearchImprovesSeed();
  testCrossRiteLedgerCapture();
  await testNextDayHardBlockedAndOverride();
  await testClickElementCannotBypass();
  testMustBreakSudanAdvisoryOnly();
  console.log("verify-day-close-review: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
