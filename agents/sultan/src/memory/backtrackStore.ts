import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "@vibesultan/agent-learning-core";

export type BacktrackNodeStatus =
  | "open"
  | "exhausted"
  | "dominated"
  | "recovered";

export interface BacktrackAnchor {
  day: number;
  sudanIdentity: string | null;
  resources?: Record<string, number | null>;
  readyRoutes?: string[];
  needsSupportRoutes?: string[];
  executedPathSignatures: string[];
  capturedAt: string;
}

export interface BacktrackFailureNode {
  id: string;
  /** Day-independent failure identity for dedupe across rewinds. */
  failureSignature: string;
  terminalReason?: string | null;
  sudanIdentity?: string | null;
  failedPathSignatures: string[];
  originDay: number;
  targetDay: number;
  depth: number;
  triedSiblingSignatures: string[];
  status: BacktrackNodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BacktrackRunBucket {
  runId: string;
  anchors: BacktrackAnchor[];
  failures: BacktrackFailureNode[];
  activeFailureId?: string | null;
}

export interface BacktrackLedgerFile {
  version: 1;
  activeRunId: string | null;
  byRun: Record<string, BacktrackRunBucket>;
}

export class BacktrackStore {
  readonly filePath: string;

  constructor(sessionDir: string) {
    fs.mkdirSync(sessionDir, { recursive: true });
    this.filePath = path.join(sessionDir, "backtrack-ledger.json");
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, emptyFile());
    }
  }

  beginRun(runId: string): void {
    const file = this.load();
    if (!file.byRun[runId]) {
      file.byRun[runId] = { runId, anchors: [], failures: [], activeFailureId: null };
    }
    file.activeRunId = runId;
    this.persist(file);
  }

  recordAnchor(input: {
    runId: string;
    day: number;
    sudanIdentity?: string | null;
    resources?: Record<string, number | null>;
    readyRoutes?: string[];
    needsSupportRoutes?: string[];
    executedPathSignatures?: string[];
  }): void {
    const file = this.load();
    const bucket = ensureBucket(file, input.runId);
    const existing = bucket.anchors.find((a) => a.day === input.day);
    const now = new Date().toISOString();
    if (existing) {
      existing.sudanIdentity = input.sudanIdentity ?? existing.sudanIdentity;
      existing.resources = input.resources ?? existing.resources;
      existing.readyRoutes = input.readyRoutes ?? existing.readyRoutes;
      existing.needsSupportRoutes =
        input.needsSupportRoutes ?? existing.needsSupportRoutes;
      existing.executedPathSignatures = unique([
        ...existing.executedPathSignatures,
        ...(input.executedPathSignatures ?? []),
      ]);
      existing.capturedAt = now;
    } else {
      bucket.anchors.push({
        day: input.day,
        sudanIdentity: input.sudanIdentity ?? null,
        resources: input.resources,
        readyRoutes: input.readyRoutes,
        needsSupportRoutes: input.needsSupportRoutes,
        executedPathSignatures: unique(input.executedPathSignatures ?? []),
        capturedAt: now,
      });
    }
    this.persist(file);
  }

  appendExecutedPath(opts: {
    runId: string;
    day: number;
    pathSignature: string;
  }): void {
    this.recordAnchor({
      runId: opts.runId,
      day: opts.day,
      executedPathSignatures: [opts.pathSignature],
    });
  }

  createOrRefreshFailure(input: {
    runId: string;
    failureSignature: string;
    originDay: number;
    targetDay: number;
    depth: number;
    failedPathSignatures: string[];
    terminalReason?: string | null;
    sudanIdentity?: string | null;
  }): BacktrackFailureNode {
    const file = this.load();
    const bucket = ensureBucket(file, input.runId);
    const existing = bucket.failures.find(
      (f) => f.failureSignature === input.failureSignature && f.status === "open",
    );
    const now = new Date().toISOString();
    if (existing) {
      existing.originDay = input.originDay;
      existing.targetDay = Math.min(existing.targetDay, input.targetDay);
      existing.depth = Math.max(existing.depth, input.depth);
      existing.failedPathSignatures = unique([
        ...existing.failedPathSignatures,
        ...input.failedPathSignatures,
      ]);
      existing.terminalReason = input.terminalReason ?? existing.terminalReason;
      existing.updatedAt = now;
      bucket.activeFailureId = existing.id;
      this.persist(file);
      return existing;
    }
    const node: BacktrackFailureNode = {
      id: `bt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      failureSignature: input.failureSignature,
      terminalReason: input.terminalReason ?? null,
      sudanIdentity: input.sudanIdentity ?? null,
      failedPathSignatures: unique(input.failedPathSignatures),
      originDay: input.originDay,
      targetDay: input.targetDay,
      depth: input.depth,
      triedSiblingSignatures: [],
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    bucket.failures.push(node);
    bucket.activeFailureId = node.id;
    this.persist(file);
    return node;
  }

  activeFailure(runId?: string | null): BacktrackFailureNode | null {
    const file = this.load();
    const id = runId ?? file.activeRunId;
    if (!id) return null;
    const bucket = file.byRun[id];
    if (!bucket?.activeFailureId) return null;
    return bucket.failures.find((f) => f.id === bucket.activeFailureId) ?? null;
  }

  markSiblingTried(opts: {
    runId: string;
    failureId: string;
    siblingSignature: string;
  }): void {
    const file = this.load();
    const bucket = file.byRun[opts.runId];
    const node = bucket?.failures.find((f) => f.id === opts.failureId);
    if (!node) return;
    node.triedSiblingSignatures = unique([
      ...node.triedSiblingSignatures,
      opts.siblingSignature,
    ]);
    node.updatedAt = new Date().toISOString();
    this.persist(file);
  }

  setFailureStatus(opts: {
    runId: string;
    failureId: string;
    status: BacktrackNodeStatus;
    targetDay?: number;
    depth?: number;
  }): void {
    const file = this.load();
    const bucket = file.byRun[opts.runId];
    const node = bucket?.failures.find((f) => f.id === opts.failureId);
    if (!node) return;
    node.status = opts.status;
    if (opts.targetDay != null) node.targetDay = opts.targetDay;
    if (opts.depth != null) node.depth = opts.depth;
    node.updatedAt = new Date().toISOString();
    if (opts.status !== "open" && bucket?.activeFailureId === opts.failureId) {
      bucket.activeFailureId = null;
    }
    this.persist(file);
  }

  isFailedPath(runId: string | null | undefined, pathSignature: string): boolean {
    const file = this.load();
    const id = runId ?? file.activeRunId;
    if (!id) return false;
    const bucket = file.byRun[id];
    if (!bucket) return false;
    return bucket.failures.some((f) =>
      f.failedPathSignatures.includes(pathSignature),
    );
  }

  listFailedPaths(runId?: string | null): string[] {
    const file = this.load();
    const id = runId ?? file.activeRunId;
    if (!id) return [];
    const bucket = file.byRun[id];
    if (!bucket) return [];
    return unique(bucket.failures.flatMap((f) => f.failedPathSignatures));
  }

  anchors(runId?: string | null): BacktrackAnchor[] {
    const file = this.load();
    const id = runId ?? file.activeRunId;
    if (!id) return [];
    return [...(file.byRun[id]?.anchors ?? [])].sort((a, b) => a.day - b.day);
  }

  clearActiveRun(): void {
    const file = this.load();
    file.activeRunId = null;
    this.persist(file);
  }

  private load(): BacktrackLedgerFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<BacktrackLedgerFile>;
      return {
        version: 1,
        activeRunId: raw.activeRunId ?? null,
        byRun:
          raw.byRun && typeof raw.byRun === "object"
            ? (raw.byRun as Record<string, BacktrackRunBucket>)
            : {},
      };
    } catch {
      return emptyFile();
    }
  }

  private persist(file: BacktrackLedgerFile): void {
    atomicWriteJson(this.filePath, file);
  }
}

function ensureBucket(
  file: BacktrackLedgerFile,
  runId: string,
): BacktrackRunBucket {
  if (!file.byRun[runId]) {
    file.byRun[runId] = {
      runId,
      anchors: [],
      failures: [],
      activeFailureId: null,
    };
  }
  file.activeRunId = runId;
  return file.byRun[runId]!;
}

function emptyFile(): BacktrackLedgerFile {
  return { version: 1, activeRunId: null, byRun: {} };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function buildFailureSignature(opts: {
  sudanIdentity?: string | null;
  pathSignatures: string[];
  terminalReason?: string | null;
}): string {
  const sudan = opts.sudanIdentity?.trim() || "sudan:?";
  const paths = [...opts.pathSignatures].sort().join(">");
  const reason = opts.terminalReason?.trim() || "terminal";
  return `${sudan}|${reason}|${paths || "path:?"}`;
}
