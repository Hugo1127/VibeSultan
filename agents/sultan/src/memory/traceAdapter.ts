import fs from "node:fs";
import path from "node:path";
import type { DecisionTrace, TraceStep, TraceSummary } from "@vibesultan/agent-learning-core";

export function loadDecisionTraces(runDir: string): DecisionTrace[] {
  const p = path.join(runDir, "decision-traces.jsonl");
  if (!fs.existsSync(p)) return [];
  const out: DecisionTrace[] = [];
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DecisionTrace);
    } catch {
      // ignore partial lines
    }
  }
  return out;
}

export function tracesToSummary(opts: {
  traces: DecisionTrace[];
  firstInterventionStep?: number | null;
}): TraceSummary {
  const openingSteps: TraceStep[] = opts.traces.map((t, i) => ({
    step: i,
    fingerprint: `${t.decisionKey}|${t.action}`,
  }));
  return {
    firstInterventionStep: opts.firstInterventionStep ?? (openingSteps.length > 0 ? 0 : null),
    openingSteps,
    milestoneStep: openingSteps.length > 0 ? openingSteps.length - 1 : null,
  };
}
