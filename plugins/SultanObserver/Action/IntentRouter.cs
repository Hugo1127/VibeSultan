using System;
using Newtonsoft.Json.Linq;
using VibeSultan.Sultan.Observer.State;

namespace VibeSultan.Sultan.Observer.Action
{
    /// <summary>
    /// Routes continue/execute/cancel/reset intents to the correct in-game gesture
    /// for the current overlay/phase. AI never picks Next vs Confirm by name.
    /// </summary>
    public static class IntentRouter
    {
        public static ActionResultDto Dispatch(string id, string op, JObject action, Func<JObject, ActionResultDto> executeDomain)
        {
            var intent = (op ?? "").Trim().ToLowerInvariant();
            return intent switch
            {
                "continue" => Continue(id, op, executeDomain),
                "execute" => Execute(id, op, action, executeDomain),
                "cancel" => Cancel(id, op, executeDomain),
                "reset" => Reset(id, op, action, executeDomain),
                _ => Fail(id, op, "unknown_intent", intent)
            };
        }

#if GAME_INTEROP
        private static ActionResultDto Continue(string id, string op, Func<JObject, ActionResultDto> executeDomain)
        {
            var overlays = OverlayScanner.Scan();
            var top = OverlayScanner.TopBlocking(overlays);
            var overlayBlocking = OverlayScanner.HasBlocking(overlays);
            var guide = GameBindings.ReadBeginGuideSnapshot();
            var guideActive = GameBindings.IsBeginGuideActive || top?.id == "begin_guide";
            var guidePreferred = guide != null && guide.TryGetValue("preferredOp", out var gp)
                ? gp as string
                : null;
            var inGamePlay = GameBindings.InGame
                             && GameBindings.Controller != null
                             && !GameBindings.IsUiActive(GameBindings.RitePanel)
                             && !overlayBlocking;

            var target = IntentPolicy.ResolveContinue(
                top?.id,
                top?.kind,
                guideActive,
                guidePreferred,
                GameBindings.IsSudanDrawBlocking,
                inGamePlay,
                overlayBlocking);

            switch (target)
            {
                case IntentPolicy.TargetRiteResultNext:
                    return ClickRiteResultNext(id, op);

                case IntentPolicy.TargetDismissOverlay:
                {
                    // Sudan break UI: report the real click path (helper/controller/delegater).
                    if (string.Equals(top?.id, "sudan_breaker", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(top?.kind, "sudan_breaker", StringComparison.OrdinalIgnoreCase))
                    {
                        if (GameBindings.TryClickSudanBreaker(out var breakerVia, force: true))
                        {
                            return Ok(id, op, "continue -> sudan_breaker via=" + breakerVia);
                        }

                        return Fail(id, op, "sudan_breaker_click_failed",
                            "SudanBreaker present but DoClick/OnPointerClick/Continue produced no path");
                    }

                    var dismissed = OverlayScanner.DismissTopBlocking(overlays);
                    return Ok(id, op, "continue -> " + IntentPolicy.TargetDismissOverlay
                                      + " via " + (dismissed ?? top?.id ?? "unknown"));
                }

                case IntentPolicy.TargetGuidePreferred:
                {
                    if (string.IsNullOrWhiteSpace(guidePreferred))
                    {
                        return Fail(id, op, "need_follow_guide", "BeginGuide has no preferredOp");
                    }

                    if (string.Equals(guidePreferred, "next_day", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(guidePreferred, "next_round", StringComparison.OrdinalIgnoreCase))
                    {
                        return Fail(id, op, "need_next_day",
                            "Day advance requires explicit next_day; continue only dismisses panels");
                    }

                    return ExecuteGuidePreferred(id, op, guidePreferred, executeDomain);
                }

                case IntentPolicy.TargetNeedOption:
                    return Fail(id, op, "need_select_event_option",
                        "Story/perk choice requires select_event_option(optionIndex)");

                case IntentPolicy.TargetNeedDifficulty:
                    return Fail(id, op, "need_select_difficulty",
                        "Difficulty requires select_difficulty before continue");

                case IntentPolicy.TargetNeedSudanDraw:
                    return Fail(id, op, "need_draw_sudan_card",
                        "Sudan box is waiting; use draw_sudan_card");

                case IntentPolicy.TargetNeedWizardChoice:
                    return Fail(id, op, "need_wizard_choice",
                        "Wizard choice menu requires selecting an exposed choice");

                case IntentPolicy.TargetNeedFollowGuide:
                    return Fail(id, op, "need_follow_guide",
                        "BeginGuide active; preferredOp=" + (guidePreferred ?? "none"));

                default:
                    return Fail(id, op, "nothing_to_continue",
                        "No panel to confirm; use next_day to advance the day");
            }
        }

        private static ActionResultDto Execute(
            string id,
            string op,
            JObject action,
            Func<JObject, ActionResultDto> executeDomain)
        {
            var difficultyActive = GameBindings.IsUiActive(GameBindings.DifficultyPanel);
            var optionActive = GameBindings.IsUiActive(GameBindings.OptionPanel);
            var ritePanel = GameBindings.RitePanel;
            var riteActive = GameBindings.IsUiActive(ritePanel);
            var riteStarted = riteActive && ritePanel.Current != null && ritePanel.Current.start;
            var canConfirm = false;
            if (riteActive && !riteStarted)
            {
                try { canConfirm = ritePanel.CheckConfirm(); } catch { /* ignore */ }
            }

            var target = IntentPolicy.ResolveExecute(
                difficultyActive, optionActive, riteActive, riteStarted, canConfirm);

            switch (target)
            {
                case IntentPolicy.TargetExecuteDifficulty:
                {
                    var mapped = new JObject { ["id"] = id, ["op"] = "select_difficulty" };
                    CopyKeys(action, mapped, "index", "optionIndex");
                    var result = executeDomain(mapped);
                    result.op = op;
                    result.detail = "execute -> select_difficulty " + (result.detail ?? "");
                    return result;
                }
                case IntentPolicy.TargetExecuteOption:
                {
                    var index = FirstInt(action, "optionIndex", "index");
                    if (index.HasValue)
                    {
                        var mapped = new JObject
                        {
                            ["id"] = id,
                            ["op"] = "select_event_option",
                            ["optionIndex"] = index.Value
                        };
                        var result = executeDomain(mapped);
                        result.op = op;
                        result.detail = "execute -> select_event_option " + (result.detail ?? "");
                        return result;
                    }

                    var option = GameBindings.OptionPanel;
                    option.OnConfirm();
                    return Ok(id, op, "execute -> OptionController.OnConfirm index=" + option.CurrentOptionIndex);
                }
                case IntentPolicy.TargetExecuteRite:
                {
                    var mapped = new JObject { ["id"] = id, ["op"] = "start_rite" };
                    var result = executeDomain(mapped);
                    result.op = op;
                    result.detail = "execute -> start_rite " + (result.detail ?? "");
                    return result;
                }
                default:
                    return Fail(id, op, "nothing_to_execute",
                        "No confirmable difficulty/option/rite transaction");
            }
        }

        private static ActionResultDto Cancel(string id, string op, Func<JObject, ActionResultDto> executeDomain)
        {
            var target = IntentPolicy.ResolveCancel(
                GameBindings.IsBeginGuideActive,
                GameBindings.IsUiActive(GameBindings.RitePanel));
            if (target == IntentPolicy.TargetNeedFollowGuide)
            {
                return Fail(id, op, "need_follow_guide", "Cannot cancel while BeginGuide is active");
            }

            if (target == IntentPolicy.TargetCancelRite)
            {
                var mapped = new JObject { ["id"] = id, ["op"] = "close_rite" };
                var result = executeDomain(mapped);
                result.op = op;
                result.detail = "cancel -> close_rite " + (result.detail ?? "");
                return result;
            }

            return Fail(id, op, "nothing_to_cancel", "No open rite panel to cancel");
        }

        private static ActionResultDto Reset(
            string id,
            string op,
            JObject action,
            Func<JObject, ActionResultDto> executeDomain)
        {
            var guide = GameBindings.ReadBeginGuideSnapshot();
            var guidePreferred = guide != null && guide.TryGetValue("preferredOp", out var gp)
                ? gp as string
                : null;
            var ritePanel = GameBindings.RitePanel;
            var riteActive = GameBindings.IsUiActive(ritePanel);
            var riteStarted = riteActive && ritePanel.Current != null && ritePanel.Current.start;
            var slotIndex = FirstInt(action, "slotIndex", "slotId", "slot", "index");

            var target = IntentPolicy.ResolveReset(
                GameBindings.IsBeginGuideActive,
                guidePreferred,
                riteActive,
                riteStarted,
                slotIndex.HasValue);

            if (target == IntentPolicy.TargetResetSlot)
            {
                var mapped = new JObject
                {
                    ["id"] = id,
                    ["op"] = "cancel_card_placement"
                };
                if (slotIndex.HasValue) mapped["slotIndex"] = slotIndex.Value;
                var result = executeDomain(mapped);
                result.op = op;
                result.detail = "reset -> cancel_card_placement " + (result.detail ?? "");
                return result;
            }

            if (target == IntentPolicy.TargetResetSubmission)
            {
                var mapped = new JObject { ["id"] = id, ["op"] = "clear_rite_submission" };
                var result = executeDomain(mapped);
                result.op = op;
                result.detail = "reset -> clear_rite_submission " + (result.detail ?? "");
                return result;
            }

            return Fail(id, op, "nothing_to_reset",
                "Need an open rite with a placed card (slotIndex) or a submitted rite to clear");
        }

        private static ActionResultDto ExecuteGuidePreferred(
            string id,
            string op,
            string guidePreferred,
            Func<JObject, ActionResultDto> executeDomain)
        {
            var publicOp = IntentPolicy.ToPublicPreferredOp(guidePreferred);
            // Intent names must not re-enter continue (would loop on BeginGuide).
            string domainOp = publicOp switch
            {
                "continue" => "next_round",
                "execute" => "start_rite",
                "cancel" => "close_rite",
                "reset" => "clear_rite_submission",
                _ => guidePreferred
            };

            var mapped = new JObject { ["id"] = id, ["op"] = domainOp };
            var result = executeDomain(mapped);
            result.op = op;
            result.detail = "continue -> guide_preferred=" + guidePreferred
                            + " as=" + domainOp
                            + (string.IsNullOrEmpty(result.detail) ? "" : " " + result.detail);
            return result;
        }

        private static ActionResultDto ClickRiteResultNext(string id, string op)
        {
            if (GameBindings.TryAdvanceRiteResult(out var via, out var reason))
            {
                return Ok(id, op, "continue -> rite_result via=" + (via ?? "unknown"));
            }

            if (string.Equals(reason, "need_select_gold_dice", StringComparison.OrdinalIgnoreCase))
            {
                return Fail(id, op, reason,
                    "Gold dice is optional; continue clicks blank/body to skip, or use select_gold_dice only when spending");
            }

            if (string.Equals(reason, "need_confirm_gold_dice", StringComparison.OrdinalIgnoreCase))
            {
                return Fail(id, op, reason,
                    "Gold dice confirm is open; use confirm_gold_dice to spend, or cancel_gold_dice to abort");
            }

            return Fail(id, op, reason ?? "rite_result_advance_failed",
                "Could not advance rite result (Next disabled until dice resolves; click body text via continue when stage=awaiting_roll)");
        }

        private static void CopyKeys(JObject source, JObject dest, params string[] keys)
        {
            if (source == null || dest == null) return;
            foreach (var key in keys)
            {
                if (source[key] != null) dest[key] = source[key];
            }
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
#else
        private static ActionResultDto Continue(string id, string op, Func<JObject, ActionResultDto> executeDomain) =>
            Fail(id, op, "binding_missing", "Compiled without GAME_INTEROP");

        private static ActionResultDto Execute(
            string id, string op, JObject action, Func<JObject, ActionResultDto> executeDomain) =>
            Fail(id, op, "binding_missing", "Compiled without GAME_INTEROP");

        private static ActionResultDto Cancel(string id, string op, Func<JObject, ActionResultDto> executeDomain) =>
            Fail(id, op, "binding_missing", "Compiled without GAME_INTEROP");

        private static ActionResultDto Reset(
            string id, string op, JObject action, Func<JObject, ActionResultDto> executeDomain) =>
            Fail(id, op, "binding_missing", "Compiled without GAME_INTEROP");
#endif

        private static ActionResultDto Ok(string id, string op, string detail) =>
            new ActionResultDto { id = id, op = op, ok = true, detail = detail };

        private static ActionResultDto Fail(string id, string op, string error, string detail) =>
            new ActionResultDto { id = id, op = op, ok = false, error = error, detail = detail };
    }
}
