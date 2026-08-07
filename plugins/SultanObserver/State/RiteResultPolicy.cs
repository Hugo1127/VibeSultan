using System;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Pure stage/gesture policy for RiteResultPanel dice pages.
    /// </summary>
    public static class RiteResultPolicy
    {
        public const string StageInactive = "inactive";
        public const string StageAwaitingRoll = "awaiting_roll";
        public const string StageGoldSelect = "gold_select";
        public const string StageGoldConfirm = "gold_confirm";
        public const string StageAwaitingNext = "awaiting_next";
        public const string StageResultPage = "result_page";

        public const string GestureNext = "next";
        public const string GestureResultText = "result_text";
        public const string GestureNeedGoldSelect = "need_select_gold_dice";
        public const string GestureNeedGoldConfirm = "need_confirm_gold_dice";
        public const string GestureNone = "none";

        public static string ResolveStage(
            bool active,
            bool nextInteractable,
            bool goldConfirmInteractable,
            bool goldSelectInteractable,
            bool dicePromptVisible)
        {
            if (!active) return StageInactive;
            if (nextInteractable) return StageAwaitingNext;
            if (goldConfirmInteractable) return StageGoldConfirm;
            if (goldSelectInteractable) return StageGoldSelect;
            if (dicePromptVisible) return StageAwaitingRoll;
            return StageResultPage;
        }

        /// <summary>
        /// What continue should do on the current rite-result stage.
        /// </summary>
        public static string ResolveContinueGesture(
            string stage,
            int goldDiceAvailable = 0)
        {
            if (string.Equals(stage, StageAwaitingNext, StringComparison.OrdinalIgnoreCase))
            {
                return GestureNext;
            }

            if (string.Equals(stage, StageGoldConfirm, StringComparison.OrdinalIgnoreCase))
            {
                return GestureNeedGoldConfirm;
            }

            if (string.Equals(stage, StageGoldSelect, StringComparison.OrdinalIgnoreCase))
            {
                // Gold dice are optional: clicking body/blank skips spending.
                // Spending requires an explicit select_gold_dice (then confirm).
                _ = goldDiceAvailable;
                return GestureResultText;
            }

            if (string.Equals(stage, StageAwaitingRoll, StringComparison.OrdinalIgnoreCase)
                || string.Equals(stage, StageResultPage, StringComparison.OrdinalIgnoreCase))
            {
                return GestureResultText;
            }

            return GestureNone;
        }
    }
}
