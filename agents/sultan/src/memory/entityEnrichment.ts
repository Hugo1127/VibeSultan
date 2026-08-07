import type { EntityKnowledgeRecord } from "@vibesultan/agent-learning-core";
import type { EnrichmentEntityKind, EnrichmentJob } from "./enrichmentQueue.js";

const CARD_FIELDS = [
  "usages",
  "antiPatterns",
  "description",
  "applicableConditions",
  "unknowns",
] as const;
const EVENT_FIELDS = [
  "successfulRoutes",
  "failureModes",
  "rewardSummary",
  "costSummary",
  "unknowns",
] as const;
const INTERACTION_FIELDS = [
  "bestPractices",
  "failureModes",
  "conditions",
  "unknowns",
] as const;

export type SemanticFieldName =
  | (typeof CARD_FIELDS)[number]
  | (typeof EVENT_FIELDS)[number]
  | (typeof INTERACTION_FIELDS)[number];

export function allowedFieldsFor(kind: EnrichmentEntityKind): readonly string[] {
  if (kind === "card") return CARD_FIELDS;
  if (kind === "event") return EVENT_FIELDS;
  return INTERACTION_FIELDS;
}

export function buildEnrichmentMessages(opts: {
  job: EnrichmentJob;
  record: EntityKnowledgeRecord;
}): Array<{ role: "system" | "user"; content: string }> {
  const fields = allowedFieldsFor(opts.job.entityKind);
  return [
    {
      role: "system",
      content: [
        "You enrich Sultan entity memory with concise soft facts.",
        "Return ONLY a JSON object. No markdown fences.",
        `Entity kind: ${opts.job.entityKind}.`,
        `Allowed keys only: ${fields.join(", ")}.`,
        "Use short English bullet strings in arrays (max 8 items each).",
        "Do not invent numerical outcomes, sample counts, confidence, or status.",
        "Ground every claim in the provided evidence snapshot.",
        "If unsure, omit the field or leave unknowns with a short note.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          key: opts.job.key,
          kind: opts.job.entityKind,
          currentFacts: opts.record.facts,
          evidenceSnapshot: opts.job.evidenceSnapshot,
          status: opts.record.status,
          sampleCount: opts.record.sampleCount,
        },
        null,
        2,
      ),
    },
  ];
}

export function parseEnrichmentPayload(
  kind: EnrichmentEntityKind,
  text: string,
): Record<string, unknown> | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const allowed = new Set(allowedFieldsFor(kind));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const normalized = normalizeField(key, value);
    if (normalized !== undefined) out[key] = normalized;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function mergeSemanticFacts(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      const prior = Array.isArray(current[key])
        ? (current[key] as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
      merged[key] = [...new Set([...prior, ...(value as string[])])].slice(-12);
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      const prior = typeof current[key] === "string" ? String(current[key]) : "";
      if (!prior || prior === "usage_unknown" || key === "description") {
        merged[key] = value.trim();
      }
    }
  }
  return merged;
}

function normalizeField(key: string, value: unknown): unknown {
  if (key === "description" || key === "rewardSummary" || key === "costSummary") {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 600) : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 240))
      .slice(0, 8);
  }
  return undefined;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim().startsWith("{")) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}
