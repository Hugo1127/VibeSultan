import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MemoryEntityKind =
  | "hypothesis"
  | "tip"
  | "experiment"
  | "experience"
  | "card"
  | "event"
  | "interaction";
export type MemoryAuditAction =
  | "snapshot_imported"
  | "created"
  | "updated"
  | "semantic_revised"
  | "status_changed"
  | "evidence_updated"
  | "merged"
  | "superseded"
  | "tombstoned"
  | "enqueued"
  | "dequeued";

export interface MemoryAuditEvent {
  ts: string;
  type: "memory_audit";
  eventId: string;
  schemaVersion: 1;
  entityKind: MemoryEntityKind;
  entityId: string;
  action: MemoryAuditAction;
  actor: string;
  reason: string;
  runId?: string;
  batchId?: string;
  before?: unknown;
  after?: unknown;
  patch?: Record<string, unknown>;
  supersedesIds?: string[];
  snapshotHash?: string;
}

export interface AuditContext {
  actor?: string;
  reason?: string;
  runId?: string;
  batchId?: string;
  supersedesIds?: string[];
}

export class MemoryAuditLog {
  readonly filePath: string;

  constructor(memoryDir: string) {
    fs.mkdirSync(memoryDir, { recursive: true });
    this.filePath = path.join(memoryDir, "iterations.jsonl");
  }

  append(
    event: Omit<
      MemoryAuditEvent,
      "ts" | "type" | "eventId" | "schemaVersion"
    >,
  ): MemoryAuditEvent {
    const row: MemoryAuditEvent = {
      ...event,
      ts: new Date().toISOString(),
      type: "memory_audit",
      eventId: auditEventId(),
      schemaVersion: 1,
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, "utf8");
    return row;
  }

  read(): MemoryAuditEvent[] {
    if (!fs.existsSync(this.filePath)) return [];
    const out: MemoryAuditEvent[] = [];
    for (const line of fs.readFileSync(this.filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Partial<MemoryAuditEvent>;
        if (
          row.type === "memory_audit" &&
          typeof row.eventId === "string" &&
          (row.entityKind === "hypothesis" ||
            row.entityKind === "tip" ||
            row.entityKind === "experiment" ||
            row.entityKind === "experience" ||
            row.entityKind === "card" ||
            row.entityKind === "event" ||
            row.entityKind === "interaction")
        ) {
          out.push(row as MemoryAuditEvent);
        }
      } catch {
        // Partial final lines after a crash are ignored.
      }
    }
    return out;
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, filePath);
}

export function snapshotHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, sortValue(input[key])]),
  );
}

function auditEventId(): string {
  return `ma_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}
