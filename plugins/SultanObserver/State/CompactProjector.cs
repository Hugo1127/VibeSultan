using System;
using System.Collections.Generic;
using System.Linq;

namespace VibeSultan.Sultan.Observer.State
{
    public static class CompactProjector
    {
        public static HashSet<string> ParseViews(string query)
        {
            var views = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(query))
            {
                return views;
            }

            var q = query.TrimStart('?');
            foreach (var part in q.Split('&'))
            {
                var kv = part.Split(new[] { '=' }, 2);
                if (kv.Length != 2 || !kv[0].Equals("views", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                foreach (var view in Uri.UnescapeDataString(kv[1]).Split(','))
                {
                    var trimmed = view.Trim();
                    if (trimmed.Length > 0)
                    {
                        views.Add(trimmed);
                    }
                }
            }

            return views;
        }

        public static object Project(GameState state, HashSet<string> views)
        {
            if (state == null)
            {
                state = GameState.CreateEmpty();
            }

            var wantFull = views != null && views.Contains("full");
            if (wantFull || views == null || views.Count == 0)
            {
                if (wantFull)
                {
                    return state;
                }

                return ProjectSummary(state);
            }

            var bag = new Dictionary<string, object>
            {
                ["schemaVersion"] = state.schemaVersion,
                ["game"] = state.game,
                ["capturedAt"] = state.capturedAt,
                ["unity"] = state.unity,
                ["screen"] = state.screen,
                ["terminal"] = state.terminal,
                ["view"] = string.Join(",", views.OrderBy(v => v))
            };

            if (views.Contains("summary") || views.Contains("values"))
            {
                bag["values"] = FilterValues(state.values, summaryOnly: !views.Contains("values") || views.Contains("summary"));
            }

            if (views.Contains("actions"))
            {
                bag["actions"] = state.actions;
            }

            if (views.Contains("cards") && state.values != null && state.values.TryGetValue("cards", out var cards))
            {
                // Visible hand only.
                bag["cards"] = cards;
            }

            if ((views.Contains("cards_all") || views.Contains("inventory"))
                && state.values != null
                && state.values.TryGetValue("cardsAll", out var cardsAll))
            {
                bag["cardsAll"] = cardsAll;
            }

            if (views.Contains("rites") && state.values != null && state.values.TryGetValue("rites", out var rites))
            {
                bag["rites"] = rites;
            }

            if (views.Contains("events") && state.values != null && state.values.TryGetValue("events", out var events))
            {
                bag["events"] = events;
            }

            if (views.Contains("overlays") && state.values != null && state.values.TryGetValue("overlays", out var overlays))
            {
                bag["overlays"] = overlays;
            }

            if (views.Contains("quests") && state.values != null && state.values.TryGetValue("quests", out var quests))
            {
                bag["quests"] = quests;
            }

            if (views.Contains("strategySnapshot") || views.Contains("strategy"))
            {
                bag["strategySnapshot"] = StrategySnapshotProjector.Build(state);
            }

            if (views.Contains("diagnostics") || views.Contains("raw"))
            {
                bag["raw"] = state.raw;
            }

            if (!bag.ContainsKey("actions") && state.actions != null)
            {
                bag["actions"] = state.actions;
            }

            if (!bag.ContainsKey("values"))
            {
                bag["values"] = FilterValues(state.values, summaryOnly: true);
            }

            return bag;
        }

        private static Dictionary<string, object> ProjectSummary(GameState state)
        {
            return new Dictionary<string, object>
            {
                ["schemaVersion"] = state.schemaVersion,
                ["game"] = state.game,
                ["capturedAt"] = state.capturedAt,
                ["unity"] = state.unity,
                ["screen"] = state.screen,
                ["terminal"] = state.terminal,
                ["values"] = FilterValues(state.values, summaryOnly: true),
                ["actions"] = state.actions,
                ["view"] = "summary"
            };
        }

        private static Dictionary<string, object> FilterValues(Dictionary<string, object> values, bool summaryOnly)
        {
            if (values == null)
            {
                return new Dictionary<string, object>();
            }

            if (!summaryOnly)
            {
                return values;
            }

            var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "day", "turn", "resources", "counters", "sudan", "questSummary",
                "guide", "stepHint", "currentRite", "currentEvent", "dailyNews", "riteResult",
                "handCount", "bag0Count", "inventoryCount", "riteCount",
                "eventOptionCount", "fingerprint",
                "initDone", "inGame", "hasGameController", "terminal",
                "overlays", "blockingOverlay"
            };

            var filtered = new Dictionary<string, object>();
            foreach (var kv in values)
            {
                if (keep.Contains(kv.Key))
                {
                    filtered[kv.Key] = kv.Value;
                }
            }

            return filtered;
        }
    }
}
