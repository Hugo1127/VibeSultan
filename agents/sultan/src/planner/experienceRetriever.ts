import type { ExperienceRecord, ExperienceStore } from "@vibesultan/agent-learning-core";
import type { EventConfiguration, StrategySnapshot } from "../game/strategyTypes.js";

export function retrieveForConfigurations(opts: {
  store: ExperienceStore;
  snapshot: StrategySnapshot;
  configurations: EventConfiguration[];
  limit?: number;
}): ExperienceRecord[] {
  const actionSignatures = opts.configurations.map((c) => {
    if (c.id.startsWith("cfg_place_")) return "place_card_on_rite";
    if (c.id.startsWith("cfg_open_")) return "open_rite";
    if (c.id.startsWith("cfg_op_")) return c.id.slice("cfg_op_".length);
    return c.id;
  });

  const eventIds = [
    ...opts.snapshot.events.map((e) => e.riteId),
    opts.snapshot.currentEvent?.riteId,
    ...opts.configurations.map((c) => c.event.riteId),
  ];
  const cardIds = [
    ...opts.snapshot.cards.map((c) => c.cardId),
    ...opts.configurations.flatMap((c) => c.assignments.map((a) => a.card.cardId)),
  ];

  return opts.store.retrieveRelevant({
    version: opts.snapshot.version,
    actionSignatures,
    eventIds,
    cardIds,
    limit: opts.limit ?? 8,
  });
}

export function attachExperienceIds(
  configurations: EventConfiguration[],
  experiences: ExperienceRecord[],
): EventConfiguration[] {
  return configurations.map((cfg) => {
    const related = experiences
      .filter((exp) => {
        if (cfg.id.startsWith("cfg_op_") && exp.actionSignature.startsWith(cfg.id.slice(7))) {
          return true;
        }
        if (cfg.id.startsWith("cfg_place_") && exp.actionSignature.startsWith("place_card_on_rite")) {
          return true;
        }
        const riteId = cfg.event.riteId;
        return exp.eventFeatures.some((ev) => String(ev.riteId ?? ev.id ?? "") === String(riteId ?? ""));
      })
      .slice(0, 3)
      .map((e) => e.id);
    const boost = related.length * 0.5;
    return {
      ...cfg,
      experienceIds: related,
      baseScore: cfg.baseScore + boost,
    };
  });
}
