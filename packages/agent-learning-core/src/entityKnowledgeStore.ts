import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  MemoryAuditLog,
  snapshotHash,
  type AuditContext,
  type MemoryAuditAction,
  type MemoryEntityKind,
} from "./audit.js";
import type {
  EntityKnowledgeRecord,
  KnowledgeEvidence,
  KnowledgeOutcome,
  KnowledgeStatus,
  KnowledgeVersionKey,
} from "./types.js";

export interface EntityKnowledgeStoreFile {
  version: 1;
  entities: EntityKnowledgeRecord[];
}

export interface EntityKnowledgeStoreOptions {
  fileName: string;
  entityKind: Extract<MemoryEntityKind, "card" | "event" | "interaction">;
  evidenceCap?: number;
  minValidatedSamples?: number;
}

export interface TouchEntityKnowledgeInput {
  key: string;
  kind: string;
  version: KnowledgeVersionKey;
  facts?: Record<string, unknown>;
  runId?: string;
}

export interface AddKnowledgeEvidenceInput {
  outcome: KnowledgeOutcome;
  summary: string;
  context?: Record<string, unknown>;
  sourceId?: string;
  runId?: string;
  capturedAt?: string;
}

function versionsMatch(a: KnowledgeVersionKey, b: KnowledgeVersionKey): boolean {
  return (
    a.gameFingerprint === b.gameFingerprint &&
    a.configFingerprint === b.configFingerprint
  );
}

function confidenceFor(sampleCount: number, positiveCount: number, negativeCount: number): number {
  if (sampleCount <= 0) return 0;
  const ratio = positiveCount / sampleCount;
  const coverage = Math.min(1, sampleCount / 5);
  const contradictionPenalty = Math.min(0.4, negativeCount / sampleCount);
  return Math.max(0, Math.min(1, ratio * 0.7 + coverage * 0.3 - contradictionPenalty));
}

function statusFor(
  record: Pick<
    EntityKnowledgeRecord,
    "sampleCount" | "positiveCount" | "negativeCount" | "confidence"
  >,
  minValidatedSamples: number,
): KnowledgeStatus {
  if (
    record.sampleCount >= 2 &&
    record.negativeCount >= Math.max(1, record.positiveCount)
  ) {
    return "contradicted";
  }
  if (
    record.sampleCount >= minValidatedSamples &&
    record.confidence >= 0.65 &&
    record.positiveCount > record.negativeCount
  ) {
    return "validated";
  }
  if (record.sampleCount >= 1) return "provisional";
  return "observed";
}

export class EntityKnowledgeStore {
  readonly filePath: string;
  readonly audit: MemoryAuditLog;
  readonly options: Required<EntityKnowledgeStoreOptions>;

  constructor(memoryDir: string, options: EntityKnowledgeStoreOptions) {
    this.options = {
      ...options,
      evidenceCap: options.evidenceCap ?? 40,
      minValidatedSamples: options.minValidatedSamples ?? 3,
    };
    fs.mkdirSync(memoryDir, { recursive: true });
    this.filePath = path.join(memoryDir, options.fileName);
    this.audit = new MemoryAuditLog(memoryDir);
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, {
        version: 1,
        entities: [],
      } satisfies EntityKnowledgeStoreFile);
    }
  }

  list(): EntityKnowledgeRecord[] {
    return this.load().entities;
  }

  get(key: string, version?: KnowledgeVersionKey): EntityKnowledgeRecord | undefined {
    return this.list().find(
      (record) =>
        record.key === key && (!version || versionsMatch(record.version, version)),
    );
  }

  listCompatible(version: KnowledgeVersionKey): EntityKnowledgeRecord[] {
    return this.list().filter((record) => versionsMatch(record.version, version));
  }

  touch(
    input: TouchEntityKnowledgeInput,
    context: AuditContext = {},
  ): EntityKnowledgeRecord {
    const existing = this.get(input.key, input.version);
    if (existing) {
      const updated: EntityKnowledgeRecord = {
        ...existing,
        facts: { ...existing.facts, ...(input.facts ?? {}) },
        encounterCount: existing.encounterCount + 1,
        updatedAt: new Date().toISOString(),
        lastRunId: input.runId ?? existing.lastRunId,
      };
      this.persist(existing, updated, "updated", context);
      return updated;
    }

    const now = new Date().toISOString();
    const record: EntityKnowledgeRecord = {
      id: newKnowledgeId(this.options.entityKind),
      key: input.key,
      kind: input.kind,
      status: "observed",
      version: input.version,
      facts: input.facts ?? {},
      encounterCount: 1,
      sampleCount: 0,
      positiveCount: 0,
      negativeCount: 0,
      confidence: 0,
      evidence: [],
      createdAt: now,
      updatedAt: now,
      lastRunId: input.runId,
    };
    this.persist(undefined, record, "created", context);
    return record;
  }

  upsertFacts(
    key: string,
    version: KnowledgeVersionKey,
    facts: Record<string, unknown>,
    context: AuditContext = {},
  ): EntityKnowledgeRecord | undefined {
    const current = this.get(key, version);
    if (!current) return undefined;
    const updated: EntityKnowledgeRecord = {
      ...current,
      facts: { ...current.facts, ...facts },
      updatedAt: new Date().toISOString(),
    };
    this.persist(current, updated, "semantic_revised", context, { facts });
    return updated;
  }

  addEvidence(
    key: string,
    version: KnowledgeVersionKey,
    input: AddKnowledgeEvidenceInput,
    context: AuditContext = {},
  ): EntityKnowledgeRecord | undefined {
    const current = this.get(key, version);
    if (!current) return undefined;
    const evidence: KnowledgeEvidence = {
      id: newEvidenceId(),
      outcome: input.outcome,
      summary: input.summary,
      context: input.context,
      sourceId: input.sourceId,
      runId: input.runId,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
    };
    const decisive = input.outcome !== "inconclusive";
    const updated: EntityKnowledgeRecord = {
      ...current,
      sampleCount: current.sampleCount + (decisive ? 1 : 0),
      positiveCount: current.positiveCount + (input.outcome === "positive" ? 1 : 0),
      negativeCount: current.negativeCount + (input.outcome === "negative" ? 1 : 0),
      evidence: [...current.evidence, evidence].slice(-this.options.evidenceCap),
      updatedAt: new Date().toISOString(),
      lastRunId: input.runId ?? current.lastRunId,
    };
    updated.confidence = confidenceFor(
      updated.sampleCount,
      updated.positiveCount,
      updated.negativeCount,
    );
    updated.status = statusFor(updated, this.options.minValidatedSamples);
    this.persist(current, updated, "evidence_updated", context, { evidence });
    return updated;
  }

  setStatus(
    key: string,
    version: KnowledgeVersionKey,
    status: KnowledgeStatus,
    context: AuditContext = {},
  ): EntityKnowledgeRecord | undefined {
    const current = this.get(key, version);
    if (!current || current.status === status) return current;
    const updated = { ...current, status, updatedAt: new Date().toISOString() };
    this.persist(current, updated, "status_changed", context);
    return updated;
  }

  retrieveByKeys(opts: {
    version: KnowledgeVersionKey;
    keys: string[];
    statuses?: KnowledgeStatus[];
    limit?: number;
  }): EntityKnowledgeRecord[] {
    const keyOrder = new Map(opts.keys.map((key, index) => [key, index]));
    const statuses = opts.statuses ? new Set(opts.statuses) : null;
    return this.listCompatible(opts.version)
      .filter((record) => keyOrder.has(record.key))
      .filter((record) => !statuses || statuses.has(record.status))
      .sort(
        (a, b) =>
          (keyOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
            (keyOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER) ||
          b.confidence - a.confidence ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, opts.limit ?? 8);
  }

  private load(): EntityKnowledgeStoreFile {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<EntityKnowledgeStoreFile>;
      return {
        version: 1,
        entities: Array.isArray(raw.entities) ? raw.entities : [],
      };
    } catch {
      return { version: 1, entities: [] };
    }
  }

  private persist(
    before: EntityKnowledgeRecord | undefined,
    after: EntityKnowledgeRecord,
    action: MemoryAuditAction,
    context: AuditContext,
    patch?: Record<string, unknown>,
  ): void {
    const file = this.load();
    const index = file.entities.findIndex((record) => record.id === after.id);
    if (index >= 0) file.entities[index] = after;
    else file.entities.push(after);
    atomicWriteJson(this.filePath, file);
    this.audit.append({
      entityKind: this.options.entityKind,
      entityId: after.id,
      action,
      actor: context.actor ?? "entity_knowledge_store",
      reason: context.reason ?? action,
      runId: context.runId ?? after.lastRunId,
      batchId: context.batchId,
      before,
      after,
      patch,
      snapshotHash: snapshotHash(file),
    });
  }
}

function newKnowledgeId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function newEvidenceId(): string {
  return `kev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
