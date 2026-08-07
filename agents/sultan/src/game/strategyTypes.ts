import type { GameAction, GameState, SceneSnapshot } from "./types.js";

/** Version fingerprints that gate which experiences may influence scoring. */
export interface StrategyVersionKey {
  gameFingerprint: string;
  configFingerprint: string;
}

export type ExperienceStatus =
  | "observed"
  | "provisional"
  | "validated"
  | "contradicted";

/** Stable features for matching across runs (no ephemeral uids). */
export interface CardFeature {
  uid?: number | null;
  cardId?: number | null;
  type?: string | null;
  rare?: number | null;
  name?: string | null;
  /** Elapsed duration ticks (Sudan face countdown = initLife - life). */
  life?: number | null;
  tags?: string[];
  inHand?: boolean;
}

export interface SlotFeature {
  index: number;
  slotKey?: string | null;
  text?: string | null;
  condition?: string | null;
  conditionType?: string | null;
  requiredRare?: number | null;
  requiredTier?: string | null;
  isKey?: boolean;
  isEnemy?: boolean;
  occupied?: boolean;
  acceptsOp?: string | null;
  occupant?: {
    cardUid?: number | null;
    cardId?: number | null;
    name?: string | null;
    type?: string | null;
    rare?: number | null;
    tier?: string | null;
    tags?: Record<string, number>;
    kind: "builtin" | "player" | "unknown";
  } | null;
}

/** Closed-map config slot schema (no panel required). */
export interface SlotPreviewFeature {
  index: number;
  slotKey?: string | null;
  text?: string | null;
  conditionType?: string | null;
  condition?: string | null;
  requiredRare?: number | null;
  requiredTier?: string | null;
  costMin?: number | null;
  isKey?: boolean;
}

export interface HandMatchHint {
  slotIndex: number;
  slotKey?: string | null;
  conditionType?: string | null;
  requiredRare?: number | null;
  matchingCardUids: number[];
  matchKind?: string | null;
}

export interface EventFeature {
  kind?: "rite";
  riteId?: number | null;
  riteUid?: number | null;
  name?: string | null;
  life?: number | null;
  started?: boolean;
  slotsFilled?: number | null;
  canConfirm?: boolean;
  remainingAppearTurns?: number | null;
  executionTurns?: number | null;
  slots?: SlotFeature[];
  /** Config-based slot preview available while map is closed. */
  slotPreview?: SlotPreviewFeature[];
  /** Count of slots with ≥1 heuristic hand match. */
  handMatchCount?: number | null;
  handMatchHints?: HandMatchHint[];
  reusableHint?: boolean | null;
}

export interface ChoiceEventFeature {
  kind: "choice";
  eventKey: string;
  prompt?: string | null;
  identitySeed: string;
  identityQuality: "stable" | "derived";
  options: Array<{
    index: number;
    label?: string | null;
    selected?: boolean;
    tag?: string | null;
  }>;
}

export interface StrategyDeadline {
  kind: "sudan_card" | "rite_life" | "execution_lock" | "guide" | string;
  label: string;
  remaining?: number | null;
  critical?: boolean;
}

export interface SudanCardSnapshot {
  cardId?: number | null;
  uid?: number | null;
  name?: string | null;
  identity?: string | null;
  rare?: number | null;
  /** Elapsed life ticks on this Sudan card (face countdown = initLife - life). */
  life?: number | null;
  /** Remaining execution days for this card (initLife - life). */
  remaining?: number | null;
  initLife?: number | null;
  redrawTimes?: number | null;
  redrawPerRound?: number | null;
  redrawRemaining?: number | null;
  exchangeCircuitOpen?: boolean;
}

export interface SudanRouteSummarySnapshot {
  coverage: number;
  readyCount: number;
  needsSupportCount: number;
  pendingProbes: number;
  /** Routes with ready or needs_support for current sudan (verified place affordance). */
  verifiedBreakCount?: number;
  incompatibleCount?: number;
  shortestPrepDays?: number | null;
  bestRouteLabel?: string | null;
  expiringOpportunity?: boolean;
  triedBranchCount?: number;
  insight?: number | null;
  rewindAvailable?: boolean;
}

export interface ExploreRecoverySnapshot {
  exploreRemainingByEvent?: Record<string, number>;
  failedPathCount?: number;
  failedPathSignatures?: string[];
  recoveryActive?: boolean;
  recoveryTargetDay?: number | null;
  recoveryDepth?: number | null;
  rewindRemaining?: number | null;
  recoveryHint?: string | null;
}

export interface StrategySnapshot {
  schemaVersion: 1;
  capturedAt: string;
  version: StrategyVersionKey;
  day?: number | null;
  turn?: number | null;
  phase?: string | null;
  terminal?: boolean;
  executionDaysLeft?: number | null;
  resources?: Record<string, number | null>;
  counters?: Record<string, number | null>;
  cards: CardFeature[];
  events: EventFeature[];
  currentChoiceEvent?: ChoiceEventFeature | null;
  /** Current open rite; retained as currentEvent for planner compatibility. */
  currentEvent?: EventFeature | null;
  deadlines: StrategyDeadline[];
  enabledOps: string[];
  unknowns: string[];
  sceneVersion?: number | null;
  /** Most urgent Sudan card (min remaining). Backward-compatible singular view. */
  sudanCard?: SudanCardSnapshot | null;
  /** All held Sudan cards with per-card face countdowns. */
  sudanCards?: SudanCardSnapshot[];
  /** Rolling route ledger summary for timing / scoring. */
  sudanRoutes?: SudanRouteSummarySnapshot | null;
  /** Vision / 灵视 counter (7100005). */
  insight?: number | null;
  /** Whether prev_round is currently enabled. */
  rewindAvailable?: boolean;
  /** Phase-2 explore / recovery observability. */
  exploreRecovery?: ExploreRecoverySnapshot | null;
}

/** One complete way to fill / advance a single event. */
export interface EventConfiguration {
  id: string;
  event: EventFeature;
  assignments: Array<{
    slotIndex: number;
    card: CardFeature;
    uid?: number | null;
    /** Stackable place amount (金币); from affordance count / costMin. */
    count?: number | null;
  }>;
  estimatedLockTurns?: number | null;
  unknowns: string[];
  experienceIds: string[];
  entityKnowledgeIds?: string[];
  entityKnowledgeScore?: number;
  entityKnowledgeWarnings?: string[];
  baseScore: number;
  /** Phase-2 explore tagging. */
  exploreKind?: "baseline" | "novel" | "blocked";
  exploreRemaining?: number;
  exploreBlockedReason?: string | null;
  pathSignature?: string | null;
  recoveryPriority?: number;
}

export interface DayPlanStep {
  op: string;
  action: GameAction;
  why: string;
  configurationId?: string;
}

export interface DayPlan {
  id: string;
  steps: DayPlanStep[];
  configurations: EventConfiguration[];
  scoreVector: number[];
  confidence: number;
  unknowns: string[];
  risks: string[];
  preservedOptions: string[];
  rationale: string;
}

export interface Prediction {
  id: string;
  at: string;
  planId?: string | null;
  stepIndex?: number | null;
  action: GameAction;
  actionSignature: string;
  contextSignature: string;
  version: StrategyVersionKey;
  expected: {
    resourceDeltas?: Record<string, number | null>;
    cardConsumptions?: Array<{ cardId?: number | null; count?: number }>;
    eventTransitions?: string[];
    lockTurns?: number | null;
    screenPhase?: string | null;
  };
  uncertain: string[];
}

export interface StateDelta {
  changed: boolean;
  day?: { before?: number | null; after?: number | null };
  terminal?: { before?: boolean | null; after?: boolean | null };
  resources?: Record<string, { before?: number | null; after?: number | null; delta?: number | null }>;
  counters?: Record<string, { before?: number | null; after?: number | null; delta?: number | null }>;
  cards?: {
    added?: Array<{ uid?: number | null; id?: number | null; name?: string | null }>;
    removed?: Array<{ uid?: number | null; id?: number | null; name?: string | null }>;
    changed?: Array<{
      uid?: number | null;
      id?: number | null;
      fields?: Record<string, { before?: unknown; after?: unknown }>;
    }>;
  };
  rites?: {
    added?: Array<{ uid?: number | null; id?: number | null; name?: string | null }>;
    removed?: Array<{ uid?: number | null; id?: number | null; name?: string | null }>;
    changed?: Array<{
      uid?: number | null;
      id?: number | null;
      fields?: Record<string, { before?: unknown; after?: unknown }>;
    }>;
  };
  events?: {
    beforeCount?: number;
    afterCount?: number;
    labelsBefore?: string[];
    labelsAfter?: string[];
  };
  questSummary?: { before?: unknown; after?: unknown };
  currentRite?: { before?: unknown; after?: unknown };
}

export interface ExperienceRecord {
  id: string;
  status: ExperienceStatus;
  version: StrategyVersionKey;
  actionSignature: string;
  contextSignature: string;
  eventFeatures: EventFeature[];
  cardFeatures: CardFeature[];
  prediction?: Prediction | null;
  actualDelta?: StateDelta | null;
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

export interface StrategyEngineOutput {
  snapshot: StrategySnapshot;
  candidates: DayPlan[];
  /** Place/open/execute configs used to build candidates (for day-close ledger). */
  configurations?: EventConfiguration[];
  /** Retrieved experiences attached during planning (for day-close scoring). */
  experiences?: unknown[];
  recommendedPlanId?: string | null;
  firstAction?: GameAction | null;
  retrievalNotes: string[];
  builtFrom: {
    stateDay?: number | null;
    sceneVersion?: number | null;
    experienceCount: number;
    entityKnowledgeCount?: number;
  };
}

export interface StrategyReviewRequest {
  snapshot: StrategySnapshot;
  candidates: DayPlan[];
  relatedExperiences: ExperienceRecord[];
}

/** One reported / observed card→slot assignment for day-close review. */
export interface DayCloseAssignment {
  cardUid: number;
  riteUid: number;
  slotIndex: number;
  card?: CardFeature;
  count?: number | null;
}

export type DayCloseIssueSeverity = "hard" | "soft";

export type DayCloseIssueCode =
  | "idle_reusable_positive_slot"
  | "allocation_drift"
  | "must_break_sudan_today"
  | "sudan_branch_test_recommended"
  | "sudan_route_probe_pending"
  | "sudan_exchange_available"
  | "sudan_exchange_tier_regression"
  | "stale_allocation"
  | "score_improvement"
  | "evidence_incomplete";

export interface DayCloseIssue {
  severity: DayCloseIssueSeverity;
  code: DayCloseIssueCode;
  message: string;
  cardUid?: number;
  riteUid?: number;
  slotIndex?: number;
  recommendedOps?: string[];
}

export type DayCloseDiffKind = "add" | "remove" | "move" | "swap";

export interface DayCloseDiffMove {
  kind: DayCloseDiffKind;
  cardUid: number;
  from?: { riteUid: number; slotIndex: number };
  to?: { riteUid: number; slotIndex: number };
  why?: string;
}

export type DayCloseEvidenceCompleteness = "full" | "partial" | "none";

export interface DayCloseReviewResult {
  schemaVersion: 1;
  day: number | null;
  ok: boolean;
  /** True when hard issues are empty (soft improvements may still exist). */
  canAdvanceDay: boolean;
  hardIssues: DayCloseIssue[];
  softIssues: DayCloseIssue[];
  currentScore: number[];
  bestScore: number[];
  /** compareScoreVectors(current, best): <0 current better, >0 best better. */
  lexCompare: number;
  moves: DayCloseDiffMove[];
  suggestedFirstAction?: GameAction | null;
  evidenceCompleteness: DayCloseEvidenceCompleteness;
  confidence: number;
  summary: string;
  bestPlanId?: string | null;
}

/** Per-day ledger of place configs observed while opening rites. */
export interface DayCandidateLedger {
  schemaVersion: 1;
  day: number | null;
  /** Deduped place / open configs keyed by configuration id. */
  configurationsById: Record<string, EventConfiguration>;
  /** Rite uids whose place affordances were captured at least once. */
  capturedRiteUids: number[];
  updatedAt: string;
}

export function emptyStateDelta(): StateDelta {
  return { changed: false };
}

export function buildStrategyContext(
  state: GameState | null | undefined,
  scene: SceneSnapshot | null | undefined,
): { state: GameState | null; scene: SceneSnapshot | null } {
  return { state: state ?? null, scene: scene ?? null };
}
