import type {
  EntityKnowledgeRecord,
  KnowledgeStatus,
  KnowledgeVersionKey,
} from "@vibesultan/agent-learning-core";
import type { SlotFeature } from "../game/strategyTypes.js";

export type EntityIdentityQuality = "stable" | "derived";
export type SultanEventKind = "rite" | "choice";

export interface CardKnowledgeFacts extends Record<string, unknown> {
  cardId: number;
  name?: string | null;
  type?: string | null;
  rare?: number | null;
  description?: string | null;
  /** Compact non-zero attribute/identity tags, e.g. { 智慧: 2, 贵族: 1 }. */
  tags?: Record<string, number>;
  reusable?: boolean | null;
  usages?: string[];
  antiPatterns?: string[];
  unknowns?: string[];
}

export interface EventOptionKnowledge {
  index: number;
  label?: string | null;
  outcome?: "positive" | "negative" | "inconclusive";
  note?: string;
}

export interface EventKnowledgeFacts extends Record<string, unknown> {
  eventKey: string;
  eventKind: SultanEventKind;
  riteId?: number | null;
  name?: string | null;
  prompt?: string | null;
  identityQuality: EntityIdentityQuality;
  life?: number | null;
  slots?: SlotFeature[];
  options?: EventOptionKnowledge[];
  successfulRoutes?: string[];
  failureModes?: string[];
  unknowns?: string[];
}

export interface InteractionKnowledgeFacts extends Record<string, unknown> {
  interactionKey: string;
  cardId: number;
  eventKey: string;
  slotIndex?: number | null;
  slotKey?: string | null;
  optionIndex?: number | null;
  conditions?: string[];
  expectedOutcome?: string | null;
  bestPractices?: string[];
  failureModes?: string[];
}

export type CardKnowledgeRecord = EntityKnowledgeRecord & {
  kind: "card";
  facts: CardKnowledgeFacts;
};

export type EventKnowledgeRecord = EntityKnowledgeRecord & {
  kind: "event";
  facts: EventKnowledgeFacts;
};

export type InteractionKnowledgeRecord = EntityKnowledgeRecord & {
  kind: "interaction";
  facts: InteractionKnowledgeFacts;
};

export type {
  EntityKnowledgeRecord,
  KnowledgeStatus,
  KnowledgeVersionKey,
};
