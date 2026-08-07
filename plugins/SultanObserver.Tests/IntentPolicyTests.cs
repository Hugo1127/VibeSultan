using VibeSultan.Sultan.Observer.Action;
using Xunit;

namespace VibeSultan.Sultan.Observer.Tests
{
    public sealed class IntentPolicyTests
    {
        [Fact]
        public void Continue_RiteResult_RoutesToNext()
        {
            var target = IntentPolicy.ResolveContinue(
                "rite_result", "rite_result", guideActive: false, guidePreferredOp: null,
                sudanDrawBlocking: false, inGamePlay: false, overlayBlocking: true);
            Assert.Equal(IntentPolicy.TargetRiteResultNext, target);
        }

        [Fact]
        public void Continue_GuideRiteStop_RoutesToPreferred()
        {
            var target = IntentPolicy.ResolveContinue(
                "begin_guide", "guide", guideActive: true, guidePreferredOp: "reset",
                sudanDrawBlocking: false, inGamePlay: false, overlayBlocking: true);
            Assert.Equal(IntentPolicy.TargetGuidePreferred, target);
        }

        [Fact]
        public void Continue_PlayNoOverlay_IsNothing()
        {
            var target = IntentPolicy.ResolveContinue(
                null, null, guideActive: false, guidePreferredOp: null,
                sudanDrawBlocking: false, inGamePlay: true, overlayBlocking: false);
            Assert.Equal(IntentPolicy.TargetNothing, target);
        }

        [Fact]
        public void Continue_PromptOverlay_Dismisses()
        {
            var target = IntentPolicy.ResolveContinue(
                "prompt", "intro_or_tip", guideActive: false, guidePreferredOp: null,
                sudanDrawBlocking: false, inGamePlay: true, overlayBlocking: true);
            Assert.Equal(IntentPolicy.TargetDismissOverlay, target);
        }

        [Fact]
        public void Cancel_WhileGuide_IsRejected()
        {
            var target = IntentPolicy.ResolveCancel(guideActive: true, ritePanelActive: true);
            Assert.Equal(IntentPolicy.TargetNeedFollowGuide, target);
        }

        [Fact]
        public void Execute_RiteReady_RoutesToStartRite()
        {
            var target = IntentPolicy.ResolveExecute(
                difficultyActive: false,
                optionActive: false,
                ritePanelActive: true,
                riteStarted: false,
                riteCanConfirm: true);
            Assert.Equal(IntentPolicy.TargetExecuteRite, target);
        }

        [Fact]
        public void Reset_SubmittedRite_ClearsSubmission()
        {
            var target = IntentPolicy.ResolveReset(
                guideActive: false,
                guidePreferredOp: null,
                ritePanelActive: true,
                riteStarted: true,
                hasSlotIndex: false);
            Assert.Equal(IntentPolicy.TargetResetSubmission, target);
        }

        [Theory]
        [InlineData("next_round", "next_round")]
        [InlineData("next_day", "next_day")]
        [InlineData("start_rite", "execute")]
        [InlineData("close_rite", "cancel")]
        [InlineData("clear_rite_submission", "reset")]
        [InlineData("place_card_on_rite", "place_card_on_rite")]
        public void AliasLegacyOp_MapsGranularOps(string legacy, string expected)
        {
            Assert.Equal(expected, IntentPolicy.AliasLegacyOp(legacy));
        }
    }
}
