using System;

namespace VibeSultan.Sultan.Observer.State
{
    public static class SceneInteractionPolicy
    {
        public static bool CanOfferSudanDraw(string topOverlayId, string guidePreferredOp)
        {
            if (string.Equals(topOverlayId, "sudan_box", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return string.Equals(topOverlayId, "begin_guide", StringComparison.OrdinalIgnoreCase)
                   && string.Equals(guidePreferredOp, "draw_sudan_card", StringComparison.OrdinalIgnoreCase);
        }

        public static bool CanOfferGenericContinue(string topOverlayId, string topOverlayKind)
        {
            if (string.Equals(topOverlayKind, "wizard_choice", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            return !string.Equals(topOverlayId, "option", StringComparison.OrdinalIgnoreCase)
                   && !string.Equals(topOverlayId, "sudan_box", StringComparison.OrdinalIgnoreCase)
                   && !string.Equals(topOverlayId, "begin_guide", StringComparison.OrdinalIgnoreCase)
                   && !string.Equals(topOverlayId, "difficulty", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// over_reason uses int.MinValue as an unset sentinel; it must not imply game over.
        /// </summary>
        public static bool IsTerminal(bool success, bool gameOver, bool inGame)
        {
            return success || (gameOver && inGame);
        }

        public static bool CanPrevRound(
            int round,
            int minRound,
            bool overlayBlocking,
            bool terminal,
            bool success = false)
        {
            // Round 1 must never rewind to round_0.json. Treat an effective floor of at
            // least 1 even when Player.min_round is still the unset default (0).
            var effectiveMin = minRound < 1 ? 1 : minRound;
            if (round <= effectiveMin) return false;
            // Victory endings are final; failure game-over still offers "previous day".
            if (success) return false;
            if (terminal) return true;
            return !overlayBlocking;
        }

        /// <summary>
        /// Fallback when current Sudan card life is unknown: treat global round as
        /// the first-card cycle (day 1 => 7/7). Prefer
        /// <see cref="ComputeExecutionDaysLeft(int, int?, int)"/> with card.life.
        /// </summary>
        public static int ComputeExecutionDaysLeft(int round, int initLife)
        {
            if (initLife <= 0) return 0;
            if (round <= 0) return initLife;
            return Math.Max(0, initLife - (round - 1));
        }

        /// <summary>
        /// Card-face countdown: sudan cards store elapsed life ticks on Card.life.
        /// Remaining = initLife - cardLife (e.g. life=2, initLife=7 => 5/7).
        /// Falls back to round-based estimate when cardLife is missing.
        /// </summary>
        public static int ComputeExecutionDaysLeft(int initLife, int? cardLife, int round)
        {
            if (initLife <= 0) return 0;
            if (cardLife.HasValue)
            {
                return Math.Max(0, initLife - Math.Max(0, cardLife.Value));
            }
            return ComputeExecutionDaysLeft(round, initLife);
        }

        public static string FormatExecutionDay(int round, int initLife, int? cardLife = null)
        {
            if (initLife <= 0)
            {
                return round > 0 ? round.ToString() : null;
            }

            return ComputeExecutionDaysLeft(initLife, cardLife, round) + "/" + initLife;
        }

        public static bool CanOfferDailyNews(
            bool overlayBlocking,
            bool terminal,
            bool riteOpen,
            bool guideActive,
            bool newsPresent,
            bool entryAvailable)
        {
            // entryAvailable is ignored: StoryEntry is the meta story book, not daily news.
            // Only offer the op when StoryNotify is actually present/open.
            _ = entryAvailable;
            return !overlayBlocking
                   && !terminal
                   && !riteOpen
                   && !guideActive
                   && newsPresent;
        }
    }
}
