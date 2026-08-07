using VibeSultan.Sultan.Observer.State;
using Xunit;

namespace VibeSultan.Sultan.Observer.Tests
{
    public sealed class RiteResultPolicyTests
    {
        [Fact]
        public void ResolveStage_PrefersNextWhenReady()
        {
            var stage = RiteResultPolicy.ResolveStage(
                active: true,
                nextInteractable: true,
                goldConfirmInteractable: true,
                goldSelectInteractable: true,
                dicePromptVisible: true);
            Assert.Equal(RiteResultPolicy.StageAwaitingNext, stage);
        }

        [Fact]
        public void ResolveStage_DicePromptWithoutNext_IsAwaitingRoll()
        {
            var stage = RiteResultPolicy.ResolveStage(
                active: true,
                nextInteractable: false,
                goldConfirmInteractable: false,
                goldSelectInteractable: false,
                dicePromptVisible: true);
            Assert.Equal(RiteResultPolicy.StageAwaitingRoll, stage);
        }

        [Theory]
        [InlineData("awaiting_roll", 1, "result_text")]
        [InlineData("awaiting_next", 1, "next")]
        [InlineData("gold_select", 2, "result_text")]
        [InlineData("gold_select", 0, "result_text")]
        [InlineData("gold_confirm", 1, "need_confirm_gold_dice")]
        public void ResolveContinueGesture_MatchesStage(string stage, int gold, string expected)
        {
            Assert.Equal(expected, RiteResultPolicy.ResolveContinueGesture(stage, gold));
        }

        [Fact]
        public void ResolveContinueGesture_GoldSelect_IsOptionalSkipViaBody()
        {
            // Having gold dice must NOT force select_gold_dice.
            Assert.Equal(
                RiteResultPolicy.GestureResultText,
                RiteResultPolicy.ResolveContinueGesture(RiteResultPolicy.StageGoldSelect, goldDiceAvailable: 3));
        }

        [Fact]
        public void ResolveContinueGesture_ResultPage_UsesResultTextGesture()
        {
            // result_page must keep using the body/blank gesture path (not Next).
            // Plugin pairs blank click with panel method so agents do not strand on no_effect.
            Assert.Equal(
                RiteResultPolicy.GestureResultText,
                RiteResultPolicy.ResolveContinueGesture(RiteResultPolicy.StageResultPage));
        }

        [Fact]
        public void ResolveStage_ResultPage_WhenNoButtonsReady()
        {
            var stage = RiteResultPolicy.ResolveStage(
                active: true,
                nextInteractable: false,
                goldConfirmInteractable: false,
                goldSelectInteractable: false,
                dicePromptVisible: false);
            Assert.Equal(RiteResultPolicy.StageResultPage, stage);
        }
    }
}
