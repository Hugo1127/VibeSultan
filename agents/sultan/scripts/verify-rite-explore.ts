import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GameAction, GameState } from "../src/game/types.js";
import { createSultanEntityStores } from "../src/memory/entityMemory.js";
import {
  canonicalCompositionSignature,
  signatureFromAssignments,
} from "../src/memory/riteComposition.js";
import { RiteExploreStore } from "../src/memory/riteExploreStore.js";
import {
  collectBaselineSignatures,
  evaluateRiteExploreGate,
  compositionHitsContradicted,
  isBlockingGameContradiction,
} from "../src/planner/riteExplorePolicy.js";
import {
  buildRiteExploreBrief,
  buildTrialSummaryZh,
  HOST_DUPLICATE_HINT,
  parseFilledSlotsFromSignature,
} from "../src/memory/riteExploreBrief.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-rite-explore-"));
}

function baseState(composition: Array<{ slot: number; cardId: number; count?: number }>): GameState {
  return {
    schemaVersion: 1,
    game: "sultan",
    terminal: false,
    screen: { id: "play", phase: "rite" },
    values: {
      day: 3,
      fingerprint: "cfg-a",
      sudan: { initLife: 7 },
      cards: composition.map((c, i) => ({
        uid: 100 + i,
        id: c.cardId,
        type: "char",
        rare: 1,
        name: `C${c.cardId}`,
        inHand: false,
        count: c.count ?? 1,
      })),
      currentRite: {
        uid: 1,
        id: 5001,
        name: "普通仪式",
        life: 4,
        started: true,
        slots: composition.map((c, i) => ({
          index: c.slot,
          slotKey: `s${c.slot}`,
          acceptsOp: "place_card_on_rite",
          cardUid: 100 + i,
          cardId: c.cardId,
          occupied: true,
        })),
      },
    },
    actions: [{ id: "execute", enabled: true }],
  };
}

function testSignaturesDistinguishCount(): void {
  const one = signatureFromAssignments({
    configFingerprint: "cfg",
    riteId: 1,
    assignments: [
      {
        cardId: 2000001,
        slotIndex: 1,
        slotKey: "s1",
        count: 1,
        interactionKey: "x",
      },
    ],
  });
  const stack = signatureFromAssignments({
    configFingerprint: "cfg",
    riteId: 1,
    assignments: [
      {
        cardId: 2000001,
        slotIndex: 1,
        slotKey: "s1",
        count: 5,
        interactionKey: "x",
      },
    ],
  });
  assert.notEqual(one, stack);
  assert.match(stack, /@5/);
}

function testBaselinesAndBudget(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const explore = new RiteExploreStore(dir);
  const runId = "run1";
  explore.beginRun(runId);

  stores.events.touch({
    key: "cfg-a:rite:5001",
    kind: "event",
    version: { gameFingerprint: "g1", configFingerprint: "cfg-a" },
    facts: {
      riteId: 5001,
      successfulRoutes: ["composition=s1:2001,s2:2002", "composition=s1:2003,s2:2002"],
    },
  });
  stores.events.setStatus("cfg-a:rite:5001", { gameFingerprint: "g1", configFingerprint: "cfg-a" }, "validated");
  // Ensure validated status sticks for baseline collection.
  const eventsPath = path.join(dir, "events.json");
  if (fs.existsSync(eventsPath)) {
    const file = JSON.parse(fs.readFileSync(eventsPath, "utf8")) as {
      entities: Array<{ key: string; status: string; confidence: number; sampleCount: number }>;
    };
    for (const row of file.entities) {
      if (row.key.includes("5001")) {
        row.status = "validated";
        row.confidence = 0.9;
        row.sampleCount = 3;
      }
    }
    fs.writeFileSync(eventsPath, JSON.stringify(file, null, 2), "utf8");
  }

  const baselines = collectBaselineSignatures({
    stores,
    configFingerprint: "cfg-a",
    riteId: 5001,
    eventKey: "cfg-a:rite:5001",
  });
  assert.equal(baselines.length, 2);

  const baselineAction: GameAction = { op: "execute" };
  const baselineState = baseState([
    { slot: 1, cardId: 2001 },
    { slot: 2, cardId: 2002 },
  ]);
  const allowBaseline = evaluateRiteExploreGate({
    action: baselineAction,
    state: baselineState,
    stores,
    exploreStore: explore,
    runId,
    gameFingerprint: "cfg-a",
  });
  assert.equal(allowBaseline?.allow, true);
  assert.equal(allowBaseline && allowBaseline.allow && allowBaseline.isNovel, false);

  const novel1 = evaluateRiteExploreGate({
    action: baselineAction,
    state: baseState([
      { slot: 1, cardId: 3001 },
      { slot: 2, cardId: 2002 },
    ]),
    stores,
    exploreStore: explore,
    runId,
    gameFingerprint: "cfg-a",
  });
  assert.equal(novel1?.allow, true);
  assert.equal(novel1 && novel1.allow && novel1.isNovel, true);
  if (novel1 && novel1.allow) {
    explore.recordSubmittedTrial({
      runId,
      eventKey: novel1.eventKey,
      riteId: novel1.riteId,
      signature: novel1.signature,
      isNovel: true,
      day: 3,
    });
  }

  const novel2 = evaluateRiteExploreGate({
    action: baselineAction,
    state: baseState([
      { slot: 1, cardId: 3002 },
      { slot: 2, cardId: 2002 },
    ]),
    stores,
    exploreStore: explore,
    runId,
    gameFingerprint: "cfg-a",
  });
  assert.equal(novel2?.allow, true);
  if (novel2 && novel2.allow) {
    explore.recordSubmittedTrial({
      runId,
      eventKey: novel2.eventKey,
      riteId: novel2.riteId,
      signature: novel2.signature,
      isNovel: true,
      day: 3,
    });
  }

  const novel3 = evaluateRiteExploreGate({
    action: baselineAction,
    state: baseState([
      { slot: 1, cardId: 3003 },
      { slot: 2, cardId: 2002 },
    ]),
    stores,
    exploreStore: explore,
    runId,
    gameFingerprint: "cfg-a",
  });
  assert.equal(novel3?.allow, false);
  assert.equal(novel3 && !novel3.allow && novel3.error, "rite_explore_limit");

  // Sudan-break composition exempt from explore_limit even when budget exhausted.
  const sudanBreakState: GameState = {
    ...baseState([{ slot: 5, cardId: 2010006 }]),
    values: {
      ...baseState([{ slot: 5, cardId: 2010006 }]).values!,
      day: 3,
      sudan: {
        initLife: 7,
        currentCard: { uid: 100, id: 2010006, name: "纵欲", rare: 2 },
      },
      cards: [
        {
          uid: 100,
          id: 2010006,
          type: "sudan",
          rare: 2,
          name: "纵欲",
          inHand: false,
        },
      ],
      currentRite: {
        uid: 34,
        id: 5001,
        name: "权力的游戏",
        life: 0,
        started: true,
        slots: [
          {
            index: 5,
            slotKey: "s6",
            acceptsOp: "cancel_card_placement",
            cardUid: 100,
            cardId: 2010006,
            occupied: true,
          },
        ],
      },
    },
  };
  const sudanBreakGate = evaluateRiteExploreGate({
    action: baselineAction,
    state: sudanBreakState,
    stores,
    exploreStore: explore,
    runId,
    gameFingerprint: "cfg-a",
  });
  assert.equal(sudanBreakGate?.allow, true, "sudan break must bypass rite_explore_limit");

  // Commit-locked day: ordinary novel blocked, sudan break still allowed.
  const lateOrdinary = evaluateRiteExploreGate({
    action: baselineAction,
    state: {
      ...baseState([
        { slot: 1, cardId: 4001 },
        { slot: 2, cardId: 2002 },
      ]),
      values: {
        ...baseState([{ slot: 1, cardId: 4001 }, { slot: 2, cardId: 2002 }]).values!,
        day: 7,
        sudan: { initLife: 7, currentCard: { uid: 99, id: 2010006, name: "纵欲" } },
      },
    },
    stores,
    exploreStore: explore,
    runId,
    gameFingerprint: "cfg-a",
  });
  assert.equal(lateOrdinary?.allow, false);
  assert.equal(lateOrdinary && !lateOrdinary.allow && lateOrdinary.error, "rite_explore_commit_locked");

  const lateSudanBreak = evaluateRiteExploreGate({
    action: baselineAction,
    state: {
      ...sudanBreakState,
      values: {
        ...sudanBreakState.values!,
        day: 7,
        sudan: {
          initLife: 7,
          currentCard: { uid: 100, id: 2010006, name: "纵欲", rare: 2 },
        },
      },
    },
    stores,
    exploreStore: explore,
    runId,
    gameFingerprint: "cfg-a",
  });
  assert.equal(lateSudanBreak?.allow, true, "sudan break must bypass commit_locked");

  const dup = evaluateRiteExploreGate({
    action: baselineAction,
    state: baseState([
      { slot: 1, cardId: 3001 },
      { slot: 2, cardId: 2002 },
    ]),
    stores,
    exploreStore: explore,
    runId,
    gameFingerprint: "cfg-a",
  });
  assert.equal(dup?.allow, false);
  assert.equal(dup && !dup.allow && dup.error, "rite_explore_signature_duplicate");
  if (dup && !dup.allow) {
    assert.match(dup.detail, /宿主防重复/);
    assert.doesNotMatch(dup.detail, /P:3001|cfg-a:rite:5001:s/);
    assert.ok(!dup.detail.includes(dup.signature ?? "___missing___"));
  }

  // No refund after "prev_round".
  assert.equal(explore.exploreCount("cfg-a:rite:5001", runId), 2);

  // New run clears budget.
  explore.beginRun("run2");
  assert.equal(explore.exploreCount("cfg-a:rite:5001", "run2"), 0);
  assert.equal(explore.remainingBudget("cfg-a:rite:5001", "run2"), 2);

  // Commit lock on day 7 with initLife 7 (no current sudan in composition).
  const late = evaluateRiteExploreGate({
    action: baselineAction,
    state: {
      ...baseState([
        { slot: 1, cardId: 4001 },
        { slot: 2, cardId: 2002 },
      ]),
      values: {
        ...baseState([{ slot: 1, cardId: 4001 }, { slot: 2, cardId: 2002 }]).values!,
        day: 7,
        sudan: { initLife: 7 },
      },
    },
    stores,
    exploreStore: explore,
    runId: "run2",
    gameFingerprint: "cfg-a",
  });
  assert.equal(late?.allow, false);
  assert.equal(late && !late.allow && late.error, "rite_explore_commit_locked");
}

function testRiteExploreBriefNaturalLanguage(): void {
  const signature = canonicalCompositionSignature({
    configFingerprint: "8b1c186f",
    riteId: 5001001,
    slots: [
      { slotKey: "s1", slotIndex: 1, code: "E" },
      { slotKey: "s2", slotIndex: 2, code: "P:2000024" },
      { slotKey: "s6", slotIndex: 6, code: "P:2010001" },
    ],
  });
  assert.ok(signature.includes("P:2010001"));

  const filled = parseFilledSlotsFromSignature(signature);
  assert.equal(filled.length, 2);
  assert.equal(filled[0]?.cardId, 2000024);
  assert.equal(filled[1]?.cardId, 2010001);

  const state: GameState = {
    schemaVersion: 1,
    game: "sultan",
    terminal: false,
    screen: { id: "play", phase: "rite" },
    values: {
      fingerprint: "8b1c186f",
      day: 1,
      cards: [
        { uid: 10, id: 2000024, name: "奈费勒", rare: 3, type: "char" },
        { uid: 1, id: 2010001, name: "杀戮", rare: 1, type: "sudan" },
      ],
      currentRite: {
        uid: 1,
        id: 5001001,
        name: "权力的游戏",
        slots: [
          {
            index: 6,
            slotKey: "s6",
            text: "在苏丹的面前使用苏丹卡也许是一个疯狂的主意……",
            cardUid: 1,
            cardId: 2010001,
          },
          {
            index: 2,
            slotKey: "s2",
            text: "一位权臣",
            cardUid: 10,
            cardId: 2000024,
          },
        ],
      },
    },
  };

  const summary = buildTrialSummaryZh({
    signature,
    state,
    preferLiveSlots: true,
  });
  assert.match(summary, /杀戮\(石\)/);
  assert.match(summary, /奈费勒\(银\)/);
  assert.doesNotMatch(summary, /P:2010001|8b1c186f:rite/);

  const submittedBrief = buildRiteExploreBrief({
    trials: [
      {
        id: "t1",
        signature,
        summaryZh: summary,
        day: 1,
        step: 39,
        status: "submitted",
        createdAt: "2026-07-29T20:00:00.000Z",
        updatedAt: "2026-07-29T20:00:00.000Z",
      },
    ],
    riteName: "权力的游戏",
    includeHostDuplicateHint: true,
  });
  assert.ok(submittedBrief);
  assert.match(submittedBrief!, /已提交过/);
  assert.match(submittedBrief!, /不要原样再 execute/);
  assert.ok(submittedBrief!.includes(HOST_DUPLICATE_HINT));
  assert.doesNotMatch(submittedBrief!, /P:2010001|8b1c186f:rite:5001001/);

  const negativeBrief = buildRiteExploreBrief({
    trials: [
      {
        id: "t2",
        signature,
        summaryZh: summary,
        day: 1,
        step: 40,
        status: "settled",
        outcome: "negative",
        createdAt: "2026-07-29T20:01:00.000Z",
        updatedAt: "2026-07-29T20:02:00.000Z",
      },
    ],
    riteName: "权力的游戏",
  });
  assert.ok(negativeBrief);
  assert.match(negativeBrief!, /本局试过/);
  assert.match(negativeBrief!, /结果不佳/);
  assert.doesNotMatch(negativeBrief!, /已提交过/);

  // Legacy trial without summaryZh falls back to signature decode (still no DSL leak).
  const legacySummary = buildTrialSummaryZh({
    signature,
    state,
    preferLiveSlots: false,
  });
  assert.match(legacySummary, /杀戮\(石\)/);
  assert.doesNotMatch(legacySummary, /P:2010001/);

  const legacyBrief = buildRiteExploreBrief({
    trials: [
      {
        id: "t3",
        signature,
        day: 1,
        status: "submitted",
        createdAt: "2026-07-29T20:00:00.000Z",
        updatedAt: "2026-07-29T20:00:00.000Z",
      },
    ],
    state,
    riteName: "权力的游戏",
  });
  assert.ok(legacyBrief);
  assert.match(legacyBrief!, /杀戮\(石\)/);
  assert.doesNotMatch(legacyBrief!, /P:2010001|8b1c186f:rite/);
}

function testHostNoiseContradictedDoesNotBlock(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const version = { gameFingerprint: "g1", configFingerprint: "cfg-a" };
  stores.interactions.touch({
    key: "cfg-a:interaction:2000369:x:slot:s2",
    kind: "interaction",
    version,
    facts: {
      cardId: 2000369,
      eventKey: "cfg-a:rite:5000001",
      slotKey: "s2",
      slotIndex: 1,
    },
  });
  stores.interactions.addEvidence("cfg-a:interaction:2000369:x:slot:s2", version, {
    outcome: "negative",
    summary: "placement failed: plan_single_step_only",
  });
  stores.interactions.addEvidence("cfg-a:interaction:2000369:x:slot:s2", version, {
    outcome: "negative",
    summary: "placement failed: plan_single_step_only",
  });
  const rec = stores.interactions.get("cfg-a:interaction:2000369:x:slot:s2", version)!;
  assert.equal(rec.status, "contradicted");
  assert.equal(isBlockingGameContradiction(rec), false);
  assert.equal(
    compositionHitsContradicted({
      stores,
      configFingerprint: "cfg-a",
      eventKey: "cfg-a:rite:5000001",
      assignments: [
        {
          cardId: 2000369,
          slotIndex: 1,
          slotKey: "s2",
          interactionKey: "x",
        },
      ],
    }),
    false,
  );
}

testSignaturesDistinguishCount();
testBaselinesAndBudget();
testHostNoiseContradictedDoesNotBlock();
testRiteExploreBriefNaturalLanguage();
console.log("verify-rite-explore: ok");
