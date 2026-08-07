using System;
using System.Text.RegularExpressions;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Helpers for stackable cards (金币 etc.). Game UI supports long-press split via
    /// CardController.CardSplit(count); agents must place only the slot cost, not the whole stack.
    /// </summary>
    public static class StackPlaceHelper
    {
        private static readonly Regex CostExact = new Regex(
            @"cost\.([^""=:\[\]]+)\s*""?\s*[:=]\s*(\d+)",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private static readonly Regex CostRange = new Regex(
            @"cost\.([^""=:\[\]]+)\s*""?\s*[:=]\s*\[\s*(\d+)",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private static readonly Regex TextGoldCost = new Regex(
            @"(?:置入|需要|花费|消耗|作为入场费)?\s*(\d+)\s*金币",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>
        /// Parse the minimum stack cost from a slot condition / text.
        /// Prefers a cost tag matching <paramref name="preferredCostTag"/> (e.g. "金币").
        /// </summary>
        public static int? ParseCostMin(
            string condition,
            string slotText = null,
            string preferredCostTag = null)
        {
            var fromCondition = ParseCostMinFromCondition(condition, preferredCostTag);
            if (fromCondition.HasValue) return fromCondition;

            if (string.IsNullOrEmpty(slotText)) return null;
            var m = TextGoldCost.Match(slotText);
            if (m.Success
                && int.TryParse(m.Groups[1].Value, out var n)
                && n > 0
                && (string.IsNullOrEmpty(preferredCostTag)
                    || preferredCostTag.IndexOf("金币", StringComparison.Ordinal) >= 0
                    || preferredCostTag.IndexOf("gold", StringComparison.OrdinalIgnoreCase) >= 0
                    || preferredCostTag.IndexOf("coin", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                return n;
            }
            return null;
        }

        public static int? ParseCostMinFromCondition(string condition, string preferredCostTag = null)
        {
            if (string.IsNullOrEmpty(condition)) return null;

            int? preferred = null;
            int? any = null;

            foreach (Match m in CostRange.Matches(condition))
            {
                if (!TryReadCost(m, out var tag, out var min)) continue;
                any ??= min;
                if (TagMatches(tag, preferredCostTag)) preferred = min;
            }

            foreach (Match m in CostExact.Matches(condition))
            {
                if (!TryReadCost(m, out var tag, out var min)) continue;
                any ??= min;
                if (TagMatches(tag, preferredCostTag)) preferred = min;
            }

            return preferred ?? any;
        }

        /// <summary>
        /// Decide how many units to place from a stack.
        /// Explicit action count wins; otherwise use slot cost min; otherwise null (place whole stack).
        /// </summary>
        public static int? ResolvePlaceCount(
            int? requestedCount,
            int stackCount,
            int? costMin)
        {
            if (stackCount <= 1) return null;

            if (requestedCount.HasValue)
            {
                if (requestedCount.Value <= 0) return null;
                return Math.Min(requestedCount.Value, stackCount);
            }

            if (costMin.HasValue && costMin.Value > 0 && costMin.Value < stackCount)
            {
                return costMin.Value;
            }

            return null;
        }

        public static string PreferredCostTag(string cardName, string cardType = null)
        {
            if (!string.IsNullOrEmpty(cardName))
            {
                if (cardName.IndexOf("金币", StringComparison.Ordinal) >= 0) return "金币";
                if (cardName.IndexOf("金骰", StringComparison.Ordinal) >= 0) return "金骰";
            }
            if (!string.IsNullOrEmpty(cardType)
                && (cardType.IndexOf("gold", StringComparison.OrdinalIgnoreCase) >= 0
                    || cardType.IndexOf("coin", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                return "金币";
            }
            return null;
        }

        private static bool TryReadCost(Match m, out string tag, out int min)
        {
            tag = m.Groups[1].Value?.Trim().TrimEnd('=');
            min = 0;
            return !string.IsNullOrEmpty(tag)
                && int.TryParse(m.Groups[2].Value, out min)
                && min > 0;
        }

        private static bool TagMatches(string tag, string preferred)
        {
            if (string.IsNullOrEmpty(preferred) || string.IsNullOrEmpty(tag)) return false;
            return tag.IndexOf(preferred, StringComparison.OrdinalIgnoreCase) >= 0
                || preferred.IndexOf(tag, StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }
}
