import {
  checkMetricHeadroom,
  compareTraces,
  computeAttribution,
  primaryMetricImproved,
  type EvaluationResult,
  type Hypothesis,
  type MetricSpec,
  type TipStore,
  type TraceSummary,
} from "@vibesultan/agent-learning-core";
import { extractMetrics } from "./sultanAdapter.js";

export function evaluateHypothesisRetest(opts: {
  hypothesis: Hypothesis;
  baselineState: unknown;
  retestState: unknown;
  baselineTrace?: TraceSummary | null;
  retestTrace?: TraceSummary | null;
  tipStore?: TipStore;
  sessionIndex?: number;
}): EvaluationResult & {
  confounded: boolean;
  headroomOk: boolean;
  attribution: ReturnType<typeof computeAttribution>;
} {
  const baselineMetrics = extractMetrics(opts.baselineState);
  const retestMetrics = extractMetrics(opts.retestState);
  const primary: MetricSpec = opts.hypothesis.primaryMetric ?? {
    name: "earlyScore",
    direction: "increase",
  };

  const headroom = checkMetricHeadroom(baselineMetrics, primary);
  const attribution = computeAttribution(baselineMetrics, retestMetrics);
  const improved = primaryMetricImproved(attribution, primary);

  // Day-to-day play naturally diverges; only treat hard confound when both
  // traces exist and report confounded AND primary metric is missing.
  let confounded = false;
  if (opts.baselineTrace && opts.retestTrace) {
    const report = compareTraces(opts.baselineTrace, opts.retestTrace);
    const primaryPresent =
      baselineMetrics[primary.name] != null && retestMetrics[primary.name] != null;
    confounded = report.confounded && !primaryPresent;
  }

  let decision: EvaluationResult["decision"] = "inconclusive";
  let reason = "insufficient_evidence";
  if (!headroom.ok) {
    decision = "inconclusive";
    reason = headroom.reason ?? "no_headroom";
  } else if (confounded) {
    decision = "inconclusive";
    reason = "confounded_traces";
  } else if (improved) {
    decision = "accepted";
    reason = "primary_metric_improved";
  } else {
    decision = "rejected";
    reason = "primary_metric_not_improved";
  }

  if (opts.tipStore) {
    for (const tip of opts.tipStore.list()) {
      if (tip.sourceHypothesisId !== opts.hypothesis.id) continue;
      const delta = attribution.deltas[primary.name];
      opts.tipStore.addEvidence(tip.id, {
        observations: 1,
        positives: decision === "accepted" ? 1 : 0,
        negatives: decision === "rejected" ? 1 : 0,
        netValues: [typeof delta === "number" ? delta : 0],
        sessionIndex: opts.sessionIndex ?? 0,
      });
    }
  }

  return {
    hypothesisId: opts.hypothesis.id,
    baselineMetrics,
    retestMetrics,
    deltas: attribution.deltas,
    decision,
    reason,
    confounded,
    headroomOk: headroom.ok,
    attribution,
  };
}
