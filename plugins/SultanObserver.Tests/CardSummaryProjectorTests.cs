using System;
using System.Collections.Generic;
using System.Linq;
using VibeSultan.Sultan.Observer.State;
using Xunit;

namespace VibeSultan.Sultan.Observer.Tests
{
    public class CardSummaryProjectorTests
    {
        [Fact]
        public void BuildCardSummary_IncludesCompactCatalogTags()
        {
            var catalog = ConfigCatalog.Instance;
            catalog.ResetForTests();
            catalog.SeedCardForTests(
                2000352,
                "玛希尔",
                "怪才工匠",
                "char",
                "发明家",
                new Dictionary<string, int>
                {
                    ["智慧"] = 5,
                    ["贵族"] = 1,
                    ["无效"] = 0,
                    ["风险"] = -1
                });

            var summary = catalog.BuildCardSummary(2000352);
            var tags = Assert.IsType<Dictionary<string, object>>(summary["tags"]);

            Assert.Equal(
                new[] { "智慧", "贵族", "风险" }.OrderBy(x => x, StringComparer.Ordinal),
                tags.Keys);
            Assert.Equal(5, tags["智慧"]);
            Assert.Equal(1, tags["贵族"]);
            Assert.Equal(-1, tags["风险"]);
            Assert.False(tags.ContainsKey("无效"));
            catalog.ResetForTests();
        }

        [Fact]
        public void MergeTags_OverlaysRuntimeValuesWithoutWipingCatalog()
        {
            var summary = new Dictionary<string, object>
            {
                ["tags"] = new Dictionary<string, object>
                {
                    ["智慧"] = 1,
                    ["贵族"] = 1,
                    ["体魄"] = 3
                }
            };

            CardSummaryProjector.MergeTags(
                summary,
                new[]
                {
                    new KeyValuePair<string, int>("wisdom", 2),
                    new KeyValuePair<string, int>("魅力", 2),
                    new KeyValuePair<string, int>("adsorb_spec", 1),
                    new KeyValuePair<string, int>("体魄", 0)
                });

            var tags = Assert.IsType<Dictionary<string, object>>(summary["tags"]);
            Assert.Equal(2, tags["智慧"]);
            Assert.Equal(1, tags["贵族"]);
            Assert.Equal(3, tags["体魄"]);
            Assert.Equal(2, tags["魅力"]);
            Assert.Equal(1, tags["adsorb_spec"]);
            Assert.False(tags.ContainsKey("wisdom"));
        }

        [Fact]
        public void MergeTags_LeavesSummaryUsableWhenTagsAreMissing()
        {
            var summary = new Dictionary<string, object> { ["name"] = "玛希尔" };

            CardSummaryProjector.MergeTags(summary, null);

            Assert.Equal("玛希尔", summary["name"]);
            Assert.False(summary.ContainsKey("tags"));
        }

        [Fact]
        public void MergeTags_SkipsKeysThatNormalizeToEmpty()
        {
            var summary = new Dictionary<string, object>
            {
                ["tags"] = new Dictionary<string, object> { ["魅力"] = 1 }
            };

            CardSummaryProjector.MergeTags(
                summary,
                new[]
                {
                    new KeyValuePair<string, int>("魅力", 2),
                    new KeyValuePair<string, int>("   ", 9)
                });

            var tags = Assert.IsType<Dictionary<string, object>>(summary["tags"]);
            Assert.Equal(2, tags["魅力"]);
            Assert.False(tags.Keys.Any(string.IsNullOrWhiteSpace));
        }

        [Fact]
        public void NormalizeTagKey_MapsEnglishCoreAttrs()
        {
            Assert.Equal("智慧", CardSummaryProjector.NormalizeTagKey("wisdom"));
            Assert.Equal("战斗", CardSummaryProjector.NormalizeTagKey("combat"));
            Assert.Equal("贵族", CardSummaryProjector.NormalizeTagKey("贵族"));
        }

        [Fact]
        public void BuildCardSummary_IncludesCatalogEquipSlotTypesForCharacters()
        {
            var catalog = ConfigCatalog.Instance;
            catalog.ResetForTests();
            catalog.SeedCardForTests(
                2000006,
                "梅姬",
                "妻子",
                "char",
                "你的妻子",
                new Dictionary<string, int> { ["已拥有"] = 1, ["追随者"] = 1 },
                new[] { "武器", "服装", "饰品" });

            var summary = catalog.BuildCardSummary(2000006);
            var slots = Assert.IsType<List<string>>(summary["equipSlotTypes"]);
            Assert.Equal(new[] { "武器", "服装", "饰品" }, slots);
            catalog.ResetForTests();
        }

        [Fact]
        public void ResolveItemSlotType_PrefersAccessoryTag()
        {
            var tags = new Dictionary<string, object>
            {
                ["装备"] = 1,
                ["饰品"] = 1,
                ["魅力"] = 1
            };
            Assert.Equal("饰品", EquipmentProjector.ResolveItemSlotType(tags));
            Assert.True(EquipmentProjector.IsCharacterType("char"));
            Assert.True(EquipmentProjector.IsItemType("item"));
        }

        [Fact]
        public void NormalizeSlotType_MapsEnglishRuntimeSlots()
        {
            Assert.Equal("武器", EquipmentProjector.NormalizeSlotType("weapon"));
            Assert.Equal("服装", EquipmentProjector.NormalizeSlotType("cloth"));
            Assert.Equal("饰品", EquipmentProjector.NormalizeSlotType("accessory"));
            Assert.True(
                EquipmentProjector.SlotTypesCompatible(
                    new[] { "weapon", "cloth", "accessory" },
                    "饰品"));
        }

        [Fact]
        public void BuildEquippedRow_MergesCatalogAttrsOverSparseRuntimeTags()
        {
            var catalog = ConfigCatalog.Instance;
            catalog.ResetForTests();
            catalog.SeedCardForTests(
                2000263,
                "白银手镯",
                "饰品",
                "item",
                "粗制的白银手镯，勉强为你增色几分。",
                new Dictionary<string, int>
                {
                    ["装备"] = 1,
                    ["饰品"] = 1,
                    ["魅力"] = 1,
                    ["已装备"] = 1
                });

            var row = EquipmentProjector.BuildEquippedRow(
                2000263,
                null,
                "item",
                uid: 86,
                rare: 1,
                runtimeTags: new[]
                {
                    new KeyValuePair<string, int>("own", 1),
                    new KeyValuePair<string, int>("weapon_keep", 1)
                });

            Assert.Equal(86, row["uid"]);
            Assert.Equal("白银手镯", row["name"]);
            Assert.Equal("饰品", row["slotType"]);
            Assert.Equal("饰品", row["title"]);
            Assert.Contains("增色", row["text"]?.ToString() ?? string.Empty);

            var tags = Assert.IsType<Dictionary<string, object>>(row["tags"]);
            Assert.Equal(1, tags["魅力"]);
            Assert.Equal(1, tags["装备"]);
            Assert.Equal(1, tags["own"]);

            var attrBonus = Assert.IsType<Dictionary<string, object>>(row["attrBonus"]);
            Assert.Equal(1, attrBonus["魅力"]);
            catalog.ResetForTests();
        }

        [Fact]
        public void AttachEquippedInsight_ExposesCharacterTagsAndEquipBonus()
        {
            var catalog = ConfigCatalog.Instance;
            catalog.ResetForTests();
            catalog.SeedCardForTests(
                2000006,
                "梅姬",
                "妻子",
                "char",
                "你的妻子",
                new Dictionary<string, int> { ["魅力"] = 2, ["社交"] = 3, ["追随者"] = 1 },
                new[] { "武器", "服装", "饰品" });
            catalog.SeedCardForTests(
                2000263,
                "白银手镯",
                "饰品",
                "item",
                "粗制的白银手镯",
                new Dictionary<string, int> { ["装备"] = 1, ["饰品"] = 1, ["魅力"] = 1 });

            var equipped = new List<Dictionary<string, object>>
            {
                EquipmentProjector.BuildEquippedRow(2000263, uid: 86, rare: 1)
            };
            var target = new Dictionary<string, object>();
            EquipmentProjector.AttachEquippedInsight(
                target,
                2000006,
                null,
                "char",
                equipped,
                runtimeTags: new[] { new KeyValuePair<string, int>("adherent", 1) });

            var tags = Assert.IsType<Dictionary<string, object>>(target["tags"]);
            Assert.Equal(2, tags["魅力"]);
            Assert.Equal(1, tags["adherent"]);
            Assert.Equal(1, target["equippedCount"]);
            var bonus = Assert.IsType<Dictionary<string, object>>(target["equipBonus"]);
            Assert.Equal(1, bonus["魅力"]);
            catalog.ResetForTests();
        }
    }
}
