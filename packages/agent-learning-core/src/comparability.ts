export interface TraceStep {
  step: number | null;
  fingerprint: string;
}

export interface TraceSummary {
  firstInterventionStep: number | null;
  openingSteps: TraceStep[];
  milestoneStep?: number | null;
}

export interface ComparabilityReport {
  confounded: boolean;
  reasons: string[];
}

export interface ComparabilityOptions {
  /** Max allowed drift in milestone step between baseline and retest. */
  milestoneTolerance?: number;
  /** Max allowed difference in opening step count. */
  openingCountTolerance?: number;
}

export function compareTraces(
  baseline: TraceSummary,
  retest: TraceSummary,
  options: ComparabilityOptions = {},
): ComparabilityReport {
  const milestoneTolerance = options.milestoneTolerance ?? 3;
  const openingCountTolerance = options.openingCountTolerance ?? 2;
  const reasons: string[] = [];
  const interventionStep = retest.firstInterventionStep;

  if (interventionStep === null) {
    return { confounded: false, reasons: ["strategy_not_exercised"] };
  }

  if (
    baseline.milestoneStep != null &&
    retest.milestoneStep != null &&
    Math.abs(baseline.milestoneStep - retest.milestoneStep) > milestoneTolerance
  ) {
    reasons.push("milestone_step_diverged");
  }

  const baselineOpening = baseline.openingSteps
    .filter((action) => action.step === null || action.step < interventionStep)
    .map((action) => action.fingerprint);
  const retestOpening = retest.openingSteps
    .filter((action) => action.step === null || action.step < interventionStep)
    .map((action) => action.fingerprint);

  const compareCount = Math.min(baselineOpening.length, retestOpening.length);
  for (let i = 0; i < compareCount; i++) {
    if (baselineOpening[i] !== retestOpening[i]) {
      reasons.push(`opening_step_diverged_at_${i}`);
      break;
    }
  }

  if (Math.abs(baselineOpening.length - retestOpening.length) > openingCountTolerance) {
    reasons.push("opening_step_count_diverged");
  }

  return { confounded: reasons.length > 0, reasons };
}
