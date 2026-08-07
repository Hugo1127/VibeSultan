import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  MemoryAuditLog,
  snapshotHash,
  type AuditContext,
  type MemoryAuditAction,
} from "./audit.js";
import type {
  ExperienceRecord,
  ExperienceStatus,
  ExperienceVersionKey,
} from "./types.js";

export interface ExperienceStoreFile {
  version: 1;
  experiences: ExperienceRecord[];
}

export interface CreateExperienceInput {
  version: ExperienceVersionKey;
  actionSignature: string;
  contextSignature: string;
  eventFeatures?: Record<string, unknown>[];
  cardFeatures?: Record<string, unknown>[];
  prediction?: Record<string, unknown> | null;
  actualDelta?: Record<string, unknown> | null;
  metricsBefore?: Record<string, number | null>;
  metricsAfter?: Record<string, number | null>;
  positive?: boolean;
  notes?: string[];
  runId?: string;
  status?: ExperienceStatus;
}

export interface ExperienceEvidenceDelta {
  positive?: boolean;
  actualDelta?: Record<string, unknown> | null;
  metricsAfter?: Record<string, number | null>;
  notes?: string[];
  runId?: string;
}

function versionsMatch(a: ExperienceVersionKey, b: ExperienceVersionKey): boolean {
  return (
    a.gameFingerprint === b.gameFingerprint &&
    a.configFingerprint === b.configFingerprint
  );
}

function clampConfidence(sampleCount: number, positiveCount: number, negativeCount: number): number {
  if (sampleCount <= 0) return 0;
  const ratio = positiveCount / sampleCount;
  const coverage = Math.min(1, sampleCount / 5);
  const contradictionPenalty = negativeCount > 0 ? Math.min(0.4, negativeCount / sampleCount) : 0;
  return Math.max(0, Math.min(1, ratio * 0.7 + coverage * 0.3 - contradictionPenalty));
}

function promoteStatus(record: ExperienceRecord): ExperienceStatus {
  if (record.negativeCount > 0 && record.negativeCount >= Math.max(1, record.positiveCount)) {
    return "contradicted";
  }
  if (record.sampleCount >= 3 && record.confidence >= 0.65 && record.positiveCount > record.negativeCount) {
    return "validated";
  }
  if (record.sampleCount >= 1) return "provisional";
  return "observed";
}

export class ExperienceStore {
  readonly filePath: string;
  readonly audit: MemoryAuditLog;

  constructor(memoryDir: string) {
    fs.mkdirSync(memoryDir, { recursive: true });
    this.filePath = path.join(memoryDir, "experiences.json");
    this.audit = new MemoryAuditLog(memoryDir);
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, {
        version: 1,
        experiences: [],
      } satisfies ExperienceStoreFile);
    }
  }

  list(): ExperienceRecord[] {
    return this.load().experiences;
  }

  get(id: string): ExperienceRecord | undefined {
    return this.list().find((row) => row.id === id);
  }

  /** Experiences that may influence scoring for this game/config version. */
  listCompatible(version: ExperienceVersionKey): ExperienceRecord[] {
    return this.list().filter(
      (row) =>
        versionsMatch(row.version, version) &&
        row.status !== "contradicted",
    );
  }

  findSimilar(input: {
    version: ExperienceVersionKey;
    actionSignature: string;
    contextSignature?: string;
  }): ExperienceRecord | undefined {
    return this.listCompatible(input.version).find(
      (row) =>
        row.actionSignature === input.actionSignature &&
        (!input.contextSignature || row.contextSignature === input.contextSignature),
    );
  }

  createOrAccumulate(input: CreateExperienceInput, context: AuditContext = {}): ExperienceRecord {
    const existing = this.findSimilar({
      version: input.version,
      actionSignature: input.actionSignature,
      contextSignature: input.contextSignature,
    });
    if (existing) {
      return (
        this.addEvidence(
          existing.id,
          {
            positive: input.positive,
            actualDelta: input.actualDelta,
            metricsAfter: input.metricsAfter,
            notes: input.notes,
            runId: input.runId,
          },
          context,
        ) ?? existing
      );
    }

    const now = new Date().toISOString();
    const positive = input.positive === true ? 1 : 0;
    const negative = input.positive === false ? 1 : 0;
    const sampleCount = input.positive === undefined ? 0 : 1;
    const record: ExperienceRecord = {
      id: newExperienceId(),
      status: input.status ?? (sampleCount > 0 ? "observed" : "observed"),
      version: input.version,
      actionSignature: input.actionSignature,
      contextSignature: input.contextSignature,
      eventFeatures: input.eventFeatures ?? [],
      cardFeatures: input.cardFeatures ?? [],
      prediction: input.prediction ?? null,
      actualDelta: input.actualDelta ?? null,
      metricsBefore: input.metricsBefore,
      metricsAfter: input.metricsAfter,
      sampleCount,
      positiveCount: positive,
      negativeCount: negative,
      confidence: clampConfidence(sampleCount, positive, negative),
      notes: [...(input.notes ?? [])],
      createdAt: now,
      updatedAt: now,
      lastRunId: input.runId,
    };
    record.status = promoteStatus(record);
    this.persist(undefined, record, "created", context);
    return record;
  }

  addEvidence(
    id: string,
    delta: ExperienceEvidenceDelta,
    context: AuditContext = {},
  ): ExperienceRecord | undefined {
    const current = this.get(id);
    if (!current || current.status === "contradicted") return undefined;
    const sampleInc = delta.positive === undefined ? 0 : 1;
    const updated: ExperienceRecord = {
      ...current,
      actualDelta: delta.actualDelta ?? current.actualDelta,
      metricsAfter: delta.metricsAfter ?? current.metricsAfter,
      sampleCount: current.sampleCount + sampleInc,
      positiveCount: current.positiveCount + (delta.positive === true ? 1 : 0),
      negativeCount: current.negativeCount + (delta.positive === false ? 1 : 0),
      notes: delta.notes?.length
        ? [...current.notes, ...delta.notes].slice(-40)
        : current.notes,
      lastRunId: delta.runId ?? current.lastRunId,
      updatedAt: new Date().toISOString(),
    };
    updated.confidence = clampConfidence(
      updated.sampleCount,
      updated.positiveCount,
      updated.negativeCount,
    );
    updated.status = promoteStatus(updated);
    this.persist(current, updated, "evidence_updated", {
      ...context,
      reason: context.reason ?? "experience_evidence",
    }, { delta });
    return updated;
  }

  setStatus(
    id: string,
    status: ExperienceStatus,
    context: AuditContext = {},
  ): ExperienceRecord | undefined {
    const current = this.get(id);
    if (!current || current.status === status) return current;
    const updated = { ...current, status, updatedAt: new Date().toISOString() };
    this.persist(current, updated, "status_changed", context);
    return updated;
  }

  retrieveRelevant(opts: {
    version: ExperienceVersionKey;
    actionSignatures?: string[];
    eventIds?: Array<number | string | null | undefined>;
    cardIds?: Array<number | string | null | undefined>;
    limit?: number;
  }): ExperienceRecord[] {
    const limit = opts.limit ?? 8;
    const eventIdSet = new Set(
      (opts.eventIds ?? [])
        .filter((v) => v !== null && v !== undefined && `${v}`.length > 0)
        .map(String),
    );
    const cardIdSet = new Set(
      (opts.cardIds ?? [])
        .filter((v) => v !== null && v !== undefined && `${v}`.length > 0)
        .map(String),
    );
    const actionSet = new Set(opts.actionSignatures ?? []);

    const scored = this.listCompatible(opts.version)
      .map((row) => {
        let score = row.confidence;
        if (actionSet.has(row.actionSignature)) score += 2;
        for (const ev of row.eventFeatures) {
          const id = ev.riteId ?? ev.id ?? ev.riteUid;
          if (id !== undefined && eventIdSet.has(String(id))) score += 1.2;
        }
        for (const card of row.cardFeatures) {
          const id = card.cardId ?? card.id;
          if (id !== undefined && cardIdSet.has(String(id))) score += 0.8;
        }
        if (row.status === "validated") score += 0.5;
        return { row, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.row.updatedAt.localeCompare(a.row.updatedAt));

    return scored.slice(0, limit).map((x) => x.row);
  }

  private load(): ExperienceStoreFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as ExperienceStoreFile;
      if (!raw || !Array.isArray(raw.experiences)) {
        return { version: 1, experiences: [] };
      }
      return { version: 1, experiences: raw.experiences };
    } catch {
      return { version: 1, experiences: [] };
    }
  }

  private persist(
    before: ExperienceRecord | undefined,
    after: ExperienceRecord,
    action: MemoryAuditAction,
    context: AuditContext,
    patch?: Record<string, unknown>,
  ): void {
    const file = this.load();
    const idx = file.experiences.findIndex((row) => row.id === after.id);
    if (idx >= 0) file.experiences[idx] = after;
    else file.experiences.push(after);
    atomicWriteJson(this.filePath, file);
    this.audit.append({
      entityKind: "experience",
      entityId: after.id,
      action,
      actor: context.actor ?? "experience_store",
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

function newExperienceId(): string {
  return `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
