/**
 * Replay a filled ReplayDocument against the live game + HUD bubbles.
 * Load a matching save in-game before running.
 *
 * Usage (recommended on Windows/Git Bash):
 *   npm run replay -- --id 20260805-201012-872
 *   npm run replay -- --id 20260805-201012-872 --delay-ms 5000
 */
import { config } from "../src/config.js";
import { HttpGameOps } from "../src/game/HttpGameOps.js";
import type { CardDto, GameAction, GameState } from "../src/game/types.js";
import { argValue, resolveReplayFilePath } from "../src/replay/cliArgs.js";
import { readReplayDocument } from "../src/replay/io.js";
import { isDecisionFilled, type ReplayDocument } from "../src/replay/types.js";

const DEFAULT_DELAY_MS = 5000;
/** Safety only — real stop is option panel / draw phase / idle. */
const DRAIN_SAFETY_MAX = 80;

function asOverlayList(state: GameState): Array<{ id?: string; kind?: string; blocking?: boolean; dismissOp?: string }> {
  const fromValues = state.values?.overlays;
  const top = state.overlays;
  const raw = Array.isArray(fromValues) ? fromValues : Array.isArray(top) ? top : [];
  return raw as Array<{ id?: string; kind?: string; blocking?: boolean; dismissOp?: string }>;
}

function isOptionPanelReady(state: GameState): boolean {
  const actions = state.actions ?? [];
  if (actions.some((a) => a.id === "select_event_option" && a.enabled !== false)) {
    return true;
  }
  const values = state.values ?? {};
  if (values.currentEvent && typeof values.currentEvent === "object") return true;
  if (typeof values.eventOptionCount === "number" && values.eventOptionCount > 0) {
    return true;
  }
  return asOverlayList(state).some(
    (o) => o.id === "option" || o.kind === "story_option" || o.dismissOp === "select_event_option",
  );
}

/** Day rolled into forced Sudan draw / box interaction — settlement chain is done. */
function isDrawPhase(state: GameState): boolean {
  const actions = state.actions ?? [];
  if (actions.some((a) => a.id === "draw_sudan_card" && a.enabled !== false)) {
    return true;
  }
  const guide = state.values?.guide as
    | { active?: boolean; preferredOp?: string | null }
    | undefined;
  if (
    guide?.active &&
    typeof guide.preferredOp === "string" &&
    /draw_sudan|sudan_box|open_sudan/i.test(guide.preferredOp)
  ) {
    return true;
  }
  return asOverlayList(state).some(
    (o) =>
      o.dismissOp === "draw_sudan_card" ||
      o.id === "sudan_box" ||
      o.kind === "sudan_draw",
  );
}

function hasContinueTarget(state: GameState): boolean {
  const overlays = asOverlayList(state);
  if (
    overlays.some(
      (o) =>
        o.blocking === true ||
        o.id === "rite_result" ||
        o.kind === "rite_result" ||
        o.dismissOp === "continue",
    )
  ) {
    return true;
  }
  const riteResult = state.values?.riteResult;
  if (riteResult && typeof riteResult === "object") {
    const rr = riteResult as Record<string, unknown>;
    if (rr.active === true || rr.visible === true) return true;
    if (typeof rr.stage === "string" && rr.stage.length > 0 && rr.stage !== "none") {
      return true;
    }
  }
  const actions = state.actions ?? [];
  return actions.some((a) => a.id === "continue" && a.enabled !== false);
}

type DrainGoal = "option" | "draw_or_idle";

/**
 * Click through rite-result / day-settlement / event-report pages.
 * - option: stop when random-event choice is up
 * - draw_or_idle: stop when Sudan draw phase starts, or settlement truly idle
 */
async function drainSettlement(
  ops: HttpGameOps,
  delayMs: number,
  label: string,
  goal: DrainGoal,
): Promise<"option" | "draw" | "idle" | "cap"> {
  let idleStreak = 0;
  const stepDelay = Math.max(500, Math.min(delayMs, 1200));

  for (let i = 1; i <= DRAIN_SAFETY_MAX; i++) {
    const state = await ops.getState(["summary", "actions", "overlays", "events"]);

    if (goal === "option" && isOptionPanelReady(state)) {
      if (i > 1) console.warn(`  ${label}: option ready after ${i - 1} continue(s)`);
      return "option";
    }
    if (goal === "draw_or_idle" && isDrawPhase(state)) {
      console.warn(`  ${label}: draw phase after ${i - 1} continue(s)`);
      return "draw";
    }
    // Never burn redraws: if draw phase appears while waiting for option, stop.
    if (goal === "option" && isDrawPhase(state) && !isOptionPanelReady(state)) {
      console.warn(`  ${label}: hit draw phase before option`);
      return "draw";
    }

    if (!hasContinueTarget(state)) {
      await sleep(Math.max(800, stepDelay));
      const again = await ops.getState(["summary", "actions", "overlays", "events"]);
      if (goal === "option" && isOptionPanelReady(again)) return "option";
      if (isDrawPhase(again)) return "draw";
      if (!hasContinueTarget(again)) {
        idleStreak++;
        if (goal === "draw_or_idle" && idleStreak >= 2) {
          console.warn(`  ${label}: settlement idle after ${i - 1} continue(s)`);
          return "idle";
        }
        if (goal === "option" && idleStreak >= 3) {
          console.warn(`  ${label}: no continue target and option still inactive`);
          return "idle";
        }
        continue;
      }
      idleStreak = 0;
    } else {
      idleStreak = 0;
    }

    const cont = (await ops.submitActions([{ op: "continue" }]))[0];
    const detail =
      cont?.ok === false
        ? ` -> ${cont.error}${cont.detail ? ` (${cont.detail})` : ""}`
        : cont?.detail
          ? ` -> ${cont.detail}`
          : "";
    console.warn(`  ${label}: continue ${i}${detail}`);

    if (cont?.error === "need_select_event_option") return "option";
    if (cont?.error === "need_draw_sudan_card" || cont?.error === "need_follow_guide") {
      const check = await ops.getState(["summary", "actions", "overlays", "events"]);
      if (isDrawPhase(check) || cont.error === "need_draw_sudan_card") return "draw";
    }
    if (cont?.error === "nothing_to_continue") {
      idleStreak++;
      if (goal === "draw_or_idle" && idleStreak >= 2) return "idle";
    } else {
      idleStreak = 0;
    }

    await sleep(stepDelay);
  }

  console.warn(`  ${label}: hit safety cap ${DRAIN_SAFETY_MAX}`);
  return "cap";
}

/**
 * Recorded place uids (esp. CardSplit gold fragments) are instance-local.
 * Remap to a live hand card with the same catalog id when the uid is gone.
 */
async function resolvePlaceAction(
  ops: HttpGameOps,
  action: GameAction,
): Promise<GameAction> {
  if (action.op !== "place_card_on_rite") return action;
  const cardId = typeof action.cardId === "number" ? action.cardId : undefined;
  const uid = typeof action.uid === "number" ? action.uid : undefined;
  if (cardId === undefined && uid === undefined) return action;

  const state = await ops.getState(["cards", "cards_all"]);
  const topCards = Array.isArray(state.cards) ? (state.cards as CardDto[]) : [];
  const allCards = Array.isArray(state.cardsAll)
    ? (state.cardsAll as CardDto[])
    : Array.isArray(state.values?.cardsAll)
      ? (state.values!.cardsAll as CardDto[])
      : [];
  const cards = topCards.length > 0 ? topCards : allCards;
  const minCount = typeof action.count === "number" ? action.count : 1;

  const byUid =
    uid !== undefined
      ? [...topCards, ...allCards].find((c) => c.uid === uid)
      : undefined;
  if (byUid) return action;

  const id = cardId ?? uid;
  if (id === undefined) return action;

  const pool = [...topCards, ...allCards];
  const candidates = pool.filter((c) => {
    if (c.id !== id) return false;
    const count = typeof c.count === "number" ? Math.max(1, c.count) : 1;
    return count >= minCount;
  });
  if (candidates.length === 0) return action;

  candidates.sort((a, b) => {
    const aHand = a.bag === 0 || a.bag == null ? 1 : 0;
    const bHand = b.bag === 0 || b.bag == null ? 1 : 0;
    if (aHand !== bHand) return bHand - aHand;
    const ac = typeof a.count === "number" ? a.count : 1;
    const bc = typeof b.count === "number" ? b.count : 1;
    return bc - ac;
  });
  const liveUid = candidates[0]?.uid;
  if (typeof liveUid !== "number" || liveUid === uid) return action;

  console.warn(
    `  remap place uid ${uid ?? "?"} -> ${liveUid} (cardId=${id}, need count>=${minCount})`,
  );
  return { ...action, uid: liveUid, cardId: id };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientExchangeError(error: string | null | undefined): boolean {
  return (
    error === "exchange_dropper_not_entered" ||
    error === "exchange_drop_failed" ||
    error === "wizard_opening" ||
    error === "wizard_not_open" ||
    error === "exchange_button_missing" ||
    error === "exchange_ui_settling"
  );
}

function assertTitlesFilled(doc: ReplayDocument): void {
  const empty = doc.steps.filter((s) => !isDecisionFilled(s.decision));
  if (empty.length === 0) return;
  const indexes = empty.map((s) => s.index).slice(0, 10).join(", ");
  throw new Error(
    `${empty.length} step(s) missing decision.title (e.g. index ${indexes}). ` +
      `Run: npm run annotate-replay -- --id ${doc.id} --motive "..."`,
  );
}

async function main(): Promise<void> {
  const filePath = resolveReplayFilePath();
  const delayMs = Math.max(0, Number(argValue("--delay-ms") ?? String(DEFAULT_DELAY_MS)) || DEFAULT_DELAY_MS);
  const doc = readReplayDocument(filePath);
  assertTitlesFilled(doc);

  const ops = new HttpGameOps(config);
  const health = await ops.health();
  if (!health.ok) {
    throw new Error(`Observer health not ok: ${JSON.stringify(health)}`);
  }
  if (health.actions === false) {
    throw new Error("Observer reports actions=false; cannot replay.");
  }
  console.log(`Replaying ${doc.steps.length} steps from ${filePath}`);
  console.log(`Delay between steps: ${delayMs}ms`);
  console.log("Ensure the matching save is already loaded in-game.");

  /** After select_event_option we drain reports until draw; trailing continue steps are no-ops. */
  let postOptionDrained = false;

  for (const step of doc.steps) {
    const stats = step.decision.stats ?? {};
    const decision = {
      step: stats.step ?? step.index + 1,
      title: step.decision.title,
      goal: step.decision.goal || undefined,
      why: step.decision.why || undefined,
      actions: step.decision.actions.length > 0 ? step.decision.actions : undefined,
      thinking: step.decision.thinking || undefined,
      mood: step.decision.mood || undefined,
    };

    console.log(
      `[${step.index + 1}/${doc.steps.length}] bubble="${decision.title}" action=${JSON.stringify(step.action)}`,
    );

    // Board snapshots LLM stats at decision push time — publish stats first.
    await ops
      .publishLlmStats({
        step: stats.step ?? step.index + 1,
        totalTokens: stats.totalTokens,
        prefillTokens: stats.prefillTokens,
        decodeTokens: stats.decodeTokens,
        prefillTokPerSec: stats.prefillTokPerSec,
        decodeTokPerSec: stats.decodeTokPerSec,
        elapsedMs: stats.elapsedMs,
        firstTokenMs: stats.firstTokenMs,
      })
      .catch(() => undefined);

    const pub = await ops.publishDecision(decision);
    if (pub.ok === false) {
      throw new Error(`publishDecision failed at step ${step.index}: ${pub.error ?? "unknown"}`);
    }

    const action = await resolvePlaceAction(ops, step.action);

    // Trailing recorded continues after post-option drain are already handled.
    if (action.op === "continue" && postOptionDrained) {
      console.warn("  skip continue (settlement already drained to draw/idle)");
      if (delayMs > 0 && step.index < doc.steps.length - 1) await sleep(delayMs);
      continue;
    }

    // Random day events need the option panel; drain settlement pages first.
    if (action.op === "select_event_option") {
      const before = await drainSettlement(
        ops,
        delayMs,
        "before select_event_option",
        "option",
      );
      if (before !== "option") {
        console.warn(`  option panel not detected (${before}); attempting select anyway`);
      }
    }

    let result = (await ops.submitActions([action]))[0];

    // Overnight rites: panel may still be open / result modal up — close then retry.
    if (
      action.op === "next_day" &&
      result &&
      result.ok === false &&
      (result.error === "rite_panel_open" ||
        result.error === "blocked_by_modal" ||
        result.error === "rite_result_advance_failed")
    ) {
      for (let retry = 1; retry <= 5; retry++) {
        console.warn(
          `  next_day retry ${retry}/5 after ${result.error}; cancel/continue then retry`,
        );
        if (result.error === "rite_panel_open") {
          await ops.submitActions([{ op: "cancel" }]).catch(() => undefined);
        } else {
          await ops.submitActions([{ op: "continue" }]).catch(() => undefined);
        }
        await sleep(Math.max(800, Math.min(delayMs, 2000)));
        result = (await ops.submitActions([action]))[0];
        if (!result || result.ok !== false) break;
        if (
          result.error !== "rite_panel_open" &&
          result.error !== "blocked_by_modal" &&
          result.error !== "rite_result_advance_failed"
        ) {
          break;
        }
      }
    }

    // Option panel still opening / more settlement pages left.
    if (
      action.op === "select_event_option" &&
      result &&
      result.ok === false &&
      result.error === "panel_inactive"
    ) {
      for (let retry = 1; retry <= 3; retry++) {
        console.warn(`  select_event_option retry ${retry}/3 after panel_inactive`);
        await drainSettlement(ops, delayMs, `select retry ${retry}`, "option");
        result = (await ops.submitActions([action]))[0];
        if (!result || result.ok !== false) break;
        if (result.error !== "panel_inactive") break;
      }
    }

    // After the random event, keep clicking reports until Sudan draw phase (or idle).
    if (action.op === "select_event_option" && result && result.ok !== false) {
      await drainSettlement(ops, delayMs, "after select_event_option", "draw_or_idle");
      postOptionDrained = true;
    }

    // Consecutive sudan exchanges need an extra frame for Wizard choice→dropper.
    if (
      action.op === "exchange_sudan_card" &&
      result &&
      result.ok === false &&
      isTransientExchangeError(result.error)
    ) {
      for (let retry = 1; retry <= 3; retry++) {
        console.warn(
          `  exchange retry ${retry}/3 after ${result.error}${result.detail ? ` (${result.detail})` : ""}`,
        );
        await sleep(delayMs);
        result = (await ops.submitActions([action]))[0];
        if (!result || result.ok !== false) break;
        if (!isTransientExchangeError(result.error)) break;
      }
    }

    // Close box may need an extra frame after tip click.
    if (
      action.op === "close_sudan_box" &&
      result &&
      result.ok === false &&
      result.error === "sudan_box_still_open"
    ) {
      for (let retry = 1; retry <= 3; retry++) {
        console.warn(`  close_sudan_box retry ${retry}/3 after sudan_box_still_open`);
        await sleep(delayMs);
        result = (await ops.submitActions([action]))[0];
        if (!result || result.ok !== false) break;
        if (result.error !== "sudan_box_still_open") break;
      }
    }

    // If prev_round is blocked, close the sudan box first — never continue
    // (guide preferredOp=draw_sudan_card burns remaining redraws).
    if (
      action.op === "prev_round" &&
      result &&
      result.ok === false &&
      (result.error === "blocked_by_modal" || result.error === "guide_dismissing")
    ) {
      for (let retry = 1; retry <= 4; retry++) {
        console.warn(
          `  prev_round retry ${retry}/4 after ${result.error}; closing sudan box first`,
        );
        await ops.submitActions([{ op: "close_sudan_box" }]).catch(() => undefined);
        await sleep(delayMs);
        result = (await ops.submitActions([action]))[0];
        if (!result || result.ok !== false) break;
        if (result.error !== "blocked_by_modal" && result.error !== "guide_dismissing") break;
      }
    }

    // Guide-dismiss continue is often redundant: after open_sudan_box the Wizard
    // choice menu is already up, and exchange_sudan_card selects the choice itself.
    const softContinue =
      action.op === "continue" &&
      !!result &&
      result.ok === false &&
      (result.error === "nothing_to_continue" ||
        result.error === "need_follow_guide" ||
        result.error === "need_wizard_choice" ||
        result.error === "need_draw_sudan_card" ||
        result.error === "no_effect");
    if (!result || (result.ok === false && !softContinue)) {
      throw new Error(
        `submitActions failed at step ${step.index}: ${JSON.stringify(result)}`,
      );
    }
    if (softContinue) {
      console.warn(
        `  soft-continue: ${result.error}${result.detail ? ` (${result.detail})` : ""}`,
      );
    } else if (result.error && result.error !== "no_effect") {
      console.warn(`  warn: ${result.error}${result.detail ? ` (${result.detail})` : ""}`);
    }

    if (delayMs > 0 && step.index < doc.steps.length - 1) {
      await sleep(delayMs);
    }
  }

  // If the script ended without a select_event_option drain, still clear leftover reports.
  if (!postOptionDrained) {
    await drainSettlement(ops, delayMs, "end-of-replay", "draw_or_idle");
  }

  console.log("Replay finished.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
