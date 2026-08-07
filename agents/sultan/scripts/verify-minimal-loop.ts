/**
 * No-LLM live/minimal smoke against Observer.
 * Prefer deterministic enabled-action policy:
 * continue / select_event_option(0) / place first card into first empty slot /
 * start_rite when ready / else next_round.
 *
 * Usage:
 *   npx tsx agents/sultan/scripts/verify-minimal-loop.ts
 *   npx tsx agents/sultan/scripts/verify-minimal-loop.ts --mock
 */
import assert from "node:assert/strict";
import { bootIntoPlay } from "../src/memory/boot.js";
import { preflightAction } from "../src/agent/tools.js";
import type {
  ActionResult,
  GameAction,
  GameState,
  SceneSnapshot,
} from "../src/game/types.js";
import { HttpGameOps } from "../src/game/HttpGameOps.js";
import { config } from "../src/config.js";
import {
  createDayBoundary,
  forceReviewBeforeAllocation,
  markReviewed,
  tickDayBoundary,
} from "../src/memory/dayBoundary.js";

type Card = { uid?: number };
type Rite = {
  uid?: number;
  canConfirm?: boolean;
  isCurrent?: boolean;
  slots?: Array<{ index?: number; occupied?: boolean; cardUid?: number | null }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function enabled(state: GameState): Set<string> {
  const set = new Set<string>();
  for (const a of state.actions ?? []) {
    if (a?.id && a.enabled !== false) set.add(a.id);
  }
  return set;
}

function cardsOf(state: GameState): Card[] {
  const raw = (state.cards ?? state.values?.cards) as unknown;
  return Array.isArray(raw) ? (raw as Card[]) : [];
}

function ritesOf(state: GameState): Rite[] {
  const raw = (state.rites ?? state.values?.rites) as unknown;
  return Array.isArray(raw) ? (raw as Rite[]) : [];
}

function actionKey(action: GameAction): string {
  return `${action.op}|${action.elementId ?? ""}|${action.optionIndex ?? ""}`;
}

function pickAction(
  state: GameState,
  scene?: SceneSnapshot,
  rejected: Set<string> = new Set(),
): GameAction | null {
  const sceneAffordances = [...(scene?.affordances ?? [])].sort((a, b) => {
    if (a.action === "click" && b.action !== "click") return 1;
    if (a.action !== "click" && b.action === "click") return -1;
    const aBox = /sudanbox|metal box/i.test(a.label ?? "") ? 0 : 1;
    const bBox = /sudanbox|metal box/i.test(b.label ?? "") ? 0 : 1;
    return aBox - bBox;
  });
  for (const affordance of sceneAffordances) {
    if (affordance.enabled === false) continue;
    const params = affordance.parameters ?? {};
    if (affordance.action === "click" && affordance.targetId) {
      const action: GameAction = {
        op: "click_element",
        elementId: affordance.targetId,
        snapshotVersion: scene!.snapshotVersion,
      };
      if (!rejected.has(actionKey(action))) return action;
      continue;
    }
    const op = affordance.mapsToOp;
    if (!op) continue;
    if (op === "select_event_option" && typeof params.optionIndex === "number") {
      const action: GameAction = { op, optionIndex: params.optionIndex };
      if (!rejected.has(actionKey(action))) return action;
      continue;
    }
    if (
      [
        "continue",
        "execute",
        "cancel",
        "reset",
        "draw_sudan_card",
        "start_rite",
        "next_round",
        "select_difficulty",
        "continue_game",
      ].includes(op)
    ) {
      const action: GameAction = { op };
      if (!rejected.has(actionKey(action))) return action;
      continue;
    }
    if (op === "start_new_game") {
      const action: GameAction = { op, initId: 1 };
      if (!rejected.has(actionKey(action))) return action;
    }
  }

  if (scene && rejected.size > 0) return null;

  const ops = enabled(state);
  const phase = (state.screen?.phase ?? "").toLowerCase();
  const blocking =
    Boolean(state.values?.blockingOverlay) ||
    phase === "prompt" ||
    phase === "change_name" ||
    phase === "wizard";
  if (blocking && ops.has("continue")) return { op: "continue" };

  if (ops.has("select_difficulty")) return { op: "select_difficulty", index: 0 };
  if (ops.has("select_event_option")) return { op: "select_event_option", optionIndex: 0 };
  if (ops.has("execute")) return { op: "execute" };
  if (ops.has("start_rite")) return { op: "execute" };

  if (ops.has("place_card_on_rite")) {
    const cards = cardsOf(state);
    const rites = ritesOf(state);
    const current = rites.find((r) => r.isCurrent) ?? rites[0];
    const slot = current?.slots?.find((s) => !s.occupied) ?? current?.slots?.[0];
    const card =
      cards.find((c) => (c as { inHand?: boolean }).inHand) ??
      cards[0];
    if (card?.uid != null && slot?.index != null) {
      return { op: "place_card_on_rite", uid: card.uid, slotIndex: slot.index };
    }
  }

  // Prefer advancing the day when no rite UI is available.
  if (
    ops.has("continue") &&
    !ops.has("place_card_on_rite") &&
    !ops.has("execute") &&
    !ops.has("start_rite")
  ) {
    return { op: "continue" };
  }

  if (ops.has("continue")) return { op: "continue" };

  if (ops.has("select_card")) {
    const card =
      cardsOf(state).find((c) => (c as { inHand?: boolean }).inHand) ??
      cardsOf(state)[0];
    if (card?.uid != null) return { op: "select_card", uid: card.uid };
  }

  if (ops.has("next_day")) return { op: "next_day" };
  if (ops.has("next_round")) return { op: "next_day" };
  if (ops.has("continue_game")) return { op: "continue_game" };
  if (ops.has("start_new_game")) return { op: "start_new_game", initId: 1 };
  return null;
}

function stateFingerprint(state: GameState): string {
  const day = state.values?.day ?? "?";
  const phase = state.screen?.phase ?? "?";
  const hand = state.values?.handCount ?? "?";
  const rite = state.values?.riteCount ?? "?";
  const events = state.values?.eventOptionCount ?? "?";
  const actions = [...enabled(state)].sort().join(",");
  return `day=${day}|phase=${phase}|hand=${hand}|rite=${rite}|events=${events}|actions=${actions}`;
}

async function runMock(): Promise<void> {
  const frames: GameState[] = [
    {
      schemaVersion: 1,
      game: "sultan",
      screen: { id: "startscene", phase: "boot" },
      terminal: false,
      values: { initDone: true, inGame: false, handCount: 0, riteCount: 0 },
      actions: [
        { id: "start_new_game", enabled: true },
        { id: "continue", enabled: true },
      ],
    },
    {
      schemaVersion: 1,
      game: "sultan",
      screen: { id: "story", phase: "story" },
      terminal: false,
      values: { initDone: true, inGame: true, day: 1, eventOptionCount: 2, handCount: 2, riteCount: 1 },
      events: [
        { index: 0, selected: false },
        { index: 1, selected: false },
      ],
      actions: [
        { id: "select_event_option", enabled: true },
        { id: "continue", enabled: true },
      ],
    },
    {
      schemaVersion: 1,
      game: "sultan",
      screen: { id: "play", phase: "guide" },
      terminal: false,
      values: {
        initDone: true,
        inGame: true,
        day: 1,
        guide: {
          active: true,
          type: "CHANGE_SUDAN_CARD",
          text: "点击金属匣抽取苏丹卡",
          preferredOp: "draw_sudan_card",
        },
      },
      actions: [{ id: "draw_sudan_card", enabled: true }],
    },
    {
      schemaVersion: 1,
      game: "sultan",
      screen: { id: "play", phase: "rite" },
      terminal: false,
      values: { initDone: true, inGame: true, day: 1, handCount: 2, riteCount: 1 },
      cards: [{ uid: 11 }, { uid: 12 }],
      rites: [
        {
          uid: 99,
          isCurrent: true,
          canConfirm: false,
          slots: [{ index: 0, occupied: false, cardUid: null }],
        },
      ],
      actions: [
        { id: "place_card_on_rite", enabled: true },
        { id: "select_card", enabled: true },
        { id: "continue", enabled: true },
      ],
    },
    {
      schemaVersion: 1,
      game: "sultan",
      screen: { id: "play", phase: "rite" },
      terminal: false,
      values: { initDone: true, inGame: true, day: 1, handCount: 1, riteCount: 1 },
      cards: [{ uid: 12 }],
      rites: [
        {
          uid: 99,
          isCurrent: true,
          canConfirm: true,
          slots: [{ index: 0, occupied: true, cardUid: 11 }],
        },
      ],
      actions: [
        { id: "execute", enabled: true },
        { id: "continue", enabled: true },
      ],
    },
    {
      schemaVersion: 1,
      game: "sultan",
      screen: { id: "play", phase: "play" },
      terminal: true,
      values: { initDone: true, inGame: true, day: 2, terminal: true },
      actions: [{ id: "noop", enabled: true }],
    },
  ];

  let idx = 0;
  const ops = {
    async getState(): Promise<GameState> {
      return frames[Math.min(idx, frames.length - 1)]!;
    },
    async observeScene(): Promise<SceneSnapshot> {
      const state = frames[Math.min(idx, frames.length - 1)]!;
      const actions = (state.actions ?? []).filter((a) => a.enabled !== false);
      return {
        snapshotVersion: idx + 1,
        scene: {
          id: state.screen?.id,
          phase: state.screen?.phase,
          modal: state.values?.guide ? "begin_guide" : undefined,
          blocking: Boolean(state.values?.guide),
        },
        instruction: state.values?.guide
          ? {
              source: "begin_guide",
              text: state.values.guide.text,
              preferredOp: state.values.guide.preferredOp,
            }
          : undefined,
        affordances: actions
          .filter((a) => a.id !== "noop")
          .map((a) => {
            const option = a.id === "select_event_option";
            return {
              action: option ? "select" : a.id,
              targetId: `semantic:${a.id}`,
              enabled: true,
              mapsToOp: a.id,
              parameters: option ? { optionIndex: 0 } : undefined,
            };
          }),
      };
    },
    async submitActions(actions: GameAction[]): Promise<ActionResult[]> {
      for (const a of actions) {
        const err = preflightAction(a, frames[Math.min(idx, frames.length - 1)]);
        assert.equal(err, null, `preflight ${a.op}: ${err}`);
      }
      idx = Math.min(idx + 1, frames.length - 1);
      return actions.map((a) => ({ op: a.op, ok: true, detail: "mock" }));
    },
  };

  const boot = await bootIntoPlay({ ops: ops as never, timeoutMs: 5000, pollMs: 1 });
  assert.equal(boot.ok, true, `boot failed: ${boot.error} ${boot.steps.join(" > ")}`);

  let okCount = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const state = await ops.getState();
    seen.add(stateFingerprint(state));
    if (state.terminal) break;
    const scene = await ops.observeScene();
    const action = pickAction(state, scene);
    assert.ok(action, "expected deterministic action");
    const results = await ops.submitActions([action]);
    assert.equal(results[0]?.ok, true);
    okCount += 1;
  }

  assert.ok(okCount >= 4, `expected >=4 ok actions, got ${okCount}`);
  assert.ok(seen.size >= 2, "expected observable state change");
  console.log("verify-minimal-loop mock ok", { okCount, fingerprints: [...seen] });
}

async function runLive(): Promise<void> {
  const ops = new HttpGameOps({ ...config, gameDryRun: false });
  const health = await ops.health();
  assert.equal(health.ok, true, "health not ok; is Steam game + SultanObserver running?");

  const boot = await bootIntoPlay({ ops, timeoutMs: 120_000, pollMs: 1000, startNewGame: true });
  assert.equal(boot.ok, true, `boot failed: ${boot.error}\n${boot.steps.join("\n")}`);

  let okCount = 0;
  const fingerprints: string[] = [];
  let lastFp = "";
  const rejectedActions = new Set<string>();

  for (let i = 0; i < 12 && okCount < 2; i++) {
    const scene = await ops.observeScene();
    const state = await ops.getState([
      "values",
      "cards",
      "rites",
      "events",
      "actions",
      "diagnostics",
    ]);
    const fp = stateFingerprint(state);
    fingerprints.push(fp);
    const phase = (state.screen?.phase ?? "").toLowerCase();
    // Difficulty / boot UI can briefly look terminal; keep going while we have playable ops.
    const canProgress =
      enabled(state).has("select_difficulty") ||
      enabled(state).has("select_event_option") ||
      enabled(state).has("place_card_on_rite") ||
      enabled(state).has("start_rite") ||
      enabled(state).has("execute") ||
      enabled(state).has("next_round") ||
      enabled(state).has("continue") ||
      enabled(state).has("reset") ||
      phase === "difficulty" ||
      phase === "boot" ||
      phase === "story" ||
      phase === "rite" ||
      phase === "play";
    if (state.terminal && !canProgress) break;

    const action = pickAction(state, scene, rejectedActions);
    if (!action) {
      await sleep(800);
      continue;
    }
    const err = preflightAction(action, state);
    assert.equal(err, null, `preflight ${JSON.stringify(action)} => ${err}`);

    const results = await ops.submitActions([action]);
    if (results[0]?.ok) {
      const sceneAfter = await ops.observeScene();
      const actionResult = results[0];
      if (actionResult.result === "no_effect") {
        rejectedActions.add(actionKey(action));
        console.warn("action had no effect; reobserving and choosing another affordance", action);
        await sleep(300);
        continue;
      }
      okCount += 1;
      rejectedActions.clear();
      assert.ok(
        sceneAfter.snapshotVersion >= scene.snapshotVersion,
        "scene version must not move backwards",
      );
      const after = await ops.getState(["values", "actions", "cards", "rites", "events"]);
      const afterFp = stateFingerprint(after);
      // Some ops (select_card) may not change compact fingerprint; still count as ok.
      if (afterFp !== lastFp) {
        lastFp = afterFp;
      }
    } else {
      rejectedActions.add(actionKey(action));
      console.warn("action failed", results[0]);
    }
    await sleep(900);
  }

  assert.ok(okCount >= 2, `expected >=2 changed actions, got ${okCount}. fps=${fingerprints.join(" || ")}`);
  console.log("verify-minimal-loop live ok", { okCount, bootSteps: boot.steps.length, fingerprints });
}

function runMockDayReviewGate(): void {
  // Simulate: continue day1 → pending_async/rite_result drain → day2 stable → review
  // → only then allow draw_sudan_card.
  let boundary = createDayBoundary({ intervalDays: 1 });
  const day1: GameState = {
    screen: { id: "play", phase: "play" },
    values: { day: 1, blockingOverlay: false },
    actions: [{ id: "continue", enabled: true, paramsHint: { resolvesTo: "next_day" } }],
  };
  const pending: GameState = {
    screen: { id: "play", phase: "play" },
    values: { day: 1, blockingOverlay: false },
    actions: [{ id: "continue", enabled: false }],
  };
  let tick = tickDayBoundary(boundary, {
    submittedOps: ["continue"],
    stateBefore: day1,
    stateAfter: pending,
    results: [{ ok: true, op: "continue", detail: "pending_async" }],
  });
  assert.equal(tick.shouldReview, false);
  boundary = tick.boundary;

  const rite: GameState = {
    screen: { id: "rite_result", phase: "rite_result" },
    values: { day: 2, blockingOverlay: true },
    actions: [{ id: "continue", enabled: true }],
  };
  tick = tickDayBoundary(boundary, {
    submittedOps: ["continue"],
    stateBefore: pending,
    stateAfter: rite,
    results: [{ ok: true, op: "continue", detail: "continue -> rite_result_next" }],
  });
  assert.equal(tick.shouldReview, false, "must finish feedback before review");
  boundary = tick.boundary;

  const day2: GameState = {
    screen: { id: "play", phase: "play" },
    values: { day: 2, blockingOverlay: false },
    actions: [{ id: "continue", enabled: true, paramsHint: { resolvesTo: "next_day" } }],
  };
  tick = tickDayBoundary(boundary, {
    submittedOps: [],
    stateBefore: rite,
    stateAfter: day2,
    results: [],
  });
  tick = tickDayBoundary(tick.boundary, {
    submittedOps: [],
    stateBefore: day2,
    stateAfter: day2,
    results: [],
  });
  assert.equal(tick.shouldReview, true);
  assert.equal(tick.reviewedDayWindow, 1);
  boundary = markReviewed(tick.boundary, 1);

  const sudan: GameState = {
    screen: { id: "sudan_draw", phase: "sudan_draw" },
    values: { day: 2, blockingOverlay: false },
    actions: [{ id: "draw_sudan_card", enabled: true }],
  };
  const forced = forceReviewBeforeAllocation(boundary, sudan);
  assert.equal(forced.shouldReview, false, "already reviewed; allocation may proceed");
  assert.equal(config.agentReviewIntervalDays >= 1, true);
}

async function main(): Promise<void> {
  const mock = process.argv.includes("--mock");
  if (mock) {
    runMockDayReviewGate();
    await runMock();
  } else await runLive();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
