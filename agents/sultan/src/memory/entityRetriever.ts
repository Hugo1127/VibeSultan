import type { EntityKnowledgeRecord, KnowledgeVersionKey } from "@vibesultan/agent-learning-core";
import { isCurrencyCard } from "../game/cardTier.js";
import type { GameState } from "../game/types.js";
import {
  cardFeaturesFromState,
  choiceEventFromState,
  eventFeaturesFromState,
  versionKeyFromState,
} from "./experienceAdapter.js";
import {
  cardKnowledgeKey,
  riteEventKey,
  type SultanEntityStores,
} from "./entityMemory.js";

export interface RelevantEntityKnowledge {
  cards: EntityKnowledgeRecord[];
  events: EntityKnowledgeRecord[];
  interactions: EntityKnowledgeRecord[];
  unknownCardIds: number[];
  currentCardIds: number[];
  currentEventKeys: string[];
}

export type CardInspectionReason = "missing_knowledge" | "usage_unknown" | "missing_description";

/**
 * Return why a card type still needs a real inspect_card observation.
 * Knowledge is keyed by stable cardId, so a known card with a new runtime UID
 * does not need to be inspected again.
 */
export function cardInspectionRequirement(opts: {
  stores: SultanEntityStores;
  state: GameState | null | undefined;
  cardId: number;
  gameFingerprint?: string | null;
  /** Optional runtime card fields for currency / type short-circuit. */
  cardHint?: { name?: string | null; type?: string | null; rare?: number | null };
}): CardInspectionReason | null {
  if (
    isCurrencyCard({
      name: opts.cardHint?.name ?? undefined,
      type: opts.cardHint?.type ?? undefined,
      rare: opts.cardHint?.rare ?? undefined,
    })
  ) {
    return null;
  }

  const rawVersion = versionKeyFromState(opts.state, opts.gameFingerprint);
  const configFingerprint = opts.stores.fingerprints.resolve(
    rawVersion.configFingerprint,
  );
  const version: KnowledgeVersionKey = {
    ...rawVersion,
    configFingerprint,
    gameFingerprint: opts.gameFingerprint?.trim() || configFingerprint,
  };
  const keys = opts.stores.fingerprints.expandKeys([
    cardKnowledgeKey(configFingerprint, opts.cardId),
  ]);
  const record = retrieveAcrossAliases(opts.stores.cards, version, keys, 1)[0];
  if (!record) return "missing_knowledge";

  if (
    isCurrencyCard({
      name: typeof record.facts.name === "string" ? record.facts.name : undefined,
      type: typeof record.facts.type === "string" ? record.facts.type : undefined,
      rare: typeof record.facts.rare === "number" ? record.facts.rare : undefined,
    })
  ) {
    return null;
  }

  const unknowns = Array.isArray(record.facts.unknowns)
    ? record.facts.unknowns.filter((value): value is string => typeof value === "string")
    : [];
  if (unknowns.includes("usage_unknown")) return "usage_unknown";
  const description =
    typeof record.facts.description === "string"
      ? record.facts.description.trim()
      : "";
  return description ? null : "missing_description";
}

export function retrieveRelevantEntityKnowledge(opts: {
  stores: SultanEntityStores;
  state: GameState | null | undefined;
  gameFingerprint?: string | null;
  maxCards?: number;
  maxEvents?: number;
  maxInteractions?: number;
}): RelevantEntityKnowledge {
  const rawVersion = versionKeyFromState(opts.state, opts.gameFingerprint);
  // Resolve existing aliases only — never record a transition during retrieval,
  // or temporary incompatible fingerprints would incorrectly merge families.
  const configFingerprint = opts.stores.fingerprints.resolve(
    rawVersion.configFingerprint,
  );
  const version: KnowledgeVersionKey = {
    ...rawVersion,
    configFingerprint,
    gameFingerprint: opts.gameFingerprint?.trim() || configFingerprint,
  };

  const currentCardIds = [
    ...new Set(
      cardFeaturesFromState(opts.state)
        .filter((card) => card.inHand && card.cardId != null)
        .map((card) => card.cardId!),
    ),
  ];
  const cardKeys = opts.stores.fingerprints.expandKeys(
    currentCardIds.map((cardId) => cardKnowledgeKey(configFingerprint, cardId)),
  );

  const currentEventKeys = eventFeaturesFromState(opts.state)
    .filter((event) => event.riteId != null)
    .map((event) => riteEventKey(configFingerprint, event.riteId!));
  const choice = choiceEventFromState(opts.state);
  if (choice) {
    currentEventKeys.unshift(
      opts.stores.fingerprints.rewriteKey(choice.eventKey, configFingerprint),
    );
  }
  const uniqueEventKeys = [...new Set(currentEventKeys)];
  const eventKeys = opts.stores.fingerprints.expandKeys(uniqueEventKeys);

  const cards = retrieveAcrossAliases(opts.stores.cards, version, cardKeys, opts.maxCards ?? 6);
  const events = retrieveAcrossAliases(
    opts.stores.events,
    version,
    eventKeys,
    opts.maxEvents ?? 4,
  );

  const cardIdSet = new Set(currentCardIds.map(String));
  const eventKeySet = new Set(eventKeys);
  const fingerprintFamily = new Set(opts.stores.fingerprints.expand(configFingerprint));
  const interactions = opts.stores.interactions
    .list()
    .filter((record) => fingerprintFamily.has(record.version.configFingerprint))
    .filter((record) => record.status !== "contradicted")
    .filter((record) => {
      const eventKey = String(record.facts.eventKey ?? "");
      const aliasedEventKeys = opts.stores.fingerprints.expandKeys([eventKey]);
      return (
        cardIdSet.has(String(record.facts.cardId ?? "")) &&
        aliasedEventKeys.some((key) => eventKeySet.has(key) || uniqueEventKeys.includes(key))
      );
    })
    .sort(
      (a, b) =>
        statusRank(b.status) - statusRank(a.status) ||
        b.confidence - a.confidence ||
        b.sampleCount - a.sampleCount,
    )
    .slice(0, opts.maxInteractions ?? 8);

  // Injected cards are a filtered subset; any stored record for a hand cardId is "known"
  // (including contradicted) so we do not keep prompting inspect_card.
  const knownCardIds = new Set<number>();
  for (const cardId of currentCardIds) {
    const keysForCard = new Set(
      opts.stores.fingerprints.expandKeys([
        cardKnowledgeKey(configFingerprint, cardId),
      ]),
    );
    const found = opts.stores.cards
      .list()
      .some(
        (record) =>
          Number(record.facts.cardId) === cardId &&
          (keysForCard.has(record.key) ||
            fingerprintFamily.has(record.version.configFingerprint)),
      );
    if (found) knownCardIds.add(cardId);
  }
  return {
    cards,
    events,
    interactions,
    unknownCardIds: currentCardIds.filter((cardId) => !knownCardIds.has(cardId)),
    currentCardIds,
    currentEventKeys: uniqueEventKeys,
  };
}

function retrieveAcrossAliases(
  store: SultanEntityStores["cards"],
  version: KnowledgeVersionKey,
  keys: string[],
  limit: number,
): EntityKnowledgeRecord[] {
  const keyOrder = new Map(keys.map((key, index) => [key, index]));
  const seen = new Set<string>();
  const matched: EntityKnowledgeRecord[] = [];
  for (const record of store.list()) {
    if (!keyOrder.has(record.key)) continue;
    if (record.status === "contradicted") continue;
    if (record.confidence < 0) continue;
    const identity = `${record.kind}:${record.facts.cardId ?? record.facts.riteId ?? record.facts.eventKey ?? record.key}`;
    if (seen.has(identity)) continue;
    if (
      record.version.configFingerprint !== version.configFingerprint &&
      record.version.gameFingerprint !== version.gameFingerprint
    ) {
      // still accept via key expansion; fingerprint family is implied by expanded keys
    }
    seen.add(identity);
    matched.push(record);
  }
  return matched
    .sort(
      (a, b) =>
        (keyOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
          (keyOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER) ||
        b.confidence - a.confidence ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, limit);
}

function statusRank(status: string): number {
  if (status === "validated") return 3;
  if (status === "provisional") return 2;
  if (status === "observed") return 1;
  return 0;
}
