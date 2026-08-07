import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AgentLogEvent {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`
  );
}

function truncate(value: unknown, maxChars: number): unknown {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return value;
  if (s.length <= maxChars) {
    return typeof value === "string" ? value : JSON.parse(s);
  }
  return { _truncated: true, length: s.length, preview: s.slice(0, maxChars) };
}

export class AgentLogger {
  readonly runId: string;
  readonly runDir: string;
  readonly jsonlPath: string;
  private readonly maxToolChars: number;
  private step = 0;

  private constructor(runDir: string, runId: string, maxToolChars: number) {
    this.runDir = runDir;
    this.runId = runId;
    this.jsonlPath = path.join(runDir, "events.jsonl");
    this.maxToolChars = maxToolChars;
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(this.jsonlPath, "", "utf8");
  }

  static create(opts: { logRoot?: string; maxToolChars?: number }): AgentLogger {
    const root = opts.logRoot ?? path.resolve(__dirname, "../../../logs");
    const runId = stamp();
    const runDir = path.join(root, "runs", runId);
    return new AgentLogger(runDir, runId, opts.maxToolChars ?? 8000);
  }

  nextStep(): number {
    this.step += 1;
    return this.step;
  }

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const row: AgentLogEvent = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    fs.appendFileSync(this.jsonlPath, JSON.stringify(row) + "\n", "utf8");
    const line = formatConsole(row);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.log("info", event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.log("warn", event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.log("error", event, data);
  }

  toolArgs(args: string): unknown {
    return truncate(args, this.maxToolChars);
  }

  toolResult(result: unknown): unknown {
    return truncate(result, this.maxToolChars);
  }

  writeSummary(summary: Record<string, unknown>): void {
    fs.writeFileSync(path.join(this.runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  }

  writeText(name: string, content: string): void {
    fs.writeFileSync(path.join(this.runDir, name), content, "utf8");
  }
}

function formatConsole(row: AgentLogEvent): string {
  const { ts, level, event, ...rest } = row;
  const keys = Object.keys(rest);
  let extra = "";
  if (keys.length > 0) {
    const compact: Record<string, unknown> = {};
    for (const k of keys) {
      const v = rest[k];
      if (typeof v === "string" && v.length > 160) {
        compact[k] = v.slice(0, 160) + "…";
      } else if (k === "result" || k === "args" || k === "reasoning") {
        compact[k] = typeof v === "string" ? v.slice(0, 120) + (v.length > 120 ? "…" : "") : v;
      } else {
        compact[k] = v;
      }
    }
    try {
      extra = " " + JSON.stringify(compact);
    } catch {
      extra = " [unserializable]";
    }
  }
  return `[${ts}] ${level.toUpperCase()} ${event}${extra}`;
}
