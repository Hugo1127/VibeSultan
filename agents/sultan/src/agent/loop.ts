import fs from "node:fs";
import path from "node:path";
import {
  ExperienceStore,
  type DecisionTrace,
  type ExperienceRecord,
} from "@vibesultan/agent-learning-core";
import type OpenAI from "openai";
import type { AppConfig } from "../config.js";
import type { GameOps } from "../game/GameOps.js";
import type { AgentLogger } from "../log/AgentLogger.js";
import { createTimedChatCompletion, streamChatText } from "../llm/timedChat.js";
import {
  compressMessages,
  compressMessagesDeterministic,
  estimateTokens,
  shouldCompressContext,
  type ChatMessage,
} from "./contextCompress.js";
import {
  mergeCompressedSnapshot,
  shouldStartBackgroundCompression,
  updateTurnGrowthEwma,
  type CompressionSnapshot,
} from "./backgroundCompress.js";
import {
  ActionFailureLedger,
  exchangeContextKeyFromGameState,
  extractSubmittedActions,
  stateKeyFromGameState,
} from "./failureLedger.js";
import { buildSystemPrompt, EXPLORE_MODE_HINT, VALIDATE_MODE_HINT } from "./systemPrompt.js";
import type { GameAction, GameState, SceneSnapshot } from "../game/types.js";
import type { DayCandidateLedger, DayPlan, Prediction } from "../game/strategyTypes.js";
import {
  buildPrediction,
  buildStrategySnapshot,
  recordActionExperience,
} from "../memory/experienceAdapter.js";
import { generateEventConfigurations } from "../planner/candidateGenerator.js";
import {
  emptyDayCandidateLedger,
  formatDayCloseReviewBrief,
  ingestConfigurationsIntoLedger,
  reviewDayCloseAllocations,
} from "../planner/dayCloseReview.js";
import {
  applyRiteSettlement,
  enrichmentTargetsFromUpdates,
  reliableCardInspection,
  recordEntityKnowledge,
  touchEntitiesFromState,
} from "../memory/entityAdapter.js";
import { createSultanEntityStores } from "../memory/entityMemory.js";
import {
  cardInspectionRequirement,
  retrieveRelevantEntityKnowledge,
} from "../memory/entityRetriever.js";
import { buildEntityMemoryInjection } from "../memory/entityInjection.js";
import { EnrichmentQueue } from "../memory/enrichmentQueue.js";
import { EpisodeStore } from "../memory/episodeStore.js";
import { EpisodeTracker } from "../memory/episodeTracker.js";
import { recordEpisodeActions } from "../memory/episodeAdapter.js";
import { SudanRouteStore } from "../memory/sudanRouteStore.js";
import {
  SudanBranchStore,
  branchActionSignature,
} from "../memory/sudanBranchStore.js";
import {
  captureSudanRoutesFromScene,
  detectSudanIdentityChange,
  enqueueMapEventProbes,
  formatSudanRouteBrief,
  insightFromState,
  pruneSudanRouteProbes,
  reliableSudanBreak,
  sudanCardFromState,
} from "../memory/sudanRouteTracker.js";
import { versionKeyFromState, choiceEventFromState } from "../memory/experienceAdapter.js";
import { ensureChoiceAltruismResolved } from "../moral/choiceAltruismClassify.js";
import type { OptionAltruismScore } from "../moral/choiceHeuristics.js";
import { readCachedAltruismScores } from "../moral/choiceHeuristics.js";
import { EntityEnrichmentWorker } from "./backgroundEntityEnrich.js";
import {
  createDayBoundary,
  forceReviewBeforeAllocation,
  isCardAssignmentPhase,
  markReviewed,
  shouldFlushTerminalReview,
  tickDayBoundary,
  type DayBoundaryState,
} from "../memory/dayBoundary.js";
import {
  emptyDayReviewCursor,
  runDailyReview,
  type DayReviewCursor,
} from "../memory/dayReview.js";
import { updateMemorySessionMeta } from "../memory/session.js";
import { RiteExploreStore } from "../memory/riteExploreStore.js";
import { buildTrialSummaryZh } from "../memory/riteExploreBrief.js";
import { BacktrackStore } from "../memory/backtrackStore.js";
import { buildPathSignature } from "../memory/riteComposition.js";
import { resetRunScopedState } from "../memory/newGameReset.js";
import { evaluateRiteExploreGate } from "../planner/riteExplorePolicy.js";
import {
  maxBacktrackDepth,
  planTerminalRecovery,
  recoveryPlanFromNode,
  type RecoveryPlan,
} from "../planner/recoveryPlanner.js";
import { formatStrategyBrief, runStrategyEngine } from "../planner/strategyEngine.js";
import {
  ActionChainController,
  formatActionChainBrief,
} from "./actionChain.js";
import {
  agentTools,
  formatTerminalRecoveryHint,
  isTerminalState,
  isVictoryTerminal,
  runTool,
  terminalRecoveryOps,
  truncateHudThinking,
} from "./tools.js";

export interface AgentLoopResult {
  finalText: string;
  stopReason: string;
  runDir: string;
  runId: string;
  decisionTraces: DecisionTrace[];
  reviewCursor?: DayReviewCursor;
  dailyReviewCount?: number;
}

type BackgroundCompressionTask = {
  snapshot: CompressionSnapshot;
  controller: AbortController;
  startedStep: number;
  startedAt: number;
  settled: boolean;
  compacted: ChatMessage[] | null;
  error: unknown;
  promise: Promise<void>;
};

class DecisionTraceWriter {
  private readonly traces: DecisionTrace[] = [];
  private readonly jsonlPath: string;

  constructor(runDir: string) {
    this.jsonlPath = path.join(runDir, "decision-traces.jsonl");
    fs.writeFileSync(this.jsonlPath, "", "utf8");
  }

  append(trace: DecisionTrace): void {
    this.traces.push(trace);
    fs.appendFileSync(this.jsonlPath, JSON.stringify(trace) + "\n", "utf8");
  }

  all(): DecisionTrace[] {
    return [...this.traces];
  }
}

function parseDecisionFromArgs(argsJson: string): {
  title?: string;
  goal?: string;
  why?: string;
} {
  try {
    const args = JSON.parse(argsJson || "{}") as { decision?: Record<string, unknown> };
    const d = args.decision;
    if (!d || typeof d !== "object") return {};
    return {
      title: typeof d.title === "string" ? d.title : undefined,
      goal: typeof d.goal === "string" ? d.goal : undefined,
      why: typeof d.why === "string" ? d.why : undefined,
    };
  } catch {
    return {};
  }
}

function inventoryLen(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * When the model calls get_state with summary/compact views, rites/cards arrays
 * are omitted. Keep the previous richer inventory so map_review / planner do not
 * suddenly see an empty map.
 */
function mergePreservingInventory(prev: GameState | null, next: GameState): GameState {
  if (!prev) return next;
  const merged: GameState = { ...next };
  if (inventoryLen(next.rites) === 0 && inventoryLen(prev.rites) > 0) {
    merged.rites = prev.rites;
  }
  if (inventoryLen(next.cards) === 0 && inventoryLen(prev.cards) > 0) {
    merged.cards = prev.cards;
  }
  const prevValues = prev.values && typeof prev.values === "object" ? prev.values : null;
  const nextValues = next.values && typeof next.values === "object" ? next.values : null;
  if (prevValues && nextValues) {
    const values = { ...nextValues };
    if (inventoryLen(nextValues.rites) === 0 && inventoryLen(prevValues.rites) > 0) {
      values.rites = prevValues.rites;
    }
    if (inventoryLen(nextValues.cards) === 0 && inventoryLen(prevValues.cards) > 0) {
      values.cards = prevValues.cards;
    }
    merged.values = values;
  } else if (!nextValues && prevValues) {
    merged.values = prevValues;
  }
  return merged;
}

function summarizeActions(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson || "{}") as { actions?: Array<{ op?: string }> };
    const ops = (args.actions ?? []).map((a) => a.op ?? "?").join(",");
    return ops || "none";
  } catch {
    return "parse_error";
  }
}

const ALLOCATION_OPS = new Set([
  "draw_sudan_card",
  "open_sudan_box",
  "exchange_sudan_card",
  "place_card_on_rite",
  "open_rite",
  "select_card",
]);

export async function runAgentLoop(opts: {
  client: OpenAI;
  ops: GameOps;
  cfg: AppConfig;
  userGoal: string;
  log: AgentLogger;
  memoryContext?: string;
  validateMode?: boolean;
  shouldStop?: () => boolean;
  /** Session directory for versioned experience persistence. */
  memoryDir?: string;
  gameFingerprint?: string | null;
  /** Autoplay game index for hypothesis sessionIndex. */
  gameIndex?: number;
  /** Resume cursor for daily review (from session meta). */
  reviewCursor?: DayReviewCursor | null;
  onReviewCursor?: (cursor: DayReviewCursor) => void;
}): Promise<AgentLoopResult> {
  const { client, ops, cfg, userGoal, log, memoryContext, validateMode, shouldStop } = opts;
  const failureLedger = new ActionFailureLedger();
  const traceWriter = new DecisionTraceWriter(log.runDir);
  const experienceStore = opts.memoryDir
    ? new ExperienceStore(opts.memoryDir)
    : null;
  const entityStores = opts.memoryDir
    ? createSultanEntityStores(opts.memoryDir, cfg.agentEntityMinSamples)
    : null;
  const episodeTracker = opts.memoryDir
    ? new EpisodeTracker(new EpisodeStore(opts.memoryDir), cfg.agentEpisodeTtlSteps)
    : null;
  const sudanRouteStore = opts.memoryDir ? new SudanRouteStore(opts.memoryDir) : null;
  const sudanBranchStore = opts.memoryDir ? new SudanBranchStore(opts.memoryDir) : null;
  const exploreStore = opts.memoryDir ? new RiteExploreStore(opts.memoryDir) : null;
  const backtrackStore = opts.memoryDir ? new BacktrackStore(opts.memoryDir) : null;
  if (exploreStore) exploreStore.beginRun(log.runId, opts.gameIndex);
  if (backtrackStore) backtrackStore.beginRun(log.runId);
  let activeRecovery: RecoveryPlan | null = null;
  let recentPathSignatures: string[] = [];
  const enrichmentQueue =
    opts.memoryDir && cfg.agentEntityEnrichEnabled
      ? new EnrichmentQueue(opts.memoryDir, cfg.agentEntityEnrichMaxQueue)
      : null;
  const enrichmentWorker =
    entityStores && enrichmentQueue
      ? new EntityEnrichmentWorker({
          client,
          model: cfg.openaiModel,
          stores: entityStores,
          queue: enrichmentQueue,
          log,
          enabled: cfg.agentEntityEnrichEnabled,
          concurrency: cfg.agentEntityEnrichConcurrency,
          timeoutMs: cfg.agentEntityEnrichTimeoutMs,
          maxAttempts: cfg.agentEntityEnrichMaxAttempts,
        })
      : null;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(cfg.agentSocialCapitalEnabled) },
  ];
  let lastStateKey = "unknown";
  let latestState: GameState | null = null;
  let latestScene: SceneSnapshot | null = null;
  let activePlan: DayPlan | null = null;
  let pendingPrediction: Prediction | null = null;
  let lastStrategyBrief = "";
  let lastActionChainBrief = "";
  let lastEntityBrief = "";
  let lastDayCloseBrief = "";
  let dayCloseLedger: DayCandidateLedger = emptyDayCandidateLedger();
  let latestExperiences: ExperienceRecord[] = [];
  let lastAltruismWarmupKey: string | null = null;

  const altruismLlmComplete = async (llmOpts: {
    messages: Array<{ role: "system" | "user"; content: string }>;
    signal?: AbortSignal;
  }) => {
    const { text } = await streamChatText({
      client,
      model: cfg.openaiModel,
      messages: llmOpts.messages,
      signal: llmOpts.signal,
    });
    return text;
  };

  const resolveChoiceAltruism = async (
    state: GameState | null | undefined,
    forceLlm = false,
  ): Promise<OptionAltruismScore[] | null> => {
    if (!cfg.agentSocialCapitalEnabled || !entityStores || !state) return null;
    const choice = choiceEventFromState(state);
    if (!choice?.options?.length) return null;
    const version = versionKeyFromState(state, opts.gameFingerprint);
    const resolved = await ensureChoiceAltruismResolved({
      stores: entityStores,
      eventKey: choice.eventKey,
      version,
      prompt: choice.prompt,
      options: choice.options,
      runId: log.runId,
      llmComplete: altruismLlmComplete,
      forceLlm,
    });
    if (resolved.source !== "cache" && resolved.source !== "none") {
      log.info("choice_altruism_resolved", {
        eventKey: choice.eventKey,
        source: resolved.source,
        scores: resolved.scores,
      });
    }
    return resolved.scores;
  };

  const warmupChoiceAltruism = async (state: GameState | null | undefined) => {
    if (!cfg.agentSocialCapitalEnabled || !entityStores || !state) return;
    const choice = choiceEventFromState(state);
    if (!choice?.options?.length) return;
    if (lastAltruismWarmupKey === choice.eventKey) return;
    const existing = readCachedAltruismScores(
      entityStores.events.get(
        choice.eventKey,
        versionKeyFromState(state, opts.gameFingerprint),
      )?.facts as Record<string, unknown> | undefined,
    );
    if (existing?.length) {
      lastAltruismWarmupKey = choice.eventKey;
      return;
    }
    lastAltruismWarmupKey = choice.eventKey;
    try {
      await resolveChoiceAltruism(state, false);
    } catch (err) {
      log.warn("choice_altruism_warmup_failed", {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const actionChain = new ActionChainController({
    memoryDir: opts.memoryDir,
    inspectionRequirement: (card, state) => {
      if (!entityStores) return null;
      const rawCardId = card.id ?? card.cardId;
      const cardId =
        typeof rawCardId === "number" && Number.isFinite(rawCardId)
          ? rawCardId
          : null;
      if (cardId == null) return "missing_knowledge";
      return cardInspectionRequirement({
        stores: entityStores,
        state,
        cardId,
        gameFingerprint: opts.gameFingerprint,
        cardHint: {
          name: typeof card.name === "string" ? card.name : null,
          type: typeof card.type === "string" ? card.type : null,
          rare: typeof card.rare === "number" ? card.rare : null,
        },
      });
    },
  });
  let dayBoundary: DayBoundaryState = createDayBoundary({
    intervalDays: cfg.agentReviewIntervalDays,
    lastReviewedDay: opts.reviewCursor?.lastReviewedDay ?? null,
  });
  let reviewCursor: DayReviewCursor = opts.reviewCursor
    ? { ...opts.reviewCursor }
    : emptyDayReviewCursor(opts.gameIndex ?? 1);
  if (opts.gameIndex != null) reviewCursor.gameIndex = opts.gameIndex;
  let dailyReviewCount = 0;
  let dayWindowStateBefore: GameState | null = null;
  let dayWindowTraceStart = 0;

  const enqueueEnrichment = (updates: ReturnType<typeof applyRiteSettlement>) => {
    if (!enrichmentWorker || !entityStores) return;
    for (const target of enrichmentTargetsFromUpdates(entityStores, updates)) {
      enrichmentWorker.enqueue(target);
    }
  };

  const applySettlements = (
    settlements: ReturnType<EpisodeTracker["observeState"]>,
  ) => {
    if (!episodeTracker || !entityStores) return;
    for (const settlement of settlements) {
      if (settlement.episode.applied) continue;
      // Rewound / quarantined / active-trial episodes must not update canonical entity memory.
      if (
        settlement.episode.quarantined ||
        settlement.episode.phase === "rewound" ||
        (settlement.episode.branchId &&
          sudanBranchStore?.get(settlement.episode.branchId)?.status === "rewound")
      ) {
        // Keep rewound/quarantined phase; only mark applied so we do not retry.
        episodeTracker.store.update(settlement.episode.id, {
          applied: true,
          quarantined: true,
          phase:
            settlement.episode.phase === "rewound" ? "rewound" : settlement.episode.phase,
        });
        log.info("episode_settlement_skipped_rewound", {
          episodeId: settlement.episode.id,
          branchId: settlement.episode.branchId ?? null,
        });
        continue;
      }
      const activeBranch = sudanBranchStore?.active();
      if (
        activeBranch &&
        settlement.episode.branchId &&
        settlement.episode.branchId === activeBranch.branchId
      ) {
        sudanBranchStore?.appendPendingEvidence(activeBranch.branchId, {
          episodeIds: [settlement.episode.id],
          notes: [`settlement_held:${settlement.outcome}`],
        });
        log.info("episode_settlement_held_for_branch", {
          episodeId: settlement.episode.id,
          branchId: activeBranch.branchId,
          outcome: settlement.outcome,
        });
        continue;
      }
      const updates = applyRiteSettlement({
        stores: entityStores,
        settlement,
        runId: log.runId,
      });
      episodeTracker.markApplied(settlement.episode.id);
      log.info("episode_settled", {
        episodeId: settlement.episode.id,
        eventKey: settlement.episode.eventKey,
        outcome: settlement.outcome,
        assignments: settlement.episode.composition.length,
        updates: updates.length,
      });
      enqueueEnrichment(updates);
    }
  };

  const syncSudanRouteLedger = (
    state: GameState | null | undefined,
    scene: SceneSnapshot | null | undefined,
  ) => {
    if (!sudanRouteStore || !state) return;
    const version = versionKeyFromState(state, opts.gameFingerprint);
    const configFingerprint = version.configFingerprint;
    const day =
      typeof state.values?.day === "number" ? state.values.day : null;
    const identity = detectSudanIdentityChange({
      store: sudanRouteStore,
      state,
      day,
      configFingerprint,
    });
    if (identity.changed) {
      log.info("sudan_identity_changed", {
        cardId: identity.cardId,
        identity: identity.identity,
      });
    }
    const mapChanges = actionChain.checkpoint.mapChanges ?? [];
    enqueueMapEventProbes({
      store: sudanRouteStore,
      mapChanges,
      configFingerprint,
    });
    const pruned = pruneSudanRouteProbes({
      store: sudanRouteStore,
      state,
    });
    if (pruned.removed.length > 0) {
      log.info("sudan_probes_pruned", {
        before: pruned.before,
        after: pruned.after,
        removed: pruned.removed.slice(0, 8),
      });
    }
    const routes = captureSudanRoutesFromScene({
      store: sudanRouteStore,
      state,
      scene,
      configFingerprint,
      day,
    });
    if (routes.length) {
      log.info("sudan_routes_captured", {
        count: routes.length,
        keys: routes.slice(0, 6).map((route) => route.key),
      });
    }
    actionChain.setSudanRouteProbePending(sudanRouteStore.pendingProbes().length);
  };

  const sudanRouteSummaryForSnapshot = (state: GameState | null | undefined) => {
    if (!sudanRouteStore) return undefined;
    const card = sudanCardFromState(state);
    const summary = sudanRouteStore.summarize({ sudanCardId: card.cardId });
    const totalEvents = Math.max(1, summary.total + summary.pendingProbes);
    return {
      coverage: summary.compatible / totalEvents,
      readyCount: summary.ready,
      needsSupportCount: summary.needsSupport,
      pendingProbes: summary.pendingProbes,
      verifiedBreakCount: summary.verifiedBreak,
      incompatibleCount: summary.incompatible,
      shortestPrepDays: summary.shortestPrepDays,
      bestRouteLabel: summary.bestReady
        ? `${summary.bestReady.eventName ?? summary.bestReady.eventKey}#${summary.bestReady.slotIndex}`
        : null,
      expiringOpportunity:
        summary.bestReady?.eventLife != null && summary.bestReady.eventLife <= 1,
      triedBranchCount: sudanBranchStore?.list().filter((b) => b.status !== "dominated").length ?? 0,
      insight: insightFromState(state),
      rewindAvailable: state?.actions?.some((a) => a.id === "prev_round" && a.enabled !== false),
    };
  };

  const exploreRecoveryForSnapshot = (state: GameState | null | undefined) => {
    const day =
      typeof state?.values?.day === "number"
        ? state.values.day
        : activeRecovery?.originDay ?? null;
    const failed = backtrackStore?.listFailedPaths(log.runId) ?? [];
    return {
      exploreRemainingByEvent: undefined,
      failedPathCount: failed.length,
      failedPathSignatures: failed.slice(0, 12),
      recoveryActive: activeRecovery?.nextAction === "prev_round",
      recoveryTargetDay: activeRecovery?.targetDay ?? null,
      recoveryDepth: activeRecovery?.depth ?? null,
      rewindRemaining:
        activeRecovery && day != null
          ? Math.max(0, day - activeRecovery.targetDay)
          : null,
      recoveryHint: activeRecovery?.hint ?? null,
    };
  };

  const recordDayAnchor = (state: GameState | null | undefined) => {
    if (!backtrackStore || !state) return;
    const day =
      typeof state.values?.day === "number" ? state.values.day : null;
    if (day == null) return;
    const snap = buildStrategySnapshot({
      state,
      gameFingerprint: opts.gameFingerprint,
      sudanRouteSummary: sudanRouteSummaryForSnapshot(state),
    });
    backtrackStore.recordAnchor({
      runId: log.runId,
      day,
      sudanIdentity: snap.sudanCard?.identity ?? null,
      resources: snap.resources,
      readyRoutes: snap.sudanRoutes?.bestRouteLabel
        ? [snap.sudanRoutes.bestRouteLabel]
        : [],
      executedPathSignatures: recentPathSignatures.slice(-8),
    });
  };

  const runHostRecoveryRewind = async (
    startState: GameState,
  ): Promise<{
    state: GameState;
    scene: SceneSnapshot | null;
    plan: RecoveryPlan | null;
    stoppedReason?: string;
  }> => {
    if (!backtrackStore) {
      return { state: startState, scene: latestScene, plan: null, stoppedReason: "no_store" };
    }
    const snap = buildStrategySnapshot({
      state: startState,
      gameFingerprint: opts.gameFingerprint,
      sudanRouteSummary: sudanRouteSummaryForSnapshot(startState),
    });
    const prevEnabled = Boolean(
      startState.actions?.some((a) => a.id === "prev_round" && a.enabled !== false),
    );
    let plan = planTerminalRecovery({
      store: backtrackStore,
      runId: log.runId,
      state: startState,
      snapshot: snap,
      recentPathSignatures,
      terminalReason: String(
        (startState.values as { questSummary?: { overReason?: unknown } } | undefined)
          ?.questSummary?.overReason ?? "terminal_failure",
      ),
      prevRoundEnabled: prevEnabled,
    });
    activeRecovery = plan;
    actionChain.setRecoveryPlan({
      targetDay: plan.targetDay,
      depth: plan.depth,
      failedPathSignatures: plan.failedPathSignatures,
      hint: plan.hint,
    });
    log.info("recovery_plan_created", {
      failureId: plan.failureId,
      targetDay: plan.targetDay,
      depth: plan.depth,
      nextAction: plan.nextAction,
    });

    let state = startState;
    let scene = latestScene;
    let steps = 0;
    const maxSteps = Math.max(1, plan.depth + 2);

    while (plan.nextAction === "prev_round" && steps < maxSteps) {
      steps += 1;
      // Clear blocking overlays with continue before rewind.
      for (let i = 0; i < 4; i++) {
        const phase = String(state.screen?.phase ?? "").toLowerCase();
        const canContinue = state.actions?.some(
          (a) => a.id === "continue" && a.enabled !== false,
        );
        if (!canContinue || phase === "play" || phase === "rite" || !state.terminal) break;
        const cont = await ops.submitActions([{ op: "continue" }]);
        if (!cont[0] || cont[0].ok === false) break;
        state = await ops.getState(["values", "actions", "cards", "rites", "events"]);
        scene = await ops.observeScene();
      }

      const dayBefore =
        typeof state.values?.day === "number" ? state.values.day : null;
      const canPrev = state.actions?.some(
        (a) => a.id === "prev_round" && a.enabled !== false,
      );
      if (!canPrev) {
        plan = { ...plan, nextAction: "start_new_game", hint: "prev_round unavailable" };
        break;
      }
      const results = await ops.submitActions([{ op: "prev_round" }]);
      actionChain.noteAction({ op: "prev_round" }, state, scene);
      state = await ops.getState(["values", "actions", "cards", "rites", "events"]);
      scene = await ops.observeScene();
      const dayAfter =
        typeof state.values?.day === "number" ? state.values.day : null;
      const ok = results[0]?.ok !== false;
      if (!ok || dayBefore == null || dayAfter == null || !(dayAfter < dayBefore)) {
        log.warn("recovery_rewind_no_effect", {
          dayBefore,
          dayAfter,
          ok,
          error: results[0]?.error ?? null,
        });
        plan = {
          ...plan,
          nextAction: "start_new_game",
          hint: "prev_round no day decrease",
        };
        break;
      }
      log.info("recovery_rewind_step", { dayBefore, dayAfter, targetDay: plan.targetDay });
      // Quarantine branch learning on rewind.
      const active = sudanBranchStore?.active();
      if (active) {
        sudanBranchStore?.markRewound(active.branchId, null, { breakResult: "unknown" });
        episodeTracker?.store.quarantineBranch(active.branchId);
      }
      plan = recoveryPlanFromNode(
        backtrackStore.activeFailure(log.runId) ?? {
          id: plan.failureId,
          failureSignature: plan.failureSignature,
          failedPathSignatures: plan.failedPathSignatures,
          originDay: plan.originDay,
          targetDay: plan.targetDay,
          depth: plan.depth,
          triedSiblingSignatures: plan.triedSiblingSignatures,
          status: "open",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          currentDay: dayAfter,
          prevRoundEnabled: Boolean(
            state.actions?.some((a) => a.id === "prev_round" && a.enabled !== false),
          ),
          maxDepth: maxBacktrackDepth(
            buildStrategySnapshot({
              state,
              gameFingerprint: opts.gameFingerprint,
            }),
          ),
        },
      );
      activeRecovery = plan;
      actionChain.setRecoveryPlan({
        targetDay: plan.targetDay,
        depth: plan.depth,
        failedPathSignatures: plan.failedPathSignatures,
        hint: plan.hint,
      });
      actionChain.observe(state, scene);
    }

    if (plan.nextAction === "try_sibling") {
      actionChain.clearRecoveryPlan();
      activeRecovery = plan;
      messages.push({
        role: "user",
        content: [
          `## Recovery 到达目标日 ${plan.targetDay}`,
          plan.hint,
          `failedPaths: ${plan.failedPathSignatures.slice(0, 8).join(" | ") || "none"}`,
          "禁止重走 failed path；优先未试 sibling 路线。",
        ].join("\n"),
      });
    } else if (plan.nextAction === "start_new_game") {
      activeRecovery = plan;
    } else {
      activeRecovery = null;
      actionChain.clearRecoveryPlan();
    }

    return {
      state,
      scene,
      plan,
      stoppedReason: plan.nextAction === "prev_round" ? "depth_or_steps" : undefined,
    };
  };

  const persistCursor = (cursor: DayReviewCursor) => {
    reviewCursor = cursor;
    opts.onReviewCursor?.(cursor);
    if (opts.memoryDir) {
      try {
        updateMemorySessionMeta(opts.memoryDir, {
          lastReviewedDay: cursor.lastReviewedDay,
          activeHypothesisId: cursor.activeHypothesisId,
        });
      } catch {
        // optional persistence
      }
    }
  };

  const performDailyReview = async (reviewedDayWindow: number, reason: string) => {
    if (!opts.memoryDir) return;
    const stateSnapshot = latestState;
    const traces = traceWriter.all().slice(dayWindowTraceStart);
    log.info("daily_review_start", {
      dayWindow: reviewedDayWindow,
      reason,
      traces: traces.length,
    });
    if (enrichmentWorker) {
      const enrichStats = enrichmentWorker.harvest();
      log.info("entity_enrich_queue_stats", {
        ...enrichStats,
        dayWindow: reviewedDayWindow,
        reason,
      });
    }
    const result = runDailyReview({
      sessionDir: opts.memoryDir,
      runId: log.runId,
      dayWindow: reviewedDayWindow,
      state: stateSnapshot ?? {},
      stateBefore: dayWindowStateBefore ?? undefined,
      traces,
      cursor: reviewCursor,
      budgetChars: cfg.agentHypothesisBudgetChars,
      stopReason: reason,
    });
    persistCursor(result.cursor);
    dayBoundary = markReviewed(dayBoundary, reviewedDayWindow);
    dailyReviewCount += 1;
    dayWindowTraceStart = traceWriter.all().length;
    dayWindowStateBefore = stateSnapshot;
    messages.push({
      role: "user",
      content: [
        `## 每日复盘完成（dayWindow=${reviewedDayWindow}）`,
        "宿主已同步复盘并注入本局记忆。请重新观察场景后继续下一天的卡片分配；不要跳过反馈结算。",
        result.memoryInjection,
      ].join("\n"),
    });
    activePlan = null;
    lastStrategyBrief = "";
    lastEntityBrief = "";
    if (experienceStore && latestState && latestScene) {
      try {
        const engine = runStrategyEngine({
          state: latestState,
          scene: latestScene,
          store: experienceStore,
          entityStores,
          gameFingerprint: opts.gameFingerprint,
          exchangeCircuitOpen: failureLedger.isExchangeCircuitOpen(
            exchangeContextKeyFromGameState(latestState),
          ),
            exploreStore,
            backtrackStore,
            runId: log.runId,
            exploreRecovery: exploreRecoveryForSnapshot(latestState),
        });
        activePlan =
          engine.candidates.find((p) => p.id === engine.recommendedPlanId) ??
          engine.candidates[0] ??
          null;
        lastStrategyBrief = formatStrategyBrief(engine, 5, entityStores);
        messages.push({ role: "user", content: lastStrategyBrief });
      } catch (err) {
        log.warn("post_review_strategy_failed", {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info("daily_review_done", {
      dayWindow: reviewedDayWindow,
      hypothesisId: result.createdHypothesisId ?? null,
      evaluated: result.evaluatedHypothesisId ?? null,
      decision: result.evaluationDecision ?? null,
    });
  };

  if (memoryContext?.trim()) {
    messages.push({ role: "user", content: memoryContext.trim() });
  }

  let goal = userGoal;
  if (validateMode) goal = `${VALIDATE_MODE_HINT}\n\n${userGoal}`;
  else if (!memoryContext?.includes("验证模式")) goal = `${EXPLORE_MODE_HINT}\n\n${userGoal}`;
  messages.push({ role: "user", content: goal });

  try {
    const [initialState, initialScene] = await Promise.all([
      // Include rites so action-chain map inventory is not empty on first observe
      // (summary alone strips values.rites; scene telemetry is a fallback).
      ops.getState(["summary", "actions", "rites"]),
      ops.observeScene(),
    ]);
    latestState = initialState;
    latestScene = initialScene;
    if (entityStores) {
      touchEntitiesFromState({
        stores: entityStores,
        state: initialState,
        gameFingerprint: opts.gameFingerprint,
        runId: log.runId,
      });
    }
    if (episodeTracker) {
      applySettlements(episodeTracker.unappliedSettlements());
      applySettlements(episodeTracker.observeState(initialState, { step: 0 }));
    }
    lastStateKey = stateKeyFromGameState(initialState);
    actionChain.observe(initialState, initialScene);
    syncSudanRouteLedger(initialState, initialScene);
    recordDayAnchor(initialState);
    const startupChain = formatActionChainBrief(actionChain.observe(initialState, initialScene));
    lastActionChainBrief = startupChain;
    messages.push({
      role: "user",
      content: [
        "## 启动时实时场景（宿主自动注入）",
        "先依据 scene/instruction/elements/affordances 判断当前界面；不要按固定步骤猜测。",
        "同时遵循行动链阶段顺序，但引导/阻塞层可随时打断。",
        JSON.stringify({ state: initialState, scene: initialScene }),
        startupChain,
        sudanRouteStore ? formatSudanRouteBrief(sudanRouteStore) : "",
      ].filter(Boolean).join("\n"),
    });
    if (experienceStore) {
      try {
        const engine = runStrategyEngine({
          state: latestState,
          scene: latestScene,
          store: experienceStore,
          entityStores,
          gameFingerprint: opts.gameFingerprint,
          sudanRouteSummary: sudanRouteSummaryForSnapshot(latestState),
          exchangeCircuitOpen: failureLedger.isExchangeCircuitOpen(
            exchangeContextKeyFromGameState(latestState),
          ),
            exploreStore,
            backtrackStore,
            runId: log.runId,
            exploreRecovery: exploreRecoveryForSnapshot(latestState),
        });
        activePlan =
          engine.candidates.find((p) => p.id === engine.recommendedPlanId) ??
          engine.candidates[0] ??
          null;
        await warmupChoiceAltruism(latestState);
        lastStrategyBrief = formatStrategyBrief(engine, 5, entityStores);
        messages.push({ role: "user", content: lastStrategyBrief });
        log.info("strategy_engine", {
          plans: engine.candidates.length,
          recommendedPlanId: engine.recommendedPlanId,
          experiences: engine.builtFrom.experienceCount,
        });
      } catch (err) {
        log.warn("strategy_engine_failed", {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info("startup_state_injected", {
      stateKey: lastStateKey,
      screenId: initialState.screen?.id ?? "unknown",
      sceneVersion: initialScene.snapshotVersion,
      terminal: initialState.terminal,
    });
  } catch (err) {
    log.warn("startup_state_injection_failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  let finalText = "";
  let stopReason = "completed";
  let lastPromptTokens = 0;
  let compressionGeneration = 0;
  let backgroundCompression: BackgroundCompressionTask | null = null;
  let averageTurnGrowth = 0;

  log.info("loop_start", { maxSteps: cfg.agentMaxSteps, model: cfg.openaiModel });

  try {
    for (let i = 0; cfg.agentMaxSteps === 0 || i < cfg.agentMaxSteps; i++) {
      if (shouldStop?.()) {
        finalText = finalText || "（已停止：收到退出信号）";
        stopReason = "stopped";
        break;
      }

      const step = log.nextStep();
      const compressionFacts = () => failureLedger.toPromptFacts(lastStateKey);
      if (enrichmentWorker) enrichmentWorker.harvest();
      if (episodeTracker) {
        applySettlements(episodeTracker.unappliedSettlements());
      }

      if (backgroundCompression?.settled) {
        const task = backgroundCompression;
        const merged = task.compacted
          ? mergeCompressedSnapshot({
              current: messages,
              snapshot: task.snapshot,
              compacted: task.compacted,
              generation: compressionGeneration,
            })
          : null;
        if (merged) {
          messages.length = 0;
          messages.push(...merged);
          compressionGeneration += 1;
          lastPromptTokens = 0;
        }
        backgroundCompression = null;
      }

      const hardLimitReached = shouldCompressContext(
        lastPromptTokens,
        messages,
        cfg.agentCompressTriggerTokens,
      );
      if (hardLimitReached) {
        if (backgroundCompression) {
          backgroundCompression.controller.abort();
          backgroundCompression = null;
        }
        const compacted = compressMessagesDeterministic({
          cfg,
          messages,
          log,
          step,
          deterministicFacts: compressionFacts(),
          reason: "hard token limit",
        });
        if (compacted !== messages) {
          messages.length = 0;
          messages.push(...compacted);
          compressionGeneration += 1;
        }
        lastPromptTokens = 0;
      }

      const currentEstimate = estimateTokens(messages);
      if (
        !backgroundCompression &&
        !hardLimitReached &&
        shouldStartBackgroundCompression({
          currentTokens: currentEstimate,
          triggerTokens: cfg.agentCompressTriggerTokens,
          averageTurnGrowth,
          lookaheadTurns: cfg.agentCompressLookaheadTurns,
          softRatio: cfg.agentCompressSoftRatio,
        })
      ) {
        const snapshot: CompressionSnapshot = {
          generation: compressionGeneration,
          messages: messages.slice(),
        };
        const controller = new AbortController();
        const task: BackgroundCompressionTask = {
          snapshot,
          controller,
          startedStep: step,
          startedAt: Date.now(),
          settled: false,
          compacted: null,
          error: null,
          promise: Promise.resolve(),
        };
        task.promise = compressMessages({
          client,
          cfg,
          messages: snapshot.messages,
          log,
          step,
          deterministicFacts: compressionFacts(),
          signal: controller.signal,
        })
          .then((compacted) => {
            task.compacted = compacted;
            task.settled = true;
          })
          .catch((err) => {
            task.error = err;
            task.settled = true;
          });
        backgroundCompression = task;
      }

      // Refresh action-chain brief every turn from latest state/scene.
      if (latestState && latestScene) {
        actionChain.observe(latestState, latestScene);
        syncSudanRouteLedger(latestState, latestScene);
        const chainBrief = formatActionChainBrief(actionChain.observe(latestState, latestScene));
        if (chainBrief !== lastActionChainBrief) {
          lastActionChainBrief = chainBrief;
          messages.push({ role: "user", content: chainBrief });
          if (sudanRouteStore) {
            messages.push({
              role: "user",
              content: formatSudanRouteBrief(sudanRouteStore),
            });
          }
        }
      }

      // Strategy candidates only dominate after map review / during allocation.
      const chainPhase = actionChain.checkpoint.phase;
      const entityMemoryPhase =
        chainPhase === "hand_review" ||
        chainPhase === "map_review" ||
        chainPhase === "synthesis" ||
        chainPhase === "allocation" ||
        chainPhase === "local_improve";
      if (entityStores && latestState && entityMemoryPhase) {
        const relevant = retrieveRelevantEntityKnowledge({
          stores: entityStores,
          state: latestState,
          gameFingerprint: opts.gameFingerprint,
          maxCards: cfg.agentEntityMaxCards,
          maxEvents: cfg.agentEntityMaxEvents,
          maxInteractions: cfg.agentEntityMaxInteractions,
        });
        const entityBrief = buildEntityMemoryInjection(
          relevant,
          cfg.agentEntityMemoryBudgetChars,
        );
        if (entityBrief !== lastEntityBrief) {
          lastEntityBrief = entityBrief;
          messages.push({ role: "user", content: entityBrief });
        }
      }

      const captureLedgerPhase =
        chainPhase === "map_review" ||
        chainPhase === "synthesis" ||
        chainPhase === "allocation" ||
        chainPhase === "local_improve" ||
        chainPhase === "end_day_gate";
      if (latestState && latestScene && captureLedgerPhase) {
        try {
          const snap = buildStrategySnapshot({
            state: latestState,
            scene: latestScene,
            gameFingerprint: opts.gameFingerprint,
            sudanRouteSummary: sudanRouteSummaryForSnapshot(latestState),
            exchangeCircuitOpen: failureLedger.isExchangeCircuitOpen(
              exchangeContextKeyFromGameState(latestState),
            ),
          });
          const liveConfigs = generateEventConfigurations({
            snapshot: snap,
            state: latestState,
            scene: latestScene,
          });
          const liveCardUids = new Set(
            (Array.isArray(latestState.values?.cards)
              ? (latestState.values!.cards as Array<{ uid?: number }>)
              : []
            )
              .map((c) => c.uid)
              .filter((u): u is number => typeof u === "number"),
          );
          const liveRiteUids = new Set(
            (Array.isArray(latestState.values?.rites)
              ? (latestState.values!.rites as Array<{ uid?: number }>)
              : []
            )
              .map((r) => r.uid)
              .filter((u): u is number => typeof u === "number"),
          );
          dayCloseLedger = ingestConfigurationsIntoLedger(dayCloseLedger, liveConfigs, {
            day: snap.day ?? null,
            liveCardUids,
            liveRiteUids,
          });
        } catch {
          // Ledger is best-effort.
        }
      }

      const strategyPhase =
        chainPhase === "map_review" ||
        chainPhase === "synthesis" ||
        chainPhase === "allocation" ||
        chainPhase === "local_improve" ||
        chainPhase === "end_day_gate";
      if (experienceStore && latestState && latestScene && strategyPhase) {
        try {
          const engine = runStrategyEngine({
            state: latestState,
            scene: latestScene,
            store: experienceStore,
            entityStores,
            gameFingerprint: opts.gameFingerprint,
            sudanRouteSummary: sudanRouteSummaryForSnapshot(latestState),
            exchangeCircuitOpen: failureLedger.isExchangeCircuitOpen(
              exchangeContextKeyFromGameState(latestState),
            ),
            exploreStore,
            backtrackStore,
            runId: log.runId,
            exploreRecovery: exploreRecoveryForSnapshot(latestState),
          });
          activePlan =
            engine.candidates.find((p) => p.id === engine.recommendedPlanId) ??
            engine.candidates[0] ??
            null;
          if (engine.configurations?.length) {
            dayCloseLedger = ingestConfigurationsIntoLedger(
              dayCloseLedger,
              engine.configurations,
              { day: engine.snapshot.day ?? null },
            );
          }
          if (engine.experiences) {
            latestExperiences = engine.experiences as typeof latestExperiences;
          }
          await warmupChoiceAltruism(latestState);
          const brief = formatStrategyBrief(engine, 5, entityStores);
          if (brief !== lastStrategyBrief) {
            lastStrategyBrief = brief;
            messages.push({ role: "user", content: brief });
          }
        } catch {
          // Keep playing even if planner fails.
        }
      } else {
        activePlan = null;
      }

      // Day-close review brief before next_day (soft guidance; hard gate is in tools).
      if (
        latestState &&
        latestScene &&
        (chainPhase === "end_day_gate" || chainPhase === "local_improve")
      ) {
        try {
          const snap = buildStrategySnapshot({
            state: latestState,
            scene: latestScene,
            gameFingerprint: opts.gameFingerprint,
            sudanRouteSummary: sudanRouteSummaryForSnapshot(latestState),
            exchangeCircuitOpen: failureLedger.isExchangeCircuitOpen(
              exchangeContextKeyFromGameState(latestState),
            ),
          });
          const review = reviewDayCloseAllocations({
            snapshot: snap,
            state: latestState,
            scene: latestScene,
            allocations: actionChain.checkpoint.allocations,
            idleCards: actionChain.checkpoint.idleCards,
            ledger: dayCloseLedger,
            experiences: latestExperiences,
            sudanBreakDone: actionChain.checkpoint.sudanBreakDone,
          });
          const reviewBrief = formatDayCloseReviewBrief(review);
          if (reviewBrief !== lastDayCloseBrief) {
            lastDayCloseBrief = reviewBrief;
            messages.push({ role: "user", content: reviewBrief });
          }
        } catch {
          // Keep playing if review fails.
        }
      }

      const estimatePromptTokens = estimateTokens(messages);
      const t0 = Date.now();
      let timed: Awaited<ReturnType<typeof createTimedChatCompletion>>;
      try {
        timed = await createTimedChatCompletion({
          client,
          model: cfg.openaiModel,
          messages,
          tools: agentTools,
          toolChoice: "auto",
          estimatePromptTokens,
          maxStreamRetries: cfg.llmMaxRetries,
          retryIntervalSec: cfg.llmRetryIntervalSec,
        });
      } catch (err) {
        log.error("llm_error", {
          step,
          ms: Date.now() - t0,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      const message = timed.message;
      const reasoning = (message as { reasoning_content?: string }).reasoning_content;
      lastPromptTokens = timed.usage?.prompt_tokens ?? estimatePromptTokens;

      await ops
        .publishLlmStats({
          step,
          totalTokens: timed.usage?.total_tokens ?? timed.speed.prefillTokens + timed.speed.decodeTokens,
          prefillTokens: timed.speed.prefillTokens,
          decodeTokens: timed.speed.decodeTokens,
          prefillTokPerSec: timed.speed.prefillTokPerSec,
          decodeTokPerSec: timed.speed.decodeTokPerSec,
          elapsedMs: timed.ms,
          firstTokenMs: timed.speed.firstTokenMs,
        })
        .catch(() => undefined);

      if (reasoning) log.writeText(`step-${String(step).padStart(2, "0")}-reasoning.txt`, reasoning);
      const hudThinking = reasoning ? truncateHudThinking(reasoning, 100) : "";

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: message.content ?? null,
      };
      if (message.tool_calls) assistantMsg.tool_calls = message.tool_calls;
      if (reasoning) assistantMsg.reasoning_content = reasoning;
      messages.push(assistantMsg);

      const toolCalls = message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        if (hudThinking) {
          void ops
            .publishDecision({
              step,
              title: "思考",
              thinking: hudThinking,
            })
            .catch(() => undefined);
        }
        finalText = typeof message.content === "string" ? message.content : "";
        stopReason = "final_message";
        break;
      }

      let decisionPublished = false;
      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        const name = call.function.name;
        const args = call.function.arguments ?? "{}";
        log.info("tool_call", { step, name, args: log.toolArgs(args) });

        let result: unknown;
        const submittedActions =
          name === "submit_actions" ? extractSubmittedActions(args) : [];
        const clickLooksLikeAllocation =
          name === "click_element" &&
          isCardAssignmentPhase(latestState, latestScene);
        if (
          opts.memoryDir &&
          (submittedActions.some((a) => ALLOCATION_OPS.has(String(a.op ?? ""))) ||
            clickLooksLikeAllocation)
        ) {
          const forced = forceReviewBeforeAllocation(
            dayBoundary,
            latestState,
            latestScene,
          );
          dayBoundary = forced.boundary;
          if (forced.shouldReview && forced.reviewedDayWindow != null) {
            await performDailyReview(forced.reviewedDayWindow, forced.reason);
          }
        }
        if (experienceStore && submittedActions.length > 0) {
          const action = submittedActions[0] as GameAction;
          pendingPrediction = buildPrediction({
            action,
            state: latestState,
            planId: activePlan?.id,
            stepIndex: 0,
            gameFingerprint: opts.gameFingerprint,
            uncertain: activePlan?.unknowns,
          });
        }
        try {
          result = await runTool(ops, name, args, {
            step,
            latestState,
            latestScene,
            activePlan,
            actionChain,
            dayCloseLedger,
            experiences: latestExperiences,
            gameFingerprint: opts.gameFingerprint,
            exchangeCircuitOpen: failureLedger.isExchangeCircuitOpen(
              exchangeContextKeyFromGameState(latestState),
            ),
            verifiedBreakCount: sudanRouteSummaryForSnapshot(latestState)?.verifiedBreakCount ?? 0,
            executionDaysLeft: (() => {
              const snap = buildStrategySnapshot({
                state: latestState,
                scene: latestScene,
                gameFingerprint: opts.gameFingerprint,
                sudanRouteSummary: sudanRouteSummaryForSnapshot(latestState),
              });
              return snap.executionDaysLeft ?? null;
            })(),
            thinking: hudThinking || undefined,
            entityStores,
            exploreStore,
            backtrackStore,
            runId: log.runId,
            recoveryPlan: activeRecovery,
          });
        } catch (err) {
          result = {
            error: "tool_exception",
            detail: err instanceof Error ? err.message : String(err),
          };
        }

        log.info("tool_result", { step, name, result: log.toolResult(result) });

        const decision = parseDecisionFromArgs(args);
        if (decision.title) decisionPublished = true;
        traceWriter.append({
          decisionKey: `${name}:${summarizeActions(args)}`,
          action: name,
          rationale: [decision.title, decision.goal, decision.why].filter(Boolean).join(" | "),
          observationIds: [`step-${step}`, `state-${lastStateKey}`],
        });

        if (name === "report_action_chain" && latestState && latestScene) {
          const chainBrief = formatActionChainBrief(actionChain.observe(latestState, latestScene));
          if (chainBrief !== lastActionChainBrief) {
            lastActionChainBrief = chainBrief;
            messages.push({ role: "user", content: chainBrief });
          }
        }

        if (
          (name === "submit_actions" || name === "click_element") &&
          result &&
          typeof result === "object" &&
          "results" in (result as object)
        ) {
          const results = (result as { results: Array<Record<string, unknown>> }).results;
          failureLedger.noteFailures(
            step,
            lastStateKey,
            results,
            extractSubmittedActions(args),
            exchangeContextKeyFromGameState(latestState),
          );
          const stateBefore = latestState;

          // After every submit, refresh summary state so the next turn sees real UIDs/phase.
          try {
            const [refreshed, refreshedScene] = await Promise.all([
              ops.getState([
                "values",
                "cards",
                "rites",
                "events",
                "actions",
              ]),
              ops.observeScene(),
            ]);
            latestState = refreshed;
            latestScene = refreshedScene;
            lastStateKey = stateKeyFromGameState(refreshed);
            const typedResults =
              results as unknown as import("../game/types.js").ActionResult[];
            submittedActions.forEach((submittedAction, index) => {
              const reliable = reliableCardInspection({
                action: submittedAction as GameAction,
                result: typedResults[index] ?? typedResults[0],
                stateBefore,
                sceneAfter: refreshedScene,
              });
              if (reliable?.uid != null) {
                actionChain.confirmCardInspection(reliable.uid);
                log.info("card_inspection_verified", {
                  uid: reliable.uid,
                  cardId: reliable.cardId,
                });
              }
            });
            const sudanBreakVerified = submittedActions.some((submittedAction, index) =>
              reliableSudanBreak({
                action: submittedAction as GameAction,
                result: typedResults[index] ?? typedResults[0],
                stateBefore,
                stateAfter: refreshed,
              }),
            );
            actionChain.observe(refreshed, refreshedScene);
            syncSudanRouteLedger(refreshed, refreshedScene);
            recordDayAnchor(refreshed);
            if (sudanBreakVerified) {
              actionChain.setSudanBreakVerified(true);
              log.info("sudan_break_verified", {
                action: submittedActions.find((_, index) =>
                  reliableSudanBreak({
                    action: submittedActions[index] as GameAction,
                    result: typedResults[index] ?? typedResults[0],
                    stateBefore,
                    stateAfter: refreshed,
                  }),
                )?.op,
              });
            }
            syncSudanRouteLedger(refreshed, refreshedScene);

            const submittedOps = submittedActions.map((a) => String(a.op ?? ""));
            const trialOps = submittedOps.filter((op) =>
              [
                "exchange_sudan_card",
                "open_sudan_box",
                "place_card_on_rite",
                "execute",
                "start_rite",
              ].includes(op),
            );
            const dayBefore =
              typeof stateBefore?.values?.day === "number" ? stateBefore.values.day : null;
            const dayAfter =
              typeof refreshed.values?.day === "number" ? refreshed.values.day : null;
            const insightBefore = insightFromState(stateBefore);
            const insightAfter = insightFromState(refreshed);
            const cardBefore = sudanCardFromState(stateBefore);
            const cardAfter = sudanCardFromState(refreshed);

            if (sudanBranchStore && trialOps.length > 0 && !sudanBranchStore.active()) {
              const left =
                typeof refreshed.values?.sudan === "object" &&
                refreshed.values.sudan &&
                typeof (refreshed.values.sudan as { executionDaysLeft?: number })
                  .executionDaysLeft === "number"
                  ? (refreshed.values.sudan as { executionDaysLeft: number }).executionDaysLeft
                  : null;
              if (left != null && left <= 2) {
                const anchorSignature = [
                  `day:${dayBefore ?? "?"}`,
                  `sudan:${cardBefore.identity}`,
                  `map:${(actionChain.checkpoint.mapChanges ?? []).slice(0, 6).join(",")}`,
                ].join("|");
                const actionSignature = branchActionSignature(trialOps);
                const started = sudanBranchStore.startTrial({
                  anchorDay: dayBefore,
                  anchorSignature,
                  actionSignature,
                  actions: trialOps,
                  sudanCardId: cardBefore.cardId,
                  sudanIdentity: cardBefore.identity,
                  mapSignature: anchorSignature,
                  baseline: {
                    insight: insightBefore,
                    redrawTimes:
                      typeof (stateBefore?.values?.sudan as { redrawTimes?: number } | undefined)
                        ?.redrawTimes === "number"
                        ? (stateBefore!.values!.sudan as { redrawTimes: number }).redrawTimes
                        : null,
                    redrawRemaining:
                      typeof (stateBefore?.values?.sudan as { redrawRemaining?: number } | undefined)
                        ?.redrawRemaining === "number"
                        ? (stateBefore!.values!.sudan as { redrawRemaining: number }).redrawRemaining
                        : null,
                  },
                });
                if (started) {
                  log.info("sudan_branch_started", {
                    branchId: started.branchId,
                    actionSignature,
                    left,
                  });
                }
              }
            }

            if (
              submittedOps.includes("start_new_game") &&
              typedResults.some((r) => r?.ok !== false && String(r?.op ?? "") === "start_new_game")
            ) {
              if (opts.memoryDir) {
                const reset = resetRunScopedState({
                  sessionDir: opts.memoryDir,
                  runId: log.runId,
                  gameIndex: opts.gameIndex,
                });
                if (!reset.ok) {
                  log.warn("new_game_reset_failed", { error: reset.error ?? null });
                  stopReason = "new_game_reset_failed";
                  finalText = `（新局重置失败）${reset.error ?? "unknown"}；已停止进入 Agent loop。`;
                } else {
                  actionChain.resetForNewGame();
                  activeRecovery = null;
                  recentPathSignatures = [];
                  activePlan = null;
                  dayBoundary = createDayBoundary({
                    intervalDays: cfg.agentReviewIntervalDays,
                    lastReviewedDay: null,
                  });
                  reviewCursor = emptyDayReviewCursor(opts.gameIndex ?? 1);
                  persistCursor(reviewCursor);
                  exploreStore?.beginRun(log.runId, opts.gameIndex);
                  backtrackStore?.beginRun(log.runId);
                  log.info("new_game_reset", reset as unknown as Record<string, unknown>);
                }
              }
            }

            if (
              sudanBranchStore &&
              submittedOps.includes("prev_round") &&
              typedResults.some((r) => r?.ok !== false && String(r?.op ?? "") === "prev_round")
            ) {
              const active = sudanBranchStore.active();
              const insightDelta =
                insightBefore != null && insightAfter != null
                  ? insightAfter - insightBefore
                  : insightAfter != null && insightBefore == null
                    ? 1
                    : null;
              if (active) {
                const verifiedBefore =
                  sudanRouteStore?.summarize({ sudanCardId: cardBefore.cardId }).verifiedBreak ?? 0;
                const tierUp =
                  cardBefore.rare != null &&
                  cardAfter.rare != null &&
                  cardAfter.rare > cardBefore.rare;
                const breakResult =
                  verifiedBefore > 0 && !sudanBreakVerified ? "fail" : "unknown";
                const rewindNotes = [
                  `rewind_rare:${cardBefore.rare ?? "?"}->${cardAfter.rare ?? "?"}`,
                  verifiedBefore > 0 ? "rewind_with_verified_break_path" : "",
                  tierUp ? "tier_regression_on_branch" : "",
                ].filter(Boolean);
                if (rewindNotes.length) {
                  sudanBranchStore.appendPendingEvidence(active.branchId, {
                    notes: rewindNotes,
                  });
                }
                sudanBranchStore.markRewound(active.branchId, insightDelta, {
                  breakResult,
                });
                if (tierUp) {
                  sudanBranchStore.markDominated(active.branchId);
                  for (const branch of sudanBranchStore.list()) {
                    if (
                      branch.anchorSignature === active.anchorSignature &&
                      branch.branchId !== active.branchId &&
                      branch.status !== "committed" &&
                      branch.pendingEvidence.notes.some((n) =>
                        n.includes("tier_regression_on_branch"),
                      )
                    ) {
                      sudanBranchStore.markDominated(branch.branchId);
                    }
                  }
                }
                episodeTracker?.store.quarantineBranch(active.branchId);
                log.info("sudan_branch_rewound", {
                  branchId: active.branchId,
                  insightDelta,
                  breakResult,
                  dayBefore,
                  dayAfter,
                  rareBefore: cardBefore.rare,
                  rareAfter: cardAfter.rare,
                });
              } else if (insightDelta != null) {
                log.info("prev_round_insight_delta", { insightDelta, dayBefore, dayAfter });
              }
              activePlan = null;
            }

            if (
              sudanBranchStore?.active() &&
              (submittedOps.includes("execute") || submittedOps.includes("start_rite")) &&
              sudanBreakVerified
            ) {
              const active = sudanBranchStore.active()!;
              sudanBranchStore.commit(active.branchId, { breakResult: "success" });
              log.info("sudan_branch_committed", { branchId: active.branchId });
            }

            if (
              submittedOps.includes("exchange_sudan_card") &&
              cardBefore.identity !== cardAfter.identity
            ) {
              const rareBefore = cardBefore.rare;
              const rareAfter = cardAfter.rare;
              const verifiedAfter =
                sudanRouteStore?.summarize({ sudanCardId: cardAfter.cardId }).verifiedBreak ?? 0;
              if (
                rareBefore != null &&
                rareAfter != null &&
                rareAfter > rareBefore &&
                verifiedAfter <= 0
              ) {
                actionChain.setSudanExchangeTierRegression({
                  rareBefore,
                  rareAfter,
                  identityAfter: cardAfter.identity,
                });
                log.info("sudan_exchange_tier_regression", {
                  rareBefore,
                  rareAfter,
                  identityAfter: cardAfter.identity,
                });
              } else {
                actionChain.setSudanExchangeTierRegression(null);
              }
              if (sudanBranchStore?.active()) {
                sudanBranchStore.appendPendingEvidence(sudanBranchStore.active()!.branchId, {
                  notes: [
                    `exchange:${cardBefore.identity}->${cardAfter.identity}`,
                    `exchange_rare:${rareBefore ?? "?"}->${rareAfter ?? "?"}`,
                  ],
                });
              }
            }

            const activeBranch = sudanBranchStore?.active() ?? null;
            const isolateLearning = !!activeBranch;

            if (experienceStore && submittedActions.length > 0) {
              const experiences = isolateLearning
                ? []
                : submittedActions.map((submittedAction, index) =>
                    recordActionExperience({
                      store: experienceStore,
                      stateBefore,
                      stateAfter: refreshed,
                      action: submittedAction as GameAction,
                      results: typedResults[index]
                        ? [typedResults[index]!]
                        : typedResults,
                      prediction: index === 0 ? pendingPrediction : null,
                      runId: log.runId,
                      gameFingerprint: opts.gameFingerprint,
                    }),
                  );
              if (isolateLearning && activeBranch) {
                sudanBranchStore?.appendPendingEvidence(activeBranch.branchId, {
                  notes: submittedOps.map((op) => `trial_op:${op}`),
                });
              }
              let altruismScores: OptionAltruismScore[] | null = null;
              if (
                cfg.agentSocialCapitalEnabled &&
                entityStores &&
                submittedOps.includes("select_event_option")
              ) {
                altruismScores = await resolveChoiceAltruism(stateBefore, false);
              }
              if (entityStores && !isolateLearning) {
                const entityUpdates = recordEntityKnowledge({
                  stores: entityStores,
                  stateBefore,
                  stateAfter: refreshed,
                  sceneAfter: refreshedScene,
                  actions: submittedActions as GameAction[],
                  results: typedResults,
                  experienceIds: experiences.map((experience) => experience.id),
                  runId: log.runId,
                  gameFingerprint: opts.gameFingerprint,
                  socialCapitalEnabled: cfg.agentSocialCapitalEnabled,
                  altruismScores,
                });
                log.info("entity_memory_updated", {
                  count: entityUpdates.length,
                  keys: entityUpdates.slice(0, 8).map((update) => update.key),
                });
                enqueueEnrichment(entityUpdates);
              } else if (isolateLearning && activeBranch && entityStores) {
                sudanBranchStore?.appendPendingEvidence(activeBranch.branchId, {
                  entityKeys: submittedOps.map((op) => `held_entity:${op}`),
                  notes: ["entity_updates_held_for_branch"],
                });
              }
              if (episodeTracker) {
                const openBefore = new Set(
                  episodeTracker.store.listOpen().map((episode) => `${episode.id}:${episode.phase}`),
                );
                recordEpisodeActions({
                  tracker: episodeTracker,
                  stateBefore,
                  stateAfter: refreshed,
                  actions: submittedActions as GameAction[],
                  results: typedResults,
                  experienceIds: experiences.map((experience) => experience.id),
                  runId: log.runId,
                  gameFingerprint: opts.gameFingerprint,
                  fingerprints: entityStores?.fingerprints,
                  allocations: actionChain.checkpoint.allocations,
                  step,
                  branchId: activeBranch?.branchId ?? null,
                  socialCapitalEnabled: cfg.agentSocialCapitalEnabled,
                  altruismScores,
                });
                // Record explore trials after successful execute/start_rite freezes composition.
                if (
                  exploreStore &&
                  entityStores &&
                  (submittedOps.includes("execute") || submittedOps.includes("start_rite"))
                ) {
                  for (let i = 0; i < submittedActions.length; i++) {
                    const action = submittedActions[i] as GameAction;
                    if (action.op !== "execute" && action.op !== "start_rite") continue;
                    if (typedResults[i]?.ok === false) continue;
                    const gate = evaluateRiteExploreGate({
                      action,
                      state: stateBefore,
                      stores: entityStores,
                      exploreStore,
                      backtrackStore,
                      runId: log.runId,
                      gameFingerprint: opts.gameFingerprint,
                    });
                    if (!gate || !gate.allow) continue;
                    const episode = episodeTracker.store
                      .listOpen()
                      .find(
                        (ep) =>
                          ep.eventKey === gate.eventKey &&
                          (ep.phase === "submitted" || ep.phase === "awaiting_result"),
                      );
                    exploreStore.recordSubmittedTrial({
                      runId: log.runId,
                      eventKey: gate.eventKey,
                      riteId: gate.riteId,
                      signature: gate.signature,
                      summaryZh: buildTrialSummaryZh({
                        signature: gate.signature,
                        state: stateBefore,
                        stores: entityStores,
                        gameFingerprint: opts.gameFingerprint,
                        preferLiveSlots: true,
                      }),
                      day:
                        typeof stateBefore?.values?.day === "number"
                          ? stateBefore.values.day
                          : null,
                      step,
                      episodeId: episode?.id,
                      isNovel: gate.isNovel,
                    });
                    const pathSig = buildPathSignature({
                      sudanIdentity: buildStrategySnapshot({
                        state: stateBefore,
                        gameFingerprint: opts.gameFingerprint,
                      }).sudanCard?.identity,
                      routeLabel: String(
                        (stateBefore?.values?.currentRite as { name?: string } | undefined)
                          ?.name ?? gate.riteId,
                      ),
                      compositionSignature: gate.signature,
                    });
                    recentPathSignatures = [...recentPathSignatures, pathSig].slice(-24);
                    if (
                      backtrackStore &&
                      typeof stateBefore?.values?.day === "number"
                    ) {
                      backtrackStore.appendExecutedPath({
                        runId: log.runId,
                        day: stateBefore.values.day,
                        pathSignature: pathSig,
                      });
                    }
                    if (activeRecovery && gate.signature) {
                      backtrackStore?.markSiblingTried({
                        runId: log.runId,
                        failureId: activeRecovery.failureId,
                        siblingSignature: pathSig,
                      });
                    }
                    log.info("rite_explore_trial_recorded", {
                      eventKey: gate.eventKey,
                      isNovel: gate.isNovel,
                      signature: gate.signature,
                      remaining: gate.remaining,
                    });
                  }
                }
                for (const episode of episodeTracker.store.listOpen()) {
                  const marker = `${episode.id}:${episode.phase}`;
                  if (openBefore.has(marker)) continue;
                  if (episode.phase === "placement") {
                    log.info("episode_open", {
                      episodeId: episode.id,
                      eventKey: episode.eventKey,
                      composition: episode.composition.length,
                      branchId: episode.branchId ?? null,
                    });
                  } else if (episode.phase === "submitted") {
                    log.info("episode_submitted", {
                      episodeId: episode.id,
                      eventKey: episode.eventKey,
                      composition: episode.composition.length,
                      branchId: episode.branchId ?? null,
                    });
                  }
                }
                applySettlements(
                  episodeTracker.observeState(refreshed, {
                    step,
                    experienceId: experiences.at(-1)?.id,
                  }),
                );
                for (const abandoned of episodeTracker.abandonExpired(step)) {
                  log.warn("episode_abandoned", {
                    episodeId: abandoned.id,
                    eventKey: abandoned.eventKey,
                    reason: "ttl_expired",
                  });
                }
              }
              pendingPrediction = null;
              activePlan = null; // force replan next turn
            }

            if (opts.memoryDir) {
              const submittedOps = submittedActions.map((a) => String(a.op ?? ""));
              if (
                submittedOps.includes("next_day") ||
                submittedOps.includes("next_round")
              ) {
                dayWindowStateBefore = stateBefore;
              }
              const beforeDay =
                typeof stateBefore?.values?.day === "number"
                  ? stateBefore.values.day
                  : null;
              const afterDay =
                typeof refreshed?.values?.day === "number"
                  ? refreshed.values.day
                  : null;
              if (
                episodeTracker &&
                beforeDay != null &&
                afterDay != null &&
                afterDay > beforeDay
              ) {
                applySettlements(
                  episodeTracker.observeDayAdvance(refreshed, {
                    step,
                    previousDay: beforeDay,
                  }),
                );
                log.info("episode_day_verify", {
                  previousDay: beforeDay,
                  day: afterDay,
                  pending: episodeTracker.store
                    .listOpen()
                    .filter((episode) => episode.phase === "awaiting_day_verify").length,
                });
              }
              const tick = tickDayBoundary(dayBoundary, {
                submittedOps,
                stateBefore,
                stateAfter: refreshed,
                sceneAfter: refreshedScene,
                results: results.map((r) => ({
                  ok: r?.ok !== false,
                  op: typeof r?.op === "string" ? r.op : null,
                  detail: typeof r?.detail === "string" ? r.detail : null,
                })),
              });
              dayBoundary = tick.boundary;
              if (tick.shouldReview && tick.reviewedDayWindow != null) {
                await performDailyReview(tick.reviewedDayWindow, tick.reason);
              }
            }

            result = {
              ...(result as Record<string, unknown>),
              stateAfter: refreshed,
              sceneAfter: refreshedScene,
            };
            if (isTerminalState(refreshed)) {
              const victory = isVictoryTerminal(refreshed);
              const recovery = terminalRecoveryOps(refreshed);
              const recoverable = !victory && recovery.length > 0;
              const hint = formatTerminalRecoveryHint(refreshed);
              if (hint) {
                result = {
                  ...(result as Record<string, unknown>),
                  terminalRecovery: {
                    victory,
                    ops: recovery,
                    hint,
                  },
                  forceReobserve: recoverable ? true : undefined,
                  hint,
                };
              }
              if (!recoverable) {
                // Do not reuse pre-click assistant text as the run summary.
                finalText = victory
                  ? "（终局：胜利）本局结束。"
                  : "（终局）无可恢复动作；本局结束。";
                stopReason = "terminal";
                log.info("loop_terminal", {
                  step,
                  stateKey: lastStateKey,
                  victory,
                  recovery,
                });
              } else {
                log.info("loop_terminal_recoverable", {
                  step,
                  stateKey: lastStateKey,
                  victory,
                  recovery,
                });
                if (backtrackStore && recovery.includes("prev_round")) {
                  const rewind = await runHostRecoveryRewind(refreshed);
                  latestState = rewind.state;
                  latestScene = rewind.scene;
                  lastStateKey = stateKeyFromGameState(latestState);
                  activePlan = null;
                  result = {
                    ...(result as Record<string, unknown>),
                    stateAfter: rewind.state,
                    sceneAfter: rewind.scene,
                    recoveryPlan: rewind.plan,
                    hint: rewind.plan?.hint ?? hint,
                    forceReobserve: true,
                  };
                  if (rewind.plan?.nextAction === "start_new_game") {
                    messages.push({
                      role: "user",
                      content:
                        "【Recovery】无法继续回退。请 start_new_game 重开；不要重走 failed path。",
                    });
                  } else if (rewind.plan?.nextAction === "try_sibling") {
                    // Resume normal planning at target day.
                  }
                }
              }
            }

            const failures = results.filter((r) => r && r.ok === false);
            const matching = failureLedger.matchingForState(lastStateKey);
            if (failures.length > 0 && matching.length >= 2) {
              // Repeated failures on same state: force re-observation instead of blind retry.
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify({
                  ...(result as Record<string, unknown>),
                  actionFailureLedger: matching.slice(-8),
                  forceReobserve: true,
                  hint: "同一状态连续失败，请先 get_state 再换合法 enabled action，勿重复相同参数。",
                }),
              });
              continue;
            }
          } catch (err) {
            log.warn("post_submit_state_refresh_failed", {
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (name === "get_state" && result && typeof result === "object") {
          // Compact/summary views omit rites[]; do not wipe a richer inventory.
          latestState = mergePreservingInventory(latestState, result as GameState);
          lastStateKey = stateKeyFromGameState(latestState);
        }

        if (name === "observe_scene" && result && typeof result === "object") {
          latestScene = result as SceneSnapshot;
        }

        if (result && typeof result === "object" && !Array.isArray(result)) {
          const matching = failureLedger.matchingForState(lastStateKey);
          if (matching.length > 0) {
            result = {
              ...(result as Record<string, unknown>),
              actionFailureLedger: matching.slice(-8),
            };
          }
        }

        if (
          result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          isTerminalState(result) &&
          !(result as { terminalRecovery?: unknown }).terminalRecovery
        ) {
          const victory = isVictoryTerminal(result);
          const recovery = terminalRecoveryOps(result);
          const recoverable = !victory && recovery.length > 0;
          const hint = formatTerminalRecoveryHint(result);
          if (hint) {
            result = {
              ...(result as Record<string, unknown>),
              terminalRecovery: {
                victory,
                ops: recovery,
                hint,
              },
              forceReobserve: recoverable ? true : undefined,
              hint,
            };
          }
          if (!recoverable && stopReason !== "terminal") {
            finalText = victory
              ? "（终局：胜利）本局结束。"
              : "（终局）无可恢复动作；本局结束。";
            stopReason = "terminal";
            log.info("loop_terminal", {
              step,
              stateKey: lastStateKey,
              victory,
              recovery,
            });
          } else if (recoverable) {
            log.info("loop_terminal_recoverable", {
              step,
              stateKey: lastStateKey,
              victory,
              recovery,
            });
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }

      // If tools omitted an embedded decision, still surface truncated reasoning in the HUD.
      if (hudThinking && !decisionPublished) {
        void ops
          .publishDecision({
            step,
            title: "思考",
            thinking: hudThinking,
          })
          .catch(() => undefined);
      }

      averageTurnGrowth = updateTurnGrowthEwma(
        averageTurnGrowth,
        Math.max(0, estimateTokens(messages) - estimatePromptTokens),
      );

      if (stopReason === "terminal") break;
    }

    if (!finalText) {
      finalText = "（已停止：达到单局最大步数）";
      stopReason = "max_steps";
      log.warn("loop_max_steps", { maxSteps: cfg.agentMaxSteps });
    }

    if (opts.memoryDir && (stopReason === "terminal" || stopReason === "max_steps")) {
      const flush = shouldFlushTerminalReview(dayBoundary, latestState);
      if (flush.shouldReview && flush.reviewedDayWindow != null) {
        await performDailyReview(flush.reviewedDayWindow, "terminal_flush");
      }
    }
  } finally {
    if (backgroundCompression && !backgroundCompression.settled) {
      backgroundCompression.controller.abort();
      await backgroundCompression.promise;
    }
    if (enrichmentWorker) {
      const enrichStats = await enrichmentWorker.shutdown(cfg.agentEntityEnrichFlushTimeoutMs);
      log.info("entity_enrich_queue_stats", { ...enrichStats, reason: "shutdown" });
    }
    log.writeText("messages.json", JSON.stringify(messages, null, 2));
    log.info("loop_end", {
      stopReason,
      dailyReviewCount,
      lastReviewedDay: reviewCursor.lastReviewedDay,
    });
  }

  return {
    finalText,
    stopReason,
    runDir: log.runDir,
    runId: log.runId,
    decisionTraces: traceWriter.all(),
    reviewCursor,
    dailyReviewCount,
  };
}
