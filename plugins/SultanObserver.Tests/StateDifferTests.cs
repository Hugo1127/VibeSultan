using System.Collections.Generic;
using VibeSultan.Sultan.Observer.State;
using Xunit;

namespace VibeSultan.Sultan.Observer.Tests
{
    public class StateDifferTests
    {
        [Fact]
        public void Compare_DetectsCardAndCounterChanges()
        {
            var before = EmptyState();
            before.values["day"] = 1;
            before.values["counters"] = new Dictionary<string, object> { ["gold"] = 3 };
            before.values["cards"] = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> { ["uid"] = 10, ["id"] = 100, ["name"] = "A", ["life"] = 1 }
            };

            var after = EmptyState();
            after.values["day"] = 1;
            after.values["counters"] = new Dictionary<string, object> { ["gold"] = 8 };
            after.values["cards"] = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> { ["uid"] = 10, ["id"] = 100, ["name"] = "A", ["life"] = 0 },
                new Dictionary<string, object> { ["uid"] = 11, ["id"] = 101, ["name"] = "B", ["life"] = 1 }
            };

            var delta = StateDiffer.Compare(before, after);
            Assert.True((bool)delta["changed"]);
            Assert.Contains("counters", delta.Keys);
            Assert.Contains("cards", delta.Keys);
        }

        [Fact]
        public void Compare_NoChangeWhenEquivalent()
        {
            var before = EmptyState();
            before.values["day"] = 2;
            before.values["cards"] = new List<Dictionary<string, object>>();
            var after = EmptyState();
            after.values["day"] = 2;
            after.values["cards"] = new List<Dictionary<string, object>>();

            var delta = StateDiffer.Compare(before, after);
            Assert.False((bool)delta["changed"]);
        }

        [Fact]
        public void Compare_DetectsRiteResultSettlementFields()
        {
            var before = EmptyState();
            before.values["riteResult"] = new Dictionary<string, object>
            {
                ["active"] = false,
                ["successCount"] = 0,
                ["successThreshold"] = 2
            };
            var after = EmptyState();
            after.values["riteResult"] = new Dictionary<string, object>
            {
                ["active"] = true,
                ["stage"] = "resolve",
                ["successCount"] = 3,
                ["successThreshold"] = 2,
                ["rewardSummary"] = "+2 gold"
            };

            var delta = StateDiffer.Compare(before, after);
            Assert.True((bool)delta["changed"]);
            Assert.Contains("riteResult", delta.Keys);
            var riteResult = Assert.IsType<Dictionary<string, object>>(delta["riteResult"]);
            Assert.Contains("successCount", riteResult.Keys);
            Assert.Contains("rewardSummary", riteResult.Keys);
        }

        [Fact]
        public void StrategySnapshot_IncludesEnabledOpsAndDeadlines()
        {
            var state = EmptyState();
            state.screen = new ScreenInfo { id = "play", name = "GameScene", phase = "play" };
            state.values["day"] = 2;
            state.values["fingerprint"] = "cfg-fp";
            state.values["sudan"] = new Dictionary<string, object> { ["initLife"] = 7 };
            state.values["rites"] = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object>
                {
                    ["uid"] = 1, ["id"] = 5001, ["name"] = "TestRite", ["life"] = 1, ["start"] = false
                }
            };
            state.actions = new List<ActionInfo>
            {
                new ActionInfo { id = "continue", enabled = true, label = "Continue" },
                new ActionInfo { id = "open_rite", enabled = false, label = "Open" }
            };

            var snap = StrategySnapshotProjector.Build(state);
            Assert.Equal(1, snap["schemaVersion"]);
            Assert.Contains("enabledOps", snap.Keys);
            var ops = Assert.IsType<List<string>>(snap["enabledOps"]);
            Assert.Contains("continue", ops);
            Assert.DoesNotContain("open_rite", ops);
            Assert.Equal(6, snap["executionDaysLeft"]);
        }

        private static GameState EmptyState()
        {
            return new GameState
            {
                schemaVersion = 1,
                game = "sultan",
                values = new Dictionary<string, object>(),
                actions = new List<ActionInfo>()
            };
        }
    }
}
