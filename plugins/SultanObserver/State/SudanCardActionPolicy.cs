using System;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Pure helpers for Sudan box open/exchange actions (unit-testable without Unity).
    /// </summary>
    public static class SudanCardActionPolicy
    {
        public const string ExchangeLabelZh = "交换手上的苏丹卡";
        public const string ExtraDrawNeedleZh = "再来一张";

        public static string NormalizeLabel(string label)
        {
            if (string.IsNullOrWhiteSpace(label)) return string.Empty;
            var chars = label.Trim().ToCharArray();
            var buffer = new char[chars.Length];
            var n = 0;
            var prevSpace = false;
            foreach (var ch in chars)
            {
                if (char.IsWhiteSpace(ch) || ch == '\u200b' || ch == '\ufeff')
                {
                    if (n == 0 || prevSpace) continue;
                    buffer[n++] = ' ';
                    prevSpace = true;
                    continue;
                }
                buffer[n++] = ch;
                prevSpace = false;
            }
            return new string(buffer, 0, n);
        }

        /// <summary>
        /// Exact match only — must not accept "疯狂到底，再来一张苏丹卡".
        /// </summary>
        public static bool IsExchangeSudanCardLabel(string label)
        {
            var text = NormalizeLabel(label);
            if (text.Length == 0) return false;
            if (text.IndexOf(ExtraDrawNeedleZh, StringComparison.Ordinal) >= 0) return false;
            return string.Equals(text, ExchangeLabelZh, StringComparison.Ordinal)
                   || string.Equals(text, "Exchange the Sultan Card", StringComparison.OrdinalIgnoreCase)
                   || string.Equals(text, "Exchange Sultan Card in Hand", StringComparison.OrdinalIgnoreCase);
        }

        public static int ComputeRedrawRemaining(int redrawTimes, int redrawPerRound)
        {
            if (redrawPerRound <= 0) return 0;
            return Math.Max(0, redrawPerRound - Math.Max(0, redrawTimes));
        }

        public static bool CanOfferOpenSudanBox(
            bool terminal,
            bool overlayBlocking,
            bool sudanDrawBlocking,
            bool boxPresent)
        {
            if (terminal || !boxPresent) return false;
            // Forced draw phase uses draw_sudan_card, not open_sudan_box.
            if (sudanDrawBlocking) return false;
            // Opening the box is allowed while a non-blocking overlay is up, but not
            // while another blocking modal owns the foreground (except wizard itself).
            return !overlayBlocking;
        }

        public static bool CanOfferExchangeSudanCard(
            bool wizardChoiceMenu,
            int redrawRemaining,
            bool exchangeButtonPresent)
        {
            return wizardChoiceMenu && redrawRemaining > 0 && exchangeButtonPresent;
        }

        public static bool CanCompleteExchangeDropper(
            bool wizardActive,
            bool redrawDropperActive,
            int redrawRemaining,
            bool currentCardPresent)
        {
            return wizardActive
                   && redrawDropperActive
                   && redrawRemaining > 0
                   && currentCardPresent;
        }

        public static string ResolveExchangePhase(
            bool wizardActive,
            bool wizardChoiceMenu,
            bool redrawDropperActive,
            int redrawRemaining,
            bool exchangeButtonPresent,
            bool currentCardPresent)
        {
            if (CanCompleteExchangeDropper(
                    wizardActive,
                    redrawDropperActive,
                    redrawRemaining,
                    currentCardPresent))
            {
                return "dropper";
            }
            if (wizardActive
                && currentCardPresent
                && CanOfferExchangeSudanCard(
                    wizardChoiceMenu,
                    redrawRemaining,
                    exchangeButtonPresent))
            {
                return "choice";
            }
            return "unavailable";
        }
    }
}
