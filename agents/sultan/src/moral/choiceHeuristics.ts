export interface ChoiceOptionLike {
  index: number;
  label?: string | null;
  tag?: string | null;
}

export interface ChoiceHeuristicResult {
  optionIndex: number;
  label: string;
  score: number;
  reason: string;
}

/** Persisted on choice event facts for stable altruism scoring. */
export interface OptionAltruismScore {
  index: number;
  altruismScore: number;
  reason?: string;
}

export const OPTION_ALTRUISM_FACTS_KEY = "optionAltruismScores";
export const OPTION_ALTRUISM_SOURCE_KEY = "optionAltruismSource";

const ALTRUISM_RE =
  /收留|救助|帮助|结交|保护|救|收养|赠|施舍|同情|庇护|支持|结盟|宽恕|放过|放走|收留她|收留他|给金币|出钱|买下|带回|安顿|庇护她|庇护他|留下她|留下他|资助|庇护者/;
const EXPLOIT_RE =
  /拒绝|杀害|杀掉|献上|取悦|献给苏丹|交给苏丹|羞辱|奴役|卖掉|驱逐|无视|走开|不管|告发|陷害|凌辱|纵欲/;
const PERSON_CUE_RE =
  /她|他|女孩|男孩|乞丐|孩子|儿童|追随者|奴隶|贵族|妻子|丈夫|友人|朋友|清流|书吏|学者|难民|路人/;

function optionText(option: ChoiceOptionLike): string {
  return [option.label, option.tag].filter(Boolean).join(" ");
}

export function scoreChoiceOptionLabel(option: ChoiceOptionLike): number {
  const text = optionText(option);
  if (!text) return 0;
  let score = 0;
  if (ALTRUISM_RE.test(text)) score += 2;
  if (EXPLOIT_RE.test(text)) score -= 2;
  return score;
}

export function hasPersonCue(label: string | null | undefined): boolean {
  if (!label?.trim()) return false;
  return PERSON_CUE_RE.test(label);
}

export function isAltruisticChoiceLabel(label: string | null | undefined): boolean {
  if (!label?.trim()) return false;
  return ALTRUISM_RE.test(label) && !EXPLOIT_RE.test(label);
}

export function readCachedAltruismScores(
  facts: Record<string, unknown> | null | undefined,
): OptionAltruismScore[] | null {
  if (!facts) return null;
  const raw = facts[OPTION_ALTRUISM_FACTS_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: OptionAltruismScore[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const index = typeof row.index === "number" ? row.index : null;
    const altruismScore =
      typeof row.altruismScore === "number" ? row.altruismScore : null;
    if (index == null || altruismScore == null) continue;
    out.push({
      index,
      altruismScore,
      reason: typeof row.reason === "string" ? row.reason : undefined,
    });
  }
  return out.length ? out : null;
}

export function cachedScoreForOption(
  option: ChoiceOptionLike,
  cached: OptionAltruismScore[] | null | undefined,
): number | null {
  if (!cached?.length) return null;
  const hit = cached.find((row) => row.index === option.index);
  return hit ? hit.altruismScore : null;
}

/**
 * Resolve whether an option is altruistic / ally-building.
 * Order: cache → keyword label.
 */
export function isAltruisticOption(
  option: ChoiceOptionLike,
  cached?: OptionAltruismScore[] | null,
): boolean {
  const cachedScore = cachedScoreForOption(option, cached);
  if (cachedScore != null) return cachedScore > 0;
  return isAltruisticChoiceLabel(option.label);
}

/**
 * Whether a choice with immediate negative effect should open pending_strategic.
 * Uses altruism resolution, then person-cue fallback when keywords/cache miss.
 */
export function shouldDeferChoiceAsStrategic(
  option: ChoiceOptionLike,
  opts?: {
    cached?: OptionAltruismScore[] | null;
    immediateNegative?: boolean;
  },
): boolean {
  if (isAltruisticOption(option, opts?.cached)) return true;
  if (opts?.immediateNegative && hasPersonCue(option.label)) return true;
  return false;
}

/**
 * Prefer altruistic / ally-building options over exploit / flatter-Sultan ones.
 */
export function recommendChoiceOption(
  options: ChoiceOptionLike[],
  cached?: OptionAltruismScore[] | null,
): ChoiceHeuristicResult | null {
  if (!options.length) return null;
  let best: ChoiceHeuristicResult | null = null;
  for (const option of options) {
    const cachedScore = cachedScoreForOption(option, cached);
    const score = cachedScore ?? scoreChoiceOptionLabel(option);
    const label = option.label?.trim() || `option ${option.index}`;
    const candidate: ChoiceHeuristicResult = {
      optionIndex: option.index,
      label,
      score,
      reason:
        score > 0
          ? cachedScore != null
            ? "cached_altruism_or_ally_building"
            : "altruism_or_ally_building"
          : score < 0
            ? cachedScore != null
              ? "cached_exploit_or_flatter"
              : "exploit_or_flatter"
            : "neutral",
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best || best.score <= 0) return null;
  return best;
}

export function formatChoiceRecommendation(
  options: ChoiceOptionLike[],
  cached?: OptionAltruismScore[] | null,
): string | null {
  const rec = recommendChoiceOption(options, cached);
  if (!rec) return null;
  return `socialCapitalChoice: prefer optionIndex=${rec.optionIndex} "${rec.label}" (${rec.reason}, score=${rec.score})`;
}

/** True when every option is keyword-neutral (no altruism/exploit hit). */
export function keywordsAreInconclusive(options: ChoiceOptionLike[]): boolean {
  if (!options.length) return true;
  return options.every((option) => scoreChoiceOptionLabel(option) === 0);
}
