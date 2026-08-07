export type CardTierName = "石" | "铜" | "银" | "金";

export interface TierCardLike {
  rare?: number | null;
  type?: string | null;
  name?: string | null;
}

export interface TierEventLike {
  name?: string | null;
}

const TIER_NAMES: Record<number, CardTierName> = {
  1: "石",
  2: "铜",
  3: "银",
  4: "金",
};

const TIER_ALIASES: Array<[RegExp, number]> = [
  [/(?:岩石|石)(?:品级|品阶|阶|级)|\bstone(?:\s+tier)?\b/i, 1],
  [/(?:青铜|铜)(?:品级|品阶|阶|级)|\b(?:copper|bronze)(?:\s+tier)?\b/i, 2],
  [/(?:白银|银)(?:品级|品阶|阶|级)|\bsilver(?:\s+tier)?\b/i, 3],
  [/(?:黄金|金)(?:品级|品阶|阶|级)|\bgold(?:en)?(?:\s+tier)?\b/i, 4],
];

const CURRENCY_RE = /金币|金骰|gold\s*(?:coin|dice)?|coin|currency|money/i;
const ERRAND_EVENT_RE =
  /治理家业|权力的游戏|浴场|书店|跑腿|estate|court|bath|bookstore|errand/i;

export function normalizeRare(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 4
    ? value
    : null;
}

export function tierName(rare: unknown): CardTierName | null {
  const normalized = normalizeRare(rare);
  return normalized == null ? null : TIER_NAMES[normalized] ?? null;
}

export function formatTier(rare: unknown): string | null {
  const normalized = normalizeRare(rare);
  const name = tierName(normalized);
  return normalized != null && name ? `${name}(${normalized})` : null;
}

export function parseTierFromText(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const exactAliases: Record<string, number> = {
    石: 1,
    岩石: 1,
    铜: 2,
    青铜: 2,
    银: 3,
    白银: 3,
    金: 4,
    黄金: 4,
  };
  if (exactAliases[text]) return exactAliases[text]!;

  const keyed = text.match(
    /(?:requiredRare|minRare|rare|rarity|tier|品级|品阶)\s*["']?\s*[:=：]?\s*["']?([1-4])\b/i,
  );
  if (keyed) return Number(keyed[1]);

  // f:rare-s1.rare<=:0 or JSON key "f:rare-s1.rare<=":0 → max rare = N+1.
  const formula = text.match(/f:rare[^\s"]*\.rare\s*<=\s*"?\s*:?\s*(-?\d+)/i);
  if (formula) {
    const n = Number(formula[1]);
    if (Number.isFinite(n)) {
      const maxRare = n + 1;
      if (maxRare >= 1 && maxRare <= 4) return maxRare;
    }
  }

  for (const [pattern, rare] of TIER_ALIASES) {
    if (pattern.test(text)) return rare;
  }
  return null;
}

export function isCurrencyCard(card: TierCardLike): boolean {
  const type = card.type?.trim() ?? "";
  const name = card.name?.trim() ?? "";
  return CURRENCY_RE.test(`${name} ${type}`);
}

export function isStrategicTierCard(card: TierCardLike): boolean {
  if (normalizeRare(card.rare) == null || isCurrencyCard(card)) return false;
  const type = card.type?.toLowerCase() ?? "";
  return !["currency", "money", "coin"].includes(type);
}

export function isErrandEvent(event: TierEventLike): boolean {
  return ERRAND_EVENT_RE.test(event.name ?? "");
}

/**
 * Soft placement score. Legality still comes from game affordances; this only
 * preserves scarce high-tier cards when a lower-tier card can do the same job.
 */
export function tierMatchScore(opts: {
  card: TierCardLike;
  requiredRare?: number | null;
  errand?: boolean;
}): number {
  if (!isStrategicTierCard(opts.card)) return 0;
  const cardRare = normalizeRare(opts.card.rare);
  if (cardRare == null) return 0;

  const requiredRare = normalizeRare(opts.requiredRare);
  if (requiredRare != null) {
    if (cardRare === requiredRare) return 6;
    if (cardRare > requiredRare) return -3 * (cardRare - requiredRare);
    return -8 * (requiredRare - cardRare);
  }

  if (opts.errand) {
    if (cardRare <= 2) return 4 - cardRare;
    return -3 * (cardRare - 2);
  }
  return cardRare >= 3 ? -1 : 0;
}
