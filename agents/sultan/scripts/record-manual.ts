import "dotenv/config";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mapRecordingToReplay } from "../src/replay/mapRecording.js";
import { replayFilePath, writeReplayDocument } from "../src/replay/io.js";
import type { RecordingDocument } from "../src/replay/types.js";

const baseUrl = (process.env.GAME_BASE_URL ?? "http://127.0.0.1:17890").replace(/\/$/, "");

async function call(pathName: string, method: "GET" | "POST"): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${pathName}`, { method });
  if (!response.ok) {
    throw new Error(`${method} ${pathName} failed: HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const health = await call("/health", "GET");
  if (health.playerRecorder !== true) {
    throw new Error("The loaded SultanObserver does not expose player recording.");
  }

  const started = await call("/record/start", "POST");
  console.log(`Recording started: ${String(started.id ?? "unknown")}`);
  console.log("Perform the manual game action now. Return here and press Enter to stop.");

  const rl = readline.createInterface({ input, output });
  await rl.question("");
  rl.close();

  const stopped = await call("/record/stop", "POST");
  if (stopped.ok !== true) {
    throw new Error(`Failed to stop recording: ${JSON.stringify(stopped)}`);
  }
  console.log(`Recorded ${String(stopped.eventCount ?? 0)} events.`);
  console.log(`Saved to: ${String(stopped.filePath ?? "unknown")}`);

  const latest = await call("/record/latest", "GET");
  if (latest.ok === false) {
    throw new Error(`Failed to load latest recording: ${JSON.stringify(latest)}`);
  }

  const recording = latest as unknown as RecordingDocument;
  const id = String(recording.id ?? stopped.id ?? Date.now());
  const sourcePath = String(recording.filePath ?? stopped.filePath ?? "");
  const replay = mapRecordingToReplay(recording, {
    id,
    sourceRecordingPath: sourcePath,
  });
  const outPath = replayFilePath(id);
  writeReplayDocument(replay, outPath);

  console.log(
    `Replay script written: ${path.resolve(outPath)} (${replay.steps.length} steps, empty bubbles)`,
  );
  console.log(`Replay id: ${id}`);
  console.log(
    `Next: npm run annotate-replay -- --id ${id} --motive "本段在做什么/为何换卡（可含事件名与目标苏丹卡）"`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
