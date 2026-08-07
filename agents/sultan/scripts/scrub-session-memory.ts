/**
 * Deterministic scrub for a Sultan memory session.
 * Default: dry-run report. Pass --apply to write changes.
 * Pass --quality for confidence realign, orphan-route clear, and tip baseline rewrite.
 *
 * Usage:
 *   npx tsx scripts/scrub-session-memory.ts --session 20260726-210553
 *   npx tsx scripts/scrub-session-memory.ts --session 20260726-210553 --quality --apply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOISE_OPS = new Set(["continue", "cancel", "probe_types"]);
const MIN_VALIDATED_SAMPLES = 3;
const ORPHAN_ROUTE_FIELDS = ["successfulRoutes", "failureModes"] as const;

type EntityRec = {
  key: string;
  status: string;
  encounterCount?: number;
  sampleCount?: number;
  positiveCount?: number;
  negativeCount?: number;
  confidence?: number;
  evidence?: Array<{
    outcome?: string;
    summary?: string;
    sourceId?: string;
    context?: Record<string, unknown>;
  }>;
  facts?: Record<string, unknown>;
  version?: { configFingerprint?: string };
  updatedAt?: string;
};

type TipRec = {
  id: string;
  status: string;
  decisionKey: string;
  title: string;
  body: string;
  evidence?: {
    observationCount?: number;
    positiveCount?: number;
    negativeCount?: number;
    netValueSum?: number;
  };
  updatedAt?: string;
  [key: string]: unknown;
};

type Episode = {
  id: string;
  riteId?: number;
  eventKey?: string;
  phase?: string;
  outcome?: string;
  applied?: boolean;
  settlementExperienceIds?: string[];
  settlement?: Record<string, unknown>;
  composition?: unknown[];
  quarantined?: boolean;
  [key: string]: unknown;
};

type Experience = {
  id: string;
  status?: string;
  actionSignature?: string;
  actualDelta?: { changed?: boolean } | null;
  [key: string]: unknown;
};

function parseArgs(argv: string[]): { session: string; apply: boolean; quality: boolean } {
  let session = "";
  let apply = false;
  let quality = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") {
      session = argv[++i] ?? "";
    } else if (argv[i] === "--apply") {
      apply = true;
    } else if (argv[i] === "--quality") {
      quality = true;
    }
  }
  if (!session) {
    throw new Error(
      "Usage: scrub-session-memory.ts --session <id> [--quality] [--apply]",
    );
  }
  return { session, apply, quality };
}

function normalizeTitle(raw: unknown): string {
  return String(raw ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function isPlaceholderTip(tip: unknown): boolean {
  const t = String(tip ?? "").trim();
  return !t || /^new\s*text$/i.test(t);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

/** Match EntityKnowledgeStore confidence (clamped to [0,1]). */
function confidenceFor(sample: number, pos: number, neg: number): number {
  if (sample <= 0) return 0;
  const ratio = pos / sample;
  const coverage = Math.min(1, sample / 5);
  const contradictionPenalty = Math.min(0.4, neg / sample);
  return Number(
    Math.max(0, Math.min(1, ratio * 0.7 + coverage * 0.3 - contradictionPenalty)).toFixed(4),
  );
}

/** Match EntityKnowledgeStore statusFor. */
function statusFor(sample: number, pos: number, neg: number, confidence: number): string {
  if (sample >= 2 && neg >= Math.max(1, pos)) return "contradicted";
  if (
    sample >= MIN_VALIDATED_SAMPLES &&
    confidence >= 0.65 &&
    pos > neg
  ) {
    return "validated";
  }
  if (sample >= 1) return "provisional";
  return "observed";
}

function recomputeEntity(entity: EntityRec): { confBefore: number; statusBefore: string } {
  const confBefore = entity.confidence ?? 0;
  const statusBefore = entity.status;
  const evidence = Array.isArray(entity.evidence) ? entity.evidence : [];
  let sample = 0;
  let pos = 0;
  let neg = 0;
  for (const ev of evidence) {
    if (ev.outcome === "inconclusive" || !ev.outcome) continue;
    sample += 1;
    if (ev.outcome === "positive") pos += 1;
    if (ev.outcome === "negative") neg += 1;
  }
  entity.sampleCount = sample;
  entity.positiveCount = pos;
  entity.negativeCount = neg;
  entity.confidence = confidenceFor(sample, pos, neg);
  entity.status = statusFor(sample, pos, neg, entity.confidence);
  entity.updatedAt = new Date().toISOString();
  return { confBefore, statusBefore };
}

const HOST_NOISE_SUMMARY_RE =
  /plan_single_step_only|action_not_enabled|rite_explore_|failed_path_blacklist|recovery_rewind_required|day_close_|exchange_circuit_open|sudan_break_path_ready|use_explicit_next_day|missing_|_not_found|option_out_of_range|invalid_slotIndex|tool_exception|unknown_tool|host_reject/i;

/** Downgrade host-preflight "negative" evidence so it cannot keep contradicted status. */
function scrubHostNoiseEvidence(entity: EntityRec): number {
  const evidence = Array.isArray(entity.evidence) ? entity.evidence : [];
  let changed = 0;
  for (const ev of evidence) {
    if (ev.outcome !== "negative") continue;
    const summary = String(ev.summary ?? "");
    const ctxError = String(
      (ev.context as { error?: unknown; hostError?: unknown } | undefined)?.error ??
        (ev.context as { hostError?: unknown } | undefined)?.hostError ??
        "",
    );
    if (!HOST_NOISE_SUMMARY_RE.test(summary) && !HOST_NOISE_SUMMARY_RE.test(ctxError)) {
      continue;
    }
    ev.outcome = "inconclusive";
    if (summary && !/not game outcome/i.test(summary)) {
      ev.summary = `${summary} (scrubbed: host noise, not game outcome)`;
    }
    changed += 1;
  }
  if (changed > 0) {
    const facts = entity.facts ?? {};
    for (const field of ["failureModes", "bestPractices", "unknowns"] as const) {
      const arr = facts[field];
      if (!Array.isArray(arr)) continue;
      facts[field] = arr.filter(
        (item) => typeof item !== "string" || !HOST_NOISE_SUMMARY_RE.test(item),
      );
    }
    entity.facts = facts;
    recomputeEntity(entity);
  }
  return changed;
}

function clearOrphanRoutes(entity: EntityRec): string[] {
  const cleared: string[] = [];
  if ((entity.sampleCount ?? 0) > 0) return cleared;
  const facts = entity.facts ?? {};
  for (const field of ORPHAN_ROUTE_FIELDS) {
    const arr = facts[field];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    facts[field] = [];
    cleared.push(field);
  }
  entity.facts = facts;
  return cleared;
}

function tipEvidenceScore(tip: TipRec): number {
  const e = tip.evidence ?? {};
  return (
    (e.positiveCount ?? 0) * 10 +
    (e.observationCount ?? 0) +
    (e.netValueSum ?? 0) +
    Date.parse(tip.updatedAt ?? "") / 1e15
  );
}

function canonicalTipGroupKey(decisionKey: string): string | null {
  const rite = decisionKey.match(/^rite:(\d+):(validated_route|baseline_route)$/);
  if (rite) return `rite:${rite[1]}:baseline_route`;
  const interaction = decisionKey.match(
    /^interaction:(\d+):(?:[a-f0-9]+:)?rite:(\d+):(.+)$/i,
  );
  if (interaction) {
    return `interaction:${interaction[1]}:rite:${interaction[2]}:${interaction[3]}`;
  }
  return null;
}

function extractCompositionHint(body: string): string {
  const fromBody = body.match(/composition=[^|]+/);
  if (fromBody) return fromBody[0].trim();
  const afterColon = body.split(/已有可靠样本：|已知可行基线：/)[1];
  if (afterColon) {
    const cut = afterColon.split(/。分配|。安全/)[0] ?? afterColon;
    return cut.trim().slice(0, 120);
  }
  return "保持已验证的填槽组合";
}

function looksTruncatedTipBody(body: string): boolean {
  const trimmed = body.trim();
  // Half-cut English tokens at end (legacy distill), not intentional English policy words.
  return /\b(tex|positi|ou|s6|resourc|reward_c)\。?$/.test(trimmed);
}

function rewriteTipAsBaseline(tip: TipRec): boolean {
  const group = canonicalTipGroupKey(tip.decisionKey);
  if (!group) return false;
  let changed = false;
  if (tip.decisionKey !== group) {
    tip.decisionKey = group;
    changed = true;
  }
  const riteMatch = group.match(/^rite:(\d+):baseline_route$/);
  const nameFromTitle =
    tip.title.match(/【([^】]+)】/)?.[1] ??
    tip.body.match(/事件\s+([^\s（(]+)/)?.[1] ??
    "该事件";
  if (riteMatch) {
    const riteId = riteMatch[1];
    const hint = extractCompositionHint(tip.body);
    const isValidatedTitle = tip.title.includes("已验证") && !tip.title.includes("基线");
    const provisionalMislabel = isValidatedTitle && tip.status === "experimental";
    const title = provisionalMislabel || tip.status === "experimental"
      ? `【${nameFromTitle}】可靠样本路线`
      : `【${nameFromTitle}】已知可行基线`;
    const body =
      `事件 ${nameFromTitle}（riteId=${riteId}）已知可行基线：${hint}。` +
      `安全余量充足（处刑剩余≥3）或手牌有更优人选时可探索偏离；` +
      `处刑≤1锁死基线，=2 时普通仪式回基线；每 rite 每局最多试 2 次新组合；失败当日回基线。` +
      `禁止空槽/整堆金/再试已矛盾组合。`;
    if (tip.title !== title || tip.body !== body || looksTruncatedTipBody(tip.body)) {
      tip.title = title;
      tip.body = body;
      changed = true;
    }
    if (provisionalMislabel && tip.status !== "experimental") {
      tip.status = "experimental";
      changed = true;
    }
    return changed;
  }
  // interaction tips: soft rewrite exploration clause, keep practice text if not truncated
  if (looksTruncatedTipBody(tip.body) || /优先沿用|勿无故/.test(tip.body)) {
    const practice = tip.body.split(/。/)[0] ?? tip.body;
    tip.body =
      `${practice.replace(/[。．.]+$/, "")}。` +
      `此为可执行基线；安全余量充足时可探索更优槽位组合，末日或失败后回基线。`;
    if (/已验证/.test(tip.title) && tip.status === "experimental") {
      tip.title = tip.title.replace("已验证", "可靠样本");
    }
    changed = true;
  }
  return changed;
}

function qualityPassTips(tips: TipRec[]): {
  rewritten: string[];
  rejectedDuplicates: string[];
  negativeConfidenceFixed: never[];
} {
  const rewritten: string[] = [];
  const rejectedDuplicates: string[] = [];
  const groups = new Map<string, TipRec[]>();
  for (const tip of tips) {
    if (tip.status === "rejected" || tip.status === "superseded") continue;
    const group = canonicalTipGroupKey(tip.decisionKey);
    if (!group) {
      if (rewriteTipAsBaseline(tip)) rewritten.push(tip.id);
      continue;
    }
    const list = groups.get(group) ?? [];
    list.push(tip);
    groups.set(group, list);
  }
  for (const [group, members] of groups) {
    members.sort((a, b) => tipEvidenceScore(b) - tipEvidenceScore(a));
    const winner = members[0]!;
    if (rewriteTipAsBaseline(winner)) rewritten.push(winner.id);
    winner.decisionKey = group;
    for (const loser of members.slice(1)) {
      if (loser.status === "rejected") continue;
      loser.status = "rejected";
      rejectedDuplicates.push(loser.id);
    }
  }
  // Also rewrite any non-grouped tips that still use old imperatives
  for (const tip of tips) {
    if (tip.status === "rejected" || tip.status === "superseded") continue;
    if (/优先沿用|勿无故空槽/.test(tip.body) && rewriteTipAsBaseline(tip)) {
      if (!rewritten.includes(tip.id)) rewritten.push(tip.id);
    }
  }
  return { rewritten, rejectedDuplicates, negativeConfidenceFixed: [] };
}

function stripPlaceholderFromText(text: string): string {
  return text
    .replace(/\bNewText\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\|\s+/g, " | ")
    .trim();
}

function expectedNameForRite(
  riteId: number | undefined,
  events: EntityRec[],
): string | null {
  if (riteId == null) return null;
  const hit = events.find((e) => Number(e.facts?.riteId) === riteId);
  const name = hit?.facts?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

async function main(): Promise<void> {
  const { session, apply, quality } = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sessionDir = path.resolve(here, "..", "memory", "sessions", session);
  if (!fs.existsSync(sessionDir)) {
    throw new Error(`session not found: ${sessionDir}`);
  }

  const report: Record<string, unknown> = {
    session,
    apply,
    quality,
    at: new Date().toISOString(),
    quarantinedEpisodes: [] as string[],
    newTextCleared: 0,
    experiencesQuarantined: [] as string[],
    experiencesContradicted: [] as string[],
    entitiesTouched: [] as string[],
    negativeConfidenceFixed: [] as string[],
    orphanRoutesCleared: [] as string[],
    statusChanged: [] as string[],
    hostNoiseEvidenceScrubbed: [] as string[],
    tipsRewritten: [] as string[],
    tipsRejectedDuplicates: [] as string[],
    meta: null as unknown,
  };

  const tipsPath = path.join(sessionDir, "tips.json");
  const episodesPath = path.join(sessionDir, "pending-episodes.json");
  const eventsPath = path.join(sessionDir, "events.json");
  const cardsPath = path.join(sessionDir, "cards.json");
  const interactionsPath = path.join(sessionDir, "interactions.json");
  const experiencesPath = path.join(sessionDir, "experiences.json");
  const metaPath = path.join(sessionDir, "meta.json");
  const dayEvidencePath = path.join(sessionDir, "day-evidence.jsonl");

  const episodesFile = readJson<{ version: number; episodes: Episode[] }>(episodesPath);
  const eventsFile = readJson<{ version: number; entities: EntityRec[] }>(eventsPath);
  const cardsFile = readJson<{ version: number; entities: EntityRec[] }>(cardsPath);
  const interactionsFile = readJson<{ version: number; entities: EntityRec[] }>(
    interactionsPath,
  );
  const experiencesFile = readJson<{ version: number; experiences: Experience[] }>(
    experiencesPath,
  );
  const tipsFile = fs.existsSync(tipsPath)
    ? readJson<{ version: number; tips: TipRec[] }>(tipsPath)
    : { version: 1, tips: [] as TipRec[] };

  const events = eventsFile.entities;
  const quarantineIds = new Set<string>();

  for (const ep of episodesFile.episodes) {
    const settlement = ep.settlement && typeof ep.settlement === "object" ? ep.settlement : {};
    let changed = false;

    if (isPlaceholderTip(settlement.tip)) {
      settlement.tip = null;
      if (typeof settlement.summary === "string") {
        settlement.summary = stripPlaceholderFromText(settlement.summary);
      }
      ep.settlement = settlement;
      (report.newTextCleared as number)++;
      changed = true;
    }

    const titleNorm = normalizeTitle(settlement.title);
    const expected = expectedNameForRite(ep.riteId, events);
    const expectedNorm = expected ? normalizeTitle(expected) : "";
    const mismatch =
      Boolean(titleNorm) &&
      Boolean(expectedNorm) &&
      titleNorm !== expectedNorm &&
      !titleNorm.includes(expectedNorm) &&
      !expectedNorm.includes(titleNorm);

    if (mismatch || ep.quarantined) {
      ep.quarantined = true;
      settlement.scrub = {
        quarantined: true,
        reason: "title_rite_mismatch",
        expectedName: expected,
        title: settlement.title ?? null,
      };
      // Keep riteId/eventKey as identity; rewrite display title to expected.
      if (expected) settlement.title = expected;
      ep.settlement = settlement;
      quarantineIds.add(ep.id);
      (report.quarantinedEpisodes as string[]).push(ep.id);
      changed = true;
    } else if (changed) {
      ep.settlement = settlement;
    }
  }

  // Downgrade experiences linked to quarantined episodes + noise ops.
  const linkedExpIds = new Set<string>();
  for (const ep of episodesFile.episodes) {
    if (!quarantineIds.has(ep.id)) continue;
    for (const id of ep.settlementExperienceIds ?? []) linkedExpIds.add(id);
  }

  const quarantineExperiences: Experience[] = [];
  const keptExperiences: Experience[] = [];
  for (const exp of experiencesFile.experiences) {
    const op = String(exp.actionSignature ?? "").split("|")[0] ?? "";
    const noDelta = exp.actualDelta == null || exp.actualDelta.changed === false;
    if (linkedExpIds.has(exp.id)) {
      exp.status = "contradicted";
      (report.experiencesContradicted as string[]).push(exp.id);
      keptExperiences.push(exp);
      continue;
    }
    if (NOISE_OPS.has(op) && noDelta) {
      (report.experiencesQuarantined as string[]).push(exp.id);
      quarantineExperiences.push(exp);
      continue;
    }
    keptExperiences.push(exp);
  }
  experiencesFile.experiences = keptExperiences;

  const scrubEntity = (entity: EntityRec, kind: string) => {
    const before = entity.evidence?.length ?? 0;
    entity.evidence = (entity.evidence ?? []).filter((ev) => {
      const source = ev.sourceId;
      if (source && quarantineIds.has(source)) return false;
      const episodeId = ev.context?.episodeId;
      if (typeof episodeId === "string" && quarantineIds.has(episodeId)) return false;
      return true;
    });
    const facts = entity.facts ?? {};
    for (const field of ["successfulRoutes", "failureModes", "usages", "antiPatterns", "bestPractices"]) {
      const arr = facts[field];
      if (!Array.isArray(arr)) continue;
      facts[field] = arr
        .filter((row) => typeof row === "string")
        .map((row) => stripPlaceholderFromText(row))
        .filter((row) => row.length > 0 && !/new\s*text/i.test(row));
    }
    const lastResult = facts.lastResult;
    if (lastResult && typeof lastResult === "object") {
      const lr = { ...(lastResult as Record<string, unknown>) };
      if (isPlaceholderTip(lr.tip)) lr.tip = null;
      const name = typeof facts.name === "string" ? facts.name : null;
      if (name && normalizeTitle(lr.title) && normalizeTitle(lr.title) !== normalizeTitle(name)) {
        // Drop misleading title; keep body/summary cleaned.
        lr.title = name;
      }
      if (typeof lr.summary === "string") lr.summary = stripPlaceholderFromText(lr.summary);
      facts.lastResult = lr;
    }
    // High-enc / zero-sample: clear stale route_unknown spam only when still empty.
    if ((entity.sampleCount ?? 0) === 0 && Array.isArray(facts.unknowns)) {
      facts.unknowns = (facts.unknowns as unknown[]).filter(
        (u) => u !== "route_unknown" || (entity.encounterCount ?? 0) < 20,
      );
    }
    entity.facts = facts;
    const hostNoiseScrubbed = scrubHostNoiseEvidence(entity);
    if (hostNoiseScrubbed > 0) {
      (report.hostNoiseEvidenceScrubbed as string[]).push(
        `${kind}:${entity.key}:${hostNoiseScrubbed}`,
      );
    }
    const { confBefore, statusBefore } = recomputeEntity(entity);
    if (confBefore < 0 && (entity.confidence ?? 0) >= 0) {
      (report.negativeConfidenceFixed as string[]).push(`${kind}:${entity.key}`);
    }
    if (statusBefore !== entity.status) {
      (report.statusChanged as string[]).push(
        `${kind}:${entity.key}:${statusBefore}->${entity.status}`,
      );
    }
    const cleared = clearOrphanRoutes(entity);
    if (cleared.length > 0) {
      (report.orphanRoutesCleared as string[]).push(
        `${kind}:${entity.key}:${cleared.join(",")}`,
      );
    }
    if (
      (entity.evidence?.length ?? 0) !== before ||
      quarantineIds.size > 0 ||
      cleared.length > 0 ||
      confBefore !== entity.confidence ||
      statusBefore !== entity.status
    ) {
      (report.entitiesTouched as string[]).push(`${kind}:${entity.key}`);
    }
  };

  for (const e of eventsFile.entities) scrubEntity(e, "event");
  for (const c of cardsFile.entities) scrubEntity(c, "card");
  for (const i of interactionsFile.entities) scrubEntity(i, "interaction");

  if (quality) {
    const tipResult = qualityPassTips(tipsFile.tips);
    report.tipsRewritten = tipResult.rewritten;
    report.tipsRejectedDuplicates = tipResult.rejectedDuplicates;
  }

  // Meta cursor from day-evidence.
  let maxReviewed: number | null = null;
  if (fs.existsSync(dayEvidencePath)) {
    const lines = fs.readFileSync(dayEvidencePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as { dayWindow?: number; day?: number };
        const d = row.dayWindow ?? row.day;
        if (typeof d === "number" && Number.isFinite(d)) {
          maxReviewed = maxReviewed == null ? d : Math.max(maxReviewed, d);
        }
      } catch {
        // skip
      }
    }
  }
  const meta = fs.existsSync(metaPath)
    ? readJson<Record<string, unknown>>(metaPath)
    : { id: session, createdAt: "" };
  meta.lastReviewedDay = maxReviewed;
  meta.activeHypothesisId = meta.activeHypothesisId ?? null;
  report.meta = {
    lastReviewedDay: meta.lastReviewedDay,
    activeHypothesisId: meta.activeHypothesisId,
  };

  const reportPath = path.join(sessionDir, "scrub-report.json");
  if (apply) {
    writeJson(episodesPath, episodesFile);
    writeJson(eventsPath, eventsFile);
    writeJson(cardsPath, cardsFile);
    writeJson(interactionsPath, interactionsFile);
    writeJson(experiencesPath, experiencesFile);
    writeJson(metaPath, meta);
    if (quality) {
      writeJson(tipsPath, tipsFile);
    }
    if (quarantineExperiences.length > 0) {
      writeJson(path.join(sessionDir, "experiences.quarantine.json"), {
        version: 1,
        experiences: quarantineExperiences,
      });
    }
    // Distill tips from cleaned entities so the playbook is usable immediately.
    try {
      const { TipStore } = await import("@vibesultan/agent-learning-core");
      const { createSultanEntityStores } = await import("../src/memory/entityMemory.js");
      const { distillTipsFromEntities } = await import("../src/memory/dayReview.js");
      const tipStore = new TipStore(sessionDir);
      const stores = createSultanEntityStores(sessionDir);
      const created = distillTipsFromEntities(tipStore, stores, `scrub:${session}`, 20);
      report.distilledTipIds = created;
      if (quality) {
        // Re-run tip quality after distill so new tips also get baseline wording.
        const refreshed = readJson<{ version: number; tips: TipRec[] }>(tipsPath);
        const tipResult = qualityPassTips(refreshed.tips);
        writeJson(tipsPath, refreshed);
        report.tipsRewritten = [
          ...new Set([
            ...(report.tipsRewritten as string[]),
            ...tipResult.rewritten,
          ]),
        ];
        report.tipsRejectedDuplicates = [
          ...new Set([
            ...(report.tipsRejectedDuplicates as string[]),
            ...tipResult.rejectedDuplicates,
          ]),
        ];
      }
    } catch (err) {
      report.distillError = err instanceof Error ? err.message : String(err);
    }
    writeJson(reportPath, report);
    console.log(`scrub applied → ${sessionDir}`);
  } else {
    writeJson(reportPath, { ...report, dryRun: true });
    console.log(`scrub dry-run report → ${reportPath}`);
  }
  console.log(
    JSON.stringify(
      {
        quarantinedEpisodes: (report.quarantinedEpisodes as string[]).length,
        newTextCleared: report.newTextCleared,
        experiencesQuarantined: (report.experiencesQuarantined as string[]).length,
        experiencesContradicted: (report.experiencesContradicted as string[]).length,
        entitiesTouched: (report.entitiesTouched as string[]).length,
        negativeConfidenceFixed: (report.negativeConfidenceFixed as string[]).length,
        orphanRoutesCleared: (report.orphanRoutesCleared as string[]).length,
        statusChanged: (report.statusChanged as string[]).length,
        hostNoiseEvidenceScrubbed: (report.hostNoiseEvidenceScrubbed as string[]).length,
        tipsRewritten: (report.tipsRewritten as string[]).length,
        tipsRejectedDuplicates: (report.tipsRejectedDuplicates as string[]).length,
        meta: report.meta,
        quality,
        apply,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
