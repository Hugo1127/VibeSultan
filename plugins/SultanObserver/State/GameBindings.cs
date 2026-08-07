using System;
using System.Collections.Generic;
#if GAME_INTEROP
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
#endif

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Strongly-typed accessors for Sultan IL2CPP interop types.
    /// </summary>
    public static class GameBindings
    {
        public static bool HasInterop
        {
            get
            {
#if GAME_INTEROP
                return true;
#else
                return false;
#endif
            }
        }

        public static string MapBeginGuidePreferredOp(string type) =>
            ResolveBeginGuidePreferredOp(type, null, null);

        /// <summary>
        /// Resolve the domain op the finger-guide expects. Prefer Type, then TextKey, then Bind
        /// (e.g. UI/StopRite), so a missing Type still maps RITE_STOP correctly.
        /// </summary>
        public static string ResolveBeginGuidePreferredOp(string type, string textKey, string bind)
        {
            var fromType = MapBeginGuideToken(type);
            if (!string.IsNullOrEmpty(fromType)) return fromType;

            var fromKey = MapBeginGuideToken(textKey);
            if (!string.IsNullOrEmpty(fromKey)) return fromKey;

            if (!string.IsNullOrEmpty(bind))
            {
                var b = bind.ToUpperInvariant().Replace("\\", "/");
                if (b.Contains("STOPRITE") || b.Contains("STOP_RITE") || b.EndsWith("/STOP"))
                {
                    return "reset";
                }
                if (b.Contains("SUDAN") || b.Contains("REDRAW"))
                {
                    return "draw_sudan_card";
                }
                if (b.Contains("NEXTDAY") || b.Contains("NEXT_DAY") || b.Contains("NEXTROUND"))
                {
                    return "continue";
                }
            }

            return null;
        }

        private static string MapBeginGuideToken(string token)
        {
            if (string.IsNullOrEmpty(token)) return null;
            var t = token.ToUpperInvariant();
            if (t.Contains("SUDAN") || t.Contains("CHANGE_SUDAN") || t.Contains("REDRAW_SUDAN") || t.Contains("DRAW_SUDAN"))
            {
                return "draw_sudan_card";
            }
            if (t.Contains("NEXT_DAY") || t.Contains("BACK_ROUND"))
            {
                return "continue";
            }
            if (t.Contains("RITE_CONFIRM"))
            {
                return "execute";
            }
            if (t.Contains("RITE_STOP"))
            {
                return "reset";
            }
            if (t.Contains("OPTION") || t.Contains("SELECT"))
            {
                return "select_event_option";
            }
            return null;
        }

        public static string MapBeginGuideHint(
            string type,
            string textKey = null,
            string bind = null,
            string preferredOp = null)
        {
            preferredOp ??= ResolveBeginGuidePreferredOp(type, textKey, bind);
            if (string.Equals(preferredOp, "draw_sudan_card", StringComparison.OrdinalIgnoreCase))
            {
                return "Guide wants Sudan card redraw/accept via box interaction — use draw_sudan_card; do not skip the guide";
            }
            if (string.Equals(preferredOp, "continue", StringComparison.OrdinalIgnoreCase)
                || string.Equals(preferredOp, "next_round", StringComparison.OrdinalIgnoreCase))
            {
                return "Guide points at advancing the day — use continue when enabled";
            }
            if (string.Equals(preferredOp, "execute", StringComparison.OrdinalIgnoreCase)
                || string.Equals(preferredOp, "start_rite", StringComparison.OrdinalIgnoreCase))
            {
                return "Guide points at rite confirm — place cards then execute";
            }
            if (string.Equals(preferredOp, "reset", StringComparison.OrdinalIgnoreCase)
                || string.Equals(preferredOp, "clear_rite_submission", StringComparison.OrdinalIgnoreCase))
            {
                return "Guide points at the broom — use reset to clear the submitted rite and unlock its cards";
            }
            if (string.IsNullOrEmpty(type) && string.IsNullOrEmpty(textKey))
            {
                return "Follow on-screen BeginGuide; do not force-close the guide";
            }
            return "Complete the guided gesture for type="
                   + (type ?? textKey ?? bind ?? "?")
                   + "; do not force-close the tutorial";
        }

#if GAME_INTEROP
        public static bool InitDone
        {
            get
            {
                try { return GameApplication.InitDone; }
                catch { return false; }
            }
        }

        public static Player Player
        {
            get
            {
                try { return GameApplication.player; }
                catch { return null; }
            }
        }

        public static Global Global
        {
            get
            {
                try { return GameApplication.global; }
                catch { return null; }
            }
        }

        public static bool InGame
        {
            get
            {
                try { return Global != null && Global.inGame; }
                catch { return false; }
            }
        }

        public static GameController Controller
        {
            get
            {
                try { return GameController.Inst; }
                catch { return null; }
            }
        }

        public static OptionController OptionPanel => Controller?.optionController;
        public static ConfirmController ConfirmPanel => Controller?.confirmController;
        public static RitePanelShowController RitePanel => Controller?.ritePanel;
        public static DifficultyPanelController DifficultyPanel => Controller?.difficultyPanelController;
        public static PromptController PromptPanel => Controller?.promptController;
        public static WizardController WizardPanel => Controller?.wizardController;
        public static PromptChangeNameController ChangeNamePanel => Controller?.promptChangeNameController;
        public static BeginGuideController BeginGuidePanel => Controller?.beginGuideController;

        private static StoryNotifyController _storyNotifyCache;
        private static float _storyNotifyCacheAt = -999f;

        /// <summary>
        /// Cached lookup — FindObjectOfType every frame can stall IL2CPP main thread.
        /// </summary>
        public static StoryNotifyController StoryNotify
        {
            get
            {
                try
                {
                    var now = Time.unscaledTime;
                    if (_storyNotifyCache != null && now - _storyNotifyCacheAt < 2f)
                    {
                        return _storyNotifyCache;
                    }
                    _storyNotifyCache = UnityEngine.Object.FindObjectOfType<StoryNotifyController>();
                    _storyNotifyCacheAt = now;
                    return _storyNotifyCache;
                }
                catch
                {
                    return null;
                }
            }
        }

        public static bool IsUiActive(Behaviour behaviour)
        {
            if (behaviour == null) return false;
            try
            {
                return behaviour.isActiveAndEnabled
                       && behaviour.gameObject != null
                       && behaviour.gameObject.activeInHierarchy;
            }
            catch
            {
                return false;
            }
        }

        public static bool IsPromptActive
        {
            get
            {
                var prompt = PromptPanel;
                if (prompt == null) return false;
                try
                {
                    if (IsUiActive(prompt)) return true;

                    // Intro overlay can keep Content/Full active even when the
                    // controller itself briefly reports inactive.
                    var content = prompt.Content;
                    if (content != null
                        && content.gameObject != null
                        && content.gameObject.activeInHierarchy
                        && !string.IsNullOrEmpty(content.text))
                    {
                        return true;
                    }

                    var full = prompt.Full;
                    if (full != null
                        && full.gameObject != null
                        && full.gameObject.activeInHierarchy)
                    {
                        return true;
                    }
                }
                catch
                {
                    // ignore
                }
                return false;
            }
        }

        public static bool IsWizardActive => IsUiActive(WizardPanel);

        public static int WizardInteractableButtonCount
        {
            get
            {
                try
                {
                    return IsWizardActive ? CountActiveButtons(WizardPanel.transform, 8) : 0;
                }
                catch
                {
                    return 0;
                }
            }
        }

        public static bool IsWizardChoiceMenu => WizardInteractableButtonCount >= 2;

        public static bool IsWizardRedrawDropperActive
        {
            get
            {
                // Require a live dropper GameObject. Do NOT trust wizard.IsRedraw alone —
                // after a successful exchange IsRedraw can stay true while the dropper
                // is inactive, which wrongly selects the "dropper" phase and fails drop.
                return FindWizardRedrawDropper() != null;
            }
        }

        /// <summary>
        /// True when the finger-guide / BeginGuide overlay is still waiting for the player gesture.
        /// Closing it via OnClose force-resolves the tutorial (game log: "BeginGuide not closed yet").
        /// </summary>
        public static bool IsBeginGuideActive
        {
            get
            {
                try
                {
                    var guide = BeginGuidePanel;
                    if (guide == null) return false;
                    if (IsUiActive(guide)) return true;

                    var item = guide.GuideItem;
                    if (item != null
                        && item.gameObject != null
                        && item.gameObject.activeInHierarchy)
                    {
                        return true;
                    }

                    return !string.IsNullOrEmpty(guide.Type) && IsUiActive(guide);
                }
                catch
                {
                    return false;
                }
            }
        }

        public static Dictionary<string, object> ReadBeginGuideSnapshot(int maxTextLen = 180)
        {
            var map = new Dictionary<string, object>
            {
                ["active"] = false
            };
            try
            {
                var guide = BeginGuidePanel;
                if (guide == null) return map;

                var active = IsBeginGuideActive;
                var type = guide.Type;
                var item = guide.GuideItem;
                string text = null;
                string textKey = null;
                string bind = null;
                try
                {
                    if (item != null)
                    {
                        textKey = item.TextKey;
                        bind = item.Bind;
                        text = item.Text != null ? item.Text.text : null;
                    }
                }
                catch
                {
                    // optional
                }

                if (!string.IsNullOrEmpty(text))
                {
                    text = text.Replace("\r", " ").Replace("\n", " ").Trim();
                    if (text.Length > maxTextLen) text = text.Substring(0, maxTextLen) + "…";
                }

                map["active"] = active;
                map["type"] = type;
                map["textKey"] = textKey;
                map["text"] = text;
                map["bind"] = bind;
                var preferred = ResolveBeginGuidePreferredOp(type, textKey, bind);
                map["hint"] = MapBeginGuideHint(type, textKey, bind, preferred);
                map["preferredOp"] = preferred;
            }
            catch (Exception ex)
            {
                map["error"] = ex.Message;
            }
            return map;
        }

        private static SudanBoxController _sudanBoxCache;
        private static float _sudanBoxCacheAt = -999f;

        /// <summary>
        /// True when the metal Sudan card box is shown and waiting for a click to draw.
        /// </summary>
        public static bool IsSudanBoxReady
        {
            get
            {
                try
                {
                    var go = Controller?.SudanBox;
                    if (go != null && go.activeInHierarchy) return true;
                    if (IsUiActive(FindSudanBoxController())) return true;

                    // sudan_box_show alone can stick during play and falsely block continue.
                    // Only trust the flag on day 0 / guide draw steps.
                    if (Player != null && Player.sudan_box_show)
                    {
                        if (Player.round <= 0 || IsBeginGuideActive) return true;
                    }

                    return false;
                }
                catch
                {
                    return false;
                }
            }
        }

        public static bool IsSudanDrawBlocking
        {
            get
            {
                if (!IsSudanBoxReady) return false;
                if (IsBeginGuideActive)
                {
                    string textKey = null;
                    string bind = null;
                    try
                    {
                        var item = BeginGuidePanel?.GuideItem;
                        textKey = item?.TextKey;
                        bind = item?.Bind;
                    }
                    catch
                    {
                        // optional
                    }

                    var guidePreferred = ResolveBeginGuidePreferredOp(BeginGuidePanel?.Type, textKey, bind);
                    if (string.Equals(guidePreferred, "draw_sudan_card", StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }

                    // Non-sudan guides must not treat the box as the blocking task.
                    if (!string.IsNullOrEmpty(guidePreferred)) return false;
                }

                try
                {
                    return Player != null && Player.round <= 0;
                }
                catch
                {
                    return false;
                }
            }
        }

        public static SudanBoxController FindSudanBoxController()
        {
            try
            {
                var now = Time.unscaledTime;
                if (_sudanBoxCache != null && now - _sudanBoxCacheAt < 2f)
                {
                    return _sudanBoxCache;
                }

                var go = Controller?.SudanBox;
                SudanBoxController box = null;
                if (go != null)
                {
                    box = go.GetComponent<SudanBoxController>();
                    if (box == null) box = go.GetComponentInChildren<SudanBoxController>(true);
                }

                if (box == null)
                {
                    box = UnityEngine.Object.FindObjectOfType<SudanBoxController>();
                }

                _sudanBoxCache = box;
                _sudanBoxCacheAt = now;
                return box;
            }
            catch
            {
                return null;
            }
        }

        public static bool IsSudanBoxPresent
        {
            get
            {
                try
                {
                    var go = Controller?.SudanBox;
                    if (go != null && go.activeInHierarchy) return true;
                    return FindSudanBoxController() != null;
                }
                catch
                {
                    return false;
                }
            }
        }

        public static bool HasExchangeSudanCardButton => FindExchangeSudanCardButton() != null;

        public static Dictionary<string, object> ReadCurrentSudanCardSummary()
        {
            var cards = ReadAllSudanCardSummaries();
            if (cards.Count == 0) return null;
            // Prefer most urgent (highest life / lowest remaining), else first bag0.
            Dictionary<string, object> best = null;
            var bestLife = int.MinValue;
            foreach (var row in cards)
            {
                var life = 0;
                if (row.TryGetValue("life", out var lifeObj) && lifeObj is int lifeInt)
                {
                    life = lifeInt;
                }
                if (best == null || life > bestLife)
                {
                    best = row;
                    bestLife = life;
                }
            }
            return best;
        }

        public static List<Dictionary<string, object>> ReadAllSudanCardSummaries()
        {
            var list = new List<Dictionary<string, object>>();
            var player = Player;
            if (player?.cards == null) return list;
            var seen = new HashSet<int>();
            for (var i = 0; i < player.cards.Count; i++)
            {
                var card = player.cards[i];
                if (card == null) continue;
                string type = null;
                try { type = card.Type; } catch { type = null; }
                if (string.IsNullOrEmpty(type)
                    || type.IndexOf("sudan", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }
                try
                {
                    if (!seen.Add(card.uid)) continue;
                }
                catch
                {
                    // optional uid
                }
                var row = SummarizeSudanCard(card);
                if (row != null) list.Add(row);
            }
            return list;
        }

        private static Dictionary<string, object> SummarizeSudanCard(Card card)
        {
            if (card == null) return null;
            var row = new Dictionary<string, object>();
            try { row["uid"] = card.uid; } catch { /* optional */ }
            try { row["id"] = card.id; } catch { /* optional */ }
            try { row["life"] = card.life; } catch { /* optional */ }
            try { row["rare"] = card.Rare; } catch { /* optional */ }
            try { row["type"] = card.Type; } catch { /* optional */ }
            try { row["customName"] = card.custom_name; } catch { /* optional */ }
            try
            {
                var bag = card.bag;
                row["bag"] = bag;
                row["inHand"] = bag == 0;
            }
            catch
            {
                // optional
            }
            try
            {
                var id = row.TryGetValue("id", out var idObj) && idObj is int idInt ? idInt : 0;
                var custom = row.TryGetValue("customName", out var c) ? c?.ToString() : null;
                var type = row.TryGetValue("type", out var t) ? t?.ToString() : null;
                row["name"] = ConfigCatalog.Instance.ResolveCardName(id, custom, type);
            }
            catch
            {
                row["name"] = "sudan";
            }
            return row;
        }

        public static string SudanCardIdentityKey(Dictionary<string, object> summary)
        {
            if (summary == null) return "";
            var uid = summary.TryGetValue("uid", out var u) ? u?.ToString() : null;
            var id = summary.TryGetValue("id", out var i) ? i?.ToString() : null;
            var name = summary.TryGetValue("name", out var n) ? n?.ToString() : null;
            return (uid ?? "") + "|" + (id ?? "") + "|" + (name ?? "");
        }

        public static Card FindCurrentSudanCard()
        {
            var player = Player;
            if (player?.cards == null) return null;
            Card best = null;
            var bestLife = int.MinValue;
            for (var i = 0; i < player.cards.Count; i++)
            {
                var card = player.cards[i];
                if (card == null) continue;
                string type = null;
                try { type = card.Type; } catch { type = null; }
                if (string.IsNullOrEmpty(type)
                    || type.IndexOf("sudan", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }
                var life = 0;
                try { life = card.life; } catch { /* optional */ }
                // Prefer most urgent (highest elapsed life => lowest remaining).
                if (best == null || life > bestLife)
                {
                    best = card;
                    bestLife = life;
                }
            }
            return best;
        }

        public static Button FindExchangeSudanCardButton()
        {
            if (!IsWizardActive) return null;
            var root = WizardPanel?.transform;
            if (root == null) return null;
            return FindInteractableButtonByExactLabelPredicate(
                root,
                SudanCardActionPolicy.IsExchangeSudanCardLabel);
        }

        public static void ClickExchangeSudanCard()
        {
            var button = FindExchangeSudanCardButton();
            if (button == null)
            {
                throw new InvalidOperationException("Exchange Sudan card button not found");
            }
            button.onClick.Invoke();
        }

        public static GameObject FindWizardRedrawDropper()
        {
            if (!IsWizardActive) return null;
            try
            {
                var dropper = WizardPanel?.WizardRedrawDropper;
                return dropper != null && dropper.activeInHierarchy ? dropper : null;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// After a redraw drop the game often leaves:
        /// 1) tip text「将苏丹卡拖拽到牌盒中」/ redraw interstitial, and
        /// 2) the new Sudan card waiting for a click acknowledgement.
        /// Without this, consecutive exchange_sudan_card fails with exchange_button_missing.
        /// </summary>
        public static string TrySettleSudanExchangeUi()
        {
            var parts = new List<string>();
            try
            {
                var controller = Controller;
                if (controller != null)
                {
                    try { controller.CurrentDrag = null; } catch { /* optional */ }
                }

                var card = FindCurrentSudanCard();
                if (card != null)
                {
                    var widget = FindActiveCardController(card.uid, preferHand: true)
                                 ?? FindActiveCardController(card.uid, preferHand: false);
                    if (widget != null && ClickPointerTarget(widget.gameObject, preferHierarchy: true))
                    {
                        parts.Add("click_card:" + card.uid);
                    }
                }

                // Wizard SudanCardHolder may show the reveal card separately from hand widgets.
                try
                {
                    var holder = WizardPanel?.SudanCardHolder;
                    if (holder != null && holder.gameObject != null && holder.gameObject.activeInHierarchy)
                    {
                        var holderCard = holder.GetComponentInChildren<CardController>(true);
                        if (holderCard != null
                            && ClickPointerTarget(holderCard.gameObject, preferHierarchy: true))
                        {
                            parts.Add("click_holder_card");
                        }
                        else if (ClickPointerTarget(holder.gameObject, preferHierarchy: true))
                        {
                            parts.Add("click_holder");
                        }
                    }
                }
                catch
                {
                    // SudanCardHolder optional across builds
                }

                // Informational wizard page (tip, not multi-choice): OnConfirm clears the tip.
                if (IsWizardActive && !IsWizardChoiceMenu)
                {
                    try
                    {
                        WizardPanel?.OnConfirm();
                        parts.Add("wizard.OnConfirm");
                    }
                    catch (Exception ex)
                    {
                        parts.Add("wizard.OnConfirm:err:" + TruncateUiText(ex.Message, 40));
                    }
                }
            }
            catch (Exception ex)
            {
                parts.Add("settle:err:" + TruncateUiText(ex.Message, 40));
            }

            return parts.Count > 0 ? string.Join("+", parts) : "noop";
        }

        /// <summary>
        /// True when Wizard looks stuck on redraw tip without a usable choice/dropper.
        /// </summary>
        public static bool IsWizardRedrawTipStuck()
        {
            if (!IsWizardActive) return false;
            if (FindWizardRedrawDropper() != null) return false;
            if (HasExchangeSudanCardButton) return false;
            // Choice menu with other buttons is a different surface.
            if (IsWizardChoiceMenu) return false;
            try
            {
                var wizard = WizardPanel;
                if (wizard != null && wizard.IsRedraw) return true;
            }
            catch
            {
                // ignore
            }
            var tips = ReadSudanBoxTips();
            return !string.IsNullOrEmpty(tips);
        }

        /// <summary>
        /// Precisely click the BeginGuide tip bubble (e.g.「将苏丹卡拖拽到牌盒中」).
        /// Wizard.OnClose alone does not clear this guide; the tip itself must be clicked.
        /// Do NOT route through continue→draw_sudan_card (that burns redraws).
        /// </summary>
        public static string TryDismissBeginGuideTip()
        {
            if (!IsBeginGuideActive) return "guide_inactive";
            var parts = new List<string>();
            try
            {
                var guide = BeginGuidePanel;
                var item = guide?.GuideItem;
                if (item != null && item.gameObject != null && item.gameObject.activeInHierarchy)
                {
                    try
                    {
                        if (item.Text != null
                            && item.Text.gameObject != null
                            && ClickPointerTarget(item.Text.gameObject, preferHierarchy: true))
                        {
                            parts.Add("click_guide_text");
                        }
                    }
                    catch
                    {
                        // Text optional
                    }

                    if (ClickPointerTarget(item.gameObject, preferHierarchy: true))
                    {
                        parts.Add("click_guide_item");
                    }

                    try
                    {
                        var button = FindActiveButton(item.transform);
                        if (button != null)
                        {
                            button.onClick.Invoke();
                            parts.Add("click_guide_button");
                        }
                    }
                    catch
                    {
                        // optional
                    }
                }

                // Needle match under the guide root (localized tip label).
                if (IsBeginGuideActive && guide != null)
                {
                    var tipGo = FindGuideTipClickTarget(guide.transform);
                    if (tipGo != null && ClickPointerTarget(tipGo, preferHierarchy: true))
                    {
                        parts.Add("click_tip_needle");
                    }
                }

                // Last resort after tip clicks — only if still active.
                if (IsBeginGuideActive && guide != null)
                {
                    foreach (var methodName in new[] { "OnClose", "Close", "Hide" })
                    {
                        try
                        {
                            var method = guide.GetType().GetMethod(
                                methodName,
                                System.Reflection.BindingFlags.Instance
                                | System.Reflection.BindingFlags.Public
                                | System.Reflection.BindingFlags.NonPublic);
                            if (method == null || method.GetParameters().Length != 0) continue;
                            method.Invoke(guide, null);
                            parts.Add("guide." + methodName);
                            if (!IsBeginGuideActive) break;
                        }
                        catch (Exception ex)
                        {
                            parts.Add("guide." + methodName + ":err:" + TruncateUiText(ex.Message, 32));
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                parts.Add("guide_dismiss:err:" + TruncateUiText(ex.Message, 40));
            }

            return parts.Count > 0 ? string.Join("+", parts) : "noop";
        }

        private static GameObject FindGuideTipClickTarget(Transform root)
        {
            if (root == null) return null;
            var needles = new[] { "拖拽到牌盒", "将苏丹卡", "放回这个宝盒", "苏丹卡" };
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            var seen = 0;
            while (queue.Count > 0 && seen < 128)
            {
                var current = queue.Dequeue();
                seen++;
                if (current == null || !current.gameObject.activeInHierarchy) continue;
                string text = null;
                try
                {
                    var tmp = current.GetComponent<TMPro.TMP_Text>();
                    if (tmp != null) text = tmp.text;
                }
                catch
                {
                    // TMP optional
                }
                if (string.IsNullOrEmpty(text))
                {
                    try
                    {
                        var legacy = current.GetComponent<UnityEngine.UI.Text>();
                        if (legacy != null) text = legacy.text;
                    }
                    catch
                    {
                        // optional
                    }
                }
                if (!string.IsNullOrEmpty(text))
                {
                    foreach (var needle in needles)
                    {
                        if (text.IndexOf(needle, StringComparison.Ordinal) >= 0)
                        {
                            return current.gameObject;
                        }
                    }
                }
                for (var i = 0; i < current.childCount; i++)
                {
                    queue.Enqueue(current.GetChild(i));
                }
            }
            return null;
        }

        /// <summary>
        /// Close the Sudan wizard box UI the way a human does: dismiss tip, then click the
        /// Wizard Close / DrawerClose button (not continue→draw_sudan_card).
        /// </summary>
        public static string TryCloseSudanBoxUi()
        {
            var parts = new List<string>();
            if (IsBeginGuideActive)
            {
                parts.Add("guide=" + TryDismissBeginGuideTip());
            }

            var wizard = WizardPanel;
            var wizardPresent = wizard != null && (IsWizardActive || IsUiActive(wizard));
            if (wizardPresent)
            {
                // Prefer the real Close button — OnClose alone often leaves the box up.
                try
                {
                    var closeBtn = wizard.Close;
                    if (closeBtn != null
                        && closeBtn.gameObject != null
                        && closeBtn.gameObject.activeInHierarchy
                        && closeBtn.IsInteractable())
                    {
                        closeBtn.onClick.Invoke();
                        parts.Add("wizard.Close.click");
                    }
                }
                catch (Exception ex)
                {
                    parts.Add("wizard.Close:err:" + TruncateUiText(ex.Message, 32));
                }

                try
                {
                    var drawerClose = wizard.DrawerClose;
                    if (IsWizardActive
                        && drawerClose != null
                        && drawerClose.gameObject != null
                        && drawerClose.gameObject.activeInHierarchy
                        && drawerClose.IsInteractable())
                    {
                        drawerClose.onClick.Invoke();
                        parts.Add("wizard.DrawerClose.click");
                    }
                }
                catch (Exception ex)
                {
                    parts.Add("wizard.DrawerClose:err:" + TruncateUiText(ex.Message, 32));
                }

                if (IsWizardActive)
                {
                    try
                    {
                        if (OverlayScanner.TryClickNamedButton(wizard.transform, "Close", requireInteractable: true))
                        {
                            parts.Add("named.Close");
                        }
                        else if (OverlayScanner.TryClickNamedButton(wizard.transform, "关闭", requireInteractable: false))
                        {
                            parts.Add("named.关闭");
                        }
                    }
                    catch
                    {
                        // optional
                    }
                }

                if (IsWizardActive)
                {
                    try
                    {
                        wizard.OnClose();
                        parts.Add("wizard.OnClose");
                    }
                    catch (Exception ex)
                    {
                        parts.Add("wizard.OnClose:err:" + TruncateUiText(ex.Message, 32));
                    }
                }

                try
                {
                    wizard.HideAllSudanCard();
                    parts.Add("HideAllSudanCard");
                }
                catch
                {
                    // optional across builds
                }
            }
            else
            {
                parts.Add("wizard_inactive");
            }

            if (IsBeginGuideActive)
            {
                parts.Add("guide2=" + TryDismissBeginGuideTip());
            }

            return parts.Count > 0 ? string.Join("+", parts) : "noop";
        }

        /// <summary>
        /// Close Sudan wizard / BeginGuide tip / rite panels so map actions like prev_round can run.
        /// Mirrors the human flow: click tip, close the box, return to the map, then rewind.
        /// </summary>
        public static string TryReturnToMapFromSudanUi()
        {
            var parts = new List<string>();
            parts.Add("settle=" + TrySettleSudanExchangeUi());
            parts.Add("closeBox=" + TryCloseSudanBoxUi());

            var rite = RitePanel;
            if (IsUiActive(rite))
            {
                try
                {
                    rite.OnClose();
                    parts.Add("rite.OnClose");
                }
                catch (Exception ex)
                {
                    parts.Add("rite.OnClose:err:" + TruncateUiText(ex.Message, 32));
                }
            }

            return string.Join("+", parts);
        }

        public static void ClickSudanBox()
        {
            var box = FindSudanBoxController();
            if (box == null)
            {
                throw new InvalidOperationException("SudanBoxController not found");
            }

            var button = FindActiveButton(box.transform);
            if (button != null && button.gameObject.activeInHierarchy && button.IsInteractable())
            {
                button.onClick.Invoke();
                return;
            }

            var eventSystem = EventSystem.current;
            if (eventSystem != null)
            {
                var pointer = new PointerEventData(eventSystem)
                {
                    button = PointerEventData.InputButton.Left
                };
                var rect = box.transform as RectTransform;
                if (rect != null)
                {
                    pointer.position = RectTransformUtility.WorldToScreenPoint(null, rect.position);
                }
                var handled = ExecuteEvents.ExecuteHierarchy<IPointerClickHandler>(
                    box.gameObject,
                    pointer,
                    ExecuteEvents.pointerClickHandler);
                if (handled != null) return;
            }
            box.OnPointerClick();
        }

        private static Button FindActiveButton(Transform root)
        {
            if (root == null) return null;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                if (current?.gameObject == null) continue;
                var button = current.gameObject.GetComponent<Button>();
                if (button != null && button.gameObject.activeInHierarchy && button.IsInteractable())
                {
                    return button;
                }
                for (var i = 0; i < current.childCount; i++)
                {
                    queue.Enqueue(current.GetChild(i));
                }
            }
            return null;
        }

        private static int CountActiveButtons(Transform root, int limit)
        {
            if (root == null || limit <= 0) return 0;
            var count = 0;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            while (queue.Count > 0 && count < limit)
            {
                var current = queue.Dequeue();
                if (current?.gameObject == null || !current.gameObject.activeInHierarchy) continue;
                var button = current.gameObject.GetComponent<Button>();
                if (button != null && button.IsInteractable()) count++;
                for (var i = 0; i < current.childCount; i++)
                {
                    queue.Enqueue(current.GetChild(i));
                }
            }
            return count;
        }

        public static string ReadSudanBoxTips(int maxLen = 160)
        {
            // GetLeftSudanCardTips() is an IL2CPP game method. Calling it off the Unity
            // main thread (or while unrelated guides/panels own the foreground) has
            // produced process-killing AccessViolationExceptions that managed catch
            // cannot recover from. Only read tips when the Sudan box is the active task.
            try
            {
                if (!IsSudanDrawBlocking && !(Player != null && Player.sudan_box_show && !IsBeginGuideActive))
                {
                    return null;
                }

                // Non-sudan BeginGuide (e.g. RITE_STOP) must never touch the box tips API.
                if (IsBeginGuideActive)
                {
                    var preferred = ResolveBeginGuidePreferredOp(
                        BeginGuidePanel?.Type,
                        BeginGuidePanel?.GuideItem?.TextKey,
                        BeginGuidePanel?.GuideItem?.Bind);
                    if (!string.Equals(preferred, "draw_sudan_card", StringComparison.OrdinalIgnoreCase))
                    {
                        return null;
                    }
                }

                var box = FindSudanBoxController();
                if (box == null) return null;
                var text = box.GetLeftSudanCardTips();
                if (string.IsNullOrEmpty(text)) return null;
                text = text.Replace("\r", " ").Replace("\n", " ").Trim();
                if (text.Length > maxLen) text = text.Substring(0, maxLen) + "…";
                return text;
            }
            catch
            {
                return null;
            }
        }

        public static string ReadPromptText(int maxLen = 120)
        {
            try
            {
                var text = PromptPanel?.Content?.text;
                if (string.IsNullOrEmpty(text)) return null;
                text = text.Replace("\r", " ").Replace("\n", " ").Trim();
                if (text.Length > maxLen) text = text.Substring(0, maxLen) + "…";
                return text;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Compact daily-news snapshot for action-chain gating.
        /// Daily news = StoryNotify popup only. GameController.StoryEntry opens the
        /// meta "一千零一夜" story/achievement book and must NOT be treated as daily news.
        /// </summary>
        public static Dictionary<string, object> ReadDailyNewsSnapshot(int maxTextLen = 220)
        {
            var map = new Dictionary<string, object>
            {
                ["present"] = false,
                ["open"] = false,
                ["entryAvailable"] = false,
                ["storyBookAvailable"] = false,
                ["title"] = null,
                ["summary"] = null,
                ["viewed"] = false
            };
#if GAME_INTEROP
            try
            {
                var controller = Controller;
                var entry = controller != null ? controller.StoryEntry : null;
                var storyBookAvailable = entry != null && entry.activeInHierarchy;
                // Keep legacy key for callers, but it no longer means "must open daily news".
                map["entryAvailable"] = false;
                map["storyBookAvailable"] = storyBookAvailable;

                var notify = StoryNotify;
                var notifyOpen = IsUiActive(notify);
                map["open"] = notifyOpen;

                string title = null;
                string summary = null;
                if (notifyOpen && notify != null)
                {
                    var texts = CollectActiveTexts(notify.transform, 6);
                    if (texts.Count > 0)
                    {
                        title = TruncateUiText(texts[0], Math.Min(80, maxTextLen));
                        if (texts.Count > 1)
                        {
                            summary = TruncateUiText(string.Join(" ", texts), maxTextLen);
                        }
                        else
                        {
                            summary = title;
                        }
                    }
                }

                // Only a live StoryNotify counts as today's news. Do not force opening the story book.
                map["present"] = notifyOpen;
                map["title"] = title;
                map["summary"] = summary;
                if (storyBookAvailable)
                {
                    map["badge"] = ReadStoryEntryBadge(entry.transform);
                }
            }
            catch (Exception ex)
            {
                map["error"] = ex.Message;
            }
#endif
            return map;
        }

        /// <summary>
        /// Daily news is the StoryNotify overlay. Never click StoryEntry (一千零一夜).
        /// Returns true when the notify is already open; false when there is nothing to open.
        /// </summary>
        public static bool OpenDailyNews()
        {
#if !GAME_INTEROP
            return false;
#else
            var notify = StoryNotify;
            if (IsUiActive(notify))
            {
                return true;
            }

            // Intentionally do not click GameController.StoryEntry — that opens the
            // meta story/achievement book, not operational daily news.
            return false;
#endif
        }

        /// <summary>
        /// Compact rite-result / dice-check snapshot (threshold tip, gold dice, Next readiness).
        /// </summary>
        public static Dictionary<string, object> ReadRiteResultSnapshot(int maxTextLen = 220)
        {
            var map = new Dictionary<string, object>
            {
                ["active"] = false,
                ["stage"] = RiteResultPolicy.StageInactive,
                ["title"] = null,
                ["body"] = null,
                ["tip"] = null,
                ["summary"] = null,
                ["needTags"] = new List<object>(),
                ["diceBreakdown"] = null,
                ["totalDice"] = null,
                ["leftTips"] = null,
                ["diceLines"] = new List<object>(),
                ["successCount"] = null,
                ["successThreshold"] = null,
                ["redrawInteractable"] = false,
                ["nextInteractable"] = false,
                ["goldSelectInteractable"] = false,
                ["goldConfirmInteractable"] = false,
                ["goldCancelInteractable"] = false,
                ["goldDiceAvailable"] = TryGetCounter(7100006) ?? 0,
                ["selectedGoldLabel"] = null,
                ["dicePromptVisible"] = false,
                ["diceCountPromptVisible"] = false,
                ["rewards"] = new List<object>(),
                ["rewardSummary"] = null
            };
#if GAME_INTEROP
            try
            {
                var panel = Controller?.riteResultPanel;
                var active = IsUiActive(panel);
                map["active"] = active;
                if (!active || panel?.transform == null) return map;

                var root = panel.transform;
                var dicePrompt = FindDescendant(root, "DicePromptNew");
                var diceCountPrompt = FindDescendant(root, "DiceCountPromptNew");
                map["dicePromptVisible"] = dicePrompt != null && dicePrompt.gameObject.activeInHierarchy;
                map["diceCountPromptVisible"] = diceCountPrompt != null
                                                && diceCountPrompt.gameObject.activeInHierarchy;
                map["nextInteractable"] = IsNamedButtonInteractable(root, "Next");
                map["goldConfirmInteractable"] = IsNamedButtonInteractable(root, "Gold Confirm");
                map["goldCancelInteractable"] = IsNamedButtonInteractable(root, "Gold Cancel")
                                               || IsNamedButtonInteractable(root, "Gold Cancel Full");
                map["goldSelectInteractable"] = FindInteractableButtonByLabels(
                    root, "金骰子", "Gold Dice", "GoldDice") != null
                    || IsNamedButtonInteractable(root, "GoldDice");
                map["redrawInteractable"] = FindInteractableButtonByLabels(root, "重投", "Redraw") != null
                                           || IsNamedButtonInteractable(root, "Redraw");

                var titleGo = FindDescendant(root, "Title");
                map["title"] = TruncateUiText(ReadFirstText(titleGo != null ? titleGo.transform : null), 80);

                // Pre-roll tip lives under RightTips; post-roll tip under DiceCountPromptNew/Tips.
                var tipGo = FindDescendant(root, "RightTips") ?? FindDescendant(root, "Tips");
                map["tip"] = TruncateUiText(ReadFirstText(tipGo != null ? tipGo.transform : null), maxTextLen);
                map["successThreshold"] = ParseSuccessThreshold(map["tip"] as string);

                var leftTipsGo = FindDescendant(root, "LeftTips");
                map["leftTips"] = TruncateUiText(
                    ReadFirstText(leftTipsGo != null ? leftTipsGo.transform : null), maxTextLen);

                var needTags = ReadDiceNeedTags(root);
                map["needTags"] = needTags;
                map["diceBreakdown"] = FormatDiceBreakdown(needTags);
                map["totalDice"] = SumDiceTagValues(needTags);

                var diceLines = new List<string>();
                if (dicePrompt != null)
                {
                    diceLines.AddRange(CollectActiveTexts(dicePrompt, 16, minLen: 1));
                }
                if (diceCountPrompt != null)
                {
                    diceLines.AddRange(CollectActiveTexts(diceCountPrompt, 16, minLen: 1));
                }
                map["diceLines"] = DistinctStrings(diceLines).ConvertAll(t => (object)t);
                map["successCount"] = ReadRolledSuccessCount(root, diceCountPrompt, map["tip"] as string);

                var body = ReadResultBodyText(root);
                map["body"] = TruncateUiText(body, maxTextLen);

                var selected = FindSelectedGoldLabel(root);
                map["selectedGoldLabel"] = selected;

                var rewards = ReadRiteResultRewards(root);
                map["rewards"] = rewards;
                map["rewardSummary"] = FormatRewardSummary(rewards);

                var tip = map["tip"] as string;
                var breakdown = map["diceBreakdown"] as string;
                var title = map["title"] as string;
                var successCount = map["successCount"];
                var rewardSummary = map["rewardSummary"] as string;
                var summary = !string.IsNullOrEmpty(tip)
                    ? tip
                    : (!string.IsNullOrEmpty(body) ? body : title);
                if (!string.IsNullOrEmpty(breakdown))
                {
                    summary = string.IsNullOrEmpty(summary)
                        ? breakdown
                        : summary + " | " + breakdown;
                }
                if (successCount != null)
                {
                    summary = string.IsNullOrEmpty(summary)
                        ? "success=" + successCount
                        : summary + " | success=" + successCount;
                }
                if (!string.IsNullOrEmpty(rewardSummary))
                {
                    summary = string.IsNullOrEmpty(summary)
                        ? rewardSummary
                        : summary + " | rewards=" + rewardSummary;
                }
                map["summary"] = summary;

                var diceUiVisible = Bool(map, "dicePromptVisible") || Bool(map, "diceCountPromptVisible");
                map["stage"] = RiteResultPolicy.ResolveStage(
                    active,
                    Bool(map, "nextInteractable"),
                    Bool(map, "goldConfirmInteractable"),
                    Bool(map, "goldSelectInteractable"),
                    diceUiVisible);
            }
            catch (Exception ex)
            {
                map["error"] = ex.Message;
            }
#endif
            return map;
        }

        /// <summary>
        /// Advance rite result without auto-spending gold dice.
        /// Never lets Il2Cpp Cast/VerificationException escape — that previously hard-locked agents.
        /// </summary>
        public static bool TryAdvanceRiteResult(out string via, out string reason)
        {
            via = null;
            reason = null;
#if !GAME_INTEROP
            reason = "no_interop";
            return false;
#else
            try
            {
                var snapBefore = ReadRiteResultSnapshot();
                if (!Bool(snapBefore, "active"))
                {
                    // Breaker may still be waiting after the result panel closes.
                    if (TryClickSudanBreaker(out var breakerOnlyVia, force: false))
                    {
                        via = breakerOnlyVia;
                        return true;
                    }

                    reason = "rite_result_inactive";
                    return false;
                }

                var goldAvailable = 0;
                if (snapBefore.TryGetValue("goldDiceAvailable", out var rawGold) && rawGold is int gi) goldAvailable = gi;
                else if (rawGold != null && int.TryParse(rawGold.ToString(), out var parsed)) goldAvailable = parsed;

                var stage = snapBefore.TryGetValue("stage", out var stageRaw) ? stageRaw as string : null;
                var gesture = RiteResultPolicy.ResolveContinueGesture(stage, goldAvailable);
                var panel = Controller?.riteResultPanel;
                if (panel?.transform == null)
                {
                    reason = "rite_result_missing";
                    return false;
                }

                var nextReady = Bool(snapBefore, "nextInteractable");

                // Prefer Next whenever it is interactable, even if stage snapshot lagged.
                if (OverlayScanner.TryClickNamedButton(panel.transform, "Next", requireInteractable: true))
                {
                    via = "next";
                    return true;
                }

                switch (gesture)
                {
                    case RiteResultPolicy.GestureNext:
                        reason = "next_not_interactable";
                        return false;

                    case RiteResultPolicy.GestureResultText:
                    {
                        // Recording manual-20260727-101858-907: Sudan-card break confirm/play
                        // uses SudanBreakerNewController.OnPointerClick (often twice), while
                        // rite_result still shows gray Next and IsUiActive(breaker)==false.
                        // Normal typewriter pages use RiteResultPanelController.OnPointerClick.
                        // Try breaker first, then the result panel handler.
                        var parts = new List<string>();
                        if (TryClickSudanBreaker(out var breakerVia, force: true))
                        {
                            parts.Add(breakerVia);
                        }

                        if (TryInvokeRiteResultPointerClick(panel, out var pointerVia))
                        {
                            parts.Add(pointerVia);
                        }

                        if (parts.Count == 0 && TryClickRiteResultBlank(panel.transform))
                        {
                            parts.Add("result_blank");
                        }

                        if (parts.Count == 0 && TryClickRiteResultBody(panel.transform))
                        {
                            parts.Add("result_text");
                        }

                        // Only invoke OnNext when the checkmark is actually ready.
                        if (nextReady
                            && TryInvokeRiteResultPanelMethod(panel, out var methodVia)
                            && !string.IsNullOrEmpty(methodVia))
                        {
                            parts.Add(methodVia);
                        }

                        if (parts.Count == 0
                            && TryForceAdvanceRiteResult(panel, out var forceVia)
                            && !string.IsNullOrEmpty(forceVia))
                        {
                            parts.Add(forceVia);
                        }

                        if (parts.Count == 0)
                        {
                            reason = "result_text_missing";
                            return false;
                        }

                        via = string.Join("+", parts);
                        // Breaker clicks may not change the riteResult snapshot until the
                        // second click / animation finishes — still count as accepted.
                        var usedBreaker = parts.Exists(p =>
                            p != null && p.IndexOf("sudan_breaker", StringComparison.OrdinalIgnoreCase) >= 0);
                        var usedPanelHandler = parts.Exists(p =>
                            p != null
                            && p.IndexOf("panel_OnPointerClick", StringComparison.OrdinalIgnoreCase) >= 0);
                        if (!usedBreaker && !usedPanelHandler)
                        {
                            var snapAfter = ReadRiteResultSnapshot();
                            if (RiteResultFingerprint(snapBefore) == RiteResultFingerprint(snapAfter)
                                && Bool(snapAfter, "active"))
                            {
                                reason = "rite_result_no_effect";
                                return false;
                            }
                        }

                        return true;
                    }

                    case RiteResultPolicy.GestureNeedGoldSelect:
                        reason = "need_select_gold_dice";
                        via = gesture;
                        return false;

                    case RiteResultPolicy.GestureNeedGoldConfirm:
                        reason = "need_confirm_gold_dice";
                        via = gesture;
                        return false;

                    default:
                        if (TryInvokeRiteResultPointerClick(panel, out var defaultPointerVia))
                        {
                            via = defaultPointerVia;
                            return true;
                        }

                        // Last-resort panel method invoke only when Next is ready.
                        if (nextReady && TryInvokeRiteResultPanelMethod(panel, out var fallbackVia))
                        {
                            via = fallbackVia;
                            return true;
                        }

                        reason = "no_rite_result_gesture";
                        return false;
                }
            }
            catch (Exception ex)
            {
                reason = "rite_result_advance_exception:" + ex.GetType().Name + ":" + ex.Message;
                return false;
            }
#endif
        }

#if GAME_INTEROP
        /// <summary>
        /// True when an actually-live Sudan break / reveal UI is waiting for a blank click.
        /// Do not trust GameController.SudanBreakerController alone — the prefab ref can be
        /// inactive while a live instance (or helper/delegater child) is on screen.
        /// </summary>
        public static bool IsSudanBreakerWaiting
        {
            get
            {
                try
                {
                    var breaker = FindSudanBreakerTarget(out _);
                    if (breaker == null) return false;
                    if (IsSudanBreakerLive(breaker)) return true;
                    return HasSudanBreakerSession(breaker);
                }
                catch
                {
                    return false;
                }
            }
        }

        private static bool IsSudanBreakerLive(SudanBreakerNewController breaker)
        {
            if (breaker == null) return false;
            if (IsUiActive(breaker)) return true;
            try
            {
                if (breaker.FullCard != null && breaker.FullCard.activeInHierarchy) return true;
            }
            catch { /* optional */ }

            try
            {
                var bg = breaker.Background;
                if (bg != null && bg.gameObject != null && bg.gameObject.activeInHierarchy) return true;
            }
            catch { /* optional */ }

            try
            {
                var helper = breaker.sudanBreakerNewHelper;
                if (helper != null && IsUiActive(helper)) return true;
            }
            catch { /* optional */ }

            try
            {
                var delegater = breaker.sudanBreakerDelegater;
                if (delegater != null
                    && delegater.gameObject != null
                    && delegater.gameObject.activeInHierarchy)
                {
                    return true;
                }
            }
            catch { /* optional */ }

            return false;
        }

        private static SudanBreakerNewController FindSudanBreakerTarget(out string how)
        {
            how = "none";
            try
            {
                var primary = Controller?.SudanBreakerController;
                if (IsSudanBreakerLive(primary))
                {
                    how = "controller_live";
                    return primary;
                }

                SudanBreakerNewController[] all = null;
                try { all = UnityEngine.Object.FindObjectsOfType<SudanBreakerNewController>(true); }
                catch
                {
                    try { all = UnityEngine.Object.FindObjectsOfType<SudanBreakerNewController>(); }
                    catch { all = null; }
                }

                if (all != null)
                {
                    foreach (var candidate in all)
                    {
                        if (candidate == null) continue;
                        if (IsSudanBreakerLive(candidate))
                        {
                            how = "find_live";
                            return candidate;
                        }
                    }
                }

                // Active helper may outlive the controller's own active flag.
                try
                {
                    SudanBreakerNewHelper[] helpers = null;
                    try { helpers = UnityEngine.Object.FindObjectsOfType<SudanBreakerNewHelper>(true); }
                    catch
                    {
                        try { helpers = UnityEngine.Object.FindObjectsOfType<SudanBreakerNewHelper>(); }
                        catch { helpers = null; }
                    }

                    if (helpers != null)
                    {
                        foreach (var helper in helpers)
                        {
                            if (helper == null || !IsUiActive(helper)) continue;
                            var parent = helper.GetComponentInParent<SudanBreakerNewController>();
                            if (parent != null)
                            {
                                how = "helper_parent";
                                return parent;
                            }

                            if (primary != null)
                            {
                                how = "helper_primary";
                                return primary;
                            }
                        }
                    }
                }
                catch { /* optional */ }

                if (primary != null && HasSudanBreakerSession(primary))
                {
                    how = "controller_session";
                    return primary;
                }

                if (primary != null)
                {
                    how = "controller_fallback";
                    return primary;
                }
            }
            catch
            {
                how = "error";
            }

            return null;
        }

        private static bool HasSudanBreakerSession(object breaker)
        {
            if (breaker == null) return false;
            // Only live session markers — NOT Notice/UpdateAction (always set on prefab).
            string[] keys =
            {
                "ClickPromise", "FinalPromise", "InitPromise", "AnimationDone",
                "CardShow", "card", "render", "CardTexture"
            };
            var flags = System.Reflection.BindingFlags.Instance
                        | System.Reflection.BindingFlags.Public
                        | System.Reflection.BindingFlags.NonPublic;
            var type = breaker.GetType();
            foreach (var key in keys)
            {
                try
                {
                    var prop = type.GetProperty(key, flags);
                    if (prop != null)
                    {
                        try
                        {
                            if (prop.GetValue(breaker) != null) return true;
                        }
                        catch
                        {
                            // Property exists but typed get failed (e.g. Promise.dll) —
                            // treat as possibly set only when the breaker is live.
                        }
                    }

                    var field = type.GetField(key, flags);
                    if (field != null)
                    {
                        try
                        {
                            if (field.GetValue(breaker) != null) return true;
                        }
                        catch { /* optional */ }
                    }
                }
                catch
                {
                    // try next
                }
            }

            return false;
        }

        public static bool TryClickSudanBreaker(out string via, bool force = false)
        {
            via = null;
            try
            {
                var breaker = FindSudanBreakerTarget(out var how);
                if (breaker == null) return false;
                if (!force && !IsSudanBreakerLive(breaker) && !HasSudanBreakerSession(breaker))
                {
                    return false;
                }

                var parts = new List<string>();
                parts.Add("target=" + how);
                parts.Add(DescribeSudanBreaker(breaker));

                // Prefer live helper click-catcher when present.
                try
                {
                    var helper = breaker.sudanBreakerNewHelper;
                    if (helper != null && IsUiActive(helper))
                    {
                        try
                        {
                            helper.DoClick();
                            parts.Add("helper.DoClick");
                        }
                        catch
                        {
                            TryInvokeNoArg(helper, "DoClick", parts, "helper.DoClick:reflect");
                        }

                        if (ClickPointerTarget(helper.gameObject, preferHierarchy: true))
                        {
                            parts.Add("helper.pointer");
                        }
                    }
                    else
                    {
                        // Scan for any active helper in the scene.
                        SudanBreakerNewHelper[] helpers = null;
                        try { helpers = UnityEngine.Object.FindObjectsOfType<SudanBreakerNewHelper>(true); }
                        catch { helpers = null; }
                        if (helpers != null)
                        {
                            foreach (var h in helpers)
                            {
                                if (h == null || !IsUiActive(h)) continue;
                                try
                                {
                                    h.DoClick();
                                    parts.Add("findHelper.DoClick");
                                }
                                catch
                                {
                                    TryInvokeNoArg(h, "DoClick", parts, "findHelper.DoClick:reflect");
                                }

                                if (h.gameObject != null
                                    && ClickPointerTarget(h.gameObject, preferHierarchy: true))
                                {
                                    parts.Add("findHelper.pointer");
                                }

                                break;
                            }
                        }
                    }
                }
                catch
                {
                    // optional
                }

                // Manual recording hit Controller.OnPointerClick (possibly on a live instance).
                try
                {
                    breaker.OnPointerClick();
                    parts.Add("controller.OnPointerClick");
                }
                catch (Exception ex)
                {
                    parts.Add("controller.OnPointerClick:err:" + ex.GetType().Name);
                    TryInvokeNoArg(breaker, "OnPointerClick", parts, "controller.OnPointerClick:reflect");
                }

                // Also poke every live controller instance — recording/Harmony is type-wide.
                try
                {
                    var all = UnityEngine.Object.FindObjectsOfType<SudanBreakerNewController>(true);
                    if (all != null)
                    {
                        var n = 0;
                        foreach (var other in all)
                        {
                            if (other == null || ReferenceEquals(other, breaker)) continue;
                            if (!IsSudanBreakerLive(other) && !HasSudanBreakerSession(other)) continue;
                            try
                            {
                                other.OnPointerClick();
                                n++;
                            }
                            catch
                            {
                                TryInvokeNoArg(other, "OnPointerClick", parts, "other.OnPointerClick");
                            }
                        }

                        if (n > 0) parts.Add("other.OnPointerClickx" + n);
                    }
                }
                catch
                {
                    // optional
                }

                if (parts.Count == 0) return false;
                via = (force ? "sudan_breaker:force:" : "sudan_breaker:") + string.Join("+", parts);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string DescribeSudanBreaker(SudanBreakerNewController breaker)
        {
            var bits = new List<string>();
            try { bits.Add("ui=" + IsUiActive(breaker)); } catch { bits.Add("ui=?"); }
            try
            {
                var helper = breaker.sudanBreakerNewHelper;
                bits.Add("helper=" + (helper != null && IsUiActive(helper)));
            }
            catch { bits.Add("helper=?"); }

            try
            {
                var delegater = breaker.sudanBreakerDelegater;
                bits.Add("delegater=" + (delegater != null));
                if (delegater != null)
                {
                    var flags = System.Reflection.BindingFlags.Instance
                                | System.Reflection.BindingFlags.Public
                                | System.Reflection.BindingFlags.NonPublic;
                    var field = delegater.GetType().GetField("canContinue", flags);
                    if (field != null) bits.Add("canContinue=" + field.GetValue(delegater));
                }
            }
            catch { bits.Add("delegater=?"); }

            try
            {
                var notice = breaker.Notice;
                var text = notice != null ? notice.text : null;
                if (!string.IsNullOrEmpty(text))
                {
                    bits.Add("notice=" + text.Replace('|', '/').Trim());
                }
            }
            catch { /* optional */ }

            try
            {
                var full = breaker.FullCard;
                bits.Add("fullCard=" + (full != null && full.activeInHierarchy));
            }
            catch { bits.Add("fullCard=?"); }

            // Promise typed reads can fail without Promise.dll — report pointer presence only.
            foreach (var key in new[] { "ClickPromise", "FinalPromise", "InitPromise", "AnimationDone", "CardShow" })
            {
                try
                {
                    var flags = System.Reflection.BindingFlags.Instance
                                | System.Reflection.BindingFlags.Public
                                | System.Reflection.BindingFlags.NonPublic;
                    var prop = breaker.GetType().GetProperty(key, flags);
                    object val = null;
                    try { val = prop?.GetValue(breaker); }
                    catch { val = "err"; }
                    bits.Add(key + "=" + (val == null ? "null" : (val is string ? "err" : "set")));
                }
                catch
                {
                    bits.Add(key + "=?");
                }
            }

            return "diag{" + string.Join(",", bits) + "}";
        }

        private static void TrySetBoolMember(
            object target,
            string name,
            bool value,
            List<string> parts,
            string label)
        {
            if (target == null || string.IsNullOrEmpty(name)) return;
            try
            {
                var flags = System.Reflection.BindingFlags.Instance
                            | System.Reflection.BindingFlags.Public
                            | System.Reflection.BindingFlags.NonPublic;
                var type = target.GetType();
                var prop = type.GetProperty(name, flags);
                if (prop != null && prop.PropertyType == typeof(bool) && prop.CanWrite)
                {
                    prop.SetValue(target, value);
                    parts?.Add(label);
                    return;
                }

                var field = type.GetField(name, flags);
                if (field != null && field.FieldType == typeof(bool))
                {
                    field.SetValue(target, value);
                    parts?.Add(label);
                }
            }
            catch
            {
                // optional
            }
        }

        private static void TryInvokeNoArg(object target, string methodName, List<string> parts, string label)
        {
            if (target == null || string.IsNullOrEmpty(methodName) || parts == null) return;
            try
            {
                var method = target.GetType().GetMethod(
                    methodName,
                    System.Reflection.BindingFlags.Instance
                    | System.Reflection.BindingFlags.Public
                    | System.Reflection.BindingFlags.NonPublic,
                    null,
                    Type.EmptyTypes,
                    null);
                if (method == null) return;
                method.Invoke(target, null);
                parts.Add(label);
            }
            catch
            {
                // optional
            }
        }

        private static void TryResolvePromiseField(object target, string fieldOrProp, List<string> parts)
        {
            if (target == null || string.IsNullOrEmpty(fieldOrProp) || parts == null) return;
            try
            {
                var flags = System.Reflection.BindingFlags.Instance
                            | System.Reflection.BindingFlags.Public
                            | System.Reflection.BindingFlags.NonPublic;
                var type = target.GetType();
                object promise = null;
                var prop = type.GetProperty(fieldOrProp, flags);
                if (prop != null) promise = prop.GetValue(target);
                if (promise == null)
                {
                    var field = type.GetField(fieldOrProp, flags);
                    if (field != null) promise = field.GetValue(target);
                }

                if (promise == null) return;
                var resolve = promise.GetType().GetMethod(
                    "Resolve",
                    flags,
                    null,
                    Type.EmptyTypes,
                    null);
                if (resolve == null) return;
                resolve.Invoke(promise, null);
                parts.Add("resolve:" + fieldOrProp);
            }
            catch
            {
                // optional
            }
        }

        private static string RiteResultFingerprint(Dictionary<string, object> snap)
        {
            if (snap == null) return "";
            snap.TryGetValue("active", out var active);
            snap.TryGetValue("stage", out var stage);
            snap.TryGetValue("nextInteractable", out var next);
            snap.TryGetValue("body", out var body);
            snap.TryGetValue("title", out var title);
            snap.TryGetValue("rewardSummary", out var rewards);
            snap.TryGetValue("successCount", out var success);
            snap.TryGetValue("dicePromptVisible", out var dice);
            snap.TryGetValue("goldSelectInteractable", out var goldSelect);
            snap.TryGetValue("goldConfirmInteractable", out var goldConfirm);
            return string.Join("|",
                active, stage, next, body, title, rewards, success, dice, goldSelect, goldConfirm);
        }

        /// <summary>
        /// Call the panel's real blank-click handler (matches human click on gray-Next pages).
        /// </summary>
        private static bool TryInvokeRiteResultPointerClick(Component panel, out string via)
        {
            via = null;
            if (panel == null) return false;
            try
            {
                if (panel is RiteResultPanelController typed)
                {
                    var eventSystem = EventSystem.current;
                    if (eventSystem == null) return false;
                    var pointer = new PointerEventData(eventSystem)
                    {
                        button = PointerEventData.InputButton.Left
                    };
                    var rect = panel.transform as RectTransform;
                    if (rect != null)
                    {
                        Camera cam = null;
                        var t = rect.transform;
                        for (var i = 0; i < 12 && t != null; i++)
                        {
                            var canvas = t.GetComponent<Canvas>();
                            if (canvas != null && canvas.renderMode != RenderMode.ScreenSpaceOverlay)
                            {
                                cam = canvas.worldCamera != null ? canvas.worldCamera : Camera.main;
                                break;
                            }

                            t = t.parent;
                        }

                        var world = rect.TransformPoint(rect.rect.center);
                        pointer.position = RectTransformUtility.WorldToScreenPoint(cam, world);
                    }

                    typed.OnPointerClick(pointer);
                    via = "panel_OnPointerClick";
                    return true;
                }
            }
            catch
            {
                // fall through to reflection
            }

            try
            {
                var method = panel.GetType().GetMethod(
                    "OnPointerClick",
                    System.Reflection.BindingFlags.Instance
                    | System.Reflection.BindingFlags.Public
                    | System.Reflection.BindingFlags.NonPublic);
                if (method == null) return false;
                var parameters = method.GetParameters();
                if (parameters.Length == 0)
                {
                    method.Invoke(panel, null);
                    via = "panel_OnPointerClick:0";
                    return true;
                }

                if (parameters.Length == 1
                    && typeof(PointerEventData).IsAssignableFrom(parameters[0].ParameterType))
                {
                    var eventSystem = EventSystem.current;
                    if (eventSystem == null) return false;
                    var pointer = new PointerEventData(eventSystem)
                    {
                        button = PointerEventData.InputButton.Left
                    };
                    method.Invoke(panel, new object[] { pointer });
                    via = "panel_OnPointerClick:1";
                    return true;
                }
            }
            catch
            {
                return false;
            }

            return false;
        }
#endif

        public static bool TrySelectGoldDice(out string detail)
        {
            detail = null;
#if !GAME_INTEROP
            detail = "no_interop";
            return false;
#else
            var panel = Controller?.riteResultPanel;
            if (!IsUiActive(panel) || panel.transform == null)
            {
                detail = "rite_result_inactive";
                return false;
            }

            var button = FindInteractableButtonByLabels(panel.transform, "金骰子", "Gold Dice", "GoldDice");
            if (button == null)
            {
                detail = "gold_dice_button_missing";
                return false;
            }

            button.onClick.Invoke();
            detail = "gold_dice";
            return true;
#endif
        }

        public static bool TryConfirmGoldDice(out string detail)
        {
            detail = null;
#if !GAME_INTEROP
            detail = "no_interop";
            return false;
#else
            var panel = Controller?.riteResultPanel;
            if (!IsUiActive(panel) || panel.transform == null)
            {
                detail = "rite_result_inactive";
                return false;
            }

            if (OverlayScanner.TryClickNamedButton(panel.transform, "Gold Confirm", requireInteractable: true))
            {
                detail = "gold_confirm";
                return true;
            }

            detail = "gold_confirm_missing";
            return false;
#endif
        }

        public static bool TryCancelGoldDice(out string detail)
        {
            detail = null;
#if !GAME_INTEROP
            detail = "no_interop";
            return false;
#else
            var panel = Controller?.riteResultPanel;
            if (!IsUiActive(panel) || panel.transform == null)
            {
                detail = "rite_result_inactive";
                return false;
            }

            if (OverlayScanner.TryClickNamedButton(panel.transform, "Gold Cancel", requireInteractable: true)
                || OverlayScanner.TryClickNamedButton(panel.transform, "Gold Cancel Full", requireInteractable: true))
            {
                detail = "gold_cancel";
                return true;
            }

            // gold_select has no cancel button — blank/body click skips spending.
            var snap = ReadRiteResultSnapshot();
            var stage = snap.TryGetValue("stage", out var stageRaw) ? stageRaw as string : null;
            if (string.Equals(stage, RiteResultPolicy.StageGoldSelect, StringComparison.OrdinalIgnoreCase)
                && TryClickRiteResultBody(panel.transform))
            {
                detail = "result_text_skip";
                return true;
            }

            detail = "gold_cancel_missing";
            return false;
#endif
        }

#if GAME_INTEROP
        private static string ReadStoryEntryBadge(Transform root)
        {
            if (root == null) return null;
            try
            {
                var queue = new System.Collections.Generic.Queue<Transform>();
                queue.Enqueue(root);
                var seen = 0;
                while (queue.Count > 0 && seen < 40)
                {
                    var t = queue.Dequeue();
                    seen++;
                    if (t == null || !t.gameObject.activeInHierarchy) continue;
                    var name = t.name ?? "";
                    if (name.IndexOf("New", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("Badge", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("Tip", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        var tmp = t.GetComponent<TMPro.TMP_Text>();
                        var legacy = t.GetComponent<UnityEngine.UI.Text>();
                        var text = tmp != null ? tmp.text : (legacy != null ? legacy.text : null);
                        text = TruncateUiText(text, 24);
                        if (!string.IsNullOrEmpty(text)) return text;
                    }
                    for (var i = 0; i < t.childCount; i++) queue.Enqueue(t.GetChild(i));
                }
            }
            catch
            {
                // optional
            }
            return null;
        }

        private static List<string> CollectActiveTexts(Transform root, int maxItems, int minLen = 2)
        {
            var list = new List<string>();
            if (root == null || maxItems <= 0) return list;
            if (minLen < 1) minLen = 1;
            try
            {
                var queue = new System.Collections.Generic.Queue<Transform>();
                queue.Enqueue(root);
                var seen = 0;
                while (queue.Count > 0 && seen < 120 && list.Count < maxItems)
                {
                    var t = queue.Dequeue();
                    seen++;
                    if (t == null || !t.gameObject.activeInHierarchy) continue;
                    var tmp = t.GetComponent<TMPro.TMP_Text>();
                    var legacy = t.GetComponent<UnityEngine.UI.Text>();
                    var text = TruncateUiText(tmp != null ? tmp.text : (legacy != null ? legacy.text : null), 120);
                    if (!string.IsNullOrEmpty(text)
                        && text.Length >= minLen
                        && !list.Contains(text))
                    {
                        list.Add(text);
                    }
                    for (var i = 0; i < t.childCount; i++) queue.Enqueue(t.GetChild(i));
                }
            }
            catch
            {
                // optional
            }
            return list;
        }

        private static List<string> DistinctStrings(List<string> values)
        {
            var list = new List<string>();
            if (values == null) return list;
            foreach (var value in values)
            {
                if (string.IsNullOrEmpty(value) || list.Contains(value)) continue;
                list.Add(value);
            }
            return list;
        }

        private static int? ParseSuccessThreshold(string tip)
        {
            if (string.IsNullOrEmpty(tip)) return null;
            // e.g. "3点成功将会获得最高的收益。" / "你至少需要2点成功"
            try
            {
                var digits = new System.Text.StringBuilder();
                for (var i = 0; i < tip.Length; i++)
                {
                    var ch = tip[i];
                    if (ch >= '0' && ch <= '9')
                    {
                        digits.Append(ch);
                        continue;
                    }
                    if (digits.Length > 0) break;
                }
                if (digits.Length > 0 && int.TryParse(digits.ToString(), out var n)) return n;
            }
            catch
            {
                // optional
            }
            return null;
        }

        private static int? ReadRolledSuccessCount(Transform panelRoot, Transform diceCountPrompt, string tip)
        {
            // Prefer explicit success/result nodes under the post-roll prompt.
            var searchRoots = new List<Transform>();
            if (diceCountPrompt != null) searchRoots.Add(diceCountPrompt);
            if (panelRoot != null) searchRoots.Add(panelRoot);

            foreach (var root in searchRoots)
            {
                try
                {
                    var queue = new Queue<Transform>();
                    queue.Enqueue(root);
                    var seen = 0;
                    while (queue.Count > 0 && seen < 160)
                    {
                        var t = queue.Dequeue();
                        seen++;
                        if (t == null || !t.gameObject.activeInHierarchy) continue;
                        var name = t.name ?? "";
                        var looksLikeSuccess = name.IndexOf("Success", StringComparison.OrdinalIgnoreCase) >= 0
                                              || name.IndexOf("ResultCount", StringComparison.OrdinalIgnoreCase) >= 0
                                              || name.IndexOf("Point", StringComparison.OrdinalIgnoreCase) >= 0
                                              || name.IndexOf("Score", StringComparison.OrdinalIgnoreCase) >= 0
                                              || name.Equals("Count", StringComparison.OrdinalIgnoreCase)
                                              || name.Equals("Num", StringComparison.OrdinalIgnoreCase)
                                              || name.Equals("Value", StringComparison.OrdinalIgnoreCase);
                        if (looksLikeSuccess)
                        {
                            // Skip attribute need-tag values under DiceNeedTags.
                            var pathOk = true;
                            var p = t;
                            while (p != null)
                            {
                                if (string.Equals(p.name, "DiceNeedTags", StringComparison.OrdinalIgnoreCase)
                                    || string.Equals(p.name, "Tips", StringComparison.OrdinalIgnoreCase)
                                    || string.Equals(p.name, "RightTips", StringComparison.OrdinalIgnoreCase))
                                {
                                    pathOk = false;
                                    break;
                                }
                                p = p.parent;
                            }
                            if (pathOk)
                            {
                                var text = TruncateUiText(ReadFirstText(t), 8);
                                if (!string.IsNullOrEmpty(text) && int.TryParse(text, out var n))
                                {
                                    return n;
                                }
                            }
                        }
                        for (var i = 0; i < t.childCount; i++) queue.Enqueue(t.GetChild(i));
                    }
                }
                catch
                {
                    // try next root
                }
            }

            // Count active success-looking dice faces under DiceCountPromptNew.
            if (diceCountPrompt != null)
            {
                var successFaces = CountNamedActiveChildren(
                    diceCountPrompt,
                    "Success", "Win", "Good", "Hit", "Succ");
                if (successFaces > 0) return successFaces;
            }

            // Last resort: single-digit texts under dice count prompt, excluding tip digits.
            if (diceCountPrompt != null)
            {
                var tipThreshold = ParseSuccessThreshold(tip);
                var digits = CollectActiveTexts(diceCountPrompt, 12, minLen: 1);
                foreach (var text in digits)
                {
                    if (!int.TryParse(text, out var n)) continue;
                    if (tipThreshold.HasValue && n == tipThreshold.Value && tip != null && tip.Contains(text))
                    {
                        // Likely the threshold digit embedded in tip text, not rolled success.
                        continue;
                    }
                    if (n >= 0 && n <= 20) return n;
                }
            }

            return null;
        }

        private static int CountNamedActiveChildren(Transform root, params string[] tokens)
        {
            if (root == null || tokens == null || tokens.Length == 0) return 0;
            var count = 0;
            try
            {
                var queue = new Queue<Transform>();
                queue.Enqueue(root);
                var seen = 0;
                while (queue.Count > 0 && seen < 200)
                {
                    var t = queue.Dequeue();
                    seen++;
                    if (t == null || !t.gameObject.activeInHierarchy) continue;
                    var name = t.name ?? "";
                    foreach (var token in tokens)
                    {
                        if (!string.IsNullOrEmpty(token)
                            && name.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            count++;
                            break;
                        }
                    }
                    for (var i = 0; i < t.childCount; i++) queue.Enqueue(t.GetChild(i));
                }
            }
            catch
            {
                return count;
            }
            return count;
        }

        /// <summary>
        /// Cards shown in rite-result "Op Cards" (e.g. 金币 x5, returning 梅姬).
        /// </summary>
        private static List<object> ReadRiteResultRewards(Transform root)
        {
            var list = new List<object>();
            if (root == null) return list;
            try
            {
                var opCards = FindDescendant(root, "Op Cards") ?? FindDescendant(root, "OpCards");
                var searchRoot = opCards != null ? opCards : root;
                var seen = new HashSet<int>();

                var widgets = searchRoot.GetComponentsInChildren<CardController>(true);
                if (widgets != null)
                {
                    foreach (var widget in widgets)
                    {
                        if (widget == null || widget.gameObject == null || !widget.gameObject.activeInHierarchy)
                        {
                            continue;
                        }

                        // When falling back to whole panel, skip ordinary hand widgets.
                        if (opCards == null)
                        {
                            var path = BuildTransformPath(widget.transform);
                            if (path.IndexOf("Op Card", StringComparison.OrdinalIgnoreCase) < 0
                                && path.IndexOf("OpCard", StringComparison.OrdinalIgnoreCase) < 0)
                            {
                                continue;
                            }
                        }

                        var card = widget.card;
                        if (card == null || !seen.Add(card.uid)) continue;
                        var name = ConfigCatalog.Instance.ResolveCardName(
                            card.id, card.custom_name, card.Type);
                        var badge = ReadNewGetBadge(widget.transform);
                        list.Add(new Dictionary<string, object>
                        {
                            ["uid"] = card.uid,
                            ["id"] = card.id,
                            ["name"] = name,
                            ["count"] = card.count,
                            ["type"] = card.Type,
                            ["rare"] = card.Rare,
                            ["isNew"] = !string.IsNullOrEmpty(badge),
                            ["badge"] = badge,
                            ["label"] = FormatRewardLabel(name, card.count, badge)
                        });
                    }
                }

                // Text-only fallback when CardController is missing on decorative reward slots.
                if (list.Count == 0 && opCards != null)
                {
                    for (var i = 0; i < opCards.childCount && list.Count < 8; i++)
                    {
                        var child = opCards.GetChild(i);
                        if (child == null || !child.gameObject.activeInHierarchy) continue;
                        if (child.name == null
                            || child.name.IndexOf("OpCard", StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            continue;
                        }

                        var texts = CollectActiveTexts(child, 8, minLen: 1);
                        var badge = ReadNewGetBadge(child);
                        var name = PickRewardNameFromTexts(texts, badge);
                        var count = PickRewardCountFromTexts(texts);
                        if (string.IsNullOrEmpty(name) && string.IsNullOrEmpty(badge) && count == null)
                        {
                            continue;
                        }

                        list.Add(new Dictionary<string, object>
                        {
                            ["uid"] = null,
                            ["id"] = null,
                            ["name"] = name,
                            ["count"] = count,
                            ["type"] = null,
                            ["rare"] = null,
                            ["isNew"] = !string.IsNullOrEmpty(badge),
                            ["badge"] = badge,
                            ["texts"] = texts.ConvertAll(t => (object)t),
                            ["label"] = FormatRewardLabel(name, count, badge)
                        });
                    }
                }
            }
            catch
            {
                // optional
            }

            return list;
        }

        private static string ReadNewGetBadge(Transform root)
        {
            var badge = FindDescendant(root, "NewGet");
            if (badge == null || !badge.gameObject.activeInHierarchy) return null;
            return TruncateUiText(ReadFirstText(badge), 24);
        }

        private static string FormatRewardLabel(string name, object count, string badge)
        {
            var label = name ?? "card";
            if (count != null)
            {
                label = label + " x" + count;
            }
            if (!string.IsNullOrEmpty(badge))
            {
                label = badge + label;
            }
            return label;
        }

        private static string FormatRewardSummary(List<object> rewards)
        {
            if (rewards == null || rewards.Count == 0) return null;
            var parts = new List<string>();
            foreach (var raw in rewards)
            {
                if (raw is Dictionary<string, object> reward
                    && reward.TryGetValue("label", out var label)
                    && label is string s
                    && !string.IsNullOrWhiteSpace(s))
                {
                    parts.Add(s);
                }
            }
            return parts.Count > 0 ? string.Join(", ", parts) : null;
        }

        private static string PickRewardNameFromTexts(List<string> texts, string badge)
        {
            if (texts == null) return null;
            foreach (var text in texts)
            {
                if (string.IsNullOrEmpty(text) || text == badge) continue;
                if (int.TryParse(text, out _)) continue;
                if (text == "新出现！" || text == "新获得！" || text == "New") continue;
                return TruncateUiText(text, 40);
            }
            return null;
        }

        private static int? PickRewardCountFromTexts(List<string> texts)
        {
            if (texts == null) return null;
            foreach (var text in texts)
            {
                if (!string.IsNullOrEmpty(text) && int.TryParse(text, out var n) && n > 0 && n < 1000)
                {
                    return n;
                }
            }
            return null;
        }

        private static string BuildTransformPath(Transform transform)
        {
            if (transform == null) return "";
            var parts = new List<string>();
            var current = transform;
            var guard = 0;
            while (current != null && guard++ < 16)
            {
                parts.Add(current.name ?? "?");
                current = current.parent;
            }
            parts.Reverse();
            return string.Join("/", parts);
        }

        private static string TruncateUiText(string text, int maxLen)
        {
            if (string.IsNullOrEmpty(text)) return null;
            text = text.Replace("\r", " ").Replace("\n", " ").Trim();
            if (text.Length == 0) return null;
            if (maxLen > 0 && text.Length > maxLen) text = text.Substring(0, maxLen) + "…";
            return text;
        }

        private static bool Bool(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.TryGetValue(key, out var raw) || raw == null) return false;
            if (raw is bool b) return b;
            return bool.TryParse(raw.ToString(), out var parsed) && parsed;
        }

        private static Transform FindDescendant(Transform root, string name)
        {
            if (root == null || string.IsNullOrEmpty(name)) return null;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                if (current == null) continue;
                if (string.Equals(current.name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return current;
                }
                for (var i = 0; i < current.childCount; i++) queue.Enqueue(current.GetChild(i));
            }
            return null;
        }

        private static string ReadFirstText(Transform root)
        {
            if (root == null) return null;
            try
            {
                var tmp = root.GetComponent<TMPro.TMP_Text>();
                if (tmp != null && !string.IsNullOrWhiteSpace(tmp.text)) return tmp.text;
                var legacy = root.GetComponent<Text>();
                if (legacy != null && !string.IsNullOrWhiteSpace(legacy.text)) return legacy.text;
                var texts = CollectActiveTexts(root, 1);
                return texts.Count > 0 ? texts[0] : null;
            }
            catch
            {
                return null;
            }
        }

        private static string ReadResultBodyText(Transform root)
        {
            var result = FindDescendant(root, "Result");
            if (result == null) return null;
            var texts = CollectActiveTexts(result, 3);
            return texts.Count > 0 ? string.Join(" ", texts) : null;
        }

        private static List<object> ReadDiceNeedTags(Transform root)
        {
            var list = new List<object>();
            var tagsRoot = FindDescendant(root, "DiceNeedTags");
            if (tagsRoot == null) return list;
            try
            {
                for (var i = 0; i < tagsRoot.childCount && list.Count < 8; i++)
                {
                    var tag = tagsRoot.GetChild(i);
                    if (tag == null || !tag.gameObject.activeInHierarchy) continue;
                    if (tag.name == null
                        || tag.name.IndexOf("Tag", StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        // Still accept unknown children under DiceNeedTags.
                    }

                    var valueNode = FindDescendant(tag, "Value");
                    var valueText = TruncateUiText(
                        ReadFirstText(valueNode != null ? valueNode : null), 16);
                    var texts = CollectActiveTexts(tag, 6);
                    var attr = InferDiceAttrLabel(tag, texts, valueText);
                    int? valueNum = null;
                    if (!string.IsNullOrEmpty(valueText) && int.TryParse(valueText, out var parsed))
                    {
                        valueNum = parsed;
                    }

                    list.Add(new Dictionary<string, object>
                    {
                        ["attr"] = attr,
                        ["value"] = valueNum.HasValue ? (object)valueNum.Value : valueText,
                        ["valueText"] = valueText,
                        ["label"] = !string.IsNullOrEmpty(attr) && !string.IsNullOrEmpty(valueText)
                            ? attr + valueText
                            : (valueText ?? attr),
                        ["texts"] = texts.ConvertAll(t => (object)t),
                        ["node"] = tag.name
                    });
                }
            }
            catch
            {
                // optional
            }
            return list;
        }

        private static string FormatDiceBreakdown(List<object> needTags)
        {
            if (needTags == null || needTags.Count == 0) return null;
            var parts = new List<string>();
            foreach (var raw in needTags)
            {
                if (raw is Dictionary<string, object> tag
                    && tag.TryGetValue("label", out var label)
                    && label is string s
                    && !string.IsNullOrWhiteSpace(s))
                {
                    parts.Add(s);
                }
            }
            return parts.Count > 0 ? string.Join(" / ", parts) : null;
        }

        private static int? SumDiceTagValues(List<object> needTags)
        {
            if (needTags == null || needTags.Count == 0) return null;
            var sum = 0;
            var any = false;
            foreach (var raw in needTags)
            {
                if (raw is not Dictionary<string, object> tag) continue;
                if (tag.TryGetValue("value", out var value) && value is int n)
                {
                    sum += n;
                    any = true;
                }
                else if (tag.TryGetValue("valueText", out var text)
                         && text is string s
                         && int.TryParse(s, out var parsed))
                {
                    sum += parsed;
                    any = true;
                }
            }
            return any ? sum : null;
        }

        private static string InferDiceAttrLabel(Transform tag, List<string> texts, string valueText)
        {
            if (texts != null)
            {
                foreach (var text in texts)
                {
                    if (string.IsNullOrEmpty(text) || text == valueText) continue;
                    var mapped = MapDiceAttrToken(text);
                    if (!string.IsNullOrEmpty(mapped)) return mapped;
                    // Non-numeric label on the tag is likely the attribute name.
                    if (!int.TryParse(text, out _)) return TruncateUiText(text, 24);
                }
            }

            if (tag == null) return null;
            try
            {
                var queue = new Queue<Transform>();
                queue.Enqueue(tag);
                var seen = 0;
                while (queue.Count > 0 && seen < 24)
                {
                    var t = queue.Dequeue();
                    seen++;
                    if (t == null) continue;
                    var mapped = MapDiceAttrToken(t.name);
                    if (!string.IsNullOrEmpty(mapped)) return mapped;

                    var image = t.GetComponent<Image>();
                    if (image != null && image.sprite != null)
                    {
                        mapped = MapDiceAttrToken(image.sprite.name);
                        if (!string.IsNullOrEmpty(mapped)) return mapped;
                    }

                    for (var i = 0; i < t.childCount; i++) queue.Enqueue(t.GetChild(i));
                }
            }
            catch
            {
                // optional
            }

            return null;
        }

        private static string MapDiceAttrToken(string token)
        {
            if (string.IsNullOrWhiteSpace(token)) return null;
            var t = token.Trim();
            var lower = t.ToLowerInvariant();
            if (t.Contains("智慧") || t.Contains("智力") || lower.Contains("wisdom")
                || lower.Contains("intellect") || lower.Contains("intelligence")
                || lower.Contains("mind") || lower.Contains("smart"))
            {
                return "智慧";
            }
            if (t.Contains("社交") || lower.Contains("social") || lower.Contains("charisma_social")
                || lower.Contains("sociab"))
            {
                return "社交";
            }
            if (t.Contains("魅力") || lower.Contains("charm") || lower.Contains("appeal"))
            {
                return "魅力";
            }
            if (t.Contains("体魄") || t.Contains("体力") || lower.Contains("physique")
                || lower.Contains("body") || lower.Contains("vital"))
            {
                return "体魄";
            }
            if (t.Contains("战斗") || t.Contains("武力") || lower.Contains("combat")
                || lower.Contains("fight") || lower.Contains("strength") || lower.Contains("might"))
            {
                return "战斗";
            }
            if (t.Contains("隐匿") || t.Contains("潜行") || lower.Contains("stealth")
                || lower.Contains("hide"))
            {
                return "隐匿";
            }
            if (t.Contains("魔力") || t.Contains("灵视") || lower.Contains("magic")
                || lower.Contains("mystic") || lower.Contains("mana"))
            {
                return "魔力";
            }
            return null;
        }

        private static string FindSelectedGoldLabel(Transform root)
        {
            try
            {
                var queue = new Queue<Transform>();
                queue.Enqueue(root);
                var seen = 0;
                while (queue.Count > 0 && seen < 120)
                {
                    var t = queue.Dequeue();
                    seen++;
                    if (t == null || !t.gameObject.activeInHierarchy) continue;
                    var text = TruncateUiText(ReadFirstText(t), 24);
                    if (!string.IsNullOrEmpty(text)
                        && text.StartsWith("x", StringComparison.OrdinalIgnoreCase)
                        && text.Length <= 6)
                    {
                        return text;
                    }
                    for (var i = 0; i < t.childCount; i++) queue.Enqueue(t.GetChild(i));
                }
            }
            catch
            {
                // optional
            }
            return null;
        }

        private static bool IsNamedButtonInteractable(Transform root, string name)
        {
            var go = FindDescendant(root, name)?.gameObject;
            if (go == null || !go.activeInHierarchy) return false;
            var button = go.GetComponent<Button>();
            return button != null && button.IsInteractable();
        }

        private static Button FindInteractableButtonByLabels(Transform root, params string[] labels)
        {
            if (root == null || labels == null || labels.Length == 0) return null;
            try
            {
                // Manual walk — GetComponentsInChildren<Button> can Cast-fault on Il2Cpp.
                var queue = new Queue<Transform>();
                queue.Enqueue(root);
                var seen = 0;
                while (queue.Count > 0 && seen < 256)
                {
                    var current = queue.Dequeue();
                    seen++;
                    if (current == null || !current.gameObject.activeInHierarchy)
                    {
                        // still enqueue children of inactive? skip.
                    }
                    else
                    {
                        Button button = null;
                        try { button = current.GetComponent<Button>(); }
                        catch { button = null; }

                        if (button != null && button.isActiveAndEnabled && button.IsInteractable())
                        {
                            var label = TruncateUiText(ReadDescendantButtonText(button.transform), 40);
                            if (!string.IsNullOrEmpty(label))
                            {
                                foreach (var want in labels)
                                {
                                    if (string.IsNullOrEmpty(want)) continue;
                                    if (label.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0)
                                    {
                                        return button;
                                    }
                                }
                            }
                        }
                    }

                    if (current == null) continue;
                    for (var i = 0; i < current.childCount; i++)
                    {
                        queue.Enqueue(current.GetChild(i));
                    }
                }
            }
            catch
            {
                // optional
            }
            return null;
        }

        /// <summary>
        /// Find a wizard/menu button by exact normalized label predicate (no substring match).
        /// </summary>
        private static Button FindInteractableButtonByExactLabelPredicate(
            Transform root,
            Func<string, bool> predicate)
        {
            if (root == null || predicate == null) return null;
            try
            {
                var queue = new Queue<Transform>();
                queue.Enqueue(root);
                var seen = 0;
                while (queue.Count > 0 && seen < 256)
                {
                    var current = queue.Dequeue();
                    seen++;
                    if (current == null || !current.gameObject.activeInHierarchy)
                    {
                        // skip inactive
                    }
                    else
                    {
                        Button button = null;
                        try { button = current.GetComponent<Button>(); }
                        catch { button = null; }

                        if (button != null && button.isActiveAndEnabled && button.IsInteractable())
                        {
                            // Do not truncate — exchange labels must match exactly.
                            var label = ReadDescendantButtonText(button.transform);
                            if (predicate(label)) return button;
                        }
                    }

                    if (current == null) continue;
                    for (var i = 0; i < current.childCount; i++)
                    {
                        queue.Enqueue(current.GetChild(i));
                    }
                }
            }
            catch
            {
                // optional
            }
            return null;
        }

        private static string ReadDescendantButtonText(Transform root)
        {
            if (root == null) return null;
            // Avoid GetComponentInChildren<T> — Il2Cpp can throw VerificationException on Cast.
            var tmp = FindComponentInSubtree<TMPro.TMP_Text>(root);
            if (tmp != null && !string.IsNullOrWhiteSpace(tmp.text)) return tmp.text;
            var legacy = FindComponentInSubtree<Text>(root);
            return legacy != null ? legacy.text : root.name;
        }

        /// <summary>
        /// Il2Cpp-safe subtree search: walk transforms and use non-generic GetComponent.
        /// GetComponentInChildren/GetComponentInParent have thrown VerificationException
        /// (Il2CppObjectBase.Cast constraint) on rite-result pages.
        /// </summary>
        private static T FindComponentInSubtree<T>(Transform root) where T : Component
        {
            if (root == null) return null;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            var seen = 0;
            while (queue.Count > 0 && seen < 256)
            {
                var current = queue.Dequeue();
                seen++;
                if (current == null) continue;
                try
                {
                    var c = current.GetComponent<T>();
                    if (c != null) return c;
                }
                catch
                {
                    // skip hostile node
                }

                for (var i = 0; i < current.childCount; i++)
                {
                    queue.Enqueue(current.GetChild(i));
                }
            }

            return null;
        }

        private static Button FindButtonInAncestors(Transform start, int maxHops = 8)
        {
            var t = start;
            for (var i = 0; i < maxHops && t != null; i++)
            {
                try
                {
                    var button = t.GetComponent<Button>();
                    if (button != null) return button;
                }
                catch
                {
                    // skip
                }

                t = t.parent;
            }

            return null;
        }

        /// <summary>
        /// Click blank / background of the rite result panel (matches human "click the screen").
        /// Prefer this over text Button.onClick, which often no-ops after typewriter finishes.
        /// </summary>
        private static bool TryClickRiteResultBlank(Transform root)
        {
            if (root == null) return false;
            try
            {
                // Named dimmers / backgrounds first.
                string[] blankNames =
                {
                    "BG", "Background", "Dimmer", "Mask", "Black", "Fade",
                    "PanelBG", "ModelBG", "Image", "Root", "Panel"
                };
                foreach (var name in blankNames)
                {
                    var node = FindDescendant(root, name);
                    if (node == null || !node.gameObject.activeInHierarchy) continue;
                    if (IsRiteResultNoiseName(node.name)) continue;
                    if (ClickPointerTarget(node.gameObject, preferHierarchy: true)) return true;
                }

                // Panel root / canvas group — same as a human click on empty area.
                if (ClickPointerTarget(root.gameObject, preferHierarchy: true)) return true;

                // Large inactive Image under panel (often the click-catcher).
                var catcher = FindLargestClickCatcher(root);
                if (catcher != null && ClickPointerTarget(catcher, preferHierarchy: true)) return true;

                return false;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryClickRiteResultBody(Transform root)
        {
            if (root == null) return false;
            try
            {
                // Named hotspots — use pointer events, NOT Button.onClick.Invoke.
                // onClick.Invoke can "succeed" without advancing typewriter/result pages.
                string[] hotspotNames =
                {
                    "Result", "Title", "Content", "Body", "Desc", "Description",
                    "Scroll View", "ScrollView", "Viewport", "Text"
                };
                foreach (var name in hotspotNames)
                {
                    var node = FindDescendant(root, name);
                    if (node == null || !node.gameObject.activeInHierarchy) continue;
                    if (IsRiteResultNoiseName(node.name)) continue;

                    if (ClickPointerTarget(node.gameObject, preferHierarchy: true)) return true;

                    var tmp = FindComponentInSubtree<TMPro.TMP_Text>(node);
                    if (tmp != null && ClickPointerTarget(tmp.gameObject, preferHierarchy: true))
                    {
                        return true;
                    }

                    var legacy = FindComponentInSubtree<Text>(node);
                    if (legacy != null && ClickPointerTarget(legacy.gameObject, preferHierarchy: true))
                    {
                        return true;
                    }
                }

                // Any IPointerClickHandler under panel except gold/autoplay/scrollbar.
                var pointerTarget = FindFirstPointerAdvanceTarget(root);
                if (pointerTarget != null && ClickPointerTarget(pointerTarget, preferHierarchy: true))
                {
                    return true;
                }

                return ClickPointerTarget(root.gameObject, preferHierarchy: true);
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Chain blank → body → panel methods. Used when earlier single gestures failed
        /// to locate a handler, or as recovery after false-positive clicks stranded agents.
        /// </summary>
        private static bool TryForceAdvanceRiteResult(Component panel, out string via)
        {
            via = null;
            if (panel?.transform == null) return false;
            var root = panel.transform;
            var parts = new List<string>();

            if (TryInvokeRiteResultPointerClick(panel, out var pointerVia)
                && !string.IsNullOrEmpty(pointerVia))
            {
                parts.Add(pointerVia);
            }

            if (TryClickRiteResultBlank(root)) parts.Add("result_blank");
            if (TryClickRiteResultBody(root)) parts.Add("result_text");
            if (OverlayScanner.TryClickNamedButton(root, "Next", requireInteractable: true))
            {
                parts.Add("next");
            }

            if (parts.Count == 0) return false;
            via = "force:" + string.Join("+", parts);
            return true;
        }

        private static bool IsRiteResultNoiseName(string name)
        {
            if (string.IsNullOrEmpty(name)) return true;
            return name.IndexOf("AutoPlay", StringComparison.OrdinalIgnoreCase) >= 0
                   || name.IndexOf("Gold", StringComparison.OrdinalIgnoreCase) >= 0
                   || name.IndexOf("Scrollbar", StringComparison.OrdinalIgnoreCase) >= 0
                   || name.IndexOf("Scroll Bar", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static GameObject FindLargestClickCatcher(Transform root)
        {
            if (root == null) return null;
            GameObject best = null;
            var bestArea = 0f;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            var seen = 0;
            while (queue.Count > 0 && seen < 256)
            {
                var current = queue.Dequeue();
                seen++;
                if (current == null || !current.gameObject.activeInHierarchy) continue;
                if (IsRiteResultNoiseName(current.name)) continue;

                try
                {
                    var rect = current as RectTransform ?? current.GetComponent<RectTransform>();
                    if (rect != null)
                    {
                        var area = Mathf.Abs(rect.rect.width * rect.rect.height);
                        // Prefer large catchers; skip tiny icons.
                        if (area > bestArea && area >= 200f * 200f)
                        {
                            bestArea = area;
                            best = current.gameObject;
                        }
                    }
                }
                catch
                {
                    // skip
                }

                for (var i = 0; i < current.childCount; i++)
                {
                    queue.Enqueue(current.GetChild(i));
                }
            }

            return best;
        }

        private static GameObject FindFirstPointerAdvanceTarget(Transform root)
        {
            if (root == null) return null;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            var seen = 0;
            while (queue.Count > 0 && seen < 256)
            {
                var current = queue.Dequeue();
                seen++;
                if (current == null || !current.gameObject.activeInHierarchy) continue;
                if (IsRiteResultNoiseName(current.name)) continue;
                try
                {
                    if (ExecuteEvents.CanHandleEvent<IPointerClickHandler>(current.gameObject))
                    {
                        return current.gameObject;
                    }
                }
                catch
                {
                    // skip
                }

                for (var i = 0; i < current.childCount; i++)
                {
                    queue.Enqueue(current.GetChild(i));
                }
            }

            return null;
        }

        private static Button FindFirstInteractableAdvanceButton(Transform root)
        {
            if (root == null) return null;
            var queue = new Queue<Transform>();
            queue.Enqueue(root);
            var seen = 0;
            while (queue.Count > 0 && seen < 256)
            {
                var current = queue.Dequeue();
                seen++;
                if (current == null || !current.gameObject.activeInHierarchy) continue;
                var n = current.name ?? "";
                if (n.IndexOf("AutoPlay", StringComparison.OrdinalIgnoreCase) >= 0
                    || n.IndexOf("Gold", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    // skip noise / gold spend controls
                }
                else
                {
                    try
                    {
                        var button = current.GetComponent<Button>();
                        if (button != null && button.isActiveAndEnabled && button.IsInteractable())
                        {
                            return button;
                        }
                    }
                    catch
                    {
                        // skip
                    }
                }

                for (var i = 0; i < current.childCount; i++)
                {
                    queue.Enqueue(current.GetChild(i));
                }
            }

            return null;
        }

        private static bool TryInvokeRiteResultPanelMethod(Component panel, out string via)
        {
            via = null;
            if (panel == null) return false;
            string[] names = { "OnNext", "Next", "Close", "Hide", "OnClose", "Dismiss", "Continue" };
            try
            {
                var type = panel.GetType();
                foreach (var name in names)
                {
                    var method = type.GetMethod(
                        name,
                        System.Reflection.BindingFlags.Instance
                        | System.Reflection.BindingFlags.Public
                        | System.Reflection.BindingFlags.NonPublic);
                    if (method == null || method.GetParameters().Length != 0) continue;
                    method.Invoke(panel, null);
                    via = "panel_method:" + name;
                    return true;
                }
            }
            catch
            {
                return false;
            }

            return false;
        }

        private static bool ClickPointerTarget(GameObject target, bool preferHierarchy = false)
        {
            if (target == null || !target.activeInHierarchy) return false;
            try
            {
                var eventSystem = EventSystem.current;
                if (eventSystem == null) return false;
                var pointer = new PointerEventData(eventSystem)
                {
                    button = PointerEventData.InputButton.Left
                };
                var rect = target.GetComponent<RectTransform>();
                Camera cam = null;
                if (rect != null)
                {
                    try
                    {
                        // Manual ancestor walk — GetComponentInParent<Canvas> can Cast-fault on Il2Cpp.
                        var t = rect.transform;
                        for (var i = 0; i < 12 && t != null; i++)
                        {
                            var canvas = t.GetComponent<Canvas>();
                            if (canvas != null && canvas.renderMode != RenderMode.ScreenSpaceOverlay)
                            {
                                cam = canvas.worldCamera != null ? canvas.worldCamera : Camera.main;
                                break;
                            }

                            t = t.parent;
                        }
                    }
                    catch
                    {
                        cam = Camera.main;
                    }

                    // Prefer geometric center of the rect (human click on blank area).
                    var world = rect.TransformPoint(rect.rect.center);
                    pointer.position = RectTransformUtility.WorldToScreenPoint(cam, world);
                }

                // Pointer down → up → click mirrors a real mouse press; some panels only
                // listen on down/up, while others only handle click.
                if (preferHierarchy)
                {
                    var down = ExecuteEvents.ExecuteHierarchy(
                        target, pointer, ExecuteEvents.pointerDownHandler);
                    var up = ExecuteEvents.ExecuteHierarchy(
                        target, pointer, ExecuteEvents.pointerUpHandler);
                    var click = ExecuteEvents.ExecuteHierarchy(
                        target, pointer, ExecuteEvents.pointerClickHandler);
                    if (down != null || up != null || click != null) return true;
                }

                var handled = false;
                handled |= ExecuteEvents.Execute(target, pointer, ExecuteEvents.pointerDownHandler);
                handled |= ExecuteEvents.Execute(target, pointer, ExecuteEvents.pointerUpHandler);
                handled |= ExecuteEvents.Execute(target, pointer, ExecuteEvents.pointerClickHandler);
                return handled;
            }
            catch
            {
                return false;
            }
        }
#endif

        public static int NeedNewInitId
        {
            get
            {
                try { return LoadController.NeedNewInitId; }
                catch { return 0; }
            }
        }

        public static int NeedLoadRound
        {
            get
            {
                try { return LoadController.NeedLoadRound; }
                catch { return 0; }
            }
        }

        public static void LoadNewGame(int initId) => LoadController.LoadNewGame(initId);
        public static void LoadRound(int round, bool begin = true) => LoadController.LoadRound(round, begin);
        public static void ReloadStart() => LoadController.ReloadStart();

        public static Card FindCardByUid(int uid)
        {
            var player = Player;
            if (player?.cards != null)
            {
                for (int i = 0; i < player.cards.Count; i++)
                {
                    var card = player.cards[i];
                    if (card != null && card.uid == uid) return card;
                }

                // Equipped items often leave the flat inventory list and only remain on char.equips.
                for (int i = 0; i < player.cards.Count; i++)
                {
                    var owner = player.cards[i];
                    if (owner == null || !EquipmentProjector.IsCharacterType(owner.Type)) continue;
                    try
                    {
                        var equips = owner.equips;
                        if (equips == null) continue;
                        for (var e = 0; e < equips.Count; e++)
                        {
                            var item = equips[e];
                            if (item != null && item.uid == uid) return item;
                        }
                    }
                    catch
                    {
                        // optional IL2CPP access
                    }
                }
            }

            // Active Sudan card may be the current drag target for 俺寻思.
            try
            {
                var sudan = FindCurrentSudanCard();
                if (sudan != null && sudan.uid == uid) return sudan;
            }
            catch
            {
                // optional
            }

            // Cards already seated on the open rite (NPC / pre-filled) may not be in Player.cards.
            return FindCardOnOpenRite(uid);
        }

        /// <summary>
        /// Resolve a hand/inventory card by catalog id when a recorded instance uid is stale
        /// (common for stackable gold after CardSplit during recording).
        /// Prefers in-hand stacks that can satisfy minCount; otherwise largest matching stack.
        /// </summary>
        public static Card FindHandCardById(int cardId, int? minCount = null)
        {
            var player = Player;
            if (player?.cards == null) return null;

            Card best = null;
            var bestCount = -1;
            var bestInHand = false;

            for (int i = 0; i < player.cards.Count; i++)
            {
                var card = player.cards[i];
                if (card == null) continue;
                try
                {
                    if (card.id != cardId) continue;
                }
                catch
                {
                    continue;
                }

                var count = 1;
                try { count = Math.Max(1, card.count); } catch { count = 1; }
                if (minCount.HasValue && count < minCount.Value) continue;

                var inHand = true;
                try { inHand = card.bag == 0; } catch { inHand = true; }

                // Prefer in-hand over bag, then larger stacks (more likely the unsplit pile).
                if (best == null
                    || (inHand && !bestInHand)
                    || (inHand == bestInHand && count > bestCount))
                {
                    best = card;
                    bestCount = count;
                    bestInHand = inHand;
                }
            }

            return best;
        }

        /// <summary>
        /// Locate the 俺寻思 ThinkController attached to GameController.IThink.
        /// </summary>
        public static ThinkController FindThinkController()
        {
            try
            {
                var go = Controller?.IThink;
                if (go != null)
                {
                    var think = go.GetComponent<ThinkController>();
                    if (think != null) return think;
                    think = go.GetComponentInChildren<ThinkController>(true);
                    if (think != null) return think;
                    think = go.GetComponentInParent<ThinkController>();
                    if (think != null) return think;
                }
            }
            catch
            {
                // optional
            }

            try { return UnityEngine.Object.FindObjectOfType<ThinkController>(); }
            catch { return null; }
        }

        /// <summary>Meta rite id for temporary 「俺寻思」 ritual spawned by ThinkController.</summary>
        public const int IThinkMetaRiteId = 5000002;

        public static Card FindCardOnOpenRite(int uid)
        {
            var panel = RitePanel;
            if (!IsUiActive(panel) || panel.Slots == null) return null;
            for (var i = 0; i < panel.Slots.Count; i++)
            {
                var slot = panel.Slots[i];
                if (slot == null) continue;
                try
                {
                    var card = slot.Current ?? slot.current;
                    if (card != null && card.uid == uid) return card;
                }
                catch
                {
                    // optional
                }
            }
            return null;
        }

        public static bool IsCardOnOpenRite(int uid) => FindCardOnOpenRite(uid) != null;

        /// <summary>
        /// Locate an active CardController for a uid. Prefers GameController.hand widgets,
        /// then any active CardController under the scene (needed for equipped items nested
        /// under character detail widgets).
        /// </summary>
        public static CardController FindActiveCardController(int uid, bool preferHand = true)
        {
            if (preferHand)
            {
                var hand = FindActiveHandCardController(uid);
                if (hand != null) return hand;
            }

            try
            {
                var widgets = UnityEngine.Object.FindObjectsOfType<CardController>(true);
                if (widgets == null) return null;
                CardController inactiveMatch = null;
                foreach (var widget in widgets)
                {
                    if (widget?.card == null || widget.card.uid != uid) continue;
                    if (widget.gameObject != null && widget.gameObject.activeInHierarchy)
                    {
                        return widget;
                    }
                    inactiveMatch ??= widget;
                }
                return inactiveMatch;
            }
            catch
            {
                return null;
            }
        }

        public static CardController FindActiveHandCardController(int uid)
        {
            try
            {
                var controller = Controller;
                var handRoot = controller?.hand;
                var widgets = handRoot != null
                    ? handRoot.GetComponentsInChildren<CardController>(true)
                    : null;
                if (widgets == null) return null;
                foreach (var widget in widgets)
                {
                    if (widget?.card != null
                        && widget.card.uid == uid
                        && widget.gameObject != null
                        && widget.gameObject.activeInHierarchy)
                    {
                        return widget;
                    }
                }
            }
            catch
            {
                // optional
            }
            return null;
        }

        public static Rite FindRiteByUid(int uid)
        {
            var player = Player;
            if (player?.rites == null) return null;
            for (int i = 0; i < player.rites.Count; i++)
            {
                var rite = player.rites[i];
                if (rite != null && rite.uid == uid) return rite;
            }
            return null;
        }

        /// <summary>
        /// Visible map rite widgets. Prefer GameController.GetViewRites(); fall back to
        /// MapController.GetViewRites(Player.rites) when the camera-local list is empty.
        /// </summary>
        public static Il2CppSystem.Collections.Generic.List<RiteController> GetVisibleMapRites()
        {
            var controller = Controller;
            if (controller == null) return null;

            try
            {
                var view = controller.GetViewRites();
                if (view != null && view.Count > 0) return view;
            }
            catch
            {
                // fall through
            }

            try
            {
                var map = controller.mapController;
                if (map == null) return null;
                return map.GetViewRites(Player?.rites);
            }
            catch
            {
                return null;
            }
        }

        public static int? TryGetCounter(int counterId)
        {
            try
            {
                var counter = Player?.counter;
                if (counter != null && counter.ContainsKey(counterId))
                {
                    return counter[counterId];
                }
            }
            catch
            {
                // optional
            }

            try
            {
                var global = Player?.global_counter_cacher;
                if (global != null && global.ContainsKey(counterId))
                {
                    return global[counterId];
                }
            }
            catch
            {
                // optional
            }

            return null;
        }

        public static Dictionary<string, object> SnapshotBindings()
        {
            var map = new Dictionary<string, object>
            {
                ["hasInterop"] = true,
                ["initDone"] = InitDone,
                ["inGame"] = InGame,
                ["hasPlayer"] = Player != null,
                ["hasController"] = Controller != null,
                ["needNewInitId"] = NeedNewInitId,
                ["needLoadRound"] = NeedLoadRound,
                ["optionActive"] = IsUiActive(OptionPanel),
                ["confirmActive"] = IsUiActive(ConfirmPanel),
                ["ritePanelActive"] = IsUiActive(RitePanel),
                ["difficultyActive"] = IsUiActive(DifficultyPanel),
                ["promptActive"] = IsPromptActive,
                ["wizardActive"] = IsWizardActive,
                ["wizardInteractableButtonCount"] = WizardInteractableButtonCount,
                ["wizardChoiceMenu"] = IsWizardChoiceMenu,
                ["promptText"] = ReadPromptText(),
                ["sudanBoxShow"] = Player != null && Player.sudan_box_show,
                ["sudanBoxReady"] = IsSudanBoxReady,
                ["sudanDrawBlocking"] = IsSudanDrawBlocking,
                // Skip tips here: probe/diagnostics must not invoke GetLeftSudanCardTips.
                ["sudanBoxTips"] = null,
                ["beginGuideActive"] = IsBeginGuideActive,
                ["beginGuide"] = ReadBeginGuideSnapshot(),
                ["gameOver"] = Controller != null && Controller.game_over
            };
            try
            {
                var overlays = OverlayScanner.Scan();
                map["changeNameActive"] = overlays.Exists(o => o.id == "change_name");
                var top = OverlayScanner.TopBlocking(overlays);
                if (top != null)
                {
                    map["topOverlay"] = top.id;
                    map["topOverlayText"] = top.text;
                }
            }
            catch
            {
                map["changeNameActive"] = false;
            }
            try
            {
                if (Player != null)
                {
                    map["playerRound"] = Player.round;
                    try { map["playerMinRound"] = Player.min_round; } catch { /* optional */ }
                    map["playerSuccess"] = Player.success;
                    map["playerOverReason"] = Player.over_reason;
                    map["cardCount"] = Player.cards?.Count ?? 0;
                    map["riteCount"] = Player.rites?.Count ?? 0;
                }
            }
            catch (Exception ex)
            {
                map["playerError"] = ex.Message;
            }
            return map;
        }
#else
        public static bool InitDone => false;
        public static bool InGame => false;
        public static Dictionary<string, object> SnapshotBindings() =>
            new Dictionary<string, object> { ["hasInterop"] = false };

        public static Dictionary<string, object> ReadDailyNewsSnapshot(int maxTextLen = 220)
        {
            return new Dictionary<string, object>
            {
                ["present"] = false,
                ["open"] = false,
                ["entryAvailable"] = false,
                ["title"] = null,
                ["summary"] = null,
                ["viewed"] = false
            };
        }

        public static bool OpenDailyNews() => false;

        public static Dictionary<string, object> ReadRiteResultSnapshot(int maxTextLen = 220)
        {
            return new Dictionary<string, object>
            {
                ["active"] = false,
                ["stage"] = RiteResultPolicy.StageInactive,
                ["title"] = null,
                ["body"] = null,
                ["tip"] = null,
                ["summary"] = null,
                ["needTags"] = new List<object>(),
                ["diceBreakdown"] = null,
                ["totalDice"] = null,
                ["leftTips"] = null,
                ["diceLines"] = new List<object>(),
                ["successCount"] = null,
                ["successThreshold"] = null,
                ["redrawInteractable"] = false,
                ["nextInteractable"] = false,
                ["goldSelectInteractable"] = false,
                ["goldConfirmInteractable"] = false,
                ["goldCancelInteractable"] = false,
                ["goldDiceAvailable"] = 0,
                ["selectedGoldLabel"] = null,
                ["dicePromptVisible"] = false,
                ["diceCountPromptVisible"] = false,
                ["rewards"] = new List<object>(),
                ["rewardSummary"] = null
            };
        }

        public static bool TryAdvanceRiteResult(out string via, out string reason)
        {
            via = null;
            reason = "no_interop";
            return false;
        }

        public static bool TrySelectGoldDice(out string detail)
        {
            detail = "no_interop";
            return false;
        }

        public static bool TryConfirmGoldDice(out string detail)
        {
            detail = "no_interop";
            return false;
        }

        public static bool TryCancelGoldDice(out string detail)
        {
            detail = "no_interop";
            return false;
        }
#endif
    }
}
