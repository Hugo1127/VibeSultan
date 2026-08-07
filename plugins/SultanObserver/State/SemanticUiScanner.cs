using System;
using System.Collections.Generic;
using System.Diagnostics;
#if GAME_INTEROP
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
#endif

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Builds a compact semantic scene from active Unity UI and typed game actions.
    /// Scans only active overlay/controller roots and enforces hard node/element caps.
    /// </summary>
    public sealed class SemanticUiScanner
    {
        private const int MaxNodes = 260;
        private const int MaxElements = 160;
        private const int MaxDepth = 9;
        private const int MaxMapRites = 24;
        private const int MaxVisibleHand = 24;

        private readonly UiAdapterRegistry _registry;

        public SemanticUiScanner(UiAdapterRegistry registry)
        {
            _registry = registry ?? throw new ArgumentNullException(nameof(registry));
        }

        public SceneSnapshot Capture(GameState state, long snapshotVersion)
        {
            state ??= GameState.CreateEmpty();
            var watch = Stopwatch.StartNew();
            var snapshot = new SceneSnapshot
            {
                snapshotVersion = snapshotVersion,
                capturedAt = DateTimeOffset.Now.ToString("o"),
                scene = new SceneDescriptor
                {
                    id = state.screen?.id,
                    name = state.screen?.name,
                    phase = state.screen?.phase
                }
            };

            _registry.BeginSnapshot(snapshotVersion);
            PopulateTelemetry(state, snapshot);
            PopulateInstructionAndModal(state, snapshot);
            PopulateDailyNewsSemantics(state, snapshot);
            PopulateRiteResultSemantics(state, snapshot);
            PopulateTypedAffordances(state, snapshot);

#if GAME_INTEROP
            PopulateMainScreenSemantics(state, snapshot);
            PopulateRitePanelSemantics(state, snapshot);
            ScanUnityUi(state, snapshot);
#endif

            SceneSnapshotNormalizer.Normalize(snapshot, MaxElements, MaxElements);
            SceneForegroundFilter.Apply(snapshot);

            watch.Stop();
            snapshot.diagnostics["captureMs"] = watch.Elapsed.TotalMilliseconds;
            snapshot.diagnostics["elementCount"] = snapshot.elements.Count;
            snapshot.diagnostics["affordanceCount"] = snapshot.affordances.Count;
            return snapshot;
        }

        private static void PopulateTelemetry(GameState state, SceneSnapshot snapshot)
        {
            if (state.values == null) return;
            foreach (var key in new[]
                     {
                         "day", "turn", "handCount", "riteCount", "eventOptionCount",
                         "blockingOverlay", "terminal", "sudan", "guide", "dailyNews",
                         "riteResult", "questSummary", "currentRite", "currentEvent"
                     })
            {
                if (state.values.TryGetValue(key, out var value)) snapshot.telemetry[key] = value;
            }
        }

        private static void PopulateInstructionAndModal(GameState state, SceneSnapshot snapshot)
        {
            if (state.values == null) return;
            if (state.values.TryGetValue("overlays", out var rawOverlays)
                && rawOverlays is List<Dictionary<string, object>> overlays)
            {
                foreach (var overlay in overlays)
                {
                    if (overlay == null) continue;
                    var blocking = Bool(overlay, "blocking");
                    if (!blocking) continue;
                    snapshot.scene.modal = String(overlay, "id");
                    snapshot.scene.blocking = true;
                    var text = SceneText.Normalize(String(overlay, "text"));
                    if (!string.IsNullOrEmpty(text))
                    {
                        snapshot.instruction = new SceneInstruction
                        {
                            source = "overlay",
                            type = String(overlay, "kind"),
                            text = text,
                            preferredOp = String(overlay, "dismissOp")
                        };
                    }
                    break;
                }
            }

            if (state.values.TryGetValue("guide", out var rawGuide)
                && rawGuide is Dictionary<string, object> guide
                && Bool(guide, "active"))
            {
                snapshot.scene.modal = "begin_guide";
                snapshot.scene.blocking = true;
                snapshot.instruction = new SceneInstruction
                {
                    source = "begin_guide",
                    type = String(guide, "type"),
                    text = SceneText.Normalize(String(guide, "text")),
                    hint = SceneText.Normalize(String(guide, "hint")),
                    preferredOp = String(guide, "preferredOp")
                };
            }
        }

        private void PopulateDailyNewsSemantics(GameState state, SceneSnapshot snapshot)
        {
            if (state?.values == null
                || !state.values.TryGetValue("dailyNews", out var raw)
                || raw is not Dictionary<string, object> news)
            {
                return;
            }

            var present = Bool(news, "present");
            var open = Bool(news, "open");
            var summary = SceneText.Normalize(String(news, "summary"));
            var title = SceneText.Normalize(String(news, "title"));
            if (open && !string.IsNullOrEmpty(summary))
            {
                snapshot.scene.modal = snapshot.scene.modal ?? "daily_news";
                if (snapshot.instruction == null || string.IsNullOrEmpty(snapshot.instruction.text))
                {
                    snapshot.instruction = new SceneInstruction
                    {
                        source = "daily_news",
                        type = "story_notify",
                        text = summary,
                        hint =
                            "Summarize today's news via report_action_chain; soft StoryNotify is not a continue target. Use next_day only when ready to advance.",
                        preferredOp = null
                    };
                }
            }

            if (!present && !open) return;

            var targetId = SceneElementId.Semantic("daily_news");
            var label = !string.IsNullOrEmpty(title) ? title : "Today's news";
            if (!snapshot.elements.Exists(e => e != null && e.elementId == targetId))
            {
                snapshot.elements.Add(new UiElementInfo
                {
                    elementId = targetId,
                    role = open ? "panel" : "button",
                    name = label,
                    text = summary ?? label,
                    visible = true,
                    interactable = !open && IsActionEnabled(state, "open_daily_news"),
                    preferredOp = open ? null : "open_daily_news"
                });
            }
        }

        private static void PopulateRiteResultSemantics(GameState state, SceneSnapshot snapshot)
        {
            if (state?.values == null
                || !state.values.TryGetValue("riteResult", out var raw)
                || raw is not Dictionary<string, object> rite)
            {
                return;
            }

            if (!Bool(rite, "active")) return;

            var tip = SceneText.Normalize(String(rite, "tip"));
            var breakdown = SceneText.Normalize(String(rite, "diceBreakdown"));
            var summary = SceneText.Normalize(String(rite, "summary"));
            var title = SceneText.Normalize(String(rite, "title"));
            var leftTips = SceneText.Normalize(String(rite, "leftTips"));
            var stage = String(rite, "stage") ?? RiteResultPolicy.StageResultPage;
            var totalDice = rite.TryGetValue("totalDice", out var totalRaw) ? totalRaw : null;
            var successCount = rite.TryGetValue("successCount", out var successRaw) ? successRaw : null;
            var successThreshold = rite.TryGetValue("successThreshold", out var thRaw) ? thRaw : null;
            var goldLeft = rite.TryGetValue("goldDiceAvailable", out var goldRaw) ? goldRaw : null;
            var rewardSummary = SceneText.Normalize(String(rite, "rewardSummary"));
            var instructionText = tip;
            if (successCount != null)
            {
                instructionText = string.IsNullOrEmpty(instructionText)
                    ? "success=" + successCount
                    : instructionText + " | success=" + successCount;
            }
            if (successThreshold != null)
            {
                instructionText = string.IsNullOrEmpty(instructionText)
                    ? "need=" + successThreshold
                    : instructionText + " | need=" + successThreshold;
            }
            if (!string.IsNullOrEmpty(rewardSummary))
            {
                instructionText = string.IsNullOrEmpty(instructionText)
                    ? "rewards=" + rewardSummary
                    : instructionText + " | rewards=" + rewardSummary;
            }
            if (!string.IsNullOrEmpty(breakdown))
            {
                instructionText = string.IsNullOrEmpty(instructionText)
                    ? breakdown
                    : instructionText + " | " + breakdown;
            }
            if (totalDice != null)
            {
                instructionText = string.IsNullOrEmpty(instructionText)
                    ? "dice=" + totalDice
                    : instructionText + " | dice=" + totalDice;
            }
            if (goldLeft != null)
            {
                instructionText = string.IsNullOrEmpty(instructionText)
                    ? "goldDice=" + goldLeft
                    : instructionText + " | goldDice=" + goldLeft;
            }
            if (string.IsNullOrEmpty(instructionText)) instructionText = summary;
            if (!string.IsNullOrEmpty(leftTips))
            {
                instructionText = string.IsNullOrEmpty(instructionText)
                    ? leftTips
                    : instructionText + " | " + leftTips;
            }
            if (!string.IsNullOrEmpty(instructionText)
                && (snapshot.instruction == null || string.IsNullOrEmpty(snapshot.instruction.text)))
            {
                snapshot.instruction = new SceneInstruction
                {
                    source = "rite_result",
                    type = "dice_check",
                    text = instructionText,
                    hint = "Dice/result: successCount=rolled successes; tip/need=threshold; rewards=newly shown cards. Gold dice is OPTIONAL — continue (blank/body) skips spending; use select_gold_dice only when tip needs more successes.",
                    preferredOp = IsActionEnabled(state, "continue") ? "continue" : null
                };
            }

            if (rite.TryGetValue("rewards", out var rewardsRaw) && rewardsRaw is List<object> rewards)
            {
                for (var i = 0; i < rewards.Count && i < 8; i++)
                {
                    if (rewards[i] is not Dictionary<string, object> reward) continue;
                    var label = SceneText.Normalize(String(reward, "label"))
                                ?? SceneText.Normalize(String(reward, "name"))
                                ?? ("reward_" + i);
                    var rewardId = SceneElementId.Semantic("rite_reward_" + i);
                    if (snapshot.elements.Exists(e => e != null && e.elementId == rewardId)) continue;
                    snapshot.elements.Add(new UiElementInfo
                    {
                        elementId = rewardId,
                        overlayId = "rite_result",
                        role = "card",
                        name = label,
                        text = label,
                        visible = true,
                        interactable = false,
                        actionParams = reward
                    });
                }
            }

            var bodyId = SceneElementId.Semantic("rite_result_body");
            if (!snapshot.elements.Exists(e => e != null && e.elementId == bodyId))
            {
                snapshot.elements.Add(new UiElementInfo
                {
                    elementId = bodyId,
                    overlayId = "rite_result",
                    role = "button",
                    name = !string.IsNullOrEmpty(title) ? title : "Rite result",
                    text = summary ?? title ?? "Rite result",
                    visible = true,
                    interactable = IsActionEnabled(state, "continue"),
                    preferredOp = IsActionEnabled(state, "continue") ? "continue" : null,
                    actionParams = new Dictionary<string, object>
                    {
                        ["stage"] = stage,
                        ["tip"] = tip,
                        ["successCount"] = successCount,
                        ["successThreshold"] = successThreshold,
                        ["diceBreakdown"] = breakdown,
                        ["totalDice"] = totalDice,
                        ["needTags"] = rite.TryGetValue("needTags", out var tags) ? tags : null,
                        ["goldDiceAvailable"] = goldLeft ?? 0
                    }
                });
            }

            if (IsActionEnabled(state, "select_gold_dice"))
            {
                var goldId = SceneElementId.Semantic("gold_dice");
                snapshot.elements.Add(new UiElementInfo
                {
                    elementId = goldId,
                    overlayId = "rite_result",
                    role = "button",
                    name = "Gold dice (optional)",
                    text = "金骰子（可选，默认 continue 跳过）",
                    visible = true,
                    interactable = true,
                    preferredOp = "select_gold_dice"
                });
            }

            if (IsActionEnabled(state, "confirm_gold_dice"))
            {
                snapshot.elements.Add(new UiElementInfo
                {
                    elementId = SceneElementId.Semantic("gold_confirm"),
                    overlayId = "rite_result",
                    role = "button",
                    name = "Gold Confirm",
                    text = "Gold Confirm",
                    visible = true,
                    interactable = true,
                    preferredOp = "confirm_gold_dice"
                });
            }

            if (IsActionEnabled(state, "cancel_gold_dice"))
            {
                snapshot.elements.Add(new UiElementInfo
                {
                    elementId = SceneElementId.Semantic("gold_cancel"),
                    overlayId = "rite_result",
                    role = "button",
                    name = "Skip/cancel gold dice",
                    text = string.Equals(stage, RiteResultPolicy.StageGoldSelect, StringComparison.OrdinalIgnoreCase)
                        ? "跳过金骰（点空白）"
                        : "取消金骰",
                    visible = true,
                    interactable = true,
                    preferredOp = "cancel_gold_dice"
                });
            }
        }

        private void PopulateTypedAffordances(GameState state, SceneSnapshot snapshot)
        {
            foreach (var action in state.actions ?? new List<ActionInfo>())
            {
                if (action == null || string.IsNullOrWhiteSpace(action.id)) continue;
                if (action.id is "noop" or "probe_types") continue;

                if (action.id == "select_event_option")
                {
                    AddOptionAffordances(state, snapshot, action);
                    continue;
                }

                // Placement / equip actions are exposed as concrete semantic:* rows.
                if (action.id is "place_card_on_rite" or "cancel_card_placement"
                    or "equip_item" or "unequip_item")
                {
                    continue;
                }

                if (action.id is "select_card" or "inspect_card" or "think_card" or "open_rite"
                    or "open_daily_news" or "prev_round" or "execute" or "cancel" or "reset")
                {
                    snapshot.affordances.Add(new UiAffordanceInfo
                    {
                        action = action.id,
                        label = action.label ?? action.id,
                        enabled = action.enabled,
                        reason = action.reason,
                        mapsToOp = action.id,
                        parameters = Copy(action.paramsHint)
                    });
                    continue;
                }

                // Legacy granular ops are not AI-primary; skip if somehow still present.
                if (action.id is "next_round" or "start_rite" or "close_rite"
                    or "clear_rite_submission" or "cancel_card_placement" or "click_element")
                {
                    continue;
                }

                var targetId = KnownTargetId(action.id);
                var element = new UiElementInfo
                {
                    elementId = targetId,
                    role = RoleForAction(action.id),
                    name = action.label ?? action.id,
                    text = action.label,
                    visible = true,
                    interactable = action.enabled,
                    blocked = !action.enabled && string.Equals(action.reason, "overlay_blocking", StringComparison.OrdinalIgnoreCase),
                    preferredOp = action.id,
                    actionParams = Copy(action.paramsHint)
                };
                snapshot.elements.Add(element);
                snapshot.affordances.Add(new UiAffordanceInfo
                {
                    action = action.id == "continue" ? "click" : action.id,
                    targetId = targetId,
                    label = action.label ?? action.id,
                    enabled = action.enabled,
                    reason = action.reason,
                    mapsToOp = action.id
                });
                RegisterTyped(snapshot, element, action.id, null);
            }
        }

        private void AddOptionAffordances(GameState state, SceneSnapshot snapshot, ActionInfo action)
        {
            if (state.values == null
                || !state.values.TryGetValue("events", out var raw)
                || raw is not List<Dictionary<string, object>> events)
            {
                return;
            }

            foreach (var option in events)
            {
                if (option == null || !option.TryGetValue("index", out var index)) continue;
                var targetId = SceneElementId.Semantic("option_" + index);
                var label = SceneText.Normalize(String(option, "label")) ?? ("Option " + index);
                var parameters = new Dictionary<string, object> { ["optionIndex"] = index };
                var element = new UiElementInfo
                {
                    elementId = targetId,
                    role = "toggle",
                    name = label,
                    text = label,
                    visible = true,
                    interactable = action.enabled,
                    selected = Bool(option, "selected"),
                    preferredOp = "select_event_option",
                    actionParams = parameters
                };
                snapshot.elements.Add(element);
                snapshot.affordances.Add(new UiAffordanceInfo
                {
                    action = "select",
                    targetId = targetId,
                    label = label,
                    enabled = action.enabled,
                    reason = action.reason,
                    mapsToOp = "select_event_option",
                    parameters = parameters
                });
                RegisterTyped(snapshot, element, "select_event_option", parameters);
            }
        }

        private void RegisterTyped(
            SceneSnapshot snapshot,
            UiElementInfo element,
            string op,
            Dictionary<string, object> parameters)
        {
            _registry.Register(new UiAdapterRegistry.ElementHandle
            {
                elementId = element.elementId,
                snapshotVersion = snapshot.snapshotVersion,
                mapsToOp = op,
                actionParams = parameters,
                visible = element.visible,
                interactable = element.interactable,
                blocked = element.blocked
            });
        }

#if GAME_INTEROP
        private sealed class ScanNode
        {
            public Transform transform;
            public string parentId;
            public string overlayId;
            public int depth;
        }

        private void PopulateRitePanelSemantics(GameState state, SceneSnapshot snapshot)
        {
            var guidePreferred = GuidePreferredOp(state);
            var guideWantsRiteStop = string.Equals(guidePreferred, "reset", StringComparison.OrdinalIgnoreCase)
                || string.Equals(guidePreferred, "clear_rite_submission", StringComparison.OrdinalIgnoreCase);

            // BeginGuide is a blocking overlay, but RITE_STOP specifically points at the
            // broom on the rite panel — we must still expose reset.
            if (OverlayScanner.HasBlocking() && !guideWantsRiteStop) return;

            var panel = GameBindings.RitePanel;
            if (!GameBindings.IsUiActive(panel) || panel.Current == null) return;

            var current = state.values != null
                          && state.values.TryGetValue("currentRite", out var raw)
                          && raw is Dictionary<string, object> dict
                ? dict
                : RiteSlotProjector.BuildCurrentRiteSnapshot();
            if (current == null) return;

            snapshot.telemetry["currentRite"] = current;
            var slots = current.TryGetValue("slots", out var rawSlots)
                        && rawSlots is List<Dictionary<string, object>> list
                ? list
                : RiteSlotProjector.BuildSlotList(panel, panel.Current.id);
            snapshot.telemetry["riteSlots"] = RiteSlotProjector.SlotSignature(slots);

            var riteName = String(current, "name") ?? "Current rite";
            var riteStarted = panel.Current.start;
            // Tag guide-required broom controls with the blocking modal id so the
            // foreground filter keeps them while BeginGuide is up.
            var guideOverlayId = guideWantsRiteStop ? "begin_guide" : null;
            snapshot.elements.Add(new UiElementInfo
            {
                elementId = SceneElementId.Semantic("rite_panel"),
                role = "panel",
                name = riteName,
                text = riteName,
                overlayId = guideOverlayId,
                visible = true,
                interactable = false
            });

            if (!guideWantsRiteStop)
            {
                var closeParams = new Dictionary<string, object>
                {
                    ["hint"] = "Close this rite panel without advancing the day",
                    ["resolvesTo"] = "close_rite"
                };
                var closeElement = new UiElementInfo
                {
                    elementId = SceneElementId.Semantic("rite_cancel"),
                    role = "button",
                    name = "Cancel / close rite",
                    text = "Close rite panel",
                    visible = true,
                    interactable = true,
                    preferredOp = "cancel",
                    actionParams = closeParams
                };
                snapshot.elements.Add(closeElement);
                snapshot.affordances.Add(new UiAffordanceInfo
                {
                    action = "cancel",
                    targetId = closeElement.elementId,
                    label = closeElement.text,
                    enabled = true,
                    mapsToOp = "cancel",
                    parameters = closeParams
                });
                RegisterTyped(snapshot, closeElement, "cancel", closeParams);
            }

            if (riteStarted || guideWantsRiteStop)
            {
                var clearParams = new Dictionary<string, object>
                {
                    ["hint"] = guideWantsRiteStop
                        ? "BeginGuide RITE_STOP points at the broom — use reset to complete the tutorial"
                        : "Clear the submission before next day and unlock all its cards for repositioning",
                    ["resolvesTo"] = "clear_rite_submission"
                };
                var clearElement = new UiElementInfo
                {
                    elementId = SceneElementId.Semantic("rite_clear_submission"),
                    role = "button",
                    name = "Reset rite submission",
                    text = "Reset submitted rite / unlock cards",
                    overlayId = guideOverlayId,
                    visible = true,
                    interactable = true,
                    preferredOp = "reset",
                    actionParams = clearParams
                };
                snapshot.elements.Add(clearElement);
                snapshot.affordances.Add(new UiAffordanceInfo
                {
                    action = "reset",
                    targetId = clearElement.elementId,
                    label = clearElement.text,
                    enabled = riteStarted,
                    reason = riteStarted ? null : "submitted_rite_not_available",
                    mapsToOp = "reset",
                    parameters = clearParams
                });
                RegisterTyped(snapshot, clearElement, "reset", clearParams);
            }

            // During RITE_STOP guide, only the broom matters — skip slot placement noise.
            if (guideWantsRiteStop) return;

            foreach (var slot in slots)
            {
                if (slot == null) continue;
                var index = 0;
                if (slot.TryGetValue("index", out var indexObj))
                {
                    int.TryParse(indexObj?.ToString(), out index);
                }
                var occupied = false;
                if (slot.TryGetValue("occupied", out var occObj) && occObj != null)
                {
                    occupied = occObj is bool flag ? flag : Convert.ToBoolean(occObj);
                }
                var text = String(slot, "text") ?? ("slot " + index);
                var conditionType = String(slot, "conditionType");
                var label = occupied
                    ? text + " [filled: " + (String(slot, "cardName") ?? ("uid=" + String(slot, "cardUid"))) + "]"
                    : text + (string.IsNullOrEmpty(conditionType) ? "" : " [" + conditionType + "]");
                var op = occupied ? "reset" : "place_card_on_rite";
                var parameters = new Dictionary<string, object>
                {
                    ["slotIndex"] = index,
                    ["slotKey"] = String(slot, "slotKey"),
                    ["text"] = text,
                    ["conditionType"] = conditionType,
                    ["condition"] = String(slot, "condition"),
                    ["isKey"] = slot.TryGetValue("isKey", out var keyObj) ? keyObj : 0,
                    ["occupied"] = occupied,
                    ["cardUid"] = slot.TryGetValue("cardUid", out var uidObj) ? uidObj : null,
                    ["uid"] = occupied ? null : "required — use a concrete place_* affordance below"
                };
                if (occupied)
                {
                    parameters["resolvesTo"] = "cancel_card_placement";
                }
                if (!occupied)
                {
                    parameters["hint"] =
                        "Do not invent uid; submit place_card_on_rite from an enabled place_* affordance with filled uid+slotIndex";
                }

                var targetId = SceneElementId.Semantic("rite_slot_" + index);
                var element = new UiElementInfo
                {
                    elementId = targetId,
                    role = "slot",
                    name = label,
                    text = label,
                    visible = true,
                    interactable = !riteStarted,
                    preferredOp = op,
                    actionParams = parameters,
                    bounds = BoundsForSlot(panel, index)
                };
                snapshot.elements.Add(element);
                // Slot-level place affordance is incomplete (uid missing). Concrete place_* rows are added below.
                if (occupied)
                {
                    var cardUid = parameters.TryGetValue("cardUid", out var cardUidObj) ? cardUidObj : null;
                    var cardName = String(slot, "cardName") ?? ("uid=" + cardUid);
                    var inspectParams = new Dictionary<string, object>
                    {
                        ["uid"] = cardUid,
                        ["slotIndex"] = index,
                        ["slotKey"] = String(slot, "slotKey"),
                        ["cardUid"] = cardUid,
                        ["cardId"] = slot.TryGetValue("cardId", out var cardIdObj) ? cardIdObj : null,
                        ["cardName"] = cardName,
                        ["hint"] = "Inspect filled rite-seat card without closing the panel"
                    };
                    if (slot.TryGetValue("cardSummary", out var cardSummary) && cardSummary != null)
                    {
                        inspectParams["cardSummary"] = cardSummary;
                    }
                    var inspectTargetId = SceneElementId.Semantic("rite_slot_card_" + index);
                    var inspectElement = new UiElementInfo
                    {
                        elementId = inspectTargetId,
                        role = "card",
                        name = cardName,
                        text = cardName + " (rite seat — inspect)",
                        visible = true,
                        interactable = true,
                        preferredOp = "inspect_card",
                        actionParams = inspectParams,
                        bounds = element.bounds
                    };
                    snapshot.elements.Add(inspectElement);
                    snapshot.affordances.Add(new UiAffordanceInfo
                    {
                        action = "inspect",
                        targetId = inspectTargetId,
                        label = "Inspect " + cardName,
                        enabled = true,
                        mapsToOp = "inspect_card",
                        parameters = inspectParams
                    });
                    RegisterTyped(snapshot, inspectElement, "inspect_card", inspectParams);
                }

                if (occupied && !riteStarted)
                {
                    snapshot.affordances.Add(new UiAffordanceInfo
                    {
                        action = "remove",
                        targetId = targetId,
                        label = label,
                        enabled = true,
                        mapsToOp = op,
                        parameters = parameters
                    });
                    RegisterTyped(snapshot, element, op, parameters);
                }
            }

            // While the rite panel is open, expose hand as card identity only (no select_card).
            // Agents fill slots via concrete place_card_on_rite affordances with uid+slotIndex.
            var controller = GameBindings.Controller;
            List<Dictionary<string, object>> hand = null;
            if (controller != null)
            {
                hand = PopulateVisibleHand(snapshot, controller, forRitePlacement: true);
            }

            var placeCount = riteStarted
                ? 0
                : AddAcceptedPlaceAffordances(snapshot, panel, slots, hand);
            bool canConfirm = false;
            try { canConfirm = panel.CheckConfirm(); } catch { /* optional */ }

            if (snapshot.instruction == null || !snapshot.scene.blocking)
            {
                snapshot.instruction = new SceneInstruction
                {
                    source = "rite_panel",
                    type = "fill_rite_slots",
                    text = riteName,
                    hint = riteStarted
                        ? "This rite is submitted and its cards are locked. Keep it running, cancel to close the panel, or reset to unlock and reconfigure it before next day."
                        : (canConfirm
                            ? "Required slots look ready — use execute to submit. You may still place cards or reset individual placements."
                            : "Fill free slots with place_card_on_rite using enabled place_* affordances (uid+slotIndex already filled)."),
                    preferredOp = riteStarted
                        ? "cancel"
                        : (canConfirm ? "execute" : "place_card_on_rite")
                };
            }

            snapshot.diagnostics["ritePanelAdapted"] = true;
            snapshot.diagnostics["riteSlotCount"] = slots.Count;
            snapshot.diagnostics["acceptedPlaceCount"] = placeCount;
        }

        private int AddAcceptedPlaceAffordances(
            SceneSnapshot snapshot,
            RitePanelShowController panel,
            List<Dictionary<string, object>> slots,
            List<Dictionary<string, object>> hand)
        {
            if (panel?.Slots == null || slots == null || hand == null || hand.Count == 0) return 0;

            const int maxPlace = 32;
            var added = 0;
            foreach (var slot in slots)
            {
                if (slot == null) continue;
                var occupied = false;
                if (slot.TryGetValue("occupied", out var occObj) && occObj != null)
                {
                    occupied = occObj is bool flag ? flag : Convert.ToBoolean(occObj);
                }
                if (occupied) continue;

                var index = 0;
                if (slot.TryGetValue("index", out var indexObj))
                {
                    int.TryParse(indexObj?.ToString(), out index);
                }
                if (index < 0 || index >= panel.Slots.Count) continue;
                var slotUi = panel.Slots[index];
                var slotText = String(slot, "text") ?? ("slot " + index);

                foreach (var cardInfo in hand)
                {
                    if (added >= maxPlace) return added;
                    if (cardInfo == null) continue;
                    if (!cardInfo.TryGetValue("uid", out var uidObj) || uidObj == null) continue;
                    if (!int.TryParse(uidObj.ToString(), out var uid)) continue;

                    var card = GameBindings.FindCardByUid(uid);
                    if (card == null) continue;

                    var accepted = true;
                    try
                    {
                        if (slotUi != null) accepted = slotUi.IsCardSatisified(card);
                    }
                    catch
                    {
                        accepted = true;
                    }
                    if (!accepted) continue;

                    var cardName = String(cardInfo, "name")
                                   ?? ConfigCatalog.Instance.ResolveCardName(card.id, card.custom_name, card.Type);
                    var targetId = SceneElementId.Semantic("place_" + index + "_" + uid);
                    var condition = String(slot, "condition");
                    var preferredTag = StackPlaceHelper.PreferredCostTag(cardName, card.Type);
                    var costMin = StackPlaceHelper.ParseCostMin(condition, slotText, preferredTag);
                    if (!costMin.HasValue && slot.TryGetValue("costMin", out var costObj))
                    {
                        int.TryParse(costObj?.ToString(), out var parsed);
                        if (parsed > 0) costMin = parsed;
                    }
                    int stackCount = 1;
                    try { stackCount = Math.Max(1, card.count); } catch { stackCount = 1; }
                    var cardRare = 0;
                    try { cardRare = card.Rare; } catch { /* optional */ }
                    var placeCount = StackPlaceHelper.ResolvePlaceCount(null, stackCount, costMin);
                    var label = placeCount.HasValue
                        ? "Place " + cardName + " x" + placeCount.Value + " → " + slotText + " (slot " + index + ")"
                        : "Place " + cardName + " → " + slotText + " (slot " + index + ")";
                    var parameters = new Dictionary<string, object>
                    {
                        ["uid"] = uid,
                        ["slotIndex"] = index,
                        ["cardName"] = cardName,
                        ["cardType"] = card.Type,
                        ["cardRare"] = cardRare > 0 ? (object)cardRare : null,
                        ["cardTier"] = RiteSlotProjector.FormatTier(cardRare),
                        ["slotText"] = slotText,
                        ["conditionType"] = String(slot, "conditionType"),
                        ["cardCount"] = stackCount
                    };
                    if (costMin.HasValue) parameters["costMin"] = costMin.Value;
                    if (placeCount.HasValue) parameters["count"] = placeCount.Value;
                    var element = new UiElementInfo
                    {
                        elementId = targetId,
                        role = "action",
                        name = label,
                        text = label,
                        visible = true,
                        interactable = true,
                        preferredOp = "place_card_on_rite",
                        actionParams = parameters
                    };
                    snapshot.elements.Add(element);
                    snapshot.affordances.Add(new UiAffordanceInfo
                    {
                        action = "place",
                        targetId = targetId,
                        label = label,
                        enabled = true,
                        mapsToOp = "place_card_on_rite",
                        parameters = parameters
                    });
                    RegisterTyped(snapshot, element, "place_card_on_rite", parameters);
                    added++;
                }
            }

            return added;
        }

        private static UiBounds BoundsForSlot(RitePanelShowController panel, int index)
        {
            try
            {
                if (panel?.Slots == null || index < 0 || index >= panel.Slots.Count) return null;
                var slot = panel.Slots[index];
                return Bounds(slot != null ? slot.GetComponent<RectTransform>() : null);
            }
            catch
            {
                return null;
            }
        }

        private void PopulateMainScreenSemantics(GameState state, SceneSnapshot snapshot)
        {
            if (snapshot.scene.blocking
                || !string.Equals(snapshot.scene.phase, "play", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var controller = GameBindings.Controller;
            if (controller == null) return;
            var prevEnabled = IsActionEnabled(state, "prev_round");
            var nextEnabled = IsActionEnabled(state, "next_day");

            // Intentionally omit StoryEntry / QuestEnter from main-screen affordances.
            // StoryEntry opens meta "一千零一夜"; QuestEnter opens achievements.
            // Neither is part of the daily action chain.
            AddMainControl(snapshot, "game_menu", "Game menu", "button",
                FindDescendant(controller.transform, "Quit"), () => controller.ShowMenu());
            AddMainControl(snapshot, "history", "Historical events", "button",
                FindDescendant(controller.noteListController != null
                        ? controller.noteListController.transform
                        : controller.transform,
                    "Show")
                ?? FindDescendant(controller.transform, "NoteList")
                ?? FindDescendant(controller.transform, "Show"),
                null);
            // Dropzone is not clickable without a card uid — agent must call think_card(uid=...).
            AddMainControl(snapshot, "i_think", "俺寻思 drop zone (submit think_card with uid)", "dropzone",
                controller.IThink, null);
            AddMainControl(snapshot, "card_panel", "Open card organization panel", "button",
                FindDescendant(controller.transform, "BagShow"), null);
            AddMainControl(snapshot, "sultan_card", "Sultan card box", "button",
                controller.SudanBox, () => ClickPointerTarget(
                    controller.SudanBox,
                    controller.SudanBox?.GetComponent<RectTransform>()),
                "open_sudan_box");
            AddMainControl(snapshot, "sort_cards", "Sort cards", "button",
                FindDescendant(controller.transform, "Sort"), () => controller.HandCardSort());
            AddMainControl(snapshot, "previous_round", "Return to previous round", "button",
                FindDescendant(controller.transform, "PrevRound"), null, "prev_round",
                enabled: prevEnabled);
            AddMainControl(snapshot, "next_day", "Advance to next day", "button",
                FindDescendant(controller.transform, "Next Round"), null, "next_day",
                enabled: nextEnabled);

            PopulateCardTiers(snapshot, controller);
            PopulateMainStats(snapshot, controller);
            var hand = PopulateVisibleHand(snapshot, controller, forRitePlacement: false);
            PopulateEquipmentAffordances(snapshot, hand);
            PopulateVisibleMapRites(snapshot, controller);
            snapshot.diagnostics["mainScreenAdapted"] = true;
        }

        private void PopulateEquipmentAffordances(
            SceneSnapshot snapshot,
            List<Dictionary<string, object>> hand)
        {
#if !GAME_INTEROP
            return;
#else
            if (hand == null || hand.Count == 0) return;
            if (OverlayScanner.HasBlocking()) return;
            if (GameBindings.IsUiActive(GameBindings.RitePanel)) return;

            var characters = new List<Card>();
            var items = new List<Card>();
            foreach (var row in hand)
            {
                if (row == null || !row.TryGetValue("uid", out var uidObj)) continue;
                if (!int.TryParse(uidObj?.ToString(), out var uid)) continue;
                var card = GameBindings.FindCardByUid(uid);
                if (card == null) continue;
                if (EquipmentProjector.IsCharacterType(card.Type)
                    && EquipmentProjector.IsEquippableCharacter(card))
                {
                    characters.Add(card);
                }
                else if (EquipmentProjector.IsItemType(card.Type)
                         && EquipmentProjector.HasEquipmentTag(card))
                {
                    items.Add(card);
                }
            }

            var equipCount = 0;
            var unequipCount = 0;
            const int maxEquip = 32;
            foreach (var character in characters)
            {
                var slotTypes = EquipmentProjector.RuntimeEquipSlotTypes(character);
                var equipped = EquipmentProjector.RuntimeEquipped(character);
                foreach (var row in equipped)
                {
                    unequipCount++;
                    if (!row.TryGetValue("uid", out var itemUidObj)
                        || !int.TryParse(itemUidObj?.ToString(), out var equippedUid))
                    {
                        continue;
                    }
                    var slotType = row.TryGetValue("slotType", out var slotObj) ? slotObj?.ToString() : null;
                    var itemName = row.TryGetValue("name", out var nameObj) ? nameObj?.ToString() : ("uid=" + equippedUid);
                    var charName = ConfigCatalog.Instance.ResolveCardName(
                        character.id, character.custom_name, character.Type);
                    var unequipParams = new Dictionary<string, object>
                    {
                        ["characterUid"] = character.uid,
                        ["itemUid"] = equippedUid,
                        ["slotType"] = slotType,
                        ["characterName"] = charName,
                        ["itemName"] = itemName,
                        ["hint"] = "Unequip before swapping the same slot type"
                    };
                    var unequipId = SceneElementId.Semantic(
                        "unequip_" + character.uid + "_" + equippedUid);
                    var unequipElement = new UiElementInfo
                    {
                        elementId = unequipId,
                        role = "equip_slot",
                        name = "Unequip " + itemName + " from " + charName,
                        text = "Unequip " + itemName,
                        visible = true,
                        interactable = true,
                        preferredOp = "unequip_item",
                        actionParams = unequipParams
                    };
                    snapshot.elements.Add(unequipElement);
                    snapshot.affordances.Add(new UiAffordanceInfo
                    {
                        action = "unequip",
                        targetId = unequipId,
                        label = "Unequip " + itemName + " <- " + charName,
                        enabled = true,
                        mapsToOp = "unequip_item",
                        parameters = unequipParams
                    });
                    RegisterTyped(snapshot, unequipElement, "unequip_item", unequipParams);
                }

                foreach (var item in items)
                {
                    if (equipCount >= maxEquip) break;
                    if (EquipmentProjector.FindOwnerOfItem(item.uid) != null) continue;

                    var slotType = EquipmentProjector.NormalizeSlotType(
                        EquipmentProjector.ResolveItemSlotType(item));
                    if (!EquipmentProjector.SlotTypesCompatible(slotTypes, slotType))
                    {
                        continue;
                    }
                    if (!string.IsNullOrWhiteSpace(slotType)
                        && EquipmentProjector.FindEquippedOccupant(character, slotType) != null)
                    {
                        continue;
                    }

                    var charName = ConfigCatalog.Instance.ResolveCardName(
                        character.id, character.custom_name, character.Type);
                    var itemName = ConfigCatalog.Instance.ResolveCardName(
                        item.id, item.custom_name, item.Type);
                    var equipParams = new Dictionary<string, object>
                    {
                        ["characterUid"] = character.uid,
                        ["itemUid"] = item.uid,
                        ["slotType"] = slotType,
                        ["characterName"] = charName,
                        ["itemName"] = itemName,
                        ["hint"] = "Drag path: item onto character; same slot requires unequip first"
                    };
                    var equipId = SceneElementId.Semantic(
                        "equip_" + character.uid + "_" + item.uid);
                    var equipElement = new UiElementInfo
                    {
                        elementId = equipId,
                        role = "equip",
                        name = "Equip " + itemName + " on " + charName,
                        text = "Equip " + itemName,
                        visible = true,
                        interactable = true,
                        preferredOp = "equip_item",
                        actionParams = equipParams
                    };
                    snapshot.elements.Add(equipElement);
                    snapshot.affordances.Add(new UiAffordanceInfo
                    {
                        action = "equip",
                        targetId = equipId,
                        label = "Equip " + itemName + " -> " + charName,
                        enabled = true,
                        mapsToOp = "equip_item",
                        parameters = equipParams
                    });
                    RegisterTyped(snapshot, equipElement, "equip_item", equipParams);
                    equipCount++;
                }
            }

            snapshot.diagnostics["equipAffordanceCount"] = equipCount;
            snapshot.diagnostics["unequipAffordanceCount"] = unequipCount;
#endif
        }

        private void PopulateCardTiers(SceneSnapshot snapshot, GameController controller)
        {
            var bagRoot = controller.BagBtnGroup?.transform;
            var bagGroup = FindDescendant(bagRoot, "BagGroup")?.transform ?? bagRoot;
            if (bagGroup == null) return;
            var tier = 0;
            for (var i = 0; i < bagGroup.childCount && tier < 4; i++)
            {
                var child = bagGroup.GetChild(i)?.gameObject;
                if (child == null || !child.activeInHierarchy) continue;
                var toggle = child.GetComponent<Toggle>();
                if (toggle == null) continue;
                var index = tier;
                tier++;
                var label = "Card tier " + ToRoman(tier);
                AddMainControl(snapshot, "card_tier_" + tier, label, "toggle",
                    child, () => controller.SetBagBtnIsOnWithoutNotify(index));
            }
        }

        // Player.counter ids for the top prestige strip (善名/恶名/权势/侠名/灵视/金骰).
        private static readonly int[] PrestigeCounterIds =
        {
            7100001, 7100002, 7100003, 7100004, 7100005, 7100006
        };

        private void PopulateMainStats(SceneSnapshot snapshot, GameController controller)
        {
            // Stable labels: prestige child TMP often reads placeholder "随意" / icon-only.
            var fallback = new[]
            {
                "善名", "恶名", "权势", "侠名", "灵视", "金骰"
            };
            var keys = new[]
            {
                "good_reputation", "bad_reputation", "power", "chivalry", "mystic_vision", "gold_dice"
            };
            var stats = new List<Dictionary<string, object>>();
            var prestige = controller.prestigeContainer;
            if (prestige != null)
            {
                var visible = 0;
                for (var i = 0; i < prestige.childCount && visible < fallback.Length; i++)
                {
                    var child = prestige.GetChild(i);
                    if (child == null || child.gameObject == null || !child.gameObject.activeInHierarchy) continue;
                    var texts = CollectTexts(child);
                    var title = fallback[visible];
                    var rawTitle = texts.Count > 0 ? texts[0] : null;
                    if (!string.IsNullOrEmpty(rawTitle)
                        && !IsNumericLike(rawTitle)
                        && rawTitle != "随意"
                        && rawTitle.IndexOf("随意", StringComparison.Ordinal) < 0)
                    {
                        title = rawTitle;
                    }
                    string value = null;
                    if (texts.Count > 1)
                    {
                        for (var t = texts.Count - 1; t >= 1; t--)
                        {
                            if (IsNumericLike(texts[t]))
                            {
                                value = texts[t];
                                break;
                            }
                        }
                    }
                    if (string.IsNullOrEmpty(value) && visible < PrestigeCounterIds.Length)
                    {
                        value = (GameBindings.TryGetCounter(PrestigeCounterIds[visible]) ?? 0).ToString();
                    }
                    AddStatus(snapshot, "status_" + visible, title, value, child.gameObject);
                    stats.Add(new Dictionary<string, object>
                    {
                        ["key"] = keys[visible],
                        ["statusId"] = "status_" + visible,
                        ["label"] = title,
                        ["value"] = value,
                        ["counterId"] = PrestigeCounterIds[visible]
                    });
                    visible++;
                }
            }

            var dayValue = BuildExecutionDayValue(controller);
            var dayTarget = FindDescendant(controller.transform, "RoundNumber")
                            ?? FindDescendant(controller.transform, "RoundNumber BG");
            AddStatus(snapshot, "execution_day", "Execution day", dayValue, dayTarget);
            stats.Add(new Dictionary<string, object>
            {
                ["key"] = "execution_day",
                ["label"] = "Execution day",
                ["value"] = dayValue
            });
            snapshot.telemetry["mainStats"] = stats;
        }

        private static string BuildExecutionDayValue(GameController controller)
        {
            var round = 0;
            var initLife = 0;
            try
            {
                if (GameBindings.Player != null)
                {
                    round = GameBindings.Player.round;
                    initLife = GameBindings.Player.sudan_card_init_life;
                }
            }
            catch
            {
                // optional
            }
            if (round <= 0 && controller != null)
            {
                try { round = controller.CurrentRoundNumber; } catch { /* optional */ }
            }

            // Prefer most urgent card-face countdown across all held Sudan cards.
            int? urgentLife = null;
            try
            {
                var all = GameBindings.ReadAllSudanCardSummaries();
                foreach (var row in all)
                {
                    if (row != null
                        && row.TryGetValue("life", out var lifeObj)
                        && lifeObj is int lifeInt)
                    {
                        if (urgentLife == null || lifeInt > urgentLife.Value)
                        {
                            urgentLife = lifeInt;
                        }
                    }
                }
            }
            catch
            {
                // optional
            }
            if (urgentLife == null)
            {
                try
                {
                    var card = GameBindings.FindCurrentSudanCard();
                    if (card != null) urgentLife = card.life;
                }
                catch
                {
                    // optional
                }
            }
            var formatted = SceneInteractionPolicy.FormatExecutionDay(round, initLife, urgentLife);
            if (!string.IsNullOrEmpty(formatted) && formatted.Contains("/"))
            {
                return formatted;
            }

            var dayText = ReadDescendantText(FindDescendant(controller.transform, "RoundNumber")?.transform)
                          ?? ReadDescendantText(FindDescendant(controller.transform, "RoundNumber BG")?.transform);
            if (!string.IsNullOrEmpty(dayText) && dayText.Contains("/") && IsNumericLike(dayText.Replace("/", "")))
            {
                return dayText;
            }
            return formatted ?? (string.IsNullOrEmpty(dayText) ? null : dayText);
        }

        private List<Dictionary<string, object>> PopulateVisibleHand(
            SceneSnapshot snapshot,
            GameController controller,
            bool forRitePlacement)
        {
            var hand = new List<Dictionary<string, object>>();
            var seen = new HashSet<int>();
            try
            {
                // Primary authority: CardController widgets under GameController.hand.
                // cardInfos maps to CardInfoNewController detail panels, which are often inactive.
                var handRoot = controller.hand;
                if (handRoot != null)
                {
                    var widgets = handRoot.GetComponentsInChildren<CardController>(true);
                    snapshot.diagnostics["handWidgetCount"] = widgets != null ? widgets.Length : 0;
                    if (widgets != null)
                    {
                        for (var i = 0; i < widgets.Length && hand.Count < MaxVisibleHand; i++)
                        {
                            var widget = widgets[i];
                            if (widget == null || widget.gameObject == null || !widget.gameObject.activeInHierarchy)
                            {
                                continue;
                            }
                            var card = widget.card;
                            if (card == null || !seen.Add(card.uid)) continue;
                            AppendHandCard(
                                snapshot, hand, card, widget.gameObject, widget.GetComponent<RectTransform>(),
                                forRitePlacement);
                        }
                    }
                }

                // Fallback: any still-active cardInfos detail widgets.
                if (hand.Count == 0)
                {
                    var infos = controller.cardInfos;
                    snapshot.diagnostics["cardInfoCount"] = infos != null ? infos.Count : 0;
                    if (infos != null)
                    {
                        var activeInfos = 0;
                        foreach (var kv in infos)
                        {
                            if (hand.Count >= MaxVisibleHand) break;
                            var card = kv.Key;
                            var info = kv.Value;
                            if (card == null || info == null || info.gameObject == null) continue;
                            if (!info.gameObject.activeInHierarchy) continue;
                            activeInfos++;
                            if (!seen.Add(card.uid)) continue;
                            AppendHandCard(
                                snapshot, hand, card, info.gameObject, info.GetComponent<RectTransform>(),
                                forRitePlacement);
                        }
                        snapshot.diagnostics["cardInfoActiveCount"] = activeInfos;
                    }
                }
            }
            catch (Exception ex)
            {
                snapshot.diagnostics["handProjectionError"] = ex.Message;
            }
            snapshot.telemetry["hand"] = hand;
            snapshot.diagnostics["visibleHandCount"] = hand.Count;
            return hand;
        }

        private void AppendHandCard(
            SceneSnapshot snapshot,
            List<Dictionary<string, object>> hand,
            Card card,
            GameObject target,
            RectTransform boundsSource,
            bool forRitePlacement)
        {
            var name = ConfigCatalog.Instance.ResolveCardName(card.id, card.custom_name, card.Type);
            var targetId = SceneElementId.Semantic("hand_" + card.uid);
            var rare = 0;
            try { rare = card.Rare; } catch { /* optional */ }
            var tier = RiteSlotProjector.FormatTier(rare);
            var parameters = new Dictionary<string, object>
            {
                ["uid"] = card.uid,
                ["type"] = card.Type,
                ["name"] = name,
                ["rare"] = rare > 0 ? (object)rare : null,
                ["tier"] = tier
            };
            var element = new UiElementInfo
            {
                elementId = targetId,
                role = "card",
                name = name,
                text = name,
                visible = true,
                interactable = !forRitePlacement,
                preferredOp = forRitePlacement ? null : "select_card",
                actionParams = parameters,
                bounds = Bounds(boundsSource),
                instanceId = target != null ? target.GetInstanceID() : 0
            };
            snapshot.elements.Add(element);
            if (!forRitePlacement)
            {
                snapshot.affordances.Add(new UiAffordanceInfo
                {
                    action = "select",
                    targetId = targetId,
                    label = name,
                    enabled = true,
                    mapsToOp = "select_card",
                    parameters = parameters
                });
                RegisterTyped(snapshot, element, "select_card", parameters);
            }
            hand.Add(new Dictionary<string, object>
            {
                ["uid"] = card.uid,
                ["id"] = card.id,
                ["type"] = card.Type,
                ["name"] = name,
                ["rare"] = rare > 0 ? (object)rare : null,
                ["tier"] = tier,
                ["life"] = card.life,
                ["count"] = card.count
            });
        }

        private void PopulateVisibleMapRites(SceneSnapshot snapshot, GameController controller)
        {
            var mapNodes = new List<Dictionary<string, object>>();
            var hand = snapshot.telemetry != null
                       && snapshot.telemetry.TryGetValue("hand", out var handObj)
                       && handObj is List<Dictionary<string, object>> handList
                ? handList
                : null;
            try
            {
                var view = GameBindings.GetVisibleMapRites();
                snapshot.diagnostics["mapViewCount"] = view != null ? view.Count : 0;
                if (view != null)
                {
                    var count = 0;
                    for (var i = 0; i < view.Count && count < MaxMapRites; i++)
                    {
                        var riteUi = view[i];
                        if (riteUi == null || riteUi.rite == null || riteUi.gameObject == null) continue;
                        if (!riteUi.gameObject.activeInHierarchy) continue;
                        var rite = riteUi.rite;
                        var name = ConfigCatalog.Instance.ResolveRiteName(rite.id, rite.custom_name);
                        try
                        {
                            // Prefer config/custom titles; PopText is often a shared bubble placeholder.
                            var pop = SceneText.Normalize(riteUi.PopText != null ? riteUi.PopText.text : null);
                            if (!string.IsNullOrEmpty(pop)
                                && (string.IsNullOrEmpty(name) || name.StartsWith("rite#", StringComparison.Ordinal)))
                            {
                                name = pop;
                            }
                        }
                        catch
                        {
                            // optional bubble text
                        }
                        var targetId = SceneElementId.Semantic("map_rite_" + rite.uid);
                        var parameters = new Dictionary<string, object> { ["uid"] = rite.uid };
                        var filled = 0;
                        if (rite.cards != null)
                        {
                            for (var c = 0; c < rite.cards.Count; c++)
                            {
                                if (rite.cards[c] != null) filled++;
                            }
                        }
                        var node = new Dictionary<string, object>
                        {
                            ["uid"] = rite.uid,
                            ["id"] = rite.id,
                            ["name"] = name,
                            ["life"] = rite.life,
                            ["start"] = rite.start,
                            ["slotsFilled"] = filled
                        };
                        RiteSlotProjector.AttachClosedRiteMatchFields(node, rite.id, hand);
                        if (node.TryGetValue("handMatchCount", out var hmc))
                        {
                            parameters["handMatchCount"] = hmc;
                        }
                        var element = new UiElementInfo
                        {
                            elementId = targetId,
                            role = "map_node",
                            name = name,
                            text = name,
                            visible = true,
                            interactable = true,
                            preferredOp = "open_rite",
                            actionParams = parameters,
                            bounds = Bounds(riteUi.GetComponent<RectTransform>() ?? riteUi.bound),
                            instanceId = riteUi.gameObject.GetInstanceID()
                        };
                        snapshot.elements.Add(element);
                        snapshot.affordances.Add(new UiAffordanceInfo
                        {
                            action = "click",
                            targetId = targetId,
                            label = name,
                            enabled = true,
                            mapsToOp = "open_rite",
                            parameters = parameters
                        });
                        RegisterTyped(snapshot, element, "open_rite", parameters);
                        mapNodes.Add(node);
                        count++;
                    }
                }
            }
            catch (Exception ex)
            {
                snapshot.diagnostics["mapProjectionError"] = ex.Message;
            }
            snapshot.telemetry["mapRites"] = mapNodes;
            snapshot.diagnostics["visibleMapRiteCount"] = mapNodes.Count;
        }

        private static bool IsNumericLike(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return false;
            foreach (var ch in text)
            {
                if (char.IsDigit(ch) || ch == '/' || ch == '-' || ch == '+' || ch == '.' || ch == ' ')
                {
                    continue;
                }
                return false;
            }
            return true;
        }

        private void AddMainControl(
            SceneSnapshot snapshot,
            string key,
            string label,
            string role,
            GameObject target,
            System.Action action,
            string mapsToOp = null,
            Dictionary<string, object> actionParams = null,
            bool enabled = true)
        {
            if (target == null || !target.activeInHierarchy) return;
            var elementId = SceneElementId.Semantic("main_" + key);
            if (snapshot.elements.Exists(e => e != null && e.elementId == elementId)) return;

            if (action == null && mapsToOp == null && (role == "button" || role == "toggle"))
            {
                var button = target.GetComponent<Button>();
                var toggle = target.GetComponent<Toggle>();
                if (button != null && button.IsInteractable())
                {
                    action = () => button.onClick.Invoke();
                }
                else if (toggle != null && toggle.IsInteractable())
                {
                    action = () => toggle.isOn = true;
                }
                else if (ExecuteEvents.CanHandleEvent<IPointerClickHandler>(target))
                {
                    action = () => ClickPointerTarget(target, target.GetComponent<RectTransform>());
                }
            }

            var interactable = (mapsToOp != null || action != null) && enabled;
            var element = new UiElementInfo
            {
                elementId = elementId,
                role = role,
                name = label,
                text = label,
                visible = true,
                interactable = interactable,
                blocked = mapsToOp != null && !enabled,
                preferredOp = mapsToOp,
                actionParams = Copy(actionParams),
                bounds = Bounds(target.GetComponent<RectTransform>()),
                instanceId = target.GetInstanceID()
            };
            snapshot.elements.Add(element);
            if (mapsToOp != null || action != null)
            {
                snapshot.affordances.Add(new UiAffordanceInfo
                {
                    action = mapsToOp ?? "click",
                    targetId = element.elementId,
                    label = label,
                    enabled = enabled,
                    reason = enabled ? null : "action_disabled",
                    mapsToOp = mapsToOp
                });
            }
            _registry.Register(new UiAdapterRegistry.ElementHandle
            {
                elementId = element.elementId,
                snapshotVersion = snapshot.snapshotVersion,
                mapsToOp = mapsToOp,
                actionParams = Copy(actionParams),
                visible = true,
                interactable = interactable,
                blocked = !enabled,
                gameObject = target,
                click = mapsToOp == null ? action : null
            });
        }

        private static bool IsActionEnabled(GameState state, string actionId)
        {
            if (state?.actions == null) return false;
            foreach (var action in state.actions)
            {
                if (action != null && string.Equals(action.id, actionId, StringComparison.OrdinalIgnoreCase))
                {
                    return action.enabled;
                }
            }
            return false;
        }

        private static void AddStatus(
            SceneSnapshot snapshot,
            string key,
            string label,
            object value,
            GameObject target)
        {
            snapshot.elements.Add(new UiElementInfo
            {
                elementId = SceneElementId.Semantic("main_" + key),
                role = "status",
                name = label,
                text = value == null || string.IsNullOrWhiteSpace(value.ToString())
                    ? label
                    : label + ": " + value,
                visible = true,
                interactable = false,
                bounds = target != null ? Bounds(target.GetComponent<RectTransform>()) : null,
                instanceId = target != null ? target.GetInstanceID() : 0
            });
        }

        private static List<string> CollectTexts(Transform root)
        {
            var list = new List<string>();
            if (root == null) return list;
            try
            {
                var tmps = root.GetComponentsInChildren<TMP_Text>(true);
                if (tmps != null)
                {
                    foreach (var item in tmps)
                    {
                        if (item == null || item.gameObject == null || !item.gameObject.activeInHierarchy) continue;
                        var text = SceneText.Normalize(item.text);
                        if (!string.IsNullOrEmpty(text) && !list.Contains(text)) list.Add(text);
                    }
                }
                var texts = root.GetComponentsInChildren<Text>(true);
                if (texts != null)
                {
                    foreach (var item in texts)
                    {
                        if (item == null || item.gameObject == null || !item.gameObject.activeInHierarchy) continue;
                        var text = SceneText.Normalize(item.text);
                        if (!string.IsNullOrEmpty(text) && !list.Contains(text)) list.Add(text);
                    }
                }
            }
            catch
            {
                // best effort
            }
            return list;
        }

        private static string ToRoman(int value)
        {
            return value switch
            {
                1 => "I",
                2 => "II",
                3 => "III",
                4 => "IV",
                _ => value.ToString()
            };
        }

        private static GameObject FindDescendant(Transform root, string name)
        {
            if (root == null || string.IsNullOrEmpty(name)) return null;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                if (current?.gameObject == null) continue;
                if (string.Equals(current.gameObject.name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return current.gameObject;
                }
                for (var i = 0; i < current.childCount; i++) queue.Enqueue(current.GetChild(i));
            }
            return null;
        }

        private void ScanUnityUi(GameState state, SceneSnapshot snapshot)
        {
            var roots = CollectRoots(snapshot);
            var visited = new HashSet<int>();
            var textSignatures = new HashSet<string>(StringComparer.Ordinal);
            var queue = new Queue<ScanNode>();
            foreach (var root in roots)
            {
                if (root.transform == null) continue;
                queue.Enqueue(root);
            }

            var nodes = 0;
            while (queue.Count > 0 && nodes < MaxNodes && snapshot.elements.Count < MaxElements)
            {
                var node = queue.Dequeue();
                var transform = node.transform;
                if (transform == null || transform.gameObject == null) continue;
                var go = transform.gameObject;
                var instanceId = go.GetInstanceID();
                if (!visited.Add(instanceId)) continue;
                nodes++;

                if (!go.activeInHierarchy) continue;
                var path = BuildPath(transform);
                var parentId = node.parentId;
                var currentParent = parentId;
                var isStoryNotifyPath = path.IndexOf("StoryNotify", StringComparison.OrdinalIgnoreCase) >= 0;
                if (string.Equals(go.name, "ModelBG", StringComparison.OrdinalIgnoreCase)
                    || (IsNoisePath(path) && !isStoryNotifyPath))
                {
                    continue;
                }

                var button = go.GetComponent<Button>();
                var toggle = go.GetComponent<Toggle>();
                var input = go.GetComponent<TMP_InputField>();
                var tmp = go.GetComponent<TMP_Text>();
                var legacyText = go.GetComponent<Text>();
                var pointerClickable = button == null
                                       && toggle == null
                                       && input == null
                                       && ExecuteEvents.CanHandleEvent<IPointerClickHandler>(go)
                                       && !IsNoiseUiName(go.name)
                                       && !isStoryNotifyPath;

                var skipStoryNotifyInteractable = isStoryNotifyPath;
                if (button != null && !IsNoiseUiName(go.name) && !skipStoryNotifyInteractable)
                {
                    var element = BuildSelectable(snapshot, transform, path, node.overlayId, "button",
                        ReadDescendantText(transform) ?? go.name, button.IsInteractable(), false);
                    AddRuntimeElement(snapshot, element, button, () => button.onClick.Invoke());
                    currentParent = element.elementId;
                }
                else if (toggle != null && !skipStoryNotifyInteractable)
                {
                    var element = BuildSelectable(snapshot, transform, path, node.overlayId, "toggle",
                        ReadDescendantText(transform) ?? go.name, toggle.IsInteractable(), toggle.isOn);
                    AddRuntimeElement(snapshot, element, toggle, () => toggle.isOn = true);
                    currentParent = element.elementId;
                }
                else if (input != null && !skipStoryNotifyInteractable)
                {
                    var element = BuildSelectable(snapshot, transform, path, node.overlayId, "input",
                        SceneText.Normalize(input.text) ?? go.name, input.IsInteractable(), false);
                    AddRuntimeElement(snapshot, element, input, null);
                    currentParent = element.elementId;
                }
                else if (pointerClickable)
                {
                    var element = BuildSelectable(snapshot, transform, path, node.overlayId, "button",
                        ReadDescendantText(transform) ?? go.name, true, false);
                    AddRuntimeElement(snapshot, element, go,
                        () => ClickPointerTarget(go, go.GetComponent<RectTransform>()));
                    currentParent = element.elementId;
                }
                else
                {
                    var text = SceneText.Normalize(tmp != null ? tmp.text : legacyText != null ? legacyText.text : null);
                    if (!string.IsNullOrEmpty(text))
                    {
                        var signature = (node.overlayId ?? "") + "|" + text;
                        if (textSignatures.Add(signature))
                        {
                            var element = new UiElementInfo
                            {
                                elementId = SceneElementId.Create(snapshot.scene.id, path, "text"),
                                parentId = parentId,
                                role = "text",
                                name = text,
                                text = text,
                                path = path,
                                overlayId = isStoryNotifyPath ? "daily_news" : node.overlayId,
                                visible = true,
                                interactable = false,
                                bounds = Bounds(go.GetComponent<RectTransform>()),
                                instanceId = instanceId
                            };
                            snapshot.elements.Add(element);
                            currentParent = element.elementId;
                        }
                    }
                }

                if (node.depth >= MaxDepth) continue;
                for (var i = 0; i < transform.childCount; i++)
                {
                    queue.Enqueue(new ScanNode
                    {
                        transform = transform.GetChild(i),
                        parentId = currentParent,
                        overlayId = node.overlayId,
                        depth = node.depth + 1
                    });
                }
            }

            if (queue.Count > 0 || snapshot.elements.Count >= MaxElements) snapshot.truncated = true;
            snapshot.diagnostics["scannedNodes"] = nodes;
            snapshot.diagnostics["rootCount"] = roots.Count;
        }

        private static string GuidePreferredOp(GameState state)
        {
            if (state?.values != null
                && state.values.TryGetValue("guide", out var raw)
                && raw is Dictionary<string, object> guide
                && guide.TryGetValue("preferredOp", out var preferred)
                && preferred is string op
                && !string.IsNullOrWhiteSpace(op))
            {
                return op;
            }

            try
            {
                var snap = GameBindings.ReadBeginGuideSnapshot();
                if (snap != null
                    && snap.TryGetValue("preferredOp", out var live)
                    && live is string liveOp
                    && !string.IsNullOrWhiteSpace(liveOp))
                {
                    return liveOp;
                }
            }
            catch
            {
                // optional
            }

            return null;
        }

        private List<ScanNode> CollectRoots(SceneSnapshot snapshot)
        {
            var roots = new List<ScanNode>();
            var riteOpen = GameBindings.IsUiActive(GameBindings.RitePanel);
            var modal = snapshot.scene?.modal;
            foreach (var overlay in OverlayScanner.Scan())
            {
                if (overlay?.behaviour == null || !GameBindings.IsUiActive(overlay.behaviour)) continue;
                var isModal = !string.IsNullOrEmpty(modal)
                              && string.Equals(overlay.id, modal, StringComparison.OrdinalIgnoreCase);
                // Keep the blocking modal (e.g. begin_guide) even while the rite panel is open.
                if (riteOpen
                    && !string.Equals(overlay.id, "rite", StringComparison.OrdinalIgnoreCase)
                    && !isModal)
                {
                    continue;
                }
                if (snapshot.scene.blocking
                    && !isModal
                    && !string.Equals(overlay.id, "rite", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                roots.Add(new ScanNode
                {
                    transform = overlay.behaviour.transform,
                    overlayId = overlay.id,
                    depth = 0
                });
            }

            var controller = GameBindings.Controller;
            if (!snapshot.scene.blocking
                && !riteOpen
                && controller != null
                && controller.gameObject != null
                && controller.gameObject.activeInHierarchy)
            {
                roots.Add(new ScanNode { transform = controller.transform, overlayId = null, depth = 0 });
            }
            return roots;
        }

        private UiElementInfo BuildSelectable(
            SceneSnapshot snapshot,
            Transform transform,
            string path,
            string overlayId,
            string role,
            string label,
            bool interactable,
            bool selected)
        {
            var guideBlocksGeneric = snapshot.scene.blocking
                                     && !string.Equals(
                                         overlayId,
                                         snapshot.scene.modal,
                                         StringComparison.OrdinalIgnoreCase);
            return new UiElementInfo
            {
                elementId = SceneElementId.Create(snapshot.scene.id, path, role),
                role = role,
                name = SceneText.Normalize(label) ?? transform.gameObject.name,
                text = SceneText.Normalize(label),
                path = path,
                overlayId = overlayId,
                visible = true,
                interactable = interactable && !guideBlocksGeneric,
                selected = selected,
                blocked = guideBlocksGeneric,
                bounds = Bounds(transform.gameObject.GetComponent<RectTransform>()),
                instanceId = transform.gameObject.GetInstanceID()
            };
        }

        private void AddRuntimeElement(
            SceneSnapshot snapshot,
            UiElementInfo element,
            UnityEngine.Object target,
            System.Action click)
        {
            snapshot.elements.Add(element);
            if (element.interactable && click != null)
            {
                snapshot.affordances.Add(new UiAffordanceInfo
                {
                    action = "click",
                    targetId = element.elementId,
                    label = element.name,
                    enabled = true
                });
            }
            _registry.Register(new UiAdapterRegistry.ElementHandle
            {
                elementId = element.elementId,
                snapshotVersion = snapshot.snapshotVersion,
                visible = element.visible,
                interactable = element.interactable && click != null,
                blocked = element.blocked,
                gameObject = target is Component component ? component.gameObject : null,
                click = click
            });
        }

        private static string ReadDescendantText(Transform root)
        {
            try
            {
                var tmps = root.GetComponentsInChildren<TMP_Text>(true);
                if (tmps != null)
                {
                    foreach (var item in tmps)
                    {
                        if (item == null || item.gameObject == null || !item.gameObject.activeInHierarchy) continue;
                        var text = SceneText.Normalize(item.text);
                        if (!string.IsNullOrEmpty(text)) return text;
                    }
                }
                var texts = root.GetComponentsInChildren<Text>(true);
                if (texts != null)
                {
                    foreach (var item in texts)
                    {
                        if (item == null || item.gameObject == null || !item.gameObject.activeInHierarchy) continue;
                        var text = SceneText.Normalize(item.text);
                        if (!string.IsNullOrEmpty(text)) return text;
                    }
                }
            }
            catch
            {
                // Best effort UI description.
            }
            return null;
        }

        private static string BuildPath(Transform transform)
        {
            var parts = new List<string>();
            var current = transform;
            var depth = 0;
            while (current != null && depth++ < 16)
            {
                parts.Add((current.gameObject?.name ?? current.name) + "[" + current.GetSiblingIndex() + "]");
                current = current.parent;
            }
            parts.Reverse();
            return string.Join("/", parts);
        }

        private static UiBounds Bounds(RectTransform rect)
        {
            if (rect == null) return null;
            try
            {
                var local = rect.rect;
                var camera = UiCamera(rect);
                var min = RectTransformUtility.WorldToScreenPoint(camera,
                    rect.TransformPoint(new Vector3(local.xMin, local.yMin, 0f)));
                var max = RectTransformUtility.WorldToScreenPoint(camera,
                    rect.TransformPoint(new Vector3(local.xMax, local.yMax, 0f)));
                return new UiBounds
                {
                    x = Math.Min(min.x, max.x),
                    y = Math.Min(min.y, max.y),
                    width = Math.Abs(max.x - min.x),
                    height = Math.Abs(max.y - min.y)
                };
            }
            catch
            {
                return null;
            }
        }

        private static Camera UiCamera(RectTransform rect)
        {
            var canvas = rect != null ? rect.GetComponentInParent<Canvas>() : null;
            if (canvas == null || canvas.renderMode == RenderMode.ScreenSpaceOverlay) return null;
            return canvas.worldCamera != null ? canvas.worldCamera : Camera.main;
        }

        private static void ClickPointerTarget(GameObject target, RectTransform rect)
        {
            if (target == null) return;
            var eventSystem = EventSystem.current;
            if (eventSystem == null)
            {
                throw new InvalidOperationException("EventSystem.current is null");
            }
            var pointer = new PointerEventData(eventSystem);
            if (rect != null)
            {
                pointer.position = RectTransformUtility.WorldToScreenPoint(UiCamera(rect), rect.position);
            }
            ExecuteEvents.Execute(target, pointer, ExecuteEvents.pointerClickHandler);
        }
#endif

        private static bool IsNoiseUiName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return true;
            return name.Equals("ModelBG", StringComparison.OrdinalIgnoreCase)
                   || name.Equals("GameObject", StringComparison.OrdinalIgnoreCase)
                   || name.Equals("Image", StringComparison.OrdinalIgnoreCase)
                   || name.Equals("Background", StringComparison.OrdinalIgnoreCase)
                   || name.Equals("AutoPlay", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsNoisePath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            return path.IndexOf("/UI[", StringComparison.OrdinalIgnoreCase) >= 0
                   && path.IndexOf("ModelBG", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string KnownTargetId(string actionId)
        {
            return actionId switch
            {
                "draw_sudan_card" => SceneElementId.Semantic("sudan_box"),
                "open_sudan_box" => SceneElementId.Semantic("main_sultan_card"),
                "exchange_sudan_card" => SceneElementId.Semantic("exchange_sudan_card"),
                "open_daily_news" => SceneElementId.Semantic("daily_news"),
                "continue" => SceneElementId.Semantic("continue"),
                "next_day" => SceneElementId.Semantic("main_next_day"),
                "next_round" => SceneElementId.Semantic("main_next_day"),
                "execute" => SceneElementId.Semantic("execute"),
                "cancel" => SceneElementId.Semantic("cancel"),
                "reset" => SceneElementId.Semantic("reset"),
                "prev_round" => SceneElementId.Semantic("main_previous_round"),
                "select_difficulty" => SceneElementId.Semantic("difficulty_confirm"),
                "select_gold_dice" => SceneElementId.Semantic("gold_dice"),
                "confirm_gold_dice" => SceneElementId.Semantic("gold_confirm"),
                "cancel_gold_dice" => SceneElementId.Semantic("gold_cancel"),
                _ => SceneElementId.Semantic(actionId)
            };
        }

        private static string RoleForAction(string actionId)
        {
            return actionId switch
            {
                "select_card" => "card",
                "place_card_on_rite" => "slot",
                _ => "button"
            };
        }

        private static Dictionary<string, object> Copy(Dictionary<string, object> source)
        {
            return source == null ? null : new Dictionary<string, object>(source);
        }

        private static string String(Dictionary<string, object> map, string key)
        {
            return map != null && map.TryGetValue(key, out var value) ? value?.ToString() : null;
        }

        private static bool Bool(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.TryGetValue(key, out var value) || value == null) return false;
            if (value is bool b) return b;
            return bool.TryParse(value.ToString(), out var parsed) && parsed;
        }
    }
}
