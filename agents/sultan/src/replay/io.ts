import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordingDocument, ReplayDocument } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** agents/sultan/replays */
export function defaultReplayDir(): string {
  return path.resolve(__dirname, "../../replays");
}

export function ensureReplayDir(dir = defaultReplayDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function replayFilePath(id: string, dir = defaultReplayDir()): string {
  return path.join(ensureReplayDir(dir), `replay-${id}.json`);
}

export function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export function writeReplayDocument(doc: ReplayDocument, filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function readRecordingDocument(filePath: string): RecordingDocument {
  return readJsonFile<RecordingDocument>(filePath);
}

export function readReplayDocument(filePath: string): ReplayDocument {
  const doc = readJsonFile<ReplayDocument>(filePath);
  if (doc.version !== 1 || !Array.isArray(doc.steps)) {
    throw new Error(`Invalid ReplayDocument: ${filePath}`);
  }
  return doc;
}
