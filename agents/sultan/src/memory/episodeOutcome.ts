import type { KnowledgeOutcome } from "@vibesultan/agent-learning-core";
import type { GameState } from "../game/types.js";

export interface EpisodeStateSnapshot {
  day: number | null;
  cardIds: number[];
  /** name/type labels for hard keyword matching on gained/lost cards */
  cardLabels: string[];
  resources: Record<string, number>;
  counters: Record<string, number>;
}

export interface OutcomeSignal {
  source: "dice" | "reward" | "text" | "cards" | "counters" | "resources";
  weight: number;
  detail: string;
}

const NEGATIVE_CARD_RE = /猜忌|谗言|反对|耻辱|罪|怀疑/;
const POSITIVE_CARD_RE = /赏赐|恩宠|支持|信任|友谊|礼物|金币|权势/;
const NEGATIVE_TEXT_RE = /失败|猜忌上升|增加猜忌|招致猜忌|谗言|反对|愤怒|惩罚/;
const POSITIVE_TEXT_RE = /赏赐|恩宠|减少猜忌|猜忌下降|支持|成功|奖励|友谊/;

export function captureEpisodeSnapshot(
  state: GameState | null | undefined,
): EpisodeStateSnapshot {
  const values = asRecord(state?.values);
  const cards = Array.isArray(values.cards) ? values.cards : [];
  const cardIds: number[] = [];
  const cardLabels: string[] = [];
  for (const raw of cards) {
    if (!isRecord(raw)) continue;
    const id = finiteNumber(raw.id);
    if (id == null) continue;
    cardIds.push(id);
    const label = [raw.name, raw.customName, raw.type]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("|");
    if (label) cardLabels.push(`${id}:${label}`);
  }
  return {
    day: finiteNumber(values.day) ?? finiteNumber(state?.values?.day as unknown),
    cardIds: [...new Set(cardIds)].sort((a, b) => a - b),
    cardLabels,
    resources: numericMap(values.resources),
    counters: numericMap(values.counters),
  };
}

export function scoreImmediateRiteResult(
  result: Record<string, unknown>,
  state?: GameState | null,
): { outcome: KnowledgeOutcome | null; signals: OutcomeSignal[]; decisive: boolean } {
  const signals: OutcomeSignal[] = [];
  if (state?.terminal === true || state?.values?.terminal === true) {
    return {
      outcome: "negative",
      signals: [{ source: "text", weight: -3, detail: "terminal" }],
      decisive: true,
    };
  }

  const success = finiteNumber(result.successCount);
  const threshold = finiteNumber(result.successThreshold);
  if (success != null && threshold != null) {
    const ok = success >= threshold;
    signals.push({
      source: "dice",
      weight: ok ? 3 : -3,
      detail: `success=${success}/${threshold}`,
    });
    return { outcome: ok ? "positive" : "negative", signals, decisive: true };
  }

  const explicit = String(result.result ?? "").toLowerCase();
  if (explicit === "success" || explicit === "positive") {
    signals.push({ source: "text", weight: 2, detail: "result=success" });
    return { outcome: "positive", signals, decisive: true };
  }
  if (explicit === "failed" || explicit === "failure" || explicit === "negative") {
    signals.push({ source: "text", weight: -2, detail: "result=failure" });
    return { outcome: "negative", signals, decisive: true };
  }

  const rewardSummary = stringValue(result.rewardSummary);
  const rewards = Array.isArray(result.rewards) ? result.rewards : [];
  if (rewardSummary || rewards.length > 0) {
    signals.push({
      source: "reward",
      weight: 2,
      detail: rewardSummary ?? `rewards=${rewards.length}`,
    });
  }

  const tipRaw = stringValue(result.tip);
  const tip =
    tipRaw && !/^new\s*text$/i.test(tipRaw.trim()) ? tipRaw : null;
  const textBlob = [
    stringValue(result.body),
    stringValue(result.title),
    tip,
    stringValue(result.summary),
    rewardSummary,
  ]
    .filter(Boolean)
    .join(" ");
  if (textBlob) {
    if (NEGATIVE_TEXT_RE.test(textBlob)) {
      signals.push({ source: "text", weight: -2, detail: "negative_result_text" });
    }
    if (POSITIVE_TEXT_RE.test(textBlob)) {
      signals.push({ source: "text", weight: 1, detail: "positive_result_text" });
    }
  }

  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  if (score === 0) return { outcome: null, signals, decisive: false };
  return {
    outcome: score > 0 ? "positive" : "negative",
    signals,
    decisive: false,
  };
}

export function scoreCrossDayDelta(
  baseline: EpisodeStateSnapshot | null | undefined,
  after: EpisodeStateSnapshot,
  opts?: {
    /**
     * Frozen rite inputs. Non-empty placements that avoid next-day penalty
     * cards/counters become learnable positive evidence (e.g. 权力的游戏).
     */
    composition?: Array<{
      cardId?: number | null;
      empty?: boolean;
    }> | null;
  },
): { outcome: KnowledgeOutcome | null; signals: OutcomeSignal[]; score: number } {
  if (!baseline) return { outcome: null, signals: [], score: 0 };
  const signals: OutcomeSignal[] = [];

  const beforeIds = new Set(baseline.cardIds);
  const afterIds = new Set(after.cardIds);
  const gainedIds = after.cardIds.filter((id) => !beforeIds.has(id));
  const lostIds = baseline.cardIds.filter((id) => !afterIds.has(id));
  const labelById = new Map<number, string>();
  for (const label of [...baseline.cardLabels, ...after.cardLabels]) {
    const [idText, rest] = label.split(":");
    const id = Number(idText);
    if (Number.isFinite(id) && rest) labelById.set(id, rest);
  }

  for (const id of gainedIds) {
    const label = labelById.get(id) ?? String(id);
    if (NEGATIVE_CARD_RE.test(label)) {
      signals.push({ source: "cards", weight: -3, detail: `gained_penalty_card=${label}` });
    } else if (POSITIVE_CARD_RE.test(label)) {
      signals.push({ source: "cards", weight: 3, detail: `gained_reward_card=${label}` });
    } else {
      signals.push({ source: "cards", weight: 1, detail: `gained_card=${id}` });
    }
  }
  for (const id of lostIds) {
    const label = labelById.get(id) ?? String(id);
    if (NEGATIVE_CARD_RE.test(label)) {
      signals.push({ source: "cards", weight: 2, detail: `lost_penalty_card=${label}` });
    } else if (POSITIVE_CARD_RE.test(label)) {
      signals.push({ source: "cards", weight: -1, detail: `lost_reward_card=${label}` });
    }
  }

  for (const [key, delta] of Object.entries(
    mapDelta(baseline.counters, after.counters),
  )) {
    const suspicious = /猜忌|谗言|反对|suspect|slander|opposition/i.test(key);
    if (suspicious) {
      signals.push({
        source: "counters",
        weight: delta > 0 ? -2 : 2,
        detail: `counter:${key}${delta >= 0 ? "+" : ""}${delta}`,
      });
    } else if (Math.abs(delta) >= 1) {
      signals.push({
        source: "counters",
        weight: Math.sign(delta),
        detail: `counter:${key}${delta >= 0 ? "+" : ""}${delta}`,
      });
    }
  }

  for (const [key, delta] of Object.entries(
    mapDelta(baseline.resources, after.resources),
  )) {
    if (delta === 0) continue;
    signals.push({
      source: "resources",
      weight: Math.sign(delta),
      detail: `resource:${key}${delta >= 0 ? "+" : ""}${delta}`,
    });
  }

  const hasCommittedInput = (opts?.composition ?? []).some(
    (assignment) =>
      !assignment.empty &&
      assignment.cardId != null &&
      assignment.cardId !== 0,
  );
  const hasHardPenalty = signals.some(
    (signal) =>
      (signal.source === "cards" &&
        signal.detail.startsWith("gained_penalty_card") &&
        signal.weight < 0) ||
      (signal.source === "counters" &&
        signal.weight < 0 &&
        /猜忌|谗言|反对|suspect|slander|opposition/i.test(signal.detail)),
  );
  // Placed a card and next day brought no 猜忌/penalty → positive for that input.
  if (hasCommittedInput && !hasHardPenalty) {
    const alreadyPositiveHard = signals.some(
      (signal) =>
        signal.source === "cards" &&
        signal.weight >= 2 &&
        signal.detail.startsWith("gained_reward_card"),
    );
    if (!alreadyPositiveHard) {
      signals.push({
        source: "cards",
        weight: 2,
        detail: "avoided_penalty_with_input",
      });
    }
  }

  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  if (score === 0) return { outcome: null, signals, score };
  // Require a hard card signal or |score|>=2 before calling it decisive-enough.
  const hasHardCard = signals.some(
    (signal) => signal.source === "cards" && Math.abs(signal.weight) >= 2,
  );
  if (!hasHardCard && Math.abs(score) < 2) {
    return { outcome: null, signals, score };
  }
  return {
    outcome: score > 0 ? "positive" : "negative",
    signals,
    score,
  };
}

export function combineOutcomeSignals(opts: {
  immediate?: { outcome: KnowledgeOutcome | null; signals: OutcomeSignal[] } | null;
  crossDay?: { outcome: KnowledgeOutcome | null; signals: OutcomeSignal[]; score: number } | null;
}): {
  outcome: KnowledgeOutcome | null;
  summary: string;
  signals: OutcomeSignal[];
} {
  const signals = [
    ...(opts.immediate?.signals ?? []),
    ...(opts.crossDay?.signals ?? []),
  ];
  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  let outcome: KnowledgeOutcome | null = null;
  if (opts.crossDay?.outcome) outcome = opts.crossDay.outcome;
  else if (score !== 0) outcome = score > 0 ? "positive" : "negative";
  else if (opts.immediate?.outcome) outcome = opts.immediate.outcome;

  const summary = [
    outcome ? `outcome=${outcome}` : null,
    ...signals.slice(0, 8).map((signal) => `${signal.source}:${signal.detail}`),
  ]
    .filter(Boolean)
    .join(" | ");
  return { outcome, summary, signals };
}

export function formatInputComposition(
  composition: Array<{
    cardId?: number | null;
    slotIndex: number;
    slotKey?: string | null;
    empty?: boolean;
    count?: number | null;
  }>,
): string {
  if (!composition.length) return "composition=empty";
  return `input=${composition
    .map((assignment) => {
      const slot = assignment.slotKey ?? assignment.slotIndex;
      if (assignment.empty || assignment.cardId == null || assignment.cardId === 0) {
        return `${slot}:empty`;
      }
      const count =
        typeof assignment.count === "number" &&
        Number.isFinite(assignment.count) &&
        assignment.count > 1
          ? Math.floor(assignment.count)
          : null;
      return count != null
        ? `${slot}:${assignment.cardId}@${count}`
        : `${slot}:${assignment.cardId}`;
    })
    .join(",")}`;
}

/**
 * Settle altruistic choice episodes when a strategic target card appears,
 * or mark inconclusive after horizonDays.
 */
export function scoreStrategicSettlement(
  baseline: EpisodeStateSnapshot | null | undefined,
  after: EpisodeStateSnapshot,
  targets: { cardIds?: number[]; namePatterns?: string[] },
  opts?: {
    openedDay?: number | null;
    horizonDays?: number;
  },
): { outcome: KnowledgeOutcome | null; signals: OutcomeSignal[]; summary: string } {
  const signals: OutcomeSignal[] = [];
  const beforeIds = new Set(baseline?.cardIds ?? []);
  const labelById = new Map<number, string>();
  for (const label of [...(baseline?.cardLabels ?? []), ...after.cardLabels]) {
    const [idText, rest] = label.split(":");
    const id = Number(idText);
    if (Number.isFinite(id) && rest) labelById.set(id, rest);
  }

  const candidates = after.cardIds.filter((id) => baseline == null || !beforeIds.has(id));
  for (const id of candidates) {
    const label = labelById.get(id) ?? "";
    const name = label.split("|")[0] ?? label;
    const hit =
      (targets.cardIds?.includes(id) ?? false) ||
      (targets.namePatterns ?? []).some(
        (pattern) => name.includes(pattern) || label.includes(pattern),
      );
    if (!hit) continue;
    signals.push({
      source: "cards",
      weight: 3,
      detail: `strategic_gain:${id}:${name || "?"}`,
    });
    return {
      outcome: "positive",
      signals,
      summary: `long_term_positive|strategic_card_gained:${id}:${name || "?"}`,
    };
  }

  const openedDay = opts?.openedDay ?? baseline?.day ?? null;
  const horizon = opts?.horizonDays ?? 30;
  if (openedDay != null && after.day != null && after.day - openedDay >= horizon) {
    signals.push({
      source: "text",
      weight: 0,
      detail: `strategic_horizon_elapsed:${horizon}`,
    });
    return {
      outcome: "inconclusive",
      signals,
      summary: `strategic_timeout|horizon=${horizon}`,
    };
  }

  return { outcome: null, signals, summary: "strategic_pending" };
}

function mapDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Record<string, number> = {};
  for (const key of keys) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

function numericMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const n = finiteNumber(raw);
    if (n != null) out[key] = n;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
