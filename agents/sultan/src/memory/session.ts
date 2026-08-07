import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { backfillEntitySkeletons, createSultanEntityStores } from "./entityMemory.js";
import { EpisodeStore } from "./episodeStore.js";
import { SudanBranchStore } from "./sudanBranchStore.js";
import { SudanRouteStore } from "./sudanRouteStore.js";

export interface MemorySessionMeta {
  id: string;
  createdAt: string;
  label?: string;
  /** Last game day that completed a daily review (same-game resume cursor). */
  lastReviewedDay?: number | null;
  /** Hypothesis currently under same-game adjacent-day validation. */
  activeHypothesisId?: string | null;
}

export interface ResolvedMemorySession {
  id: string;
  dir: string;
  meta: MemorySessionMeta;
  isNew: boolean;
}

function stampId(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function sanitizeId(raw: string): string {
  const s = raw.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) throw new Error("invalid memory session id");
  return s;
}

export function sessionsRoot(memoryRoot: string): string {
  return path.join(memoryRoot, "sessions");
}

export function listMemorySessions(memoryRoot: string): MemorySessionMeta[] {
  const root = sessionsRoot(memoryRoot);
  if (!fs.existsSync(root)) return [];
  const out: MemorySessionMeta[] = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const metaPath = path.join(dir, "meta.json");
    try {
      out.push(
        fs.existsSync(metaPath)
          ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as MemorySessionMeta)
          : { id: name, createdAt: "" },
      );
    } catch {
      out.push({ id: name, createdAt: "" });
    }
  }
  return out.sort((a, b) => (b.createdAt || b.id).localeCompare(a.createdAt || a.id));
}

export function createMemorySession(
  memoryRoot: string,
  idOrLabel?: string,
): ResolvedMemorySession {
  const id = sanitizeId(idOrLabel?.trim() || stampId());
  const dir = path.join(sessionsRoot(memoryRoot), id);
  if (fs.existsSync(dir)) throw new Error(`memory session already exists: ${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const meta: MemorySessionMeta = {
    id,
    createdAt: new Date().toISOString(),
    label: idOrLabel?.trim() || id,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(
    path.join(dir, "hypotheses.json"),
    JSON.stringify({ version: 1, hypotheses: [] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "tips.json"),
    JSON.stringify({ version: 1, tips: [] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "experiment-ledger.json"),
    JSON.stringify({ version: 1, queue: [] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "experiences.json"),
    JSON.stringify({ version: 1, experiences: [] }, null, 2),
    "utf8",
  );
  createSultanEntityStores(dir);
  new EpisodeStore(dir);
  new SudanRouteStore(dir);
  new SudanBranchStore(dir);
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(dir, "day-evidence.jsonl"), "", "utf8");
  return { id, dir, meta, isNew: true };
}

export function openMemorySession(memoryRoot: string, id: string): ResolvedMemorySession {
  const safe = sanitizeId(id);
  const dir = path.join(sessionsRoot(memoryRoot), safe);
  if (!fs.existsSync(dir)) throw new Error(`memory session not found: ${safe}`);
  const metaPath = path.join(dir, "meta.json");
  let meta: MemorySessionMeta = { id: safe, createdAt: "" };
  if (fs.existsSync(metaPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as MemorySessionMeta;
  }
  backfillEntitySkeletons(dir);
  new EpisodeStore(dir);
  new SudanRouteStore(dir);
  new SudanBranchStore(dir);
  // Ensure fingerprint alias + entity files exist for older sessions.
  createSultanEntityStores(dir);
  return { id: safe, dir, meta, isNew: false };
}

export function updateMemorySessionMeta(
  sessionDir: string,
  patch: Partial<MemorySessionMeta>,
): MemorySessionMeta {
  const metaPath = path.join(sessionDir, "meta.json");
  let meta: MemorySessionMeta = { id: path.basename(sessionDir), createdAt: "" };
  if (fs.existsSync(metaPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as MemorySessionMeta;
  }
  meta = { ...meta, ...patch };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export type MemoryCliArgs = {
  fresh?: string | true;
  memory?: string;
  list?: boolean;
};

export function parseMemoryCliArgs(argv: string[]): MemoryCliArgs {
  const out: MemoryCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--fresh") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.fresh = next;
        i += 1;
      } else out.fresh = true;
    } else if (a === "--memory" || a === "--session" || a === "--memory-session") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) throw new Error(`${a} requires a session id`);
      out.memory = next;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage:
  npm run autoplay -- --fresh [name]              New memory session
  npm run autoplay -- --memory <id>               Continue session
  npm run autoplay -- --memory-session <id>       Same as --memory
  npm run autoplay -- --session <id>              Same as --memory
  npm run autoplay -- --list                      List sessions

Resume the reviewed session:
  npm run autoplay -- --memory-session 20260726-210553
  npm run start -- --memory-session 20260726-210553
`);
      process.exit(0);
    }
  }
  return out;
}

export async function resolveMemorySession(
  memoryRoot: string,
  args: MemoryCliArgs,
): Promise<ResolvedMemorySession> {
  if (args.list) {
    const sessions = listMemorySessions(memoryRoot);
    if (sessions.length === 0) console.log("(no memory sessions yet)");
    else for (const s of sessions) console.log(`- ${s.id}  created=${s.createdAt || "?"}`);
    process.exit(0);
  }

  if (args.fresh !== undefined) {
    return createMemorySession(memoryRoot, args.fresh === true ? undefined : args.fresh);
  }
  if (args.memory) return openMemorySession(memoryRoot, args.memory);

  const envSession = process.env.AGENT_MEMORY_SESSION?.trim();
  if (envSession) return openMemorySession(memoryRoot, envSession);

  const sessions = listMemorySessions(memoryRoot);
  if (!process.stdin.isTTY) return createMemorySession(memoryRoot);

  console.log("\nMemory sessions:");
  sessions.forEach((s, i) => console.log(`  [${i + 1}] ${s.id}`));
  console.log("  [n] new session");
  const answer = await ask("Choose session number, id, or n [n]: ");
  if (!answer || answer.toLowerCase() === "n" || answer.toLowerCase() === "new") {
    const name = await ask("Optional name (Enter = timestamp): ");
    return createMemorySession(memoryRoot, name || undefined);
  }
  const asNum = Number(answer);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= sessions.length) {
    return openMemorySession(memoryRoot, sessions[asNum - 1]!.id);
  }
  return openMemorySession(memoryRoot, answer);
}
