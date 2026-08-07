using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Formatting = Newtonsoft.Json.Formatting;
#if GAME_INTEROP
using UnityEngine;
#endif

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Lightweight index over StreamingAssets/config for stable IDs and display names.
    /// </summary>
    public sealed class ConfigCatalog
    {
        private static ConfigCatalog _instance;
        private readonly Dictionary<string, object> _summary = new Dictionary<string, object>();
        private readonly Dictionary<int, Dictionary<string, object>> _cards =
            new Dictionary<int, Dictionary<string, object>>();
        private readonly Dictionary<int, Dictionary<string, object>> _rites =
            new Dictionary<int, Dictionary<string, object>>();
        private bool _loaded;
        private string _configRoot;
        private string _loadError;

        public static ConfigCatalog Instance => _instance ??= new ConfigCatalog();

        public Dictionary<string, object> GetSummary()
        {
            EnsureLoaded();
            return _summary;
        }

        public string ResolveCardName(int id, string customName = null, string type = null)
        {
            EnsureLoaded();
            if (!string.IsNullOrWhiteSpace(customName)) return SceneText.Normalize(customName);
            if (_cards.TryGetValue(id, out var card))
            {
                var name = String(card, "name");
                if (!string.IsNullOrWhiteSpace(name)) return name;
                var title = String(card, "title");
                if (!string.IsNullOrWhiteSpace(title)) return title;
            }
            if (!string.IsNullOrWhiteSpace(type)) return type + "#" + id;
            return "card#" + id;
        }

        public string ResolveRiteName(int id, string customName = null)
        {
            EnsureLoaded();
            if (!string.IsNullOrWhiteSpace(customName)) return SceneText.Normalize(customName);
            var rite = GetRite(id);
            if (rite != null)
            {
                var name = String(rite, "name");
                if (!string.IsNullOrWhiteSpace(name)) return name;
                var title = String(rite, "title");
                if (!string.IsNullOrWhiteSpace(title)) return title;
                var text = String(rite, "text");
                if (!string.IsNullOrWhiteSpace(text)) return text;
            }
            return "rite#" + id;
        }

        public Dictionary<string, object> GetCard(int id)
        {
            EnsureLoaded();
            return _cards.TryGetValue(id, out var card) ? card : null;
        }

        public Dictionary<string, object> GetRite(int id)
        {
            EnsureLoaded();
            if (_rites.TryGetValue(id, out var cached)) return cached;
            if (string.IsNullOrEmpty(_configRoot)) return null;
            try
            {
                var path = Path.Combine(_configRoot, "rite", id + ".json");
                if (!File.Exists(path)) return null;
                var token = ParseConfigJson(File.ReadAllText(path));
                if (token is not JObject obj) return null;
                var map = ToStringObjectMap(obj);
                AttachCardsSlot(obj, map);
                _rites[id] = map;
                return map;
            }
            catch (Exception ex)
            {
                _loadError = ex.Message;
                return null;
            }
        }

        /// <summary>Test helper: seed card names without Unity StreamingAssets.</summary>
        public void SeedCardForTests(
            int id,
            string name,
            string title = null,
            string type = null,
            string text = null,
            Dictionary<string, int> tags = null,
            IEnumerable<string> equipSlotTypes = null)
        {
            _loaded = true;
            var card = new Dictionary<string, object>
            {
                ["id"] = id,
                ["name"] = name,
                ["title"] = title,
                ["type"] = type,
                ["text"] = text
            };
            CardSummaryProjector.MergeTags(card, tags);
            if (equipSlotTypes != null)
            {
                var slots = new List<string>();
                foreach (var slot in equipSlotTypes)
                {
                    var normalized = SceneText.Normalize(slot);
                    if (!string.IsNullOrWhiteSpace(normalized) && !slots.Contains(normalized))
                    {
                        slots.Add(normalized);
                    }
                }
                if (slots.Count > 0) card["equipSlotTypes"] = slots;
            }
            _cards[id] = card;
        }

        /// <summary>
        /// Compact catalog dossier for agent-facing card identity (rite slots / inspect).
        /// </summary>
        public Dictionary<string, object> BuildCardSummary(int id, string customName = null, string runtimeType = null)
        {
            EnsureLoaded();
            var name = ResolveCardName(id, customName, runtimeType);
            var summary = new Dictionary<string, object>
            {
                ["cardId"] = id,
                ["name"] = name
            };
            if (!_cards.TryGetValue(id, out var card) || card == null)
            {
                if (!string.IsNullOrWhiteSpace(runtimeType)) summary["type"] = runtimeType;
                return summary;
            }

            CopyIfPresent(card, summary, "title");
            CopyIfPresent(card, summary, "type");
            CopyIfPresent(card, summary, "rare");
            CopyIfPresent(card, summary, "text");
            CopyIfPresent(card, summary, "desc");
            CopyIfPresent(card, summary, "description");
            CopyIfPresent(card, summary, "tip");
            CopyTagsIfPresent(card, summary);
            if (!summary.ContainsKey("type") && !string.IsNullOrWhiteSpace(runtimeType))
            {
                summary["type"] = runtimeType;
            }
            EquipmentProjector.AttachEquipFields(
                summary,
                id,
                summary.TryGetValue("type", out var resolvedType) ? resolvedType?.ToString() : runtimeType);
            return summary;
        }

        private static void CopyIfPresent(
            Dictionary<string, object> source,
            Dictionary<string, object> target,
            string key)
        {
            if (source == null || target == null) return;
            if (!source.TryGetValue(key, out var value) || value == null) return;
            var text = SceneText.Normalize(value.ToString());
            if (string.IsNullOrWhiteSpace(text)) return;
            target[key] = text.Length > 400 ? text.Substring(0, 400) : text;
        }

        private static void CopyTagsIfPresent(
            Dictionary<string, object> source,
            Dictionary<string, object> target)
        {
            if (source == null || target == null) return;
            if (!source.TryGetValue("tags", out var raw)
                || raw is not Dictionary<string, object> tags
                || tags.Count == 0)
            {
                return;
            }

            var copy = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var pair in new SortedDictionary<string, object>(tags, StringComparer.Ordinal))
            {
                copy[pair.Key] = pair.Value;
            }
            target["tags"] = copy;
        }

        /// <summary>Test helper: seed rite names without Unity StreamingAssets.</summary>
        public void SeedRiteForTests(int id, string name, string title = null, string text = null)
        {
            _loaded = true;
            _rites[id] = new Dictionary<string, object>
            {
                ["id"] = id,
                ["name"] = name,
                ["title"] = title,
                ["text"] = text
            };
        }

        public void ResetForTests()
        {
            _loaded = false;
            _configRoot = null;
            _loadError = null;
            _summary.Clear();
            _cards.Clear();
            _rites.Clear();
        }

        private void EnsureLoaded()
        {
            if (_loaded) return;
            _loaded = true;
            try
            {
#if GAME_INTEROP
                _configRoot = Path.Combine(Application.dataPath, "StreamingAssets", "config");
#else
                _configRoot = null;
#endif
                _summary["configRoot"] = _configRoot;
                _summary["exists"] = !string.IsNullOrEmpty(_configRoot) && Directory.Exists(_configRoot);
                if (string.IsNullOrEmpty(_configRoot) || !Directory.Exists(_configRoot))
                {
                    return;
                }

                _summary["riteCount"] = CountJsonFiles(Path.Combine(_configRoot, "rite"));
                _summary["eventCount"] = CountJsonFiles(Path.Combine(_configRoot, "event"));
                _summary["riteTemplateCount"] = CountJsonFiles(Path.Combine(_configRoot, "rite_template"));
                _summary["lootCount"] = CountJsonFiles(Path.Combine(_configRoot, "loot"));

                var cardsPath = Path.Combine(_configRoot, "cards.json");
                if (File.Exists(cardsPath))
                {
                    _summary["cardsFileBytes"] = new FileInfo(cardsPath).Length;
                    try
                    {
                        var token = ParseConfigJson(File.ReadAllText(cardsPath));
                        _summary["cardsTopLevelKind"] = token.Type.ToString();
                        if (token is JObject obj)
                        {
                            _summary["cardsKeyCount"] = obj.Count;
                            foreach (var prop in obj.Properties())
                            {
                                if (prop.Value is not JObject cardObj) continue;
                                if (!int.TryParse(prop.Name, out var id)
                                    && cardObj["id"] != null
                                    && !int.TryParse(cardObj["id"]?.ToString(), out id))
                                {
                                    continue;
                                }
                                if (cardObj["id"] != null && int.TryParse(cardObj["id"]?.ToString(), out var nestedId))
                                {
                                    id = nestedId;
                                }
                                var card = ToStringObjectMap(cardObj);
                                AttachCardTags(cardObj, card);
                                AttachCardEquipSlots(cardObj, card);
                                _cards[id] = card;
                            }
                        }
                        else if (token is JArray arr)
                        {
                            _summary["cardsKeyCount"] = arr.Count;
                        }
                    }
                    catch (Exception ex)
                    {
                        _summary["cardsParseError"] = ex.Message;
                        _loadError = ex.Message;
                    }
                }

                var variablePath = Path.Combine(_configRoot, "variable.json");
                if (File.Exists(variablePath))
                {
                    _summary["variableFileBytes"] = new FileInfo(variablePath).Length;
                }

                var fingerprint = string.Join("|",
                    _summary.TryGetValue("riteCount", out var r) ? r : 0,
                    _summary.TryGetValue("eventCount", out var e) ? e : 0,
                    _summary.TryGetValue("cardsFileBytes", out var c) ? c : 0,
                    _cards.Count);
                _summary["fingerprint"] = fingerprint.GetHashCode().ToString("x8");
                _summary["cardNameCacheCount"] = _cards.Count;
                if (!string.IsNullOrEmpty(_loadError)) _summary["loadError"] = _loadError;
            }
            catch (Exception ex)
            {
                _loadError = ex.GetType().Name + ": " + ex.Message;
                _summary["loadError"] = _loadError;
            }
        }

        private static readonly JsonLoadSettings ConfigJsonLoadSettings = new JsonLoadSettings
        {
            CommentHandling = CommentHandling.Ignore,
            LineInfoHandling = LineInfoHandling.Ignore
        };

        private static JToken ParseConfigJson(string text)
        {
            // Sultan config files routinely include // comments and are not strict JSON.
            using var reader = new JsonTextReader(new StringReader(text))
            {
                DateParseHandling = DateParseHandling.None
            };
            return JToken.Load(reader, ConfigJsonLoadSettings);
        }

        private static Dictionary<string, object> ToStringObjectMap(JObject obj)
        {
            var map = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var prop in obj.Properties())
            {
                if (prop.Value == null || prop.Value.Type == JTokenType.Null) continue;
                if (prop.Value.Type == JTokenType.Object || prop.Value.Type == JTokenType.Array) continue;
                map[prop.Name] = prop.Value.Type == JTokenType.Integer
                    ? prop.Value.Value<int>()
                    : prop.Value.ToString();
            }
            return map;
        }

        private static void AttachCardTags(JObject cardObj, Dictionary<string, object> map)
        {
            if (cardObj?["tag"] is not JObject rawTags || map == null) return;

            var tags = new SortedDictionary<string, object>(StringComparer.Ordinal);
            foreach (var prop in rawTags.Properties())
            {
                if (prop.Value == null || prop.Value.Type == JTokenType.Null) continue;
                if (!int.TryParse(prop.Value.ToString(), out var value) || value == 0) continue;
                var key = CardSummaryProjector.NormalizeTagKey(prop.Name);
                if (string.IsNullOrWhiteSpace(key)) continue;
                tags[key] = value;
            }
            if (tags.Count == 0) return;

            var compact = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var pair in tags)
            {
                compact[pair.Key] = pair.Value;
            }
            map["tags"] = compact;
        }

        private static void AttachCardEquipSlots(JObject cardObj, Dictionary<string, object> map)
        {
            if (cardObj?["equips"] is not JArray rawSlots || map == null) return;
            var slots = new List<string>();
            foreach (var token in rawSlots)
            {
                if (token == null || token.Type == JTokenType.Null) continue;
                var slot = EquipmentProjector.NormalizeSlotType(token.ToString());
                if (string.IsNullOrWhiteSpace(slot) || slots.Contains(slot)) continue;
                slots.Add(slot);
            }
            if (slots.Count > 0) map["equipSlotTypes"] = slots;
        }

        private static void AttachCardsSlot(JObject riteObj, Dictionary<string, object> map)
        {
            if (riteObj?["cards_slot"] is not JObject cardsSlot || map == null) return;
            var slots = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var prop in cardsSlot.Properties())
            {
                if (prop.Value is not JObject slot) continue;
                string conditionType = null;
                string conditionJson = null;
                if (slot["condition"] is JObject cond)
                {
                    conditionType = cond.Value<string>("type");
                    conditionJson = cond.ToString(Formatting.None);
                }
                else if (slot["condition"] != null && slot["condition"].Type != JTokenType.Null)
                {
                    conditionJson = slot["condition"].ToString(Formatting.None);
                }

                slots[prop.Name] = new Dictionary<string, object>
                {
                    ["text"] = slot.Value<string>("text"),
                    ["is_key"] = slot["is_key"]?.Type == JTokenType.Integer ? slot.Value<int>("is_key") : 0,
                    ["is_empty"] = slot["is_empty"]?.Type == JTokenType.Boolean
                        ? slot.Value<bool>("is_empty")
                        : slot.Value<int?>("is_empty") == 1,
                    ["conditionType"] = conditionType,
                    ["condition"] = conditionJson
                };
            }
            map["cards_slot"] = slots;
        }

        private static string String(Dictionary<string, object> map, string key)
        {
            return map != null && map.TryGetValue(key, out var value) ? SceneText.Normalize(value?.ToString()) : null;
        }

        private static int CountJsonFiles(string dir)
        {
            if (!Directory.Exists(dir)) return 0;
            return Directory.GetFiles(dir, "*.json", SearchOption.TopDirectoryOnly).Length;
        }
    }
}
