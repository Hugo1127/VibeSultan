import fs from "node:fs";
import path from "node:path";
import type { KnowledgeVersionKey } from "@vibesultan/agent-learning-core";

export type EnrichmentEntityKind = "card" | "event" | "interaction";
export type EnrichmentJobStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "aborted";

export interface EnrichmentJob {
  id: string;
  entityKind: EnrichmentEntityKind;
  key: string;
  version: KnowledgeVersionKey;
  status: EnrichmentJobStatus;
  /** Entity updatedAt captured at enqueue time for generation-safe merge. */
  generation: string;
  evidenceSnapshot: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface EnrichmentQueueStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
  aborted: number;
  total: number;
}

/**
 * Persistent single-file JSONL queue. Jobs are deduped by entityKind+key;
 * a newer snapshot replaces an unfinished job for the same entity.
 */
export class EnrichmentQueue {
  readonly filePath: string;
  private readonly maxQueue: number;

  constructor(sessionDir: string, maxQueue = 200) {
    fs.mkdirSync(sessionDir, { recursive: true });
    this.filePath = path.join(sessionDir, "enrichment-queue.jsonl");
    this.maxQueue = Math.max(1, maxQueue);
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  list(): EnrichmentJob[] {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, "utf8").split(/\r?\n/);
    const jobs: EnrichmentJob[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        jobs.push(JSON.parse(line) as EnrichmentJob);
      } catch {
        // skip corrupt lines
      }
    }
    return jobs;
  }

  stats(): EnrichmentQueueStats {
    const jobs = this.list();
    const stats: EnrichmentQueueStats = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      aborted: 0,
      total: jobs.length,
    };
    for (const job of jobs) {
      if (job.status in stats) {
        stats[job.status as keyof Omit<EnrichmentQueueStats, "total">] += 1;
      }
    }
    return stats;
  }

  enqueue(input: {
    entityKind: EnrichmentEntityKind;
    key: string;
    version: KnowledgeVersionKey;
    generation: string;
    evidenceSnapshot: Record<string, unknown>;
    maxAttempts?: number;
  }): EnrichmentJob {
    const jobs = this.list();
    const existingIndex = jobs.findIndex(
      (job) =>
        job.entityKind === input.entityKind &&
        job.key === input.key &&
        (job.status === "pending" || job.status === "running"),
    );
    const now = new Date().toISOString();
    if (existingIndex >= 0) {
      const existing = jobs[existingIndex]!;
      const updated: EnrichmentJob = {
        ...existing,
        version: input.version,
        generation: input.generation,
        evidenceSnapshot: input.evidenceSnapshot,
        status: existing.status === "running" ? "running" : "pending",
        updatedAt: now,
        lastError: undefined,
      };
      jobs[existingIndex] = updated;
      this.rewrite(jobs);
      return updated;
    }

    const job: EnrichmentJob = {
      id: `enq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      entityKind: input.entityKind,
      key: input.key,
      version: input.version,
      status: "pending",
      generation: input.generation,
      evidenceSnapshot: input.evidenceSnapshot,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 2,
      createdAt: now,
      updatedAt: now,
    };
    jobs.push(job);
    this.rewrite(trimQueue(jobs, this.maxQueue));
    return job;
  }

  claimNext(): EnrichmentJob | undefined {
    const jobs = this.list();
    const index = jobs.findIndex((job) => job.status === "pending");
    if (index < 0) return undefined;
    const now = new Date().toISOString();
    const claimed: EnrichmentJob = {
      ...jobs[index]!,
      status: "running",
      attempts: jobs[index]!.attempts + 1,
      updatedAt: now,
    };
    jobs[index] = claimed;
    this.rewrite(jobs);
    return claimed;
  }

  complete(id: string): EnrichmentJob | undefined {
    return this.patch(id, {
      status: "done",
      completedAt: new Date().toISOString(),
      lastError: undefined,
    });
  }

  fail(id: string, error: string, retry: boolean): EnrichmentJob | undefined {
    const job = this.list().find((item) => item.id === id);
    if (!job) return undefined;
    if (retry && job.attempts < job.maxAttempts) {
      return this.patch(id, {
        status: "pending",
        lastError: error,
      });
    }
    return this.patch(id, {
      status: "failed",
      lastError: error,
      completedAt: new Date().toISOString(),
    });
  }

  abortRunning(reason: string): number {
    const jobs = this.list();
    let count = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < jobs.length; i++) {
      if (jobs[i]!.status !== "running") continue;
      jobs[i] = {
        ...jobs[i]!,
        status: "pending",
        lastError: reason,
        updatedAt: now,
      };
      count += 1;
    }
    if (count > 0) this.rewrite(jobs);
    return count;
  }

  private patch(
    id: string,
    patch: Partial<Omit<EnrichmentJob, "id" | "createdAt">>,
  ): EnrichmentJob | undefined {
    const jobs = this.list();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) return undefined;
    const updated: EnrichmentJob = {
      ...jobs[index]!,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    };
    jobs[index] = updated;
    this.rewrite(jobs);
    return updated;
  }

  private rewrite(jobs: EnrichmentJob[]): void {
    const body = jobs.map((job) => JSON.stringify(job)).join("\n");
    fs.writeFileSync(this.filePath, body ? `${body}\n` : "", "utf8");
  }
}

function trimQueue(jobs: EnrichmentJob[], maxQueue: number): EnrichmentJob[] {
  const open = jobs.filter(
    (job) => job.status === "pending" || job.status === "running",
  );
  if (open.length <= maxQueue) return jobs;
  const dropIds = new Set(
    open
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, open.length - maxQueue)
      .map((job) => job.id),
  );
  return jobs.map((job) =>
    dropIds.has(job.id)
      ? {
          ...job,
          status: "aborted" as const,
          lastError: "queue_overflow",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }
      : job,
  );
}
