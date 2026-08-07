using System.Collections.Generic;
using VibeSultan.Sultan.Observer.State;
using Xunit;

namespace VibeSultan.Sultan.Observer.Tests
{
    public class StateProjectorTests
    {
        [Theory]
        [InlineData("StartScene", "boot")]
        [InlineData("MainMenu", "main_menu")]
        [InlineData("RitePanel", "rite")]
        [InlineData("StoryNotify", "story")]
        [InlineData("GameOver", "terminal")]
        [InlineData("DesktopPlay", "play")]
        public void InferPhase_MapsKnownScreens(string name, string expected)
        {
            Assert.Equal(expected, StateProjector.InferPhase(name.ToLowerInvariant(), name));
        }

        [Fact]
        public void NormalizeScreenId_StartScene()
        {
            Assert.Equal("startscene", StateProjector.NormalizeScreenId("StartScene"));
        }

        [Fact]
        public void ProjectionDto_Fixture_ShapesCardsRitesEvents()
        {
            // Pure DTO fixture mirroring what StateReader puts into GameState.values.
            var cards = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> { ["uid"] = 1, ["id"] = 100, ["bag"] = 0, ["bagpos"] = 0 },
                new Dictionary<string, object> { ["uid"] = 2, ["id"] = 200, ["bag"] = 1, ["bagpos"] = 1 }
            };
            var rites = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object>
                {
                    ["uid"] = 10,
                    ["id"] = 501,
                    ["start"] = false,
                    ["canConfirm"] = false,
                    ["slots"] = new List<Dictionary<string, object>>
                    {
                        new Dictionary<string, object> { ["index"] = 0, ["occupied"] = false, ["cardUid"] = null }
                    }
                }
            };
            var events = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> { ["index"] = 0, ["selected"] = true, ["label"] = "option_0" },
                new Dictionary<string, object> { ["index"] = 1, ["selected"] = false, ["label"] = "option_1" }
            };
            var counters = new Dictionary<string, object> { ["gold"] = 12, ["influence"] = 3 };

            var state = GameState.CreateEmpty();
            state.screen.id = "play";
            state.screen.phase = "play";
            state.values["day"] = 2;
            state.values["handCount"] = 1;
            state.values["riteCount"] = 1;
            state.values["eventOptionCount"] = 2;
            state.values["cards"] = cards;
            state.values["rites"] = rites;
            state.values["events"] = events;
            state.values["currentEvent"] = new Dictionary<string, object>
            {
                ["kind"] = "choice",
                ["prompt"] = "Choose",
                ["identitySeed"] = "fixture",
                ["identityQuality"] = "derived",
                ["options"] = events
            };
            state.values["counters"] = counters;
            state.values["initDone"] = true;
            state.values["inGame"] = true;
            state.actions = new List<ActionInfo>
            {
                new ActionInfo { id = "select_card", enabled = true },
                new ActionInfo { id = "continue", enabled = true }
            };

            var projected = CompactProjector.Project(state, new HashSet<string>
            {
                "values", "cards", "rites", "events", "actions"
            }) as Dictionary<string, object>;

            Assert.NotNull(projected);
            Assert.True(projected.ContainsKey("cards"));
            Assert.True(projected.ContainsKey("rites"));
            Assert.True(projected.ContainsKey("events"));
            var values = Assert.IsType<Dictionary<string, object>>(projected["values"]);
            Assert.Equal(2, values["day"]);
            Assert.Equal(true, values["inGame"]);
            Assert.Equal(counters, values["counters"]);
            Assert.True(values.ContainsKey("currentEvent"));
            Assert.Equal(2, ((List<Dictionary<string, object>>)projected["events"]).Count);
        }

        [Fact]
        public void DerivedChoiceIdentity_IsStableAndContentSensitive()
        {
            var first = StateProjector.BuildDerivedChoiceIdentity(
                " Choose   your origin ",
                new[] { "Merchant", "Scholar" });
            var same = StateProjector.BuildDerivedChoiceIdentity(
                "choose your origin",
                new[] { "merchant", "scholar" });
            var different = StateProjector.BuildDerivedChoiceIdentity(
                "choose your origin",
                new[] { "Merchant", "Soldier" });

            Assert.Equal(first, same);
            Assert.NotEqual(first, different);
        }

        [Fact]
        public void DailyNews_EmptySnapshot_HasExpectedDefaults()
        {
            var news = GameBindings.ReadDailyNewsSnapshot();
            Assert.NotNull(news);
            Assert.True(news.ContainsKey("present"));
            Assert.True(news.ContainsKey("open"));
            Assert.True(news.ContainsKey("entryAvailable"));
            Assert.True(news.ContainsKey("summary"));
            Assert.Equal(false, news["present"]);
            Assert.Equal(false, news["open"]);
        }
    }
}
