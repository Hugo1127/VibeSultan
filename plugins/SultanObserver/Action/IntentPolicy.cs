using System;

namespace VibeSultan.Sultan.Observer.Action
{
    /// <summary>
    /// Pure routing decisions for domain intents. No Unity/IL2CPP dependency.
    /// </summary>
    public static class IntentPolicy
    {
        public const string TargetRiteResultNext = "rite_result_next";
        public const string TargetDismissOverlay = "dismiss_overlay";
        public const string TargetGuidePreferred = "guide_preferred";
        public const string TargetNextDay = "next_day";
        public const string TargetNeedOption = "need_select_event_option";
        public const string TargetNeedDifficulty = "need_select_difficulty";
        public const string TargetNeedSudanDraw = "need_draw_sudan_card";
        public const string TargetNeedWizardChoice = "need_wizard_choice";
        public const string TargetNothing = "nothing";

        public const string TargetExecuteDifficulty = "execute_difficulty";
        public const string TargetExecuteOption = "execute_option";
        public const string TargetExecuteRite = "execute_rite";
        public const string TargetCancelRite = "cancel_rite";
        public const string TargetResetSlot = "reset_slot";
        public const string TargetResetSubmission = "reset_submission";
        public const string TargetNeedFollowGuide = "need_follow_guide";

        public static string ResolveContinue(
            string topOverlayId,
            string topOverlayKind,
            bool guideActive,
            string guidePreferredOp,
            bool sudanDrawBlocking,
            bool inGamePlay,
            bool overlayBlocking)
        {
            // Break animation first: blank click via SudanBreaker.OnPointerClick.
            if (string.Equals(topOverlayId, "sudan_breaker", StringComparison.OrdinalIgnoreCase))
            {
                return TargetDismissOverlay;
            }

            if (string.Equals(topOverlayId, "rite_result", StringComparison.OrdinalIgnoreCase))
            {
                return TargetRiteResultNext;
            }

            if (string.Equals(topOverlayId, "option", StringComparison.OrdinalIgnoreCase))
            {
                return TargetNeedOption;
            }

            if (string.Equals(topOverlayId, "difficulty", StringComparison.OrdinalIgnoreCase))
            {
                return TargetNeedDifficulty;
            }

            if (string.Equals(topOverlayKind, "wizard_choice", StringComparison.OrdinalIgnoreCase))
            {
                return TargetNeedWizardChoice;
            }

            // BeginGuide preferredOp may be draw_sudan_card / reset / continue — honor it
            // before treating sudan_box_show as a hard block.
            if (guideActive || string.Equals(topOverlayId, "begin_guide", StringComparison.OrdinalIgnoreCase))
            {
                if (!string.IsNullOrWhiteSpace(guidePreferredOp))
                {
                    return TargetGuidePreferred;
                }

                return TargetNeedFollowGuide;
            }

            if (string.Equals(topOverlayId, "sudan_box", StringComparison.OrdinalIgnoreCase)
                || sudanDrawBlocking)
            {
                return TargetNeedSudanDraw;
            }

            if (overlayBlocking
                && (string.Equals(topOverlayId, "prompt", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(topOverlayId, "change_name", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(topOverlayId, "confirm", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(topOverlayId, "wizard", StringComparison.OrdinalIgnoreCase)))
            {
                return TargetDismissOverlay;
            }

            // Day advance is NEVER via continue — use explicit next_day / next_round.
            _ = inGamePlay;

            if (overlayBlocking)
            {
                return TargetDismissOverlay;
            }

            return TargetNothing;
        }

        public static string ResolveExecute(
            bool difficultyActive,
            bool optionActive,
            bool ritePanelActive,
            bool riteStarted,
            bool riteCanConfirm)
        {
            if (difficultyActive) return TargetExecuteDifficulty;
            if (optionActive) return TargetExecuteOption;
            if (ritePanelActive && !riteStarted && riteCanConfirm) return TargetExecuteRite;
            return TargetNothing;
        }

        public static string ResolveCancel(bool guideActive, bool ritePanelActive)
        {
            if (guideActive) return TargetNeedFollowGuide;
            if (ritePanelActive) return TargetCancelRite;
            return TargetNothing;
        }

        public static string ResolveReset(
            bool guideActive,
            string guidePreferredOp,
            bool ritePanelActive,
            bool riteStarted,
            bool hasSlotIndex)
        {
            _ = guideActive;
            _ = guidePreferredOp;
            _ = hasSlotIndex;

            if (ritePanelActive && riteStarted)
            {
                return TargetResetSubmission;
            }

            // Undo placements in the open (unsubmitted) rite panel.
            if (ritePanelActive && !riteStarted)
            {
                return TargetResetSlot;
            }

            return TargetNothing;
        }

        /// <summary>
        /// Map legacy granular ops onto intents for compatibility.
        /// </summary>
        public static string AliasLegacyOp(string op)
        {
            if (string.IsNullOrWhiteSpace(op)) return op;
            return op.Trim().ToLowerInvariant() switch
            {
                // next_round / next_day are domain ops — do not alias into continue.
                "start_rite" => "execute",
                "close_rite" => "cancel",
                "clear_rite_submission" => "reset",
                _ => op
            };
        }

        /// <summary>
        /// Map guide/domain preferred ops onto public intent names for AI-facing snapshots.
        /// </summary>
        public static string ToPublicPreferredOp(string preferredOp)
        {
            if (string.IsNullOrWhiteSpace(preferredOp)) return preferredOp;
            var aliased = AliasLegacyOp(preferredOp);
            return string.IsNullOrWhiteSpace(aliased) ? preferredOp : aliased;
        }
    }
}
