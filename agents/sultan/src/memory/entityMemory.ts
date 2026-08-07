import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EntityKnowledgeStore,
  type ExperienceRecord,
  type KnowledgeVersionKey,
} from "@vibesultan/agent-learning-core";
import { FingerprintAliasStore } from "./fingerprintAlias.js";

export interface SultanEntityStores {
  cards: EntityKnowledgeStore;
  events: EntityKnowledgeStore;
  interactions: EntityKnowledgeStore;
  fingerprints: FingerprintAliasStore;
}

export function createSultanEntityStores(
  sessionDir: string,
  minValidatedSamples = 3,
): SultanEntityStores {
  return {
    cards: new EntityKnowledgeStore(sessionDir, {
      fileName: "cards.json",
      entityKind: "card",
      minValidatedSamples,
    }),
    events: new EntityKnowledgeStore(sessionDir, {
      fileName: "events.json",
      entityKind: "event",
      minValidatedSamples,
    }),
    interactions: new EntityKnowledgeStore(sessionDir, {
      fileName: "interactions.json",
      entityKind: "interaction",
      minValidatedSamples,
    }),
    fingerprints: new FingerprintAliasStore(sessionDir),
  };
}

export function cardKnowledgeKey(configFingerprint: string, cardId: number): string {
  return `${configFingerprint}:card:${cardId}`;
}

export function riteEventKey(configFingerprint: string, riteId: number): string {
  return `${configFingerprint}:rite:${riteId}`;
}

export function choiceEventKey(
  configFingerprint: string,
  prompt: string | null | undefined,
  labels: Array<string | null | undefined>,
): string {
  const normalized = [prompt ?? "", ...labels]
    .map((value) => normalizeIdentityText(value ?? ""))
    .join("|");
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${configFingerprint}:choice:${digest}`;
}

export function interactionKnowledgeKey(opts: {
  configFingerprint: string;
  cardId: number;
  eventKey: string;
  slotIndex?: number | null;
  slotKey?: string | null;
  optionIndex?: number | null;
}): string {
  const target =
    opts.optionIndex != null
      ? `option:${opts.optionIndex}`
      : `slot:${opts.slotKey ?? opts.slotIndex ?? "unknown"}`;
  return `${opts.configFingerprint}:interaction:${opts.cardId}:${hashKey(opts.eventKey)}:${target}`;
}

/** Populate stable entity skeletons from legacy experiences without inventing semantics. */
export function backfillEntitySkeletons(sessionDir: string): {
  cards: number;
  events: number;
} {
  const experiencePath = path.join(sessionDir, "experiences.json");
  const stores = createSultanEntityStores(sessionDir);
  if (!fs.existsSync(experiencePath)) return { cards: 0, events: 0 };

  let experiences: ExperienceRecord[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(experiencePath, "utf8")) as {
      experiences?: ExperienceRecord[];
    };
    experiences = Array.isArray(raw.experiences) ? raw.experiences : [];
  } catch {
    return { cards: 0, events: 0 };
  }

  let cards = 0;
  let events = 0;
  for (const experience of experiences) {
    const version = experience.version;
    for (const raw of experience.cardFeatures ?? []) {
      const cardId = finiteNumber(raw.cardId ?? raw.id);
      if (cardId == null) continue;
      const key = cardKnowledgeKey(version.configFingerprint, cardId);
      if (stores.cards.get(key, version)) continue;
      stores.cards.touch({
        key,
        kind: "card",
        version,
        facts: {
          cardId,
          name: stringValue(raw.name),
          type: stringValue(raw.type),
          rare: finiteNumber(raw.rare),
          unknowns: ["usage_unknown"],
        },
        runId: experience.lastRunId,
      }, {
        actor: "entity_backfill",
        reason: "legacy_experience_card_skeleton",
        runId: experience.lastRunId,
      });
      cards += 1;
    }
    for (const raw of experience.eventFeatures ?? []) {
      const riteId = finiteNumber(raw.riteId ?? raw.id);
      if (riteId == null) continue;
      const key = riteEventKey(version.configFingerprint, riteId);
      if (stores.events.get(key, version)) continue;
      stores.events.touch({
        key,
        kind: "event",
        version,
        facts: {
          eventKey: key,
          eventKind: "rite",
          riteId,
          name: stringValue(raw.name),
          identityQuality: "stable",
          life: finiteNumber(raw.life),
          unknowns: ["route_unknown"],
        },
        runId: experience.lastRunId,
      }, {
        actor: "entity_backfill",
        reason: "legacy_experience_event_skeleton",
        runId: experience.lastRunId,
      });
      events += 1;
    }
  }
  return { cards, events };
}

function normalizeIdentityText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function compatibleVersion(
  gameFingerprint: string | null | undefined,
  configFingerprint: string | null | undefined,
): KnowledgeVersionKey {
  return {
    gameFingerprint: gameFingerprint?.trim() || configFingerprint?.trim() || "unknown-config",
    configFingerprint: configFingerprint?.trim() || "unknown-config",
  };
}
