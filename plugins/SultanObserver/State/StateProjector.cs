using System;
using System.Collections.Generic;
using System.Text;
#if GAME_INTEROP
using TMPro;
using UnityEngine;
using UnityEngine.UI;
#endif

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Projects game runtime objects into JSON-safe dictionaries.
    /// </summary>
    public static class StateProjector
    {
        public sealed class Projection
        {
            public int? day;
            public int handCount;
            public int inventoryCount;
            public int bag0Count;
            public int riteCount;
            public int eventOptionCount;
            public bool terminal;
            public bool inGame;
            public bool initDone;
            public bool hasGameController;
            public string phaseHint;
            /// <summary>UI-visible hand cards only (CardController under hand).</summary>
            public List<Dictionary<string, object>> cards = new List<Dictionary<string, object>>();
            /// <summary>Full/capped inventory for optional views=cards_all.</summary>
            public List<Dictionary<string, object>> cardsAll = new List<Dictionary<string, object>>();
            public List<Dictionary<string, object>> rites = new List<Dictionary<string, object>>();
            public List<Dictionary<string, object>> events = new List<Dictionary<string, object>>();
            public List<Dictionary<string, object>> overlays = new List<Dictionary<string, object>>();
            public bool blockingOverlay;
            public Dictionary<string, object> counters = new Dictionary<string, object>();
            public Dictionary<string, object> resources = new Dictionary<string, object>();
            public Dictionary<string, object> sudan = new Dictionary<string, object>();
            public Dictionary<string, object> questSummary = new Dictionary<string, object>();
            public Dictionary<string, object> guide = new Dictionary<string, object>();
            public Dictionary<string, object> dailyNews = new Dictionary<string, object>();
            public Dictionary<string, object> riteResult = new Dictionary<string, object>();
            public Dictionary<string, object> currentRite;
            public Dictionary<string, object> currentEvent;
            public List<ActionInfo> actions = new List<ActionInfo>();
            public Dictionary<string, object> diagnostics = new Dictionary<string, object>();
        }

        public static string BuildDerivedChoiceIdentity(
            string prompt,
            IEnumerable<string> labels)
        {
            var builder = new StringBuilder();
            builder.Append(NormalizeIdentityText(prompt));
            if (labels != null)
            {
                foreach (var label in labels)
                {
                    builder.Append('|').Append(NormalizeIdentityText(label));
                }
            }

            // FNV-1a 64-bit is deterministic across runtimes and sufficient for an identity seed.
            ulong hash = 14695981039346656037UL;
            foreach (var ch in builder.ToString())
            {
                hash ^= ch;
                hash *= 1099511628211UL;
            }
            return hash.ToString("x16");
        }

        private static string NormalizeIdentityText(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return string.Empty;
            var output = new StringBuilder();
            bool pendingSpace = false;
            foreach (var ch in value.Trim().ToLowerInvariant())
            {
                if (char.IsWhiteSpace(ch))
                {
                    pendingSpace = output.Length > 0;
                    continue;
                }
                if (pendingSpace)
                {
                    output.Append(' ');
                    pendingSpace = false;
                }
                output.Append(ch);
            }
            return output.ToString();
        }

        private static Dictionary<string, object> BuildChoiceEventProjection(
            string prompt,
            List<Dictionary<string, object>> options)
        {
            var labels = new List<string>();
            foreach (var option in options)
            {
                if (option != null && option.TryGetValue("label", out var raw) && raw != null)
                {
                    labels.Add(raw.ToString());
                }
            }
            return new Dictionary<string, object>
            {
                ["kind"] = "choice",
                ["prompt"] = prompt,
                ["options"] = options,
                ["identitySeed"] = BuildDerivedChoiceIdentity(prompt, labels),
                ["identityQuality"] = "derived"
            };
        }

        public static Projection ProjectRuntime(string sceneId, string sceneName)
        {
            var p = new Projection
            {
                phaseHint = InferPhase(sceneId, sceneName),
                diagnostics = GameBindings.SnapshotBindings()
            };

#if !GAME_INTEROP
            p.actions.Add(new ActionInfo { id = "noop", label = "No-op", enabled = true });
            p.actions.Add(new ActionInfo { id = "probe_types", label = "Refresh type probe", enabled = true });
            return p;
#else
            p.initDone = GameBindings.InitDone;
            p.inGame = GameBindings.InGame;
            p.hasGameController = GameBindings.Controller != null;
            p.diagnostics["sceneId"] = sceneId;
            p.diagnostics["sceneName"] = sceneName;

            var player = GameBindings.Player;
            var controller = GameBindings.Controller;
            var option = GameBindings.OptionPanel;
            var ritePanel = GameBindings.RitePanel;
            var overlays = OverlayScanner.Scan();
            bool uiBlocking = OverlayScanner.HasBlocking(overlays);

            if (player != null)
            {
                p.day = player.round;
                // Only treat as terminal after init, and never while a blocking overlay is up.
                // over_reason uses int.MinValue as unset sentinel — never treat it as game over.
                bool settled = GameBindings.InitDone || GameBindings.IsUiActive(controller);
                p.terminal = !uiBlocking
                             && settled
                             && SceneInteractionPolicy.IsTerminal(
                                 player.success,
                                 controller != null && controller.game_over,
                                 GameBindings.InGame);
                var redrawTimes = player.sudan_redraw_times;
                var redrawPerRound = player.sudan_redraw_times_per_round;
                p.sudan["redrawTimes"] = redrawTimes;
                p.sudan["redrawPerRound"] = redrawPerRound;
                p.sudan["redrawRemaining"] = SudanCardActionPolicy.ComputeRedrawRemaining(
                    redrawTimes, redrawPerRound);
                p.sudan["removeCount"] = player.sudan_remove_count;
                p.sudan["initLife"] = player.sudan_card_init_life;
                p.sudan["boxShow"] = player.sudan_box_show;
                p.sudan["boxReady"] = GameBindings.IsSudanBoxReady;
                p.sudan["boxPresent"] = GameBindings.IsSudanBoxPresent;
                p.sudan["boxTips"] = GameBindings.ReadSudanBoxTips();
                var allSudan = GameBindings.ReadAllSudanCardSummaries();
                p.sudan["cards"] = allSudan;
                p.sudan["currentCard"] = GameBindings.ReadCurrentSudanCardSummary();
                var round = player.round;
                var initLife = player.sudan_card_init_life;
                // Min remaining across all held Sudan cards (multi-card pressure).
                int? minRemaining = null;
                foreach (var row in allSudan)
                {
                    if (row == null) continue;
                    if (!row.TryGetValue("life", out var lifeObj) || !(lifeObj is int lifeInt))
                    {
                        continue;
                    }
                    var rem = SceneInteractionPolicy.ComputeExecutionDaysLeft(
                        initLife, lifeInt, round);
                    row["remaining"] = rem;
                    if (minRemaining == null || rem < minRemaining.Value)
                    {
                        minRemaining = rem;
                    }
                }
                int? cardLife = null;
                try
                {
                    if (p.sudan["currentCard"] is Dictionary<string, object> cc
                        && cc.TryGetValue("life", out var lifeObj)
                        && lifeObj is int lifeInt)
                    {
                        cardLife = lifeInt;
                    }
                }
                catch
                {
                    // optional
                }
                var remaining = minRemaining
                    ?? SceneInteractionPolicy.ComputeExecutionDaysLeft(
                        initLife, cardLife, round);
                p.sudan["remaining"] = remaining;
                p.sudan["executionDaysLeft"] = remaining;
                p.questSummary["notes"] = player.notes?.Count ?? 0;
                p.questSummary["success"] = player.success;
                p.questSummary["overReason"] = player.over_reason;

                ProjectCards(player, controller, p);
                ProjectRites(player, ritePanel, p);
                ProjectCounters(player, p);
                ProjectResources(player, p);
            }

            if (controller != null && controller.CurrentRoundNumber > 0 && p.day == null)
            {
                p.day = controller.CurrentRoundNumber;
            }

            ProjectOverlays(p, overlays);
            p.guide = GameBindings.ReadBeginGuideSnapshot();
            p.dailyNews = GameBindings.ReadDailyNewsSnapshot();
            p.riteResult = GameBindings.ReadRiteResultSnapshot();

            if (GameBindings.IsUiActive(option))
            {
                ProjectOptionEvents(option, p);
            }

            p.phaseHint = RefinePhase(p, sceneId, overlays, ritePanel, controller);
            p.actions = BuildActions(p, overlays, option, ritePanel, controller);
            return p;
#endif
        }

#if GAME_INTEROP
        private static void ProjectCards(Player player, GameController controller, Projection p)
        {
            if (player.cards == null) return;

            var visibleUids = new HashSet<int>();
            try
            {
                var handRoot = controller != null ? controller.hand : null;
                var widgets = handRoot != null
                    ? handRoot.GetComponentsInChildren<CardController>(true)
                    : null;
                if (widgets != null)
                {
                    for (var i = 0; i < widgets.Length && p.cards.Count < 48; i++)
                    {
                        var widget = widgets[i];
                        if (widget == null || widget.gameObject == null || !widget.gameObject.activeInHierarchy)
                        {
                            continue;
                        }

                        var card = widget.card;
                        if (card == null || !visibleUids.Add(card.uid)) continue;
                        p.cards.Add(ToCardRow(card, inHand: true, visible: true));
                    }
                }
            }
            catch (Exception ex)
            {
                p.diagnostics["visibleHandError"] = ex.Message;
            }

            var bag0 = 0;
            var inventory = 0;
            for (var i = 0; i < player.cards.Count; i++)
            {
                var card = player.cards[i];
                if (card == null) continue;
                inventory++;
                var inBag0 = card.bag == 0;
                if (inBag0) bag0++;

                // Optional full inventory (capped): bag0 first, then other bags.
                if (inBag0 || p.cardsAll.Count < 96)
                {
                    try
                    {
                        p.cardsAll.Add(ToCardRow(card, inHand: inBag0, visible: visibleUids.Contains(card.uid)));
                    }
                    catch (Exception ex)
                    {
                        p.diagnostics["cardRowError"] = ex.GetType().Name + ": " + ex.Message;
                    }
                }
            }

            // Fallback: if UI widgets are unavailable, expose a small bag0 sample so agents
            // are not completely blind — still far smaller than dumping the whole inventory.
            if (p.cards.Count == 0 && bag0 > 0)
            {
                for (var i = 0; i < player.cards.Count && p.cards.Count < 24; i++)
                {
                    var card = player.cards[i];
                    if (card == null || card.bag != 0) continue;
                    p.cards.Add(ToCardRow(card, inHand: true, visible: false));
                }
                p.diagnostics["visibleHandFallback"] = "bag0_sample";
            }

            p.handCount = p.cards.Count;
            p.bag0Count = bag0;
            p.inventoryCount = inventory;
            p.diagnostics["bagIndex"] = player.BagIndex;
            p.diagnostics["totalCards"] = inventory;
            p.diagnostics["visibleHandCount"] = p.cards.Count;
            p.diagnostics["bag0Count"] = bag0;
        }

        private static Dictionary<string, object> ToCardRow(Card card, bool inHand, bool visible)
        {
            var row = new Dictionary<string, object>
            {
                ["inHand"] = inHand,
                ["visible"] = visible
            };
            try { row["uid"] = card.uid; } catch { /* optional */ }
            try { row["id"] = card.id; } catch { /* optional */ }
            try { row["bag"] = card.bag; } catch { /* optional */ }
            try { row["bagpos"] = card.bagpos; } catch { /* optional */ }
            try { row["life"] = card.life; } catch { /* optional */ }
            try { row["count"] = card.count; } catch { /* optional */ }
            try { row["rare"] = card.Rare; } catch { /* optional — some proxies NRE on Rare */ }
            try { row["type"] = card.Type; } catch { /* optional */ }
            try { row["customName"] = card.custom_name; } catch { /* optional */ }
            try
            {
                var id = row.TryGetValue("id", out var idObj) && idObj is int idInt ? idInt : 0;
                var custom = row.TryGetValue("customName", out var c) ? c?.ToString() : null;
                var type = row.TryGetValue("type", out var t) ? t?.ToString() : null;
                row["name"] = ConfigCatalog.Instance.ResolveCardName(id, custom, type);
            }
            catch
            {
                row["name"] = "card";
            }
            try
            {
                EquipmentProjector.AttachRuntimeEquipFields(row, card);
            }
            catch
            {
                // optional — never fail whole inventory projection
            }
            return row;
        }

        private static void ProjectRites(Player player, RitePanelShowController ritePanel, Projection p)
        {
            if (player.rites == null) return;
            // Only treat as current when the panel is actually visible. A leftover
            // RitePanel.Current after close must not project currentRite — agents
            // used that stale object to skip the next-day continue gate.
            bool ritePanelOpen = ritePanel != null && GameBindings.IsUiActive(ritePanel);
            int currentUid = ritePanelOpen && ritePanel.Current != null ? ritePanel.Current.uid : -1;
            bool canConfirm = false;
            try { canConfirm = ritePanelOpen && ritePanel.CheckConfirm(); }
            catch { /* ignore */ }

            for (int i = 0; i < player.rites.Count; i++)
            {
                var rite = player.rites[i];
                if (rite == null) continue;
                int filled = 0;
                if (rite.cards != null)
                {
                    for (int c = 0; c < rite.cards.Count; c++)
                    {
                        if (rite.cards[c] != null) filled++;
                    }
                }

                var item = new Dictionary<string, object>
                {
                    ["uid"] = rite.uid,
                    ["id"] = rite.id,
                    ["start"] = rite.start,
                    ["life"] = rite.life,
                    ["isShow"] = rite.is_show,
                    ["slotsFilled"] = filled,
                    ["cardCount"] = rite.cards?.Count ?? 0,
                    ["isCurrent"] = rite.uid == currentUid,
                    ["canConfirm"] = rite.uid == currentUid && canConfirm,
                    ["customName"] = rite.custom_name,
                    ["name"] = ConfigCatalog.Instance.ResolveRiteName(rite.id, rite.custom_name)
                };

                if (rite.uid == currentUid)
                {
                    var slots = RiteSlotProjector.BuildSlotList(ritePanel, rite.id);
                    item["slots"] = slots;
                    // Still attach config preview for planner/hand-match when panel is open.
                    RiteSlotProjector.AttachClosedRiteMatchFields(item, rite.id, p.cards);
                    p.currentRite = new Dictionary<string, object>
                    {
                        ["uid"] = rite.uid,
                        ["id"] = rite.id,
                        ["name"] = item["name"],
                        ["started"] = rite.start,
                        ["canConfirm"] = canConfirm,
                        ["slotCount"] = slots.Count,
                        ["slots"] = slots,
                        ["hint"] =
                            "Read slots[].text/conditionType before place_card_on_rite; each rite has different slot requirements."
                    };
                    if (item.TryGetValue("slotPreview", out var preview))
                        p.currentRite["slotPreview"] = preview;
                    if (item.TryGetValue("handMatchCount", out var hmc))
                        p.currentRite["handMatchCount"] = hmc;
                    if (item.TryGetValue("handMatchHints", out var hmh))
                        p.currentRite["handMatchHints"] = hmh;
                }
                else
                {
                    // Closed map: config slot schema + heuristic hand matches (no panel).
                    RiteSlotProjector.AttachClosedRiteMatchFields(item, rite.id, p.cards);
                }

                p.rites.Add(item);
            }

            p.riteCount = player.rites.Count;
            if (p.currentRite == null)
            {
                p.currentRite = RiteSlotProjector.BuildCurrentRiteSnapshot();
            }
        }

        private static void ProjectCounters(Player player, Projection p)
        {
            try
            {
                if (player.counter != null)
                {
                    foreach (var kv in player.counter)
                    {
                        p.counters[kv.Key.ToString()] = kv.Value;
                    }
                }
            }
            catch (Exception ex)
            {
                p.diagnostics["counterError"] = ex.Message;
            }

            try
            {
                if (player.global_counter_cacher != null)
                {
                    var global = new Dictionary<string, object>();
                    foreach (var kv in player.global_counter_cacher)
                    {
                        global[kv.Key.ToString()] = kv.Value;
                    }
                    p.diagnostics["globalCounterCache"] = global;
                }
            }
            catch
            {
                // optional
            }
        }

        /// <summary>
        /// Gold is inventory of 金币 cards (count stack), not a prestige counter.
        /// </summary>
        private static void ProjectResources(Player player, Projection p)
        {
            var gold = 0;
            try
            {
                if (player.cards != null)
                {
                    for (var i = 0; i < player.cards.Count; i++)
                    {
                        var card = player.cards[i];
                        if (card == null) continue;
                        var name = ConfigCatalog.Instance.ResolveCardName(card.id, card.custom_name, card.Type)
                                   ?? card.custom_name
                                   ?? "";
                        var type = card.Type != null ? card.Type.ToString() : "";
                        if (name.IndexOf("金币", StringComparison.Ordinal) >= 0
                            || type.IndexOf("gold", StringComparison.OrdinalIgnoreCase) >= 0
                            || type.IndexOf("coin", StringComparison.OrdinalIgnoreCase) >= 0
                            || type.IndexOf("money", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            gold += Math.Max(1, card.count);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                p.diagnostics["resourcesError"] = ex.Message;
            }

            p.resources["gold"] = gold;
            if (p.counters.TryGetValue("7100006", out var goldDice))
            {
                p.resources["goldDice"] = goldDice;
            }
        }

        private static void ProjectOverlays(Projection p, List<OverlayScanner.Overlay> overlays)
        {
            p.blockingOverlay = false;
            foreach (var overlay in overlays)
            {
                if (overlay == null) continue;
                p.overlays.Add(new Dictionary<string, object>
                {
                    ["id"] = overlay.id,
                    ["kind"] = overlay.kind,
                    ["blocking"] = overlay.blocking,
                    ["dismissOp"] = overlay.dismissOp,
                    ["text"] = overlay.text,
                    ["source"] = overlay.source
                });
                if (overlay.blocking) p.blockingOverlay = true;
            }
        }

#if GAME_INTEROP
        private static void ProjectOptionEvents(OptionController option, Projection p)
        {
            string prompt = null;
            try
            {
                prompt = SanitizeUiText(option.Content != null ? option.Content.text : null, 160);
                if (!string.IsNullOrEmpty(prompt))
                {
                    p.diagnostics["optionPrompt"] = prompt;
                }
            }
            catch
            {
                // optional
            }

            var root = option.Options;
            if (root == null || root.childCount <= 0)
            {
                // Fallback: at least advertise a few slots so the agent can try.
                p.eventOptionCount = 3;
                for (int i = 0; i < 3; i++)
                {
                    p.events.Add(new Dictionary<string, object>
                    {
                        ["index"] = i,
                        ["selected"] = option.CurrentOptionIndex == i,
                        ["label"] = "option_" + i
                    });
                }
                p.currentEvent = BuildChoiceEventProjection(prompt, p.events);
                return;
            }

            int listed = 0;
            for (int i = 0; i < root.childCount; i++)
            {
                Transform child;
                try { child = root.GetChild(i); }
                catch { continue; }
                if (child == null || child.gameObject == null || !child.gameObject.activeInHierarchy)
                {
                    continue;
                }

                Toggle toggle = null;
                try
                {
                    toggle = child.GetComponent<Toggle>();
                    if (toggle == null) toggle = child.GetComponentInChildren<Toggle>(true);
                }
                catch
                {
                    // ignore
                }

                var label = ReadOptionChildLabel(child);
                // Skip pure layout helpers that have neither toggle nor text.
                if (toggle == null && string.IsNullOrEmpty(label)) continue;

                bool selected = false;
                try
                {
                    selected = toggle != null ? toggle.isOn : option.CurrentOptionIndex == i;
                }
                catch
                {
                    selected = option.CurrentOptionIndex == i;
                }

                if (string.IsNullOrEmpty(label)) label = "option_" + i;

                var item = new Dictionary<string, object>
                {
                    ["index"] = i,
                    ["selected"] = selected,
                    ["label"] = label
                };

                try
                {
                    var current = option.CurrentOption;
                    if (selected && current != null && !string.IsNullOrEmpty(current.tag))
                    {
                        item["tag"] = current.tag;
                    }
                }
                catch
                {
                    // optional
                }

                p.events.Add(item);
                listed++;
            }

            if (listed == 0)
            {
                // Last resort: expose raw child indices.
                for (int i = 0; i < root.childCount && i < 8; i++)
                {
                    p.events.Add(new Dictionary<string, object>
                    {
                        ["index"] = i,
                        ["selected"] = option.CurrentOptionIndex == i,
                        ["label"] = "option_" + i
                    });
                    listed++;
                }
            }

            p.eventOptionCount = listed;
            p.currentEvent = BuildChoiceEventProjection(prompt, p.events);
        }

        private static string ReadOptionChildLabel(Transform child)
        {
            if (child == null) return null;
            try
            {
                var tmps = child.GetComponentsInChildren<TMP_Text>(true);
                if (tmps != null)
                {
                    for (int i = 0; i < tmps.Length; i++)
                    {
                        var t = tmps[i];
                        if (t == null || !t.gameObject.activeInHierarchy) continue;
                        var text = SanitizeUiText(t.text, 120);
                        if (!string.IsNullOrEmpty(text)) return text;
                    }
                }
            }
            catch
            {
                // fall through
            }

            try
            {
                var texts = child.GetComponentsInChildren<Text>(true);
                if (texts != null)
                {
                    for (int i = 0; i < texts.Length; i++)
                    {
                        var t = texts[i];
                        if (t == null || !t.gameObject.activeInHierarchy) continue;
                        var text = SanitizeUiText(t.text, 120);
                        if (!string.IsNullOrEmpty(text)) return text;
                    }
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static string SanitizeUiText(string text, int maxLen)
        {
            if (string.IsNullOrEmpty(text)) return null;
            text = text.Replace("\r", " ").Replace("\n", " ").Trim();
            if (text.Length == 0) return null;
            if (text.Length > maxLen) text = text.Substring(0, maxLen) + "…";
            return text;
        }
#endif

        private static string RefinePhase(
            Projection p,
            string sceneId,
            List<OverlayScanner.Overlay> overlays,
            RitePanelShowController ritePanel,
            GameController controller)
        {
            var top = OverlayScanner.TopBlocking(overlays);
            if (top != null)
            {
                return top.id switch
                {
                    "difficulty" => "difficulty",
                    "change_name" => "change_name",
                    "prompt" => "prompt",
                    "begin_guide" => PhaseForGuide(p),
                    "sudan_box" => "sudan_draw",
                    "wizard" => "wizard",
                    "option" => "story",
                    "confirm" => "confirm",
                    "rite_result" => "rite_result",
                    _ => top.id
                };
            }

            if (GameBindings.IsBeginGuideActive) return PhaseForGuide(p);
            if (GameBindings.IsSudanDrawBlocking) return "sudan_draw";
            if (GameBindings.IsUiActive(ritePanel)) return "rite";
            if (p.terminal) return "terminal";
            if (sceneId == "startscene" || sceneId == "boot" || sceneId == "initscene") return "boot";
            if (controller != null && (GameBindings.InGame || GameBindings.InitDone)) return "play";
            if (!GameBindings.InitDone) return "boot";
            if (!GameBindings.InGame) return "main_menu";
            return InferPhase(sceneId, null);
        }

        private static List<ActionInfo> BuildActions(
            Projection p,
            List<OverlayScanner.Overlay> overlays,
            OptionController option,
            RitePanelShowController ritePanel,
            GameController controller)
        {
            var list = new List<ActionInfo>
            {
                new ActionInfo { id = "noop", label = "No-op", enabled = true },
                new ActionInfo { id = "probe_types", label = "Refresh type probe", enabled = true }
            };

            bool overlayBlocking = p.blockingOverlay;
            var top = OverlayScanner.TopBlocking(overlays);
            bool guideActive = GameBindings.IsBeginGuideActive || top?.id == "begin_guide";
            string guideType = p.guide != null && p.guide.TryGetValue("type", out var gt) ? gt as string : null;
            string guidePreferred = p.guide != null && p.guide.TryGetValue("preferredOp", out var gp) ? gp as string : null;
            string guideHint = p.guide != null && p.guide.TryGetValue("hint", out var gh) ? gh as string : null;
            bool optionActive = GameBindings.IsUiActive(option) && p.eventOptionCount > 0;
            bool riteOpen = controller != null && GameBindings.InGame && GameBindings.IsUiActive(ritePanel);
            bool riteStarted = riteOpen && ritePanel.Current != null && ritePanel.Current.start;
            bool canConfirmRite = false;
            if (riteOpen && !riteStarted)
            {
                try { canConfirmRite = ritePanel.CheckConfirm(); } catch { /* ignore */ }
            }

            if (p.phaseHint == "boot" || p.phaseHint == "main_menu")
            {
                list.Add(new ActionInfo
                {
                    id = "start_new_game",
                    label = "Start new game",
                    enabled = true,
                    reason = GameBindings.InitDone ? null : "init_not_done_yet",
                    paramsHint = new Dictionary<string, object> { ["initId"] = "optional int" }
                });
                var savedRound = GameBindings.NeedLoadRound;
                if (savedRound > 0)
                {
                    list.Add(new ActionInfo
                    {
                        id = "continue_game",
                        label = "Continue saved game",
                        enabled = true,
                        paramsHint = new Dictionary<string, object> { ["round"] = savedRound }
                    });
                }
                list.Add(new ActionInfo
                {
                    id = "continue",
                    label = "Advance current UI flow",
                    enabled = true,
                    paramsHint = new Dictionary<string, object> { ["resolvesTo"] = "boot_dismiss_or_prompt" }
                });
            }

            if (top != null && top.id == "difficulty")
            {
                list.Add(new ActionInfo
                {
                    id = "select_difficulty",
                    label = "Select difficulty (optional index)",
                    enabled = true,
                    paramsHint = new Dictionary<string, object> { ["index"] = "optional int" }
                });
                list.Add(new ActionInfo
                {
                    id = "execute",
                    label = "Confirm difficulty selection",
                    enabled = true,
                    paramsHint = new Dictionary<string, object>
                    {
                        ["resolvesTo"] = "select_difficulty",
                        ["index"] = "optional int"
                    }
                });
            }

            // Guide: expose preferred intent/domain op; continue routes to preferredOp.
            if (guideActive && !string.IsNullOrWhiteSpace(guidePreferred))
            {
                list.Add(new ActionInfo
                {
                    id = "continue",
                    label = "Follow BeginGuide preferred gesture",
                    enabled = true,
                    paramsHint = new Dictionary<string, object>
                    {
                        ["resolvesTo"] = guidePreferred,
                        ["guideType"] = guideType,
                        ["hint"] = guideHint
                    }
                });

                if (string.Equals(guidePreferred, "reset", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(guidePreferred, "clear_rite_submission", StringComparison.OrdinalIgnoreCase))
                {
                    list.Add(new ActionInfo
                    {
                        id = "reset",
                        label = "Clear submitted rite (broom)",
                        enabled = riteOpen && riteStarted,
                        reason = riteOpen && riteStarted ? null : "submitted_rite_not_available",
                        paramsHint = new Dictionary<string, object>
                        {
                            ["resolvesTo"] = "clear_rite_submission",
                            ["guideType"] = guideType,
                            ["hint"] = guideHint
                        }
                    });
                }
                else if (string.Equals(guidePreferred, "execute", StringComparison.OrdinalIgnoreCase)
                         || string.Equals(guidePreferred, "start_rite", StringComparison.OrdinalIgnoreCase))
                {
                    list.Add(new ActionInfo
                    {
                        id = "execute",
                        label = "Confirm / submit current rite",
                        enabled = canConfirmRite,
                        reason = canConfirmRite ? null : "rite_not_ready",
                        paramsHint = new Dictionary<string, object> { ["resolvesTo"] = "start_rite" }
                    });
                }
            }

            if (SceneInteractionPolicy.CanOfferSudanDraw(top?.id, guidePreferred))
            {
                list.Add(new ActionInfo
                {
                    id = "draw_sudan_card",
                    label = "Click Sudan box to draw/redraw card",
                    enabled = true,
                    paramsHint = new Dictionary<string, object>
                    {
                        ["hint"] = guideHint ?? "Required when phase=sudan_draw",
                        ["guideType"] = guideType,
                        ["tips"] = p.sudan != null && p.sudan.TryGetValue("boxTips", out var tips) ? tips : null
                    }
                });
            }

            var redrawRemaining = 0;
            if (p.sudan != null && p.sudan.TryGetValue("redrawRemaining", out var rrObj) && rrObj is int rrInt)
            {
                redrawRemaining = rrInt;
            }
            else if (p.sudan != null
                     && p.sudan.TryGetValue("redrawTimes", out var rtObj)
                     && p.sudan.TryGetValue("redrawPerRound", out var rpObj))
            {
                var rt = rtObj is int rti ? rti : 0;
                var rp = rpObj is int rpi ? rpi : 0;
                redrawRemaining = SudanCardActionPolicy.ComputeRedrawRemaining(rt, rp);
            }

            var canOpenBox = SudanCardActionPolicy.CanOfferOpenSudanBox(
                p.terminal,
                overlayBlocking,
                GameBindings.IsSudanDrawBlocking,
                GameBindings.IsSudanBoxPresent);
            list.Add(new ActionInfo
            {
                id = "open_sudan_box",
                label = "Open Sudan card box (exchange menu)",
                enabled = canOpenBox,
                reason = p.terminal
                    ? "game_over"
                    : (GameBindings.IsSudanDrawBlocking
                        ? "sudan_draw_required"
                        : (!GameBindings.IsSudanBoxPresent
                            ? "sudan_box_inactive"
                            : (overlayBlocking ? "overlay_blocking" : null))),
                paramsHint = new Dictionary<string, object>
                {
                    ["hint"] = "Opens the top-left Sudan box; then use exchange_sudan_card if available",
                    ["redrawRemaining"] = redrawRemaining,
                    ["currentCard"] = p.sudan != null && p.sudan.TryGetValue("currentCard", out var cc)
                        ? cc
                        : null
                }
            });

            var wizardChoice = GameBindings.IsWizardChoiceMenu;
            var exchangeButton = GameBindings.HasExchangeSudanCardButton;
            var redrawDropper = GameBindings.IsWizardRedrawDropperActive;
            var exchangePhase = SudanCardActionPolicy.ResolveExchangePhase(
                GameBindings.IsWizardActive,
                wizardChoice,
                redrawDropper,
                redrawRemaining,
                exchangeButton,
                GameBindings.FindCurrentSudanCard() != null);
            var canExchange = exchangePhase != "unavailable";
            list.Add(new ActionInfo
            {
                id = "exchange_sudan_card",
                label = "Exchange current Sudan card (Wizard)",
                enabled = canExchange,
                reason = !GameBindings.IsWizardActive
                    ? "wizard_not_open"
                    : (redrawRemaining <= 0
                        ? "no_redraw_remaining"
                        : (GameBindings.FindCurrentSudanCard() == null
                            ? "no_sudan_card"
                            : (exchangePhase == "unavailable" ? "exchange_button_missing" : null))),
                paramsHint = new Dictionary<string, object>
                {
                    ["hint"] = exchangePhase == "dropper"
                        ? "Complete the pending exchange by dragging the current Sudan card into the Wizard box"
                        : "Click exact label 交换手上的苏丹卡, then drag the current card into the Wizard box; never 再来一张",
                    ["exactLabel"] = SudanCardActionPolicy.ExchangeLabelZh,
                    ["phase"] = exchangePhase,
                    ["requiresDrag"] = exchangePhase == "dropper",
                    ["redrawRemaining"] = redrawRemaining,
                    ["doesNotResetCountdown"] = true
                }
            });

            if (optionActive)
            {
                var indices = new List<object>();
                foreach (var ev in p.events)
                {
                    if (ev != null && ev.TryGetValue("index", out var idx)) indices.Add(idx);
                }
                list.Add(new ActionInfo
                {
                    id = "select_event_option",
                    label = "Select perk/story option then confirm",
                    enabled = true,
                    paramsHint = new Dictionary<string, object>
                    {
                        ["optionIndex"] = indices.Count > 0
                            ? string.Join("|", indices)
                            : ("0.." + (p.eventOptionCount - 1)),
                        ["hint"] = "Read events[].label, choose optionIndex"
                    }
                });
                list.Add(new ActionInfo
                {
                    id = "execute",
                    label = "Confirm selected event option",
                    enabled = true,
                    paramsHint = new Dictionary<string, object>
                    {
                        ["resolvesTo"] = "select_event_option",
                        ["optionIndex"] = "required unless already selected"
                    }
                });
            }

            // Blocking overlays: advertise continue (plugin routes Next/Confirm/dismiss).
            if (overlayBlocking
                && SceneInteractionPolicy.CanOfferGenericContinue(top?.id, top?.kind)
                && !guideActive)
            {
                var riteResult = p.riteResult ?? new Dictionary<string, object>();
                var riteStage = riteResult.TryGetValue("stage", out var stageRaw) ? stageRaw as string : null;
                var goldAvailable = 0;
                if (riteResult.TryGetValue("goldDiceAvailable", out var goldRaw) && goldRaw != null)
                {
                    int.TryParse(goldRaw.ToString(), out goldAvailable);
                }

                var continueGesture = top?.id == "rite_result"
                    ? RiteResultPolicy.ResolveContinueGesture(riteStage, goldAvailable)
                    : null;
                var continueEnabled = top?.id != "rite_result"
                    || continueGesture == RiteResultPolicy.GestureNext
                    || continueGesture == RiteResultPolicy.GestureResultText;

                list.Add(new ActionInfo
                {
                    id = "continue",
                    label = top?.id == "rite_result"
                        ? "Advance result/dice page (body/blank skips gold dice; Next when ready; never auto-spends)"
                        : (top?.id == "change_name" ? "Confirm default name" : "Advance blocking UI"),
                    enabled = continueEnabled,
                    reason = continueEnabled
                        ? null
                        : (continueGesture ?? "rite_result_needs_gold_confirm"),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["resolvesTo"] = top?.id == "rite_result" ? "rite_result_advance" : "dismiss_overlay",
                        ["overlay"] = top?.id,
                        ["text"] = top?.text,
                        ["riteResult"] = top?.id == "rite_result" ? riteResult : null
                    }
                });

                if (top?.id == "rite_result")
                {
                    var goldSelect = riteResult.TryGetValue("goldSelectInteractable", out var gs) && gs is true;
                    var goldConfirm = riteResult.TryGetValue("goldConfirmInteractable", out var gc) && gc is true;
                    var goldCancel = riteResult.TryGetValue("goldCancelInteractable", out var gcancel) && gcancel is true;
                    if (goldSelect)
                    {
                        list.Add(new ActionInfo
                        {
                            id = "select_gold_dice",
                            label = "Optional: open gold-dice picker (spend only if tip needs more successes)",
                            enabled = true,
                            paramsHint = new Dictionary<string, object>
                            {
                                ["goldDiceAvailable"] = goldAvailable,
                                ["tip"] = riteResult.TryGetValue("tip", out var tip) ? tip : null,
                                ["hint"] = "Optional. Prefer continue to skip; spend only when tip/needTags justify it"
                            }
                        });
                    }

                    if (goldConfirm)
                    {
                        list.Add(new ActionInfo
                        {
                            id = "confirm_gold_dice",
                            label = "Confirm selected gold dice count",
                            enabled = true,
                            paramsHint = new Dictionary<string, object>
                            {
                                ["selectedGoldLabel"] = riteResult.TryGetValue("selectedGoldLabel", out var sel) ? sel : null,
                                ["goldDiceAvailable"] = goldAvailable
                            }
                        });
                    }

                    // gold_select: skip via blank/body; gold_confirm: Gold Cancel button.
                    if (goldSelect || goldCancel)
                    {
                        list.Add(new ActionInfo
                        {
                            id = "cancel_gold_dice",
                            label = goldSelect
                                ? "Skip gold dice (click blank/body; does not spend)"
                                : "Cancel gold dice selection",
                            enabled = true,
                            paramsHint = new Dictionary<string, object>
                            {
                                ["hint"] = goldSelect
                                    ? "Same as continue on gold_select: skip spending"
                                    : "Abort confirm without spending"
                            }
                        });
                    }
                }
            }

            if (controller != null && GameBindings.InGame)
            {
                if (p.cards.Count > 0)
                {
                    list.Add(new ActionInfo
                    {
                        id = "select_card",
                        label = "Select card by uid",
                        enabled = !overlayBlocking && !riteOpen,
                        reason = overlayBlocking
                            ? "overlay_blocking"
                            : (riteOpen ? "use_place_card_on_rite" : null),
                        paramsHint = new Dictionary<string, object> { ["uid"] = "int" }
                    });
                }

                if (riteOpen && (!overlayBlocking || guideActive))
                {
                    var current = p.currentRite ?? RiteSlotProjector.BuildCurrentRiteSnapshot();
                    p.currentRite = current;
                    var slotHints = current != null && current.TryGetValue("slots", out var rawSlots)
                        ? rawSlots
                        : new List<Dictionary<string, object>>();

                    if (!guideActive || string.Equals(guidePreferred, "execute", StringComparison.OrdinalIgnoreCase))
                    {
                        list.Add(new ActionInfo
                        {
                            id = "place_card_on_rite",
                            label = "Place card into rite slot",
                            enabled = !riteStarted && !overlayBlocking,
                            reason = riteStarted
                                ? "rite_started_reset_first"
                                : (overlayBlocking ? "overlay_blocking" : null),
                            paramsHint = new Dictionary<string, object>
                            {
                                ["uid"] = "card uid from hand/cards",
                                ["slotIndex"] = "int — match slots[].index",
                                ["slots"] = slotHints
                            }
                        });
                    }

                    list.Add(new ActionInfo
                    {
                        id = "execute",
                        label = "Confirm / submit rite",
                        enabled = !riteStarted && canConfirmRite && !overlayBlocking,
                        reason = riteStarted
                            ? "rite_already_started"
                            : (overlayBlocking
                                ? "overlay_blocking"
                                : (canConfirmRite ? null : "rite_not_ready")),
                        paramsHint = new Dictionary<string, object> { ["resolvesTo"] = "start_rite" }
                    });
                    list.Add(new ActionInfo
                    {
                        id = "reset",
                        label = "Undo rite choices / clear submission",
                        enabled = true,
                        paramsHint = new Dictionary<string, object>
                        {
                            ["resolvesTo"] = riteStarted ? "clear_rite_submission" : "cancel_card_placement",
                            ["slotIndex"] = "optional int when undoing a placement",
                            ["slots"] = slotHints
                        }
                    });
                    if (!guideActive)
                    {
                        list.Add(new ActionInfo
                        {
                            id = "cancel",
                            label = "Close rite panel without submitting",
                            enabled = true,
                            paramsHint = new Dictionary<string, object> { ["resolvesTo"] = "close_rite" }
                        });
                    }
                }

                var canAdvanceDay = !p.terminal && !overlayBlocking && !riteOpen && !guideActive;
                var canContinuePanel = (overlayBlocking
                                        && SceneInteractionPolicy.CanOfferGenericContinue(top?.id, top?.kind)
                                        && !guideActive)
                                       || (guideActive && !string.IsNullOrWhiteSpace(guidePreferred))
                                       || (top?.id == "rite_result");
                list.Add(new ActionInfo
                {
                    id = "continue",
                    label = "Confirm / dismiss current panel",
                    enabled = canContinuePanel,
                    reason = p.terminal
                        ? "game_over"
                        : (canContinuePanel
                            ? null
                            : (guideActive && string.IsNullOrWhiteSpace(guidePreferred)
                                ? "need_follow_guide"
                                : "nothing_to_continue")),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["resolvesTo"] = overlayBlocking
                            ? (top?.id ?? "dismiss_overlay")
                            : (guideActive ? (guidePreferred ?? "guide") : "nothing"),
                        ["hint"] = "Never advances the day; use next_day for that"
                    }
                });

                list.Add(new ActionInfo
                {
                    id = "next_day",
                    label = "Advance to next day",
                    enabled = canAdvanceDay,
                    reason = p.terminal
                        ? "game_over"
                        : (overlayBlocking
                            ? "overlay_blocking"
                            : (riteOpen
                                ? "rite_panel_open"
                                : (guideActive ? "need_follow_guide" : null))),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["resolvesTo"] = "next_round",
                        ["hint"] = "Explicit day advance only; not via continue"
                    }
                });

                var player = GameBindings.Player;
                var round = player != null ? player.round : 0;
                var minRound = 0;
                var playerSuccess = false;
                try { if (player != null) minRound = player.min_round; } catch { /* optional */ }
                try { if (player != null) playerSuccess = player.success; } catch { /* optional */ }
                var canPrev = !riteOpen
                              && SceneInteractionPolicy.CanPrevRound(
                                  round, minRound, overlayBlocking, p.terminal, playerSuccess);
                list.Add(new ActionInfo
                {
                    id = "prev_round",
                    label = "Return to previous round",
                    enabled = canPrev,
                    reason = playerSuccess
                        ? "victory"
                        : (riteOpen
                            ? "rite_panel_open"
                            : (!p.terminal && overlayBlocking
                                ? "overlay_blocking"
                                : (canPrev ? null : "no_previous_round"))),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["round"] = round,
                        ["minRound"] = minRound,
                        ["hint"] = p.terminal && !playerSuccess
                            ? "Failure game-over: prefer prev_round to retry the prior day"
                            : "Rewind one day when available"
                    }
                });

                if (p.terminal)
                {
                    list.Add(new ActionInfo
                    {
                        id = "start_new_game",
                        label = "Start a new game after ending / unwinnable game-over",
                        enabled = true,
                        paramsHint = new Dictionary<string, object>
                        {
                            ["initId"] = "optional int",
                            ["hint"] =
                                "Use when prev_round is unavailable, or after rewind the position is still unwinnable"
                        }
                    });
                }

                list.Add(new ActionInfo
                {
                    id = "inspect_card",
                    label = riteOpen
                        ? "Inspect filled rite-slot card dossier (catalog / DoIThink help)"
                        : "Inspect card dossier (DoIThink help; does not create map events)",
                    enabled = !overlayBlocking && !p.terminal,
                    reason = overlayBlocking
                        ? "overlay_blocking"
                        : (p.terminal ? "game_over" : null),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["uid"] = "int",
                        ["hint"] = riteOpen
                            ? "While rite panel open, pass cardUid from currentRite.slots[].cardUid / cardSummary"
                            : "Read-only dossier. To discover events, use think_card instead."
                    }
                });

                var canThink = !overlayBlocking && !riteOpen && !p.terminal && !guideActive;
                list.Add(new ActionInfo
                {
                    id = "think_card",
                    label = "Drop card into 俺寻思 to discover / spawn a map event",
                    enabled = canThink,
                    reason = overlayBlocking
                        ? "overlay_blocking"
                        : (p.terminal
                            ? "game_over"
                            : (riteOpen
                                ? "rite_panel_open"
                                : (guideActive ? "need_follow_guide" : null))),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["uid"] = "int — hand / inventory / current Sudan card uid",
                        ["hint"] =
                            "Gameplay drop (ThinkController), not inspect_card. Books / Sudan / intel / items may spawn events. After success, open the new non-meta map rite (id!=5000002)."
                    }
                });

                var canEquip = !overlayBlocking && !riteOpen && !p.terminal && !guideActive;
                list.Add(new ActionInfo
                {
                    id = "equip_item",
                    label = "Equip item onto owned character/follower",
                    enabled = canEquip,
                    reason = overlayBlocking
                        ? "overlay_blocking"
                        : (p.terminal
                            ? "game_over"
                            : (riteOpen
                                ? "rite_panel_open"
                                : (guideActive ? "need_follow_guide" : null))),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["characterUid"] = "int — owned char/follower uid",
                        ["itemUid"] = "int — equippable item uid",
                        ["hint"] =
                            "Use enabled semantic:equip_* affordances. Same slot occupied requires unequip_item first."
                    }
                });
                list.Add(new ActionInfo
                {
                    id = "unequip_item",
                    label = "Unequip item from character",
                    enabled = canEquip,
                    reason = overlayBlocking
                        ? "overlay_blocking"
                        : (p.terminal
                            ? "game_over"
                            : (riteOpen
                                ? "rite_panel_open"
                                : (guideActive ? "need_follow_guide" : null))),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["characterUid"] = "int — optional when itemUid uniquely owned",
                        ["itemUid"] = "int — currently equipped item uid",
                        ["hint"] = "Use enabled semantic:unequip_* affordances."
                    }
                });

                var newsPresent = p.dailyNews != null
                                  && p.dailyNews.TryGetValue("present", out var presentRaw)
                                  && presentRaw is bool presentFlag
                                  && presentFlag;
                var newsEntry = p.dailyNews != null
                                && p.dailyNews.TryGetValue("entryAvailable", out var entryRaw)
                                && entryRaw is bool entryFlag
                                && entryFlag;
                var canOpenNews = SceneInteractionPolicy.CanOfferDailyNews(
                    overlayBlocking, p.terminal, riteOpen, guideActive, newsPresent, newsEntry);
                list.Add(new ActionInfo
                {
                    id = "open_daily_news",
                    label = "Read today's StoryNotify (not story book)",
                    enabled = canOpenNews,
                    reason = overlayBlocking
                        ? "overlay_blocking"
                        : (p.terminal
                            ? "game_over"
                            : (riteOpen
                                ? "rite_panel_open"
                                : (guideActive
                                    ? "need_follow_guide"
                                    : (canOpenNews ? null : "no_daily_news")))),
                    paramsHint = new Dictionary<string, object>
                    {
                        ["dailyNews"] = p.dailyNews,
                        ["hint"] =
                            "Only when StoryNotify popup is open. Summarize via report_action_chain. "
                            + "Never open StoryEntry / 一千零一夜 / achievements for the daily loop. "
                            + "Day advance uses next_day, not continue."
                    }
                });

                list.Add(new ActionInfo
                {
                    id = "open_rite",
                    label = "Open visible map rite",
                    enabled = !overlayBlocking && !p.terminal && !riteOpen,
                    reason = overlayBlocking
                        ? "overlay_blocking"
                        : (p.terminal ? "game_over" : (riteOpen ? "rite_panel_open" : null)),
                    paramsHint = new Dictionary<string, object> { ["uid"] = "rite uid" }
                });
            }

            // Deduplicate by id keeping first.
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var unique = new List<ActionInfo>();
            foreach (var a in list)
            {
                if (a?.id == null || !seen.Add(a.id)) continue;
                unique.Add(a);
            }
            return unique;
        }
#endif

        private static string PhaseForGuide(Projection p)
        {
            var type = p?.guide != null && p.guide.TryGetValue("type", out var t) ? t as string : null;
            if (!string.IsNullOrEmpty(type))
            {
                var upper = type.ToUpperInvariant();
                if (upper.Contains("SUDAN")) return "sudan_draw";
                if (upper.Contains("RITE")) return "rite";
                if (upper.Contains("NEXT_DAY") || upper.Contains("BACK_ROUND")) return "play";
            }
            return "guide";
        }

        public static string InferPhase(string screenId, string sceneName)
        {
            var n = (screenId ?? "").ToLowerInvariant();
            if (string.IsNullOrEmpty(n) && !string.IsNullOrEmpty(sceneName))
            {
                n = sceneName.ToLowerInvariant();
            }

            if (n.Contains("start")) return "boot";
            if (n.Contains("menu")) return "main_menu";
            if (n.Contains("rite")) return "rite";
            if (n.Contains("story") || n.Contains("event") || n.Contains("notify")) return "story";
            if (n.Contains("end") || n.Contains("gameover") || n.Contains("result") || n.Contains("over")) return "terminal";
            if (n.Contains("game") || n.Contains("main") || n.Contains("play") || n.Contains("desktop")) return "play";
            return string.IsNullOrEmpty(n) ? "unknown" : n.Replace(" ", "_");
        }

        public static string NormalizeScreenId(string name)
        {
            if (string.IsNullOrEmpty(name)) return "unknown";
            var n = name.ToLowerInvariant();
            if (n.Contains("start")) return "startscene";
            if (n.Contains("menu")) return "main_menu";
            if (n.Contains("rite")) return "rite";
            if (n.Contains("story") || n.Contains("event") || n.Contains("notify")) return "story";
            if (n.Contains("end") || n.Contains("gameover") || n.Contains("result") || n.Contains("over")) return "terminal";
            if (n.Contains("game") || n.Contains("main") || n.Contains("play") || n.Contains("desktop")) return "play";
            return n.Replace(" ", "_");
        }
    }
}
