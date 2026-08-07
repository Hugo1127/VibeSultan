using System.Collections.Generic;
using VibeSultan.Sultan.Observer.State;
using Xunit;

namespace VibeSultan.Sultan.Observer.Tests
{
    public class CompactProjectorTests
    {
        [Fact]
        public void ParseViews_SplitsCommaList()
        {
            var views = CompactProjector.ParseViews("?views=cards,rites,diagnostics");
            Assert.Contains("cards", views);
            Assert.Contains("rites", views);
            Assert.Contains("diagnostics", views);
        }

        [Fact]
        public void Project_Default_IsSummary()
        {
            var state = GameState.CreateEmpty();
            state.values["day"] = 3;
            state.values["cards"] = new[] { "c1" };
            state.values["noise"] = 123;
            var projected = CompactProjector.Project(state, new HashSet<string>()) as Dictionary<string, object>;
            Assert.NotNull(projected);
            Assert.Equal("summary", projected["view"]);
            var values = Assert.IsType<Dictionary<string, object>>(projected["values"]);
            Assert.True(values.ContainsKey("day"));
            Assert.False(values.ContainsKey("noise"));
            Assert.False(values.ContainsKey("cards"));
        }

        [Fact]
        public void Project_CardsView_IncludesCards()
        {
            var state = GameState.CreateEmpty();
            state.values["cards"] = new[] { "c1", "c2" };
            var views = new HashSet<string> { "cards" };
            var projected = CompactProjector.Project(state, views) as Dictionary<string, object>;
            Assert.NotNull(projected);
            Assert.True(projected.ContainsKey("cards"));
        }

        [Fact]
        public void Project_CardsAllView_IncludesInventoryOnly()
        {
            var state = GameState.CreateEmpty();
            state.values["cards"] = new[] { "visible" };
            state.values["cardsAll"] = new[] { "visible", "hidden_ether" };
            var projected = Assert.IsType<Dictionary<string, object>>(
                CompactProjector.Project(state, new HashSet<string> { "cards_all" }));
            Assert.True(projected.ContainsKey("cardsAll"));
            Assert.False(projected.ContainsKey("cards"));
        }

        [Fact]
        public void Project_RitesEventsValues_IncludeBootFields()
        {
            var state = GameState.CreateEmpty();
            state.values["rites"] = new[] { "r1" };
            state.values["events"] = new[] { "e1" };
            state.values["initDone"] = true;
            state.values["inGame"] = true;
            state.values["day"] = 4;
            var views = new HashSet<string> { "rites", "events", "values" };
            var projected = CompactProjector.Project(state, views) as Dictionary<string, object>;
            Assert.NotNull(projected);
            Assert.True(projected.ContainsKey("rites"));
            Assert.True(projected.ContainsKey("events"));
            var values = Assert.IsType<Dictionary<string, object>>(projected["values"]);
            Assert.Equal(true, values["initDone"]);
            Assert.Equal(true, values["inGame"]);
            Assert.Equal(4, values["day"]);
        }

        [Fact]
        public void Project_SummaryRetainsGuideAndStepHint()
        {
            var state = GameState.CreateEmpty();
            state.values["guide"] = new Dictionary<string, object>
            {
                ["active"] = true,
                ["type"] = "CHANGE_SUDAN_CARD"
            };
            state.values["stepHint"] = "Click the metal box";
            var projected = Assert.IsType<Dictionary<string, object>>(
                CompactProjector.Project(state, new HashSet<string>()));
            var values = Assert.IsType<Dictionary<string, object>>(projected["values"]);
            Assert.True(values.ContainsKey("guide"));
            Assert.Equal("Click the metal box", values["stepHint"]);
        }

        [Fact]
        public void Project_SummaryRetainsDailyNews()
        {
            var state = GameState.CreateEmpty();
            state.values["dailyNews"] = new Dictionary<string, object>
            {
                ["present"] = true,
                ["open"] = false,
                ["summary"] = "朝堂有新消息"
            };
            var projected = Assert.IsType<Dictionary<string, object>>(
                CompactProjector.Project(state, new HashSet<string>()));
            var values = Assert.IsType<Dictionary<string, object>>(projected["values"]);
            Assert.True(values.ContainsKey("dailyNews"));
            var news = Assert.IsType<Dictionary<string, object>>(values["dailyNews"]);
            Assert.Equal(true, news["present"]);
            Assert.Equal("朝堂有新消息", news["summary"]);
        }

        [Fact]
        public void Project_SummaryRetainsRiteResult()
        {
            var state = GameState.CreateEmpty();
            state.values["riteResult"] = new Dictionary<string, object>
            {
                ["active"] = true,
                ["stage"] = "awaiting_roll",
                ["tip"] = "3点成功将会获得最高的收益。",
                ["goldDiceAvailable"] = 1
            };
            var projected = Assert.IsType<Dictionary<string, object>>(
                CompactProjector.Project(state, new HashSet<string>()));
            var values = Assert.IsType<Dictionary<string, object>>(projected["values"]);
            Assert.True(values.ContainsKey("riteResult"));
            var rite = Assert.IsType<Dictionary<string, object>>(values["riteResult"]);
            Assert.Equal(true, rite["active"]);
            Assert.Equal("3点成功将会获得最高的收益。", rite["tip"]);
        }

        [Fact]
        public void Project_SummaryRetainsCurrentRiteCardTags()
        {
            var state = GameState.CreateEmpty();
            state.values["currentRite"] = new Dictionary<string, object>
            {
                ["uid"] = 19,
                ["slots"] = new List<Dictionary<string, object>>
                {
                    new()
                    {
                        ["index"] = 0,
                        ["occupied"] = true,
                        ["cardSummary"] = new Dictionary<string, object>
                        {
                            ["name"] = "玛希尔",
                            ["tags"] = new Dictionary<string, object>
                            {
                                ["智慧"] = 5,
                                ["工匠"] = 1
                            }
                        }
                    }
                }
            };

            var projected = Assert.IsType<Dictionary<string, object>>(
                CompactProjector.Project(state, new HashSet<string>()));
            var values = Assert.IsType<Dictionary<string, object>>(projected["values"]);
            var rite = Assert.IsType<Dictionary<string, object>>(values["currentRite"]);
            var slots = Assert.IsType<List<Dictionary<string, object>>>(rite["slots"]);
            var summary = Assert.IsType<Dictionary<string, object>>(slots[0]["cardSummary"]);
            var tags = Assert.IsType<Dictionary<string, object>>(summary["tags"]);

            Assert.Equal(5, tags["智慧"]);
            Assert.Equal(1, tags["工匠"]);
        }
    }
}
