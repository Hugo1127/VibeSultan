using System;
using System.Collections.Generic;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Builds a stable, compact card dossier for agent-facing state and scene payloads.
    /// </summary>
    public static class CardSummaryProjector
    {
        /// <summary>
        /// Overlay tag values onto an existing summary. Catalog/fallback tags are kept unless
        /// the incoming list provides a non-zero value for the same normalized key.
        /// </summary>
        public static void MergeTags(
            Dictionary<string, object> summary,
            IEnumerable<KeyValuePair<string, int>> tags)
        {
            if (summary == null || tags == null) return;

            var sorted = new SortedDictionary<string, int>(StringComparer.Ordinal);
            if (summary.TryGetValue("tags", out var existing)
                && existing is Dictionary<string, object> current)
            {
                foreach (var pair in current)
                {
                    if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value == null) continue;
                    if (!TryReadInt(pair.Value, out var value) || value == 0) continue;
                    var key = NormalizeTagKey(pair.Key);
                    if (string.IsNullOrWhiteSpace(key)) continue;
                    sorted[key] = value;
                }
            }

            foreach (var pair in tags)
            {
                if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value == 0) continue;
                var key = NormalizeTagKey(pair.Key);
                // SortedDictionary throws on null keys; some runtime tags normalize to empty.
                if (string.IsNullOrWhiteSpace(key)) continue;
                sorted[key] = pair.Value;
            }

            if (sorted.Count == 0)
            {
                summary.Remove("tags");
                return;
            }

            var compact = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var pair in sorted)
            {
                compact[pair.Key] = pair.Value;
            }
            summary["tags"] = compact;
        }

        public static string NormalizeTagKey(string key)
        {
            if (string.IsNullOrWhiteSpace(key)) return key;
            var normalized = SceneText.Normalize(key);
            var mapped = MapAttrToken(normalized);
            return string.IsNullOrWhiteSpace(mapped) ? normalized : mapped;
        }

        private static bool TryReadInt(object value, out int result)
        {
            if (value is int i)
            {
                result = i;
                return true;
            }
            if (value is long l && l >= int.MinValue && l <= int.MaxValue)
            {
                result = (int)l;
                return true;
            }
            return int.TryParse(value?.ToString(), out result);
        }

        private static string MapAttrToken(string token)
        {
            if (string.IsNullOrWhiteSpace(token)) return null;
            var t = token.Trim();
            var lower = t.ToLowerInvariant();
            if (t.Contains("智慧") || t.Contains("智力") || lower.Contains("wisdom")
                || lower.Contains("intellect") || lower.Contains("intelligence")
                || lower.Contains("mind") || lower.Contains("smart"))
            {
                return "智慧";
            }
            if (t.Contains("社交") || lower.Contains("social") || lower.Contains("charisma_social")
                || lower.Contains("sociab"))
            {
                return "社交";
            }
            if (t.Contains("魅力") || lower.Contains("charm") || lower.Contains("appeal")
                || lower == "charisma")
            {
                return "魅力";
            }
            if (t.Contains("体魄") || t.Contains("体力") || lower.Contains("physique")
                || lower.Contains("body") || lower.Contains("vital"))
            {
                return "体魄";
            }
            if (t.Contains("战斗") || t.Contains("武力") || lower.Contains("combat")
                || lower.Contains("fight") || lower.Contains("strength") || lower.Contains("might"))
            {
                return "战斗";
            }
            if (t.Contains("隐匿") || t.Contains("潜行") || lower.Contains("stealth")
                || lower.Contains("hide"))
            {
                return "隐匿";
            }
            if (t.Contains("魔力") || t.Contains("灵视") || lower.Contains("magic")
                || lower.Contains("mystic") || lower.Contains("mana"))
            {
                return "魔力";
            }
            return null;
        }

#if GAME_INTEROP
        public static Dictionary<string, object> Build(Card card)
        {
            if (card == null) return new Dictionary<string, object>();

            var summary = ConfigCatalog.Instance.BuildCardSummary(
                card.id,
                card.custom_name,
                card.Type);
            try
            {
                summary["rare"] = card.Rare;
                summary["tier"] = RiteSlotProjector.FormatTier(card.Rare);
            }
            catch { /* optional */ }
            try { summary["life"] = card.life; } catch { /* optional */ }
            try { summary["count"] = card.count; } catch { /* optional */ }
            summary["cardUid"] = card.uid;

            try
            {
                var runtimeTags = new List<KeyValuePair<string, int>>();
                if (card.tag != null)
                {
                    foreach (var pair in card.tag)
                    {
                        runtimeTags.Add(new KeyValuePair<string, int>(pair.Key, pair.Value));
                    }
                }
                if (runtimeTags.Count > 0)
                {
                    // Overlay only: incomplete/English runtime tags must not wipe catalog attrs.
                    MergeTags(summary, runtimeTags);
                }
            }
            catch
            {
                // Keep catalog tags when IL2CPP dictionary access is unavailable.
            }

            EquipmentProjector.AttachRuntimeEquipFields(summary, card);
            return summary;
        }
#endif
    }
}
