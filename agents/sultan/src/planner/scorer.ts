import type { ExperienceRecord } from "@vibesultan/agent-learning-core";
import type { DayPlan, EventConfiguration, StrategySnapshot } from "../game/strategyTypes.js";
import {
  isCurrencyCard,
  isErrandEvent,
  isStrategicTierCard,
  tierMatchScore,
} from "../game/cardTier.js";
import { config } from "../config.js";
import { scoreSocialCapital } from "../moral/keyFollowers.js";
import {
  adviseExecutionTiming,
  planBreaksSudanCard,
  scoreExecutionTiming,
} from "./executionTiming.js";

/**
 * Lexicographic score vector (rolling Sudan lifecycle):
 * 0 survival / hard deadlines
 * 1 route feasibility + latest start / execution timing
 * 2 expiring break opportunities
 * 3 verified reward / cost (experience + entity knowledge)
 * --- when Social Capital enabled ---
 * 4 socialCapital (bounded 0–2; key followers presence + rare)
 * 5 route readiness / preparation coverage
 * 6 insight delta (mild negative — 灵视 +1 is soft cost)
 * 7 continuous / recurring coverage
 * 8 card/task tier fit
 * 9 reusable utilization + ordinary resources
 * 10 -opportunity cost
 * --- when Social Capital disabled (legacy 10-dim) ---
 * 4 route readiness … 9 -opportunity cost
 */
export function scorePlanVector(opts: {
  snapshot: StrategySnapshot;
  configurations: EventConfiguration[];
  experiences: ExperienceRecord[];
  /** Override config.agentSocialCapitalEnabled for tests. */
  socialCapitalEnabled?: boolean;
}): number[] {
  const { snapshot, configurations } = opts;
  const socialEnabled =
    opts.socialCapitalEnabled ?? config.agentSocialCapitalEnabled;
  const ops = new Set(
    configurations.map((c) => {
      if (c.id.startsWith("cfg_op_")) return c.id.slice(7);
      if (c.id.startsWith("cfg_place_")) return "place_card_on_rite";
      if (c.id.startsWith("cfg_open_")) return "open_rite";
      return "other";
    }),
  );

  const timing = adviseExecutionTiming(snapshot);
  const breaksSudan = planBreaksSudanCard(configurations);
  const advancesDay = ops.has("next_day") || ops.has("next_round");
  const riteStarted = snapshot.currentEvent?.started === true;
  const clearsSubmission =
    riteStarted &&
    ((ops.has("reset") && snapshot.enabledOps.includes("reset")) ||
      (ops.has("clear_rite_submission") &&
        snapshot.enabledOps.includes("clear_rite_submission")));
  const survival =
    snapshot.terminal === true
      ? -100
      : advancesDay && timing.lethalIfUnbroken && !breaksSudan
        ? -80
        : advancesDay &&
            (timing.policy === "commit_best" || timing.policy === "emergency") &&
            !breaksSudan
          ? -50
          : clearsSubmission
            ? 20
            : 10;

  const routeFeasibility = scoreExecutionTiming({ snapshot, configurations });

  const expiring =
    configurations.reduce((sum, c) => {
      if (c.event.life != null && c.event.life <= 1) {
        return sum + (planBreaksSudanCard([c]) ? 14 : 8);
      }
      return sum;
    }, 0) +
    (snapshot.sudanRoutes?.expiringOpportunity && breaksSudan ? 10 : 0) +
    (ops.has("select_event_option") ? 4 : 0);

  const verified =
    configurations.filter((c) => c.experienceIds.length > 0).length * 4 +
    Math.min(
      6,
      configurations.reduce(
        (sum, configuration) => sum + (configuration.entityKnowledgeScore ?? 0),
        0,
      ),
    );

  const social = socialEnabled ? scoreSocialCapital(snapshot.cards).score : null;

  const readiness =
    (snapshot.sudanRoutes?.readyCount ?? 0) * 3 +
    (snapshot.sudanRoutes?.needsSupportCount ?? 0) +
    (timing.policy === "discover_routes" && ops.has("open_rite") ? 8 : 0) +
    (timing.policy === "branch_test" &&
    (ops.has("exchange_sudan_card") || ops.has("open_sudan_box") || breaksSudan)
      ? 10
      : 0) +
    (timing.policy === "commit_best" && breaksSudan ? 12 : 0);

  // Mild negative weight for insight-increasing rewinds; do not hard-block.
  const insightCost = ops.has("prev_round") ? -2 : 0;

  const continuous = configurations.reduce((sum, c) => {
    const name = (c.event.name ?? "").toLowerCase();
    if (
      name.includes("治理家业") ||
      name.includes("权力的游戏") ||
      name.includes("浴场") ||
      name.includes("书店") ||
      name.includes("estate") ||
      name.includes("court") ||
      name.includes("bath")
    ) {
      return sum + (c.assignments.length > 0 || c.id.startsWith("cfg_open_") ? 10 : 2);
    }
    return sum;
  }, 0);

  const tierFit = configurations.reduce((sum, configuration) => {
    for (const assignment of configuration.assignments) {
      const slot = configuration.event.slots?.find(
        (candidate) => candidate.index === assignment.slotIndex,
      );
      sum += tierMatchScore({
        card: assignment.card,
        requiredRare: slot?.requiredRare,
        errand: isErrandEvent(configuration.event),
      });
    }
    return sum;
  }, 0);

  const assignedCardKeys = new Set<string>();
  for (const cfg of configurations) {
    for (const a of cfg.assignments) {
      assignedCardKeys.add(`u:${a.uid ?? "?"}|c:${a.card.cardId ?? "?"}`);
    }
  }
  const reusableHand = snapshot.cards.filter((c) => {
    const type = (c.type ?? "").toLowerCase();
    if (!c.inHand) return false;
    if (type === "sudan") return false;
    if (type === "consumable" || type === "once") return false;
    if (type === "item" && (isStrategicTierCard(c) || isCurrencyCard(c))) return false;
    return true;
  });
  const assignedReusable = reusableHand.filter((c) =>
    assignedCardKeys.has(`u:?|c:${c.cardId ?? "?"}`) ||
    [...assignedCardKeys].some((k) => k.includes(`c:${c.cardId ?? "?"}`)),
  ).length;
  const utilization =
    reusableHand.length === 0
      ? 0
      : Math.round((assignedReusable / reusableHand.length) * 20) +
        configurations.reduce((sum, c) => sum + c.assignments.length, 0);
  const ordinary =
    utilization +
    configurations.reduce((sum, c) => sum + Math.max(0, c.baseScore) * 0.1, 0);

  const opportunityCost = -configurations.reduce((sum, c) => {
    for (const a of c.assignments) {
      if (isStrategicTierCard(a.card) && (a.card.rare ?? 0) >= 3) sum += 2;
    }
    if ((c.estimatedLockTurns ?? 0) >= 2) sum += 1;
    return sum;
  }, 0);

  const tail = [
    readiness,
    insightCost,
    continuous,
    tierFit,
    ordinary,
    opportunityCost,
  ];
  if (social == null) {
    return [survival, routeFeasibility, expiring, verified, ...tail];
  }
  return [survival, routeFeasibility, expiring, verified, social, ...tail];
}

export function compareScoreVectors(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

export function summarizePlanRationale(
  plan: DayPlan,
  snapshot: StrategySnapshot,
  opts?: { socialCapitalEnabled?: boolean },
): string {
  const socialEnabled =
    opts?.socialCapitalEnabled ?? config.agentSocialCapitalEnabled;
  const ops = plan.steps.map((s) => s.op).join(" → ");
  const critical = snapshot.deadlines.filter((d) => d.critical).map((d) => d.label);
  const placeCount = plan.configurations.reduce((n, c) => n + c.assignments.length, 0);
  const timing = adviseExecutionTiming(snapshot);
  const bits = [
    `actions=${ops || "none"}`,
    `places=${placeCount}`,
    `execLeft=${timing.executionDaysLeft ?? "?"}`,
    `execPolicy=${timing.policy}`,
    `confidence=${plan.confidence.toFixed(2)}`,
  ];
  if (socialEnabled) {
    const social = scoreSocialCapital(snapshot.cards);
    bits.push(`socialCapital=${social.score}`);
    if (social.followers.length) {
      bits.push(
        `followers=${social.followers.map((f) => `${f.label}@${f.rare ?? "?"}`).join(",")}`,
      );
    }
  }
  if (planBreaksSudanCard(plan.configurations)) bits.push("breaksSudan=1");
  if (snapshot.sudanCard?.redrawRemaining != null) {
    bits.push(`redrawLeft=${snapshot.sudanCard.redrawRemaining}`);
  }
  if (snapshot.sudanRoutes) {
    bits.push(
      `routesReady=${snapshot.sudanRoutes.readyCount}`,
      `pendingProbes=${snapshot.sudanRoutes.pendingProbes}`,
    );
  }
  if (critical.length) bits.push(`critical=${critical.join(",")}`);
  if (plan.unknowns.length) bits.push(`unknowns=${plan.unknowns.slice(0, 3).join(",")}`);
  return bits.join("; ");
}
