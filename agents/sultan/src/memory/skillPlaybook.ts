import fs from "node:fs";
import path from "node:path";
import {
  HypothesisStore,
  SkillArtifactStore,
  TipStore,
  evaluateSelectionGate,
  reflectStub,
} from "@vibesultan/agent-learning-core";

/** Compress validated hypotheses + active tips into skills/best_skill.md (deterministic). */
export function refreshSkillPlaybook(sessionDir: string, opts?: {
  editBudget?: number;
  maxChars?: number;
  gameIndex?: number;
}): { promoted: boolean; version: number | null; path: string | null } {
  const hypothesisStore = new HypothesisStore(sessionDir);
  const tipStore = new TipStore(sessionDir);
  const skillStore = new SkillArtifactStore(sessionDir);

  const validatedClaims = hypothesisStore
    .list()
    .filter((h) => h.status === "validated" || h.status === "provisionally_validated")
    .map((h) => h.claim);
  const activeTips = tipStore
    .list()
    .filter((t) => t.status === "active" || t.status === "experimental")
    .map((t) => `${t.title}: ${t.body}`);
  const failures = hypothesisStore
    .list()
    .filter((h) => h.status === "rejected")
    .slice(-6)
    .map((h) => h.claim);

  if (validatedClaims.length === 0 && activeTips.length === 0) {
    return { promoted: false, version: null, path: null };
  }

  const current = skillStore.readBest() ?? "";
  const reflected = reflectStub({
    currentContent: current,
    validatedClaims,
    activeTipBodies: activeTips,
    failureSummaries: failures,
    editBudget: opts?.editBudget ?? 4,
    maxChars: opts?.maxChars ?? 4000,
  });

  const baselineMeta = skillStore.bestMeta();
  const baselineScore = baselineMeta?.selectionScore ?? null;
  const candidateScore = validatedClaims.length * 10 + activeTips.length * 3;

  const gate = evaluateSelectionGate(
    { selectionScore: baselineScore, hiddenScore: null },
    { selectionScore: candidateScore, hiddenScore: null },
    { hiddenRegressionMax: 0.05, allowBootstrap: true },
  );

  if (!gate.accept) {
    skillStore.pushRejected({
      digest: reflected.content.slice(0, 80),
      summary: "skill_not_improved",
      selectionScore: baselineScore,
      candidateScore,
      reason: gate.reason,
    });
    return { promoted: false, version: baselineMeta?.version ?? null, path: skillStore.bestPath };
  }

  const written = skillStore.writeCandidate({
    content: reflected.content,
    parentVersion: baselineMeta?.version ?? null,
    edits: reflected.edits,
    selectionScore: candidateScore,
    hiddenScore: null,
    note: `gameIndex=${opts?.gameIndex ?? "?"}`,
  });
  skillStore.promote(written.version);
  const manifest = skillStore.loadManifest();
  manifest.lastOptimizeSessionIndex = opts?.gameIndex ?? manifest.lastOptimizeSessionIndex;
  skillStore.saveManifest(manifest);

  return { promoted: true, version: written.version, path: skillStore.bestPath };
}

export function loadBestSkillInjection(sessionDir: string, budgetChars: number): string | null {
  const bestPath = path.join(sessionDir, "skills", "best_skill.md");
  if (!fs.existsSync(bestPath)) return null;
  const body = fs.readFileSync(bestPath, "utf8").trim();
  if (!body) return null;
  const header = "## 已部署技能（只读 playbook）";
  const text = `${header}\n${body}`;
  return text.length > budgetChars ? text.slice(0, budgetChars) + "\n…" : text;
}
