import fs from "node:fs";
import path from "node:path";
import {
  ExperimentLedger,
  HypothesisStore,
  TipStore,
  buildResearchAgenda,
  findDuplicate,
  newExperimentPlanId,
  type DecisionTrace,
  type Hypothesis,
  type NextAction,
  type Outcome,
} from "@vibesultan/agent-learning-core";
import { strategyExercised } from "./compliance.js";
import { evaluateHypothesisRetest } from "./evaluator.js";
import {
  buildMemoryInjection,
  classifyOutcome,
  detectReviewSignals,
  extractEvidence,
  extractMetrics,
  filterPlaybookHypotheses,
  filterPlaybookTips,
  isTerminalState,
  primaryMetricForTopic,
  summarizeRun,
} from "./sultanAdapter.js";
import { tracesToSummary } from "./traceAdapter.js";
import type { GameState } from "../game/types.js";
import { config } from "../config.js";
import { createSultanEntityStores } from "./entityMemory.js";

export interface DayReviewProposal {
  hypothesis?: {
    claim: string;
    rationale: string;
    constraints: string;
    topicKey: string;
  };
  tip?: { decisionKey: string; title: string; body: string };
}

export interface DayReviewCursor {
  lastReviewedDay: number | null;
  activeHypothesisId: string | null;
  baselineState: unknown | null;
  baselineTraces: DecisionTrace[];
  gameIndex: number;
  /** Adjacent-day validate attempts for the current active hypothesis. */
  validateAttempts?: number;
}

export interface DayReviewResult {
  cursor: DayReviewCursor;
  memoryInjection: string;
  createdHypothesisId?: string;
  createdTipId?: string;
  evaluatedHypothesisId?: string;
  evaluationDecision?: string;
  outcomeAppended: boolean;
  proposed: boolean;
  dayEvidenceAppended: boolean;
}

const MAX_VALIDATE_ATTEMPTS = 2;

function appendOutcome(sessionDir: string, outcome: Outcome): void {
  const p = path.join(sessionDir, "outcomes.jsonl");
  fs.appendFileSync(p, JSON.stringify(outcome) + "\n", "utf8");
}

function appendDayEvidence(
  sessionDir: string,
  row: Record<string, unknown>,
): void {
  const p = path.join(sessionDir, "day-evidence.jsonl");
  fs.appendFileSync(p, JSON.stringify(row) + "\n", "utf8");
}

export function ruleBasedDayReview(opts: {
  runId: string;
  dayWindow: number;
  state: unknown;
  stateBefore?: unknown;
  traces?: DecisionTrace[];
  finalText?: string;
  stopReason?: string;
}): DayReviewProposal {
  const metrics = extractMetrics(opts.state);
  const outcome = classifyOutcome(opts.state, metrics);
  const day = metrics.day ?? opts.dayWindow;
  const sudan = metrics.sudanRemaining;
  const executionLeft =
    typeof metrics.sudanRemaining === "number" ? metrics.sudanRemaining : null;
  const riteCount = typeof metrics.riteCount === "number" ? metrics.riteCount : null;
  const summary =
    opts.finalText && opts.finalText.trim()
      ? summarizeRun(opts.state, opts.finalText, opts.stopReason ?? "day_review")
      : [
          `dayWindow=${opts.dayWindow}`,
          `day=${day}`,
          `metrics=${JSON.stringify(metrics)}`,
          `traces=${opts.traces?.length ?? 0}`,
        ].join(" | ");

  if (outcome === "negative" || (typeof sudan === "number" && sudan <= 2)) {
    return {
      hypothesis: {
        topicKey: "sudan_pressure",
        claim: "苏丹卡倒计时偏低时应优先处理主线事件而非仪式刷资源",
        rationale: summary,
        constraints: "sudanRemaining <= 3 或 outcome negative",
      },
      tip: {
        decisionKey: "prioritize_story_over_rite",
        title: "倒计时紧张时优先故事选项",
        body: "当 sudan 剩余天数 ≤3，先推进主线/任务选项，再考虑仪式刷资源。",
      },
    };
  }

  if (executionLeft === 1) {
    return {
      hypothesis: {
        topicKey: "execution_timing",
        claim: "处刑最后一天必须优先完成可验证销卡路径，再考虑日常收益",
        rationale: summary.slice(0, 400),
        constraints: "executionDaysLeft == 1",
      },
      tip: {
        decisionKey: "break_sudan_on_last_day",
        title: "处刑末日优先销卡",
        body: "处刑剩余 1 天时，先 open_rite 找到可放苏丹卡的槽并 execute；不要只刷治理家业/书店。",
      },
    };
  }

  if (typeof riteCount === "number" && riteCount >= 8 && day >= 4) {
    return {
      hypothesis: {
        topicKey: "map_scout_added",
        claim: "地图点变多时应优先扫 mapChanges 的 added 新地点，再回头刷常驻点",
        rationale: summary.slice(0, 400),
        constraints: "riteCount >= 8 且 day >= 4",
      },
      tip: {
        decisionKey: "scout_added_map_rites_first",
        title: "先扫新增地图点",
        body: "brief 出现 added: 时，优先 open_rite 这些 uid；不要只开权力的游戏/治理家业。",
      },
    };
  }

  if (day >= 5) {
    return {
      hypothesis: {
        topicKey: "rite_efficiency",
        claim: "中后期应优先填满仪式槽再提交以提高资源转化",
        rationale: summary.slice(0, 400),
        constraints: "day >= 5 且 screen.phase=rite 或 play",
      },
      tip: {
        decisionKey: "fill_rite_slots_before_execute",
        title: "中后期先填满仪式槽再提交",
        body: "day≥5 时优先把可复用人物/道具填进高收益仪式槽，再 execute；避免空槽或半槽提交。",
      },
    };
  }

  if (day >= 3 && day <= 4) {
    return {
      hypothesis: {
        topicKey: "tier_match",
        claim: "高阶卡应优先匹配高阶任务/苏丹出口，低阶人物承担跑腿日常",
        rationale: summary.slice(0, 400),
        constraints: "day 3-4",
      },
      tip: {
        decisionKey: "match_tier_before_errands",
        title: "品阶匹配后再跑腿",
        body: "银/金战略卡先看销卡与高收益槽；石/铜人物优先治理家业、书店等日常。",
      },
    };
  }

  return {
    hypothesis: {
      topicKey: "early_explore",
      claim: "开局前几天应先摸清 handCount、地图点与事件选项再密集分配",
      rationale: summary.slice(0, 400),
      constraints: "day <= 3",
    },
    tip: {
      decisionKey: "scout_before_dense_allocate",
      title: "开局先摸清再密集分配",
      body: "前几天先看今日消息、手牌用途与地图点变化，再按 Top3 分配；避免开局盲目塞卡。",
    },
  };
}

/** Distill playbook tips from validated entity knowledge (does not consume hyp slot). */
export function truncateRouteHint(raw: string, maxLen = 120): string {
  const composition = raw.match(/composition=[^|]*/)?.[0] ?? raw.trim();
  if (composition.length <= maxLen) return composition.trim();
  const slice = composition.slice(0, maxLen);
  const cut = Math.max(slice.lastIndexOf("|"), slice.lastIndexOf(","), slice.lastIndexOf(" "));
  const base = (cut > maxLen * 0.5 ? slice.slice(0, cut) : slice).trim().replace(/[|,\s]+$/, "");
  return `${base}…`;
}

export function canonicalInteractionDecisionKey(
  cardId: number | string,
  eventKey: string,
  slotKey: string | number | null | undefined,
): string {
  const riteMatch = String(eventKey).match(/rite:(\d+)/i);
  const ritePart = riteMatch ? `rite:${riteMatch[1]}` : String(eventKey).replace(/^[a-f0-9]+:/i, "");
  return `interaction:${cardId}:${ritePart}:${String(slotKey ?? "s?")}`;
}

export function distillTipsFromEntities(
  tipStore: TipStore,
  entityStores: ReturnType<typeof createSultanEntityStores>,
  runId: string,
  maxNew = 12,
  opts?: { socialCapitalEnabled?: boolean },
): string[] {
  const created: string[] = [];
  const existingKeys = new Set(tipStore.list().map((t) => t.decisionKey));
  const socialEnabled =
    opts?.socialCapitalEnabled ?? config.agentSocialCapitalEnabled;

  const seedTips: Array<{
    decisionKey: string;
    title: string;
    body: string;
    status?: "experimental" | "active";
  }> = [
    {
      decisionKey: "gold_dice_optional_default_skip",
      title: "金骰默认跳过",
      body: "rite_result 的 gold_select 非强制；默认 continue 点空白跳过，仅门槛不够时再 select_gold_dice。",
    },
    {
      decisionKey: "min_gold_cost_on_place",
      title: "金币按 costMin 最小放置",
      body: "书店等只要 1 金币的槽，place_card_on_rite 传 count=costMin，禁止整堆丢入。",
    },
    {
      decisionKey: "execution_drag_when_safe",
      title: "有把握时拖到处刑末日再销卡",
      body: "处刑剩余 >1 且已有销卡路径时，前几天优先积累收益，末日再 execute 销卡。",
    },
  ];

  if (socialEnabled) {
    seedTips.push({
      decisionKey: "rebellion_strategic_patience",
      title: "苏丹是终局 Boss：结党卧薪",
      body: "苏丹不是盟友。executionDaysLeft 安全时优先结交/保全具名追随者与清流资产；短期金币损耗视为战略投资。实力未成前隐忍，勿做必死对抗。",
      status: "active",
    });
  }

  for (const tip of seedTips) {
    if (created.length >= maxNew) break;
    if (existingKeys.has(tip.decisionKey)) continue;
    const t = tipStore.create({
      decisionKey: tip.decisionKey,
      title: tip.title,
      body: tip.body,
      sourceInstanceId: runId,
      status: tip.status ?? "experimental",
    });
    existingKeys.add(tip.decisionKey);
    created.push(t.id);
  }

  for (const event of entityStores.events.list()) {
    if (created.length >= maxNew) break;
    if (event.status !== "validated" && event.status !== "provisional") continue;
    const riteId = event.facts?.riteId;
    const name = typeof event.facts?.name === "string" ? event.facts.name : null;
    if (typeof riteId !== "number" || !name) continue;
    const routes = Array.isArray(event.facts?.successfulRoutes)
      ? event.facts.successfulRoutes.filter((r): r is string => typeof r === "string")
      : [];
    if (routes.length === 0 && event.status !== "validated") continue;
    const decisionKey = `rite:${riteId}:baseline_route`;
    // Also skip legacy key so we do not double-create before scrub migrates.
    if (
      existingKeys.has(decisionKey) ||
      existingKeys.has(`rite:${riteId}:validated_route`)
    ) {
      continue;
    }
    const routeHint =
      routes[0] != null ? truncateRouteHint(routes[0]) : "保持已验证的填槽组合";
    const validated = event.status === "validated";
    const t = tipStore.create({
      decisionKey,
      title: validated
        ? `【${name}】已知可行基线`
        : `【${name}】可靠样本路线`,
      body:
        `事件 ${name}（riteId=${riteId}）已知可行基线：${routeHint}。` +
        `安全余量充足（处刑剩余≥3）或手牌有更优人选时可探索偏离；` +
        `处刑≤1锁死基线，=2 时普通仪式回基线；每 rite 每局最多试 2 次新组合；失败当日回基线。` +
        `禁止空槽/整堆金/再试已矛盾组合。`,
      sourceInstanceId: runId,
      status: validated ? "active" : "experimental",
    });
    existingKeys.add(decisionKey);
    created.push(t.id);
  }

  for (const interaction of entityStores.interactions.list()) {
    if (created.length >= maxNew) break;
    if (interaction.status !== "validated") continue;
    const cardId = interaction.facts?.cardId;
    const eventKey = interaction.facts?.eventKey;
    const slotKey = interaction.facts?.slotKey ?? interaction.facts?.slotIndex;
    if (cardId == null || !eventKey) continue;
    const decisionKey = canonicalInteractionDecisionKey(
      Number(cardId),
      String(eventKey),
      slotKey as string | number | null | undefined,
    );
    if (existingKeys.has(decisionKey)) continue;
    const practices = Array.isArray(interaction.facts?.bestPractices)
      ? interaction.facts.bestPractices.filter((r): r is string => typeof r === "string")
      : [];
    const practiceHint = practices[0]
      ? truncateRouteHint(practices[0], 140)
      : `把 cardId=${cardId} 放到该事件对应槽位`;
    const t = tipStore.create({
      decisionKey,
      title: `卡 ${cardId} → ${decisionKey.split(":").slice(2).join(":")}`,
      body:
        `${practiceHint}。此为可执行基线；安全余量充足时可探索更优槽位组合，末日或失败后回基线。`,
      sourceInstanceId: runId,
      status: "active",
    });
    existingKeys.add(decisionKey);
    created.push(t.id);
  }

  return created;
}

function buildDailyMemoryInjection(
  hypotheses: Hypothesis[],
  tips: Array<{ title: string; body: string; status: string }>,
  budgetChars: number,
  activeHypothesisId: string | null,
): string {
  const playbookH = filterPlaybookHypotheses(
    hypotheses.map((h) => ({
      claim: h.claim,
      constraints: h.constraints,
      status: h.status,
    })),
  );
  const playbookT = filterPlaybookTips(tips);
  const base = buildMemoryInjection(playbookH, playbookT, budgetChars);
  const active = activeHypothesisId
    ? hypotheses.find((h) => h.id === activeHypothesisId)
    : null;
  const parts = ["## 本局每日记忆（只读）", base];
  if (active) {
    parts.push(
      "",
      "## 待同局验证假设",
      `- id: ${active.id}`,
      `- claim: ${active.claim}`,
      `- constraints: ${active.constraints}`,
      `- topic: ${active.topicKey}`,
      `- primaryMetric: ${active.primaryMetric?.name ?? "score"} (${active.primaryMetric?.direction ?? "increase"})`,
      "在接下来的一天里优先验证该假设，并记录 primaryMetric 变化。",
    );
  }
  const text = parts.join("\n");
  return text.length > budgetChars ? text.slice(0, budgetChars) + "\n…" : text;
}

function linkedTip(
  tipStore: TipStore,
  hypothesisId: string,
): ReturnType<TipStore["list"]>[number] | undefined {
  return tipStore.list().find((t) => t.sourceHypothesisId === hypothesisId);
}

function supersedeSameDecisionKey(tipStore: TipStore, decisionKey: string, keepId?: string): void {
  for (const tip of tipStore.list()) {
    if (tip.decisionKey !== decisionKey) continue;
    if (keepId && tip.id === keepId) continue;
    if (tip.status === "rejected" || tip.status === "superseded") continue;
    tipStore.setStatus(tip.id, "superseded", { reason: "same_decision_key_slot" });
  }
}

/**
 * Persist a daily review: always write day evidence/outcome; settle previous
 * hypothesis when due; propose only when agenda is free or a new signal fires.
 */
export function runDailyReview(opts: {
  sessionDir: string;
  runId: string;
  dayWindow: number;
  state: GameState | unknown;
  stateBefore?: GameState | unknown;
  traces?: DecisionTrace[];
  cursor: DayReviewCursor;
  budgetChars: number;
  finalText?: string;
  stopReason?: string;
  terminalFlush?: boolean;
}): DayReviewResult {
  const hypothesisStore = new HypothesisStore(opts.sessionDir);
  const tipStore = new TipStore(opts.sessionDir);
  const ledger = new ExperimentLedger(opts.sessionDir);
  const entityStores = createSultanEntityStores(opts.sessionDir);
  const cursor: DayReviewCursor = {
    ...opts.cursor,
    validateAttempts: opts.cursor.validateAttempts ?? 0,
  };
  let evaluatedHypothesisId: string | undefined;
  let evaluationDecision: string | undefined;
  let keepActive = false;
  const traces = opts.traces ?? [];
  // Terminal / endgame is diagnostic-only: no scoring, retest, tip updates, or new claims.
  const terminal =
    opts.terminalFlush === true || isTerminalState(opts.state);
  let signals: { forcePropose: boolean; reason: string | null } = {
    forcePropose: false,
    reason: null,
  };
  let createdHypothesisId: string | undefined;
  let createdTipId: string | undefined;
  let proposed = false;
  let outcomeAppended = false;

  // --- Settle previous active hypothesis (adjacent day window) ---
  if (!terminal && cursor.activeHypothesisId && cursor.baselineState != null) {
    const hypothesis = hypothesisStore
      .list()
      .find((h) => h.id === cursor.activeHypothesisId);
    if (hypothesis) {
      const tip = linkedTip(tipStore, hypothesis.id);
      const exercised = strategyExercised({
        topicKey: hypothesis.topicKey,
        decisionKey: tip?.decisionKey,
        constraints: hypothesis.constraints,
        traces,
      });

      let evaluation = evaluateHypothesisRetest({
        hypothesis,
        baselineState: cursor.baselineState,
        retestState: opts.state,
        baselineTrace: tracesToSummary({ traces: cursor.baselineTraces }),
        retestTrace: tracesToSummary({ traces }),
        tipStore,
        sessionIndex: cursor.gameIndex,
      });

      if (!exercised) {
        evaluation = {
          ...evaluation,
          decision: "inconclusive",
          reason: "strategy_not_exercised",
          confounded: true,
        };
        // Still record tip opportunity without punishing as reject.
        if (tip) {
          tipStore.addEvidence(tip.id, {
            observations: 1,
            positives: 0,
            negatives: 0,
            netValues: [0],
            sessionIndex: cursor.gameIndex,
          });
        }
      }

      const attempts = (cursor.validateAttempts ?? 0) + 1;
      cursor.validateAttempts = attempts;

      let nextAction: NextAction = "archive";
      if (evaluation.decision === "accepted") nextAction = "accept";
      else if (evaluation.decision === "rejected") nextAction = "revise";
      else if (attempts < MAX_VALIDATE_ATTEMPTS) nextAction = "retry_same";

      const hypStatus =
        evaluation.decision === "accepted"
          ? ("validated" as const)
          : evaluation.decision === "rejected"
            ? ("rejected" as const)
            : ("inconclusive" as const);
      const outcomeClass =
        evaluation.decision === "accepted"
          ? ("positive" as const)
          : evaluation.reason === "strategy_not_exercised"
            ? ("noncompliant" as const)
            : evaluation.confounded
              ? ("confounded" as const)
              : evaluation.decision === "rejected"
                ? ("negative" as const)
                : ("pending" as const);

      hypothesisStore.update(hypothesis.id, {
        status: hypStatus,
        outcomeClass,
        nextAction,
        evidence: extractEvidence(opts.state),
      });

      const tipStatus =
        evaluation.decision === "accepted"
          ? ("active" as const)
          : evaluation.decision === "rejected"
            ? ("rejected" as const)
            : ("experimental" as const);
      for (const t of tipStore.list()) {
        if (t.sourceHypothesisId !== hypothesis.id) continue;
        tipStore.setStatus(t.id, tipStatus, {
          reason: evaluation.reason ?? `hypothesis_${evaluation.decision}`,
        });
        if (evaluation.decision === "accepted") {
          supersedeSameDecisionKey(tipStore, t.decisionKey, t.id);
        }
      }

      // Drop matching ledger head when this hypothesis leaves the validate queue.
      if (nextAction !== "retry_same") {
        while (ledger.peek()?.hypothesisId === hypothesis.id) {
          ledger.dequeue();
        }
      }

      evaluatedHypothesisId = hypothesis.id;
      evaluationDecision = evaluation.reason === "strategy_not_exercised"
        ? "inconclusive"
        : evaluation.decision;

      if (nextAction === "retry_same") {
        keepActive = true;
        cursor.baselineState = opts.state;
        cursor.baselineTraces = [...traces];
      } else {
        cursor.activeHypothesisId = null;
        cursor.validateAttempts = 0;
      }
    }
  }

  if (!terminal) {
    const activeHyp = cursor.activeHypothesisId
      ? hypothesisStore.list().find((h) => h.id === cursor.activeHypothesisId)
      : null;
    signals = detectReviewSignals({
      state: opts.state,
      stateBefore: opts.stateBefore ?? cursor.baselineState ?? undefined,
      activeTopicKey: activeHyp?.topicKey,
    });

    const agenda = buildResearchAgenda(hypothesisStore.list(), ledger.list());
    const proposal = ruleBasedDayReview({
      runId: opts.runId,
      dayWindow: opts.dayWindow,
      state: opts.state,
      stateBefore: opts.stateBefore,
      traces,
      finalText: opts.finalText,
      stopReason: opts.stopReason ?? "day_review",
    });

    const canPropose =
      !keepActive &&
      (!cursor.activeHypothesisId || signals.forcePropose) &&
      Boolean(proposal.hypothesis);

    if (canPropose && proposal.hypothesis) {
      const dup = findDuplicate(
        proposal.hypothesis.claim,
        proposal.hypothesis.topicKey,
        hypothesisStore.list(),
        undefined,
        0.62,
      );
      const topicCooling = agenda.topics.some(
        (t) => t.topicKey === proposal.hypothesis!.topicKey && t.coolingDown,
      );

      if (!dup && !topicCooling) {
        if (signals.forcePropose && cursor.activeHypothesisId) {
          hypothesisStore.update(cursor.activeHypothesisId, {
            status: "inconclusive",
            nextAction: "switch_topic",
            outcomeClass: "pending",
          });
          cursor.activeHypothesisId = null;
          cursor.validateAttempts = 0;
        }

        const metric = primaryMetricForTopic(proposal.hypothesis.topicKey);
        const h = hypothesisStore.create({
          claim: proposal.hypothesis.claim,
          rationale: proposal.hypothesis.rationale,
          constraints: proposal.hypothesis.constraints,
          topicKey: proposal.hypothesis.topicKey,
          sourceInstanceId: opts.runId,
          sessionIndex: cursor.gameIndex,
          primaryMetric: metric,
        });
        createdHypothesisId = h.id;
        cursor.activeHypothesisId = h.id;
        cursor.validateAttempts = 0;
        proposed = true;

        ledger.enqueue({
          id: newExperimentPlanId(),
          hypothesisId: h.id,
          instanceId: opts.runId,
          primaryMetric: metric,
          enqueuedAt: new Date().toISOString(),
          priority: signals.forcePropose ? 8 : 5,
        });

        if (proposal.tip) {
          supersedeSameDecisionKey(tipStore, proposal.tip.decisionKey);
          const t = tipStore.create({
            decisionKey: proposal.tip.decisionKey,
            title: proposal.tip.title,
            body: proposal.tip.body,
            sourceInstanceId: opts.runId,
            sourceHypothesisId: createdHypothesisId,
            status: "experimental",
          });
          createdTipId = t.id;
        }
      }
    }
  }

  // --- Daily outcome (early-game only) + day evidence (always, for diagnostics) ---
  const metrics = extractMetrics(opts.state);
  const beforeMetrics =
    opts.stateBefore != null
      ? extractMetrics(opts.stateBefore)
      : cursor.baselineState != null
        ? extractMetrics(cursor.baselineState)
        : null;

  if (!terminal && metrics.earlyEligible === 1) {
    appendOutcome(opts.sessionDir, {
      runId: `${opts.runId}:day${opts.dayWindow}`,
      score: metrics.earlyScore,
      metrics: { ...metrics, dayWindow: opts.dayWindow },
      outcomeClass: classifyOutcome(opts.state, metrics),
      recordedAt: new Date().toISOString(),
    });
    outcomeAppended = true;
  }

  appendDayEvidence(opts.sessionDir, {
    ts: new Date().toISOString(),
    runId: opts.runId,
    dayWindow: opts.dayWindow,
    metrics,
    deltas:
      beforeMetrics != null
        ? Object.fromEntries(
            Object.keys(metrics).map((k) => {
              const a = metrics[k];
              const b = beforeMetrics[k];
              return [
                k,
                typeof a === "number" && typeof b === "number" ? a - b : null,
              ];
            }),
          )
        : null,
    traces: traces.length,
    activeHypothesisId: cursor.activeHypothesisId,
    evaluatedHypothesisId: evaluatedHypothesisId ?? null,
    evaluationDecision: evaluationDecision ?? null,
    proposed,
    signal: signals.reason,
    terminal,
    outcomeAppended,
    entityUpdates: {
      cards: summarizeEntityStatuses(entityStores.cards.list()),
      events: summarizeEntityStatuses(entityStores.events.list()),
      interactions: summarizeEntityStatuses(entityStores.interactions.list()),
    },
  });

  // Passive evidence for active/experimental tips every day (opportunity clock).
  if (!terminal) {
    for (const tip of tipStore.list()) {
      if (tip.status !== "active" && tip.status !== "experimental" && tip.status !== "candidate") {
        continue;
      }
      if (evaluatedHypothesisId && tip.sourceHypothesisId === evaluatedHypothesisId) {
        continue; // already updated during settle
      }
      const exercised = strategyExercised({
        decisionKey: tip.decisionKey,
        topicKey: tip.sourceHypothesisId
          ? hypothesisStore.get(tip.sourceHypothesisId)?.topicKey
          : undefined,
        traces,
      });
      const updated = tipStore.addEvidence(tip.id, {
        observations: 1,
        positives: exercised ? 1 : 0,
        negatives: 0,
        netValues: [exercised ? 1 : 0],
        sessionIndex: cursor.gameIndex,
      });
      // Promote experimental tips with enough positive evidence.
      if (
        updated &&
        updated.status === "experimental" &&
        updated.evidence.positiveCount >= 2 &&
        updated.evidence.observationCount >= 2
      ) {
        tipStore.setStatus(tip.id, "active", { reason: "daily_evidence_promote" });
        supersedeSameDecisionKey(tipStore, tip.decisionKey, tip.id);
      }
    }
  }

  if (!terminal) {
    cursor.lastReviewedDay = opts.dayWindow;
  }
  if (!terminal && !keepActive) {
    cursor.baselineState = opts.state;
    cursor.baselineTraces = [...traces];
  }

  // Entity → tip distillation (does not consume the single hyp validate slot).
  if (!terminal) {
    distillTipsFromEntities(tipStore, entityStores, opts.runId);
  }

  const memoryInjection = buildDailyMemoryInjection(
    hypothesisStore.list(),
    tipStore.list().map((t) => ({ title: t.title, body: t.body, status: t.status })),
    opts.budgetChars,
    cursor.activeHypothesisId,
  );

  return {
    cursor,
    memoryInjection,
    createdHypothesisId,
    createdTipId,
    evaluatedHypothesisId,
    evaluationDecision,
    outcomeAppended,
    proposed,
    dayEvidenceAppended: true,
  };
}

function summarizeEntityStatuses(
  records: Array<{ status: string }>,
): Record<string, number> {
  const summary: Record<string, number> = { total: records.length };
  for (const record of records) {
    summary[record.status] = (summary[record.status] ?? 0) + 1;
  }
  return summary;
}

export function emptyDayReviewCursor(gameIndex = 1): DayReviewCursor {
  return {
    lastReviewedDay: null,
    activeHypothesisId: null,
    baselineState: null,
    baselineTraces: [],
    gameIndex,
    validateAttempts: 0,
  };
}
