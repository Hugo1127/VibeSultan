using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Read-only strategy facts for the Agent planner. No strategy advice.
    /// </summary>
    public static class StrategySnapshotProjector
    {
        public static Dictionary<string, object> Build(GameState state)
        {
            var values = state?.values ?? new Dictionary<string, object>();
            var cards = AsList(Get(values, "cards"));
            var rites = AsList(Get(values, "rites"));
            var events = AsList(Get(values, "events"));
            var currentRite = AsDict(Get(values, "currentRite"));
            var sudan = AsDict(Get(values, "sudan"));
            var enabledOps = new List<string>();
            if (state?.actions != null)
            {
                foreach (var action in state.actions)
                {
                    if (action != null && action.enabled && !string.IsNullOrEmpty(action.id))
                    {
                        enabledOps.Add(action.id);
                    }
                }
            }

            var deadlines = new List<Dictionary<string, object>>();
            var day = AsNullableInt(Get(values, "day"));
            var initLife = AsNullableInt(Get(sudan, "initLife"));
            var currentCard = AsDict(Get(sudan, "currentCard"));
            var sudanCardsList = AsList(Get(sudan, "cards"));
            if (sudanCardsList.Count == 0 && currentCard.Count > 0)
            {
                sudanCardsList.Add(currentCard);
            }
            foreach (var card in cards)
            {
                var type = (StringOf(Get(card, "type")) ?? "").ToLowerInvariant();
                if (!(type == "sudan" || type.Contains("sudan"))) continue;
                var uid = AsNullableInt(Get(card, "uid"));
                var already = false;
                foreach (var existing in sudanCardsList)
                {
                    if (uid != null && AsNullableInt(Get(existing, "uid")) == uid)
                    {
                        already = true;
                        break;
                    }
                }
                if (!already) sudanCardsList.Add(card);
            }

            int? executionDaysLeft = null;
            var sudanCardSnapshots = new List<Dictionary<string, object>>();
            if (initLife.HasValue && initLife.Value > 0)
            {
                foreach (var row in sudanCardsList)
                {
                    var life = AsNullableInt(Get(row, "life"));
                    if (!life.HasValue) continue;
                    var rem = Math.Max(0, initLife.Value - Math.Max(0, life.Value));
                    var name = StringOf(Get(row, "name")) ?? "sudan";
                    sudanCardSnapshots.Add(new Dictionary<string, object>
                    {
                        ["uid"] = Get(row, "uid"),
                        ["cardId"] = Get(row, "id") ?? Get(row, "cardId"),
                        ["name"] = name,
                        ["rare"] = Get(row, "rare"),
                        ["life"] = life,
                        ["remaining"] = rem,
                        ["initLife"] = initLife
                    });
                    deadlines.Add(new Dictionary<string, object>
                    {
                        ["kind"] = "sudan_card",
                        ["label"] = name + " (" + rem + "/" + initLife.Value + ")",
                        ["remaining"] = rem,
                        ["critical"] = rem <= 2
                    });
                    if (executionDaysLeft == null || rem < executionDaysLeft.Value)
                    {
                        executionDaysLeft = rem;
                    }
                }
            }
            if (!executionDaysLeft.HasValue)
            {
                var cardLife = AsNullableInt(Get(currentCard, "life"));
                if (initLife.HasValue && initLife.Value > 0 && cardLife.HasValue)
                {
                    executionDaysLeft = Math.Max(0, initLife.Value - Math.Max(0, cardLife.Value));
                }
                else
                {
                    executionDaysLeft =
                        AsNullableInt(Get(sudan, "remaining"))
                        ?? AsNullableInt(Get(sudan, "executionDaysLeft"));
                    if (!executionDaysLeft.HasValue && initLife.HasValue && initLife.Value > 0 && day.HasValue)
                    {
                        executionDaysLeft = Math.Max(0, initLife.Value - Math.Max(1, day.Value) + 1);
                    }
                }
                if (executionDaysLeft.HasValue && sudanCardSnapshots.Count == 0)
                {
                    deadlines.Add(new Dictionary<string, object>
                    {
                        ["kind"] = "sudan_card",
                        ["label"] = "Current Sultan card execution window",
                        ["remaining"] = executionDaysLeft,
                        ["critical"] = executionDaysLeft <= 2
                    });
                }
            }

            foreach (var rite in rites)
            {
                var life = AsNullableInt(Get(rite, "life"));
                if (!life.HasValue) continue;
                deadlines.Add(new Dictionary<string, object>
                {
                    ["kind"] = "rite_life",
                    ["label"] = StringOf(Get(rite, "name")) ?? ("rite:" + StringOf(Get(rite, "uid"))),
                    ["remaining"] = life,
                    ["critical"] = life <= 1
                });
            }

            var unknowns = new List<string>();
            if (Get(values, "resources") == null) unknowns.Add("resources_unprojected");
            if (events.Count == 0 && AsNullableInt(Get(values, "eventOptionCount")).GetValueOrDefault() > 0)
            {
                unknowns.Add("event_labels_incomplete");
            }

            return new Dictionary<string, object>
            {
                ["schemaVersion"] = 1,
                ["capturedAt"] = state?.capturedAt ?? DateTimeOffset.Now.ToString("o"),
                ["version"] = new Dictionary<string, object>
                {
                    ["gameFingerprint"] = StringOf(Get(values, "fingerprint")) ?? "",
                    ["configFingerprint"] = StringOf(Get(values, "fingerprint")) ?? ""
                },
                ["day"] = day,
                ["turn"] = AsNullableInt(Get(values, "turn")),
                ["phase"] = state?.screen?.phase,
                ["terminal"] = state?.terminal == true || Equals(Get(values, "terminal"), true),
                ["executionDaysLeft"] = executionDaysLeft,
                ["sudanCards"] = sudanCardSnapshots,
                ["resources"] = AsDict(Get(values, "resources")),
                ["counters"] = AsDict(Get(values, "counters")),
                ["cards"] = ProjectCards(cards),
                ["events"] = ProjectRitesAsEvents(rites),
                ["currentEvent"] = currentRite.Count > 0 ? ProjectCurrentEvent(currentRite) : null,
                ["storyOptions"] = events,
                ["deadlines"] = deadlines,
                ["enabledOps"] = enabledOps,
                ["unknowns"] = unknowns
            };
        }

        private static List<Dictionary<string, object>> ProjectCards(List<Dictionary<string, object>> cards)
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var card in cards)
            {
                if (card == null) continue;
                list.Add(new Dictionary<string, object>
                {
                    ["cardId"] = Get(card, "id"),
                    ["uid"] = Get(card, "uid"),
                    ["type"] = Get(card, "type"),
                    ["rare"] = Get(card, "rare"),
                    ["name"] = Get(card, "name") ?? Get(card, "customName"),
                    ["life"] = Get(card, "life"),
                    ["count"] = Get(card, "count"),
                    ["inHand"] = Get(card, "inHand")
                });
            }

            return list;
        }

        private static List<Dictionary<string, object>> ProjectRitesAsEvents(List<Dictionary<string, object>> rites)
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var rite in rites)
            {
                if (rite == null) continue;
                list.Add(new Dictionary<string, object>
                {
                    ["riteId"] = Get(rite, "id"),
                    ["riteUid"] = Get(rite, "uid"),
                    ["name"] = Get(rite, "name"),
                    ["life"] = Get(rite, "life"),
                    ["started"] = Get(rite, "start") ?? Get(rite, "started"),
                    ["slotsFilled"] = Get(rite, "slotsFilled"),
                    ["canConfirm"] = Get(rite, "canConfirm"),
                    ["remainingAppearTurns"] = Get(rite, "life"),
                    ["slots"] = Get(rite, "slots")
                });
            }

            return list;
        }

        private static Dictionary<string, object> ProjectCurrentEvent(Dictionary<string, object> current)
        {
            return new Dictionary<string, object>
            {
                ["riteId"] = Get(current, "id"),
                ["riteUid"] = Get(current, "uid"),
                ["name"] = Get(current, "name"),
                ["started"] = Get(current, "started"),
                ["canConfirm"] = Get(current, "canConfirm"),
                ["slots"] = Get(current, "slots"),
                ["slotCount"] = Get(current, "slotCount")
            };
        }

        private static List<Dictionary<string, object>> AsList(object value)
        {
            var list = new List<Dictionary<string, object>>();
            if (value is List<Dictionary<string, object>> typed) return typed;
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
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        private static object Get(Dictionary<string, object> dict, string key)
        {
            if (dict == null) return null;
            return dict.TryGetValue(key, out var value) ? value : null;
        }

        private static string StringOf(object value) => value?.ToString();

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
    }
}
