import type { GameAction } from "../game/types.js";

/** HUD footer metrics (same shape as AgentLlmStats). */
export interface ReplayHudStats {
  step?: number;
  totalTokens?: number;
  prefillTokens?: number;
  decodeTokens?: number;
  prefillTokPerSec?: number | null;
  decodeTokPerSec?: number | null;
  elapsedMs?: number;
  firstTokenMs?: number | null;
}

export interface ReplayDecision {
  title: string;
  goal: string;
  why: string;
  actions: string[];
  thinking: string;
  mood: string;
  /** Optional HUD status footer; filled by annotate-replay. */
  stats?: ReplayHudStats;
}

export interface ReplayStepSource {
  sequence: number;
  phase: string;
  method: string;
}

export interface ReplayStep {
  index: number;
  source: ReplayStepSource;
  action: GameAction;
  decision: ReplayDecision;
  note?: string;
}

export interface ReplayDocument {
  version: 1;
  id: string;
  sourceRecordingPath: string;
  createdAt: string;
  prompt?: string;
  /**
   * Episode narrative / moral motive. Annotate MUST ground every bubble in this brief
   * (e.g. save 还书的少女 with 石级奢靡 — do not harm her with arbitrary Sudan cards).
   */
  motive?: string;
  steps: ReplayStep[];
}

export interface RecordedCall {
  sequence: number;
  at?: string;
  frame?: number;
  phase: string;
  method: string;
  data?: Record<string, unknown>;
}

export interface RecordingDocument {
  id?: string;
  filePath?: string;
  events?: RecordedCall[];
  initialState?: unknown;
  [key: string]: unknown;
}

export function emptyDecision(): ReplayDecision {
  return {
    title: "",
    goal: "",
    why: "",
    actions: [],
    thinking: "",
    mood: "",
    stats: {},
  };
}

export function isDecisionFilled(decision: ReplayDecision): boolean {
  return typeof decision.title === "string" && decision.title.trim().length > 0;
}
