using System.Collections.Generic;
using VibeSultan.Sultan.Observer.State;
using Xunit;

namespace VibeSultan.Sultan.Observer.Tests
{
    public class SceneContractTests
    {
        [Fact]
        public void ElementId_IsStableAcrossCaseWhitespaceAndSlashStyle()
        {
            var a = SceneElementId.Create("GameScene", "Canvas\\Panel / Confirm Button", "Button");
            var b = SceneElementId.Create("gamescene", "canvas/panel/confirm button", "button");
            Assert.Equal(a, b);
            Assert.StartsWith("ui:", a);
        }

        [Fact]
        public void NormalizeText_StripsRichTextAndCollapsesWhitespace()
        {
            Assert.Equal("选择 你的 出身", SceneText.Normalize("<b>选择</b>\n 你的\t出身"));
        }

        [Fact]
        public void SceneDiff_DetectsModalAndElementChanges()
        {
            var before = Snapshot(1, "story", "option");
            before.elements.Add(new UiElementInfo
            {
                elementId = "semantic:option_0",
                role = "toggle",
                text = "商人贵族",
                visible = true,
                interactable = true
            });

            var after = Snapshot(2, "sudan_draw", "begin_guide");
            after.elements.Add(new UiElementInfo
            {
                elementId = "semantic:sudan_box",
                role = "button",
                text = "苏丹卡匣",
                visible = true,
                interactable = true
            });

            var diff = SceneDiffer.Compare(before, after);
            Assert.True(diff.changed);
            Assert.True(diff.screenChanged);
            Assert.Equal("success", diff.result);
            Assert.Contains("scene.phase", diff.changes.Keys);
            Assert.Contains("elements", diff.changes.Keys);
        }

        [Fact]
        public void SceneDiff_IgnoresMainChromeStatusNoise()
        {
            var before = Snapshot(1, "play", null);
            var after = Snapshot(2, "play", null);
            after.elements.Add(new UiElementInfo
            {
                elementId = "semantic:main_status_5",
                role = "status",
                text = "金骰: 3",
                visible = true,
                interactable = false
            });
            after.elements.Add(new UiElementInfo
            {
                elementId = "semantic:hand_31",
                role = "card",
                text = "梅姬",
                visible = true,
                interactable = true
            });

            var diff = SceneDiffer.Compare(before, after);
            Assert.True(diff.changed);
            var elements = Assert.IsType<Dictionary<string, object>>(diff.changes["elements"]);
            var added = Assert.IsType<List<string>>(elements["added"]);
            Assert.Contains(added, s => s.StartsWith("semantic:hand_31"));
            Assert.DoesNotContain(added, s => s.StartsWith("semantic:main_status_"));
        }

        [Fact]
        public void SceneDiff_ReportsNoEffectForEquivalentSnapshots()
        {
            var before = Snapshot(1, "play", null);
            var after = Snapshot(2, "play", null);
            Assert.Equal("no_effect", SceneDiffer.Compare(before, after).result);
        }

        [Fact]
        public void SceneDiff_DetectsNestedSudanTelemetryChange()
        {
            var before = Snapshot(1, "sudan_draw", "begin_guide");
            before.telemetry["sudan"] = new Dictionary<string, object>
                { ["redrawTimes"] = 0, ["boxTips"] = "card A" };
            var after = Snapshot(2, "sudan_draw", "begin_guide");
            after.telemetry["sudan"] = new Dictionary<string, object>
                { ["redrawTimes"] = 1, ["boxTips"] = "card B" };

            var diff = SceneDiffer.Compare(before, after);
            Assert.True(diff.changed);
            Assert.Contains("telemetry.sudan", diff.changes.Keys);
        }

        [Theory]
        [InlineData("difficulty", null, false)]
        [InlineData("difficulty", "draw_sudan_card", false)]
        [InlineData("prompt", "draw_sudan_card", false)]
        [InlineData("sudan_box", null, true)]
        [InlineData("begin_guide", "draw_sudan_card", true)]
        [InlineData("begin_guide", "continue", false)]
        public void SudanDrawPolicy_RequiresForegroundSudanAffordance(
            string topOverlay,
            string guidePreferred,
            bool expected)
        {
            Assert.Equal(
                expected,
                SceneInteractionPolicy.CanOfferSudanDraw(topOverlay, guidePreferred));
        }

        [Fact]
        public void ForegroundFilter_RemovesBackgroundContentAndDisabledActions()
        {
            var snapshot = Snapshot(3, "difficulty", "difficulty");
            snapshot.scene.blocking = true;
            snapshot.elements.Add(new UiElementInfo
            {
                elementId = "ui:difficulty_text",
                overlayId = "difficulty",
                role = "text",
                text = "Choose difficulty",
                visible = true
            });
            snapshot.elements.Add(new UiElementInfo
            {
                elementId = "ui:sudan_box",
                overlayId = "sudan_box",
                role = "button",
                text = "SudanBox",
                visible = true,
                interactable = false,
                blocked = true
            });
            snapshot.elements.Add(new UiElementInfo
            {
                elementId = "semantic:difficulty_confirm",
                role = "button",
                visible = true,
                interactable = true
            });
            snapshot.affordances.Add(new UiAffordanceInfo
            {
                action = "select_difficulty",
                targetId = "semantic:difficulty_confirm",
                enabled = true
            });
            snapshot.affordances.Add(new UiAffordanceInfo
            {
                action = "draw_sudan_card",
                targetId = "ui:sudan_box",
                enabled = false,
                reason = "blocked_by_modal"
            });

            SceneForegroundFilter.Apply(snapshot);

            Assert.Equal(2, snapshot.elements.Count);
            Assert.DoesNotContain(snapshot.elements, e => e.elementId == "ui:sudan_box");
            Assert.Single(snapshot.affordances);
            Assert.Equal("select_difficulty", snapshot.affordances[0].action);
            Assert.Equal(true, snapshot.diagnostics["backgroundFiltered"]);
        }

        [Theory]
        [InlineData("RITE_STOP", null, null, "reset")]
        [InlineData(null, "BEGIN_GUIDE_RITE_STOP_PROMPT", null, "reset")]
        [InlineData(null, null, "UI/StopRite", "reset")]
        [InlineData("CHANGE_SUDAN", null, null, "draw_sudan_card")]
        [InlineData("NEXT_DAY", null, null, "continue")]
        [InlineData(null, null, null, null)]
        public void BeginGuidePreferredOp_ResolvesFromTypeTextKeyOrBind(
            string type,
            string textKey,
            string bind,
            string expected)
        {
            Assert.Equal(expected, GameBindings.ResolveBeginGuidePreferredOp(type, textKey, bind));
        }

        [Fact]
        public void ForegroundFilter_KeepsRiteStopBroomTaggedWithBeginGuide()
        {
            var snapshot = Snapshot(9, "rite", "begin_guide");
            snapshot.scene.blocking = true;
            snapshot.elements.Add(new UiElementInfo
            {
                elementId = "semantic:rite_clear_submission",
                overlayId = "begin_guide",
                role = "button",
                text = "Clear rite submission and unlock cards (broom)",
                visible = true,
                interactable = true,
                preferredOp = "reset"
            });
            snapshot.elements.Add(new UiElementInfo
            {
                elementId = "semantic:hand_29",
                overlayId = null,
                role = "card",
                text = "阿尔图",
                visible = true,
                interactable = true
            });
            snapshot.affordances.Add(new UiAffordanceInfo
            {
                action = "reset",
                targetId = "semantic:rite_clear_submission",
                enabled = true,
                mapsToOp = "reset"
            });

            SceneForegroundFilter.Apply(snapshot);

            Assert.Contains(snapshot.elements, e => e.elementId == "semantic:rite_clear_submission");
            Assert.DoesNotContain(snapshot.elements, e => e.elementId == "semantic:hand_29");
            Assert.Single(snapshot.affordances);
            Assert.Equal("reset", snapshot.affordances[0].action);
        }

        [Theory]
        [InlineData("wizard", "wizard_choice", false)]
        [InlineData("difficulty", "difficulty", false)]
        [InlineData("option", "story_option", false)]
        [InlineData("prompt", "intro_or_tip", true)]
        [InlineData("wizard", "wizard", true)]
        public void GenericContinuePolicy_DoesNotBypassChoiceMenus(
            string topOverlay,
            string topKind,
            bool expected)
        {
            Assert.Equal(
                expected,
                SceneInteractionPolicy.CanOfferGenericContinue(topOverlay, topKind));
        }

        [Theory]
        [InlineData(false, false, false, false)]
        [InlineData(true, false, false, true)]
        [InlineData(false, true, true, true)]
        [InlineData(false, true, false, false)]
        [InlineData(true, true, true, true)]
        public void TerminalPolicy_IgnoresUnsetOverReasonSentinel(
            bool success,
            bool gameOver,
            bool inGame,
            bool expected)
        {
            Assert.Equal(expected, SceneInteractionPolicy.IsTerminal(success, gameOver, inGame));
        }

        [Theory]
        [InlineData(1, 1, false, false, false, false)]
        [InlineData(1, 0, false, false, false, false)] // round_0 is never a valid rewind target
        [InlineData(2, 0, false, false, false, true)]
        [InlineData(2, 1, false, false, false, true)]
        [InlineData(2, 1, true, false, false, false)] // overlay blocks while not terminal
        [InlineData(2, 1, false, true, false, true)] // failure game-over can rewind
        [InlineData(2, 1, true, true, false, true)] // failure game-over ignores soft overlay
        [InlineData(2, 1, false, true, true, false)] // victory cannot rewind
        [InlineData(5, 5, false, false, false, false)]
        public void PrevRoundPolicy_RequiresRoundAboveMinRound(
            int round,
            int minRound,
            bool overlayBlocking,
            bool terminal,
            bool success,
            bool expected)
        {
            Assert.Equal(
                expected,
                SceneInteractionPolicy.CanPrevRound(round, minRound, overlayBlocking, terminal, success));
        }

        [Theory]
        [InlineData(1, 7, "7/7")]
        [InlineData(2, 7, "6/7")]
        [InlineData(7, 7, "1/7")]
        [InlineData(8, 7, "0/7")]
        [InlineData(0, 7, "7/7")]
        [InlineData(3, 0, "3")]
        public void ExecutionDay_IsCountdownRemainingOverInitLife(int round, int initLife, string expected)
        {
            Assert.Equal(expected, SceneInteractionPolicy.FormatExecutionDay(round, initLife));
            if (initLife > 0 && expected != null && expected.Contains("/"))
            {
                var left = int.Parse(expected.Split('/')[0]);
                Assert.Equal(left, SceneInteractionPolicy.ComputeExecutionDaysLeft(round, initLife));
            }
        }

        [Theory]
        [InlineData(7, 0, 6, "7/7")]   // fresh card: life=0 => full window
        [InlineData(7, 2, 6, "5/7")]   // live copper 纵欲: life=2 => 5 remaining
        [InlineData(7, 6, 6, "1/7")]   // last day
        [InlineData(7, 7, 6, "0/7")]   // expired
        public void ExecutionDay_PrefersCardFaceLifeOverRound(
            int initLife, int cardLife, int round, string expected)
        {
            Assert.Equal(
                expected,
                SceneInteractionPolicy.FormatExecutionDay(round, initLife, cardLife));
            var left = int.Parse(expected.Split('/')[0]);
            Assert.Equal(
                left,
                SceneInteractionPolicy.ComputeExecutionDaysLeft(initLife, cardLife, round));
            // Round-only fallback must NOT override card face when life is present.
            Assert.NotEqual(
                SceneInteractionPolicy.ComputeExecutionDaysLeft(round, initLife),
                left);
        }

        [Fact]
        public void ExecutionDay_MultiCardUsesMostUrgentLife()
        {
            // 纵欲 life=1 => 6 left; 金杀戮 life=0 => 7 left; urgency = max(life)=1 => 6/7.
            const int urgentLife = 1;
            Assert.Equal(
                "6/7",
                SceneInteractionPolicy.FormatExecutionDay(5, 7, urgentLife));
            Assert.Equal(
                6,
                SceneInteractionPolicy.ComputeExecutionDaysLeft(7, urgentLife, 5));
        }

        [Theory]
        [InlineData(false, false, false, false, true, false, true)]
        // StoryEntry / story book availability alone must NOT enable daily news.
        [InlineData(false, false, false, false, false, true, false)]
        [InlineData(true, false, false, false, true, true, false)]
        [InlineData(false, true, false, false, true, true, false)]
        [InlineData(false, false, true, false, true, true, false)]
        [InlineData(false, false, false, true, true, true, false)]
        [InlineData(false, false, false, false, false, false, false)]
        public void DailyNewsPolicy_RequiresPlayableForeground(
            bool overlayBlocking,
            bool terminal,
            bool riteOpen,
            bool guideActive,
            bool newsPresent,
            bool entryAvailable,
            bool expected)
        {
            Assert.Equal(
                expected,
                SceneInteractionPolicy.CanOfferDailyNews(
                    overlayBlocking, terminal, riteOpen, guideActive, newsPresent, entryAvailable));
        }

        [Fact]
        public void NormalizeText_SupportsDailyNewsSummaryCleaning()
        {
            Assert.Equal(
                "今日朝堂 传来 新消息",
                SceneText.Normalize("<i>今日朝堂</i>\n 传来\t新消息"));
        }

        [Fact]
        public void ConfigCatalog_ResolvesSeededCardAndRiteNames()
        {
            var catalog = ConfigCatalog.Instance;
            catalog.ResetForTests();
            catalog.SeedCardForTests(2000001, "阿尔图", "被选中的人", "char");
            catalog.SeedRiteForTests(5000804, "索拉薇儿的游戏");

            Assert.Equal("阿尔图", catalog.ResolveCardName(2000001));
            Assert.Equal("自定义名", catalog.ResolveCardName(2000001, "自定义名"));
            Assert.Equal("char#9", catalog.ResolveCardName(9, null, "char"));
            Assert.Equal("索拉薇儿的游戏", catalog.ResolveRiteName(5000804));
            Assert.Equal("rite#1", catalog.ResolveRiteName(1));
            catalog.ResetForTests();
        }

        [Fact]
        public void ConfigCatalog_BuildCardSummaryIncludesCatalogText()
        {
            var catalog = ConfigCatalog.Instance;
            catalog.ResetForTests();
            catalog.SeedCardForTests(2000024, "苏丹", "至高苏丹", "char", "宫廷中心的权力本身");

            var summary = catalog.BuildCardSummary(2000024);
            Assert.Equal(2000024, summary["cardId"]);
            Assert.Equal("苏丹", summary["name"]);
            Assert.Equal("至高苏丹", summary["title"]);
            Assert.Equal("char", summary["type"]);
            Assert.Equal("宫廷中心的权力本身", summary["text"]);
            catalog.ResetForTests();
        }

        [Fact]
        public void RiteSlotSignature_ChangesWhenOccupancyChanges()
        {
            var before = new List<Dictionary<string, object>>
            {
                new()
                {
                    ["index"] = 0,
                    ["occupied"] = false,
                    ["cardUid"] = null,
                    ["text"] = "纵欲卡"
                }
            };
            var after = new List<Dictionary<string, object>>
            {
                new()
                {
                    ["index"] = 0,
                    ["occupied"] = true,
                    ["cardUid"] = 17,
                    ["text"] = "纵欲卡"
                }
            };

            Assert.NotEqual(
                RiteSlotProjector.SlotSignature(before),
                RiteSlotProjector.SlotSignature(after));
        }

        [Fact]
        public void RiteSlotInspectElement_CarriesCompleteCardSummary()
        {
            var summary = new Dictionary<string, object>
            {
                ["cardId"] = 2000352,
                ["name"] = "玛希尔",
                ["rare"] = 2,
                ["tags"] = new Dictionary<string, object>
                {
                    ["智慧"] = 5,
                    ["工匠"] = 1
                }
            };
            var element = new UiElementInfo
            {
                elementId = "semantic:rite_slot_card_0",
                role = "card",
                preferredOp = "inspect_card",
                actionParams = new Dictionary<string, object>
                {
                    ["uid"] = 124,
                    ["slotIndex"] = 0,
                    ["cardSummary"] = summary
                }
            };

            var projected = Assert.IsType<Dictionary<string, object>>(
                element.actionParams["cardSummary"]);
            var tags = Assert.IsType<Dictionary<string, object>>(projected["tags"]);
            Assert.Equal(5, tags["智慧"]);
            Assert.Equal(1, tags["工匠"]);
        }

        [Fact]
        public void ElementRegistry_RejectsStaleAndBlockedTargets()
        {
            var registry = new UiAdapterRegistry();
            registry.BeginSnapshot(7);
            registry.Register(new UiAdapterRegistry.ElementHandle
            {
                elementId = "semantic:continue",
                snapshotVersion = 7,
                visible = true,
                interactable = true,
                blocked = true
            });
            registry.CommitSnapshot(7, 7);

            Assert.Equal("stale_scene", registry.Resolve("semantic:continue", 6).error);
            Assert.Equal("blocked_by_modal", registry.Resolve("semantic:continue", 7).error);
        }

        [Fact]
        public void Normalizer_DeduplicatesSortsAndTruncates()
        {
            var snapshot = Snapshot(1, "play", null);
            snapshot.elements.Add(new UiElementInfo
                { elementId = "z", role = "text", visible = true, interactable = false });
            snapshot.elements.Add(new UiElementInfo
                { elementId = "a", role = "button", visible = true, interactable = true });
            snapshot.elements.Add(new UiElementInfo
                { elementId = "a", role = "button", visible = true, interactable = true });

            SceneSnapshotNormalizer.Normalize(snapshot, maxElements: 1);

            Assert.Single(snapshot.elements);
            Assert.Equal("a", snapshot.elements[0].elementId);
            Assert.True(snapshot.truncated);
        }

        [Theory]
        [InlineData("交换手上的苏丹卡", true)]
        [InlineData("  交换手上的苏丹卡  ", true)]
        [InlineData("疯狂到底，再来一张苏丹卡", false)]
        [InlineData("再来一张苏丹卡", false)]
        [InlineData("交换手上的苏丹卡再来一张", false)]
        [InlineData("", false)]
        public void ExchangeLabel_MatchesExactExchangeOnly(string label, bool expected)
        {
            Assert.Equal(expected, SudanCardActionPolicy.IsExchangeSudanCardLabel(label));
        }

        [Fact]
        public void RedrawRemaining_AndOpenExchangeGates()
        {
            Assert.Equal(2, SudanCardActionPolicy.ComputeRedrawRemaining(1, 3));
            Assert.Equal(0, SudanCardActionPolicy.ComputeRedrawRemaining(3, 3));
            Assert.True(SudanCardActionPolicy.CanOfferOpenSudanBox(
                terminal: false,
                overlayBlocking: false,
                sudanDrawBlocking: false,
                boxPresent: true));
            Assert.False(SudanCardActionPolicy.CanOfferOpenSudanBox(
                terminal: false,
                overlayBlocking: false,
                sudanDrawBlocking: true,
                boxPresent: true));
            Assert.True(SudanCardActionPolicy.CanOfferExchangeSudanCard(
                wizardChoiceMenu: true, redrawRemaining: 2, exchangeButtonPresent: true));
            Assert.False(SudanCardActionPolicy.CanOfferExchangeSudanCard(
                wizardChoiceMenu: true, redrawRemaining: 0, exchangeButtonPresent: true));
        }

        [Theory]
        [InlineData(true, true, false, 2, true, true, "choice")]
        [InlineData(true, false, true, 2, false, true, "dropper")]
        [InlineData(true, false, true, 0, false, true, "unavailable")]
        [InlineData(true, false, true, 2, false, false, "unavailable")]
        [InlineData(false, false, false, 2, false, true, "unavailable")]
        public void ExchangePhase_CoversChoiceAndDropper(
            bool wizardActive,
            bool choiceMenu,
            bool dropperActive,
            int redrawRemaining,
            bool buttonPresent,
            bool currentCardPresent,
            string expected)
        {
            Assert.Equal(expected, SudanCardActionPolicy.ResolveExchangePhase(
                wizardActive,
                choiceMenu,
                dropperActive,
                redrawRemaining,
                buttonPresent,
                currentCardPresent));
        }

        [Fact]
        public void ExchangeDropper_RemainsAvailableAfterChoiceButtonDisappears()
        {
            Assert.True(SudanCardActionPolicy.CanCompleteExchangeDropper(
                wizardActive: true,
                redrawDropperActive: true,
                redrawRemaining: 2,
                currentCardPresent: true));
        }

        private static SceneSnapshot Snapshot(long version, string phase, string modal)
        {
            return new SceneSnapshot
            {
                snapshotVersion = version,
                scene = new SceneDescriptor { id = "play", phase = phase, modal = modal },
                telemetry = new Dictionary<string, object> { ["day"] = 1 }
            };
        }
    }
}
