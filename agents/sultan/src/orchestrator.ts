import fs from "node:fs";
import path from "node:path";
import asciichart from "asciichart";
import {
  ExperienceStore,
  HypothesisStore,
  TipStore,
  computeBestSoFar,
  type Outcome,
} from "@vibesultan/agent-learning-core";
import { config } from "./config.js";
import { runAgentLoop } from "./agent/loop.js";
import { HttpGameOps } from "./game/HttpGameOps.js";
import type { GameOps } from "./game/GameOps.js";
import { createLlmClient } from "./llm/client.js";
import { AgentLogger } from "./log/AgentLogger.js";
import { bootIntoPlay } from "./memory/boot.js";
import {
  emptyDayReviewCursor,
  type DayReviewCursor,
} from "./memory/dayReview.js";
import {
  buildMemoryInjection,
  classifyOutcome,
  extractMetrics,
  filterPlaybookHypotheses,
  filterPlaybookTips,
  formatEarlyCurvePoint,
  selectLastEarlySnapshotPerGame,
} from "./memory/sultanAdapter.js";
import {
  loadBestSkillInjection,
  refreshSkillPlaybook,
} from "./memory/skillPlaybook.js";
import {
  parseMemoryCliArgs,
  resolveMemorySession,
  updateMemorySessionMeta,
  type ResolvedMemorySession,
} from "./memory/session.js";
import { resetRunScopedState } from "./memory/newGameReset.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function appendOutcome(sessionDir: string, outcome: Outcome): void {
  const p = path.join(sessionDir, "outcomes.jsonl");
  fs.appendFileSync(p, JSON.stringify(outcome) + "\n", "utf8");
}

function loadOutcomes(sessionDir: string): Outcome[] {
  const p = path.join(sessionDir, "outcomes.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Outcome);
}

function printCurve(outcomes: Outcome[]): void {
  if (!config.agentTerminalCurve || outcomes.length === 0) return;
  // One point per game: last early-eligible daily snapshot. Legacy rows without
  // earlyEligible/earlyScore are ignored (no rewrite of historical files).
  const points = selectLastEarlySnapshotPerGame(outcomes);
  if (points.length === 0) {
    console.log("[early-curve] no early-eligible daily snapshots yet");
    return;
  }
  const actual = points.map((p) => p.earlyScore);
  const best = computeBestSoFar(actual).filter((v): v is number => typeof v === "number");
  const latest = points[points.length - 1];
  console.log(
    `[early-curve] games=${points.length} latest=${formatEarlyCurvePoint(latest)}`,
  );
  console.log("actual earlyScore (per game, last non-terminal day):");
  console.log(
    asciichart.plot(actual, {
      height: config.agentTerminalCurveHeight,
    }),
  );
  if (best.length > 0) {
    console.log("best-so-far earlyScore:");
    console.log(
      asciichart.plot(best, {
        height: config.agentTerminalCurveHeight,
      }),
    );
  }
}

async function playOneGame(opts: {
  client: ReturnType<typeof createLlmClient>;
  ops: GameOps;
  memoryContext: string;
  userGoal: string;
  memoryDir: string;
  gameFingerprint?: string | null;
  gameIndex: number;
  reviewCursor: DayReviewCursor;
  onReviewCursor?: (cursor: DayReviewCursor) => void;
}): Promise<{
  log: AgentLogger;
  finalText: string;
  stopReason: string;
  endState: unknown;
  reviewCursor?: DayReviewCursor;
  dailyReviewCount?: number;
}> {
  const log = AgentLogger.create({
    logRoot: config.agentLogDir,
    maxToolChars: config.agentLogMaxChars,
  });

  log.info("game_start", {
    mode: "explore",
    reviewIntervalDays: config.agentReviewIntervalDays,
    lastReviewedDay: opts.reviewCursor.lastReviewedDay,
    activeHypothesisId: opts.reviewCursor.activeHypothesisId,
  });

  const result = await runAgentLoop({
    client: opts.client,
    ops: opts.ops,
    cfg: config,
    userGoal: opts.userGoal,
    log,
    memoryContext: opts.memoryContext,
    validateMode: false,
    memoryDir: opts.memoryDir,
    gameFingerprint: opts.gameFingerprint,
    gameIndex: opts.gameIndex,
    reviewCursor: opts.reviewCursor,
    onReviewCursor: opts.onReviewCursor,
  });

  let endState: unknown = null;
  try {
    endState = await opts.ops.getState(["full"]);
  } catch {
    endState = null;
  }

  log.writeSummary({
    runId: log.runId,
    mode: "explore",
    stopReason: result.stopReason,
    final: result.finalText,
    traceCount: result.decisionTraces.length,
    dailyReviewCount: result.dailyReviewCount ?? 0,
  });

  return {
    log,
    finalText: result.finalText,
    stopReason: result.stopReason,
    endState,
    reviewCursor: result.reviewCursor,
    dailyReviewCount: result.dailyReviewCount,
  };
}

/**
 * One autoplay game: boot once, run a single agent loop with in-run daily
 * reviews (settlement drain → pre-allocation review → same-game resume).
 * No second validate boot.
 */
async function runGameWithDailyReview(opts: {
  session: ResolvedMemorySession;
  client: ReturnType<typeof createLlmClient>;
  ops: GameOps;
  gameIndex: number;
  gameFingerprint?: string | null;
}): Promise<void> {
  const hypothesisStore = new HypothesisStore(opts.session.dir);
  const tipStore = new TipStore(opts.session.dir);
  new ExperienceStore(opts.session.dir);

  const playbookParts: string[] = [];
  if (config.agentSkilloptInjectBest) {
    const skill = loadBestSkillInjection(
      opts.session.dir,
      Math.floor(config.agentHypothesisBudgetChars * 0.55),
    );
    if (skill) playbookParts.push(skill);
  }
  playbookParts.push(
    buildMemoryInjection(
      filterPlaybookHypotheses(
        hypothesisStore.list().map((h) => ({
          claim: h.claim,
          constraints: h.constraints,
          status: h.status,
        })),
      ),
      filterPlaybookTips(
        tipStore.list().map((t) => ({ title: t.title, body: t.body, status: t.status })),
      ),
      config.agentHypothesisBudgetChars,
    ),
  );
  const memoryContext = playbookParts.join("\n\n");

  const boot = await bootIntoPlay({
    ops: opts.ops,
    timeoutMs: config.agentBootTimeoutMs,
    startNewGame: true,
  });
  if (!boot.ok) {
    const tail = (boot.steps ?? []).slice(-12).join(" | ");
    throw new Error(`boot failed: ${boot.error}${tail ? ` :: ${tail}` : ""}`);
  }

  const reset = resetRunScopedState({
    sessionDir: opts.session.dir,
    runId: `game-${opts.gameIndex}`,
    gameIndex: opts.gameIndex,
  });
  if (!reset.ok) {
    throw new Error(`new game reset failed: ${reset.error}`);
  }

  // New autoplay game resets the day-review cursor (hypothesis/tip history kept).
  // Mid-game resume should use `npm start -- --memory-session <id>` which loads meta.
  let reviewCursor = emptyDayReviewCursor(opts.gameIndex);
  updateMemorySessionMeta(opts.session.dir, {
    lastReviewedDay: null,
    activeHypothesisId: null,
  });

  const explore = await playOneGame({
    client: opts.client,
    ops: opts.ops,
    memoryContext,
    userGoal:
      "你在《苏丹的游戏》中。遵循行动链推进；过天后先处理结算反馈。宿主会在下一天分配前同步复盘并注入记忆，然后继续同一局。终局时用中文总结。",
    memoryDir: opts.session.dir,
    gameFingerprint: opts.gameFingerprint,
    gameIndex: opts.gameIndex,
    reviewCursor,
    onReviewCursor: (cursor) => {
      reviewCursor = cursor;
      console.log(
        `[daily-review] lastReviewedDay=${cursor.lastReviewedDay} active=${cursor.activeHypothesisId ?? "none"}`,
      );
    },
  });

  if (explore.reviewCursor) reviewCursor = explore.reviewCursor;

  // Whole-game terminal record is diagnostic only; early-game ranking uses :dayN rows.
  const metrics = extractMetrics(explore.endState);
  const outcomeClass = classifyOutcome(explore.endState, metrics);
  appendOutcome(opts.session.dir, {
    runId: explore.log.runId,
    score: null,
    metrics: {
      ...metrics,
      earlyEligible: 0,
      earlyScore: null,
      score: null,
    },
    outcomeClass,
    recordedAt: new Date().toISOString(),
  });

  const skill = refreshSkillPlaybook(opts.session.dir, {
    maxChars: config.agentSkilloptMaxChars,
    gameIndex: opts.gameIndex,
  });
  console.log(
    `[game] stop=${explore.stopReason} dailyReviews=${explore.dailyReviewCount ?? 0} lastReviewedDay=${reviewCursor.lastReviewedDay} skill=${skill.promoted ? `v${skill.version}` : "unchanged"}`,
  );
  printCurve(loadOutcomes(opts.session.dir));
}

async function main(): Promise<void> {
  const cli = parseMemoryCliArgs(process.argv.slice(2));
  const session = await resolveMemorySession(config.agentMemoryDir, cli);
  console.log(`Memory session: ${session.id} (${session.isNew ? "new" : "existing"})`);
  console.log(
    `Daily review interval: ${config.agentReviewIntervalDays} game day(s) (fast loop = every day)`,
  );

  const ops = new HttpGameOps(config);
  const health = await ops.health();
  if (!health.ok) throw new Error(`Game health not ok: ${JSON.stringify(health)}`);
  const gameFingerprint =
    typeof health.fingerprint === "string" ? health.fingerprint : null;

  const client = createLlmClient(config);
  // Count terminal game outcomes (runId without :dayN suffix) for gameIndex.
  const priorGames = loadOutcomes(session.dir).filter(
    (o) => typeof o.runId === "string" && !o.runId.includes(":day"),
  ).length;
  let gameIndex = priorGames;
  const maxGames = config.agentMaxGames > 0 ? config.agentMaxGames : Number.POSITIVE_INFINITY;

  while (gameIndex < maxGames) {
    gameIndex += 1;
    console.log(`\n=== Game ${gameIndex} ===`);
    await runGameWithDailyReview({
      session,
      client,
      ops,
      gameIndex,
      gameFingerprint,
    });
    if (gameIndex < maxGames) await sleep(config.agentInterGameDelayMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
