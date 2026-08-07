using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Builds agent-readable descriptions of the open rite panel slots.
    /// Slot requirements come from CardSlotController.Slot (RiteNode.Slot).
    /// </summary>
    public static class RiteSlotProjector
    {
#if GAME_INTEROP
        public static Dictionary<string, object> BuildCurrentRiteSnapshot()
        {
            var panel = GameBindings.RitePanel;
            if (!GameBindings.IsUiActive(panel) || panel.Current == null)
            {
                return null;
            }

            var rite = panel.Current;
            var name = ConfigCatalog.Instance.ResolveRiteName(rite.id, rite.custom_name);
            bool canConfirm = false;
            try { canConfirm = panel.CheckConfirm(); } catch { /* optional */ }

            var slots = BuildSlotList(panel, rite.id);
            return new Dictionary<string, object>
            {
                ["uid"] = rite.uid,
                ["id"] = rite.id,
                ["name"] = name,
                ["started"] = rite.start,
                ["canConfirm"] = canConfirm,
                ["slotCount"] = slots.Count,
                ["slots"] = slots,
                ["hint"] =
                    "Match hand card uid to a free slot via place_card_on_rite; read each slot.text/condition/costMin/cardSummary before placing. "
                    + "Stackable items (金币) auto-split to costMin unless you pass count. "
                    + "Filled slots expose cardSummary and can be inspected via inspect_card(uid) without closing the panel."
            };
        }

        public static List<Dictionary<string, object>> BuildSlotList(
            RitePanelShowController panel,
            int riteId)
        {
            var slots = new List<Dictionary<string, object>>();
            if (panel?.Slots == null) return slots;

            var configSlots = ReadConfigSlots(riteId);
            for (var i = 0; i < panel.Slots.Count; i++)
            {
                var slotUi = panel.Slots[i];
                if (slotUi == null) continue;
                var index = i;
                try { index = slotUi.Index; } catch { /* keep i */ }

                Card card = null;
                try { card = slotUi.Current ?? slotUi.current; } catch { /* optional */ }

                string text = null;
                string guid = null;
                var isKey = 0;
                var isEmpty = false;
                var isEnemy = false;
                string conditionType = null;
                string conditionSummary = null;
                try
                {
                    var spec = slotUi.Slot;
                    if (spec != null)
                    {
                        text = SceneText.Normalize(spec.text);
                        guid = spec.guid;
                        isKey = spec.is_key;
                        isEmpty = spec.is_empty;
                        isEnemy = spec.is_enemy;
                        SummarizeCondition(spec.condition, out conditionType, out conditionSummary);
                    }
                }
                catch
                {
                    // optional
                }

                var slotKey = "s" + (index + 1);
                if (configSlots != null)
                {
                    if ((string.IsNullOrEmpty(text) || string.IsNullOrEmpty(conditionSummary))
                        && configSlots.TryGetValue(slotKey, out var cfg)
                        && cfg is Dictionary<string, object> cfgMap)
                    {
                        if (string.IsNullOrEmpty(text)) text = String(cfgMap, "text");
                        if (string.IsNullOrEmpty(conditionType)) conditionType = String(cfgMap, "conditionType");
                        if (string.IsNullOrEmpty(conditionSummary)) conditionSummary = String(cfgMap, "condition");
                    }
                }

                if (string.IsNullOrEmpty(text))
                {
                    text = !string.IsNullOrEmpty(conditionType)
                        ? "Requires " + conditionType + " card"
                        : "Rite slot " + index;
                }

                var costMin = StackPlaceHelper.ParseCostMin(conditionSummary, text);
                var requiredRare = ParseRequiredRare(conditionSummary, text);
                var row = new Dictionary<string, object>
                {
                    ["index"] = index,
                    ["slotKey"] = slotKey,
                    ["guid"] = guid,
                    ["text"] = text,
                    ["isKey"] = isKey,
                    ["isEmpty"] = isEmpty,
                    ["isEnemy"] = isEnemy,
                    ["conditionType"] = conditionType,
                    ["condition"] = conditionSummary,
                    ["requiredRare"] = requiredRare.HasValue ? (object)requiredRare.Value : null,
                    ["requiredTier"] = requiredRare.HasValue ? FormatTier(requiredRare.Value) : null,
                    ["occupied"] = card != null,
                    ["cardUid"] = card != null ? card.uid : null,
                    ["cardId"] = card != null ? card.id : null,
                    ["cardName"] = card != null
                        ? ConfigCatalog.Instance.ResolveCardName(card.id, card.custom_name, card.Type)
                        : null,
                    ["acceptsOp"] = card != null ? "cancel_card_placement" : "place_card_on_rite"
                };
                if (costMin.HasValue)
                {
                    row["costMin"] = costMin.Value;
                    row["placeCountHint"] = costMin.Value;
                }
                if (card != null)
                {
                    var summary = CardSummaryProjector.Build(card);
                    row["cardSummary"] = summary;
                    try { row["cardCount"] = card.count; } catch { /* optional */ }
                }
                row["hint"] = costMin.HasValue
                    ? "Stackable costs: place only costMin (use place_card_on_rite.count or auto-split); do not dump the whole 金币 stack."
                    : "Match hand card uid to a free slot; stackable item cards can set count to spend a partial stack.";
                slots.Add(row);
            }

            return slots;
        }

        public static string FormatTier(int rare)
        {
            switch (rare)
            {
                case 1: return "石(1)";
                case 2: return "铜(2)";
                case 3: return "银(3)";
                case 4: return "金(4)";
                default: return null;
            }
        }

        /// <summary>
        /// Closed-map slot schema from ConfigCatalog.cards_slot (no panel required).
        /// </summary>
        public static List<Dictionary<string, object>> BuildConfigSlotPreview(int riteId)
        {
            var slots = new List<Dictionary<string, object>>();
            var configSlots = ReadConfigSlots(riteId);
            if (configSlots == null || configSlots.Count == 0) return slots;

            foreach (var pair in configSlots)
            {
                if (pair.Value is not Dictionary<string, object> cfgMap) continue;
                var slotKey = (pair.Key ?? "").Trim();
                if (string.IsNullOrEmpty(slotKey)) continue;
                var index = ParseSlotKeyIndex(slotKey);
                var text = String(cfgMap, "text");
                var conditionType = String(cfgMap, "conditionType");
                var conditionSummary = String(cfgMap, "condition");
                if (string.IsNullOrEmpty(text))
                {
                    text = !string.IsNullOrEmpty(conditionType)
                        ? "Requires " + conditionType + " card"
                        : "Rite slot " + index;
                }
                var costMin = StackPlaceHelper.ParseCostMin(conditionSummary, text);
                var requiredRare = ParseRequiredRare(conditionSummary, text);
                var isKey = 0;
                if (cfgMap.TryGetValue("is_key", out var keyObj) && keyObj != null)
                {
                    int.TryParse(keyObj.ToString(), out isKey);
                }
                var row = new Dictionary<string, object>
                {
                    ["index"] = index,
                    ["slotKey"] = slotKey.StartsWith("s", StringComparison.OrdinalIgnoreCase)
                        ? slotKey.ToLowerInvariant()
                        : "s" + (index + 1),
                    ["text"] = text,
                    ["isKey"] = isKey,
                    ["conditionType"] = conditionType,
                    ["condition"] = conditionSummary,
                    ["requiredRare"] = requiredRare.HasValue ? (object)requiredRare.Value : null,
                    ["requiredTier"] = requiredRare.HasValue ? FormatTier(requiredRare.Value) : null
                };
                if (costMin.HasValue)
                {
                    row["costMin"] = costMin.Value;
                }
                slots.Add(row);
            }

            slots.Sort((a, b) =>
            {
                var ia = a.TryGetValue("index", out var ao) && ao is int ai ? ai : 0;
                var ib = b.TryGetValue("index", out var bo) && bo is int bi ? bi : 0;
                return ia.CompareTo(ib);
            });
            return slots;
        }

        /// <summary>
        /// Heuristic hand↔slot matches for closed-map ranking (not IsCardSatisified).
        /// Attaches slotPreview / handMatchCount / handMatchHints onto <paramref name="target"/>.
        /// </summary>
        public static void AttachClosedRiteMatchFields(
            Dictionary<string, object> target,
            int riteId,
            IList<Dictionary<string, object>> handCards)
        {
            if (target == null) return;
            var preview = BuildConfigSlotPreview(riteId);
            target["slotPreview"] = preview;
            var hints = BuildHandMatchHints(preview, handCards);
            // Count slots that have ≥1 heuristic hand match (for open_rite ranking).
            target["handMatchCount"] = hints.Count;
            target["handMatchHints"] = hints;
        }

        public static List<Dictionary<string, object>> BuildHandMatchHints(
            IList<Dictionary<string, object>> slotPreview,
            IList<Dictionary<string, object>> handCards)
        {
            var hints = new List<Dictionary<string, object>>();
            if (slotPreview == null || slotPreview.Count == 0 || handCards == null || handCards.Count == 0)
            {
                return hints;
            }

            const int maxPerSlot = 3;
            foreach (var slot in slotPreview)
            {
                if (slot == null) continue;
                var index = 0;
                if (slot.TryGetValue("index", out var indexObj))
                {
                    int.TryParse(indexObj?.ToString(), out index);
                }
                var conditionType = String(slot, "conditionType");
                var condition = String(slot, "condition");
                var text = String(slot, "text");
                int? requiredRare = null;
                if (slot.TryGetValue("requiredRare", out var rareObj) && rareObj != null
                    && int.TryParse(rareObj.ToString(), out var rr))
                {
                    requiredRare = rr;
                }

                var matched = new List<object>();
                foreach (var card in handCards)
                {
                    if (card == null || matched.Count >= maxPerSlot) continue;
                    if (!card.TryGetValue("uid", out var uidObj) || uidObj == null) continue;
                    if (!HeuristicCardMatchesSlot(card, conditionType, condition, text, requiredRare))
                    {
                        continue;
                    }
                    matched.Add(uidObj is int uidInt ? uidInt : Convert.ToInt32(uidObj));
                }

                if (matched.Count == 0) continue;
                hints.Add(new Dictionary<string, object>
                {
                    ["slotIndex"] = index,
                    ["slotKey"] = String(slot, "slotKey") ?? ("s" + (index + 1)),
                    ["conditionType"] = conditionType,
                    ["requiredRare"] = requiredRare.HasValue ? (object)requiredRare.Value : null,
                    ["matchingCardUids"] = matched,
                    ["matchKind"] = "type+rare"
                });
            }

            return hints;
        }

        private static bool HeuristicCardMatchesSlot(
            Dictionary<string, object> card,
            string conditionType,
            string condition,
            string text,
            int? requiredRare)
        {
            var cardType = String(card, "type") ?? "";
            var cardName = String(card, "name") ?? "";
            int? cardRare = null;
            if (card.TryGetValue("rare", out var rareObj) && rareObj != null
                && int.TryParse(rareObj.ToString(), out var cr)
                && cr >= 1 && cr <= 4)
            {
                cardRare = cr;
            }

            var typeNeedle = (conditionType ?? "").Trim().ToLowerInvariant();
            var blob = ((condition ?? "") + " " + (text ?? "")).ToLowerInvariant();
            var typeOk = true;
            if (!string.IsNullOrEmpty(typeNeedle))
            {
                typeOk = CardTypeMatches(cardType, cardName, typeNeedle, blob);
            }
            else if (blob.Contains("sudan") || blob.Contains("苏丹")
                     || blob.Contains("杀戮") || blob.Contains("纵欲")
                     || blob.Contains("征服") || blob.Contains("奢靡"))
            {
                typeOk = CardTypeMatches(cardType, cardName, "sudan", blob);
            }
            else if (blob.Contains("金币") || blob.Contains("gold"))
            {
                typeOk = cardName.IndexOf("金币", StringComparison.OrdinalIgnoreCase) >= 0
                         || cardType.IndexOf("item", StringComparison.OrdinalIgnoreCase) >= 0;
            }

            if (!typeOk) return false;
            if (!requiredRare.HasValue || !cardRare.HasValue) return true;
            // Exact tier match for closed-map hints; precise acceptance is place_* after open.
            return cardRare.Value == requiredRare.Value;
        }

        private static bool CardTypeMatches(
            string cardType,
            string cardName,
            string conditionType,
            string blob)
        {
            var t = (cardType ?? "").ToLowerInvariant();
            var n = (cardName ?? "").ToLowerInvariant();
            var c = (conditionType ?? "").ToLowerInvariant();
            if (c.Contains("sudan") || c == "苏丹")
            {
                return t.Contains("sudan")
                       || n.Contains("杀戮") || n.Contains("纵欲")
                       || n.Contains("征服") || n.Contains("奢靡");
            }
            if (c.Contains("char") || c.Contains("follower") || c.Contains("人物") || c.Contains("角色"))
            {
                return t.Contains("char") || t.Contains("follower") || t.Contains("person");
            }
            if (c.Contains("item") || c.Contains("道具") || c.Contains("物品"))
            {
                return t.Contains("item") || n.Contains("金币");
            }
            if (c.Contains("cost") || blob.Contains("金币"))
            {
                return n.Contains("金币") || t.Contains("item");
            }
            // Unknown conditionType: weak name/type overlap only.
            return !string.IsNullOrEmpty(c) && (t.Contains(c) || n.Contains(c));
        }

        private static int ParseSlotKeyIndex(string slotKey)
        {
            if (string.IsNullOrEmpty(slotKey)) return 0;
            var digits = Regex.Match(slotKey, @"(\d+)");
            if (digits.Success && int.TryParse(digits.Groups[1].Value, out var n))
            {
                // Config keys are usually s1..sN (1-based). UI slot index is often 0-based.
                // Keep catalog number-1 when key looks like sN and N>=1.
                if (slotKey.StartsWith("s", StringComparison.OrdinalIgnoreCase) && n >= 1)
                {
                    return n - 1;
                }
                return n;
            }
            return 0;
        }

        private static int? ParseRequiredRare(string condition, string text)
        {
            var combined = (condition ?? "") + " " + (text ?? "");
            if (string.IsNullOrWhiteSpace(combined)) return null;

            var keyed = Regex.Match(
                combined,
                @"(?:requiredRare|minRare|rare|rarity|tier|品级|品阶)\s*[""']?\s*[:=：]?\s*[""']?([1-4])",
                RegexOptions.IgnoreCase);
            if (keyed.Success && int.TryParse(keyed.Groups[1].Value, out var parsed))
            {
                return parsed;
            }

            // f:rare-s1.rare<=:0 or JSON "f:rare-s1.rare<=":0 → max rare = N+1.
            var formula = Regex.Match(
                combined,
                @"f:rare[^\s""]*\.rare\s*<=\s*""?\s*:?\s*(-?\d+)",
                RegexOptions.IgnoreCase);
            if (formula.Success && int.TryParse(formula.Groups[1].Value, out var ceiling))
            {
                var maxRare = ceiling + 1;
                if (maxRare >= 1 && maxRare <= 4) return maxRare;
            }

            if (Regex.IsMatch(combined, @"(?:岩石|石)(?:品级|品阶|阶|级)|\bstone(?:\s+tier)?\b", RegexOptions.IgnoreCase)) return 1;
            if (Regex.IsMatch(combined, @"(?:青铜|铜)(?:品级|品阶|阶|级)|\b(?:copper|bronze)(?:\s+tier)?\b", RegexOptions.IgnoreCase)) return 2;
            if (Regex.IsMatch(combined, @"(?:白银|银)(?:品级|品阶|阶|级)|\bsilver(?:\s+tier)?\b", RegexOptions.IgnoreCase)) return 3;
            if (Regex.IsMatch(combined, @"(?:黄金|金)(?:品级|品阶|阶|级)|\bgold(?:en)?(?:\s+tier)?\b", RegexOptions.IgnoreCase)) return 4;
            return null;
        }

        public static int? GetSlotCardUid(CardSlotController slot)
        {
            if (slot == null) return null;
            try
            {
                var card = slot.Current ?? slot.current;
                return card != null ? card.uid : (int?)null;
            }
            catch
            {
                return null;
            }
        }

        private static Dictionary<string, object> ReadConfigSlots(int riteId)
        {
            try
            {
                var rite = ConfigCatalog.Instance.GetRite(riteId);
                if (rite != null
                    && rite.TryGetValue("cards_slot", out var raw)
                    && raw is Dictionary<string, object> map)
                {
                    return map;
                }
            }
            catch
            {
                // optional
            }
            return null;
        }

        private static void SummarizeCondition(
            ICondition condition,
            out string conditionType,
            out string conditionSummary)
        {
            conditionType = null;
            conditionSummary = null;
            if (condition == null) return;
            try
            {
                // Common ICondition implementations expose a string "type" (sudan/char/item).
                var typeProp = condition.GetType().GetProperty("type")
                               ?? condition.GetType().GetProperty("Type");
                if (typeProp != null)
                {
                    conditionType = typeProp.GetValue(condition)?.ToString();
                }
            }
            catch
            {
                // optional
            }

            try
            {
                conditionSummary = SceneText.Normalize(condition.ToString());
                if (!string.IsNullOrEmpty(conditionSummary)
                    && conditionSummary.IndexOf("ICondition", StringComparison.OrdinalIgnoreCase) >= 0
                    && conditionSummary.Length < 24)
                {
                    conditionSummary = conditionType;
                }
            }
            catch
            {
                conditionSummary = conditionType;
            }
        }

        private static string String(Dictionary<string, object> map, string key)
        {
            return map != null && map.TryGetValue(key, out var value)
                ? SceneText.Normalize(value?.ToString())
                : null;
        }
#else
        public static Dictionary<string, object> BuildCurrentRiteSnapshot() => null;

        public static List<Dictionary<string, object>> BuildConfigSlotPreview(int riteId)
            => new List<Dictionary<string, object>>();

        public static void AttachClosedRiteMatchFields(
            Dictionary<string, object> target,
            int riteId,
            IList<Dictionary<string, object>> handCards)
        {
            if (target == null) return;
            target["slotPreview"] = new List<Dictionary<string, object>>();
            target["handMatchCount"] = 0;
            target["handMatchHints"] = new List<Dictionary<string, object>>();
        }

        public static string FormatTier(int rare) => null;
#endif

        /// <summary>
        /// Compact occupancy signature for scene-diff / telemetry (works without game interop).
        /// </summary>
        public static string SlotSignature(IList<Dictionary<string, object>> slots)
        {
            if (slots == null || slots.Count == 0) return "[]";
            var parts = new List<string>(slots.Count);
            foreach (var slot in slots)
            {
                if (slot == null) continue;
                parts.Add(string.Join(":",
                    slot.TryGetValue("index", out var index) ? index : "",
                    slot.TryGetValue("occupied", out var occupied) ? occupied : "",
                    slot.TryGetValue("cardUid", out var uid) ? uid : "",
                    slot.TryGetValue("text", out var text) ? text : ""));
            }
            return "[" + string.Join("|", parts) + "]";
        }
    }
}
