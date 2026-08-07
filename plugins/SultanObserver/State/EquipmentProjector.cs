using System;
using System.Collections.Generic;

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Projects character equipment slots / equipped items and shared equip eligibility helpers.
    /// Runtime Card.equips is the authority for "worn on whom"; catalog tag "已装备" is NOT ownership.
    /// </summary>
    public static class EquipmentProjector
    {
        public static readonly string[] KnownSlotTypes = { "武器", "服装", "饰品", "动物", "宝石" };

        /// <summary>Core combat/social attrs that equipment commonly modifies.</summary>
        public static readonly string[] CombatAttrKeys =
        {
            "智慧", "社交", "魅力", "体魄", "战斗", "隐匿", "魔力"
        };

        public static bool IsCharacterType(string type)
        {
            if (string.IsNullOrWhiteSpace(type)) return false;
            var t = type.Trim().ToLowerInvariant();
            return t is "char" or "character" or "follower";
        }

        public static bool IsItemType(string type)
        {
            if (string.IsNullOrWhiteSpace(type)) return false;
            return string.Equals(type.Trim(), "item", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Normalize runtime/catalog slot labels to stable Chinese slot ids.
        /// Game runtime often emits weapon/cloth/accessory while catalog uses 武器/服装/饰品.
        /// </summary>
        public static string NormalizeSlotType(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            var normalized = SceneText.Normalize(raw);
            if (string.IsNullOrWhiteSpace(normalized)) return null;
            var lower = normalized.ToLowerInvariant();
            if (normalized.Contains("武器") || lower is "weapon" or "weapons") return "武器";
            if (normalized.Contains("服装") || normalized.Contains("衣服")
                || lower is "cloth" or "clothing" or "clothes" or "armor")
            {
                return "服装";
            }
            if (normalized.Contains("饰品") || normalized.Contains("饰")
                || lower is "accessory" or "accessories" or "ornament")
            {
                return "饰品";
            }
            if (normalized.Contains("动物") || lower is "animal" or "animals") return "动物";
            if (normalized.Contains("宝石") || lower is "jewel" or "jewelry" or "gem") return "宝石";
            return normalized;
        }

        public static bool SlotTypesCompatible(IEnumerable<string> characterSlots, string itemSlotType)
        {
            var item = NormalizeSlotType(itemSlotType);
            if (string.IsNullOrWhiteSpace(item)) return true;
            if (characterSlots == null) return true;
            var any = false;
            foreach (var slot in characterSlots)
            {
                any = true;
                if (string.Equals(NormalizeSlotType(slot), item, StringComparison.Ordinal)) return true;
            }
            // Empty character slot list: do not hard-block; let CardEquip decide.
            return !any;
        }

        public static string ResolveItemSlotType(IDictionary<string, object> tags, string title = null)
        {
            if (tags != null)
            {
                foreach (var slot in KnownSlotTypes)
                {
                    if (TryTag(tags, slot, out var value) && value > 0) return slot;
                }
                foreach (var pair in tags)
                {
                    var mapped = NormalizeSlotType(pair.Key);
                    if (mapped != null
                        && Array.IndexOf(KnownSlotTypes, mapped) >= 0
                        && TryTag(tags, pair.Key, out var value)
                        && value > 0)
                    {
                        return mapped;
                    }
                }
            }

            if (!string.IsNullOrWhiteSpace(title))
            {
                return NormalizeSlotType(title);
            }

            return null;
        }

        public static bool TryTag(IDictionary<string, object> tags, string key, out int value)
        {
            value = 0;
            if (tags == null || string.IsNullOrWhiteSpace(key)) return false;
            if (!tags.TryGetValue(key, out var raw) || raw == null) return false;
            if (raw is int i)
            {
                value = i;
                return true;
            }
            if (raw is long l && l >= int.MinValue && l <= int.MaxValue)
            {
                value = (int)l;
                return true;
            }
            return int.TryParse(raw.ToString(), out value);
        }

        public static List<string> CatalogEquipSlotTypes(int cardId)
        {
            var catalog = ConfigCatalog.Instance.GetCard(cardId);
            if (catalog == null) return new List<string>();
            if (!catalog.TryGetValue("equipSlotTypes", out var raw) || raw == null)
            {
                return new List<string>();
            }

            var result = new List<string>();
            if (raw is List<string> list)
            {
                foreach (var item in list)
                {
                    var slot = NormalizeSlotType(item);
                    if (!string.IsNullOrWhiteSpace(slot) && !result.Contains(slot)) result.Add(slot);
                }
                return result;
            }

            if (raw is IEnumerable<object> objects)
            {
                foreach (var item in objects)
                {
                    var slot = NormalizeSlotType(item?.ToString());
                    if (!string.IsNullOrWhiteSpace(slot) && !result.Contains(slot)) result.Add(slot);
                }
            }
            return result;
        }

        public static void AttachEquipFields(Dictionary<string, object> summary, int cardId, string type)
        {
            if (summary == null) return;
            if (!IsCharacterType(type) && !IsCharacterType(summary.TryGetValue("type", out var t) ? t?.ToString() : null))
            {
                return;
            }

            var slots = CatalogEquipSlotTypes(cardId);
            if (slots.Count > 0)
            {
                summary["equipSlotTypes"] = slots;
            }
        }

        /// <summary>
        /// Agent-facing equipped item row: catalog title/text/tags + runtime tag overlay.
        /// Incomplete runtime tags (own/weapon_keep) must not wipe catalog attrs like 魅力.
        /// </summary>
        public static Dictionary<string, object> BuildEquippedRow(
            int cardId,
            string customName = null,
            string runtimeType = "item",
            int? uid = null,
            int? rare = null,
            IEnumerable<KeyValuePair<string, int>> runtimeTags = null)
        {
            var row = new Dictionary<string, object>
            {
                ["id"] = cardId,
                ["name"] = ConfigCatalog.Instance.ResolveCardName(cardId, customName, runtimeType),
                ["type"] = runtimeType ?? "item"
            };
            if (uid.HasValue) row["uid"] = uid.Value;
            if (rare.HasValue) row["rare"] = rare.Value;

            try
            {
                var summary = ConfigCatalog.Instance.BuildCardSummary(cardId, customName, runtimeType);
                if (runtimeTags != null)
                {
                    CardSummaryProjector.MergeTags(summary, runtimeTags);
                }

                Dictionary<string, object> tags = null;
                if (summary.TryGetValue("tags", out var tagObj) && tagObj is Dictionary<string, object> dict)
                {
                    tags = dict;
                }

                var title = summary.TryGetValue("title", out var titleObj) ? titleObj?.ToString() : null;
                var slotType = ResolveItemSlotType(tags, title);
                if (summary.TryGetValue("name", out var nameObj) && nameObj != null)
                {
                    row["name"] = nameObj.ToString();
                }
                if (summary.TryGetValue("type", out var typeObj) && typeObj != null)
                {
                    row["type"] = typeObj.ToString();
                }
                if (!rare.HasValue && summary.TryGetValue("rare", out var rareObj) && rareObj != null)
                {
                    row["rare"] = rareObj;
                }
                if (!string.IsNullOrWhiteSpace(slotType)) row["slotType"] = slotType;
                if (!string.IsNullOrWhiteSpace(title)) row["title"] = title;
                if (summary.TryGetValue("text", out var textObj) && textObj != null)
                {
                    var text = SceneText.Normalize(textObj.ToString());
                    if (!string.IsNullOrWhiteSpace(text)) row["text"] = text;
                }
                if (tags != null && tags.Count > 0) row["tags"] = tags;

                var attrBonus = ExtractAttrBonus(tags);
                if (attrBonus.Count > 0) row["attrBonus"] = attrBonus;
            }
            catch
            {
                // Keep minimal identity row if catalog/tag merge fails.
                if (runtimeTags != null)
                {
                    try
                    {
                        var fallback = new Dictionary<string, object>();
                        CardSummaryProjector.MergeTags(fallback, runtimeTags);
                        if (fallback.TryGetValue("tags", out var tagObj)
                            && tagObj is Dictionary<string, object> tags
                            && tags.Count > 0)
                        {
                            row["tags"] = tags;
                            var slotType = ResolveItemSlotType(tags);
                            if (!string.IsNullOrWhiteSpace(slotType)) row["slotType"] = slotType;
                            var attrBonus = ExtractAttrBonus(tags);
                            if (attrBonus.Count > 0) row["attrBonus"] = attrBonus;
                        }
                    }
                    catch
                    {
                        // optional
                    }
                }
            }

            return row;
        }

        public static Dictionary<string, object> ExtractAttrBonus(IDictionary<string, object> tags)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            if (tags == null) return result;
            foreach (var key in CombatAttrKeys)
            {
                if (TryTag(tags, key, out var value) && value != 0)
                {
                    result[key] = value;
                }
            }
            return result;
        }

        public static Dictionary<string, object> AggregateEquipBonus(
            IEnumerable<Dictionary<string, object>> equipped)
        {
            var totals = new SortedDictionary<string, int>(StringComparer.Ordinal);
            if (equipped == null)
            {
                return new Dictionary<string, object>(StringComparer.Ordinal);
            }

            foreach (var row in equipped)
            {
                if (row == null) continue;
                IDictionary<string, object> source = null;
                if (row.TryGetValue("attrBonus", out var ab)
                    && ab is Dictionary<string, object> abDict)
                {
                    source = abDict;
                }
                else if (row.TryGetValue("tags", out var tagObj)
                         && tagObj is Dictionary<string, object> tags)
                {
                    source = tags;
                }
                if (source == null) continue;

                foreach (var key in CombatAttrKeys)
                {
                    if (!TryTag(source, key, out var value) || value == 0) continue;
                    totals[key] = totals.TryGetValue(key, out var cur) ? cur + value : value;
                }
            }

            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var pair in totals)
            {
                result[pair.Key] = pair.Value;
            }
            return result;
        }

        /// <summary>
        /// Attach character catalog/runtime tags plus equipped list / equipBonus summary.
        /// </summary>
        public static void AttachEquippedInsight(
            Dictionary<string, object> target,
            int cardId,
            string customName,
            string runtimeType,
            IList<Dictionary<string, object>> equipped,
            IEnumerable<KeyValuePair<string, int>> runtimeTags = null,
            IEnumerable<string> equipSlotTypes = null)
        {
            if (target == null) return;

            var equippedList = equipped ?? new List<Dictionary<string, object>>();
            target["equipped"] = equippedList;
            target["equippedCount"] = equippedList.Count;

            try
            {
                var bonus = AggregateEquipBonus(equippedList);
                if (bonus.Count > 0) target["equipBonus"] = bonus;
                else target.Remove("equipBonus");
            }
            catch
            {
                target.Remove("equipBonus");
            }

            if (equipSlotTypes != null)
            {
                var slots = new List<string>();
                foreach (var slot in equipSlotTypes)
                {
                    var normalized = NormalizeSlotType(slot);
                    if (!string.IsNullOrWhiteSpace(normalized) && !slots.Contains(normalized))
                    {
                        slots.Add(normalized);
                    }
                }
                if (slots.Count > 0) target["equipSlotTypes"] = slots;
            }

            try
            {
                var dossier = ConfigCatalog.Instance.BuildCardSummary(cardId, customName, runtimeType);
                if (runtimeTags != null)
                {
                    CardSummaryProjector.MergeTags(dossier, runtimeTags);
                }
                if (dossier.TryGetValue("tags", out var tags)
                    && tags is Dictionary<string, object> tagDict
                    && tagDict.Count > 0)
                {
                    target["tags"] = tagDict;
                }

                if (!target.ContainsKey("equipSlotTypes")
                    && dossier.TryGetValue("equipSlotTypes", out var catalogSlots)
                    && catalogSlots is List<string> list
                    && list.Count > 0)
                {
                    target["equipSlotTypes"] = list;
                }
            }
            catch
            {
                // Catalog/tag enrichment is best-effort; keep equipped[] above.
            }
        }

#if GAME_INTEROP
        public static List<string> RuntimeEquipSlotTypes(Card card)
        {
            var result = new List<string>();
            if (card == null) return result;
            try
            {
                var slots = card.equip_slots;
                if (slots != null)
                {
                    for (var i = 0; i < slots.Count; i++)
                    {
                        var slot = NormalizeSlotType(slots[i]);
                        if (!string.IsNullOrWhiteSpace(slot) && !result.Contains(slot)) result.Add(slot);
                    }
                }
            }
            catch
            {
                // optional IL2CPP access
            }

            if (result.Count == 0)
            {
                result.AddRange(CatalogEquipSlotTypes(card.id));
            }
            return result;
        }

        public static List<Dictionary<string, object>> RuntimeEquipped(Card character)
        {
            var result = new List<Dictionary<string, object>>();
            if (character == null) return result;
            try
            {
                var equips = character.equips;
                if (equips == null) return result;
                for (var i = 0; i < equips.Count; i++)
                {
                    var item = equips[i];
                    if (item == null) continue;
                    result.Add(ToEquippedRow(item));
                }
            }
            catch
            {
                // optional IL2CPP access
            }
            return result;
        }

        public static Dictionary<string, object> ToEquippedRow(Card item)
        {
            if (item == null) return new Dictionary<string, object>();
            try
            {
                var runtimeTags = new List<KeyValuePair<string, int>>();
                try
                {
                    if (item.tag != null)
                    {
                        foreach (var pair in item.tag)
                        {
                            if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value == 0) continue;
                            runtimeTags.Add(new KeyValuePair<string, int>(pair.Key, pair.Value));
                        }
                    }
                }
                catch
                {
                    // optional
                }

                int? rare = null;
                try { rare = item.Rare; } catch { /* optional */ }
                return BuildEquippedRow(
                    item.id,
                    item.custom_name,
                    item.Type,
                    item.uid,
                    rare,
                    runtimeTags);
            }
            catch
            {
                try
                {
                    return new Dictionary<string, object>
                    {
                        ["uid"] = item.uid,
                        ["id"] = item.id,
                        ["name"] = ConfigCatalog.Instance.ResolveCardName(item.id, item.custom_name, item.Type),
                        ["type"] = item.Type ?? "item"
                    };
                }
                catch
                {
                    return new Dictionary<string, object>();
                }
            }
        }

        public static Dictionary<string, object> RuntimeTags(Card card)
        {
            var tags = new Dictionary<string, object>(StringComparer.Ordinal);
            if (card?.tag == null) return tags;
            try
            {
                foreach (var pair in card.tag)
                {
                    if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value == 0) continue;
                    tags[CardSummaryProjector.NormalizeTagKey(pair.Key)] = pair.Value;
                }
            }
            catch
            {
                // optional
            }
            return tags;
        }

        public static bool HasEquipmentTag(Card item)
        {
            if (item == null) return false;
            var tags = RuntimeTags(item);
            if (TryTag(tags, "装备", out var value) && value > 0) return true;

            // Catalog fallback (runtime tag may be incomplete).
            var catalog = ConfigCatalog.Instance.GetCard(item.id);
            if (catalog != null
                && catalog.TryGetValue("tags", out var raw)
                && raw is Dictionary<string, object> catalogTags
                && TryTag(catalogTags, "装备", out var catalogValue)
                && catalogValue > 0)
            {
                return true;
            }
            return ResolveItemSlotType(tags) != null;
        }

        public static bool IsEquippableCharacter(Card character)
        {
            if (character == null || !IsCharacterType(character.Type)) return false;
            var tags = RuntimeTags(character);
            if (HasOwnershipTag(tags)) return true;

            var catalog = ConfigCatalog.Instance.GetCard(character.id);
            if (catalog?.TryGetValue("tags", out var raw) == true
                && raw is Dictionary<string, object> catalogTags
                && HasOwnershipTag(catalogTags))
            {
                return true;
            }

            // Owned inventory chars sit in bag 0 (hand/bag). Rite NPCs should not.
            try
            {
                if (character.bag == 0 && RuntimeEquipSlotTypes(character).Count > 0)
                {
                    return true;
                }
            }
            catch
            {
                // optional
            }
            return false;
        }

        private static bool HasOwnershipTag(IDictionary<string, object> tags)
        {
            if (tags == null) return false;
            if (TryTag(tags, "已拥有", out var owned) && owned > 0) return true;
            if (TryTag(tags, "主角", out var hero) && hero > 0) return true;
            if (TryTag(tags, "追随者", out var follower) && follower > 0) return true;
            if (TryTag(tags, "adherent", out var adherent) && adherent > 0) return true;
            if (TryTag(tags, "own", out var own) && own > 0) return true;
            if (TryTag(tags, "妻子", out var wife) && wife > 0) return true;
            return false;
        }

        public static string ResolveItemSlotType(Card item)
        {
            if (item == null) return null;
            var tags = RuntimeTags(item);
            var slot = ResolveItemSlotType(tags);
            if (!string.IsNullOrWhiteSpace(slot)) return slot;

            var summary = ConfigCatalog.Instance.BuildCardSummary(item.id, item.custom_name, item.Type);
            return ResolveItemSlotType(
                summary.TryGetValue("tags", out var tagObj) && tagObj is Dictionary<string, object> dict
                    ? dict
                    : null,
                summary.TryGetValue("title", out var title) ? title?.ToString() : null);
        }

        public static Dictionary<string, object> FindEquippedOccupant(Card character, string slotType)
        {
            if (character == null || string.IsNullOrWhiteSpace(slotType)) return null;
            var want = NormalizeSlotType(slotType);
            foreach (var row in RuntimeEquipped(character))
            {
                if (row.TryGetValue("slotType", out var raw)
                    && string.Equals(NormalizeSlotType(raw?.ToString()), want, StringComparison.Ordinal))
                {
                    return row;
                }
            }
            return null;
        }

        public static bool CharacterHasItem(Card character, int itemUid)
        {
            if (character == null) return false;
            foreach (var row in RuntimeEquipped(character))
            {
                if (row.TryGetValue("uid", out var raw)
                    && raw is int uid
                    && uid == itemUid)
                {
                    return true;
                }
                if (raw != null && int.TryParse(raw.ToString(), out var parsed) && parsed == itemUid)
                {
                    return true;
                }
            }
            return false;
        }

        public static Card FindOwnerOfItem(int itemUid)
        {
            var player = GameBindings.Player;
            if (player?.cards == null) return null;
            for (var i = 0; i < player.cards.Count; i++)
            {
                var card = player.cards[i];
                if (card == null || !IsCharacterType(card.Type)) continue;
                if (CharacterHasItem(card, itemUid)) return card;
            }
            return null;
        }

        public static void AttachRuntimeEquipFields(Dictionary<string, object> target, Card card)
        {
            if (target == null || card == null) return;

            // Must never throw into StateProjector — cardsAll projection has no try/catch.
            try
            {
                if (!IsCharacterType(card.Type)) return;

                var runtimeTags = new List<KeyValuePair<string, int>>();
                try
                {
                    if (card.tag != null)
                    {
                        foreach (var pair in card.tag)
                        {
                            if (string.IsNullOrWhiteSpace(pair.Key) || pair.Value == 0) continue;
                            runtimeTags.Add(new KeyValuePair<string, int>(pair.Key, pair.Value));
                        }
                    }
                }
                catch
                {
                    // optional IL2CPP tag access
                }

                AttachEquippedInsight(
                    target,
                    card.id,
                    card.custom_name,
                    card.Type,
                    RuntimeEquipped(card),
                    runtimeTags,
                    RuntimeEquipSlotTypes(card));
            }
            catch
            {
                try
                {
                    // Minimal fallback so agents still see wear relations.
                    var slots = RuntimeEquipSlotTypes(card);
                    if (slots.Count > 0) target["equipSlotTypes"] = slots;
                    var equipped = RuntimeEquipped(card);
                    target["equipped"] = equipped;
                    target["equippedCount"] = equipped.Count;
                }
                catch
                {
                    // optional
                }
            }
        }
#endif
    }
}
