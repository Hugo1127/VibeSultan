import type { GameOps } from "../game/GameOps.js";
import type { GameAction, GameState } from "../game/types.js";
import { screenId } from "../agent/tools.js";

export interface BootResult {
  ok: boolean;
  screen?: string;
  phase?: string;
  error?: string;
  steps: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function submit(ops: GameOps, actions: GameAction[]): Promise<{ ok: boolean; detail: string }> {
  const results = await ops.submitActions(actions);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    return {
      ok: false,
      detail: failed.map((f) => `${f.op}:${f.error}`).join(","),
    };
  }
  return { ok: true, detail: results.map((r) => r.op ?? "?").join(",") };
}

function phaseOf(state: GameState): string {
  return (state.screen?.phase ?? state.screen?.id ?? "unknown").toLowerCase();
}

function enabledActionIds(state: GameState): Set<string> {
  const set = new Set<string>();
  for (const a of state.actions ?? []) {
    if (a?.id && a.enabled !== false) set.add(a.id);
  }
  return set;
}

function isBootish(state: GameState): boolean {
  const id = (screenId(state) ?? "").toLowerCase();
  const phase = phaseOf(state);
  return (
    id === "startscene" ||
    phase === "boot" ||
    phase === "main_menu" ||
    id === "main_menu"
  );
}

/**
 * Boot only enters a game. All UI interpretation and tutorial interaction belongs
 * to the observe_scene agent loop.
 */
export async function bootIntoPlay(opts: {
  ops: GameOps;
  timeoutMs: number;
  pollMs?: number;
  startNewGame?: boolean;
}): Promise<BootResult> {
  const { ops, timeoutMs, startNewGame = true } = opts;
  const pollMs = opts.pollMs ?? 800;
  const steps: string[] = [];
  const deadline = Date.now() + timeoutMs;
  let entered = false;

  while (Date.now() < deadline) {
    const state = await ops.getState([
      "values",
      "actions",
      "diagnostics",
    ]);
    const id = screenId(state);
    const phase = phaseOf(state);
    const initDone = Boolean(state.values?.initDone);
    const inGame = Boolean(state.values?.inGame);
    const enabled = enabledActionIds(state);
    steps.push(
      `poll screen=${id} phase=${phase} initDone=${initDone} inGame=${inGame} actions=${[...enabled].join("|")}`,
    );

    if (state.terminal || (inGame && !isBootish(state))) {
      return { ok: true, screen: id, phase, steps };
    }

    // InitDone may stay false on StartScene; do not block forever — load ops still work.
    if (!entered && isBootish(state)) {
      if (!startNewGame && enabled.has("continue_game") && initDone) {
        const r = await submit(ops, [{ op: "continue_game" }]);
        steps.push(`continue_game:${r.ok ? "ok" : r.detail}`);
        entered = true;
        await sleep(pollMs * 2);
        continue;
      }
      if (startNewGame && enabled.has("start_new_game")) {
        const r = await submit(ops, [{ op: "start_new_game", initId: 1 }]);
        steps.push(`start_new_game:${r.ok ? "ok" : r.detail}`);
        entered = r.ok;
        await sleep(pollMs * 2);
        continue;
      }
      if (!initDone) {
        await sleep(pollMs);
        continue;
      }
    }

    // A non-boot scene with live actions is already suitable for semantic observation.
    if (!isBootish(state) && enabled.size > 0) {
      return { ok: true, screen: id, phase, steps };
    }

    await sleep(pollMs);
  }

  return { ok: false, error: "boot_timeout", steps };
}
