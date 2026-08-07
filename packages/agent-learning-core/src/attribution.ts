import type { MetricSpec } from "./types.js";

export interface MetricAttribution {
  baseline: Record<string, number | null>;
  retest: Record<string, number | null>;
  deltas: Record<string, number | null>;
}

export function computeAttribution(
  baseline: Record<string, number | null>,
  retest: Record<string, number | null>,
  metricNames?: string[],
): MetricAttribution {
  const names =
    metricNames ??
    [...new Set([...Object.keys(baseline), ...Object.keys(retest)])];
  const deltas: Record<string, number | null> = {};
  for (const name of names) {
    const a = baseline[name];
    const b = retest[name];
    deltas[name] =
      typeof a === "number" && typeof b === "number" ? b - a : null;
  }
  return { baseline, retest, deltas };
}

export function primaryMetricImproved(
  attribution: MetricAttribution,
  spec: MetricSpec,
): boolean {
  const delta = attribution.deltas[spec.name];
  if (typeof delta !== "number") return false;
  return spec.direction === "increase" ? delta > 0 : delta < 0;
}

export function guardrailPassed(
  attribution: MetricAttribution,
  guardrail: { name: string; maxRegressionRatio: number },
): boolean {
  const baseline = attribution.baseline[guardrail.name];
  const retest = attribution.retest[guardrail.name];
  if (typeof baseline !== "number" || typeof retest !== "number") return false;
  return retest >= baseline * (1 - guardrail.maxRegressionRatio);
}
