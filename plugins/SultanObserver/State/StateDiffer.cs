using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Structured before/after diff for learning. SceneDiffer covers UI;
    /// this covers cards, rites, events, resources, counters, quest, terminal.
    /// </summary>
    public static class StateDiffer
    {
        public static Dictionary<string, object> Compare(GameState before, GameState after)
        {
            var delta = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase)
            {
                ["changed"] = false
            };
            if (before == null && after == null) return delta;

            var beforeValues = before?.values ?? new Dictionary<string, object>();
            var afterValues = after?.values ?? new Dictionary<string, object>();

            AddScalarPair(delta, "day", AsNullableInt(Get(beforeValues, "day")), AsNullableInt(Get(afterValues, "day")));
            AddScalarPair(
                delta,
                "terminal",
                AsNullableBool(before?.terminal ?? Get(beforeValues, "terminal")),
                AsNullableBool(after?.terminal ?? Get(afterValues, "terminal")));

            AddNumericMapDelta(delta, "resources", AsDict(Get(beforeValues, "resources")), AsDict(Get(afterValues, "resources")));
            AddNumericMapDelta(delta, "counters", AsDict(Get(beforeValues, "counters")), AsDict(Get(afterValues, "counters")));

            AddEntityListDelta(
                delta,
                "cards",
                AsList(Get(beforeValues, "cards")),
                AsList(Get(afterValues, "cards")),
                idKeys: new[] { "uid", "id" },
                trackFields: new[] { "bag", "life", "count", "rare", "type", "name", "inHand" });

            AddEntityListDelta(
                delta,
                "rites",
                AsList(Get(beforeValues, "rites")),
                AsList(Get(afterValues, "rites")),
                idKeys: new[] { "uid", "id" },
                trackFields: new[] { "start", "life", "slotsFilled", "canConfirm", "isShow", "name", "isCurrent" });

            AddEventsDelta(delta, AsList(Get(beforeValues, "events")), AsList(Get(afterValues, "events")));

            var questBefore = NormalizeValue(Get(beforeValues, "questSummary"));
            var questAfter = NormalizeValue(Get(afterValues, "questSummary"));
            if (!Equals(questBefore, questAfter))
            {
                delta["questSummary"] = Pair(questBefore, questAfter);
            }

            var riteBefore = NormalizeValue(Get(beforeValues, "currentRite"));
            var riteAfter = NormalizeValue(Get(afterValues, "currentRite"));
            if (!Equals(riteBefore, riteAfter))
            {
                delta["currentRite"] = Pair(riteBefore, riteAfter);
            }

            AddRiteResultDelta(delta, AsDict(Get(beforeValues, "riteResult")), AsDict(Get(afterValues, "riteResult")));

            delta["changed"] = delta.Keys.Any(k => !string.Equals(k, "changed", StringComparison.OrdinalIgnoreCase));
            return delta;
        }

        private static void AddRiteResultDelta(
            Dictionary<string, object> delta,
            Dictionary<string, object> before,
            Dictionary<string, object> after)
        {
            if (before.Count == 0 && after.Count == 0) return;
            var fields = new[]
            {
                "active",
                "stage",
                "successCount",
                "successThreshold",
                "rewardSummary",
                "tip",
                "result",
                "riteId",
                "riteUid"
            };
            var changed = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var field in fields)
            {
                var b = NormalizeValue(Get(before, field));
                var a = NormalizeValue(Get(after, field));
                if (!Equals(b, a)) changed[field] = Pair(b, a);
            }

            if (changed.Count == 0) return;
            delta["riteResult"] = changed;
        }

        private static void AddEventsDelta(
            Dictionary<string, object> delta,
            List<Dictionary<string, object>> before,
            List<Dictionary<string, object>> after)
        {
            var labelsBefore = before
                .Select(e => StringOf(Get(e, "label")) ?? ("#" + StringOf(Get(e, "index"))))
                .ToList();
            var labelsAfter = after
                .Select(e => StringOf(Get(e, "label")) ?? ("#" + StringOf(Get(e, "index"))))
                .ToList();
            if (labelsBefore.SequenceEqual(labelsAfter) && before.Count == after.Count) return;
            delta["events"] = new Dictionary<string, object>
            {
                ["beforeCount"] = before.Count,
                ["afterCount"] = after.Count,
                ["labelsBefore"] = labelsBefore,
                ["labelsAfter"] = labelsAfter
            };
        }

        private static void AddEntityListDelta(
            Dictionary<string, object> delta,
            string key,
            List<Dictionary<string, object>> before,
            List<Dictionary<string, object>> after,
            string[] idKeys,
            string[] trackFields)
        {
            var beforeMap = IndexBy(before, idKeys);
            var afterMap = IndexBy(after, idKeys);
            var added = new List<Dictionary<string, object>>();
            var removed = new List<Dictionary<string, object>>();
            var changed = new List<Dictionary<string, object>>();

            foreach (var kv in afterMap)
            {
                if (!beforeMap.ContainsKey(kv.Key))
                {
                    added.Add(Identity(kv.Value));
                }
            }

            foreach (var kv in beforeMap)
            {
                if (!afterMap.ContainsKey(kv.Key))
                {
                    removed.Add(Identity(kv.Value));
                    continue;
                }

                var fields = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                foreach (var field in trackFields)
                {
                    var b = NormalizeValue(Get(kv.Value, field));
                    var a = NormalizeValue(Get(afterMap[kv.Key], field));
                    if (!Equals(b, a)) fields[field] = Pair(b, a);
                }

                if (fields.Count > 0)
                {
                    var row = Identity(afterMap[kv.Key]);
                    row["fields"] = fields;
                    changed.Add(row);
                }
            }

            if (added.Count == 0 && removed.Count == 0 && changed.Count == 0) return;
            const int maxListed = 24;
            var payload = new Dictionary<string, object>
            {
                ["addedCount"] = added.Count,
                ["removedCount"] = removed.Count,
                ["changedCount"] = changed.Count,
                ["added"] = added.Take(maxListed).ToList(),
                ["removed"] = removed.Take(maxListed).ToList(),
                ["changed"] = changed.Take(maxListed).ToList()
            };
            if (added.Count > maxListed || removed.Count > maxListed || changed.Count > maxListed)
            {
                payload["truncated"] = true;
            }
            delta[key] = payload;
        }

        private static void AddNumericMapDelta(
            Dictionary<string, object> delta,
            string key,
            Dictionary<string, object> before,
            Dictionary<string, object> after)
        {
            var keys = new HashSet<string>(before.Keys, StringComparer.OrdinalIgnoreCase);
            foreach (var k in after.Keys) keys.Add(k);
            var map = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var k in keys.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                var b = AsNullableDouble(Get(before, k));
                var a = AsNullableDouble(Get(after, k));
                if (Equals(b, a)) continue;
                double? d = null;
                if (b.HasValue && a.HasValue) d = a.Value - b.Value;
                map[k] = new Dictionary<string, object>
                {
                    ["before"] = b,
                    ["after"] = a,
                    ["delta"] = d
                };
            }

            if (map.Count > 0) delta[key] = map;
        }

        private static void AddScalarPair(Dictionary<string, object> delta, string key, object before, object after)
        {
            if (Equals(before, after)) return;
            delta[key] = Pair(before, after);
        }

        private static Dictionary<string, object> Pair(object before, object after)
        {
            return new Dictionary<string, object>
            {
                ["before"] = before,
                ["after"] = after
            };
        }

        private static Dictionary<string, object> Identity(Dictionary<string, object> row)
        {
            return new Dictionary<string, object>
            {
                ["uid"] = Get(row, "uid"),
                ["id"] = Get(row, "id"),
                ["name"] = Get(row, "name") ?? Get(row, "customName")
            };
        }

        private static Dictionary<string, Dictionary<string, object>> IndexBy(
            List<Dictionary<string, object>> rows,
            string[] idKeys)
        {
            var map = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            foreach (var row in rows)
            {
                if (row == null) continue;
                var parts = idKeys.Select(k => StringOf(Get(row, k)) ?? "").ToArray();
                var key = string.Join("|", parts);
                if (string.IsNullOrWhiteSpace(key.Replace("|", ""))) continue;
                map[key] = row;
            }

            return map;
        }

        private static List<Dictionary<string, object>> AsList(object value)
        {
            var list = new List<Dictionary<string, object>>();
            if (value is IEnumerable enumerable && !(value is string))
            {
                foreach (var item in enumerable)
                {
                    if (item is Dictionary<string, object> dict) list.Add(dict);
                }
            }

            return list;
        }

        private static Dictionary<string, object> AsDict(object value)
        {
            if (value is Dictionary<string, object> dict) return dict;
            return new Dictionary<string, object>();
        }

        private static object Get(Dictionary<string, object> dict, string key)
        {
            if (dict == null) return null;
            return dict.TryGetValue(key, out var value) ? value : null;
        }

        private static string StringOf(object value)
        {
            return value?.ToString();
        }

        private static int? AsNullableInt(object value)
        {
            if (value == null) return null;
            if (value is int i) return i;
            if (value is long l) return (int)l;
            if (int.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }

            return null;
        }

        private static bool? AsNullableBool(object value)
        {
            if (value == null) return null;
            if (value is bool b) return b;
            if (bool.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out var parsed)) return parsed;
            return null;
        }

        private static double? AsNullableDouble(object value)
        {
            if (value == null) return null;
            if (value is double d) return d;
            if (value is float f) return f;
            if (value is int i) return i;
            if (value is long l) return l;
            if (double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }

            return null;
        }

        private static object NormalizeValue(object value)
        {
            if (value == null) return null;
            if (value is string || value is bool || value is int || value is long || value is float || value is double)
            {
                return value;
            }

            if (value is IDictionary dict)
            {
                var map = new SortedDictionary<string, object>(StringComparer.Ordinal);
                foreach (DictionaryEntry entry in dict)
                {
                    map[Convert.ToString(entry.Key, CultureInfo.InvariantCulture) ?? ""] = NormalizeValue(entry.Value);
                }

                return string.Join(";", map.Select(kv => kv.Key + "=" + Format(kv.Value)));
            }

            if (value is IEnumerable enumerable && !(value is string))
            {
                var items = new List<string>();
                foreach (var item in enumerable) items.Add(Format(NormalizeValue(item)));
                return string.Join(",", items);
            }

            return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static string Format(object value)
        {
            return value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        }
    }
}
