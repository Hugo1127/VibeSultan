/**
 * Rebuild deterministic rite episode outcomes from experiences + state deltas.
 *
 * Default is dry-run. Write only with:
 *   npx tsx scripts/backfill-entity-outcomes.ts --apply --memory <session-id>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExperienceRecord } from "@vibesultan/agent-learning-core";
import { applyRiteSettlement } from "../src/memory/entityAdapter.js";
import {
  cardKnowledgeKey,
  createSultanEntityStores,
  interactionKnowledgeKey,
  riteEventKey,
} from "../src/memory/entityMemory.js";
import { EpisodeStore } from "../src/memory/episodeStore.js";
import { EpisodeTracker } from "../src/memory/episodeTracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultMemoryRoot = path.resolve(__dirname, "../memory");

function parseArgs(argv: string[]): {
  apply: boolean;
  memory?: string;
  memoryRoot: string;
} {
  let apply = false;
  let memory: string | undefined;
  let memoryRoot = defaultMemoryRoot;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--memory") memory = argv[++i];
    else if (arg === "--memory-root") memoryRoot = path.resolve(argv[++i] ?? "");
  }
  return { apply, memory, memoryRoot };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function loadExperiences(sessionDir: string): ExperienceRecord[] {
  const filePath = path.join(sessionDir, "experiences.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      experiences?: ExperienceRecord[];
    };
    return Array.isArray(raw.experiences) ? raw.experiences : [];
  } catch {
    return [];
  }
}

function looksLikeHudDump(text: string): boolean {
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 6 || text.length > 420) return true;
  return (text.match(/金币|影响力|回合|天数|手牌|苏丹|继续|下一天/g) ?? []).length >= 3;
}

function extractRiteResult(experience: ExperienceRecord): Record<string, unknown> | null {
  const delta = isRecord(experience.actualDelta) ? experience.actualDelta : null;
  if (delta && isRecord(delta.riteResult)) {
    return flattenDelta(delta.riteResult);
  }
  for (const note of experience.notes ?? []) {
    if (typeof note !== "string") continue;
    const match = note.match(/success(?:Count)?\s*[:=]\s*(\d+).*threshold\s*[:=]\s*(\d+)/i);
    if (match) {
      return {
        successCount: Number(match[1]),
        successThreshold: Number(match[2]),
        active: true,
      };
    }
  }
  return null;
}

function flattenDelta(delta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { active: true };
  for (const [key, value] of Object.entries(delta)) {
    if (isRecord(value) && "after" in value) out[key] = value.after;
    else out[key] = value;
  }
  return out;
}

function riteIdFromExperience(experience: ExperienceRecord): number | null {
  for (const feature of experience.eventFeatures ?? []) {
    const riteId = asNumber(feature.riteId) ?? asNumber(feature.id);
    if (riteId != null) return riteId;
  }
  const contextMatch = experience.contextSignature?.match(/currentRite=(\d+)/);
  if (contextMatch) return Number(contextMatch[1]);
  return null;
}

function compositionFromExperience(
  experience: ExperienceRecord,
  eventKey: string,
  fp: string,
): Array<{
  cardId: number;
  slotIndex: number;
  slotKey: string | null;
  interactionKey: string;
}> {
  const cards = (experience.cardFeatures ?? [])
    .map((feature) => asNumber(feature.cardId) ?? asNumber(feature.id))
    .filter((id): id is number => id != null);
  if (cards.length === 0) return [];
  return cards.map((cardId, index) => {
    const slotIndex = index;
    const slotKey = null;
    return {
      cardId,
      slotIndex,
      slotKey,
      interactionKey: interactionKnowledgeKey({
        configFingerprint: fp,
        cardId,
        eventKey,
        slotIndex,
        slotKey,
      }),
    };
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.memory) {
    console.error(
      "Usage: backfill-entity-outcomes.ts --memory <id> [--apply] [--memory-root <dir>]",
    );
    process.exit(1);
  }
  const sessionDir = path.join(args.memoryRoot, "sessions", args.memory);
  if (!fs.existsSync(sessionDir)) {
    console.error(`session not found: ${sessionDir}`);
    process.exit(1);
  }

  const stores = createSultanEntityStores(sessionDir);
  const experiences = loadExperiences(sessionDir);
  const report = {
    sessionDir,
    apply: args.apply,
    experiences: experiences.length,
    fingerprintAliases: [] as Array<{ from: string; to: string }>,
    cleanedDescriptions: [] as string[],
    rebuiltSettlements: [] as Array<Record<string, unknown>>,
    skipped: [] as string[],
  };

  // Prefer the latest non-unknown fingerprint as canonical (cold-start → full catalog).
  const seenFingerprints: string[] = [];
  for (const experience of experiences) {
    const fp = experience.version?.configFingerprint?.trim();
    if (!fp || fp === "unknown-config") continue;
    if (!seenFingerprints.includes(fp)) seenFingerprints.push(fp);
  }
  const canonical = [...seenFingerprints].reverse()[0];
  if (canonical) {
    for (const fp of seenFingerprints) stores.fingerprints.observe(fp);
    for (const fp of seenFingerprints) {
      if (fp === canonical) continue;
      report.fingerprintAliases.push({ from: fp, to: canonical });
      if (args.apply) mergeFingerprintSkeletons(stores, fp, canonical);
    }
  }

  for (const card of stores.cards.list()) {
    const description = asString(card.facts.description);
    if (!description || !looksLikeHudDump(description)) continue;
    report.cleanedDescriptions.push(card.key);
    if (args.apply) {
      stores.cards.upsertFacts(
        card.key,
        card.version,
        { description: "", unknowns: ["usage_unknown"] },
        { actor: "backfill_entity_outcomes", reason: "clear_hud_description" },
      );
    }
  }

  const tracker = new EpisodeTracker(new EpisodeStore(sessionDir));
  for (const experience of experiences) {
    if (!String(experience.actionSignature ?? "").includes("execute")) continue;
    const riteResult = extractRiteResult(experience);
    if (!riteResult) {
      report.skipped.push(`${experience.id}: no structured riteResult`);
      continue;
    }
    const success = asNumber(riteResult.successCount);
    const threshold = asNumber(riteResult.successThreshold);
    if (success == null || threshold == null) {
      report.skipped.push(`${experience.id}: inconclusive riteResult`);
      continue;
    }
    const riteId = riteIdFromExperience(experience);
    if (riteId == null) {
      report.skipped.push(`${experience.id}: missing riteId`);
      continue;
    }
    const fp = stores.fingerprints.resolve(experience.version.configFingerprint);
    const eventKey = riteEventKey(fp, riteId);
    const outcome = success >= threshold ? "positive" : "negative";
    const summary = `outcome=${outcome} | success=${success} | threshold=${threshold}`;
    const composition = compositionFromExperience(experience, eventKey, fp);
    report.rebuiltSettlements.push({
      experienceId: experience.id,
      eventKey,
      outcome,
      composition: composition.length,
      summary,
    });
    if (!args.apply) continue;

    const version = {
      ...experience.version,
      configFingerprint: fp,
    };
    ensureEventSkeleton(stores, eventKey, version, riteId, experience.lastRunId);
    for (const assignment of composition) {
      ensureCardSkeleton(stores, assignment.cardId, version, experience.lastRunId);
      ensureInteractionSkeleton(stores, assignment, eventKey, version, experience.lastRunId);
    }
    const episode = tracker.recordSubmit({
      version,
      eventKey,
      riteId,
      composition,
      experienceId: experience.id,
      runId: experience.lastRunId,
    });
    const settled = tracker.store.update(episode.id, {
      phase: "awaiting_result",
      outcome,
      settlement: { ...riteResult, summary },
      composition: composition.length ? composition : episode.composition,
      applied: false,
    });
    if (!settled || settled.applied) continue;
    applyRiteSettlement({
      stores,
      settlement: {
        episode: settled,
        outcome,
        summary,
        result: riteResult,
      },
      runId: experience.lastRunId,
    });
    tracker.markApplied(settled.id);
  }

  console.log(JSON.stringify(report, null, 2));
  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to write.");
  }
}

function mergeFingerprintSkeletons(
  stores: ReturnType<typeof createSultanEntityStores>,
  fromFp: string,
  toFp: string,
): void {
  for (const store of [stores.cards, stores.events, stores.interactions]) {
    for (const record of store.list()) {
      if (record.version.configFingerprint !== fromFp) continue;
      if (record.sampleCount > 0) continue;
      const targetKey = stores.fingerprints.rewriteKey(record.key, toFp);
      const version = {
        ...record.version,
        configFingerprint: toFp,
      };
      if (store.get(targetKey, version)) continue;
      store.touch(
        {
          key: targetKey,
          kind: record.kind,
          version,
          facts: {
            ...record.facts,
            ...(record.kind === "event" ? { eventKey: targetKey } : {}),
            ...(record.kind === "interaction"
              ? {
                  interactionKey: targetKey,
                  eventKey: isRecord(record.facts)
                    ? stores.fingerprints.rewriteKey(
                        String(record.facts.eventKey ?? ""),
                        toFp,
                      )
                    : undefined,
                }
              : {}),
            aliases: [record.key],
          },
          runId: record.lastRunId,
        },
        {
          actor: "backfill_entity_outcomes",
          reason: "fingerprint_alias_merge",
          runId: record.lastRunId,
        },
      );
    }
  }
}

function ensureEventSkeleton(
  stores: ReturnType<typeof createSultanEntityStores>,
  eventKey: string,
  version: { gameFingerprint: string; configFingerprint: string },
  riteId: number,
  runId?: string,
): void {
  if (stores.events.get(eventKey, version)) return;
  stores.events.touch(
    {
      key: eventKey,
      kind: "event",
      version,
      facts: {
        eventKey,
        eventKind: "rite",
        riteId,
        unknowns: ["route_unknown"],
      },
      runId,
    },
    { actor: "backfill_entity_outcomes", reason: "ensure_event", runId },
  );
}

function ensureCardSkeleton(
  stores: ReturnType<typeof createSultanEntityStores>,
  cardId: number,
  version: { gameFingerprint: string; configFingerprint: string },
  runId?: string,
): void {
  const key = cardKnowledgeKey(version.configFingerprint, cardId);
  if (stores.cards.get(key, version)) return;
  stores.cards.touch(
    {
      key,
      kind: "card",
      version,
      facts: { cardId, unknowns: ["usage_unknown"] },
      runId,
    },
    { actor: "backfill_entity_outcomes", reason: "ensure_card", runId },
  );
}

function ensureInteractionSkeleton(
  stores: ReturnType<typeof createSultanEntityStores>,
  assignment: {
    interactionKey: string;
    cardId: number;
    slotIndex: number;
    slotKey: string | null;
  },
  eventKey: string,
  version: { gameFingerprint: string; configFingerprint: string },
  runId?: string,
): void {
  if (stores.interactions.get(assignment.interactionKey, version)) return;
  stores.interactions.touch(
    {
      key: assignment.interactionKey,
      kind: "interaction",
      version,
      facts: {
        interactionKey: assignment.interactionKey,
        cardId: assignment.cardId,
        eventKey,
        slotIndex: assignment.slotIndex,
        slotKey: assignment.slotKey,
      },
      runId,
    },
    { actor: "backfill_entity_outcomes", reason: "ensure_interaction", runId },
  );
}

main();
