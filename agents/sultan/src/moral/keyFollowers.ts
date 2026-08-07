import type { CardFeature } from "../game/strategyTypes.js";

export interface KeyFollowerSpec {
  /** Stable catalog id when known. */
  cardId?: number;
  /** Display name patterns for cards whose id is not yet catalogued. */
  namePatterns: string[];
  label: string;
}

/** Key NPCs / allies used as hard Social Capital signals. */
export const KEY_FOLLOWERS: KeyFollowerSpec[] = [
  { cardId: 2000006, namePatterns: ["梅姬"], label: "梅姬" },
  { cardId: 2000312, namePatterns: ["奈费勒"], label: "奈费勒" },
  { cardId: undefined, namePatterns: ["鲁梅拉"], label: "鲁梅拉" },
];

const BOND_TAGS = new Set(["adherent", "支持", "命运的羁绊"]);

export interface SocialCapitalDetail {
  score: number;
  followers: Array<{ label: string; cardId: number | null; rare: number | null }>;
}

function cardName(card: CardFeature): string {
  return (card.name ?? "").trim();
}

function matchesFollower(card: CardFeature, spec: KeyFollowerSpec): boolean {
  if (spec.cardId != null && card.cardId === spec.cardId) return true;
  const name = cardName(card);
  if (!name) return false;
  return spec.namePatterns.some((pattern) => name.includes(pattern));
}

function followerContribution(rare: number | null | undefined): number {
  if (rare == null || rare <= 1) return 1;
  return 2;
}

function hasBondTag(card: CardFeature): boolean {
  const tags = card.tags ?? [];
  return tags.some((tag) => {
    const key = tag.includes(":") ? tag.split(":")[0]! : tag;
    return BOND_TAGS.has(key);
  });
}

/**
 * Bounded Social Capital score in [0, 2] from roster presence + rare tier.
 */
export function scoreSocialCapital(cards: CardFeature[]): SocialCapitalDetail {
  const followers: SocialCapitalDetail["followers"] = [];
  let raw = 0;
  const matchedIds = new Set<string>();

  for (const spec of KEY_FOLLOWERS) {
    const hit = cards.find((card) => matchesFollower(card, spec));
    if (!hit) continue;
    const key = `${spec.label}:${hit.cardId ?? hit.uid ?? cardName(hit)}`;
    if (matchedIds.has(key)) continue;
    matchedIds.add(key);
    raw += followerContribution(hit.rare);
    followers.push({
      label: spec.label,
      cardId: hit.cardId ?? null,
      rare: hit.rare ?? null,
    });
  }

  // Weak bond-tag bonus for other adherents not already counted.
  const extraBond = cards.some((card) => {
    if (!hasBondTag(card)) return false;
    return !KEY_FOLLOWERS.some((spec) => matchesFollower(card, spec));
  });
  if (extraBond) raw += 1;

  return {
    score: Math.max(0, Math.min(2, raw)),
    followers,
  };
}

export function matchesStrategicTarget(
  card: { cardId?: number | null; name?: string | null },
  targets: { cardIds?: number[]; namePatterns?: string[] },
): boolean {
  if (card.cardId != null && targets.cardIds?.includes(card.cardId)) return true;
  const name = (card.name ?? "").trim();
  if (!name) return false;
  return (targets.namePatterns ?? []).some((pattern) => name.includes(pattern));
}

/** Default strategic targets for altruistic rescue choices (name-first for 鲁梅拉). */
export function defaultStrategicTargets(): {
  cardIds: number[];
  namePatterns: string[];
} {
  return {
    cardIds: KEY_FOLLOWERS.map((f) => f.cardId).filter(
      (id): id is number => typeof id === "number",
    ),
    namePatterns: KEY_FOLLOWERS.flatMap((f) => f.namePatterns),
  };
}
