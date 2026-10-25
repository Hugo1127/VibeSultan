import { config } from "./config.js";
import { HttpGameOps } from "./game/HttpGameOps.js";
import { assertObserverHasInterop } from "./game/interopGuard.js";
import { createLlmClient } from "./llm/client.js";
import { runAgentLoop } from "./agent/loop.js";
import { AgentLogger } from "./log/AgentLogger.js";
import { bootIntoPlay } from "./memory/boot.js";
import { emptyDayReviewCursor } from "./memory/dayReview.js";
import { resetRunScopedState } from "./memory/newGameReset.js";
import {
  parseMemoryCliArgs,
  resolveMemorySession,
  updateMemorySessionMeta,
} from "./memory/session.js";

async function main(): Promise<void> {
  const log = AgentLogger.create({
    logRoot: config.agentLogDir,
    maxToolChars: config.agentLogMaxChars,
  });
  const cli = parseMemoryCliArgs(process.argv.slice(2));
  const session = await resolveMemorySession(config.agentMemoryDir, cli);

  log.info("run_start", {
    runId: log.runId,
    envPath: config.envPath,
    model: config.openaiModel,
    gameBaseUrl: config.gameBaseUrl,
    maxSteps: config.agentMaxSteps,
    memorySession: session.id,
  });

  const ops = new HttpGameOps(config);
  const health = await ops.health();
  log.info("game_health", health as unknown as Record<string, unknown>);
  if (!health.ok) throw new Error(`Game health not ok: ${JSON.stringify(health)}`);
  assertObserverHasInterop(health, config.gameBaseUrl);
  const gameFingerprint =
    typeof (health as { fingerprint?: string }).fingerprint === "string"
      ? (health as { fingerprint?: string }).fingerprint
      : null;

  const boot = await bootIntoPlay({
    ops,
    timeoutMs: config.agentBootTimeoutMs,
    startNewGame: true,
  });
  log.info("boot", boot as unknown as Record<string, unknown>);
  if (!boot.ok) throw new Error(`Boot failed: ${boot.error}`);

  const reset = resetRunScopedState({
    sessionDir: session.dir,
    runId: log.runId,
    gameIndex: 1,
  });
  if (!reset.ok) throw new Error(`New game reset failed: ${reset.error}`);
  log.info("new_game_reset", reset as unknown as Record<string, unknown>);

  // Fresh run: wipe day-review cursor so early days are not suppressed by old meta.
  updateMemorySessionMeta(session.dir, {
    lastReviewedDay: null,
    activeHypothesisId: null,
  });

  const goal =
    process.argv.filter((a) => !a.startsWith("--")).slice(2).join(" ").trim() ||
    "你在《苏丹的游戏》中。用 get_state 观察卡牌/事件/仪式状态，再 submit_actions 推进。终局时用中文总结。";

  log.writeText("goal.txt", goal);
  const client = createLlmClient(config);

  // Resume day-review cursor from session meta (do not wipe mid-game progress).
  // After startNewGame boot we already cleared meta; keep nulls for a fresh run.
  const reviewCursor = emptyDayReviewCursor(1);
  reviewCursor.lastReviewedDay = null;
  reviewCursor.activeHypothesisId = null;

  const result = await runAgentLoop({
    client,
    ops,
    cfg: config,
    userGoal: goal,
    log,
    memoryDir: session.dir,
    gameFingerprint,
    reviewCursor,
    onReviewCursor: (cursor) => {
      updateMemorySessionMeta(session.dir, {
        lastReviewedDay: cursor.lastReviewedDay,
        activeHypothesisId: cursor.activeHypothesisId,
      });
    },
  });

  log.writeText("final.txt", result.finalText);
  log.writeSummary({
    runId: log.runId,
    ok: true,
    stopReason: result.stopReason,
    traceCount: result.decisionTraces.length,
    runDir: log.runDir,
  });

  console.log("\n=== Agent final ===\n");
  console.log(result.finalText);
  console.log(`\nLogs: ${log.runDir}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
