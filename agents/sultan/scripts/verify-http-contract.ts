import assert from "node:assert/strict";
import {
  preflightAction,
  formatTerminalRecoveryHint,
  isTerminalState,
  isVictoryTerminal,
  terminalRecoveryOps,
  validateSceneClick,
} from "../src/agent/tools.js";
import { bootIntoPlay } from "../src/memory/boot.js";
import type {
  ActionResult,
  GameAction,
  GameState,
  SceneSnapshot,
} from "../src/game/types.js";
import { HttpGameOps } from "../src/game/HttpGameOps.js";
import { config } from "../src/config.js";
import { createDayBoundary } from "../src/memory/dayBoundary.js";

function testPreflight(): void {
  assert.equal(preflightAction({ op: "noop" }), null);
  assert.equal(preflightAction({ op: "continue" }), null);
  assert.equal(preflightAction({ op: "execute" }), null);
  assert.equal(preflightAction({ op: "cancel" }), null);
  assert.equal(preflightAction({ op: "reset" }), null);
  assert.equal(preflightAction({ op: "continue_game" }), null);
  assert.equal(preflightAction({ op: "next_round" }), null);
  assert.equal(preflightAction({ op: "select_event_option" }), "missing_optionIndex");
  assert.equal(preflightAction({ op: "select_event_option", optionIndex: 0 }), null);
  assert.equal(preflightAction({ op: "select_card" }), "missing_uid");
  assert.equal(preflightAction({ op: "select_card", uid: 7 }), null);
  assert.equal(preflightAction({ op: "inspect_card" }), "missing_uid");
  assert.equal(preflightAction({ op: "inspect_card", uid: 7 }), null);
  assert.equal(preflightAction({ op: "open_daily_news" }), null);
  assert.equal(
    preflightAction({ op: "place_card_on_rite", uid: 1 }),
    "missing_slotIndex",
  );
  assert.equal(
    preflightAction({ op: "place_card_on_rite", uid: 1, slotIndex: 0 }),
    null,
  );
  assert.equal(preflightAction({ op: "equip_item" }), "missing_characterUid");
  assert.equal(
    preflightAction({ op: "equip_item", characterUid: 10, itemUid: 86 }),
    null,
  );
  assert.equal(preflightAction({ op: "unequip_item" }), "missing_itemUid");
  assert.equal(preflightAction({ op: "unequip_item", itemUid: 86 }), null);
  assert.equal(preflightAction({ op: "cancel_card_placement" }), null);
  assert.equal(preflightAction({ op: "clear_rite_submission" }), null);
  assert.equal(preflightAction({ op: "click_element" }), "missing_elementId");
  assert.equal(
    preflightAction({ op: "click_element", elementId: "semantic:continue", snapshotVersion: 4 }),
    null,
  );

  const state: GameState = {
    values: {
      cards: [{ uid: 1 }],
      events: [{ index: 0 }],
    },
    actions: [
      { id: "select_card", enabled: true },
      { id: "select_event_option", enabled: true },
      { id: "continue", enabled: true },
      { id: "execute", enabled: false },
    ],
  };
  assert.equal(preflightAction({ op: "select_card", uid: 1 }, state), null);
  assert.equal(preflightAction({ op: "select_card", uid: 99 }, state), "card_not_found");
  assert.equal(
    preflightAction({ op: "select_event_option", optionIndex: 3 }, state),
    "option_out_of_range",
  );
  assert.equal(preflightAction({ op: "continue" }, state), null);
  assert.equal(preflightAction({ op: "execute" }, state), "action_not_enabled");
  assert.equal(preflightAction({ op: "next_round" }, state), "action_not_enabled");

  // AI-visible action surface should center on intents, not button labels.
  const intentIds = new Set((state.actions ?? []).map((a) => a.id));
  assert.ok(intentIds.has("continue"));
  assert.ok(!intentIds.has("click_element"));
}

function testSceneClickContract(): void {
  const scene: SceneSnapshot = {
    snapshotVersion: 4,
    scene: { id: "play", phase: "story", modal: "option", blocking: true },
    instruction: { text: "选择你的出身" },
    elements: [
      {
        elementId: "semantic:option_0",
        role: "toggle",
        text: "商人",
        visible: true,
        interactable: true,
      },
      {
        elementId: "ui:blocked",
        role: "button",
        text: "主界面按钮",
        visible: true,
        interactable: false,
        blocked: true,
      },
    ],
    affordances: [
      {
        action: "click",
        targetId: "semantic:option_0",
        enabled: true,
        mapsToOp: "select_event_option",
      },
      {
        action: "click",
        targetId: "ui:blocked",
        enabled: false,
        reason: "blocked_by_modal",
      },
    ],
  };
  assert.equal(validateSceneClick(scene, "semantic:option_0", 4), null);
  assert.equal(validateSceneClick(scene, "semantic:option_0", 3), "stale_scene");
  assert.equal(validateSceneClick(scene, "ui:blocked", 4), "blocked_by_modal");
  assert.equal(validateSceneClick(scene, "missing", 4), "element_not_clickable");
  assert.equal(validateSceneClick(null, "semantic:option_0", 4), "observe_scene_required");
}

function testGameStateShape(): void {
  const state: GameState = {
    schemaVersion: 1,
    game: "sultan",
    screen: { id: "play", phase: "play" },
    terminal: false,
    values: {
      day: 3,
      initDone: true,
      inGame: true,
      counters: { gold: 100 },
      sudan: { remaining: 5 },
      handCount: 4,
      cards: [{ uid: 1, id: 10 }],
      rites: [{ uid: 2, id: 20, canConfirm: false }],
      events: [{ index: 0, label: "option_0" }],
      currentEvent: {
        kind: "choice",
        prompt: "Choose",
        identitySeed: "abc123",
        identityQuality: "derived",
        options: [{ index: 0, label: "option_0" }],
      },
    },
    actions: [{ id: "continue", enabled: true }],
  };
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.game, "sultan");
  assert.ok(Array.isArray(state.actions));
  assert.equal(state.values?.currentEvent?.identitySeed, "abc123");
  assert.equal(isTerminalState({ terminal: true }), true);
  assert.equal(isTerminalState(state), false);

  const failureTerminal: GameState = {
    terminal: true,
    screen: { id: "play", phase: "terminal" },
    values: { questSummary: { success: false, overReason: 12 } },
    actions: [
      { id: "prev_round", enabled: true },
      { id: "start_new_game", enabled: true },
      { id: "next_day", enabled: false, reason: "game_over" },
    ],
  };
  assert.equal(isVictoryTerminal(failureTerminal), false);
  assert.deepEqual(terminalRecoveryOps(failureTerminal), [
    "prev_round",
    "start_new_game",
  ]);
  assert.match(
    formatTerminalRecoveryHint(failureTerminal) ?? "",
    /recovery plan|prev_round/,
  );
  assert.match(
    formatTerminalRecoveryHint(failureTerminal) ?? "",
    /failed path|目标决策日|prev_round/,
  );

  const victoryTerminal: GameState = {
    terminal: true,
    values: { questSummary: { success: true, overReason: 22 } },
    actions: [{ id: "start_new_game", enabled: true }],
  };
  assert.equal(isVictoryTerminal(victoryTerminal), true);
  assert.deepEqual(terminalRecoveryOps(victoryTerminal), ["start_new_game"]);
}

async function testBootMock(): Promise<void> {
  const frames: GameState[] = [
    {
      screen: { id: "startscene", phase: "boot" },
      values: { initDone: false, inGame: false },
      actions: [{ id: "continue", enabled: true }],
    },
    {
      screen: { id: "startscene", phase: "boot" },
      values: { initDone: true, inGame: false },
      actions: [
        { id: "start_new_game", enabled: true },
        { id: "continue", enabled: true },
      ],
    },
    {
      screen: { id: "story", phase: "story" },
      values: { initDone: true, inGame: true, eventOptionCount: 1 },
      actions: [
        { id: "select_event_option", enabled: true },
        { id: "continue", enabled: true },
      ],
    },
    {
      screen: { id: "play", phase: "play" },
      values: { initDone: true, inGame: true, handCount: 1 },
      actions: [
        { id: "select_card", enabled: true },
        { id: "continue", enabled: true },
      ],
    },
  ];
  let i = 0;
  let polls = 0;
  const ops = {
    async getState(): Promise<GameState> {
      polls += 1;
      // Simulate InitDone flipping true after the first poll.
      if (i === 0 && polls >= 2) i = 1;
      return frames[Math.min(i, frames.length - 1)]!;
    },
    async submitActions(actions: GameAction[]): Promise<ActionResult[]> {
      i = Math.min(i + 1, frames.length - 1);
      return actions.map((a) => ({ op: a.op, ok: true }));
    },
  };
  const boot = await bootIntoPlay({ ops: ops as never, timeoutMs: 2000, pollMs: 1 });
  assert.equal(boot.ok, true, boot.error ?? boot.steps.join(" > "));
  assert.ok(boot.steps.some((s) => s.includes("start_new_game")));
}

async function testHttpGameOpsMock(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body && typeof init.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({ url, method, body });

    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ ok: true, game: "sultan", actions: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/state")) {
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          game: "sultan",
          screen: { id: "play", phase: "play" },
          terminal: false,
          values: {
            day: 1,
            initDone: true,
            inGame: true,
            currentRite: {
              uid: 19,
              name: "项目投资",
              slots: [
                {
                  index: 0,
                  occupied: true,
                  cardUid: 124,
                  cardSummary: {
                    cardId: 2000352,
                    name: "玛希尔",
                    rare: 2,
                    tier: "铜(2)",
                    tags: { 智慧: 5, 工匠: 1 },
                  },
                },
              ],
            },
          },
          actions: [
            { id: "continue", enabled: true },
            { id: "next_day", enabled: true },
            { id: "execute", enabled: false },
            { id: "cancel", enabled: false },
            { id: "reset", enabled: false },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/scene")) {
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          snapshotVersion: 5,
          scene: { id: "play", phase: "story", modal: "option" },
          instruction: { text: "选择一个选项" },
          elements: [
            {
              elementId: "semantic:option_0",
              role: "toggle",
              text: "选项 A",
              visible: true,
              interactable: true,
            },
            {
              elementId: "semantic:rite_slot_card_0",
              role: "card",
              text: "玛希尔 (rite seat — inspect)",
              visible: true,
              interactable: true,
              preferredOp: "inspect_card",
              actionParams: {
                uid: 124,
                slotIndex: 0,
                cardSummary: {
                  cardId: 2000352,
                  name: "玛希尔",
                  tags: { 智慧: 5, 工匠: 1 },
                },
              },
            },
          ],
          affordances: [
            {
              action: "select",
              targetId: "semantic:option_0",
              enabled: true,
              mapsToOp: "select_event_option",
              parameters: { optionIndex: 0 },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/actions")) {
      const actions = (body as { actions?: GameAction[] })?.actions ?? [];
      return new Response(
        JSON.stringify({
          ok: true,
          results: actions.map((a, i) => ({
            id: a.id ?? `r${i}`,
            op: a.op,
            ok: true,
            detail: "mock",
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const ops = new HttpGameOps({ ...config, gameDryRun: false, gameBaseUrl: "http://mock" });
    const health = await ops.health();
    assert.equal(health.ok, true);
    const state = await ops.getState();
    assert.equal(state.schemaVersion, 1);
    assert.equal(
      state.values?.currentRite?.slots?.[0]?.cardSummary?.tags?.智慧,
      5,
      "filled rite slot should expose runtime card tags in one state read",
    );
    const scene = await ops.observeScene();
    assert.equal(scene.snapshotVersion, 5);
    const riteCard = scene.elements?.find(
      (element) => element.elementId === "semantic:rite_slot_card_0",
    );
    const summary = riteCard?.actionParams?.cardSummary as
      | { tags?: Record<string, number> }
      | undefined;
    assert.equal(
      summary?.tags?.工匠,
      1,
      "rite slot scene element should carry the same card summary",
    );
    const results = await ops.submitActions([{ op: "next_day" }]);
    assert.equal(results[0]?.ok, true);
    assert.ok(
      (state.actions ?? []).some((a) => a.id === "continue"),
      "AI-visible actions should include continue for panel dismiss",
    );
    assert.ok(
      (state.actions ?? []).some((a) => a.id === "next_day"),
      "AI-visible actions should include explicit next_day",
    );
    assert.ok(
      !(state.actions ?? []).some((a) => a.id === "next_round"),
      "AI-visible actions should prefer next_day over legacy next_round",
    );
    assert.ok(calls.some((c) => c.url.includes("/health")));
    assert.ok(calls.some((c) => c.url.includes("/state")));
    assert.ok(calls.some((c) => c.url.includes("/scene")));
    assert.ok(calls.some((c) => c.url.includes("/actions")));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testDailyReviewConfig(): void {
  assert.ok(config.agentReviewIntervalDays >= 1);
  const boundary = createDayBoundary({
    intervalDays: config.agentReviewIntervalDays,
    lastReviewedDay: null,
  });
  assert.equal(boundary.intervalDays, config.agentReviewIntervalDays);
  assert.equal(boundary.phase, "idle");
}

async function main(): Promise<void> {
  testPreflight();
  testGameStateShape();
  testSceneClickContract();
  testDailyReviewConfig();
  await testBootMock();
  await testHttpGameOpsMock();
  console.log("verify-http-contract: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
