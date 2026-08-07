using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace VibeSultan.Sultan.Observer.State
{
    public sealed class StateReader
    {
        private Dictionary<string, object> _lastProbe;

        public GameState Read()
        {
            var state = GameState.CreateEmpty();
            state.unity.version = Application.unityVersion;
            state.unity.frame = Time.frameCount;
            state.unity.productName = Application.productName;

            var scene = SceneManager.GetActiveScene();
            state.screen.name = scene.name ?? "Unknown";
            state.screen.id = StateProjector.NormalizeScreenId(state.screen.name);

            var catalog = ConfigCatalog.Instance.GetSummary();
            state.values["fingerprint"] = catalog.TryGetValue("fingerprint", out var fp) ? fp : null;
            state.values["config"] = new Dictionary<string, object>
            {
                ["riteCount"] = catalog.TryGetValue("riteCount", out var rc) ? rc : 0,
                ["eventCount"] = catalog.TryGetValue("eventCount", out var ec) ? ec : 0,
                ["cardsKeyCount"] = catalog.TryGetValue("cardsKeyCount", out var ck) ? ck : null
            };

            var projection = StateProjector.ProjectRuntime(state.screen.id, state.screen.name);
            ApplyProjection(state, projection);

            // TypeProbe is diagnostic-only; do not run on the hot capture path.
            // Trigger explicitly via the probe_types action.
            _lastProbe = TypeProbe.LastReport ?? _lastProbe;
            if (_lastProbe != null)
            {
                state.raw["typeProbe"] = _lastProbe;
            }
            state.raw["configCatalog"] = catalog;
            state.raw["bindings"] = projection.diagnostics;
            state.raw["hasInterop"] = GameBindings.HasInterop;

            return state;
        }

        private static void ApplyProjection(GameState state, StateProjector.Projection p)
        {
            state.screen.phase = p.phaseHint ?? "unknown";
            if (state.screen.phase == "boot")
            {
                state.screen.id = "startscene";
            }

            if (p.day.HasValue)
            {
                state.values["day"] = p.day.Value;
                state.values["turn"] = p.day.Value;
            }

            state.values["handCount"] = p.handCount;
            state.values["bag0Count"] = p.bag0Count;
            state.values["inventoryCount"] = p.inventoryCount;
            state.values["riteCount"] = p.riteCount;
            state.values["eventOptionCount"] = p.eventOptionCount;
            state.values["initDone"] = p.initDone;
            state.values["inGame"] = p.inGame;
            state.values["hasGameController"] = p.hasGameController;
            // Default cards = UI-visible hand only. Full inventory is optional via views=cards_all.
            state.values["cards"] = p.cards;
            state.values["cardsAll"] = p.cardsAll;
            state.values["rites"] = p.rites;
            if (p.currentRite != null)
            {
                state.values["currentRite"] = p.currentRite;
            }
            if (p.currentEvent != null)
            {
                state.values["currentEvent"] = p.currentEvent;
            }
            state.values["events"] = p.events;
            state.values["overlays"] = p.overlays;
            state.values["blockingOverlay"] = p.blockingOverlay;
            state.values["counters"] = p.counters;
            state.values["resources"] = p.resources;
            state.values["sudan"] = p.sudan;
            state.values["guide"] = p.guide;
            state.values["dailyNews"] = p.dailyNews;
            state.values["riteResult"] = p.riteResult;
            state.values["questSummary"] = p.questSummary;
            state.values["terminal"] = p.terminal;
            if (p.guide != null && p.guide.TryGetValue("hint", out var guideHint) && guideHint != null)
            {
                state.values["stepHint"] = guideHint;
            }

            state.actions = p.actions ?? new List<ActionInfo>();
            state.terminal = p.terminal || string.Equals(p.phaseHint, "terminal", StringComparison.OrdinalIgnoreCase);
        }
    }
}
