using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;

namespace VibeSultan.Sultan.Observer.State
{
    public static class SceneDiffer
    {
        private const int MaxListedSignatures = 24;

        public static SceneDiff Compare(SceneSnapshot before, SceneSnapshot after)
        {
            var diff = new SceneDiff
            {
                sceneBeforeVersion = before?.snapshotVersion,
                sceneAfterVersion = after?.snapshotVersion,
                result = "no_effect"
            };

            if (before == null || after == null)
            {
                diff.changed = before != after;
                diff.screenChanged = diff.changed;
                diff.result = diff.changed ? "success" : "no_effect";
                diff.changes["snapshot"] = Pair(before == null ? "missing" : "present",
                    after == null ? "missing" : "present");
                return diff;
            }

            AddChange(diff, "scene.id", before.scene?.id, after.scene?.id);
            AddChange(diff, "scene.phase", before.scene?.phase, after.scene?.phase);
            AddChange(diff, "scene.modal", before.scene?.modal, after.scene?.modal);
            AddChange(diff, "instruction.type", before.instruction?.type, after.instruction?.type);
            AddChange(diff, "instruction.text", before.instruction?.text, after.instruction?.text);

            var beforeElements = ElementSignatures(before.elements);
            var afterElements = ElementSignatures(after.elements);
            AddSetChange(diff, "elements", beforeElements, afterElements);

            var beforeAffordances = AffordanceSignatures(before.affordances);
            var afterAffordances = AffordanceSignatures(after.affordances);
            AddSetChange(diff, "affordances", beforeAffordances, afterAffordances);

            foreach (var key in new[]
                     {
                         "day", "handCount", "riteCount", "eventOptionCount",
                         "blockingOverlay", "sudan", "guide", "questSummary",
                         "riteSlots", "currentRite", "dailyNews", "riteResult"
                     })
            {
                object beforeValue = null;
                object afterValue = null;
                before.telemetry?.TryGetValue(key, out beforeValue);
                after.telemetry?.TryGetValue(key, out afterValue);
                AddChange(diff, "telemetry." + key, NormalizeValue(beforeValue), NormalizeValue(afterValue));
            }

            diff.screenChanged =
                !Equals(before.scene?.id, after.scene?.id)
                || !Equals(before.scene?.phase, after.scene?.phase)
                || !Equals(before.scene?.modal, after.scene?.modal);
            diff.changed = diff.changes.Count > 0;
            diff.result = diff.changed ? "success" : "no_effect";
            return diff;
        }

        private static HashSet<string> ElementSignatures(IEnumerable<UiElementInfo> elements)
        {
            return new HashSet<string>(
                (elements ?? Enumerable.Empty<UiElementInfo>())
                .Where(e => e != null && IsDecisionRelevantElement(e))
                .Select(e => string.Join("|",
                    e.elementId,
                    e.role,
                    Truncate(e.text, 80),
                    e.visible,
                    e.interactable,
                    e.selected,
                    e.blocked)),
                StringComparer.Ordinal);
        }

        private static HashSet<string> AffordanceSignatures(IEnumerable<UiAffordanceInfo> affordances)
        {
            return new HashSet<string>(
                (affordances ?? Enumerable.Empty<UiAffordanceInfo>())
                .Where(a => a != null && IsDecisionRelevantAffordance(a))
                .Select(a => string.Join("|", a.action, a.targetId, a.enabled, a.reason, a.mapsToOp)),
                StringComparer.Ordinal);
        }

        /// <summary>
        /// Keep modal/options/cards/map/typed intents; drop chrome noise (status strip, tiers, raw ui:*).
        /// </summary>
        internal static bool IsDecisionRelevantElement(UiElementInfo element)
        {
            if (element == null) return false;
            var id = element.elementId ?? "";
            if (id.StartsWith("semantic:", StringComparison.OrdinalIgnoreCase))
            {
                // Persistent main-chrome statuses create huge diffs when entering play.
                if (id.StartsWith("semantic:main_status_", StringComparison.OrdinalIgnoreCase)
                    || id.StartsWith("semantic:main_card_tier_", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(id, "semantic:main_execution_day", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(id, "semantic:main_achievements", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(id, "semantic:main_story_book", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(id, "semantic:main_draw_cards", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(id, "semantic:main_game_menu", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(id, "semantic:main_sort_cards", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(id, "semantic:main_card_panel", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(id, "semantic:main_history", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
                return true;
            }

            var role = element.role ?? "";
            if (role is "card" or "map_node" or "slot" or "option" or "toggle")
            {
                return true;
            }

            if (!string.IsNullOrEmpty(element.preferredOp)) return true;
            if (!string.IsNullOrEmpty(element.overlayId)) return true;
            return false;
        }

        internal static bool IsDecisionRelevantAffordance(UiAffordanceInfo affordance)
        {
            if (affordance == null) return false;
            if (!string.IsNullOrEmpty(affordance.mapsToOp)) return true;
            var target = affordance.targetId ?? "";
            if (target.StartsWith("semantic:", StringComparison.OrdinalIgnoreCase))
            {
                return IsDecisionRelevantElement(new UiElementInfo { elementId = target, role = "button" });
            }
            return false;
        }

        private static void AddSetChange(
            SceneDiff diff,
            string key,
            HashSet<string> before,
            HashSet<string> after)
        {
            if (before.SetEquals(after)) return;
            var added = after.Except(before).OrderBy(PreferSemanticOrder).ThenBy(v => v).ToList();
            var removed = before.Except(after).OrderBy(PreferSemanticOrder).ThenBy(v => v).ToList();
            var payload = new Dictionary<string, object>
            {
                ["addedCount"] = added.Count,
                ["removedCount"] = removed.Count,
                ["added"] = added.Take(MaxListedSignatures).ToList(),
                ["removed"] = removed.Take(MaxListedSignatures).ToList()
            };
            if (added.Count > MaxListedSignatures || removed.Count > MaxListedSignatures)
            {
                payload["truncated"] = true;
            }
            diff.changes[key] = payload;
        }

        private static int PreferSemanticOrder(string signature)
        {
            if (string.IsNullOrEmpty(signature)) return 2;
            return signature.StartsWith("semantic:", StringComparison.OrdinalIgnoreCase) ? 0 : 1;
        }

        private static void AddChange(SceneDiff diff, string key, object before, object after)
        {
            if (Equals(before, after)) return;
            diff.changes[key] = Pair(before, after);
        }

        private static Dictionary<string, object> Pair(object before, object after)
        {
            return new Dictionary<string, object>
            {
                ["before"] = before,
                ["after"] = after
            };
        }

        private static object NormalizeValue(object value)
        {
            if (value == null) return null;
            return StableValue(value);
        }

        private static string Truncate(string text, int maxLen)
        {
            if (string.IsNullOrEmpty(text) || maxLen <= 0 || text.Length <= maxLen) return text;
            return text.Substring(0, maxLen) + "…";
        }

        private static string StableValue(object value)
        {
            if (value == null) return "null";
            if (value is IDictionary dictionary)
            {
                var entries = new List<string>();
                foreach (DictionaryEntry entry in dictionary)
                {
                    entries.Add((entry.Key?.ToString() ?? "") + ":" + StableValue(entry.Value));
                }
                entries.Sort(StringComparer.Ordinal);
                return "{" + string.Join(",", entries) + "}";
            }
            if (value is IEnumerable sequence && value is not string)
            {
                var items = new List<string>();
                foreach (var item in sequence) items.Add(StableValue(item));
                return "[" + string.Join(",", items) + "]";
            }
            if (value is IConvertible)
            {
                try { return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture); }
                catch { /* use ToString */ }
            }
            return value.ToString();
        }
    }
}
