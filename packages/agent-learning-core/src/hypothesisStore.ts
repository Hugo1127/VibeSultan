import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  MemoryAuditLog,
  snapshotHash,
  type MemoryAuditAction,
} from "./audit.js";
import type {
  Evidence,
  Hypothesis,
  HypothesisStatus,
  MetricSpec,
  NextAction,
  OutcomeClass,
} from "./types.js";

export interface HypothesisStoreFile {
  version: 1;
  hypotheses: Hypothesis[];
}

export interface CreateHypothesisInput {
  claim: string;
  rationale: string;
  constraints: string;
  topicKey: string;
  sourceInstanceId: string;
  sessionIndex: number;
  primaryMetric?: MetricSpec;
  status?: HypothesisStatus;
}

export interface UpdateHypothesisPatch {
  status?: HypothesisStatus;
  claim?: string;
  rationale?: string;
  constraints?: string;
  topicKey?: string;
  evidence?: Partial<Evidence>;
  outcomeClass?: OutcomeClass;
  nextAction?: NextAction;
  primaryMetric?: MetricSpec;
}

function emptyEvidence(): Evidence {
  return {
    observations: [],
    metrics: {},
    notes: [],
    updatedAt: new Date().toISOString(),
  };
}

function emptyStore(): HypothesisStoreFile {
  return { version: 1, hypotheses: [] };
}

export class HypothesisStore {
  readonly filePath: string;
  readonly audit: MemoryAuditLog;

  constructor(memoryDir: string) {
    fs.mkdirSync(memoryDir, { recursive: true });
    this.filePath = path.join(memoryDir, "hypotheses.json");
    this.audit = new MemoryAuditLog(memoryDir);
    if (!fs.existsSync(this.filePath)) {
      this.save(emptyStore());
    }
  }

  load(): HypothesisStoreFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<HypothesisStoreFile>;
      if (!Array.isArray(parsed.hypotheses)) return emptyStore();
      return { version: 1, hypotheses: parsed.hypotheses };
    } catch {
      return emptyStore();
    }
  }

  save(store: HypothesisStoreFile): void {
    atomicWriteJson(this.filePath, store);
  }

  list(): Hypothesis[] {
    return this.load().hypotheses;
  }

  get(id: string): Hypothesis | undefined {
    return this.list().find((h) => h.id === id);
  }

  create(input: CreateHypothesisInput): Hypothesis {
    const now = new Date().toISOString();
    const hypothesis: Hypothesis = {
      id: newHypothesisId(),
      status: input.status ?? (input.primaryMetric ? "candidate" : "backlog"),
      topicKey: input.topicKey,
      claim: input.claim.trim(),
      rationale: input.rationale.trim(),
      constraints: input.constraints.trim(),
      sourceInstanceId: input.sourceInstanceId,
      sessionIndex: Math.max(1, Math.floor(input.sessionIndex)),
      createdAt: now,
      updatedAt: now,
      evidence: emptyEvidence(),
      outcomeClass: "pending",
      nextAction: input.primaryMetric ? "await_validate" : "archive",
      primaryMetric: input.primaryMetric,
    };
    this.upsert(hypothesis);
    return hypothesis;
  }

  update(id: string, patch: UpdateHypothesisPatch): Hypothesis | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const evidence: Evidence = {
      ...current.evidence,
      ...(patch.evidence ?? {}),
      updatedAt: new Date().toISOString(),
    };
    const updated: Hypothesis = {
      ...current,
      ...patch,
      claim: patch.claim?.trim() ?? current.claim,
      rationale: patch.rationale?.trim() ?? current.rationale,
      constraints: patch.constraints?.trim() ?? current.constraints,
      evidence,
      updatedAt: new Date().toISOString(),
    };
    this.upsert(updated);
    return updated;
  }

  setStatus(id: string, status: HypothesisStatus): Hypothesis | undefined {
    return this.update(id, { status });
  }

  private upsert(h: Hypothesis): void {
    const store = this.load();
    const idx = store.hypotheses.findIndex((x) => x.id === h.id);
    const before = idx >= 0 ? store.hypotheses[idx] : undefined;
    if (idx >= 0) {
      store.hypotheses[idx] = h;
    } else {
      store.hypotheses.push(h);
    }
    const action = hypothesisAuditAction(before, h);
    this.audit.append({
      entityKind: "hypothesis",
      entityId: h.id,
      action,
      actor: "hypothesis_store",
      reason: action,
      before:
        action === "semantic_revised" || action === "status_changed"
          ? before
          : undefined,
      after: h,
      snapshotHash: snapshotHash(store),
    });
    this.save(store);
  }
}

function hypothesisAuditAction(
  before: Hypothesis | undefined,
  after: Hypothesis,
): MemoryAuditAction {
  if (!before) return "created";
  if (before.status !== after.status) return "status_changed";
  if (
    before.claim !== after.claim ||
    before.constraints !== after.constraints ||
    before.rationale !== after.rationale ||
    before.topicKey !== after.topicKey ||
    JSON.stringify(before.primaryMetric) !== JSON.stringify(after.primaryMetric)
  ) {
    return "semantic_revised";
  }
  return "evidence_updated";
}

function newHypothesisId(): string {
  return (
    `h_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_` +
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  );
}
