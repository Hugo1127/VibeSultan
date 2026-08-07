/**
 * Offline action-chain controller + next-day gate tests (no LLM / no live game).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ActionChainController,
  formatActionChainBrief,
  prioritizeMapChanges,
} from "../src/agent/actionChain.js";
import { preflightAction, runTool } from "../src/agent/tools.js";
import { reliableCardInspection } from "../src/memory/entityAdapter.js";
import { reliableSudanBreak } from "../src/memory/sudanRouteTracker.js";
import type { GameAction, GameState, SceneSnapshot } from "../src/game/types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-action-chain-"));
}

function playState(overrides: Partial<GameState> = {}): GameState {
  const base: GameState = {
    schemaVersion: 1,
    game: "sultan",
    terminal: false,
    screen: { id: "play", phase: "play" },
    values: {
      day: 1,
      turn: 1,
      initDone: true,
      inGame: true,
      handCount: 2,
      riteCount: 2,
      dailyNews: { present: true, open: false, entryAvailable: true, summary: null },
      cards: [
        { uid: 10, id: 1, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
        { uid: 11, id: 2, type: "char", rare: 1, name: "Aide", inHand: true, bag: 0 },
        { uid: 12, id: 3, type: "item", rare: 3, name: "RareOnce", inHand: true, bag: 0 },
      ],
      rites: [
        { uid: 100, id: 5001, name: "治理家业", life: 99, start: false, slotsFilled: 0 },
        { uid: 101, id: 5002, name: "权力的游戏", life: 99, start: false, slotsFilled: 0 },
      ],
      blockingOverlay: false,
    },
    actions: [
      { id: "open_daily_news", enabled: true },
      { id: "inspect_card", enabled: true },
      { id: "open_rite", enabled: true },
      { id: "place_card_on_rite", enabled: true },
      { id: "continue", enabled: false, reason: "nothing_to_continue" },
      { id: "next_day", enabled: true },
      { id: "reset", enabled: true },
    ],
  };
  return {
    ...base,
    ...overrides,
    values: { ...base.values, ...(overrides.values ?? {}) },
    actions: overrides.actions ?? base.actions,
  };
}

function playScene(): SceneSnapshot {
  return {
    snapshotVersion: 1,
    scene: { id: "play", phase: "play", blocking: false },
    affordances: [
      { action: "open_daily_news", mapsToOp: "open_daily_news", enabled: true },
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 10, slotIndex: 0 },
      },
      {
        action: "place",
        mapsToOp: "place_card_on_rite",
        enabled: true,
        parameters: { uid: 11, slotIndex: 0 },
      },
      {
        action: "open",
        mapsToOp: "open_rite",
        enabled: true,
        parameters: { uid: 100 },
      },
      {
        action: "open",
        mapsToOp: "open_rite",
        enabled: true,
        parameters: { uid: 101 },
      },
      { action: "click", mapsToOp: "next_day", enabled: true },
    ],
  };
}

function testEntryToDailyFlow(): void {
  const chain = new ActionChainController();
  let state = playState({
    screen: { id: "story", phase: "story" },
    actions: [
      { id: "select_event_option", enabled: true },
      { id: "execute", enabled: true },
    ],
  });
  let brief = chain.observe(state, playScene());
  assert.equal(brief.phase, "entry_setup");

  state = playState({
    screen: { id: "play", phase: "sudan_draw" },
    actions: [{ id: "draw_sudan_card", enabled: true }],
  });
  chain.noteAction({ op: "draw_sudan_card" }, state, playScene());
  brief = chain.observe(state, playScene());
  assert.equal(chain.checkpoint.sudanDrawn, true);

  state = playState();
  brief = chain.observe(state, playScene());
  assert.equal(brief.phase, "daily_news");
}

function testNewsHandMapAndGate(): void {
  const dir = tempDir();
  const chain = new ActionChainController({ memoryDir: dir });
  const state = playState();
  const scene = playScene();
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);
  chain.observe(state, scene);

  let result = chain.applyReport(
    {
      newsChecked: true,
      newsPresent: true,
      newsSummary: "朝堂传来流言",
      top3: [
        { title: "稳住朝堂", why: "怀疑上升" },
        { title: "治理家业", why: "金币" },
        { title: "探消息", why: "情报" },
      ],
      reviewedCardUids: [10, 11, 12],
      inspectedCardUids: [12],
      reviewedRiteUids: [100, 101],
      allocations: [
        { cardUid: 10, riteUid: 100, slotIndex: 0, why: "estate gold" },
        { cardUid: 11, riteUid: 101, slotIndex: 0, why: "court suspicion" },
      ],
      idleCards: [{ cardUid: 12, reason: "reserved", detail: "save rare item" }],
      localImproveDone: true,
    },
    state,
    scene,
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.brief.canAdvanceDay, true);
  assert.ok(result.brief.utilization.coverage >= 1 || result.brief.utilization.idle.length > 0);

  assert.equal(chain.isTrueNextDayContinue(state, scene), true);
  const gate = chain.canAdvanceDay(state, scene);
  assert.equal(gate.ok, true);

  // Incomplete checklist is advisory only (canAdvanceDay false ≠ hard reject).
  const blockedChain = new ActionChainController();
  blockedChain.noteAction({ op: "draw_sudan_card" }, state, scene);
  const early = blockedChain.canAdvanceDay(state, scene);
  assert.equal(early.ok, false);
  assert.ok(early.missing.length > 0);
}

function testDayResetAndMapDiff(): void {
  const chain = new ActionChainController();
  const s1 = playState();
  (s1.values as Record<string, unknown>).day = 1;
  chain.noteAction({ op: "draw_sudan_card" }, s1, playScene());
  chain.applyReport(
    {
      newsChecked: true,
      newsPresent: false,
      reviewedCardUids: [10, 11, 12],
      reviewedRiteUids: [100, 101],
      top3: [{ title: "a", why: "b" }],
      allocations: [{ cardUid: 10, riteUid: 100, slotIndex: 0 }],
      idleCards: [
        { cardUid: 11, reason: "no_positive_slot" },
        { cardUid: 12, reason: "reserved" },
      ],
      localImproveDone: true,
    },
    s1,
    playScene(),
  );

  const s2 = playState();
  (s2.values as Record<string, unknown>).day = 2;
  (s2.values as Record<string, unknown>).rites = [
    { uid: 100, id: 5001, name: "治理家业", life: 98, start: true, slotsFilled: 1 },
    { uid: 102, id: 5003, name: "浴场", life: 3, start: false, slotsFilled: 0 },
  ];
  const brief = chain.observe(s2, playScene());
  assert.equal(brief.day, 2);
  assert.equal(brief.phase, "daily_news");
  assert.equal(chain.checkpoint.newsChecked, false);
  assert.ok(brief.mapChanges.length > 0);
  assert.ok(
    brief.mapChanges.some((c) => c.startsWith("added:102:")),
    "new rite uid must appear as added",
  );
  assert.deepEqual(
    prioritizeMapChanges(["removed:101:x", "added:102:浴场", "life:100:99->98"]).slice(0, 1),
    ["added:102:浴场"],
  );
}

function testMapChangesRefreshAfterEmptyRollover(): void {
  const chain = new ActionChainController();
  const day1 = playState();
  (day1.values as Record<string, unknown>).day = 1;
  chain.observe(day1, playScene());

  // Day boundary with compact state (no rites) — previously froze mapChanges as only removed.
  const emptyDay2: GameState = {
    schemaVersion: 1,
    game: "sultan",
    screen: { id: "play", phase: "play" },
    values: {
      day: 2,
      turn: 2,
      riteCount: 3,
      dailyNews: { present: false, open: false },
      blockingOverlay: false,
      // rites intentionally omitted (summary view)
    },
    actions: [{ id: "open_rite", enabled: true }],
  };
  let brief = chain.observe(emptyDay2, {
    snapshotVersion: 2,
    scene: { id: "play", phase: "play", blocking: false },
    affordances: [],
  });
  assert.equal(brief.day, 2);

  // Later scene telemetry reveals the real map — mapChanges must refresh with added: first.
  const richScene: SceneSnapshot = {
    snapshotVersion: 3,
    scene: { id: "play", phase: "play", blocking: false },
    telemetry: {
      mapRites: [
        { uid: 20, id: 5002010, name: "装备商人", life: 4, start: false, slotsFilled: 0 },
        { uid: 21, id: 5000129, name: "做好准备", life: 4, start: false, slotsFilled: 0 },
        { uid: 100, id: 5001, name: "治理家业", life: 98, start: false, slotsFilled: 0 },
      ],
    },
    affordances: [
      {
        action: "open",
        mapsToOp: "open_rite",
        enabled: true,
        parameters: { uid: 20 },
      },
    ],
  };
  brief = chain.observe(emptyDay2, richScene);
  assert.ok(
    brief.mapChanges.some((c) => c.startsWith("added:20:")),
    `expected added:20 in ${brief.mapChanges.join("|")}`,
  );
  assert.ok(
    brief.mapChanges.some((c) => c.startsWith("added:21:")),
    "telemetry-only rites must enter inventory",
  );
  const text = formatActionChainBrief(brief);
  const mapLine = text.split("\n").find((l) => l.startsWith("mapChanges:"));
  assert.ok(mapLine, "brief must include mapChanges line");
  assert.ok(mapLine!.includes("added:"), "brief must show added");
  assert.ok(
    mapLine!.indexOf("added:") < mapLine!.indexOf("removed:") || !mapLine!.includes("removed:"),
    "added: must be listed before removed: in brief",
  );
  assert.ok(mapLine!.includes("NEW map points="), "brief should call out new map points");
}

function testMultiCardSameRiteAndLocalAdjust(): void {
  const chain = new ActionChainController();
  const state = playState();
  const scene = playScene();
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);
  const result = chain.applyReport(
    {
      newsChecked: true,
      newsPresent: false,
      reviewedCardUids: [10, 11, 12],
      reviewedRiteUids: [100, 101],
      top3: [{ title: "强化家业", why: "多卡同点" }],
      allocations: [
        { cardUid: 10, riteUid: 100, slotIndex: 0 },
        { cardUid: 11, riteUid: 100, slotIndex: 1 },
      ],
      idleCards: [{ cardUid: 12, reason: "reserved" }],
      localImproveDone: false,
    },
    state,
    scene,
  );
  assert.equal(result.ok, true);
  assert.equal(result.brief.canAdvanceDay, false);
  assert.ok(result.brief.missing.includes("local_improve"));

  // Simulate reset + reassignment via noteAction (reset clears current rite allocations).
  const stateWithRite = {
    ...state,
    values: {
      ...state.values,
      currentRite: { uid: 100, id: 5001, name: "治理家业" },
    },
  };
  chain.noteAction({ op: "reset" }, stateWithRite, scene);
  assert.equal(
    chain.checkpoint.allocations.filter((a) => a.riteUid === 100).length,
    0,
  );
  chain.noteAction(
    { op: "place_card_on_rite", uid: 10, slotIndex: 0 },
    stateWithRite,
    scene,
  );
  chain.noteAction(
    { op: "place_card_on_rite", uid: 11, slotIndex: 1 },
    stateWithRite,
    scene,
  );
  const done = chain.applyReport(
    {
      localImproveDone: true,
      idleCards: [{ cardUid: 12, reason: "reserved" }],
    },
    state,
    scene,
  );
  assert.equal(done.ok, true);
  assert.equal(done.brief.canAdvanceDay, true);
}

async function testToolGateAndPreflight(): Promise<void> {
  assert.equal(preflightAction({ op: "inspect_card" }), "missing_uid");
  assert.equal(preflightAction({ op: "inspect_card", uid: 10 }), null);
  assert.equal(preflightAction({ op: "open_daily_news" }), null);
  assert.equal(preflightAction({ op: "next_day" }), null);

  const chain = new ActionChainController();
  const state = playState();
  const scene = playScene();
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);

  const submitted: GameAction[] = [];
  const ops = {
    async submitActions(actions: GameAction[]) {
      submitted.push(...actions);
      return actions.map((a) => ({ op: a.op, ok: true, detail: "next_day via NextRoundButton" }));
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

  // Incomplete checklist alone must NOT hard-block next_day when no verified place pool.
  // (Day-close hard issues require captured place affordances / open rite.)
  const result = await runTool(
    ops as never,
    "submit_actions",
    JSON.stringify({
      actions: [{ op: "next_day" }],
      dayCloseReviewOverride: "清单未完成但无已验证正收益槽",
      decision: { title: "资源不足跳过当天" },
    }),
    { latestState: state, latestScene: scene, actionChain: chain },
  );
  const r = result as {
    results: Array<{ error?: string; ok?: boolean; op?: string }>;
    actionChain?: { canAdvanceDay?: boolean; missing?: string[] };
  };
  assert.equal(r.results[0]?.error, undefined);
  assert.equal(r.results[0]?.ok, true);
  assert.equal(submitted[0]?.op, "next_day");
  assert.equal(r.actionChain?.canAdvanceDay, false);
  assert.ok((r.actionChain?.missing?.length ?? 0) > 0);
}

function testBriefFormat(): void {
  const chain = new ActionChainController();
  const brief = chain.observe(playState(), playScene());
  const text = formatActionChainBrief(brief);
  assert.ok(text.includes("【当前行动链】"));
  assert.ok(text.includes("phase="));
  assert.ok(text.includes("executionTiming:"));
}

function testMandatoryNewCardInspection(): void {
  const chain = new ActionChainController({
    inspectionRequirement: (card) =>
      card.id === 4 ? "usage_unknown" : null,
  });
  const day1 = playState();
  chain.observe(day1, playScene());

  const day2 = playState();
  (day2.values as Record<string, unknown>).day = 2;
  (day2.values as Record<string, unknown>).cards = [
    ...((day1.values?.cards ?? []) as unknown[]),
    { uid: 14, id: 4, type: "item", rare: 2, name: "NewBook", inHand: true, bag: 0 },
  ];
  chain.observe(day2, playScene());
  let brief = chain.applyReport(
    { newsChecked: true, newsPresent: false },
    day2,
    playScene(),
  ).brief;
  assert.equal(brief.phase, "hand_review");
  assert.equal(brief.newCards[0]?.uid, 14);
  assert.equal(brief.newCards[0]?.tier, "铜(2)");
  assert.equal(brief.requiredInspections[0]?.reason, "usage_unknown");
  assert.ok(formatActionChainBrief(brief).includes("mustInspect: 14:NewBook:usage_unknown"));

  const fakeReview = chain.applyReport(
    { reviewedCardUids: [10, 11, 12, 14] },
    day2,
    playScene(),
  );
  assert.equal(fakeReview.ok, false);
  assert.equal(fakeReview.error, "inspection_evidence_required:14");

  const fakeInspection = chain.applyReport(
    { inspectedCardUids: [14] },
    day2,
    playScene(),
  );
  assert.equal(fakeInspection.ok, false);
  assert.equal(fakeInspection.error, "inspection_evidence_required:14");

  const action: GameAction = { op: "inspect_card", uid: 14 };
  assert.equal(
    reliableCardInspection({
      action,
      result: { ok: false, detail: "uid=14 id=4 cardSummary={book usage}" },
      stateBefore: day2,
    }),
    null,
  );
  assert.equal(
    reliableCardInspection({
      action,
      result: { ok: true, detail: "uid=14 id=4" },
      stateBefore: day2,
    }),
    null,
  );
  const reliable = reliableCardInspection({
    action,
    result: { ok: true, detail: "uid=14 id=4 cardSummary={book usage}" },
    stateBefore: day2,
  });
  assert.equal(reliable?.uid, 14);
  chain.confirmCardInspection(reliable!.uid!);
  brief = chain.observe(day2, playScene());
  assert.equal(brief.requiredInspections.length, 0);

  const accepted = chain.applyReport(
    { reviewedCardUids: [10, 11, 12, 14] },
    day2,
    playScene(),
  );
  assert.equal(accepted.ok, true, accepted.error);
}

function testExistingUnknownAndKnownDuplicateUid(): void {
  const unknownChain = new ActionChainController({
    inspectionRequirement: (card) =>
      card.id === 3 ? "usage_unknown" : null,
  });
  const state = playState();
  let brief = unknownChain.observe(state, playScene());
  assert.equal(brief.newCards.length, 0, "startup hand is a baseline, not newly acquired");
  assert.equal(brief.requiredInspections[0]?.uid, 12);

  const knownChain = new ActionChainController({
    inspectionRequirement: () => null,
  });
  knownChain.observe(state, playScene());
  const replaced = playState();
  (replaced.values as Record<string, unknown>).cards = [
    { uid: 20, id: 1, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
    ...((state.values?.cards ?? []) as unknown[]).slice(1),
  ];
  brief = knownChain.observe(replaced, playScene());
  assert.equal(brief.newCards.length, 0, "known cardId with a new UID reuses knowledge");
  assert.equal(brief.requiredInspections.length, 0);
}

function testExecutionDayGateBlocksLastDayWithoutBreak(): void {
  const chain = new ActionChainController();
  const state = playState();
  (state.values as Record<string, unknown>).day = 7;
  (state.values as Record<string, unknown>).sudan = { initLife: 7 };
  (state.values as Record<string, unknown>).cards = [
    { uid: 10, id: 1, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
    { uid: 99, id: 9001, type: "sudan", rare: 1, name: "石杀戮", inHand: true, bag: 0 },
  ];
  const scene = playScene();
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);
  const result = chain.applyReport(
    {
      newsChecked: true,
      newsPresent: false,
      reviewedCardUids: [10, 99],
      reviewedRiteUids: [100, 101],
      top3: [{ title: "最后一天销卡", why: "处刑" }],
      allocations: [{ cardUid: 10, riteUid: 100, slotIndex: 0 }],
      idleCards: [{ cardUid: 99, reason: "reserved", detail: "should not reserve on last day" }],
      localImproveDone: true,
    },
    state,
    scene,
  );
  assert.equal(result.ok, true);
  assert.equal(result.brief.executionTiming.policy, "commit_best");
  assert.ok(result.brief.missing.includes("execution_break_today"));
  // Sudan incompleteness is advisory — checklist may still report ready for next_day.
  assert.equal(result.brief.canAdvanceDay, true);

  const done = chain.applyReport(
    {
      allocations: [{ cardUid: 99, riteUid: 100, slotIndex: 0, why: "break sudan" }],
      idleCards: [{ cardUid: 10, reason: "no_positive_slot" }],
      sudanBreakDone: true,
      localImproveDone: true,
    },
    state,
    scene,
  );
  assert.equal(done.ok, false);
  assert.equal(done.error, "sudan_break_not_verified");
  assert.ok(!done.brief.done.includes("sudan_break_done"));

  const afterBreak = playState();
  (afterBreak.values as Record<string, unknown>).day = 7;
  (afterBreak.values as Record<string, unknown>).sudan = { initLife: 7, currentCard: null };
  (afterBreak.values as Record<string, unknown>).cards = [
    { uid: 10, id: 1, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
  ];
  assert.equal(
    reliableSudanBreak({
      action: { op: "execute" },
      result: { op: "execute", ok: true },
      stateBefore: state,
      stateAfter: afterBreak,
    }),
    true,
  );
  chain.observe(afterBreak, scene);
  chain.setSudanBreakVerified(true);
  assert.ok(chain.brief(afterBreak, scene).done.includes("sudan_break_done"));

  assert.equal(
    reliableSudanBreak({
      action: { op: "execute" },
      result: { op: "execute", ok: true },
      stateBefore: state,
      stateAfter: state,
    }),
    false,
    "successful submit is not a break while the Sudan card remains live",
  );
}

async function testNextDayNotHardBlockedByIncompleteChecklist(): Promise<void> {
  const chain = new ActionChainController();
  const state = playState({
    values: {
      day: 1,
      blockingOverlay: false,
      currentRite: {
        uid: 4,
        id: 5000001,
        name: "治理家业",
        started: false,
        canConfirm: false,
        slotCount: 0,
        slots: [],
      },
      dailyNews: { present: true, open: true, summary: "NewText +99" },
      cards: [
        { uid: 10, id: 1, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
        { uid: 11, id: 2, type: "char", rare: 1, name: "Aide", inHand: true, bag: 0 },
      ],
      rites: [
        { uid: 100, id: 5001, name: "治理家业", life: 99, start: false, slotsFilled: 0 },
      ],
    },
  });
  const scene: SceneSnapshot = {
    snapshotVersion: 1,
    scene: {
      id: "play",
      phase: "play",
      modal: "daily_news",
      blocking: false,
    },
    instruction: {
      source: "daily_news",
      type: "story_notify",
      text: "NewText +99",
    },
    affordances: [{ action: "click", mapsToOp: "next_day", enabled: true }],
  };
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);
  chain.applyReport({ newsChecked: true, newsPresent: true, newsSummary: "NewText +99" }, state, scene);

  const advisory = chain.canAdvanceDay(state, scene);
  assert.equal(advisory.ok, false);
  assert.ok(advisory.missing.length > 0);

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
    "submit_actions",
    JSON.stringify({
      actions: [{ op: "next_day" }],
      dayCloseReviewOverride: "daily_news 场景无已验证放置槽",
      decision: { title: "skip day" },
    }),
    { latestState: state, latestScene: scene, actionChain: chain },
  );
  const r = result as { results: Array<{ error?: string; ok?: boolean }> };
  assert.equal(r.results[0]?.error, undefined);
  assert.equal(submitted[0]?.op, "next_day");
}

function testResetClearsAllocationsAndIdlePrune(): void {
  const chain = new ActionChainController();
  const state = playState();
  const scene = playScene();
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);
  chain.applyReport(
    {
      newsChecked: true,
      reviewedCardUids: [10, 11, 12],
      reviewedRiteUids: [100, 101],
      top3: [{ title: "a", why: "b" }],
      allocations: [{ cardUid: 10, riteUid: 100, slotIndex: 0 }],
      idleCards: [{ cardUid: 11, reason: "no_positive_slot" }],
      localImproveDone: true,
    },
    state,
    scene,
  );
  assert.equal(chain.checkpoint.allocations.length, 1);

  const withRite = playState({
    values: {
      ...(state.values as object),
      currentRite: { uid: 100, id: 5001, name: "治理家业" },
    },
  });
  chain.noteAction({ op: "reset" }, withRite, scene);
  assert.equal(
    chain.checkpoint.allocations.filter((a) => a.riteUid === 100).length,
    0,
    "reset must clear allocations for current rite",
  );

  // Idle card leaves hand → pruned on observe.
  chain.applyReport(
    {
      idleCards: [{ cardUid: 11, reason: "no_positive_slot" }],
      localImproveDone: false,
    },
    withRite,
    scene,
  );
  const withoutAide = playState({
    values: {
      ...(withRite.values as object),
      cards: [
        { uid: 10, id: 1, type: "char", rare: 1, name: "Hero", inHand: true, bag: 0 },
        { uid: 12, id: 3, type: "item", rare: 3, name: "RareOnce", inHand: true, bag: 0 },
      ],
    },
  });
  chain.observe(withoutAide, scene);
  assert.equal(
    chain.checkpoint.idleCards.some((i) => i.cardUid === 11),
    false,
    "idleCards for departed UIDs must be pruned",
  );
}

function testIdleAndAssignedConflict(): void {
  const chain = new ActionChainController();
  const state = playState();
  const scene = playScene();
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);
  const result = chain.applyReport(
    {
      newsChecked: true,
      reviewedCardUids: [10, 11, 12],
      reviewedRiteUids: [100, 101],
      top3: [{ title: "a", why: "b" }],
      allocations: [{ cardUid: 10, riteUid: 100, slotIndex: 0 }],
      idleCards: [{ cardUid: 10, reason: "reserved" }],
      localImproveDone: true,
    },
    state,
    scene,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "idle_and_assigned:10");
}

function testTerminalRecoveryOpsAndNewGameReset(): void {
  const chain = new ActionChainController();
  const terminalState = playState({
    terminal: true,
    screen: { id: "play", phase: "terminal" },
    values: {
      day: 8,
      questSummary: { success: false, overReason: 12 },
    },
    actions: [
      { id: "prev_round", enabled: true },
      { id: "start_new_game", enabled: true },
      { id: "next_day", enabled: false, reason: "game_over" },
    ],
  });
  const brief = chain.observe(terminalState, playScene());
  assert.equal(brief.phase, "terminal");
  assert.ok(brief.allowedOps.includes("prev_round"));
  assert.ok(brief.allowedOps.includes("start_new_game"));
  assert.match(brief.nextHint, /prev_round|start_new_game|重开/);

  chain.noteAction({ op: "draw_sudan_card" }, terminalState, playScene());
  assert.equal(chain.checkpoint.sudanDrawn, true);
  chain.noteAction({ op: "start_new_game" }, terminalState, playScene());
  assert.equal(chain.checkpoint.sudanDrawn, false);
  assert.equal(chain.checkpoint.entrySetupDone, false);
  assert.equal(chain.checkpoint.day, null);

  chain.setRecoveryPlan({
    targetDay: 4,
    depth: 4,
    failedPathSignatures: ["path:a"],
    hint: "rewind",
  });
  const recoveryState = playState();
  (recoveryState.values as Record<string, unknown>).day = 8;
  recoveryState.actions = [{ id: "prev_round", enabled: true }, { id: "continue", enabled: true }];
  let recoveryBrief = chain.observe(recoveryState, playScene());
  assert.equal(recoveryBrief.phase, "recovery_rewind");
  assert.ok(recoveryBrief.allowedOps.includes("prev_round"));
  (recoveryState.values as Record<string, unknown>).day = 4;
  recoveryBrief = chain.observe(recoveryState, playScene());
  assert.notEqual(recoveryBrief.phase, "recovery_rewind");
}

function testSoftMapReviewWithSlotPreview(): void {
  const chain = new ActionChainController();
  const scene = playScene();
  const ritesWithPreview = [
    {
      uid: 100,
      id: 5001,
      name: "治理家业",
      life: 99,
      start: false,
      slotsFilled: 0,
      slotPreview: [{ index: 0, slotKey: "s1", text: "人物", conditionType: "char" }],
      handMatchCount: 2,
    },
    {
      uid: 101,
      id: 5002,
      name: "权力的游戏",
      life: 99,
      start: false,
      slotsFilled: 0,
      slotPreview: [{ index: 5, slotKey: "s6", text: "苏丹卡", conditionType: "sudan" }],
      handMatchCount: 1,
    },
  ];

  // Establish previousMap on day0 so day1 is not all-added.
  const day0 = playState({ values: { day: 0, rites: ritesWithPreview } });
  chain.noteAction({ op: "draw_sudan_card" }, day0, scene);
  chain.observe(day0, scene);
  chain.applyReport(
    {
      newsChecked: true,
      newsPresent: false,
      reviewedCardUids: [10, 11, 12],
      inspectedCardUids: [12],
      reviewedRiteUids: [],
      top3: [{ title: "t", why: "w", priority: 1 }],
    },
    day0,
    scene,
  );

  const day1 = playState({ values: { day: 1, rites: ritesWithPreview } });
  // Day change resets checkpoint fields — set probe after the transition observe.
  let brief = chain.observe(day1, scene);
  chain.setSudanRouteProbePending(1);
  brief = chain.observe(day1, scene);
  assert.ok(
    brief.missing.some((m) => m.startsWith("map_review")),
    `sudan outlet with pending probe must keep map_review open; missing=${brief.missing.join(",")}`,
  );

  // Opening the sudan outlet completes map_review (errand soft-reviewed via preview).
  chain.noteAction({ op: "open_rite", uid: 101 }, day1, scene);
  brief = chain.observe(day1, scene);
  assert.ok(
    brief.done.includes("map_review"),
    `expected map_review done, got done=${brief.done.join(",")} missing=${brief.missing.join(",")}`,
  );

  // Newly added point without open must keep map_review incomplete.
  chain.setSudanRouteProbePending(0);
  chain.applyReport(
    {
      reviewedRiteUids: [100, 101],
      top3: [{ title: "t", why: "w", priority: 1 }],
    },
    day1,
    scene,
  );
  const day2 = playState({
    values: {
      day: 2,
      rites: [
        ...ritesWithPreview,
        {
          uid: 102,
          id: 5003,
          name: "新事件",
          life: 3,
          slotPreview: [{ index: 0, conditionType: "char" }],
          handMatchCount: 1,
        },
      ],
    },
  });
  brief = chain.observe(day2, scene);
  assert.ok(
    brief.mapChanges.some((c) => c.startsWith("added:102")),
    `new map point should appear in mapChanges, got ${brief.mapChanges.join("|")}`,
  );
  assert.ok(
    brief.missing.some((m) => m.startsWith("map_review")),
    "added point must require open_rite even with slotPreview",
  );
}

async function main(): Promise<void> {
  testEntryToDailyFlow();
  testNewsHandMapAndGate();
  testDayResetAndMapDiff();
  testMapChangesRefreshAfterEmptyRollover();
  testMultiCardSameRiteAndLocalAdjust();
  await testToolGateAndPreflight();
  testBriefFormat();
  testMandatoryNewCardInspection();
  testExistingUnknownAndKnownDuplicateUid();
  testExecutionDayGateBlocksLastDayWithoutBreak();
  await testNextDayNotHardBlockedByIncompleteChecklist();
  testResetClearsAllocationsAndIdlePrune();
  testIdleAndAssignedConflict();
  testTerminalRecoveryOpsAndNewGameReset();
  testSoftMapReviewWithSlotPreview();
  console.log("verify-action-chain: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
