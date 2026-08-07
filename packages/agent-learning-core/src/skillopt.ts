import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./audit.js";

export interface SkillEdit {
  op: "add" | "replace" | "delete" | "protect";
  target: string;
  content?: string;
  rationale?: string;
}

export interface SkillArtifactVersion {
  version: number;
  createdAt: string;
  parentVersion: number | null;
  contentHash: string;
  charCount: number;
  selectionScore: number | null;
  hiddenScore: number | null;
  edits: SkillEdit[];
  note?: string;
}

export interface RejectedEditEntry {
  ts: string;
  digest: string;
  summary: string;
  selectionScore: number | null;
  candidateScore: number | null;
  reason: string;
}

export interface SkillArtifactManifest {
  version: 1;
  bestVersion: number | null;
  latestVersion: number;
  versions: SkillArtifactVersion[];
  rejectedBuffer: RejectedEditEntry[];
  lastOptimizeSessionIndex: number;
  updatedAt: string;
}

export interface GateScores {
  selectionScore: number | null;
  hiddenScore: number | null;
}

export interface GateDecision {
  accept: boolean;
  reason: string;
  baseline: GateScores;
  candidate: GateScores;
  hiddenRegression: number | null;
}

export interface GateOptions {
  hiddenRegressionMax: number;
  allowBootstrap: boolean;
}

export interface ReflectInput {
  currentContent: string;
  validatedClaims: string[];
  activeTipBodies: string[];
  failureSummaries: string[];
  editBudget: number;
  maxChars: number;
}

export interface ReflectResult {
  content: string;
  edits: SkillEdit[];
  truncated: boolean;
}

const PROTECTED_HEADER = "## Protected lessons";
const SKILL_DIR = "skills";

export class SkillArtifactStore {
  readonly dir: string;
  readonly manifestPath: string;
  readonly bestPath: string;

  constructor(memoryDir: string) {
    this.dir = path.join(memoryDir, SKILL_DIR);
    this.manifestPath = path.join(this.dir, "manifest.json");
    this.bestPath = path.join(this.dir, "best_skill.md");
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.manifestPath)) {
      this.saveManifest(emptyManifest());
    }
  }

  loadManifest(): SkillArtifactManifest {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.manifestPath, "utf8"),
      ) as Partial<SkillArtifactManifest>;
      return normalizeManifest(parsed);
    } catch {
      return emptyManifest();
    }
  }

  saveManifest(manifest: SkillArtifactManifest): void {
    atomicWriteJson(this.manifestPath, {
      ...manifest,
      updatedAt: new Date().toISOString(),
    });
  }

  versionPath(version: number): string {
    return path.join(this.dir, `v${version}.md`);
  }

  readVersion(version: number): string | null {
    const p = this.versionPath(version);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  }

  readBest(): string | null {
    if (!fs.existsSync(this.bestPath)) return null;
    return fs.readFileSync(this.bestPath, "utf8");
  }

  bestMeta(): SkillArtifactVersion | null {
    const manifest = this.loadManifest();
    if (manifest.bestVersion == null) return null;
    return manifest.versions.find((v) => v.version === manifest.bestVersion) ?? null;
  }

  writeCandidate(opts: {
    content: string;
    parentVersion: number | null;
    edits: SkillEdit[];
    selectionScore: number | null;
    hiddenScore: number | null;
    note?: string;
  }): SkillArtifactVersion {
    const manifest = this.loadManifest();
    const version = manifest.latestVersion + 1;
    const content = opts.content.trimEnd() + "\n";
    fs.writeFileSync(this.versionPath(version), content, "utf8");
    const meta: SkillArtifactVersion = {
      version,
      createdAt: new Date().toISOString(),
      parentVersion: opts.parentVersion,
      contentHash: hashContent(content),
      charCount: content.length,
      selectionScore: opts.selectionScore,
      hiddenScore: opts.hiddenScore,
      edits: opts.edits,
      note: opts.note,
    };
    manifest.latestVersion = version;
    manifest.versions.push(meta);
    this.saveManifest(manifest);
    return meta;
  }

  promote(version: number): SkillArtifactVersion {
    const manifest = this.loadManifest();
    const meta = manifest.versions.find((v) => v.version === version);
    if (!meta) throw new Error(`skill version not found: ${version}`);
    const content = this.readVersion(version);
    if (content == null) throw new Error(`missing skill file v${version}`);
    fs.writeFileSync(this.bestPath, content, "utf8");
    manifest.bestVersion = version;
    this.saveManifest(manifest);
    return meta;
  }

  pushRejected(entry: Omit<RejectedEditEntry, "ts">): void {
    const manifest = this.loadManifest();
    manifest.rejectedBuffer.push({ ...entry, ts: new Date().toISOString() });
    if (manifest.rejectedBuffer.length > 40) {
      manifest.rejectedBuffer = manifest.rejectedBuffer.slice(-40);
    }
    this.saveManifest(manifest);
  }
}

export function evaluateSelectionGate(
  baseline: GateScores,
  candidate: GateScores,
  options: GateOptions,
): GateDecision {
  const hiddenRegression = computeHiddenRegression(
    baseline.hiddenScore,
    candidate.hiddenScore,
  );

  if (
    hiddenRegression != null &&
    hiddenRegression > options.hiddenRegressionMax
  ) {
    return {
      accept: false,
      reason: `hidden_regression=${hiddenRegression.toFixed(3)} > max=${options.hiddenRegressionMax}`,
      baseline,
      candidate,
      hiddenRegression,
    };
  }

  if (baseline.selectionScore == null) {
    if (options.allowBootstrap && candidate.selectionScore != null) {
      return {
        accept: true,
        reason: "bootstrap_first_best",
        baseline,
        candidate,
        hiddenRegression,
      };
    }
    return {
      accept: false,
      reason: "baseline_unscored_no_bootstrap",
      baseline,
      candidate,
      hiddenRegression,
    };
  }

  if (candidate.selectionScore == null) {
    return {
      accept: false,
      reason: "candidate_unscored",
      baseline,
      candidate,
      hiddenRegression,
    };
  }

  if (candidate.selectionScore > baseline.selectionScore) {
    return {
      accept: true,
      reason: `selection ${candidate.selectionScore.toFixed(3)} > ${baseline.selectionScore.toFixed(3)}`,
      baseline,
      candidate,
      hiddenRegression,
    };
  }

  if (candidate.selectionScore === baseline.selectionScore) {
    return {
      accept: false,
      reason: "selection_tie_reject",
      baseline,
      candidate,
      hiddenRegression,
    };
  }

  return {
    accept: false,
    reason: `selection ${candidate.selectionScore.toFixed(3)} <= ${baseline.selectionScore.toFixed(3)}`,
    baseline,
    candidate,
    hiddenRegression,
  };
}

/** Deterministic stub — no LLM; produces a compact markdown skill body. */
export function reflectStub(input: ReflectInput): ReflectResult {
  const sections: string[] = ["# Agent Skill Playbook", ""];
  const edits: SkillEdit[] = [];

  if (input.validatedClaims.length > 0) {
    edits.push({
      op: "add",
      target: "Validated principles",
      rationale: "compress validated hypotheses",
    });
    sections.push("## Validated principles");
    for (const claim of input.validatedClaims.slice(0, input.editBudget)) {
      sections.push(`- ${claim}`);
    }
    sections.push("");
  }

  if (input.activeTipBodies.length > 0 && edits.length < input.editBudget) {
    edits.push({
      op: "add",
      target: "Active tips",
      rationale: "include active tips",
    });
    sections.push("## Active tips");
    for (const body of input.activeTipBodies.slice(0, 4)) {
      sections.push(`- ${body}`);
    }
    sections.push("");
  }

  if (input.failureSummaries.length > 0 && edits.length < input.editBudget) {
    edits.push({
      op: "add",
      target: "Anti-patterns",
      rationale: "failure reflect",
    });
    sections.push("## Anti-patterns");
    for (const line of input.failureSummaries.slice(0, 6)) {
      sections.push(`- ${line}`);
    }
    sections.push("");
  }

  let content = sections.join("\n").trimEnd() + "\n";
  let truncated = false;
  if (content.length > input.maxChars) {
    content = content.slice(0, input.maxChars - 20).trimEnd() + "\n\n…\n";
    truncated = true;
  }

  return { content, edits, truncated };
}

export function emptyManifest(): SkillArtifactManifest {
  return {
    version: 1,
    bestVersion: null,
    latestVersion: 0,
    versions: [],
    rejectedBuffer: [],
    lastOptimizeSessionIndex: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export { PROTECTED_HEADER };

function computeHiddenRegression(
  baseline: number | null,
  candidate: number | null,
): number | null {
  if (baseline == null || candidate == null) return null;
  if (baseline <= 0) return candidate < baseline ? 1 : 0;
  if (candidate >= baseline) return 0;
  return (baseline - candidate) / Math.abs(baseline);
}

function normalizeManifest(
  parsed: Partial<SkillArtifactManifest>,
): SkillArtifactManifest {
  return {
    version: 1,
    bestVersion:
      typeof parsed.bestVersion === "number" ? parsed.bestVersion : null,
    latestVersion:
      typeof parsed.latestVersion === "number" ? parsed.latestVersion : 0,
    versions: Array.isArray(parsed.versions) ? parsed.versions : [],
    rejectedBuffer: Array.isArray(parsed.rejectedBuffer)
      ? parsed.rejectedBuffer
      : [],
    lastOptimizeSessionIndex:
      typeof parsed.lastOptimizeSessionIndex === "number"
        ? parsed.lastOptimizeSessionIndex
        : 0,
    updatedAt:
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString(),
  };
}
