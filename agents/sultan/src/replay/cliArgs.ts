import fs from "node:fs";
import path from "node:path";
import { defaultReplayDir, replayFilePath } from "./io.js";

export function argValue(flag: string, argv = process.argv): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
}

/** Collect a multi-token flag value until the next --flag (Windows/Git Bash safe). */
export function argRest(flag: string, argv = process.argv, fallback?: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return fallback;
  const parts: string[] = [];
  for (let i = idx + 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) break;
    parts.push(token);
  }
  const joined = parts.join(" ").trim();
  return joined || fallback;
}

/** Collect --prompt value even when shell quoting splits it across argv tokens. */
export function argPrompt(argv = process.argv, fallback?: string): string | undefined {
  return argRest("--prompt", argv, fallback);
}

/** Collect --motive episode narrative brief. */
export function argMotive(argv = process.argv, fallback?: string): string | undefined {
  return argRest("--motive", argv, fallback);
}

/**
 * Resolve a replay JSON path from --id and/or --file.
 * Prefer --id on Windows/Git Bash to avoid path-separator mangling.
 */
export function resolveReplayFilePath(opts?: {
  file?: string;
  id?: string;
  argv?: string[];
}): string {
  const argv = opts?.argv ?? process.argv;
  const id = opts?.id ?? argValue("--id", argv);
  const file = opts?.file ?? argValue("--file", argv);

  if (id) {
    const normalized = id.replace(/^replay-/i, "").replace(/\.json$/i, "");
    const candidate = replayFilePath(normalized);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Replay not found for --id ${normalized}: ${candidate}`);
    }
    return candidate;
  }

  if (!file) {
    throw new Error(
      'Missing replay target. Use --id 20260805-201012-872 (recommended) or --file replays/replay-....json',
    );
  }

  const candidates = [
    path.resolve(file),
    path.resolve(defaultReplayDir(), file),
    path.resolve(defaultReplayDir(), path.basename(file)),
  ];

  // Recover from shells that stripped separators: "...replaysreplay-ID.json"
  const mangled = file.match(/replay-(\d{8}-\d{6}-\d+)\.json$/i);
  if (mangled) {
    candidates.push(replayFilePath(mangled[1]!));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Replay file not found: ${file}\nTried:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Tip: use --id ${mangled?.[1] ?? "<recording-id>"} instead of a full path.`,
  );
}
