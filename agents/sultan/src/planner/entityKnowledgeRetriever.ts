import type {
  EventConfiguration,
  StrategySnapshot,
} from "../game/strategyTypes.js";
import type { RelevantEntityKnowledge } from "../memory/entityRetriever.js";
import { riteEventKey } from "../memory/entityMemory.js";

export function attachEntityKnowledge(
  configurations: EventConfiguration[],
  snapshot: StrategySnapshot,
  relevant: RelevantEntityKnowledge,
): EventConfiguration[] {
  return configurations.map((configuration) => {
    const eventKey =
      configuration.event.riteId != null
        ? riteEventKey(
            snapshot.version.configFingerprint,
            configuration.event.riteId,
          )
        : snapshot.currentChoiceEvent?.eventKey ?? null;
    const cardIds = new Set(
      configuration.assignments
        .map((assignment) => assignment.card.cardId)
        .filter((cardId): cardId is number => cardId != null),
    );
    const slotIndexes = new Set(
      configuration.assignments.map((assignment) => assignment.slotIndex),
    );
    const interactions = relevant.interactions.filter(
      (record) =>
        eventKey != null &&
        record.facts.eventKey === eventKey &&
        cardIds.has(Number(record.facts.cardId)) &&
        (record.facts.slotIndex == null ||
          slotIndexes.has(Number(record.facts.slotIndex))),
    );
    const eventRecord = relevant.events.find(
      (record) => record.facts.eventKey === eventKey,
    );
    const ids = [
      ...interactions.map((record) => record.id),
      ...(eventRecord ? [eventRecord.id] : []),
    ];
    const score = interactions.reduce((sum, record) => {
      const statusWeight =
        record.status === "validated"
          ? 1
          : record.status === "provisional"
            ? 0.35
            : 0;
      return sum + record.confidence * statusWeight * 2;
    }, 0);
    const failureModes = Array.isArray(eventRecord?.facts.failureModes)
      ? eventRecord.facts.failureModes.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    for (const interaction of interactions) {
      if (!Array.isArray(interaction.facts.failureModes)) continue;
      failureModes.push(
        ...interaction.facts.failureModes.filter(
          (item): item is string => typeof item === "string",
        ),
      );
    }
    return {
      ...configuration,
      entityKnowledgeIds: ids,
      entityKnowledgeScore: score,
      entityKnowledgeWarnings: [...new Set(failureModes)].slice(0, 3),
      // Keep knowledge below hard constraints by applying it only to base/ordinary value.
      baseScore: configuration.baseScore + score,
    };
  });
}
