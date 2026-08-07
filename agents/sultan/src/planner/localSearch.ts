import type { ExperienceRecord } from "@vibesultan/agent-learning-core";
import type { DayPlan, EventConfiguration, StrategySnapshot } from "../game/strategyTypes.js";
import {
  formatTier,
  isStrategicTierCard,
} from "../game/cardTier.js";
import { configurationToAction } from "./candidateGenerator.js";
import { compareScoreVectors, scorePlanVector, summarizePlanRationale } from "./scorer.js";

function cardKey(uid: number | null | undefined, cardId: number | null | undefined): string {
  return `u:${uid ?? "?"}|c:${cardId ?? "?"}`;
}

function slotKey(cfg: EventConfiguration): string | null {
  const a = cfg.assignments[0];
  if (!a) return null;
  return `r:${cfg.event.riteUid ?? cfg.event.riteId ?? "?"}|s:${a.slotIndex}`;
}

function cloneConfigs(configs: EventConfiguration[]): EventConfiguration[] {
  return configs.map((c) => ({
    ...c,
    assignments: c.assignments.map((a) => ({ ...a, card: { ...a.card } })),
    unknowns: [...c.unknowns],
    experienceIds: [...c.experienceIds],
  }));
}

function usesCard(cfg: EventConfiguration, key: string): boolean {
  return cfg.assignments.some((a) => cardKey(a.uid ?? null, a.card.cardId ?? null) === key);
}

function scoreOf(
  snapshot: StrategySnapshot,
  configurations: EventConfiguration[],
  experiences: ExperienceRecord[],
): number[] {
  return scorePlanVector({ snapshot, configurations, experiences });
}

function toPlan(
  id: string,
  configurations: EventConfiguration[],
  snapshot: StrategySnapshot,
  experiences: ExperienceRecord[],
): DayPlan {
  const steps = [];
  for (const cfg of configurations) {
    const action = configurationToAction(cfg);
    if (!action) continue;
    steps.push({
      op: String(action.op),
      action,
      why: `configuration ${cfg.id}`,
      configurationId: cfg.id,
    });
  }
  const scoreVector = scoreOf(snapshot, configurations, experiences);
  const plan: DayPlan = {
    id,
    steps,
    configurations,
    scoreVector,
    confidence: Math.max(0.2, Math.min(0.95, 0.4 + configurations.length * 0.05)),
    unknowns: [...new Set(configurations.flatMap((c) => c.unknowns))],
    risks: scoreVector[0]! < 0 ? ["deadline_or_survival_risk"] : [],
    preservedOptions: [
      ...new Set(
        configurations.flatMap((configuration) =>
          configuration.assignments
            .filter(
              (assignment) =>
                isStrategicTierCard(assignment.card) &&
                (assignment.card.rare ?? 0) >= 3,
            )
            .map(
              (assignment) =>
                `preserve_tier:${formatTier(assignment.card.rare) ?? assignment.card.rare}:${
                  assignment.card.name ?? assignment.card.cardId
                }`,
            ),
        ),
      ),
    ],
    rationale: "",
  };
  plan.rationale = summarizePlanRationale(plan, snapshot);
  return plan;
}

/**
 * Bounded local improvement over a complete feasible assignment set:
 * move one card, swap two cards, add idle card into empty slot, drop low-value assignment.
 */
export function improvePlanLocally(opts: {
  snapshot: StrategySnapshot;
  seed: EventConfiguration[];
  neighborhood: EventConfiguration[];
  experiences: ExperienceRecord[];
  maxIterations?: number;
}): DayPlan {
  const maxIterations = opts.maxIterations ?? 12;
  let current = cloneConfigs(opts.seed.filter((c) => c.assignments.length > 0 || c.id.startsWith("cfg_op_")));
  // Prefer productive placement/open/execute configs in the working set.
  current = current.filter(
    (c) =>
      c.id.startsWith("cfg_place_") ||
      c.id.startsWith("cfg_open_") ||
      c.id === "cfg_op_execute" ||
      c.id === "cfg_op_start_rite" ||
      c.id === "cfg_op_reset",
  );
  let bestScore = scoreOf(opts.snapshot, current, opts.experiences);
  const pool = opts.neighborhood.filter((c) => c.id.startsWith("cfg_place_"));

  for (let iter = 0; iter < maxIterations; iter++) {
    let improved: EventConfiguration[] | null = null;
    let improvedScore: number[] | null = null;

    // 1) Add an unused place config (fill idle reusable card / empty slot).
    for (const candidate of pool) {
      const sk = slotKey(candidate);
      const ck = cardKey(
        candidate.assignments[0]?.uid ?? null,
        candidate.assignments[0]?.card.cardId ?? null,
      );
      if (!sk) continue;
      if (current.some((c) => slotKey(c) === sk)) continue;
      if (current.some((c) => usesCard(c, ck))) continue;
      const next = [...current, candidate];
      const score = scoreOf(opts.snapshot, next, opts.experiences);
      if (compareScoreVectors(score, bestScore) < 0) {
        improved = next;
        improvedScore = score;
        bestScore = score;
      }
    }

    // 2) Replace one assignment with another for the same card (move).
    for (let i = 0; i < current.length; i++) {
      const cur = current[i]!;
      if (!cur.id.startsWith("cfg_place_")) continue;
      const ck = cardKey(cur.assignments[0]?.uid ?? null, cur.assignments[0]?.card.cardId ?? null);
      for (const candidate of pool) {
        const candKey = cardKey(
          candidate.assignments[0]?.uid ?? null,
          candidate.assignments[0]?.card.cardId ?? null,
        );
        if (candKey !== ck) continue;
        const sk = slotKey(candidate);
        if (!sk || current.some((c, idx) => idx !== i && slotKey(c) === sk)) continue;
        const next = current.map((c, idx) => (idx === i ? candidate : c));
        const score = scoreOf(opts.snapshot, next, opts.experiences);
        if (compareScoreVectors(score, bestScore) < 0) {
          improved = next;
          improvedScore = score;
          bestScore = score;
        }
      }
    }

    // 3) Swap cards between two placements.
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const a = current[i]!;
        const b = current[j]!;
        if (!a.id.startsWith("cfg_place_") || !b.id.startsWith("cfg_place_")) continue;
        const aUid = a.assignments[0]?.uid;
        const bUid = b.assignments[0]?.uid;
        const aSlot = a.assignments[0]?.slotIndex;
        const bSlot = b.assignments[0]?.slotIndex;
        if (aUid == null || bUid == null || aSlot == null || bSlot == null) continue;
        const swapA = pool.find(
          (c) =>
            c.assignments[0]?.uid === bUid &&
            c.assignments[0]?.slotIndex === aSlot &&
            (c.event.riteUid ?? c.event.riteId) === (a.event.riteUid ?? a.event.riteId),
        );
        const swapB = pool.find(
          (c) =>
            c.assignments[0]?.uid === aUid &&
            c.assignments[0]?.slotIndex === bSlot &&
            (c.event.riteUid ?? c.event.riteId) === (b.event.riteUid ?? b.event.riteId),
        );
        if (!swapA || !swapB) continue;
        const next = current.map((c, idx) => (idx === i ? swapA : idx === j ? swapB : c));
        const score = scoreOf(opts.snapshot, next, opts.experiences);
        if (compareScoreVectors(score, bestScore) < 0) {
          improved = next;
          improvedScore = score;
          bestScore = score;
        }
      }
    }

    // 4) Drop lowest baseScore placement and try refill (bounded).
    if (current.length > 0) {
      const placeIdx = current
        .map((c, idx) => ({ c, idx }))
        .filter((x) => x.c.id.startsWith("cfg_place_"))
        .sort((x, y) => x.c.baseScore - y.c.baseScore);
      if (placeIdx[0]) {
        const without = current.filter((_, idx) => idx !== placeIdx[0]!.idx);
        const score = scoreOf(opts.snapshot, without, opts.experiences);
        // Only accept drop if it improves opportunity-cost / survival lex order.
        if (compareScoreVectors(score, bestScore) < 0) {
          improved = without;
          improvedScore = score;
          bestScore = score;
        }
      }
    }

    if (!improved || !improvedScore) break;
    current = improved;
  }

  return toPlan("plan_local_opt", current, opts.snapshot, opts.experiences);
}
