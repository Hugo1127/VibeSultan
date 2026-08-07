import type { ExperienceRecord } from "@vibesultan/agent-learning-core";
import type { DayPlan, EventConfiguration, StrategySnapshot } from "../game/strategyTypes.js";
import {
  formatTier,
  isStrategicTierCard,
} from "../game/cardTier.js";
import { configurationToAction } from "./candidateGenerator.js";
import { compareScoreVectors, scorePlanVector, summarizePlanRationale } from "./scorer.js";
import { improvePlanLocally } from "./localSearch.js";

interface BeamNode {
  usedCardKeys: Set<string>;
  usedSlotKeys: Set<string>;
  configurations: EventConfiguration[];
}

function cardKey(uid: number | null | undefined, cardId: number | null | undefined): string {
  return `u:${uid ?? "?"}|c:${cardId ?? "?"}`;
}

function slotKey(cfg: EventConfiguration): string[] {
  // Same rite may appear multiple times across different slots.
  return cfg.assignments.map(
    (a) => `r:${cfg.event.riteUid ?? cfg.event.riteId ?? "?"}|s:${a.slotIndex}`,
  );
}

function conflicts(node: BeamNode, cfg: EventConfiguration): boolean {
  for (const sk of slotKey(cfg)) {
    if (node.usedSlotKeys.has(sk)) return true;
  }
  for (const a of cfg.assignments) {
    if (node.usedCardKeys.has(cardKey(a.uid ?? null, a.card.cardId ?? null))) return true;
  }
  // Avoid packing end-of-day next_day with productive work in the same plan.
  const hasNext =
    cfg.id === "cfg_op_next_day" ||
    cfg.id === "cfg_op_next_round" ||
    node.configurations.some((c) => c.id === "cfg_op_next_day" || c.id === "cfg_op_next_round");
  const hasWork =
    cfg.id.startsWith("cfg_place_") ||
    cfg.id.startsWith("cfg_open_") ||
    cfg.id === "cfg_op_execute" ||
    cfg.id === "cfg_op_start_rite" ||
    node.configurations.some(
      (c) =>
        c.id.startsWith("cfg_place_") ||
        c.id.startsWith("cfg_open_") ||
        c.id === "cfg_op_execute" ||
        c.id === "cfg_op_start_rite",
    );
  if (hasNext && hasWork) return true;
  return false;
}

function expandMultiSlot(cfg: EventConfiguration): EventConfiguration[] {
  if (!cfg.id.startsWith("cfg_place_multi_") || cfg.assignments.length <= 1) return [cfg];
  // Expand into per-slot placements so beam can schedule them as sequential steps.
  return cfg.assignments.map((a) => ({
    id: `cfg_place_${cfg.event.riteUid ?? cfg.event.riteId ?? "x"}_${a.slotIndex}_${a.uid}`,
    event: cfg.event,
    assignments: [a],
    estimatedLockTurns: cfg.estimatedLockTurns,
    unknowns: cfg.unknowns,
    experienceIds: cfg.experienceIds,
    baseScore: cfg.baseScore / cfg.assignments.length,
  }));
}

export function beamSearchDayPlans(opts: {
  snapshot: StrategySnapshot;
  configurations: EventConfiguration[];
  experiences: ExperienceRecord[];
  beamWidth?: number;
  maxPlans?: number;
  maxDepth?: number;
  localImprove?: boolean;
}): DayPlan[] {
  const beamWidth = opts.beamWidth ?? 24;
  const maxPlans = opts.maxPlans ?? 8;
  const maxDepth = opts.maxDepth ?? 5;
  const ranked = opts.configurations
    .flatMap(expandMultiSlot)
    .sort((a, b) => b.baseScore - a.baseScore);

  let beam: BeamNode[] = [
    {
      usedCardKeys: new Set(),
      usedSlotKeys: new Set(),
      configurations: [],
    },
  ];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: BeamNode[] = [];
    for (const node of beam) {
      next.push(node);
      for (const cfg of ranked) {
        if (node.configurations.some((c) => c.id === cfg.id)) continue;
        if (conflicts(node, cfg)) continue;
        const usedCardKeys = new Set(node.usedCardKeys);
        const usedSlotKeys = new Set(node.usedSlotKeys);
        for (const a of cfg.assignments) {
          usedCardKeys.add(cardKey(a.uid ?? null, a.card.cardId ?? null));
        }
        for (const sk of slotKey(cfg)) usedSlotKeys.add(sk);
        next.push({
          usedCardKeys,
          usedSlotKeys,
          configurations: [...node.configurations, cfg],
        });
      }
    }

    next.sort((a, b) => {
      const sa = scorePlanVector({
        snapshot: opts.snapshot,
        configurations: a.configurations,
        experiences: opts.experiences,
      });
      const sb = scorePlanVector({
        snapshot: opts.snapshot,
        configurations: b.configurations,
        experiences: opts.experiences,
      });
      return compareScoreVectors(sa, sb);
    });
    beam = next.slice(0, beamWidth);
  }

  const plans: DayPlan[] = [];
  const seen = new Set<string>();
  for (const node of beam) {
    if (node.configurations.length === 0) continue;
    let configurations = node.configurations;
    if (opts.localImprove !== false) {
      const improved = improvePlanLocally({
        snapshot: opts.snapshot,
        seed: configurations,
        neighborhood: ranked,
        experiences: opts.experiences,
      });
      configurations = improved.configurations.length ? improved.configurations : configurations;
    }

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
    if (steps.length === 0) continue;
    const key = steps.map((s) => `${s.op}:${JSON.stringify(s.action)}`).join("||");
    if (seen.has(key)) continue;
    seen.add(key);

    const scoreVector = scorePlanVector({
      snapshot: opts.snapshot,
      configurations,
      experiences: opts.experiences,
    });
    const confidence = Math.max(
      0.15,
      Math.min(
        0.95,
        0.35 +
          configurations.reduce((s, c) => s + c.experienceIds.length, 0) * 0.08 -
          configurations.reduce((s, c) => s + c.unknowns.length, 0) * 0.05 +
          configurations.reduce(
            (s, c) => s + Math.min(0.08, (c.entityKnowledgeScore ?? 0) * 0.04),
            0,
          ),
      ),
    );
    const plan: DayPlan = {
      id: `plan_${plans.length + 1}`,
      steps,
      configurations,
      scoreVector,
      confidence,
      unknowns: [...new Set(configurations.flatMap((c) => c.unknowns))],
      risks: [
        ...(scoreVector[0]! < 0 ? ["deadline_or_survival_risk"] : []),
        ...new Set(
          configurations.flatMap(
            (configuration) => configuration.entityKnowledgeWarnings ?? [],
          ),
        ),
      ],
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
    plan.rationale = summarizePlanRationale(plan, opts.snapshot);
    plans.push(plan);
    if (plans.length >= maxPlans) break;
  }

  // Always include a safe no-work plan if next_day is enabled and no other plan exists.
  const dayAdvanceOp = opts.snapshot.enabledOps.includes("next_day")
    ? "next_day"
    : opts.snapshot.enabledOps.includes("next_round")
      ? "next_round"
      : null;
  if (plans.length === 0 && dayAdvanceOp) {
    plans.push({
      id: "plan_next_day_only",
      steps: [
        {
          op: dayAdvanceOp,
          action: { op: dayAdvanceOp },
          why: "No higher-value configuration found",
        },
      ],
      configurations: [],
      scoreVector: [-5, 0, 0, 0, 0, 0, 0],
      confidence: 0.2,
      unknowns: ["no_candidates"],
      risks: ["possibly_skipping_day_value"],
      preservedOptions: [],
      rationale: "Fallback continue",
    });
  }

  return plans.sort((a, b) => compareScoreVectors(a.scoreVector, b.scoreVector));
}
