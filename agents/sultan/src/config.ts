import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveEnvFile(): string {
  if (process.env.ENV_FILE) {
    return path.resolve(process.env.ENV_FILE);
  }
  const candidate = path.resolve(__dirname, "../../../env/.env");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.resolve(__dirname, "../../../env/.env.example");
}

const envPath = resolveEnvFile();
dotenv.config({ path: envPath });

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing env ${name} (loaded from ${envPath})`);
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  envPath,
  openaiApiKey: (process.env.OPENAI_API_KEY || process.env.MOONSHOT_API_KEY || "").trim(),
  openaiBaseUrl: req("OPENAI_BASE_URL", "https://api.moonshot.ai/v1").replace(/\/$/, ""),
  openaiModel: req("OPENAI_MODEL", "kimi-k2.7-code"),
  httpUserAgent: req("HTTP_USER_AGENT", "VibeSultan-SultanAgent/0.1"),
  llmMaxRetries: num("LLM_MAX_RETRIES", 5),
  llmRetryIntervalSec: num("LLM_RETRY_INTERVAL_SEC", 10),
  llmRequestTimeoutMs: num("LLM_REQUEST_TIMEOUT_MS", 300_000),
  gameBaseUrl: req("GAME_BASE_URL", "http://127.0.0.1:17890").replace(/\/$/, ""),
  gameTimeoutMs: num("GAME_REQUEST_TIMEOUT_MS", 15000),
  gameDryRun: bool("GAME_DRY_RUN", false),
  agentMaxSteps: num("AGENT_MAX_STEPS", 40),
  agentCompressTriggerTokens: num("AGENT_COMPRESS_TRIGGER_TOKENS", 64000),
  agentCompressSoftRatio: num("AGENT_COMPRESS_SOFT_RATIO", 0.5),
  agentCompressLookaheadTurns: num("AGENT_COMPRESS_LOOKAHEAD_TURNS", 2),
  agentCompressKeepTurns: num("AGENT_COMPRESS_KEEP_TURNS", 4),
  agentCompressSegmentTokens: num("AGENT_COMPRESS_SEGMENT_TOKENS", 12_000),
  agentCompressDump: bool("AGENT_COMPRESS_DUMP", false),
  agentLogDir: process.env.AGENT_LOG_DIR
    ? path.resolve(process.env.AGENT_LOG_DIR)
    : path.resolve(path.dirname(envPath), "../agents/sultan/logs"),
  agentLogMaxChars: num("AGENT_LOG_MAX_CHARS", 8000),
  agentMaxGames: num("AGENT_MAX_GAMES", 0),
  agentMemoryDir: process.env.AGENT_MEMORY_DIR
    ? path.resolve(process.env.AGENT_MEMORY_DIR)
    : path.resolve(path.dirname(envPath), "../agents/sultan/memory"),
  agentBootTimeoutMs: num("AGENT_BOOT_TIMEOUT_MS", 60000),
  agentInterGameDelayMs: num("AGENT_INTER_GAME_DELAY_MS", 2000),
  /** Game-day cadence for in-run daily review (default: every 1 day — ~60-day runs). */
  agentReviewIntervalDays: Math.max(1, Math.floor(num("AGENT_REVIEW_INTERVAL_DAYS", 1))),
  agentHypothesisBudgetChars: num("AGENT_HYPOTHESIS_BUDGET_CHARS", 6000),
  agentEntityMemoryBudgetChars: Math.max(500, num("AGENT_ENTITY_MEMORY_BUDGET_CHARS", 2500)),
  agentEntityMinSamples: Math.max(1, Math.floor(num("AGENT_ENTITY_MIN_SAMPLES", 3))),
  agentEntityMaxCards: Math.max(1, Math.floor(num("AGENT_ENTITY_MAX_CARDS", 6))),
  agentEntityMaxEvents: Math.max(1, Math.floor(num("AGENT_ENTITY_MAX_EVENTS", 4))),
  agentEntityMaxInteractions: Math.max(
    1,
    Math.floor(num("AGENT_ENTITY_MAX_INTERACTIONS", 8)),
  ),
  /** Async soft-fact enrichment (usages / best practices). Never blocks the main loop. */
  agentEntityEnrichEnabled: bool("AGENT_ENTITY_ENRICH_ENABLED", true),
  agentEntityEnrichConcurrency: Math.max(1, Math.floor(num("AGENT_ENTITY_ENRICH_CONCURRENCY", 1))),
  agentEntityEnrichMaxQueue: Math.max(1, Math.floor(num("AGENT_ENTITY_ENRICH_MAX_QUEUE", 200))),
  agentEntityEnrichTimeoutMs: Math.max(1_000, num("AGENT_ENTITY_ENRICH_TIMEOUT_MS", 60_000)),
  agentEntityEnrichMaxAttempts: Math.max(1, Math.floor(num("AGENT_ENTITY_ENRICH_MAX_ATTEMPTS", 2))),
  agentEntityEnrichFlushTimeoutMs: Math.max(
    0,
    num("AGENT_ENTITY_ENRICH_FLUSH_TIMEOUT_MS", 5_000),
  ),
  agentEpisodeTtlSteps: Math.max(10, Math.floor(num("AGENT_EPISODE_TTL_STEPS", 120))),
  /**
   * Moral Alignment / Social Capital framework.
   * When false: legacy 10-dim scorer, no moral axiom, no choice heuristics,
   * no pending_strategic altruism settlement.
   */
  agentSocialCapitalEnabled: bool("AGENT_SOCIAL_CAPITAL_ENABLED", true),
  /** Prefer injecting skills/best_skill.md when present (cross-game slow loop). */
  agentSkilloptInjectBest: bool("AGENT_SKILLOPT_INJECT_BEST", true),
  agentSkilloptMaxChars: num("AGENT_SKILLOPT_MAX_CHARS", 4000),
  agentTerminalCurve: bool("AGENT_TERMINAL_CURVE", true),
  agentTerminalCurveWidth: Math.max(8, num("AGENT_TERMINAL_CURVE_WIDTH", 48)),
  agentTerminalCurveHeight: Math.max(4, num("AGENT_TERMINAL_CURVE_HEIGHT", 8)),
};

export type AppConfig = typeof config;
