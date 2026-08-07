import type { MetricSpec } from "./types.js";

export interface HeadroomResult {
  ok: boolean;
  reason?: "metric_unavailable" | "no_headroom";
  baseline: number | null;
}

export interface HeadroomOptions {
  epsilon?: number;
  /** Optional upper bound for increase-direction metrics (domain-specific). */
  maxValue?: number;
}

export function checkMetricHeadroom(
  baselineMetrics: Record<string, number | null>,
  spec: MetricSpec,
  options: HeadroomOptions = {},
): HeadroomResult {
  const epsilon = options.epsilon ?? 0.01;
  const baseline = baselineMetrics[spec.name];
  if (typeof baseline !== "number") {
    return { ok: false, reason: "metric_unavailable", baseline: null };
  }
  if (spec.direction === "decrease" && baseline <= epsilon) {
    return { ok: false, reason: "no_headroom", baseline };
  }
  if (
    spec.direction === "increase" &&
    typeof options.maxValue === "number" &&
    baseline >= options.maxValue - epsilon
  ) {
    return { ok: false, reason: "no_headroom", baseline };
  }
  return { ok: true, baseline };
}
