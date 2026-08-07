import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  MemoryAuditLog,
  snapshotHash,
} from "./audit.js";
import type { ExperimentPlan } from "./types.js";

export interface ExperimentLedgerFile {
  version: 1;
  queue: ExperimentPlan[];
}

function emptyLedger(): ExperimentLedgerFile {
  return { version: 1, queue: [] };
}

export class ExperimentLedger {
  readonly filePath: string;
  readonly audit: MemoryAuditLog;
  private queue: ExperimentPlan[];

  constructor(memoryDir: string) {
    fs.mkdirSync(memoryDir, { recursive: true });
    this.filePath = path.join(memoryDir, "experiment-ledger.json");
    this.audit = new MemoryAuditLog(memoryDir);
    this.queue = this.load().queue;
  }

  load(): ExperimentLedgerFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<ExperimentLedgerFile>;
      return {
        version: 1,
        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      };
    } catch {
      return emptyLedger();
    }
  }

  persist(): void {
    const file: ExperimentLedgerFile = { version: 1, queue: this.queue };
    atomicWriteJson(this.filePath, file);
  }

  enqueue(plan: ExperimentPlan): void {
    this.queue = [...this.queue, plan].sort(
      (a, b) => b.priority - a.priority || a.enqueuedAt.localeCompare(b.enqueuedAt),
    );
    this.audit.append({
      entityKind: "experiment",
      entityId: plan.id,
      action: "enqueued",
      actor: "experiment_ledger",
      reason: "plan_enqueued",
      after: plan,
      snapshotHash: snapshotHash({ version: 1, queue: this.queue }),
    });
    this.persist();
  }

  peek(): ExperimentPlan | undefined {
    return this.queue[0];
  }

  dequeue(): ExperimentPlan | undefined {
    const next = this.queue.shift();
    if (next) {
      this.audit.append({
        entityKind: "experiment",
        entityId: next.id,
        action: "dequeued",
        actor: "experiment_ledger",
        reason: "plan_dequeued",
        before: next,
        snapshotHash: snapshotHash({ version: 1, queue: this.queue }),
      });
      this.persist();
    }
    return next;
  }

  size(): number {
    return this.queue.length;
  }

  list(): ExperimentPlan[] {
    return [...this.queue];
  }
}

export function newExperimentPlanId(): string {
  return (
    `xp_${Date.now().toString(36)}_` +
    `${Math.random().toString(36).slice(2, 8)}`
  );
}
