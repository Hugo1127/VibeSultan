using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using VibeSultan.Sultan.Observer.State;

namespace VibeSultan.Sultan.Observer.Action
{
    public sealed class ActionExecutor
    {
        private readonly GameVersionGuard _versionGuard;

        public ActionExecutor(GameVersionGuard versionGuard)
        {
            _versionGuard = versionGuard;
        }

        public List<ActionResultDto> ExecuteBatch(List<JObject> actions)
        {
            var results = new List<ActionResultDto>();
            if (actions == null || actions.Count == 0)
            {
                return results;
            }

            foreach (var action in actions)
            {
                results.Add(ExecuteOne(action));
            }

            return results;
        }

        private ActionResultDto ExecuteOne(JObject action)
        {
            var id = action?.Value<string>("id");
            var op = action?.Value<string>("op");
            if (string.IsNullOrWhiteSpace(op))
            {
                return Fail(id, op, "missing_op", null);
            }

            op = op.Trim();
            var aliased = IntentPolicy.AliasLegacyOp(op);
            if (!string.Equals(aliased, op, StringComparison.OrdinalIgnoreCase)
                && IsIntent(aliased))
            {
                var mapped = action != null ? (JObject)action.DeepClone() : new JObject();
                mapped["op"] = aliased;
                if (string.IsNullOrWhiteSpace(mapped.Value<string>("id"))) mapped["id"] = id;
                var result = ExecuteOne(mapped);
                result.detail = (string.IsNullOrEmpty(result.detail) ? "" : result.detail + " ")
                                + "aliasedFrom=" + op;
                return result;
            }

            if (_versionGuard != null && !_versionGuard.IsSafe && IsDangerous(op))
            {
                return Fail(id, op, "version_mismatch", _versionGuard.Detail);
            }

            try
            {
#if !GAME_INTEROP
                if (op == "noop") return Ok(id, op, "noop");
                if (op == "probe_types") return Probe(id, op);
                if (IsIntent(op))
                {
                    return IntentRouter.Dispatch(id, op, action, ExecuteDomainOne);
                }
                return Fail(id, op, "binding_missing", "Compiled without GAME_INTEROP; launch game once to generate interop.");
#else
                if (IsIntent(op))
                {
                    return IntentRouter.Dispatch(id, op, action, ExecuteDomainOne);
                }

                return ExecuteDomainOne(action);
#endif
            }
            catch (Exception ex)
            {
                return Fail(id, op, "exception", ex.GetType().Name + ": " + ex.Message);
            }
        }

        private static bool IsIntent(string op)
        {
            return op is "continue" or "execute" or "cancel" or "reset";
        }

        private static bool IsDangerous(string op)
        {
            return op is "start_rite" or "clear_rite_submission" or "close_rite"
                or "place_card_on_rite" or "cancel_card_placement"
                or "equip_item" or "unequip_item"
                or "start_new_game" or "continue_game" or "next_day" or "next_round" or "prev_round"
                or "open_rite" or "open_daily_news" or "inspect_card" or "think_card" or "click_element"
                or "open_sudan_box" or "close_sudan_box" or "exchange_sudan_card"
                or "select_gold_dice" or "confirm_gold_dice" or "cancel_gold_dice"
                or "continue" or "execute" or "cancel" or "reset";
        }

        /// <summary>
        /// Domain ops only — never aliases intents (prevents IntentRouter recursion).
        /// </summary>
        private ActionResultDto ExecuteDomainOne(JObject action)
        {
            var id = action?.Value<string>("id");
            var op = action?.Value<string>("op");
            if (string.IsNullOrWhiteSpace(op))
            {
                return Fail(id, op, "missing_op", null);
            }

            op = op.Trim();
#if !GAME_INTEROP
            if (op == "noop") return Ok(id, op, "noop");
            if (op == "probe_types") return Probe(id, op);
            return Fail(id, op, "binding_missing", "Compiled without GAME_INTEROP; launch game once to generate interop.");
#else
            return op switch
            {
                "noop" => Ok(id, op, "noop"),
                "probe_types" => Probe(id, op),
                "start_new_game" => StartNewGame(id, op, action),
                "continue_game" => ContinueGame(id, op, action),
                "select_difficulty" => SelectDifficulty(id, op, action),
                "select_event_option" => SelectEventOption(id, op, action),
                "draw_sudan_card" => DrawSudanCard(id, op),
                "open_sudan_box" => OpenSudanBox(id, op),
                "close_sudan_box" => CloseSudanBox(id, op),
                "exchange_sudan_card" => ExchangeSudanCard(id, op),
                "click_element" => ClickElement(id, op, action),
                "select_card" => SelectCard(id, op, action),
                "inspect_card" => InspectCard(id, op, action),
                "think_card" => ThinkCard(id, op, action),
                "open_daily_news" => OpenDailyNews(id, op),
                "select_gold_dice" => SelectGoldDice(id, op),
                "confirm_gold_dice" => ConfirmGoldDice(id, op),
                "cancel_gold_dice" => CancelGoldDice(id, op),
                "place_card_on_rite" => PlaceCardOnRite(id, op, action),
                "cancel_card_placement" => CancelCardPlacement(id, op, action),
                "equip_item" => EquipItem(id, op, action),
                "unequip_item" => UnequipItem(id, op, action),
                "start_rite" => StartRite(id, op),
                "clear_rite_submission" => ClearRiteSubmission(id, op),
                "close_rite" => CloseRite(id, op),
                "open_rite" => OpenRite(id, op, action),
                "next_day" => NextRound(id, op),
                "next_round" => NextRound(id, op),
                "prev_round" => PrevRound(id, op),
                _ => Fail(id, op, "unknown_op", null)
            };
#endif
        }

        private ActionResultDto Probe(string id, string op)
        {
            var report = TypeProbe.Probe();
            var count = report.TryGetValue("hitCount", out var c) ? c : 0;
            return Ok(id, op, "hitCount=" + count + " bindings=" + (GameBindings.HasInterop ? "interop" : "stub"));
        }

#if GAME_INTEROP
        private static ActionResultDto StartNewGame(string id, string op, JObject action)
        {
            // InitDone may still be false on InitScene; allow the load call and report status.
            var initId = FirstInt(action, "initId", "id");
            if (!initId.HasValue || initId.Value <= 0)
            {
                initId = GameBindings.NeedNewInitId;
            }
            if (!initId.HasValue || initId.Value <= 0)
            {
                initId = 1;
            }

            var beforeRound = GameBindings.Player?.round;
            GameBindings.LoadNewGame(initId.Value);
            return Ok(
                id,
                op,
                "LoadController.LoadNewGame(" + initId.Value + ") beforeRound=" + beforeRound
                + " initDone=" + GameBindings.InitDone);
        }

        private static ActionResultDto ContinueGame(string id, string op, JObject action)
        {
            if (GameBindings.InGame && GameBindings.Player != null)
            {
                return Fail(id, op, "already_in_game", "continue_game is only valid on the start screen");
            }
            var round = FirstInt(action, "round");
            if (!round.HasValue || round.Value <= 0)
            {
                round = GameBindings.NeedLoadRound;
            }
            if (!round.HasValue || round.Value <= 0)
            {
                return Fail(
                    id,
                    op,
                    "no_saved_round",
                    "LoadController reports no positive saved round; refusing to load round_0.json");
            }

            GameBindings.LoadRound(round.Value, begin: true);
            return Ok(id, op, "LoadController.LoadRound(" + round.Value + ", true)");
        }

        private static ActionResultDto DrawSudanCard(string id, string op)
        {
            var top = OverlayScanner.TopBlocking();
            var guideSnap = GameBindings.ReadBeginGuideSnapshot();
            var guidePreferred = guideSnap != null && guideSnap.TryGetValue("preferredOp", out var gp)
                ? gp as string
                : null;
            if (!SceneInteractionPolicy.CanOfferSudanDraw(top?.id, guidePreferred))
            {
                return Fail(
                    id,
                    op,
                    "blocked_by_modal",
                    "topOverlay=" + (top?.id ?? "none") + "; observe_scene and resolve the foreground modal first");
            }

            if (!GameBindings.IsSudanBoxReady && GameBindings.FindSudanBoxController() == null)
            {
                return Fail(id, op, "sudan_box_inactive", "Sudan box is not ready to draw");
            }

            try
            {
                GameBindings.ClickSudanBox();
                return Ok(id, op, "SudanBoxController.OnPointerClick");
            }
            catch (Exception ex)
            {
                return Fail(id, op, "sudan_box_click_failed", ex.Message);
            }
        }

        private static ActionResultDto OpenSudanBox(string id, string op)
        {
            var top = OverlayScanner.TopBlocking();
            var overlayBlocking = top != null;
            var terminal = false;
            try
            {
                var player = GameBindings.Player;
                var controller = GameBindings.Controller;
                if (player != null && controller != null)
                {
                    terminal = SceneInteractionPolicy.IsTerminal(
                        player.success, controller.game_over, GameBindings.InGame);
                }
            }
            catch
            {
                // optional
            }

            if (!SudanCardActionPolicy.CanOfferOpenSudanBox(
                    terminal,
                    overlayBlocking,
                    GameBindings.IsSudanDrawBlocking,
                    GameBindings.IsSudanBoxPresent))
            {
                if (terminal) return Fail(id, op, "game_over", null);
                if (GameBindings.IsSudanDrawBlocking)
                {
                    return Fail(id, op, "sudan_draw_required", "use draw_sudan_card during forced draw");
                }
                if (!GameBindings.IsSudanBoxPresent)
                {
                    return Fail(id, op, "sudan_box_inactive", "Sudan box is not present");
                }
                return Fail(
                    id,
                    op,
                    "blocked_by_modal",
                    "topOverlay=" + (top?.id ?? "none") + "; resolve foreground modal first");
            }

            try
            {
                GameBindings.ClickSudanBox();
                return Ok(id, op, "open_sudan_box via SudanBoxController");
            }
            catch (Exception ex)
            {
                return Fail(id, op, "sudan_box_click_failed", ex.Message);
            }
        }

        private static ActionResultDto CloseSudanBox(string id, string op)
        {
            var beforeActive = GameBindings.IsWizardActive || GameBindings.IsBeginGuideActive;
            var path = GameBindings.TryCloseSudanBoxUi();
            // Also clear rite panel if it still covers the map after box close.
            if (GameBindings.IsUiActive(GameBindings.RitePanel))
            {
                try
                {
                    GameBindings.RitePanel.OnClose();
                    path += "+rite.OnClose";
                }
                catch
                {
                    // optional
                }
            }

            var stillBlocking =
                GameBindings.IsWizardActive
                || GameBindings.IsBeginGuideActive
                || OverlayScanner.HasBlocking();
            if (stillBlocking)
            {
                return Fail(
                    id,
                    op,
                    "sudan_box_still_open",
                    "close_sudan_box incomplete path=" + path
                    + " wizard=" + GameBindings.IsWizardActive
                    + " guide=" + GameBindings.IsBeginGuideActive);
            }

            if (!beforeActive)
            {
                return Ok(id, op, "close_sudan_box already_closed path=" + path);
            }

            return Ok(id, op, "close_sudan_box path=" + path);
        }

        private static ActionResultDto ExchangeSudanCard(string id, string op)
        {
            var player = GameBindings.Player;
            if (player == null) return Fail(id, op, "no_player", null);
            var controller = GameBindings.Controller;
            if (controller == null) return Fail(id, op, "no_controller", null);

            var redrawTimes = 0;
            var redrawPerRound = 0;
            try { redrawTimes = player.sudan_redraw_times; } catch { /* optional */ }
            try { redrawPerRound = player.sudan_redraw_times_per_round; } catch { /* optional */ }
            var remaining = SudanCardActionPolicy.ComputeRedrawRemaining(redrawTimes, redrawPerRound);
            var card = GameBindings.FindCurrentSudanCard();
            var settlePrefix = "";

            // Prior exchange may leave BeginGuide tip「将苏丹卡拖拽到牌盒中」+ unacked card.
            // Dismiss tip by clicking it — never via continue/draw_sudan_card.
            if (GameBindings.IsBeginGuideActive
                || GameBindings.IsWizardRedrawTipStuck()
                || (GameBindings.IsWizardActive
                    && !GameBindings.HasExchangeSudanCardButton
                    && GameBindings.FindWizardRedrawDropper() == null))
            {
                if (GameBindings.IsBeginGuideActive)
                {
                    settlePrefix = "guide=" + GameBindings.TryDismissBeginGuideTip();
                }
                settlePrefix =
                    (settlePrefix.Length > 0 ? settlePrefix + "+" : "")
                    + "settle=" + GameBindings.TrySettleSudanExchangeUi();
                card = GameBindings.FindCurrentSudanCard() ?? card;
            }

            // After an exchange the Wizard often closes; consecutive exchange_sudan_card
            // must re-open the box. Do not sleep on the Unity thread — HTTP layer retries
            // once the next frame makes the choice menu available.
            if (!GameBindings.IsWizardActive && remaining > 0 && card != null)
            {
                try
                {
                    GameBindings.ClickSudanBox();
                }
                catch (Exception ex)
                {
                    return Fail(id, op, "wizard_reopen_failed", ex.Message);
                }
                if (!GameBindings.IsWizardActive)
                {
                    return Fail(
                        id,
                        op,
                        "wizard_opening",
                        "re-opened sudan box; wizard not active yet (retry next frame)"
                        + (settlePrefix.Length > 0 ? " settle=" + settlePrefix : ""));
                }
            }

            var wizardChoice = GameBindings.IsWizardChoiceMenu;
            var buttonPresent = GameBindings.HasExchangeSudanCardButton;
            var dropperActive = GameBindings.FindWizardRedrawDropper() != null;
            var phase = SudanCardActionPolicy.ResolveExchangePhase(
                GameBindings.IsWizardActive,
                wizardChoice,
                dropperActive,
                remaining,
                buttonPresent,
                card != null);

            // Stale "dropper" claims (no live GO) → re-enter via choice button.
            if (phase == "dropper" && !dropperActive)
            {
                phase = buttonPresent && remaining > 0 && card != null ? "choice" : "unavailable";
            }

            if (phase == "unavailable")
            {
                // One more settle+reopen attempt; HTTP retries on the next frame.
                if (remaining > 0 && card != null)
                {
                    settlePrefix = string.IsNullOrEmpty(settlePrefix)
                        ? GameBindings.TrySettleSudanExchangeUi()
                        : settlePrefix + "+" + GameBindings.TrySettleSudanExchangeUi();
                    if (!GameBindings.IsWizardActive || !GameBindings.HasExchangeSudanCardButton)
                    {
                        try { GameBindings.ClickSudanBox(); }
                        catch { /* optional */ }
                    }
                    return Fail(
                        id,
                        op,
                        "exchange_ui_settling",
                        "waiting for wizard choice/dropper after settle=" + settlePrefix);
                }
                if (!GameBindings.IsWizardActive)
                {
                    return Fail(
                        id,
                        op,
                        "wizard_not_open",
                        "open_sudan_box first; exchange only from Wizard choice menu");
                }
                if (remaining <= 0)
                {
                    return Fail(
                        id,
                        op,
                        "no_redraw_remaining",
                        "redrawTimes=" + redrawTimes + " redrawPerRound=" + redrawPerRound);
                }
                if (card == null)
                {
                    return Fail(id, op, "no_sudan_card", "current Sudan card not found");
                }
                return Fail(
                    id,
                    op,
                    "exchange_button_missing",
                    "neither exact exchange choice nor active redraw dropper is available"
                    + (settlePrefix.Length > 0 ? " settle=" + settlePrefix : ""));
            }

            var beforeCard = GameBindings.ReadCurrentSudanCardSummary();
            var beforeKey = GameBindings.SudanCardIdentityKey(beforeCard);
            var beforeRedraw = redrawTimes;
            var path = phase;

            if (phase == "choice")
            {
                try
                {
                    GameBindings.ClickExchangeSudanCard();
                }
                catch (Exception ex)
                {
                    return Fail(id, op, "exchange_click_failed", ex.Message);
                }

                // Dropper usually appears next frame; HTTP retries this error.
                if (GameBindings.FindWizardRedrawDropper() == null)
                {
                    return Fail(
                        id,
                        op,
                        "exchange_dropper_not_entered",
                        "exchange choice clicked but Wizard redraw dropper did not become active");
                }
                path += "->dropper";
            }

            // Card reference can go stale after a prior redraw — refresh before drop.
            card = GameBindings.FindCurrentSudanCard() ?? card;

            var dropError = "";
            if (!TryDropSudanForExchange(controller, card, out var dropPath, out dropError))
            {
                return Fail(id, op, "exchange_drop_failed", dropError);
            }
            path += "->" + dropPath;

            var afterPlayer = GameBindings.Player;
            var afterRedraw = beforeRedraw;
            try
            {
                if (afterPlayer != null) afterRedraw = afterPlayer.sudan_redraw_times;
            }
            catch
            {
                // optional
            }
            var afterCard = GameBindings.ReadCurrentSudanCardSummary();
            var afterKey = GameBindings.SudanCardIdentityKey(afterCard);

            if (afterRedraw <= beforeRedraw)
            {
                return Fail(
                    id,
                    op,
                    "exchange_not_applied",
                    "redrawTimes unchanged before=" + beforeRedraw + " after=" + afterRedraw
                    + " cardBefore=" + beforeKey + " cardAfter=" + afterKey
                    + " path=" + path);
            }

            if (!string.IsNullOrEmpty(beforeKey)
                && !string.IsNullOrEmpty(afterKey)
                && string.Equals(beforeKey, afterKey, StringComparison.Ordinal))
            {
                return Fail(
                    id,
                    op,
                    "exchange_card_unchanged",
                    "redrawTimes increased but sudan card identity unchanged key=" + beforeKey);
            }

            // Ack new card + click BeginGuide tip「将苏丹卡拖拽到牌盒中」.
            // Do not use continue/draw_sudan_card here — that would burn another redraw.
            var settle = GameBindings.TrySettleSudanExchangeUi();
            var guideDismiss = GameBindings.IsBeginGuideActive
                ? GameBindings.TryDismissBeginGuideTip()
                : "guide_inactive";
            return Ok(
                id,
                op,
                "exchange_sudan_card redraw=" + beforeRedraw + "->" + afterRedraw
                + " card=" + beforeKey + "->" + afterKey
                + " path=" + path
                + " settle=" + settle
                + " guide=" + guideDismiss
                + (settlePrefix.Length > 0 ? " preSettle=" + settlePrefix : ""));
        }

        private static bool TryDropSudanForExchange(
            GameController controller,
            Card card,
            out string path,
            out string error)
        {
            path = "none";
            error = "";
            if (card == null)
            {
                error = "current Sudan card not found";
                return false;
            }

            var dropper = GameBindings.FindWizardRedrawDropper();
            if (dropper == null)
            {
                error = "WizardRedrawDropper not found or inactive";
                return false;
            }

            var cardWidget = GameBindings.FindActiveCardController(card.uid, preferHand: true)
                             ?? GameBindings.FindActiveCardController(card.uid, preferHand: false);
            if (cardWidget == null)
            {
                try { cardWidget = controller.AddCard(card, true); }
                catch (Exception ex) { error = "AddCardWidget:" + TruncateErr(ex.Message); }
            }

            try
            {
                controller.CurrentDrag = card;
                controller.DragCard(card, true);

                var eventSystem = EventSystem.current;
                if (eventSystem != null && cardWidget != null)
                {
                    var pointer = new PointerEventData(eventSystem)
                    {
                        button = PointerEventData.InputButton.Left,
                        pointerDrag = cardWidget.gameObject,
                        pointerPress = cardWidget.gameObject,
                        rawPointerPress = cardWidget.gameObject
                    };
                    var handled = ExecuteEvents.ExecuteHierarchy<IDropHandler>(
                        dropper,
                        pointer,
                        ExecuteEvents.dropHandler);
                    if (handled != null) path = "OnDrop";
                }

                // Some game builds expose the drop zone without an IDropHandler.
                // Use the Wizard's own completion method only when no UI handler accepted the drop.
                if (path == "none")
                {
                    var wizard = GameBindings.WizardPanel;
                    if (wizard == null)
                    {
                        error = "WizardController unavailable after drop";
                        return false;
                    }
                    wizard.RedrawSudanCard(card);
                    path = path == "none" ? "Wizard.RedrawSudanCard" : path + "+Wizard.RedrawSudanCard";
                }
                return true;
            }
            catch (Exception ex)
            {
                error = TruncateErr(ex.Message);
                return false;
            }
            finally
            {
                try { controller.CurrentDrag = null; } catch { /* optional */ }
            }
        }

        private ActionResultDto ClickElement(string id, string op, JObject action)
        {
            var elementId = action?.Value<string>("elementId") ?? action?.Value<string>("targetId");
            var snapshotVersion = action?.Value<long?>("snapshotVersion");
            if (string.IsNullOrWhiteSpace(elementId))
            {
                return Fail(id, op, "missing_element_id", "click_element requires elementId");
            }
            if (!snapshotVersion.HasValue)
            {
                return Fail(id, op, "missing_snapshot_version", "click_element requires snapshotVersion");
            }

            var registry = PluginContext.Hub?.UiRegistry;
            if (registry == null)
            {
                return Fail(id, op, "scene_registry_missing", null);
            }
            var resolved = registry.Resolve(elementId, snapshotVersion.Value);
            if (resolved.handle == null)
            {
                return Fail(id, op, resolved.error ?? "element_not_found", "elementId=" + elementId);
            }

            var handle = resolved.handle;
            if (!string.IsNullOrEmpty(handle.mapsToOp))
            {
                if (string.Equals(handle.mapsToOp, "click_element", StringComparison.OrdinalIgnoreCase))
                {
                    return Fail(id, op, "recursive_element_action", elementId);
                }

                var mapped = new JObject
                {
                    ["id"] = id,
                    ["op"] = handle.mapsToOp
                };
                if (handle.actionParams != null)
                {
                    foreach (var kv in handle.actionParams)
                    {
                        mapped[kv.Key] = kv.Value == null ? JValue.CreateNull() : JToken.FromObject(kv.Value);
                    }
                }

                var result = ExecuteOne(mapped);
                result.op = op;
                result.detail = "elementId=" + elementId + " mapsTo=" + handle.mapsToOp
                                + (string.IsNullOrEmpty(result.detail) ? "" : " " + result.detail);
                return result;
            }

            if (handle.click == null)
            {
                return Fail(id, op, "unsupported_interaction", "No safe click adapter for " + elementId);
            }

            handle.click.Invoke();
            return Ok(id, op, "clicked elementId=" + elementId);
        }

        private static ActionResultDto SelectDifficulty(string id, string op, JObject action)
        {
            var panel = GameBindings.DifficultyPanel;
            if (!GameBindings.IsUiActive(panel))
            {
                return Fail(id, op, "panel_inactive", "DifficultyPanelController not active");
            }

            var index = FirstInt(action, "index", "optionIndex");
            if (index.HasValue && index.Value >= 0)
            {
                panel.CurrentSelect = index.Value;
                try { panel.SelectDifficultyItem(); } catch { /* optional sync */ }
            }

            panel.OnConfirm();
            return Ok(id, op, "DifficultyPanelController.OnConfirm select=" + panel.CurrentSelect);
        }

        private static ActionResultDto SelectEventOption(string id, string op, JObject action)
        {
            var option = GameBindings.OptionPanel;
            if (!GameBindings.IsUiActive(option))
            {
                return Fail(id, op, "panel_inactive", "OptionController not active");
            }

            var index = FirstInt(action, "optionIndex", "index", "optionId", "id");
            if (!index.HasValue || index.Value < 0)
            {
                return Fail(id, op, "option_out_of_range", "Need non-negative optionIndex");
            }

            var childCount = option.Options != null ? option.Options.childCount : 0;
            if (childCount > 0 && index.Value >= childCount)
            {
                return Fail(id, op, "option_out_of_range", "index=" + index.Value + " childCount=" + childCount);
            }

            option.CurrentOptionIndex = index.Value;
            TryActivateOptionToggle(option, index.Value);
            option.SelectOption();
            option.OnConfirm();
            return Ok(id, op, "OptionController select+confirm index=" + index.Value);
        }

        private static void TryActivateOptionToggle(OptionController option, int index)
        {
            try
            {
                if (option.Options == null || index < 0 || index >= option.Options.childCount) return;
                var child = option.Options.GetChild(index);
                if (child == null) return;
                var toggle = child.GetComponent<Toggle>();
                if (toggle != null)
                {
                    toggle.isOn = true;
                }
            }
            catch
            {
                // optional UI sync
            }
        }

        private static ActionResultDto SelectCard(string id, string op, JObject action)
        {
            var controller = GameBindings.Controller;
            if (controller == null)
            {
                return Fail(id, op, "no_controller", "GameController.Inst is null");
            }

            if (GameBindings.Player == null)
            {
                return Fail(id, op, "no_player", "GameApplication.player is null");
            }

            if (OverlayScanner.HasBlocking())
            {
                return Fail(id, op, "blocked_by_modal", "resolve foreground modal before select_card");
            }

            var uid = FirstInt(action, "uid", "cardId", "id");
            if (!uid.HasValue)
            {
                return Fail(id, op, "missing_uid", "Need uid");
            }

            var card = GameBindings.FindCardByUid(uid.Value);
            if (card == null)
            {
                return Fail(id, op, "card_not_found", "uid=" + uid.Value);
            }

            controller.SelectCard(card);
            return Ok(id, op, "GameController.SelectCard uid=" + uid.Value + " id=" + card.id);
        }

        private static ActionResultDto InspectCard(string id, string op, JObject action)
        {
            var controller = GameBindings.Controller;
            var player = GameBindings.Player;
            if (controller == null) return Fail(id, op, "no_controller", null);
            if (player == null) return Fail(id, op, "no_player", null);
            if (OverlayScanner.HasBlocking())
            {
                return Fail(id, op, "blocked_by_modal", "resolve foreground modal before inspect_card");
            }

            var uid = FirstInt(action, "uid", "cardId", "id");
            if (!uid.HasValue) return Fail(id, op, "missing_uid", "Need uid");
            var card = GameBindings.FindCardByUid(uid.Value);
            if (card == null) return Fail(id, op, "card_not_found", "uid=" + uid.Value);

            var riteOpen = GameBindings.IsUiActive(GameBindings.RitePanel);
            var onOpenRite = GameBindings.IsCardOnOpenRite(uid.Value);
            if (riteOpen && !onOpenRite)
            {
                return Fail(
                    id,
                    op,
                    "rite_panel_open",
                    "while rite panel is open, inspect_card only accepts filled currentRite slot uids; got uid="
                    + uid.Value);
            }

            var summary = CardSummaryProjector.Build(card);
            var summaryText = FormatCardSummary(summary);

            try
            {
                if (controller.CanShowIThink())
                {
                    player.ithink_card = card;
                    controller.DoIThink();
                    return Ok(
                        id,
                        op,
                        "GameController.DoIThink uid=" + uid.Value
                        + " id=" + card.id
                        + " mode=i_think"
                        + (onOpenRite ? " source=rite_slot" : " source=hand")
                        + " | " + summaryText);
                }
            }
            catch (Exception ex)
            {
                if (!onOpenRite)
                {
                    return Fail(id, op, "i_think_unavailable", ex.Message);
                }
            }

            // Rite-seat / NPC cards: catalog dossier is enough when IThink is unavailable.
            if (onOpenRite)
            {
                return Ok(
                    id,
                    op,
                    "catalog_inspect uid=" + uid.Value
                    + " id=" + card.id
                    + " mode=catalog_only source=rite_slot | " + summaryText);
            }

            return Fail(id, op, "i_think_unavailable", "GameController.CanShowIThink=false");
        }

        /// <summary>
        /// Gameplay drop into 俺寻思 (ThinkController). Distinct from inspect_card/DoIThink.
        /// Manual path evidence: CurrentDrag → ithink_card + Think.Current → meta rite 5000002
        /// → panel close → real map event (e.g. 稍加整修).
        /// </summary>
        private static ActionResultDto ThinkCard(string id, string op, JObject action)
        {
            var controller = GameBindings.Controller;
            var player = GameBindings.Player;
            if (controller == null) return Fail(id, op, "no_controller", null);
            if (player == null) return Fail(id, op, "no_player", null);
            if (OverlayScanner.HasBlocking())
            {
                return Fail(id, op, "blocked_by_modal", "resolve foreground modal before think_card");
            }
            if (GameBindings.IsUiActive(GameBindings.RitePanel))
            {
                return Fail(
                    id,
                    op,
                    "rite_panel_open",
                    "close the rite panel before dropping a card into 俺寻思");
            }
            if (!controller.CanShowIThink())
            {
                return Fail(id, op, "i_think_unavailable", "GameController.CanShowIThink=false");
            }

            var uid = FirstInt(action, "uid", "cardId", "id");
            if (!uid.HasValue) return Fail(id, op, "missing_uid", "Need uid");
            var card = GameBindings.FindCardByUid(uid.Value);
            if (card == null) return Fail(id, op, "card_not_found", "uid=" + uid.Value);

            var think = GameBindings.FindThinkController();
            if (think == null) return Fail(id, op, "no_think_controller", "ThinkController not found on IThink");

            try
            {
                if (!think.EnableThink)
                {
                    return Fail(id, op, "think_disabled", "ThinkController.EnableThink=false");
                }
            }
            catch
            {
                // optional property
            }

            var beforeUids = CollectRiteUids(player);
            var path = "none";
            var errors = new List<string>();
            var cardWidget = GameBindings.FindActiveCardController(uid.Value, preferHand: true)
                             ?? GameBindings.FindActiveCardController(uid.Value, preferHand: false);
            if (cardWidget == null)
            {
                // Sudan / bag cards may lack an on-screen widget; spawn a temp controller.
                try
                {
                    cardWidget = controller.AddCard(card, true);
                    if (cardWidget != null) errors.Add("spawnedCardWidget=true");
                }
                catch (Exception ex)
                {
                    errors.Add("AddCardWidget:" + TruncateErr(ex.Message));
                }
            }
            errors.Add("cardWidget=" + (cardWidget != null ? "yes" : "no"));

            try
            {
                try { controller.CurrentDrag = card; } catch (Exception ex) { errors.Add("CurrentDrag:" + ex.Message); }
                try { controller.DragCard(card, true); } catch (Exception ex) { errors.Add("DragCard:" + ex.Message); }

                // Primary: UI-shaped OnDrop FIRST — this is what creates meta rite 5000002.
                // (set_Current alone seats the card but does not spawn the map event.)
                try
                {
                    var eventSystem = EventSystem.current;
                    if (eventSystem == null) errors.Add("OnDrop:no_EventSystem");
                    else if (cardWidget == null) errors.Add("OnDrop:no_CardController");
                    else
                    {
                        var pointer = new PointerEventData(eventSystem)
                        {
                            button = PointerEventData.InputButton.Left,
                            pointerDrag = cardWidget.gameObject,
                            pointerPress = cardWidget.gameObject,
                            rawPointerPress = cardWidget.gameObject
                        };
                        // OnDrop alone creates the meta 俺寻思 rite. Do not also
                        // ExecuteEvents.dropHandler — that duplicates the meta rite.
                        think.OnDrop(pointer);
                        path = "OnDrop";
                    }
                }
                catch (Exception ex)
                {
                    errors.Add("OnDrop:" + TruncateErr(ex.Message));
                }

                // Fallback seat if OnDrop did not place the card.
                if (!IsThinkCurrent(think, uid.Value))
                {
                    try
                    {
                        think.Current = card;
                        player.ithink_card = card;
                        path = path == "none" ? "set_Current" : path + "+set_Current";
                    }
                    catch (Exception ex)
                    {
                        errors.Add("set_Current:" + TruncateErr(ex.Message));
                    }
                }
                else
                {
                    try { player.ithink_card = think.Current ?? card; }
                    catch (Exception ex) { errors.Add("ithink_card:" + TruncateErr(ex.Message)); }
                }

                try
                {
                    if (think.rite != null || think.Current != null || player.ithink_card != null)
                    {
                        think.ThinkOverSelect();
                        path += "+ThinkOverSelect";
                    }
                }
                catch (Exception ex)
                {
                    errors.Add("ThinkOverSelect:" + TruncateErr(ex.Message));
                }

                // If still no new rites, try DoIThink as last resort (help path; rarely spawns).
                if (CollectRiteUids(player).SetEquals(beforeUids))
                {
                    try
                    {
                        player.ithink_card = card;
                        controller.DoIThink();
                        path += "+DoIThink";
                    }
                    catch (Exception ex)
                    {
                        errors.Add("DoIThink:" + TruncateErr(ex.Message));
                    }
                }

                try
                {
                    var panel = GameBindings.RitePanel;
                    if (GameBindings.IsUiActive(panel) && panel?.Current != null
                        && panel.Current.id == GameBindings.IThinkMetaRiteId)
                    {
                        panel.OnClose();
                        path += "+OnCloseMeta";
                    }
                }
                catch (Exception ex)
                {
                    errors.Add("OnCloseMeta:" + TruncateErr(ex.Message));
                }
            }
            finally
            {
                try { controller.CurrentDrag = null; } catch { /* optional */ }
            }

            var afterUids = CollectRiteUids(player);
            var added = afterUids.Except(beforeUids).OrderBy(x => x).ToList();
            var addedRows = DescribeRites(player, added);
            var gameplayAdded = addedRows
                .Where(r => r.id != GameBindings.IThinkMetaRiteId)
                .ToList();
            var metaAdded = addedRows
                .Where(r => r.id == GameBindings.IThinkMetaRiteId)
                .ToList();

            var holding = IsThinkCurrent(think, uid.Value) || IsThinkHolding(think, player, uid.Value);
            if (added.Count == 0 && !IsThinkCurrent(think, uid.Value) && think.rite == null)
            {
                return Fail(
                    id,
                    op,
                    "think_no_effect",
                    "no new rite / think slot after drop uid=" + uid.Value
                    + " path=" + path
                    + (errors.Count > 0 ? " errors=" + string.Join(";", errors) : ""));
            }

            var cardName = "?";
            try
            {
                cardName = ConfigCatalog.Instance.ResolveCardName(card.id, card.custom_name, card.Type);
            }
            catch
            {
                try { cardName = card.custom_name ?? card.id.ToString(); } catch { /* optional */ }
            }

            var detail =
                "ThinkController drop uid=" + uid.Value
                + " id=" + card.id
                + " name=" + cardName
                + " path=" + path
                + " addedRites=[" + string.Join(", ", addedRows.Select(FormatRiteRow)) + "]"
                + " gameplayAdded=[" + string.Join(", ", gameplayAdded.Select(FormatRiteRow)) + "]"
                + " metaAdded=[" + string.Join(", ", metaAdded.Select(FormatRiteRow)) + "]"
                + " holding=" + holding
                + (errors.Count > 0 ? " notes=" + string.Join(";", errors) : "");

            return Ok(id, op, detail);
        }

        private static bool IsThinkCurrent(ThinkController think, int uid)
        {
            try { return think?.Current != null && think.Current.uid == uid; }
            catch { return false; }
        }

        private static bool IsThinkHolding(ThinkController think, Player player, int uid)
        {
            if (IsThinkCurrent(think, uid)) return true;
            try
            {
                if (player?.ithink_card != null && player.ithink_card.uid == uid) return true;
            }
            catch { /* optional */ }
            return false;
        }

        private static string TruncateErr(string message)
        {
            if (string.IsNullOrEmpty(message)) return "";
            var cut = message.IndexOf("--- BEGIN", StringComparison.Ordinal);
            if (cut > 0) message = message.Substring(0, cut).Trim();
            if (message.Length > 180) message = message.Substring(0, 180);
            return message.Replace('\r', ' ').Replace('\n', ' ');
        }

        private static HashSet<int> CollectRiteUids(Player player)
        {
            var set = new HashSet<int>();
            try
            {
                if (player?.rites == null) return set;
                foreach (var rite in player.rites)
                {
                    if (rite != null) set.Add(rite.uid);
                }
            }
            catch { /* optional */ }
            return set;
        }

        private sealed class RiteRow
        {
            public int uid;
            public int id;
            public string name;
        }

        private static List<RiteRow> DescribeRites(Player player, IEnumerable<int> uids)
        {
            var rows = new List<RiteRow>();
            if (player?.rites == null || uids == null) return rows;
            var want = new HashSet<int>(uids);
            try
            {
                foreach (var rite in player.rites)
                {
                    if (rite == null || !want.Contains(rite.uid)) continue;
                    string name = null;
                    try { name = ConfigCatalog.Instance.ResolveRiteName(rite.id, rite.custom_name); }
                    catch { try { name = rite.custom_name; } catch { /* optional */ } }
                    rows.Add(new RiteRow { uid = rite.uid, id = rite.id, name = name });
                }
            }
            catch { /* optional */ }
            return rows;
        }

        private static string FormatRiteRow(RiteRow row)
        {
            if (row == null) return "?";
            return "uid=" + row.uid + " id=" + row.id + " name=" + (row.name ?? "?");
        }

        private static string FormatCardSummary(Dictionary<string, object> summary)
        {
            if (summary == null || summary.Count == 0) return "cardSummary={}";
            var parts = new List<string>();
            foreach (var key in new[] { "name", "title", "type", "rare", "text", "desc", "description", "tip" })
            {
                if (!summary.TryGetValue(key, out var value) || value == null) continue;
                var text = value.ToString();
                if (string.IsNullOrWhiteSpace(text)) continue;
                if (text.Length > 160) text = text.Substring(0, 160);
                parts.Add(key + "=" + text);
            }
            if (summary.TryGetValue("tags", out var rawTags)
                && rawTags is Dictionary<string, object> tags
                && tags.Count > 0)
            {
                var tagParts = new List<string>();
                foreach (var pair in tags)
                {
                    tagParts.Add(pair.Key + ":" + pair.Value);
                }
                parts.Add("tags=" + string.Join(",", tagParts));
            }
            return "cardSummary={" + string.Join("; ", parts) + "}";
        }

        private static ActionResultDto OpenDailyNews(string id, string op)
        {
            if (OverlayScanner.HasBlocking())
            {
                return Fail(id, op, "blocked_by_modal", "resolve foreground modal before open_daily_news");
            }
            if (GameBindings.IsUiActive(GameBindings.RitePanel))
            {
                return Fail(id, op, "rite_panel_open", "close rite panel before open_daily_news");
            }
            if (GameBindings.IsBeginGuideActive)
            {
                return Fail(id, op, "need_follow_guide", "finish BeginGuide before open_daily_news");
            }

            try
            {
                var newsBefore = GameBindings.ReadDailyNewsSnapshot();
                var alreadyOpen = newsBefore != null
                                  && newsBefore.TryGetValue("open", out var openRaw)
                                  && openRaw is bool openFlag
                                  && openFlag;
                if (!alreadyOpen)
                {
                    // Do not open StoryEntry / 一千零一夜. No operational news popup → skip.
                    return Ok(
                        id,
                        op,
                        "no_daily_news_popup; skip story book (一千零一夜/achievements)");
                }

                GameBindings.OpenDailyNews();
                var news = GameBindings.ReadDailyNewsSnapshot();
                var summary = news != null && news.TryGetValue("summary", out var s) ? s as string : null;
                return Ok(
                    id,
                    op,
                    "StoryNotify already open"
                    + (string.IsNullOrEmpty(summary) ? "" : " summary=" + summary)
                    + "; summarize then continue — do not open story book");
            }
            catch (Exception ex)
            {
                return Fail(id, op, "open_daily_news_failed", ex.Message);
            }
        }

        private static ActionResultDto SelectGoldDice(string id, string op)
        {
            if (!GameBindings.TrySelectGoldDice(out var detail))
            {
                return Fail(id, op, detail ?? "select_gold_dice_failed", detail);
            }
            return Ok(id, op, "select_gold_dice via=" + detail);
        }

        private static ActionResultDto ConfirmGoldDice(string id, string op)
        {
            if (!GameBindings.TryConfirmGoldDice(out var detail))
            {
                return Fail(id, op, detail ?? "confirm_gold_dice_failed", detail);
            }
            return Ok(id, op, "confirm_gold_dice via=" + detail);
        }

        private static ActionResultDto CancelGoldDice(string id, string op)
        {
            if (!GameBindings.TryCancelGoldDice(out var detail))
            {
                return Fail(id, op, detail ?? "cancel_gold_dice_failed", detail);
            }
            return Ok(id, op, "cancel_gold_dice via=" + detail);
        }

        private static ActionResultDto OpenRite(string id, string op, JObject action)
        {
            var controller = GameBindings.Controller;
            if (controller == null) return Fail(id, op, "no_controller", null);
            if (OverlayScanner.HasBlocking())
            {
                return Fail(id, op, "blocked_by_modal", "resolve foreground modal before open_rite");
            }

            var uid = FirstInt(action, "uid", "riteUid", "id");
            if (!uid.HasValue) return Fail(id, op, "missing_uid", "Need rite uid");

            RiteController match = null;
            try
            {
                var view = GameBindings.GetVisibleMapRites();
                if (view != null)
                {
                    for (var i = 0; i < view.Count; i++)
                    {
                        var item = view[i];
                        if (item == null || item.rite == null) continue;
                        if (item.rite.uid == uid.Value
                            && item.gameObject != null
                            && item.gameObject.activeInHierarchy)
                        {
                            match = item;
                            break;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                return Fail(id, op, "rite_lookup_failed", ex.Message);
            }

            if (match == null)
            {
                return Fail(id, op, "rite_not_visible", "uid=" + uid.Value + " not in visible map rites");
            }

            try
            {
                var es = UnityEngine.EventSystems.EventSystem.current;
                var data = new UnityEngine.EventSystems.BaseEventData(es);
                match.OnSubmit(data);
                return Ok(id, op, "RiteController.OnSubmit uid=" + uid.Value + " id=" + match.rite.id);
            }
            catch (Exception ex)
            {
                return Fail(id, op, "open_rite_failed", ex.Message);
            }
        }

        private static ActionResultDto PlaceCardOnRite(string id, string op, JObject action)
        {
            var panel = GameBindings.RitePanel;
            if (!GameBindings.IsUiActive(panel))
            {
                return Fail(id, op, "panel_inactive", "RitePanelShowController not active");
            }

            if (GameBindings.Player == null)
            {
                return Fail(id, op, "no_player", null);
            }

            // uid is instance identity (unstable across saves / after CardSplit).
            // cardId is catalog identity — use as fallback for stackable items (金币).
            var uid = FirstInt(action, "uid", "card");
            var cardIdHint = FirstInt(action, "cardId");
            var slotIndex = FirstInt(action, "slotIndex", "slotId", "slot", "index");
            var requestedCount = FirstInt(action, "count", "amount", "placeCount");
            if (!uid.HasValue && !cardIdHint.HasValue)
            {
                return Fail(id, op, "missing_uid", "Need uid or cardId");
            }
            if (!slotIndex.HasValue || slotIndex.Value < 0)
            {
                return Fail(id, op, "missing_slotIndex", "Need non-negative slotIndex");
            }

            Card card = null;
            if (uid.HasValue)
            {
                card = GameBindings.FindCardByUid(uid.Value);
            }
            if (card == null && cardIdHint.HasValue)
            {
                card = GameBindings.FindHandCardById(cardIdHint.Value, requestedCount);
                if (card != null)
                {
                    try { uid = card.uid; } catch { /* optional */ }
                }
            }
            // Last resort: some callers still pass catalog id in the uid field.
            if (card == null && uid.HasValue)
            {
                card = GameBindings.FindHandCardById(uid.Value, requestedCount);
                if (card != null)
                {
                    try { uid = card.uid; } catch { /* optional */ }
                }
            }
            if (card == null || !uid.HasValue)
            {
                return Fail(
                    id,
                    op,
                    "card_not_found",
                    "uid=" + (uid.HasValue ? uid.Value.ToString() : "null")
                    + (cardIdHint.HasValue ? (" cardId=" + cardIdHint.Value) : ""));
            }

            if (panel.Slots == null || slotIndex.Value >= panel.Slots.Count)
            {
                return Fail(id, op, "slot_out_of_range", "slotIndex=" + slotIndex.Value + " slots=" + (panel.Slots?.Count ?? 0));
            }

            var slot = panel.Slots[slotIndex.Value];
            var slotText = "";
            string conditionSummary = null;
            try { slotText = SceneText.Normalize(slot?.Slot?.text); } catch { /* optional */ }
            try
            {
                var condition = slot?.Slot?.condition;
                if (condition != null) conditionSummary = SceneText.Normalize(condition.ToString());
            }
            catch { /* optional */ }
            var beforeUid = RiteSlotProjector.GetSlotCardUid(slot);

            var cardName = "";
            try
            {
                cardName = ConfigCatalog.Instance.ResolveCardName(card.id, card.custom_name, card.Type)
                           ?? "";
            }
            catch { /* optional */ }
            var preferredTag = StackPlaceHelper.PreferredCostTag(cardName, card.Type);
            var costMin = StackPlaceHelper.ParseCostMin(conditionSummary, slotText, preferredTag);
            int stackCount = 1;
            try { stackCount = Math.Max(1, card.count); } catch { stackCount = 1; }
            var placeCount = StackPlaceHelper.ResolvePlaceCount(requestedCount, stackCount, costMin);
            if (requestedCount.HasValue && requestedCount.Value > stackCount)
            {
                return Fail(
                    id,
                    op,
                    "insufficient_count",
                    "requested count=" + requestedCount.Value + " but card uid=" + uid.Value
                    + " only has count=" + stackCount);
            }

            var cardController = FindActiveHandCardController(uid.Value);
            if (cardController == null)
            {
                return Fail(
                    id,
                    op,
                    "card_controller_not_found",
                    "No active hand CardController for uid=" + uid.Value);
            }

            var splitNote = "";
            if (placeCount.HasValue && placeCount.Value > 0 && placeCount.Value < stackCount)
            {
                try
                {
                    var splitCard = cardController.CardSplit(placeCount.Value);
                    if (splitCard == null)
                    {
                        return Fail(
                            id,
                            op,
                            "split_failed",
                            "CardSplit(" + placeCount.Value + ") returned null for uid=" + uid.Value
                            + " count=" + stackCount);
                    }

                    var splitUid = splitCard.uid;
                    var splitController = FindActiveHandCardController(splitUid);
                    if (splitController == null)
                    {
                        // Split card may reuse / replace the widget; fall back to source widget
                        // only when its card uid already points at the split result.
                        if (cardController.card != null && cardController.card.uid == splitUid)
                        {
                            splitController = cardController;
                        }
                    }

                    if (splitController == null)
                    {
                        return Fail(
                            id,
                            op,
                            "split_controller_not_found",
                            "CardSplit ok (newUid=" + splitUid + ") but no hand CardController");
                    }

                    splitNote = "; split count=" + placeCount.Value
                        + " from uid=" + uid.Value + " -> uid=" + splitUid;
                    uid = splitUid;
                    card = splitCard;
                    cardController = splitController;
                }
                catch (Exception ex)
                {
                    return Fail(
                        id,
                        op,
                        "split_failed",
                        "CardSplit(" + placeCount.Value + ") uid=" + uid.Value
                        + " exception=" + ex.GetType().Name + ": " + ex.Message);
                }
            }

            try
            {
                if (slot != null && !slot.IsCardSatisified(card))
                {
                    return Fail(
                        id,
                        op,
                        "card_not_accepted",
                        "uid=" + uid.Value + " rejected by slotIndex=" + slotIndex.Value
                        + (string.IsNullOrEmpty(slotText) ? "" : (" text=" + slotText))
                        + "; observe semantic:rite_slot_* / currentRite.slots");
                }
            }
            catch
            {
                // IsCardSatisified is best-effort; fall through to TryUpdateCard.
            }

            bool accepted;
            try
            {
                accepted = panel.TryUpdateCard(slotIndex.Value, card);
                if (!accepted)
                {
                    return Fail(
                        id,
                        op,
                        "place_rejected",
                        "TryUpdateCard=false slotIndex=" + slotIndex.Value
                        + " uid=" + uid.Value
                        + (string.IsNullOrEmpty(slotText) ? "" : (" text=" + slotText)));
                }

                // Recorded player path:
                // TryUpdateCard -> DropCard -> CardSlot.SetCard -> RitePanel.SetCard.
                slot.DropCard(cardController);
                accepted = RiteSlotProjector.GetSlotCardUid(slot) == uid.Value;
            }
            catch (Exception ex)
            {
                return Fail(
                    id,
                    op,
                    "place_failed",
                    "slotIndex=" + slotIndex.Value + " uid=" + uid.Value
                    + " exception=" + ex.GetType().Name + ": " + ex.Message);
            }

            var afterUid = RiteSlotProjector.GetSlotCardUid(panel.Slots[slotIndex.Value]);
            bool canConfirm = false;
            try { canConfirm = panel.CheckConfirm(); } catch { /* ignore */ }

            if (!accepted && afterUid != uid.Value)
            {
                return Fail(
                    id,
                    op,
                    "place_rejected",
                    "TryUpdateCard=false slotIndex=" + slotIndex.Value
                    + " beforeUid=" + beforeUid + " afterUid=" + afterUid
                    + (string.IsNullOrEmpty(slotText) ? "" : (" text=" + slotText)));
            }

            if (afterUid != uid.Value)
            {
                return Fail(
                    id,
                    op,
                    "place_no_change",
                    "slotIndex=" + slotIndex.Value + " still uid=" + afterUid
                    + "; expected uid=" + uid.Value
                    + (string.IsNullOrEmpty(slotText) ? "" : (" text=" + slotText)));
            }

            return Ok(
                id,
                op,
                "Placed card uid=" + uid.Value
                + " in rite slot=" + slotIndex.Value
                + "; readyToSubmit=" + canConfirm
                + (placeCount.HasValue ? ("; placedCount=" + placeCount.Value) : "")
                + splitNote
                + (string.IsNullOrEmpty(slotText) ? "" : (" text=" + slotText)));
        }

        private static CardController FindActiveHandCardController(int uid) =>
            GameBindings.FindActiveHandCardController(uid);

        private static Card FindEquippedCardInstance(Card character, int itemUid)
        {
            if (character == null) return null;
            try
            {
                var equips = character.equips;
                if (equips == null) return null;
                for (var i = 0; i < equips.Count; i++)
                {
                    var item = equips[i];
                    if (item != null && item.uid == itemUid) return item;
                }
            }
            catch
            {
                // optional
            }
            return null;
        }

        private static CardController FindChildCardController(CardController root, int uid)
        {
            if (root == null) return null;
            try
            {
                var widgets = root.GetComponentsInChildren<CardController>(true);
                if (widgets == null) return null;
                foreach (var widget in widgets)
                {
                    if (widget == null || ReferenceEquals(widget, root)) continue;
                    if (widget.card != null && widget.card.uid == uid) return widget;
                }
            }
            catch
            {
                // optional
            }
            return null;
        }

        private static ActionResultDto EquipItem(string id, string op, JObject action)
        {
            if (GameBindings.Controller == null) return Fail(id, op, "no_controller", null);
            if (GameBindings.Player == null) return Fail(id, op, "no_player", null);
            if (OverlayScanner.HasBlocking())
            {
                return Fail(id, op, "blocked_by_modal", "resolve foreground modal before equip_item");
            }
            if (GameBindings.IsUiActive(GameBindings.RitePanel))
            {
                return Fail(id, op, "rite_panel_open", "close rite panel before equip_item");
            }

            var characterUid = FirstInt(action, "characterUid", "charUid", "targetUid");
            var itemUid = FirstInt(action, "itemUid", "uid", "cardUid");
            if (!characterUid.HasValue) return Fail(id, op, "missing_characterUid", "Need characterUid");
            if (!itemUid.HasValue) return Fail(id, op, "missing_itemUid", "Need itemUid");

            var character = GameBindings.FindCardByUid(characterUid.Value);
            if (character == null) return Fail(id, op, "character_not_found", "characterUid=" + characterUid.Value);
            var item = GameBindings.FindCardByUid(itemUid.Value);
            if (item == null) return Fail(id, op, "item_not_found", "itemUid=" + itemUid.Value);

            if (!EquipmentProjector.IsCharacterType(character.Type))
            {
                return Fail(id, op, "wrong_character_type", "characterUid=" + characterUid.Value + " type=" + character.Type);
            }
            if (!EquipmentProjector.IsItemType(item.Type))
            {
                return Fail(id, op, "wrong_item_type", "itemUid=" + itemUid.Value + " type=" + item.Type);
            }
            if (!EquipmentProjector.IsEquippableCharacter(character))
            {
                return Fail(id, op, "not_equippable_character", "characterUid=" + characterUid.Value + " is not owned follower/hero");
            }
            if (!EquipmentProjector.HasEquipmentTag(item))
            {
                return Fail(id, op, "item_not_equippable", "itemUid=" + itemUid.Value + " missing 装备 tag");
            }
            if (GameBindings.IsCardOnOpenRite(characterUid.Value) || GameBindings.IsCardOnOpenRite(itemUid.Value))
            {
                return Fail(id, op, "card_on_rite", "unequip/equip cards must not be seated on an open rite");
            }

            var owner = EquipmentProjector.FindOwnerOfItem(itemUid.Value);
            if (owner != null)
            {
                return Fail(
                    id,
                    op,
                    "item_already_equipped",
                    "itemUid=" + itemUid.Value + " already on characterUid=" + owner.uid
                    + "; unequip_item first");
            }

            var slotType = EquipmentProjector.NormalizeSlotType(
                EquipmentProjector.ResolveItemSlotType(item));
            var slotTypes = EquipmentProjector.RuntimeEquipSlotTypes(character);
            if (!EquipmentProjector.SlotTypesCompatible(slotTypes, slotType))
            {
                return Fail(
                    id,
                    op,
                    "slot_incompatible",
                    "item slotType=" + slotType + " not in character equipSlotTypes=["
                    + string.Join(",", slotTypes) + "]");
            }

            if (!string.IsNullOrWhiteSpace(slotType))
            {
                var occupant = EquipmentProjector.FindEquippedOccupant(character, slotType);
                if (occupant != null)
                {
                    return Fail(
                        id,
                        op,
                        "slot_occupied",
                        "characterUid=" + characterUid.Value + " slotType=" + slotType
                        + " occupied by itemUid=" + (occupant.TryGetValue("uid", out var occUid) ? occUid : "?")
                        + "; unequip_item first");
                }
            }

            var characterController = GameBindings.FindActiveCardController(characterUid.Value);
            if (characterController == null)
            {
                return Fail(
                    id,
                    op,
                    "character_controller_not_found",
                    "No active CardController for characterUid=" + characterUid.Value);
            }
            var itemController = GameBindings.FindActiveCardController(itemUid.Value);
            if (itemController == null)
            {
                return Fail(
                    id,
                    op,
                    "item_controller_not_found",
                    "No active CardController for itemUid=" + itemUid.Value);
            }

            var before = EquipmentProjector.RuntimeEquipped(character);
            bool accepted;
            try
            {
                // UI path: drag item onto character. CardEquip(rightController) mirrors DropCard.
                accepted = characterController.CardEquip(itemController);
            }
            catch (Exception ex)
            {
                return Fail(
                    id,
                    op,
                    "equip_failed",
                    "characterUid=" + characterUid.Value + " itemUid=" + itemUid.Value
                    + " exception=" + ex.GetType().Name + ": " + ex.Message);
            }

            var after = EquipmentProjector.RuntimeEquipped(character);
            var equipped = EquipmentProjector.CharacterHasItem(character, itemUid.Value);
            if (!accepted || !equipped)
            {
                return Fail(
                    id,
                    op,
                    "equip_rejected",
                    "CardEquip=" + accepted
                    + " characterUid=" + characterUid.Value
                    + " itemUid=" + itemUid.Value
                    + " beforeCount=" + before.Count
                    + " afterCount=" + after.Count
                    + (string.IsNullOrWhiteSpace(slotType) ? "" : (" slotType=" + slotType)));
            }

            return Ok(
                id,
                op,
                "Equipped itemUid=" + itemUid.Value
                + " on characterUid=" + characterUid.Value
                + (string.IsNullOrWhiteSpace(slotType) ? "" : (" slotType=" + slotType))
                + "; equippedCount=" + after.Count);
        }

        private static ActionResultDto UnequipItem(string id, string op, JObject action)
        {
            if (GameBindings.Controller == null) return Fail(id, op, "no_controller", null);
            if (GameBindings.Player == null) return Fail(id, op, "no_player", null);
            if (OverlayScanner.HasBlocking())
            {
                return Fail(id, op, "blocked_by_modal", "resolve foreground modal before unequip_item");
            }
            if (GameBindings.IsUiActive(GameBindings.RitePanel))
            {
                return Fail(id, op, "rite_panel_open", "close rite panel before unequip_item");
            }

            var characterUid = FirstInt(action, "characterUid", "charUid", "targetUid");
            var itemUid = FirstInt(action, "itemUid", "uid", "cardUid");
            if (!itemUid.HasValue) return Fail(id, op, "missing_itemUid", "Need itemUid");

            Card character = null;
            if (characterUid.HasValue)
            {
                character = GameBindings.FindCardByUid(characterUid.Value);
                if (character == null)
                {
                    return Fail(id, op, "character_not_found", "characterUid=" + characterUid.Value);
                }
                if (!EquipmentProjector.CharacterHasItem(character, itemUid.Value))
                {
                    return Fail(
                        id,
                        op,
                        "item_not_equipped",
                        "itemUid=" + itemUid.Value + " is not equipped on characterUid=" + characterUid.Value);
                }
            }
            else
            {
                character = EquipmentProjector.FindOwnerOfItem(itemUid.Value);
                if (character == null)
                {
                    return Fail(id, op, "item_not_equipped", "itemUid=" + itemUid.Value + " has no owner");
                }
                characterUid = character.uid;
            }

            // Prefer the equipped Card instance from char.equips; inventory lookup may miss it.
            var item = FindEquippedCardInstance(character, itemUid.Value)
                       ?? GameBindings.FindCardByUid(itemUid.Value);
            if (item == null) return Fail(id, op, "item_not_found", "itemUid=" + itemUid.Value);

            var itemController = GameBindings.FindActiveCardController(itemUid.Value, preferHand: false);
            if (itemController == null)
            {
                // Equipped widgets may nest under the character card; search children of char widget.
                var charController = GameBindings.FindActiveCardController(characterUid.Value, preferHand: false);
                itemController = FindChildCardController(charController, itemUid.Value);
            }
            if (itemController == null)
            {
                return Fail(
                    id,
                    op,
                    "item_controller_not_found",
                    "No CardController for equipped itemUid=" + itemUid.Value);
            }

            bool canRemove;
            try { canRemove = itemController.CanRemoveFromSlot(); }
            catch (Exception ex)
            {
                return Fail(
                    id,
                    op,
                    "cannot_unequip",
                    "CanRemoveFromSlot failed itemUid=" + itemUid.Value
                    + " exception=" + ex.GetType().Name + ": " + ex.Message);
            }
            if (!canRemove)
            {
                return Fail(id, op, "cannot_unequip", "CanRemoveFromSlot=false itemUid=" + itemUid.Value);
            }

            var before = EquipmentProjector.RuntimeEquipped(character);
            try
            {
                itemController.RemoveFromSlot();
            }
            catch (Exception ex)
            {
                return Fail(
                    id,
                    op,
                    "unequip_failed",
                    "itemUid=" + itemUid.Value + " characterUid=" + characterUid.Value
                    + " exception=" + ex.GetType().Name + ": " + ex.Message);
            }

            var after = EquipmentProjector.RuntimeEquipped(character);
            if (EquipmentProjector.CharacterHasItem(character, itemUid.Value))
            {
                return Fail(
                    id,
                    op,
                    "unequip_no_change",
                    "itemUid=" + itemUid.Value + " still on characterUid=" + characterUid.Value
                    + " beforeCount=" + before.Count + " afterCount=" + after.Count);
            }

            return Ok(
                id,
                op,
                "Unequipped itemUid=" + itemUid.Value
                + " from characterUid=" + characterUid.Value
                + "; equippedCount=" + after.Count);
        }

        private static ActionResultDto CancelCardPlacement(string id, string op, JObject action)
        {
            var panel = GameBindings.RitePanel;
            if (!GameBindings.IsUiActive(panel))
            {
                return Fail(id, op, "panel_inactive", "RitePanelShowController not active");
            }

            var slotIndex = FirstInt(action, "slotIndex", "slotId", "slot", "index");
            if (slotIndex.HasValue && slotIndex.Value >= 0 && panel.Slots != null)
            {
                if (slotIndex.Value >= panel.Slots.Count)
                {
                    return Fail(id, op, "slot_out_of_range", "slotIndex=" + slotIndex.Value);
                }

                var slot = panel.Slots[slotIndex.Value];
                if (slot != null)
                {
                    try
                    {
                        panel.ChooseSlotCard(slot);
                    }
                    catch
                    {
                        // optional
                    }
                    try
                    {
                        slot.RecoveryCard();
                        return Ok(id, op, "Cancelled card placement in rite slot=" + slotIndex.Value);
                    }
                    catch
                    {
                        // fall through to RemoveSlotCard
                    }
                }
            }

            panel.RemoveSlotCard();
            return Ok(id, op, "Cancelled selected card placement"
                + (slotIndex.HasValue ? (" in rite slot=" + slotIndex.Value) : ""));
        }

        private static ActionResultDto CloseRite(string id, string op)
        {
            var panel = GameBindings.RitePanel;
            if (!GameBindings.IsUiActive(panel))
            {
                return Fail(id, op, "panel_inactive", "RitePanelShowController not active");
            }

            var riteUid = panel.Current != null ? panel.Current.uid : -1;
            panel.OnClose();
            return Ok(id, op, "RitePanelShowController.OnClose riteUid=" + riteUid);
        }

        private static ActionResultDto ClearRiteSubmission(string id, string op)
        {
            var panel = GameBindings.RitePanel;
            if (!GameBindings.IsUiActive(panel) || panel.Current == null)
            {
                return Fail(id, op, "panel_inactive", "RitePanelShowController not active");
            }
            if (!panel.Current.start)
            {
                return Fail(id, op, "rite_not_started", "The current rite has not been submitted");
            }

            var riteUid = panel.Current.uid;
            panel.OnStop();
            return Ok(id, op, "Cleared rite submission riteUid=" + riteUid + "; cards are unlocked");
        }

        private static ActionResultDto StartRite(string id, string op)
        {
            var panel = GameBindings.RitePanel;
            if (!GameBindings.IsUiActive(panel))
            {
                return Fail(id, op, "panel_inactive", "RitePanelShowController not active");
            }

            bool ready;
            try { ready = panel.CheckConfirm(); }
            catch (Exception ex)
            {
                return Fail(id, op, "rite_not_ready", "CheckConfirm threw: " + ex.Message);
            }

            if (!ready)
            {
                return Fail(id, op, "rite_not_ready", "CheckConfirm=false");
            }

            var riteUid = panel.Current != null ? panel.Current.uid : -1;
            panel.OnConfirm();
            return Ok(id, op, "Submitted rite riteUid=" + riteUid);
        }

        private static ActionResultDto NextRound(string id, string op)
        {
            var controller = GameBindings.Controller;
            if (controller == null)
            {
                return Fail(id, op, "no_controller", "GameController.Inst is null");
            }

            if (controller.game_over)
            {
                return Fail(id, op, "game_over", "cannot advance");
            }

            if (OverlayScanner.HasBlocking())
            {
                return Fail(id, op, "blocked_by_modal", "resolve foreground modal before " + op);
            }

            if (GameBindings.IsUiActive(GameBindings.RitePanel))
            {
                return Fail(id, op, "rite_panel_open", "close rite panel before " + op);
            }

            var before = GameBindings.Player?.round ?? 0;
            var clicked = OverlayScanner.TryClickNamedButton(controller.transform, "Next Round");
            if (!clicked)
            {
                controller.OnNextRound();
            }

            var after = GameBindings.Player?.round ?? 0;
            var riteResultUp = GameBindings.IsUiActive(controller.riteResultPanel);
            return Ok(
                id,
                op,
                "next_day via "
                + (clicked ? "NextRoundButton" : "OnNextRound")
                + " before=" + before
                + " after=" + after
                + (riteResultUp ? " rite_result=true" : " pending_async"));
        }

        private static ActionResultDto PrevRound(string id, string op)
        {
            var controller = GameBindings.Controller;
            var player = GameBindings.Player;
            if (controller == null) return Fail(id, op, "no_controller", null);
            if (player == null) return Fail(id, op, "no_player", null);

            // After sudan exchanges BeginGuide tip「将苏丹卡拖拽到牌盒中」+ Wizard block the map.
            // Human clicks the tip precisely, closes the box, then rewinds.
            // Never use continue here — guide preferredOp is draw_sudan_card and burns redraws.
            var dismissPath = "";
            if (OverlayScanner.HasBlocking()
                || GameBindings.IsBeginGuideActive
                || GameBindings.IsWizardActive
                || GameBindings.IsUiActive(GameBindings.RitePanel))
            {
                dismissPath = GameBindings.TryReturnToMapFromSudanUi();
            }

            var overlayBlocking = OverlayScanner.HasBlocking() || GameBindings.IsBeginGuideActive;
            var success = player.success;
            var terminal = SceneInteractionPolicy.IsTerminal(
                success, controller.game_over, GameBindings.InGame);
            var minRound = 0;
            try { minRound = player.min_round; } catch { /* optional */ }
            if (!SceneInteractionPolicy.CanPrevRound(
                    player.round, minRound, overlayBlocking, terminal, success))
            {
                if (success) return Fail(id, op, "victory", "cannot rewind after success");
                if (!terminal && overlayBlocking)
                {
                    // Soft failure so HTTP/replay can retry next frame after tip click settles.
                    return Fail(
                        id,
                        op,
                        "guide_dismissing",
                        "clicked BeginGuide tip / closed wizard; wait next frame for prev_round"
                        + (dismissPath.Length > 0 ? " dismiss=" + dismissPath : ""));
                }
                return Fail(
                    id,
                    op,
                    "no_previous_round",
                    "round=" + player.round + " minRound=" + minRound
                    + "; refusing round_0 / unavailable rewind");
            }

            var before = player.round;
            controller.OnPrevRound();

            // OnPrevRound often opens ConfirmController:「返回上一回合将丢失当前回合进度」.
            // Auto-click 确定 / OnConfirm so the rewind completes in one op when possible.
            var confirmPath = "";
            try
            {
                var confirm = GameBindings.ConfirmPanel;
                if (GameBindings.IsUiActive(confirm))
                {
                    confirm.OnConfirm();
                    confirmPath = "+confirm.OnConfirm";
                }
            }
            catch (Exception ex)
            {
                confirmPath = "+confirm:err:" + TruncateErr(ex.Message);
            }

            var after = GameBindings.Player?.round;
            return Ok(
                id,
                op,
                "GameController.OnPrevRound before=" + before + " after=" + after
                + confirmPath
                + (dismissPath.Length > 0 ? " dismiss=" + dismissPath : ""));
        }

        private static int? FirstInt(JObject action, params string[] keys)
        {
            if (action == null) return null;
            foreach (var key in keys)
            {
                var token = action[key];
                if (token == null || token.Type == JTokenType.Null) continue;
                if (token.Type == JTokenType.Integer) return token.Value<int>();
                if (int.TryParse(token.ToString(), out var i)) return i;
            }
            return null;
        }
#endif

        private static ActionResultDto Ok(string id, string op, string detail) =>
            new ActionResultDto { id = id, op = op, ok = true, detail = detail };

        private static ActionResultDto Fail(string id, string op, string error, string detail) =>
            new ActionResultDto { id = id, op = op, ok = false, error = error, detail = detail };
    }
}
