export type {
  RunContext,
  ObservationRef,
  DecisionTrace,
  Outcome,
  Evidence,
  Hypothesis,
  Tip,
  TipEvidence,
  ExperimentPlan,
  EvaluationResult,
  HypothesisStatus,
  TipStatus,
  OutcomeClass,
  NextAction,
  MetricSpec,
  ExperienceStatus,
  ExperienceVersionKey,
  ExperienceRecord,
  KnowledgeStatus,
  KnowledgeVersionKey,
  KnowledgeOutcome,
  KnowledgeEvidence,
  EntityKnowledgeRecord,
} from "./types.js";

export {
  MemoryAuditLog,
  atomicWriteJson,
  snapshotHash,
  stableStringify,
  type MemoryAuditEvent,
  type MemoryEntityKind,
  type MemoryAuditAction,
  type AuditContext,
} from "./audit.js";

export {
  findDuplicate,
  claimSimilarity,
  ngramJaccard,
  type DuplicateMatch,
  type ConceptExtractor,
} from "./dedupe.js";

export {
  HypothesisStore,
  type HypothesisStoreFile,
  type CreateHypothesisInput,
  type UpdateHypothesisPatch,
} from "./hypothesisStore.js";

export {
  TipStore,
  type TipStoreFile,
  type CreateTipInput,
  type TipEvidenceDelta,
} from "./tipStore.js";

export {
  ExperienceStore,
  type ExperienceStoreFile,
  type CreateExperienceInput,
  type ExperienceEvidenceDelta,
} from "./experienceStore.js";

export {
  EntityKnowledgeStore,
  type EntityKnowledgeStoreFile,
  type EntityKnowledgeStoreOptions,
  type TouchEntityKnowledgeInput,
  type AddKnowledgeEvidenceInput,
} from "./entityKnowledgeStore.js";

export {
  ExperimentLedger,
  newExperimentPlanId,
  type ExperimentLedgerFile,
} from "./experimentLedger.js";

export {
  buildResearchAgenda,
  selectNextExperiment,
  type TopicAgenda,
  type ResearchAgenda,
} from "./researchAgenda.js";

export {
  compareTraces,
  type TraceStep,
  type TraceSummary,
  type ComparabilityReport,
  type ComparabilityOptions,
} from "./comparability.js";

export {
  checkMetricHeadroom,
  type HeadroomResult,
  type HeadroomOptions,
} from "./headroom.js";

export {
  computeAttribution,
  primaryMetricImproved,
  guardrailPassed,
  type MetricAttribution,
} from "./attribution.js";

export {
  SkillArtifactStore,
  evaluateSelectionGate,
  reflectStub,
  emptyManifest,
  hashContent,
  PROTECTED_HEADER,
  type SkillEdit,
  type SkillArtifactVersion,
  type SkillArtifactManifest,
  type RejectedEditEntry,
  type GateScores,
  type GateDecision,
  type GateOptions,
  type ReflectInput,
  type ReflectResult,
} from "./skillopt.js";

export {
  computeBestSoFar,
  learningCurveFromOutcomes,
  peakScore,
  type LearningCurvePoint,
} from "./learningCurve.js";
