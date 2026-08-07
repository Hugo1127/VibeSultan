import type { Evidence, MetricSpec, Outcome, OutcomeClass } from "@vibesultan/agent-learning-core";
import type { GameState } from "../game/types.js";

/** One more survival day always outranks any preparation score within a day. */
const SURVIVAL_TIER = 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function numField(values: Record<string, unknown>, key: string): number | null {
  const v = values[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function clampNonNeg(n: number | null | undefined, max: number): number {
  if (n == null || !Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, n);
}

/** Sum stacked 金币 cards when resources.gold is missing (agent-side fallback). */
function goldFromCards(values: Record<string, unknown>): number | null {
  const pools = [values.cardsAll, values.cards];
  let total = 0;
  let seen = false;
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const raw of pool) {
      if (!isRecord(raw)) continue;
      const name = String(raw.name ?? raw.customName ?? "");
      const type = String(raw.type ?? "");
      if (
        name.includes("金币") ||
        /gold|coin|money/i.test(type)
      ) {
        seen = true;
        const count = asFiniteNumber(raw.count);
        total += count != null && count > 0 ? count : 1;
      }
    }
    if (seen) break;
  }
  return seen ? total : null;
}

function sudanRemainingFrom(values: Record<string, unknown>, day: number | null): number | null {
  const sudan = isRecord(values.sudan) ? values.sudan : {};
  const initLife = asFiniteNumber(sudan.initLife);
  // Min remaining across ALL held Sudan cards (multi-card pressure).
  let minRemaining: number | null = null;
  const consider = (raw: Record<string, unknown>) => {
    const type = String(raw.type ?? "").toLowerCase();
    const name = String(raw.name ?? raw.customName ?? "");
    const isSudan =
      type === "sudan" ||
      type.includes("sudan") ||
      /苏丹|杀戮|纵欲|征服|奢靡/.test(name);
    if (!isSudan) return;
    const life = asFiniteNumber(raw.life);
    if (initLife == null || initLife <= 0 || life == null) return;
    const rem = Math.max(0, initLife - Math.max(0, life));
    if (minRemaining == null || rem < minRemaining) minRemaining = rem;
  };
  if (isRecord(sudan.currentCard)) consider(sudan.currentCard);
  for (const poolKey of ["cards", "cardsAll"] as const) {
    const pool = values[poolKey];
    if (!Array.isArray(pool)) continue;
    for (const raw of pool) {
      if (isRecord(raw)) consider(raw);
    }
  }
  if (minRemaining != null) return minRemaining;

  const direct =
    asFiniteNumber(sudan.remaining) ??
    asFiniteNumber(sudan.daysLeft) ??
    asFiniteNumber(sudan.executionDaysLeft);
  if (direct != null) return direct;
  if (initLife == null || initLife <= 0 || day == null) return null;
  if (day <= 0) return initLife;
  return Math.max(0, initLife - (day - 1));
}

/** True when the game has entered a terminal / endgame screen. */
export function isTerminalState(state: GameState | unknown): boolean {
  if (!isRecord(state)) return false;
  if (state.terminal === true) return true;
  const values = isRecord(state.values) ? state.values : {};
  if (values.terminal === true) return true;
  const screen = isRecord(state.screen) ? state.screen : {};
  const phase = String(screen.phase ?? "").toLowerCase();
  const id = String(screen.id ?? "").toLowerCase();
  return phase === "terminal" || id === "terminal";
}

export function primaryMetricForTopic(topicKey: string): MetricSpec {
  switch (topicKey) {
    case "sudan_pressure":
    case "execution_timing":
      // Survive + early preparation; do not use endgame score.
      return { name: "earlyScore", direction: "increase" };
    case "rite_efficiency":
    case "min_gold_cost":
    case "errand_vs_story":
      return { name: "gold", direction: "increase" };
    case "map_scout_added":
    case "gold_dice_optional":
    case "tier_match":
    case "early_explore":
    default:
      return { name: "earlyScore", direction: "increase" };
  }
}

export function extractMetrics(state: GameState | unknown): Record<string, number | null> {
  if (!isRecord(state)) {
    return {
      day: null,
      score: null,
      earlyScore: null,
      earlyEligible: 0,
      survivalDay: null,
      safetyMargin: null,
      economyScore: null,
      progressScore: null,
      capacityScore: null,
    };
  }
  const values = isRecord(state.values) ? state.values : {};
  const resources = isRecord(values.resources) ? values.resources : {};
  const counters = isRecord(values.counters) ? values.counters : {};

  const day = numField(values, "day") ?? numField(values, "turn");
  const gold =
    asFiniteNumber(resources.gold) ??
    asFiniteNumber(resources.money) ??
    goldFromCards(values);

  const sudanRemaining = sudanRemainingFrom(values, day);

  const questProgress =
    asFiniteNumber(counters.questProgress) ??
    (isRecord(values.questSummary) ? asFiniteNumber(values.questSummary.completed) : null) ??
    (isRecord(values.questSummary) ? asFiniteNumber(values.questSummary.notes) : null);

  const handCount = numField(values, "handCount");
  const riteCount = numField(values, "riteCount");
  const goldDice =
    asFiniteNumber(resources.goldDice) ?? asFiniteNumber(counters["7100006"]);

  const terminal = isTerminalState(state);
  const earlyEligible = terminal ? 0 : 1;
  const survivalDay = day != null && Number.isFinite(day) ? Math.max(0, day) : null;

  // Capped preparation so resource spikes cannot outrank surviving one more day.
  const safetyMargin = clampNonNeg(sudanRemaining, 7) * 4;
  const economyScore = clampNonNeg(gold, 40) + clampNonNeg(goldDice, 6) * 5;
  const progressScore = clampNonNeg(questProgress, 10) * 8;
  const capacityScore =
    clampNonNeg(handCount, 12) * 2 + clampNonNeg(riteCount, 10) * 3;
  const preparationScore = safetyMargin + economyScore + progressScore + capacityScore;

  const earlyScore =
    earlyEligible === 1 && survivalDay != null
      ? survivalDay * SURVIVAL_TIER + preparationScore
      : null;

  // Alias: learning stores historically read `score`. Prefer earlyScore.
  const score = earlyScore;

  return {
    day,
    gold,
    sudanRemaining,
    questProgress,
    handCount,
    riteCount,
    goldDice,
    survivalDay,
    safetyMargin,
    economyScore,
    progressScore,
    capacityScore,
    earlyEligible,
    earlyScore,
    score,
  };
}

/** Detect pressure / opportunity that should allow proposing a new topic today. */
export function detectReviewSignals(opts: {
  state: unknown;
  stateBefore?: unknown;
  activeTopicKey?: string | null;
}): { forcePropose: boolean; reason: string | null } {
  if (isTerminalState(opts.state)) {
    return { forcePropose: false, reason: null };
  }
  const metrics = extractMetrics(opts.state);
  const before = opts.stateBefore != null ? extractMetrics(opts.stateBefore) : null;
  const sudan = metrics.sudanRemaining;
  if (typeof sudan === "number" && sudan <= 2 && opts.activeTopicKey !== "sudan_pressure") {
    return { forcePropose: true, reason: "sudan_pressure_signal" };
  }
  if (
    before &&
    typeof metrics.gold === "number" &&
    typeof before.gold === "number" &&
    metrics.gold - before.gold >= 5 &&
    opts.activeTopicKey !== "rite_efficiency"
  ) {
    return { forcePropose: true, reason: "gold_jump_signal" };
  }
  if (typeof metrics.day === "number" && metrics.day >= 5 && opts.activeTopicKey === "early_explore") {
    return { forcePropose: true, reason: "midgame_topic_shift" };
  }
  return { forcePropose: false, reason: null };
}

export function buildComparisonKey(state: GameState | unknown): string {
  if (!isRecord(state)) return "unknown";
  const values = isRecord(state.values) ? state.values : {};
  const screen = isRecord(state.screen) ? String(state.screen.id ?? "?") : "?";
  const fp = values.fingerprint ?? "?";
  const day = values.day ?? values.turn ?? "?";
  return `screen=${screen}|day=${day}|fp=${fp}`;
}

export function extractEvidence(state: GameState | unknown): Evidence {
  const metrics = extractMetrics(state);
  const now = new Date().toISOString();
  const notes: string[] = [];
  if (isRecord(state)) {
    const screen = isRecord(state.screen) ? state.screen : {};
    notes.push(`screen=${screen.id ?? "?"} phase=${screen.phase ?? "?"}`);
    notes.push(`terminal=${isTerminalState(state)}`);
    const values = isRecord(state.values) ? state.values : {};
    if (isRecord(values.sudan)) {
      notes.push(`sudan=${JSON.stringify(values.sudan)}`);
    }
  }
  return {
    observations: [
      {
        id: `obs_${Date.now()}`,
        kind: "game_state",
        summary: buildComparisonKey(state),
        capturedAt: now,
      },
    ],
    metrics,
    notes,
    updatedAt: now,
  };
}

export function classifyOutcome(
  state: GameState | unknown,
  metrics: Record<string, number | null>,
): OutcomeClass {
  if (!isRecord(state)) return "infra_failure";
  // Endgame is outside early-game scoring; keep a diagnostic class only.
  if (isTerminalState(state)) return "negative";
  const remaining = metrics.sudanRemaining;
  if (typeof remaining === "number" && remaining <= 0) return "negative";
  if (typeof metrics.day === "number" && metrics.day >= 7) return "provisional_positive";
  return "pending";
}

export function summarizeRun(
  state: GameState | unknown,
  finalText: string,
  stopReason: string,
): string {
  const metrics = extractMetrics(state);
  const key = buildComparisonKey(state);
  const outcome = classifyOutcome(state, metrics);
  return [
    "## 对局摘要",
    `- comparisonKey: ${key}`,
    `- stopReason: ${stopReason}`,
    `- outcomeClass: ${outcome}`,
    `- metrics: ${JSON.stringify(metrics)}`,
    `- final: ${finalText.slice(0, 500)}`,
  ].join("\n");
}

export type EarlyCurvePoint = {
  runId: string;
  baseRunId: string;
  dayWindow: number | null;
  earlyScore: number;
  metrics: Record<string, number | null>;
};

/**
 * Keep only early-eligible daily snapshots (`:dayN`) and take the last one
 * per game so each run contributes a single curve point.
 * Legacy outcomes without earlyEligible/earlyScore are ignored.
 */
export function selectLastEarlySnapshotPerGame(outcomes: Outcome[]): EarlyCurvePoint[] {
  const dayRe = /^(.*):day(\d+)$/;
  const order: string[] = [];
  const latest = new Map<string, EarlyCurvePoint>();

  for (const outcome of outcomes) {
    if (typeof outcome.runId !== "string") continue;
    const match = dayRe.exec(outcome.runId);
    if (!match) continue;
    const metrics = outcome.metrics ?? {};
    if (metrics.earlyEligible !== 1) continue;
    const earlyScore =
      typeof metrics.earlyScore === "number" && Number.isFinite(metrics.earlyScore)
        ? metrics.earlyScore
        : typeof outcome.score === "number" && Number.isFinite(outcome.score)
          ? outcome.score
          : null;
    if (earlyScore == null) continue;

    const baseRunId = match[1]!;
    const dayWindow =
      typeof metrics.dayWindow === "number"
        ? metrics.dayWindow
        : Number.parseInt(match[2]!, 10);
    const point: EarlyCurvePoint = {
      runId: outcome.runId,
      baseRunId,
      dayWindow: Number.isFinite(dayWindow) ? dayWindow : null,
      earlyScore,
      metrics,
    };
    if (!latest.has(baseRunId)) order.push(baseRunId);
    latest.set(baseRunId, point);
  }

  return order.map((id) => latest.get(id)!);
}

export function formatEarlyCurvePoint(point: EarlyCurvePoint | undefined): string {
  if (!point) return "n/a";
  const m = point.metrics;
  return [
    `earlyScore=${point.earlyScore}`,
    `day=${m.day ?? "?"}`,
    `gold=${m.gold ?? "?"}`,
    `quest=${m.questProgress ?? "?"}`,
    `sudan=${m.sudanRemaining ?? "?"}`,
    `econ=${m.economyScore ?? "?"}`,
    `prep=${
      typeof m.safetyMargin === "number" &&
      typeof m.economyScore === "number" &&
      typeof m.progressScore === "number" &&
      typeof m.capacityScore === "number"
        ? m.safetyMargin + m.economyScore + m.progressScore + m.capacityScore
        : "?"
    }`,
  ].join(" ");
}

const PLAYBOOK_H_STATUS = new Set([
  "validated",
  "provisionally_validated",
]);
const PLAYBOOK_TIP_STATUS = new Set(["active", "experimental"]);

/** Filter to playbook-grade memory for Gameplay injection. */
export function filterPlaybookHypotheses<T extends { status: string }>(
  hypotheses: T[],
): T[] {
  return hypotheses.filter((h) => PLAYBOOK_H_STATUS.has(h.status));
}

export function filterPlaybookTips<T extends { status: string }>(tips: T[]): T[] {
  return tips.filter((t) => PLAYBOOK_TIP_STATUS.has(t.status));
}

export function buildMemoryInjection(
  hypotheses: Array<{ claim: string; constraints: string; status: string }>,
  tips: Array<{ title: string; body: string; status: string }>,
  budgetChars: number,
): string {
  const hList = filterPlaybookHypotheses(hypotheses).slice(0, 8);
  // Larger tip playbook so entity-distilled + topic tips can coexist.
  const tList = filterPlaybookTips(tips).slice(0, 24);
  const parts: string[] = ["## 跨局记忆（只读 playbook）"];
  if (hList.length === 0 && tList.length === 0) {
    parts.push("- （暂无已验证假设/活跃技巧）");
  }
  for (const h of hList) {
    parts.push(`- [${h.status}] 假设：${h.claim}（约束：${h.constraints}）`);
  }
  for (const t of tList) {
    parts.push(`- [${t.status}] 技巧：${t.title} — ${t.body}`);
  }
  const text = parts.join("\n");
  return text.length > budgetChars ? text.slice(0, budgetChars) + "\n…" : text;
}
