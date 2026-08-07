import type { KnowledgeVersionKey } from "@vibesultan/agent-learning-core";
import type { SultanEntityStores } from "../memory/entityMemory.js";
import {
  OPTION_ALTRUISM_FACTS_KEY,
  OPTION_ALTRUISM_SOURCE_KEY,
  keywordsAreInconclusive,
  readCachedAltruismScores,
  scoreChoiceOptionLabel,
  type ChoiceOptionLike,
  type OptionAltruismScore,
} from "./choiceHeuristics.js";

export type ChoiceAltruismLlmComplete = (opts: {
  messages: Array<{ role: "system" | "user"; content: string }>;
  signal?: AbortSignal;
}) => Promise<string>;

export interface ClassifyChoiceAltruismInput {
  prompt?: string | null;
  options: ChoiceOptionLike[];
  llmComplete: ChoiceAltruismLlmComplete;
  timeoutMs?: number;
}

const SYSTEM = `You classify story choice options for Social Capital (ally-building vs exploit/flatter-Sultan).
Return ONLY compact JSON:
{"options":[{"index":0,"altruismScore":2,"reason":"..."}]}
altruismScore is an integer in [-2,2]: positive = help/protect/recruit allies; negative = kill/sell/refuse/flatter Sultan; 0 = neutral/unclear.
Do not invent options. Score every provided index once.`;

function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(-2, Math.min(2, Math.round(value)));
}

export function parseAltruismClassification(
  text: string,
  options: ChoiceOptionLike[],
): OptionAltruismScore[] | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return null;
  const rows = (parsed as { options?: unknown }).options;
  if (!Array.isArray(rows)) return null;
  const byIndex = new Map<number, OptionAltruismScore>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const index = typeof row.index === "number" ? row.index : null;
    const altruismScore = clampScore(row.altruismScore);
    if (index == null || altruismScore == null) continue;
    byIndex.set(index, {
      index,
      altruismScore,
      reason: typeof row.reason === "string" ? row.reason.slice(0, 120) : undefined,
    });
  }
  if (!byIndex.size) return null;
  // Fill missing options as neutral so cache is complete.
  return options.map((option) => {
    const hit = byIndex.get(option.index);
    if (hit) return hit;
    return { index: option.index, altruismScore: 0, reason: "unscored_default_neutral" };
  });
}

export function scoresFromKeywords(options: ChoiceOptionLike[]): OptionAltruismScore[] {
  return options.map((option) => ({
    index: option.index,
    altruismScore: scoreChoiceOptionLabel(option),
    reason: "keyword",
  }));
}

/**
 * Sync short LLM classify. Returns null on timeout/parse failure.
 */
export async function classifyChoiceAltruism(
  input: ClassifyChoiceAltruismInput,
): Promise<OptionAltruismScore[] | null> {
  if (!input.options.length) return null;
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 12_000);
  const user = JSON.stringify({
    prompt: input.prompt ?? null,
    options: input.options.map((option) => ({
      index: option.index,
      label: option.label ?? null,
      tag: option.tag ?? null,
    })),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const text = await input.llmComplete({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      signal: controller.signal,
    });
    return parseAltruismClassification(text, input.options);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface EnsureChoiceAltruismOpts {
  stores: SultanEntityStores;
  eventKey: string;
  version: KnowledgeVersionKey;
  prompt?: string | null;
  options: ChoiceOptionLike[];
  runId?: string;
  /** When omitted and keywords inconclusive, skip LLM (brief soft path). */
  llmComplete?: ChoiceAltruismLlmComplete | null;
  timeoutMs?: number;
  forceLlm?: boolean;
}

/**
 * Resolve and persist option altruism scores on the choice event.
 * Order: existing cache → keyword (if decisive) → optional LLM → write cache.
 */
export async function ensureChoiceAltruismResolved(
  opts: EnsureChoiceAltruismOpts,
): Promise<{
  scores: OptionAltruismScore[] | null;
  source: "cache" | "keyword" | "llm" | "none";
}> {
  const existing = opts.stores.events.get(opts.eventKey, opts.version);
  const cached = readCachedAltruismScores(
    existing?.facts as Record<string, unknown> | undefined,
  );
  if (cached?.length) {
    return { scores: cached, source: "cache" };
  }

  if (!opts.options.length) {
    return { scores: null, source: "none" };
  }

  const inconclusive = keywordsAreInconclusive(opts.options);
  if (!inconclusive && !opts.forceLlm) {
    const scores = scoresFromKeywords(opts.options);
    persistAltruismScores(opts, scores, "keyword");
    return { scores, source: "keyword" };
  }

  if (!opts.llmComplete) {
    return { scores: null, source: "none" };
  }

  const classified = await classifyChoiceAltruism({
    prompt: opts.prompt,
    options: opts.options,
    llmComplete: opts.llmComplete,
    timeoutMs: opts.timeoutMs,
  });
  if (!classified) {
    // Last resort: store keyword snapshot (often all zeros) so we do not re-call every step.
    const fallback = scoresFromKeywords(opts.options);
    persistAltruismScores(opts, fallback, "keyword_fallback");
    return { scores: fallback, source: "keyword" };
  }

  persistAltruismScores(opts, classified, "llm");
  return { scores: classified, source: "llm" };
}

function persistAltruismScores(
  opts: EnsureChoiceAltruismOpts,
  scores: OptionAltruismScore[],
  source: string,
): void {
  const context = {
    actor: "sultan_choice_altruism",
    reason: `option_altruism_${source}`,
    runId: opts.runId,
  };
  opts.stores.events.touch(
    {
      key: opts.eventKey,
      kind: "event",
      version: opts.version,
      facts: {
        [OPTION_ALTRUISM_FACTS_KEY]: scores,
        [OPTION_ALTRUISM_SOURCE_KEY]: source,
      },
      runId: opts.runId,
    },
    context,
  );
}
