import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "@vibesultan/agent-learning-core";

export interface FingerprintAliasFile {
  version: 1;
  canonical: string | null;
  aliases: Record<string, string>;
}

/**
 * Tracks cold-start → full-catalog config fingerprint transitions so entity keys
 * written under an earlier fingerprint remain retrievable after the game loads
 * the complete catalog hash.
 */
export class FingerprintAliasStore {
  readonly filePath: string;

  constructor(sessionDir: string) {
    fs.mkdirSync(sessionDir, { recursive: true });
    this.filePath = path.join(sessionDir, "fingerprint-aliases.json");
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, {
        version: 1,
        canonical: null,
        aliases: {},
      } satisfies FingerprintAliasFile);
    }
  }

  /** Observe a live fingerprint; later values become canonical and alias prior ones. */
  observe(fingerprint: string | null | undefined): string | null {
    const fp = fingerprint?.trim() || null;
    if (!fp || fp === "unknown-config") return fp;
    const file = this.load();
    if (!file.canonical) {
      file.canonical = fp;
      this.persist(file);
      return fp;
    }
    if (fp === file.canonical || file.aliases[fp] === file.canonical) {
      return file.canonical;
    }
    if (file.aliases[fp]) {
      file.canonical = this.walk(file, file.aliases[fp]);
      this.persist(file);
      return file.canonical;
    }
    const previous = file.canonical;
    file.aliases[previous] = fp;
    for (const [from, to] of Object.entries(file.aliases)) {
      if (to === previous) file.aliases[from] = fp;
    }
    file.canonical = fp;
    this.persist(file);
    return fp;
  }

  resolve(fingerprint: string | null | undefined): string {
    const fp = fingerprint?.trim() || "unknown-config";
    if (fp === "unknown-config") return fp;
    const file = this.load();
    if (!file.canonical) return fp;
    if (fp === file.canonical) return fp;
    return this.walk(file, file.aliases[fp] ?? fp);
  }

  /** All fingerprints that should be treated as the same config family. */
  expand(fingerprint: string | null | undefined): string[] {
    const resolved = this.resolve(fingerprint);
    const file = this.load();
    const out = new Set<string>([resolved]);
    if (fingerprint?.trim()) out.add(fingerprint.trim());
    for (const [from, to] of Object.entries(file.aliases)) {
      if (this.walk(file, to) === resolved || from === resolved) {
        out.add(from);
        out.add(this.walk(file, to));
      }
    }
    if (file.canonical) out.add(file.canonical);
    return [...out];
  }

  rewriteKey(key: string, toFingerprint: string): string {
    const match = key.match(/^([^:]+):(.*)$/);
    if (!match) return key;
    return `${toFingerprint}:${match[2]}`;
  }

  expandKeys(keys: string[]): string[] {
    const out = new Set<string>();
    for (const key of keys) {
      out.add(key);
      const match = key.match(/^([^:]+):(.*)$/);
      if (!match) continue;
      const suffix = match[2]!;
      for (const fp of this.expand(match[1])) {
        out.add(`${fp}:${suffix}`);
      }
    }
    return [...out];
  }

  private walk(file: FingerprintAliasFile, start: string): string {
    let current = start;
    const seen = new Set<string>();
    while (file.aliases[current] && !seen.has(current)) {
      seen.add(current);
      current = file.aliases[current]!;
    }
    return current;
  }

  private load(): FingerprintAliasFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<FingerprintAliasFile>;
      return {
        version: 1,
        canonical: typeof raw.canonical === "string" ? raw.canonical : null,
        aliases:
          raw.aliases && typeof raw.aliases === "object" && !Array.isArray(raw.aliases)
            ? (raw.aliases as Record<string, string>)
            : {},
      };
    } catch {
      return { version: 1, canonical: null, aliases: {} };
    }
  }

  private persist(file: FingerprintAliasFile): void {
    atomicWriteJson(this.filePath, file);
  }
}
