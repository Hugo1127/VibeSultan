import type { ExperienceStore } from "@vibesultan/agent-learning-core";
import type { GameAction, GameState, SceneSnapshot } from "../game/types.js";
import type { StrategyEngineOutput } from "../game/strategyTypes.js";
import { config } from "../config.js";
import {
  formatChoiceRecommendation,
  readCachedAltruismScores,
} from "../moral/choiceHeuristics.js";
import { buildStrategySnapshot } from "../memory/experienceAdapter.js";
import { generateEventConfigurations } from "./candidateGenerator.js";
import { adviseExecutionTiming } from "./executionTiming.js";
import { attachExperienceIds, retrieveForConfigurations } from "./experienceRetriever.js";
import { beamSearchDayPlans } from "./beamSearch.js";
import type { SultanEntityStores } from "../memory/entityMemory.js";
import { retrieveRelevantEntityKnowledge } from "../memory/entityRetriever.js";
import { attachEntityKnowledge } from "./entityKnowledgeRetriever.js";
import type { RiteExploreStore } from "../memory/riteExploreStore.js";
import type { BacktrackStore } from "../memory/backtrackStore.js";
import {
  annotateExploreConfigurations,
  filterBlockedExploreConfigurations,
} from "./riteExplorePolicy.js";

export function runStrategyEngine(opts: {
  state: GameState | null | undefined;
  scene: SceneSnapshot | null | undefined;
  store: ExperienceStore;
  entityStores?: SultanEntityStores | null;
  gameFingerprint?: string | null;
  beamWidth?: number;
  maxPlans?: number;
  sudanRouteSummary?: import("../game/strategyTypes.js").StrategySnapshot["sudanRoutes"];
  exchangeCircuitOpen?: boolean;
  exploreStore?: RiteExploreStore | null;
  backtrackStore?: BacktrackStore | null;
  runId?: string | null;
  exploreRecovery?: import("../game/strategyTypes.js").StrategySnapshot["exploreRecovery"];
}): StrategyEngineOutput {
  const snapshot = buildStrategySnapshot({
    state: opts.state,
    scene: opts.scene,
    gameFingerprint: opts.gameFingerprint,
    sudanRouteSummary: opts.sudanRouteSummary,
    exchangeCircuitOpen: opts.exchangeCircuitOpen,
    exploreRecovery: opts.exploreRecovery,
  });

  const rawConfigs = generateEventConfigurations({
    snapshot,
    state: opts.state,
    scene: opts.scene,
  });
  const experiences = retrieveForConfigurations({
    store: opts.store,
    snapshot,
    configurations: rawConfigs,
    limit: 10,
  });
  const experienceConfigurations = attachExperienceIds(rawConfigs, experiences);
  const relevantEntities = opts.entityStores
    ? retrieveRelevantEntityKnowledge({
        stores: opts.entityStores,
        state: opts.state,
        gameFingerprint: opts.gameFingerprint,
        maxCards: 12,
        maxEvents: 12,
        maxInteractions: 40,
      })
    : null;
  let configurations = relevantEntities
    ? attachEntityKnowledge(experienceConfigurations, snapshot, relevantEntities)
    : experienceConfigurations;

  if (opts.entityStores && opts.exploreStore && opts.runId) {
    configurations = annotateExploreConfigurations({
      configurations,
      stores: opts.entityStores,
      exploreStore: opts.exploreStore,
      backtrackStore: opts.backtrackStore,
      runId: opts.runId,
      state: opts.state,
      gameFingerprint: opts.gameFingerprint,
      failedPathBoost: snapshot.exploreRecovery?.recoveryActive === true,
    });
    configurations = filterBlockedExploreConfigurations(configurations);
  }

  const candidates = beamSearchDayPlans({
    snapshot,
    configurations,
    experiences,
    beamWidth: opts.beamWidth,
    maxPlans: opts.maxPlans,
    localImprove: true,
  });

  const recommended = candidates[0] ?? null;
  const firstAction: GameAction | null = recommended?.steps[0]?.action ?? null;

  return {
    snapshot,
    candidates,
    configurations,
    experiences: experiences as unknown[],
    recommendedPlanId: recommended?.id ?? null,
    firstAction,
    retrievalNotes: [
      `configs=${configurations.length}`,
      `experiences=${experiences.length}`,
      `entityKnowledge=${relevantEntities?.interactions.length ?? 0}`,
      `plans=${candidates.length}`,
      experiences.length === 0 ? "cold_start_no_experience" : "experience_retrieved",
      snapshot.exploreRecovery?.recoveryActive ? "recovery_active" : "recovery_idle",
    ],
    builtFrom: {
      stateDay: snapshot.day,
      sceneVersion: snapshot.sceneVersion,
      experienceCount: experiences.length,
      entityKnowledgeCount: relevantEntities
        ? relevantEntities.cards.length +
          relevantEntities.events.length +
          relevantEntities.interactions.length
        : 0,
    },
  };
}

export function formatStrategyBrief(
  output: StrategyEngineOutput,
  maxPlans = 5,
  entityStores?: SultanEntityStores | null,
): string {
  const lines: string[] = [];
  const timing = adviseExecutionTiming(output.snapshot);
  lines.push("【策略引擎候选】硬规则+经验检索生成，非攻略灌入。请从中选择 planId，并只执行其第一步。");
  lines.push(
    `day=${output.snapshot.day ?? "?"} phase=${output.snapshot.phase ?? "?"} execLeft=${output.snapshot.executionDaysLeft ?? "?"} experiences=${output.builtFrom.experienceCount}`,
  );
  lines.push(`executionTiming: policy=${timing.policy} | ${timing.hint}`);
  if (config.agentSocialCapitalEnabled && output.snapshot.currentChoiceEvent?.options?.length) {
    const choice = output.snapshot.currentChoiceEvent;
    const cached = entityStores
      ? readCachedAltruismScores(
          entityStores.events.get(choice.eventKey, output.snapshot.version)?.facts as
            | Record<string, unknown>
            | undefined,
        )
      : null;
    const choiceLine = formatChoiceRecommendation(choice.options, cached);
    if (choiceLine) lines.push(choiceLine);
  }
  if (output.snapshot.sudanCards && output.snapshot.sudanCards.length > 0) {
    const list = output.snapshot.sudanCards
      .map((c) => {
        const rem =
          c.remaining != null && c.initLife != null
            ? `${c.remaining}/${c.initLife}`
            : c.remaining != null
              ? String(c.remaining)
              : "?";
        return `${c.name ?? c.cardId ?? "?"}[${rem}]`;
      })
      .join(", ");
    lines.push(`sudanCards(${output.snapshot.sudanCards.length}): ${list}`);
  } else if (output.snapshot.sudanCard) {
    const card = output.snapshot.sudanCard;
    lines.push(
      `sudanCard: ${card.name ?? card.cardId ?? "?"} redrawLeft=${card.redrawRemaining ?? "?"} insight=${output.snapshot.insight ?? "?"} rewind=${output.snapshot.rewindAvailable ? 1 : 0}`,
    );
  }
  if (output.snapshot.sudanRoutes) {
    const routes = output.snapshot.sudanRoutes;
    lines.push(
      `sudanRoutes: coverage=${routes.coverage.toFixed(2)} ready=${routes.readyCount} needs_support=${routes.needsSupportCount} verified_break=${routes.verifiedBreakCount ?? 0} pending_probes=${routes.pendingProbes} shortest_prep=${routes.shortestPrepDays ?? "?"} best=${routes.bestRouteLabel ?? "none"} tried_branches=${routes.triedBranchCount ?? 0}`,
    );
  }
  if (output.snapshot.exploreRecovery) {
    const er = output.snapshot.exploreRecovery;
    lines.push(
      `exploreRecovery: active=${er.recoveryActive ? 1 : 0} targetDay=${er.recoveryTargetDay ?? "?"} depth=${er.recoveryDepth ?? "?"} rewindLeft=${er.rewindRemaining ?? "?"} failedPaths=${er.failedPathCount ?? 0}` +
        (er.recoveryHint ? ` | ${er.recoveryHint}` : ""),
    );
  }
  if (output.snapshot.deadlines.length) {
    lines.push(
      `deadlines: ${output.snapshot.deadlines
        .slice(0, 5)
        .map((d) => `${d.label}:${d.remaining ?? "?"}${d.critical ? "*" : ""}`)
        .join("; ")}`,
    );
  }
  for (const plan of output.candidates.slice(0, maxPlans)) {
    const step = plan.steps[0];
    lines.push(
      `- ${plan.id}: first=${step ? JSON.stringify(step.action) : "none"} score=${plan.scoreVector
        .map((n) => n.toFixed(1))
        .join(",")} conf=${plan.confidence.toFixed(2)} | ${plan.rationale}`,
    );
    if (plan.risks.length) lines.push(`  risks: ${plan.risks.join(", ")}`);
    if (plan.unknowns.length) lines.push(`  unknowns: ${plan.unknowns.slice(0, 4).join(", ")}`);
    const knowledgeScore = plan.configurations.reduce(
      (sum, configuration) => sum + (configuration.entityKnowledgeScore ?? 0),
      0,
    );
    const knowledgeWarnings = [
      ...new Set(
        plan.configurations.flatMap(
          (configuration) => configuration.entityKnowledgeWarnings ?? [],
        ),
      ),
    ];
    if (knowledgeScore > 0) {
      lines.push(`  entityKnowledgeScore=${knowledgeScore.toFixed(2)}`);
    }
    if (knowledgeWarnings.length > 0) {
      lines.push(`  knownFailures: ${knowledgeWarnings.slice(0, 3).join("; ")}`);
    }
  }
  lines.push(`notes: ${output.retrievalNotes.join("; ")}`);
  lines.push("选择后 submit_actions 只提交该 plan 的第一个动作；执行后会重新规划。");
  return lines.join("\n");
}
