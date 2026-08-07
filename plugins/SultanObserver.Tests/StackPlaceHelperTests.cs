using VibeSultan.Sultan.Observer.State;
using Xunit;

namespace VibeSultan.Sultan.Observer.Tests
{
    public class StackPlaceHelperTests
    {
        [Fact]
        public void ParseCostMin_BookstoreGoldCost()
        {
            var condition = "{\"type\":\"item\",\"any\":{\"cost.金币\":1,\"is\":2000525}}";
            Assert.Equal(1, StackPlaceHelper.ParseCostMin(condition, preferredCostTag: "金币"));
        }

        [Fact]
        public void ParseCostMin_BathhouseFromText()
        {
            Assert.Equal(
                1,
                StackPlaceHelper.ParseCostMin(
                    null,
                    "你必须置入1金币作为入场费，除非你拥有一张洗浴金卡",
                    "金币"));
        }

        [Fact]
        public void ParseCostMin_RangeUsesMinimum()
        {
            var condition = "{\"type\":\"item\",\"cost.谗言\":[1,999]}";
            Assert.Equal(1, StackPlaceHelper.ParseCostMin(condition));
        }

        [Fact]
        public void ResolvePlaceCount_AutoSplitsToCost()
        {
            Assert.Equal(1, StackPlaceHelper.ResolvePlaceCount(null, stackCount: 5, costMin: 1));
        }

        [Fact]
        public void ResolvePlaceCount_ExplicitCountWins()
        {
            Assert.Equal(2, StackPlaceHelper.ResolvePlaceCount(2, stackCount: 5, costMin: 1));
        }

        [Fact]
        public void ResolvePlaceCount_NoSplitWhenWholeStackNeeded()
        {
            Assert.Null(StackPlaceHelper.ResolvePlaceCount(null, stackCount: 3, costMin: 3));
            Assert.Null(StackPlaceHelper.ResolvePlaceCount(null, stackCount: 1, costMin: 1));
        }
    }
}
