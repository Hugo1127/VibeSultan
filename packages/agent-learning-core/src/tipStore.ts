import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  MemoryAuditLog,
  snapshotHash,
  type AuditContext,
  type MemoryAuditAction,
} from "./audit.js";
import type { Tip, TipEvidence, TipStatus } from "./types.js";

export interface TipStoreFile {
  version: 1;
  tips: Tip[];
}

export interface TipEvidenceDelta {
  observations?: number;
  positives?: number;
  negatives?: number;
  netValues?: number[];
  sessionIndex: number;
}

export interface CreateTipInput {
  decisionKey: string;
  title: string;
  body: string;
  sourceInstanceId: string;
  sourceHypothesisId?: string;
  status?: TipStatus;
}

function emptyTipEvidence(): TipEvidence {
  return {
    observationCount: 0,
    positiveCount: 0,
    negativeCount: 0,
    netValueSum: 0,
  };
}

export class TipStore {
  readonly filePath: string;
  readonly audit: MemoryAuditLog;

  constructor(memoryDir: string) {
    fs.mkdirSync(memoryDir, { recursive: true });
    this.filePath = path.join(memoryDir, "tips.json");
    this.audit = new MemoryAuditLog(memoryDir);
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, { version: 1, tips: [] } satisfies TipStoreFile);
    }
  }

  list(): Tip[] {
    return this.load().tips;
  }

  get(id: string): Tip | undefined {
    return this.list().find((tip) => tip.id === id);
  }

  create(input: CreateTipInput, context: AuditContext = {}): Tip {
    const now = new Date().toISOString();
    const tip: Tip = {
      id: newTipId(),
      status: input.status ?? "candidate",
      decisionKey: input.decisionKey,
      title: input.title.trim(),
      body: input.body.trim(),
      sourceInstanceId: input.sourceInstanceId,
      sourceHypothesisId: input.sourceHypothesisId,
      evidence: emptyTipEvidence(),
      createdAt: now,
      updatedAt: now,
    };
    this.persist(undefined, tip, "created", context);
    return tip;
  }

  addEvidence(
    id: string,
    delta: TipEvidenceDelta,
    context: AuditContext = {},
  ): Tip | undefined {
    const current = this.get(id);
    if (!current || terminalTip(current.status)) return undefined;
    const values = (delta.netValues ?? []).filter(Number.isFinite);
    const updated: Tip = {
      ...current,
      evidence: {
        observationCount:
          current.evidence.observationCount + finiteInt(delta.observations),
        positiveCount:
          current.evidence.positiveCount + finiteInt(delta.positives),
        negativeCount:
          current.evidence.negativeCount + finiteInt(delta.negatives),
        netValueSum:
          current.evidence.netValueSum + values.reduce((a, b) => a + b, 0),
        lastUpdatedSessionIndex: delta.sessionIndex,
      },
      updatedAt: new Date().toISOString(),
    };
    this.persist(current, updated, "evidence_updated", {
      ...context,
      reason: context.reason ?? "evidence_accumulated",
    }, { delta });
    return updated;
  }

  setStatus(
    id: string,
    status: TipStatus,
    context: AuditContext = {},
  ): Tip | undefined {
    const current = this.get(id);
    if (!current || current.status === status) return current;
    const updated = { ...current, status, updatedAt: new Date().toISOString() };
    this.persist(current, updated, "status_changed", context);
    return updated;
  }

  private persist(
    before: Tip | undefined,
    after: Tip,
    action: MemoryAuditAction,
    context: AuditContext,
    patch?: Record<string, unknown>,
  ): void {
    const file = this.load();
    const index = file.tips.findIndex((tip) => tip.id === after.id);
    const next: TipStoreFile = {
      version: 1,
      tips:
        index >= 0
          ? file.tips.map((tip, i) => (i === index ? after : tip))
          : [...file.tips, after],
    };
    this.audit.append({
      entityKind: "tip",
      entityId: after.id,
      action,
      actor: context.actor ?? "tip_store",
      reason: context.reason ?? action,
      runId: context.runId,
      batchId: context.batchId,
      before:
        action === "semantic_revised" || action === "status_changed"
          ? before
          : undefined,
      after,
      patch,
      snapshotHash: snapshotHash(next),
    });
    atomicWriteJson(this.filePath, next);
  }

  private load(): TipStoreFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<TipStoreFile>;
      return {
        version: 1,
        tips: Array.isArray(parsed.tips) ? parsed.tips : [],
      };
    } catch {
      return { version: 1, tips: [] };
    }
  }
}

function terminalTip(status: TipStatus): boolean {
  return status === "rejected" || status === "superseded";
}

function newTipId(): string {
  return (
    `t_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_` +
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  );
}

function finiteInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}
