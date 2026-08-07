export interface RunContext {
  runId: string;
  sessionIndex: number;
  instanceId: string;
  startedAt: string;
}

export interface ObservationRef {
  id: string;
  kind: string;
  summary: string;
  capturedAt: string;
}

export interface DecisionTrace {
  decisionKey: string;
  action: string;
  rationale: string;
  observationIds: string[];
}

export type OutcomeClass =
  | "pending"
  | "provisional_positive"
  | "positive"
  | "negative"
  | "confounded"
  | "noncompliant"
  | "no_headroom"
  | "infra_failure";

export type NextAction =
  | "accept"
  | "retry_same"
  | "await_retry_review"
  | "await_validate"
  | "confirm_cross_instance"
  | "revise"
  | "switch_topic"
  | "archive";

export interface Outcome {
  runId: string;
  score: number | null;
  metrics: Record<string, number | null>;
  outcomeClass: OutcomeClass;
  recordedAt: string;
}

export interface Evidence {
  observations: ObservationRef[];
  metrics: Record<string, number | null>;
  notes: string[];
  updatedAt: string;
}

export type HypothesisStatus =
  | "candidate"
  | "backlog"
  | "validating"
  | "provisionally_validated"
  | "validated"
  | "rejected"
  | "inconclusive"
  | "abandoned";

export type TipStatus =
  | "candidate"
  | "experimental"
  | "active"
  | "contextual"
  | "shadow"
  | "rejected"
  | "superseded";

export interface MetricSpec {
  name: string;
  direction: "increase" | "decrease";
}

export interface Hypothesis {
  id: string;
  status: HypothesisStatus;
  topicKey: string;
  claim: string;
  rationale: string;
  constraints: string;
  sourceInstanceId: string;
  sessionIndex: number;
  createdAt: string;
  updatedAt: string;
  evidence: Evidence;
  outcomeClass: OutcomeClass;
  nextAction: NextAction;
  primaryMetric?: MetricSpec;
}

export interface TipEvidence {
  observationCount: number;
  positiveCount: number;
  negativeCount: number;
  netValueSum: number;
  lastUpdatedSessionIndex?: number;
}

export interface Tip {
  id: string;
  status: TipStatus;
  decisionKey: string;
  title: string;
  body: string;
  sourceInstanceId: string;
  sourceHypothesisId?: string;
  evidence: TipEvidence;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentPlan {
  id: string;
  hypothesisId: string;
  instanceId: string;
  primaryMetric: MetricSpec;
  enqueuedAt: string;
  priority: number;
}

export interface EvaluationResult {
  hypothesisId: string;
  baselineMetrics: Record<string, number | null>;
  retestMetrics: Record<string, number | null>;
  deltas: Record<string, number | null>;
  decision: "accepted" | "rejected" | "inconclusive";
  reason: string;
}

export type ExperienceStatus =
  | "observed"
  | "provisional"
  | "validated"
  | "contradicted";

export interface ExperienceVersionKey {
  gameFingerprint: string;
  configFingerprint: string;
}

/** Cross-run reusable experience for strategy planning (version-gated). */
export interface ExperienceRecord {
  id: string;
  status: ExperienceStatus;
  version: ExperienceVersionKey;
  actionSignature: string;
  contextSignature: string;
  eventFeatures: Record<string, unknown>[];
  cardFeatures: Record<string, unknown>[];
  prediction?: Record<string, unknown> | null;
  actualDelta?: Record<string, unknown> | null;
  metricsBefore?: Record<string, number | null>;
  metricsAfter?: Record<string, number | null>;
  sampleCount: number;
  positiveCount: number;
  negativeCount: number;
  confidence: number;
  notes: string[];
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
}

export type KnowledgeStatus = ExperienceStatus;
export type KnowledgeVersionKey = ExperienceVersionKey;
export type KnowledgeOutcome = "positive" | "negative" | "inconclusive";

export interface KnowledgeEvidence {
  id: string;
  outcome: KnowledgeOutcome;
  summary: string;
  context?: Record<string, unknown>;
  sourceId?: string;
  runId?: string;
  capturedAt: string;
}

/** Generic, version-gated entity knowledge. Domain facts remain game-specific. */
export interface EntityKnowledgeRecord {
  id: string;
  key: string;
  kind: string;
  status: KnowledgeStatus;
  version: KnowledgeVersionKey;
  facts: Record<string, unknown>;
  encounterCount: number;
  sampleCount: number;
  positiveCount: number;
  negativeCount: number;
  confidence: number;
  evidence: KnowledgeEvidence[];
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
}
