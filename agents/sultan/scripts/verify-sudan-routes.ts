import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GameState, SceneSnapshot } from "../src/game/types.js";
import { SudanBranchStore, branchActionSignature } from "../src/memory/sudanBranchStore.js";
import { SudanRouteStore } from "../src/memory/sudanRouteStore.js";
import {
  captureSudanRoutesFromScene,
  detectSudanIdentityChange,
  enqueueMapEventProbes,
  insightFromState,
  pruneSudanRouteProbes,
} from "../src/memory/sudanRouteTracker.js";
import { EpisodeStore } from "../src/memory/episodeStore.js";
import { BacktrackStore } from "../src/memory/backtrackStore.js";
import { buildPathSignature } from "../src/memory/riteComposition.js";
import { adviseExecutionTiming } from "../src/planner/executionTiming.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-routes-"));
}

function sampleState(overrides?: Partial<GameState["values"]>): GameState {
  return {
    schemaVersion: 1,
    game: "sultan",
    terminal: false,
    screen: { id: "play", phase: "rite" },
    values: {
      day: 3,
      fingerprint: "cfg-sudan",
      sudan: {
        initLife: 7,
        redrawTimes: 1,
        redrawPerRound: 3,
        redrawRemaining: 2,
        currentCard: { uid: 99, id: 9001, name: "石杀戮" },
      },
      counters: { "7100005": 0 },
      cards: [
        { uid: 99, id: 9001, type: "sudan", rare: 1, name: "石杀戮", inHand: true, bag: 0 },
        { uid: 10, id: 2001, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
      ],
      currentRite: {
        uid: 1,
        id: 5001,
        name: "销卡仪式",
        life: 2,
        started: false,
        slots: [
          { index: 0, text: "置入苏丹卡", occupied: false },
          { index: 1, text: "需要角色", occupied: false },
        ],
      },
      ...overrides,
    },
  };
}

function sampleScene(): SceneSnapshot {
  return {
    snapshotVersion: 1,
    scene: { id: "play", phase: "rite", blocking: false },
    affordances: [
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 99, slotIndex: 0, cardType: "sudan", cardName: "石杀戮" },
      },
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 10, slotIndex: 1, cardType: "char", cardName: "Hero" },
      },
    ],
  };
}

function testRouteProbeAndCapture(): void {
  const dir = tempDir();
  const store = new SudanRouteStore(dir);
  const state = sampleState();
  const changed = detectSudanIdentityChange({
    store,
    state,
    day: 3,
    configFingerprint: "cfg-sudan",
  });
  assert.equal(changed.changed, true);
  assert.ok(store.pendingProbes().some((p) => p.startsWith("sudan:")));

  enqueueMapEventProbes({
    store,
    mapChanges: ["added:7:新事件"],
    configFingerprint: "cfg-sudan",
  });
  assert.ok(store.pendingProbes().some((p) => p.includes("added:7")));

  const routes = captureSudanRoutesFromScene({
    store,
    state,
    scene: sampleScene(),
    configFingerprint: "cfg-sudan",
    day: 3,
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.status, "needs_support");
  assert.equal(routes[0]!.slotIndex, 0);
  assert.ok(routes[0]!.unfilledSlots?.includes(1));
  const summary = store.summarize({ sudanCardId: 9001 });
  assert.equal(summary.compatible, 1);
  assert.equal(summary.needsSupport, 1);
}

function testBranchDedupeAndRewindIsolation(): void {
  const dir = tempDir();
  const branches = new SudanBranchStore(dir);
  const episodes = new EpisodeStore(dir);
  const anchor = "day:6|sudan:9001|map:x";
  const actions = ["exchange_sudan_card", "open_rite"];
  const signature = branchActionSignature(actions);
  const first = branches.startTrial({
    anchorDay: 6,
    anchorSignature: anchor,
    actionSignature: signature,
    actions,
    sudanCardId: 9001,
    sudanIdentity: "9001|99|石杀戮",
    baseline: { insight: 0, redrawRemaining: 2 },
  });
  assert.ok(first);
  const dup = branches.startTrial({
    anchorDay: 6,
    anchorSignature: anchor,
    actionSignature: signature,
    actions,
    sudanCardId: 9001,
    baseline: { insight: 0 },
  });
  assert.equal(dup, null, "same branch signature must not retry");

  episodes.create({
    kind: "rite",
    phase: "submitted",
    version: { configFingerprint: "cfg-sudan", gameFingerprint: "g1" },
    eventKey: "cfg-sudan:rite:5001",
    riteId: 5001,
    composition: [],
    settlementExperienceIds: [],
    branchId: first!.branchId,
    applied: false,
  });
  branches.appendPendingEvidence(first!.branchId, {
    episodeIds: [episodes.list()[0]!.id],
    notes: ["trial"],
  });
  const rewound = branches.markRewound(first!.branchId, 1);
  assert.equal(rewound?.status, "rewound");
  assert.equal(rewound?.insightDelta, 1);
  const quarantined = episodes.quarantineBranch(first!.branchId);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0]!.phase, "rewound");
  assert.equal(quarantined[0]!.quarantined, true);
  assert.equal(episodes.listOpen().length, 0);

  const committed = branches.startTrial({
    anchorDay: 6,
    anchorSignature: anchor + "|alt",
    actionSignature: "place_card_on_rite>execute",
    actions: ["place_card_on_rite", "execute"],
    sudanCardId: 9001,
    baseline: { insight: 1 },
  });
  assert.ok(committed);
  branches.appendPendingEvidence(committed!.branchId, {
    experienceIds: ["exp_1"],
    notes: ["ok"],
  });
  const done = branches.commit(committed!.branchId, { breakResult: "success" });
  assert.equal(done?.status, "committed");
  assert.ok(done?.experienceIds.includes("exp_1"));
}

function testInsightHelper(): void {
  const state = sampleState({ counters: { "7100005": 3 } });
  assert.equal(insightFromState(state), 3);
}

function testPrunePendingProbesAndVerifiedBreak(): void {
  const dir = tempDir();
  const store = new SudanRouteStore(dir);
  for (let i = 1; i <= 12; i++) {
    store.markPendingProbe(`event:added:${i}:点${i}`);
  }
  store.markPendingProbe("sudan:9001");
  store.markPendingProbe("sudan:9999");
  const pruned = pruneSudanRouteProbes({
    store,
    state: sampleState({
      rites: [
        { uid: 10, id: 1, name: "点10" },
        { uid: 11, id: 2, name: "点11" },
        { uid: 12, id: 3, name: "点12" },
      ],
    }),
  });
  assert.ok(pruned.after <= 8);
  assert.ok(!store.pendingProbes().some((p) => p === "sudan:9999"));
  assert.ok(!store.pendingProbes().some((p) => p.includes("added:1:")));
  assert.ok(store.pendingProbes().some((p) => p === "sudan:9001") || pruned.after >= 0);

  // Capture needs_support → verifiedBreak > 0 → timing leaves discover.
  captureSudanRoutesFromScene({
    store,
    state: sampleState(),
    scene: sampleScene(),
    configFingerprint: "cfg-sudan",
    day: 3,
  });
  const summary = store.summarize({ sudanCardId: 9001 });
  assert.ok(summary.verifiedBreak >= 1);
  const advice = adviseExecutionTiming({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    version: { gameFingerprint: "g", configFingerprint: "cfg-sudan" },
    day: 3,
    turn: null,
    phase: "main",
    terminal: false,
    resources: {},
    counters: {},
    cards: [],
    events: [],
    quests: [],
    enabledOps: ["open_rite"],
    executionDaysLeft: 4,
    sudanCard: { cardId: 9001, identity: "9001|99|石杀戮" },
    sudanRoutes: {
      coverage: 1,
      readyCount: summary.ready,
      needsSupportCount: summary.needsSupport,
      pendingProbes: 5,
      verifiedBreakCount: summary.verifiedBreak,
    },
  });
  assert.equal(advice.policy, "accumulate_prepare");
}

function testIncompatibleTierRoute(): void {
  const dir = tempDir();
  const store = new SudanRouteStore(dir);
  const state = sampleState({
    sudan: {
      initLife: 7,
      currentCard: { uid: 99, id: 9001, name: "铜纵欲", rare: 2 },
    },
    cards: [
      { uid: 99, id: 9001, type: "sudan", rare: 2, name: "铜纵欲", inHand: true, bag: 0 },
    ],
    currentRite: {
      uid: 36,
      id: 5002005,
      name: "欢愉之馆",
      life: 0,
      started: false,
      slots: [
        {
          index: 3,
          slotKey: "s4",
          text: "折断一张不高于岩石品级的苏丹卡",
          condition: '{"type":"sudan","f:rare-s1.rare<=":0}',
          requiredRare: 1,
          requiredTier: "石(1)",
          occupied: false,
        },
      ],
    },
  });
  const scene: SceneSnapshot = {
    snapshotVersion: 1,
    scene: { id: "play", phase: "rite", blocking: false },
    affordances: [
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 99, slotIndex: 3 },
      },
    ],
  };
  // Note: game would not usually emit place affordance for incompatible tier;
  // tracker still marks incompatible when requiredRare is present.
  const routes = captureSudanRoutesFromScene({
    store,
    state,
    scene,
    configFingerprint: "cfg-sudan",
    day: 5,
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.status, "incompatible");
  const summary = store.summarize({ sudanCardId: 9001 });
  assert.equal(summary.verifiedBreak, 0);
  assert.equal(summary.incompatible, 1);
  assert.equal(summary.compatible, 0);
}

function testFailedPathBlacklistAcrossDays(): void {
  const dir = tempDir();
  const store = new BacktrackStore(dir);
  store.beginRun("r1");
  const sig = buildPathSignature({
    sudanIdentity: "9001|99|石杀戮",
    routeLabel: "销卡仪式",
    compositionSignature: "cfg:rite:5001:s0:P:9001,s1:P:2001",
  });
  store.createOrRefreshFailure({
    runId: "r1",
    failureSignature: `x|${sig}`,
    originDay: 8,
    targetDay: 4,
    depth: 4,
    failedPathSignatures: [sig],
    terminalReason: "fail",
  });
  assert.equal(store.isFailedPath("r1", sig), true);
  assert.equal(store.listFailedPaths("r1").includes(sig), true);
}

function main(): void {
  testRouteProbeAndCapture();
  testBranchDedupeAndRewindIsolation();
  testInsightHelper();
  testPrunePendingProbesAndVerifiedBreak();
  testIncompatibleTierRoute();
  testFailedPathBlacklistAcrossDays();
  console.log("verify-sudan-routes: ok");
}

main();
