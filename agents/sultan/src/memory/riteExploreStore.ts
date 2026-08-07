import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, type KnowledgeOutcome } from "@vibesultan/agent-learning-core";

export type RiteExploreTrialStatus = "submitted" | "settled" | "void";

export interface RiteExploreTrial {
  id: string;
  signature: string;
  /** Human-readable composition summary (no DSL signature). */
  summaryZh?: string;
  day: number | null;
  step?: number;
  episodeId?: string;
  status: RiteExploreTrialStatus;
  outcome?: KnowledgeOutcome | null;
  createdAt: string;
  updatedAt: string;
}

export interface RiteExploreRecord {
  riteId: number;
  eventKey: string;
  /** Distinct novel signatures submitted this run (baseline excluded). */
  exploreCount: number;
  signatures: string[];
  trials: RiteExploreTrial[];
}

export interface RiteExploreRunBucket {
  runId: string;
  gameIndex?: number;
  rites: Record<string, RiteExploreRecord>;
}

export interface RiteExploreLedgerFile {
  version: 1;
  activeRunId: string | null;
  byRun: Record<string, RiteExploreRunBucket>;
}

const MAX_NOVEL_PER_RITE = 2;

export class RiteExploreStore {
  readonly filePath: string;

  constructor(sessionDir: string) {
    fs.mkdirSync(sessionDir, { recursive: true });
    this.filePath = path.join(sessionDir, "rite-explore-ledger.json");
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, emptyFile());
    }
  }

  beginRun(runId: string, gameIndex?: number): void {
    const file = this.load();
    if (!file.byRun[runId]) {
      file.byRun[runId] = { runId, gameIndex, rites: {} };
    } else if (gameIndex != null) {
      file.byRun[runId]!.gameIndex = gameIndex;
    }
    file.activeRunId = runId;
    this.persist(file);
  }

  activeRunId(): string | null {
    return this.load().activeRunId;
  }

  hasTried(eventKey: string, signature: string, runId?: string | null): boolean {
    const record = this.recordFor(eventKey, runId);
    if (!record) return false;
    return record.signatures.includes(signature) || record.trials.some((t) => t.signature === signature);
  }

  listTrials(eventKey: string, runId?: string | null): RiteExploreTrial[] {
    const record = this.recordFor(eventKey, runId);
    if (!record) return [];
    return [...record.trials];
  }

  exploreCount(eventKey: string, runId?: string | null): number {
    return this.recordFor(eventKey, runId)?.exploreCount ?? 0;
  }

  remainingBudget(eventKey: string, runId?: string | null): number {
    return Math.max(0, MAX_NOVEL_PER_RITE - this.exploreCount(eventKey, runId));
  }

  maxNovelPerRite(): number {
    return MAX_NOVEL_PER_RITE;
  }

  recordSubmittedTrial(input: {
    runId: string;
    eventKey: string;
    riteId: number;
    signature: string;
    /** Human-readable composition; preferred over signature when injecting briefs. */
    summaryZh?: string;
    day?: number | null;
    step?: number;
    episodeId?: string;
    /** When true, counts toward explore budget (non-baseline). */
    isNovel: boolean;
  }): RiteExploreTrial | null {
    const file = this.load();
    const bucket =
      file.byRun[input.runId] ??
      ({ runId: input.runId, rites: {} } satisfies RiteExploreRunBucket);
    file.byRun[input.runId] = bucket;
    file.activeRunId = input.runId;

    const record =
      bucket.rites[input.eventKey] ??
      ({
        riteId: input.riteId,
        eventKey: input.eventKey,
        exploreCount: 0,
        signatures: [],
        trials: [],
      } satisfies RiteExploreRecord);
    bucket.rites[input.eventKey] = record;

    if (record.signatures.includes(input.signature)) {
      // Exact signature already tried — do not double-count.
      return null;
    }

    const now = new Date().toISOString();
    const trial: RiteExploreTrial = {
      id: `rex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      signature: input.signature,
      ...(input.summaryZh?.trim() ? { summaryZh: input.summaryZh.trim() } : {}),
      day: input.day ?? null,
      step: input.step,
      episodeId: input.episodeId,
      status: "submitted",
      createdAt: now,
      updatedAt: now,
    };
    record.trials.push(trial);
    record.signatures.push(input.signature);
    if (input.isNovel) {
      record.exploreCount = Math.min(
        MAX_NOVEL_PER_RITE,
        record.exploreCount + 1,
      );
    }
    this.persist(file);
    return trial;
  }

  settleTrial(opts: {
    runId?: string | null;
    episodeId?: string;
    signature?: string;
    outcome?: KnowledgeOutcome | null;
  }): void {
    const file = this.load();
    const runId = opts.runId ?? file.activeRunId;
    if (!runId) return;
    const bucket = file.byRun[runId];
    if (!bucket) return;
    const now = new Date().toISOString();
    for (const record of Object.values(bucket.rites)) {
      for (const trial of record.trials) {
        const match =
          (opts.episodeId && trial.episodeId === opts.episodeId) ||
          (opts.signature && trial.signature === opts.signature);
        if (!match || trial.status !== "submitted") continue;
        trial.status = "settled";
        trial.outcome = opts.outcome ?? null;
        trial.updatedAt = now;
      }
    }
    this.persist(file);
  }

  clearActiveRun(): void {
    const file = this.load();
    file.activeRunId = null;
    this.persist(file);
  }

  private recordFor(
    eventKey: string,
    runId?: string | null,
  ): RiteExploreRecord | null {
    const file = this.load();
    const id = runId ?? file.activeRunId;
    if (!id) return null;
    return file.byRun[id]?.rites[eventKey] ?? null;
  }

  private load(): RiteExploreLedgerFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<RiteExploreLedgerFile>;
      return {
        version: 1,
        activeRunId: raw.activeRunId ?? null,
        byRun:
          raw.byRun && typeof raw.byRun === "object"
            ? (raw.byRun as Record<string, RiteExploreRunBucket>)
            : {},
      };
    } catch {
      return emptyFile();
    }
  }

  private persist(file: RiteExploreLedgerFile): void {
    atomicWriteJson(this.filePath, file);
  }
}

function emptyFile(): RiteExploreLedgerFile {
  return { version: 1, activeRunId: null, byRun: {} };
}
