using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BepInEx;
using HarmonyLib;
using Newtonsoft.Json;
using VibeSultan.Sultan.Observer.State;
#if GAME_INTEROP
using UnityEngine.EventSystems;
#endif

namespace VibeSultan.Sultan.Observer.Recording
{
    /// <summary>
    /// Explicit, developer-only recorder for learning real player interaction paths.
    /// It is not a replay system and records nothing until /record/start is called.
    /// </summary>
    public sealed class PlayerActionRecorder : IDisposable
    {
        private readonly object _gate = new object();
        private readonly StateHub _hub;
        private readonly Harmony _harmony;
        private readonly List<RecordedCall> _events = new List<RecordedCall>();
        private RecordingDocument _current;
        private RecordingDocument _latest;
        private long _sequence;
        private string _lastThinkSignature;
        private string _lastRiteResultSignature;
        private string _lastSudanSignature;
        private HashSet<int> _lastRiteUids = new HashSet<int>();

        public PlayerActionRecorder(StateHub hub)
        {
            _hub = hub;
            _harmony = new Harmony(Plugin.PluginGuid + ".player-action-recorder");
        }

        public bool Active
        {
            get
            {
                lock (_gate) return _current != null && _current.active;
            }
        }

        public void Install()
        {
            // Boot-safe: install only the original rite/equip recorder patches.
            // Do not attach ThinkController / CardDragManager probes here — they can
            // native-crash IL2CPP Harmony during Chainloader and prevent game start.
            var safeTypes = new[]
            {
                typeof(CardSlotDropCardPatch),
                typeof(CardSlotSetCardPatch),
                typeof(RiteRequestUpdatePatch),
                typeof(RiteTryUpdateCardPatch),
                typeof(RiteSetCardPatch),
                typeof(RiteConfirmPatch),
                typeof(RiteStopPatch),
                typeof(RiteClosePatch),
                typeof(CardEquipPatch),
                typeof(CardRemoveFromSlotPatch)
            };

            var ok = 0;
            var failed = 0;
            foreach (var type in safeTypes)
            {
                try
                {
                    _harmony.CreateClassProcessor(type).Patch();
                    ok++;
                }
                catch (Exception ex)
                {
                    failed++;
                    Plugin.Log?.LogWarning(
                        "PlayerActionRecorder skip patch " + type.Name + ": " + ex.Message);
                }
            }

#if GAME_INTEROP
            // DoIThink is a real method (not a field accessor) and is already used by
            // inspect_card at runtime. Patch it alone; skip if IL2CPP rejects it.
            try
            {
                _harmony.CreateClassProcessor(typeof(GameDoIThinkPatch)).Patch();
                ok++;
                Plugin.Log?.LogInfo("PlayerActionRecorder attached GameController.DoIThink probe");
            }
            catch (Exception ex)
            {
                failed++;
                Plugin.Log?.LogWarning(
                    "PlayerActionRecorder skip GameDoIThinkPatch: " + ex.Message);
            }

            // Result-page / Sudan-break / sudan-box / map-rite / day / option probes.
            var optionalResultProbes = new[]
            {
                typeof(RiteResultOnPointerClickPatch),
                typeof(RiteResultOnNextPatch),
                typeof(RiteResultDoNextPatch),
                typeof(SudanBreakerOnPointerClickPatch),
                typeof(SudanBoxOnPointerClickPatch),
                typeof(WizardRedrawSudanCardPatch),
                typeof(GameOnPrevRoundPatch),
                typeof(GameOnNextRoundPatch),
                typeof(RiteControllerOnSubmitPatch),
                typeof(OptionOnConfirmPatch),
                typeof(ConfirmOnConfirmPatch),
                typeof(CardSplitPatch)
            };
            foreach (var type in optionalResultProbes)
            {
                try
                {
                    _harmony.CreateClassProcessor(type).Patch();
                    ok++;
                    Plugin.Log?.LogInfo("PlayerActionRecorder attached " + type.Name);
                }
                catch (Exception ex)
                {
                    failed++;
                    Plugin.Log?.LogWarning(
                        "PlayerActionRecorder skip " + type.Name + ": " + ex.Message);
                }
            }

            // BeginGuide close methods vary by game build — patch by name when present.
            ok += TryPatchOptionalMethod(
                typeof(BeginGuideController), "OnClose",
                nameof(BeginGuideClosePrefix), nameof(BeginGuideClosePostfix), ref failed);
            ok += TryPatchOptionalMethod(
                typeof(BeginGuideController), "Close",
                nameof(BeginGuideClosePrefix), nameof(BeginGuideClosePostfix), ref failed);
            ok += TryPatchOptionalMethod(
                typeof(BeginGuideController), "Hide",
                nameof(BeginGuideClosePrefix), nameof(BeginGuideClosePostfix), ref failed);

            var guideButtonType =
                AccessTools.TypeByName("BeginGuideButtonHandler")
                ?? AccessTools.TypeByName("Game.BeginGuideButtonHandler");
            if (guideButtonType != null)
            {
                ok += TryPatchOptionalMethod(
                    guideButtonType, "OnPointerClick",
                    nameof(BeginGuideButtonPrefix), nameof(BeginGuideButtonPostfix), ref failed);
                ok += TryPatchOptionalMethod(
                    guideButtonType, "OnClick",
                    nameof(BeginGuideButtonPrefix), nameof(BeginGuideButtonPostfix), ref failed);
            }
            else
            {
                Plugin.Log?.LogInfo("PlayerActionRecorder skip BeginGuideButtonHandler (type not found)");
            }
#endif

            Plugin.Log?.LogInfo(
                "PlayerActionRecorder patches installed ok=" + ok + " failed=" + failed
                + " (drag/OnDrop probes disabled; poll probe enabled while recording)");
        }

#if GAME_INTEROP
        private int TryPatchOptionalMethod(
            Type type,
            string methodName,
            string prefixName,
            string postfixName,
            ref int failed)
        {
            try
            {
                var method = AccessTools.Method(type, methodName);
                if (method == null)
                {
                    Plugin.Log?.LogInfo(
                        "PlayerActionRecorder skip " + type.Name + "." + methodName + " (not found)");
                    return 0;
                }

                var prefix = new HarmonyMethod(
                    typeof(PlayerActionRecorder).GetMethod(
                        prefixName, System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic));
                var postfix = new HarmonyMethod(
                    typeof(PlayerActionRecorder).GetMethod(
                        postfixName, System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic));
                _harmony.Patch(method, prefix: prefix, postfix: postfix);
                Plugin.Log?.LogInfo(
                    "PlayerActionRecorder attached " + type.Name + "." + methodName);
                return 1;
            }
            catch (Exception ex)
            {
                failed++;
                Plugin.Log?.LogWarning(
                    "PlayerActionRecorder skip " + type.Name + "." + methodName + ": " + ex.Message);
                return 0;
            }
        }

        private static void BeginGuideClosePrefix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.SudanSnapshot();
            data["guideEvent"] = "close";
            RecorderProbe.Enter("BeginGuideController.OnClose", data);
        }

        private static void BeginGuideClosePostfix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.SudanSnapshot();
            data["guideEvent"] = "close";
            RecorderProbe.Exit("BeginGuideController.OnClose", data);
        }

        private static void BeginGuideButtonPrefix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.SudanSnapshot();
            data["guideEvent"] = "button";
            RecorderProbe.Enter("BeginGuideButtonHandler.Click", data);
        }

        private static void BeginGuideButtonPostfix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.SudanSnapshot();
            data["guideEvent"] = "button";
            RecorderProbe.Exit("BeginGuideButtonHandler.Click", data);
        }
#endif

        /// <summary>
        /// Poll i_think / hand / rite deltas while recording. Safe alternative to
        /// Harmony-patching ThinkController / CardDragManager (those can crash boot).
        /// </summary>
        public void PollThink()
        {
#if GAME_INTEROP
            if (!Active) return;

            Dictionary<string, object> snap;
            try { snap = RecorderProbe.ThinkSnapshot(); }
            catch { return; }

            var riteUids = new HashSet<int>();
            try
            {
                if (snap.TryGetValue("rites", out var ritesObj) && ritesObj is List<object> rites)
                {
                    foreach (var item in rites)
                    {
                        if (item is Dictionary<string, object> row
                            && row.TryGetValue("uid", out var uidObj)
                            && uidObj != null
                            && int.TryParse(uidObj.ToString(), out var uid))
                        {
                            riteUids.Add(uid);
                        }
                    }
                }
            }
            catch { /* optional */ }

            var signature = string.Join("|", new[]
            {
                Str(snap, "handCount"),
                Str(snap, "riteCount"),
                Str(snap, "ithinkCardUid"),
                Str(snap, "ithinkCardId"),
                Str(snap, "currentDragUid"),
                Str(snap, "currentDragId"),
                Str(snap, "thinkCurrentUid"),
                Str(snap, "thinkRiteUid"),
                Str(snap, "thinkRiteId"),
                Str(snap, "thinkRiteNodeId"),
                Str(snap, "enableThink"),
                Str(snap, "canShowIThink"),
                string.Join(",", riteUids.OrderBy(x => x))
            });

            lock (_gate)
            {
                if (_current == null || !_current.active) return;
                if (signature == _lastThinkSignature) return;

                var added = riteUids.Except(_lastRiteUids).OrderBy(x => x).ToList();
                var removed = _lastRiteUids.Except(riteUids).OrderBy(x => x).ToList();
                snap["addedRiteUids"] = added;
                snap["removedRiteUids"] = removed;
                snap["prevSignature"] = _lastThinkSignature;
                snap["signature"] = signature;

                _lastThinkSignature = signature;
                _lastRiteUids = riteUids;
                RecordLocked("poll", "i_think_state", snap);
            }

            PollRiteResult();
            PollSudan();
#else
            // no-op without game interop
#endif
        }

        /// <summary>
        /// Poll sudan-box / wizard / redraw / round deltas while recording.
        /// Complements Harmony probes when box/wizard clicks are not patched.
        /// </summary>
        public void PollSudan()
        {
#if GAME_INTEROP
            if (!Active) return;

            Dictionary<string, object> snap;
            try { snap = RecorderProbe.SudanSnapshot(); }
            catch { return; }

            var signature = string.Join("|", new[]
            {
                Str(snap, "wizardActive"),
                Str(snap, "wizardChoiceMenu"),
                Str(snap, "wizardRedrawDropperActive"),
                Str(snap, "redrawTimes"),
                Str(snap, "redrawRemaining"),
                Str(snap, "sudanCardUid"),
                Str(snap, "sudanCardId"),
                Str(snap, "sudanBoxReady"),
                Str(snap, "playerRound"),
                Str(snap, "ritePanelActive"),
                Str(snap, "currentRiteUid"),
                Str(snap, "beginGuideActive"),
                Str(snap, "guidePreferredOp"),
                Str(snap, "guideType")
            });

            lock (_gate)
            {
                if (_current == null || !_current.active) return;
                if (signature == _lastSudanSignature) return;
                snap["prevSignature"] = _lastSudanSignature;
                snap["signature"] = signature;
                _lastSudanSignature = signature;
                RecordLocked("poll", "sudan_state", snap);
            }
#endif
        }

        /// <summary>
        /// Poll rite-result / Sudan-breaker deltas while recording blank-click advances.
        /// </summary>
        public void PollRiteResult()
        {
#if GAME_INTEROP
            if (!Active) return;

            Dictionary<string, object> snap;
            try { snap = RecorderProbe.RiteResultSnapshot(); }
            catch { return; }

            var signature = string.Join("|", new[]
            {
                Str(snap, "active"),
                Str(snap, "stage"),
                Str(snap, "nextInteractable"),
                Str(snap, "title"),
                Str(snap, "body"),
                Str(snap, "rewardSummary"),
                Str(snap, "successCount"),
                Str(snap, "dicePromptVisible"),
                Str(snap, "goldSelectInteractable"),
                Str(snap, "goldConfirmInteractable"),
                Str(snap, "sudanBreakerWaiting"),
                Str(snap, "sudanBreakerActive")
            });

            lock (_gate)
            {
                if (_current == null || !_current.active) return;
                if (signature == _lastRiteResultSignature) return;
                snap["prevSignature"] = _lastRiteResultSignature;
                snap["signature"] = signature;
                _lastRiteResultSignature = signature;
                RecordLocked("poll", "rite_result_state", snap);
            }
#endif
        }

        private static string Str(Dictionary<string, object> data, string key)
        {
            if (data == null || !data.TryGetValue(key, out var value) || value == null) return "";
            return value.ToString();
        }

        public Dictionary<string, object> Start()
        {
            lock (_gate)
            {
                _events.Clear();
                _sequence = 0;
                _lastThinkSignature = null;
                _lastRiteResultSignature = null;
                _lastSudanSignature = null;
                _lastRiteUids = new HashSet<int>();
                var now = DateTimeOffset.Now;
                _current = new RecordingDocument
                {
                    id = now.ToString("yyyyMMdd-HHmmss-fff"),
                    active = true,
                    startedAt = now.ToString("o"),
                    purpose = "Developer guidance for SultanObserver / Sultan Agent changes",
                    initialState = SnapshotState(),
                    initialScene = SnapshotScene()
                };
                RecordLocked("recording", "start", new Dictionary<string, object>());
#if GAME_INTEROP
                try
                {
                    // Seed poll baseline without emitting a fake delta.
                    var snap = RecorderProbe.ThinkSnapshot();
                    if (snap.TryGetValue("rites", out var ritesObj) && ritesObj is List<object> rites)
                    {
                        foreach (var item in rites)
                        {
                            if (item is Dictionary<string, object> row
                                && row.TryGetValue("uid", out var uidObj)
                                && uidObj != null
                                && int.TryParse(uidObj.ToString(), out var uid))
                            {
                                _lastRiteUids.Add(uid);
                            }
                        }
                    }
                    _lastThinkSignature = string.Join("|", new[]
                    {
                        Str(snap, "handCount"),
                        Str(snap, "riteCount"),
                        Str(snap, "ithinkCardUid"),
                        Str(snap, "ithinkCardId"),
                        Str(snap, "currentDragUid"),
                        Str(snap, "currentDragId"),
                        Str(snap, "thinkCurrentUid"),
                        Str(snap, "thinkRiteUid"),
                        Str(snap, "thinkRiteId"),
                        Str(snap, "thinkRiteNodeId"),
                        Str(snap, "enableThink"),
                        Str(snap, "canShowIThink"),
                        string.Join(",", _lastRiteUids.OrderBy(x => x))
                    });
                    snap["signature"] = _lastThinkSignature;
                    RecordLocked("poll", "i_think_baseline", snap);

                    var riteSnap = RecorderProbe.RiteResultSnapshot();
                    _lastRiteResultSignature = string.Join("|", new[]
                    {
                        Str(riteSnap, "active"),
                        Str(riteSnap, "stage"),
                        Str(riteSnap, "nextInteractable"),
                        Str(riteSnap, "title"),
                        Str(riteSnap, "body"),
                        Str(riteSnap, "rewardSummary"),
                        Str(riteSnap, "successCount"),
                        Str(riteSnap, "dicePromptVisible"),
                        Str(riteSnap, "goldSelectInteractable"),
                        Str(riteSnap, "goldConfirmInteractable"),
                        Str(riteSnap, "sudanBreakerWaiting"),
                        Str(riteSnap, "sudanBreakerActive")
                    });
                    riteSnap["signature"] = _lastRiteResultSignature;
                    RecordLocked("poll", "rite_result_baseline", riteSnap);

                    var sudanSnap = RecorderProbe.SudanSnapshot();
                    _lastSudanSignature = string.Join("|", new[]
                    {
                        Str(sudanSnap, "wizardActive"),
                        Str(sudanSnap, "wizardChoiceMenu"),
                        Str(sudanSnap, "wizardRedrawDropperActive"),
                        Str(sudanSnap, "redrawTimes"),
                        Str(sudanSnap, "redrawRemaining"),
                        Str(sudanSnap, "sudanCardUid"),
                        Str(sudanSnap, "sudanCardId"),
                        Str(sudanSnap, "sudanBoxReady"),
                        Str(sudanSnap, "playerRound"),
                        Str(sudanSnap, "ritePanelActive"),
                        Str(sudanSnap, "currentRiteUid"),
                        Str(sudanSnap, "beginGuideActive"),
                        Str(sudanSnap, "guidePreferredOp"),
                        Str(sudanSnap, "guideType")
                    });
                    sudanSnap["signature"] = _lastSudanSignature;
                    RecordLocked("poll", "sudan_baseline", sudanSnap);
                }
                catch { /* optional */ }
#endif
                return StatusLocked();
            }
        }

        public Dictionary<string, object> Stop()
        {
            lock (_gate)
            {
                if (_current == null)
                {
                    return new Dictionary<string, object>
                    {
                        ["ok"] = false,
                        ["error"] = "not_recording"
                    };
                }

                RecordLocked("recording", "stop", new Dictionary<string, object>());
                _current.active = false;
                _current.stoppedAt = DateTimeOffset.Now.ToString("o");
                _current.finalState = SnapshotState();
                _current.finalScene = SnapshotScene();
                _current.events = new List<RecordedCall>(_events);
                _current.eventCount = _events.Count;
                _current.filePath = WriteDocument(_current);
                _latest = _current;
                _current = null;

                return new Dictionary<string, object>
                {
                    ["ok"] = true,
                    ["active"] = false,
                    ["id"] = _latest.id,
                    ["eventCount"] = _latest.eventCount,
                    ["filePath"] = _latest.filePath
                };
            }
        }

        public Dictionary<string, object> Status()
        {
            lock (_gate) return StatusLocked();
        }

        public object Latest()
        {
            lock (_gate)
            {
                return _latest ?? (object)new Dictionary<string, object>
                {
                    ["ok"] = false,
                    ["error"] = "no_recording"
                };
            }
        }

        public void Record(string phase, string method, Dictionary<string, object> data = null)
        {
            lock (_gate)
            {
                if (_current == null || !_current.active) return;
                RecordLocked(phase, method, data);
            }
        }

        private void RecordLocked(string phase, string method, Dictionary<string, object> data)
        {
            if (_events.Count >= 2000) return;
            _events.Add(new RecordedCall
            {
                sequence = ++_sequence,
                at = DateTimeOffset.Now.ToString("o"),
                frame = UnityEngine.Time.frameCount,
                phase = phase,
                method = method,
                data = data ?? new Dictionary<string, object>()
            });
        }

        private Dictionary<string, object> StatusLocked()
        {
            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["active"] = _current != null && _current.active,
                ["id"] = _current?.id,
                ["eventCount"] = _events.Count,
                ["latestId"] = _latest?.id,
                ["latestPath"] = _latest?.filePath
            };
        }

        private object SnapshotState()
        {
            return CompactProjector.Project(_hub?.GetCachedState(), new HashSet<string>());
        }

        private object SnapshotScene()
        {
            return _hub?.GetCachedScene();
        }

        private static string WriteDocument(RecordingDocument document)
        {
            var directory = Path.Combine(Paths.BepInExRootPath, "recordings", "sultan");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "manual-" + document.id + ".json");
            document.filePath = path;
            File.WriteAllText(path, JsonConvert.SerializeObject(document, Formatting.Indented));
            return path;
        }

        public void Dispose()
        {
            try { _harmony.UnpatchSelf(); } catch { /* best effort */ }
        }
    }

    public sealed class RecordingDocument
    {
        public string id { get; set; }
        public bool active { get; set; }
        public string purpose { get; set; }
        public string startedAt { get; set; }
        public string stoppedAt { get; set; }
        public int eventCount { get; set; }
        public string filePath { get; set; }
        public object initialState { get; set; }
        public object initialScene { get; set; }
        public List<RecordedCall> events { get; set; }
        public object finalState { get; set; }
        public object finalScene { get; set; }
    }

    public sealed class RecordedCall
    {
        public long sequence { get; set; }
        public string at { get; set; }
        public int frame { get; set; }
        public string phase { get; set; }
        public string method { get; set; }
        public Dictionary<string, object> data { get; set; }
    }

#if GAME_INTEROP
    internal static class RecorderProbe
    {
        public static Dictionary<string, object> Slot(CardSlotController slot, Card card = null)
        {
            var data = new Dictionary<string, object>();
            try { data["slotIndex"] = slot?.Index; } catch { /* optional */ }
            try { data["slotCardUid"] = RiteSlotProjector.GetSlotCardUid(slot); } catch { /* optional */ }
            try { data["cardUid"] = card?.uid; } catch { /* optional */ }
            try { data["cardId"] = card?.id; } catch { /* optional */ }
            try { data["riteUid"] = GameBindings.RitePanel?.Current?.uid; } catch { /* optional */ }
            try { data["cardCount"] = card != null ? Math.Max(1, card.count) : (object)null; } catch { /* optional */ }
            try { data["cardRare"] = card?.Rare; } catch { /* optional */ }
            try
            {
                if (card != null)
                {
                    data["cardName"] = ConfigCatalog.Instance.ResolveCardName(
                        card.id, card.custom_name, card.Type);
                }
            }
            catch
            {
                try { data["cardName"] = card?.custom_name; } catch { /* optional */ }
            }
            // slotWasEmpty is set by SetCard Prefix only (pre-mutation). Do not infer here.
            return data;
        }

        public static Dictionary<string, object> CardInfo(Card card)
        {
            var data = new Dictionary<string, object>();
            if (card == null) return data;
            try { data["cardUid"] = card.uid; } catch { /* optional */ }
            try { data["cardId"] = card.id; } catch { /* optional */ }
            try { data["cardType"] = card.Type; } catch { /* optional */ }
            try { data["cardRare"] = card.Rare; } catch { /* optional */ }
            try { data["cardCount"] = Math.Max(1, card.count); } catch { /* optional */ }
            try
            {
                data["cardName"] = ConfigCatalog.Instance.ResolveCardName(
                    card.id, card.custom_name, card.Type);
            }
            catch
            {
                try { data["cardName"] = card.custom_name; } catch { /* optional */ }
            }
            return data;
        }

        public static ThinkController FindThinkController() => GameBindings.FindThinkController();

        public static Dictionary<string, object> ThinkSnapshot(Card card = null)
        {
            var data = CardInfo(card);
            try
            {
                var player = GameBindings.Player;
                if (player != null)
                {
                    data["ithinkCardUid"] = player.ithink_card?.uid;
                    data["ithinkCardId"] = player.ithink_card?.id;
                    data["handCount"] = player.cards?.Count;
                    data["riteCount"] = player.rites?.Count;
                }
            }
            catch { /* optional */ }

            try
            {
                var controller = GameBindings.Controller;
                if (controller != null)
                {
                    data["canShowIThink"] = controller.CanShowIThink();
                    data["iThinkActive"] = controller.IThink != null && controller.IThink.activeInHierarchy;
                    data["currentDragUid"] = controller.CurrentDrag?.uid;
                    data["currentDragId"] = controller.CurrentDrag?.id;
                }
            }
            catch { /* optional */ }

            try
            {
                var think = FindThinkController();
                if (think != null)
                {
                    data["enableThink"] = think.EnableThink;
                    data["thinkCurrentUid"] = think.Current?.uid;
                    data["thinkCurrentId"] = think.Current?.id;
                    var thinkRiteNode = think.ThinkRite;
                    data["thinkRiteNodeId"] = thinkRiteNode?.id;
                    data["thinkRiteNodeName"] = thinkRiteNode?.name;
                    var thinkRite = think.rite;
                    data["thinkRiteUid"] = thinkRite?.uid;
                    data["thinkRiteId"] = thinkRite?.id;
                    data["thinkRiteName"] = SafeRiteName(thinkRite);
                }
            }
            catch { /* optional */ }

            try
            {
                var rites = new List<object>();
                var player = GameBindings.Player;
                if (player?.rites != null)
                {
                    foreach (var rite in player.rites)
                    {
                        if (rite == null) continue;
                        rites.Add(new Dictionary<string, object>
                        {
                            ["uid"] = rite.uid,
                            ["id"] = rite.id,
                            ["name"] = SafeRiteName(rite)
                        });
                    }
                }
                data["rites"] = rites;
            }
            catch { /* optional */ }

            return data;
        }

        public static Dictionary<string, object> RiteResultSnapshot()
        {
            var data = new Dictionary<string, object>();
            try
            {
                var snap = GameBindings.ReadRiteResultSnapshot(180);
                foreach (var kv in snap)
                {
                    data[kv.Key] = kv.Value;
                }
            }
            catch { /* optional */ }

            try
            {
                data["sudanBreakerWaiting"] = GameBindings.IsSudanBreakerWaiting;
                data["sudanBreakerActive"] = GameBindings.IsUiActive(
                    GameBindings.Controller?.SudanBreakerController);
            }
            catch { /* optional */ }

            return data;
        }

        public static Dictionary<string, object> SudanSnapshot()
        {
            var data = new Dictionary<string, object>();
            try
            {
                data["wizardActive"] = GameBindings.IsWizardActive;
                data["wizardChoiceMenu"] = GameBindings.IsWizardChoiceMenu;
                data["wizardRedrawDropperActive"] = GameBindings.IsWizardRedrawDropperActive;
                data["sudanBoxReady"] = GameBindings.IsSudanBoxReady;
                data["sudanBoxPresent"] = GameBindings.IsSudanBoxPresent;
                data["ritePanelActive"] = GameBindings.IsUiActive(GameBindings.RitePanel);
            }
            catch { /* optional */ }

            try
            {
                var guide = GameBindings.ReadBeginGuideSnapshot();
                data["beginGuideActive"] = guide != null
                    && guide.TryGetValue("active", out var activeObj)
                    && activeObj is bool active
                    && active;
                if (guide != null)
                {
                    if (guide.TryGetValue("type", out var guideType)) data["guideType"] = guideType;
                    if (guide.TryGetValue("preferredOp", out var preferred))
                        data["guidePreferredOp"] = preferred;
                    if (guide.TryGetValue("textKey", out var textKey)) data["guideTextKey"] = textKey;
                    if (guide.TryGetValue("text", out var text)) data["guideText"] = text;
                }
            }
            catch { /* optional */ }

            try
            {
                var player = GameBindings.Player;
                if (player != null)
                {
                    data["redrawTimes"] = player.sudan_redraw_times;
                    data["redrawPerRound"] = player.sudan_redraw_times_per_round;
                    data["playerRound"] = player.round;
                }
            }
            catch { /* optional */ }

            try
            {
                var card = GameBindings.FindCurrentSudanCard();
                if (card != null)
                {
                    data["sudanCardUid"] = card.uid;
                    data["sudanCardId"] = card.id;
                    try
                    {
                        data["sudanCardName"] = ConfigCatalog.Instance.ResolveCardName(
                            card.id, card.custom_name, card.Type);
                    }
                    catch
                    {
                        try { data["sudanCardName"] = card.custom_name; } catch { /* optional */ }
                    }
                }
            }
            catch { /* optional */ }

            try
            {
                var rite = GameBindings.RitePanel?.Current;
                if (rite != null)
                {
                    data["currentRiteUid"] = rite.uid;
                    data["currentRiteId"] = rite.id;
                    data["currentRiteName"] = SafeRiteName(rite);
                }
            }
            catch { /* optional */ }

            try
            {
                var redrawTimes = data.TryGetValue("redrawTimes", out var rt) && rt != null
                    ? Convert.ToInt32(rt)
                    : 0;
                var redrawPerRound = data.TryGetValue("redrawPerRound", out var rp) && rp != null
                    ? Convert.ToInt32(rp)
                    : 0;
                data["redrawRemaining"] = Math.Max(0, redrawPerRound - redrawTimes);
            }
            catch { /* optional */ }

            return data;
        }

        private static string SafeRiteName(Rite rite)
        {
            if (rite == null) return null;
            try
            {
                return ConfigCatalog.Instance.ResolveRiteName(rite.id, rite.custom_name);
            }
            catch
            {
                try { return rite.custom_name; } catch { return null; }
            }
        }

        public static string SafeRiteNamePublic(Rite rite) => SafeRiteName(rite);

        public static Dictionary<string, object> DropTargetInfo(object target)
        {
            var data = new Dictionary<string, object>();
            if (target == null)
            {
                data["target"] = null;
                return data;
            }

            try { data["targetType"] = target.GetType().FullName; } catch { /* optional */ }
            try
            {
                if (target is UnityEngine.Object unityObj)
                {
                    data["targetName"] = unityObj.name;
                }
            }
            catch { /* optional */ }

            try
            {
                var controller = GameBindings.Controller;
                if (controller?.IThink != null && target is UnityEngine.Component component)
                {
                    data["isIThinkTarget"] =
                        component.gameObject == controller.IThink
                        || component.transform.IsChildOf(controller.IThink.transform)
                        || controller.IThink.transform.IsChildOf(component.transform)
                        || component.GetComponentInParent<ThinkController>() != null;
                }
                else if (target is ThinkController)
                {
                    data["isIThinkTarget"] = true;
                }
            }
            catch { /* optional */ }

            return data;
        }

        public static Dictionary<string, object> Merge(Dictionary<string, object> left, Dictionary<string, object> right)
        {
            var data = left ?? new Dictionary<string, object>();
            if (right == null) return data;
            foreach (var pair in right)
            {
                data[pair.Key] = pair.Value;
            }
            return data;
        }

        public static void Enter(string method, Dictionary<string, object> data = null) =>
            PluginContext.Recorder?.Record("enter", method, data);

        public static void Exit(string method, Dictionary<string, object> data = null) =>
            PluginContext.Recorder?.Record("exit", method, data);

        /// <summary>
        /// Harmony prefixes must not touch game singletons unless recording is active.
        /// Eager snapshot args (e.g. SudanSnapshot) during boot can AV inside IL2CPP cctors.
        /// </summary>
        public static bool IsRecordingActive => PluginContext.Recorder?.Active == true;
    }

    [HarmonyPatch(typeof(CardSlotController), nameof(CardSlotController.DropCard))]
    internal static class CardSlotDropCardPatch
    {
        private static void Prefix(CardSlotController __instance, CardController rightController)
        {
            RecorderProbe.Enter("CardSlotController.DropCard",
                RecorderProbe.Slot(__instance, rightController?.card));
        }

        private static void Postfix(CardSlotController __instance, CardController rightController)
        {
            RecorderProbe.Exit("CardSlotController.DropCard",
                RecorderProbe.Slot(__instance, rightController?.card));
        }
    }

    [HarmonyPatch(typeof(CardSlotController), nameof(CardSlotController.SetCard))]
    internal static class CardSlotSetCardPatch
    {
        // Exit folds over enter in the mapper; preserve pre-mutation emptiness on exit.
        [ThreadStatic] private static object _slotWasEmpty;

        private static void Prefix(CardSlotController __instance, Card card)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            // Capture emptiness BEFORE SetCard mutates the slot.
            var data = RecorderProbe.Slot(__instance, card);
            try
            {
                var wasEmpty = RiteSlotProjector.GetSlotCardUid(__instance) == null && card != null;
                data["slotWasEmpty"] = wasEmpty;
                _slotWasEmpty = wasEmpty;
            }
            catch
            {
                _slotWasEmpty = null;
            }
            RecorderProbe.Enter("CardSlotController.SetCard", data);
        }

        private static void Postfix(CardSlotController __instance, Card card)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.Slot(__instance, card);
            if (_slotWasEmpty != null) data["slotWasEmpty"] = _slotWasEmpty;
            _slotWasEmpty = null;
            RecorderProbe.Exit("CardSlotController.SetCard", data);
        }
    }

    [HarmonyPatch(typeof(RitePanelShowController), nameof(RitePanelShowController.RequestUpdate))]
    internal static class RiteRequestUpdatePatch
    {
        private static void Prefix(Card card) =>
            RecorderProbe.Enter("RitePanelShowController.RequestUpdate", RecorderProbe.Slot(null, card));

        private static void Postfix(Card card) =>
            RecorderProbe.Exit("RitePanelShowController.RequestUpdate", RecorderProbe.Slot(null, card));
    }

    [HarmonyPatch(
        typeof(RitePanelShowController),
        nameof(RitePanelShowController.TryUpdateCard),
        new[] { typeof(int), typeof(Card) })]
    internal static class RiteTryUpdateCardPatch
    {
        private static void Prefix(int index, Card card)
        {
            var data = RecorderProbe.Slot(null, card);
            data["slotIndex"] = index;
            RecorderProbe.Enter("RitePanelShowController.TryUpdateCard", data);
        }

        private static void Postfix(int index, Card card, bool __result)
        {
            var data = RecorderProbe.Slot(null, card);
            data["slotIndex"] = index;
            data["result"] = __result;
            RecorderProbe.Exit("RitePanelShowController.TryUpdateCard", data);
        }
    }

    [HarmonyPatch(
        typeof(RitePanelShowController),
        nameof(RitePanelShowController.SetCard),
        new[] { typeof(int), typeof(Card) })]
    internal static class RiteSetCardPatch
    {
        [ThreadStatic] private static object _slotWasEmpty;

        private static void Prefix(int index, Card card)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.Slot(null, card);
            data["slotIndex"] = index;
            // Detect fill-vs-sync via panel slot occupancy before mutation.
            try
            {
                var panel = GameBindings.RitePanel;
                var slots = panel != null ? panel.Slots : null;
                int? beforeUid = null;
                if (slots != null && index >= 0 && index < slots.Count)
                {
                    beforeUid = RiteSlotProjector.GetSlotCardUid(slots[index]);
                }
                var wasEmpty = beforeUid == null && card != null;
                data["slotWasEmpty"] = wasEmpty;
                _slotWasEmpty = wasEmpty;
            }
            catch
            {
                _slotWasEmpty = null;
            }
            RecorderProbe.Enter("RitePanelShowController.SetCard", data);
        }

        private static void Postfix(int index, Card card)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.Slot(null, card);
            data["slotIndex"] = index;
            if (_slotWasEmpty != null) data["slotWasEmpty"] = _slotWasEmpty;
            _slotWasEmpty = null;
            RecorderProbe.Exit("RitePanelShowController.SetCard", data);
        }
    }

    [HarmonyPatch(typeof(RitePanelShowController), nameof(RitePanelShowController.OnConfirm))]
    internal static class RiteConfirmPatch
    {
        private static void Prefix() => RecorderProbe.Enter("RitePanelShowController.OnConfirm");
        private static void Postfix() => RecorderProbe.Exit("RitePanelShowController.OnConfirm");
    }

    [HarmonyPatch(typeof(RitePanelShowController), nameof(RitePanelShowController.OnStop))]
    internal static class RiteStopPatch
    {
        private static void Prefix() => RecorderProbe.Enter("RitePanelShowController.OnStop");
        private static void Postfix() => RecorderProbe.Exit("RitePanelShowController.OnStop");
    }

    [HarmonyPatch(typeof(RitePanelShowController), nameof(RitePanelShowController.OnClose))]
    internal static class RiteClosePatch
    {
        private static void Prefix() => RecorderProbe.Enter("RitePanelShowController.OnClose");
        private static void Postfix() => RecorderProbe.Exit("RitePanelShowController.OnClose");
    }

    [HarmonyPatch(typeof(CardController), nameof(CardController.CardEquip))]
    internal static class CardEquipPatch
    {
        private static void Prefix(CardController __instance, CardController rightController)
        {
            var data = new Dictionary<string, object>();
            try { data["characterUid"] = __instance?.card?.uid; } catch { /* optional */ }
            try { data["characterId"] = __instance?.card?.id; } catch { /* optional */ }
            try { data["itemUid"] = rightController?.card?.uid; } catch { /* optional */ }
            try { data["itemId"] = rightController?.card?.id; } catch { /* optional */ }
            RecorderProbe.Enter("CardController.CardEquip", data);
        }

        private static void Postfix(CardController __instance, CardController rightController, bool __result)
        {
            var data = new Dictionary<string, object>();
            try { data["characterUid"] = __instance?.card?.uid; } catch { /* optional */ }
            try { data["itemUid"] = rightController?.card?.uid; } catch { /* optional */ }
            data["result"] = __result;
            RecorderProbe.Exit("CardController.CardEquip", data);
        }
    }

    [HarmonyPatch(typeof(CardController), nameof(CardController.RemoveFromSlot))]
    internal static class CardRemoveFromSlotPatch
    {
        private static void Prefix(CardController __instance)
        {
            var data = new Dictionary<string, object>();
            try { data["itemUid"] = __instance?.card?.uid; } catch { /* optional */ }
            try { data["itemId"] = __instance?.card?.id; } catch { /* optional */ }
            try { data["canRemove"] = __instance?.CanRemoveFromSlot(); } catch { /* optional */ }
            RecorderProbe.Enter("CardController.RemoveFromSlot", data);
        }

        private static void Postfix(CardController __instance)
        {
            var data = new Dictionary<string, object>();
            try { data["itemUid"] = __instance?.card?.uid; } catch { /* optional */ }
            RecorderProbe.Exit("CardController.RemoveFromSlot", data);
        }
    }

    [HarmonyPatch(typeof(GameController), nameof(GameController.DoIThink))]
    internal static class GameDoIThinkPatch
    {
        private static void Prefix()
        {
            Card card = null;
            try { card = GameBindings.Player?.ithink_card; } catch { /* optional */ }
            RecorderProbe.Enter("GameController.DoIThink", RecorderProbe.ThinkSnapshot(card));
        }

        private static void Postfix()
        {
            Card card = null;
            try { card = GameBindings.Player?.ithink_card; } catch { /* optional */ }
            RecorderProbe.Exit("GameController.DoIThink", RecorderProbe.ThinkSnapshot(card));
        }
    }

    [HarmonyPatch(typeof(RiteResultPanelController), nameof(RiteResultPanelController.OnPointerClick))]
    internal static class RiteResultOnPointerClickPatch
    {
        private static void Prefix(PointerEventData eventData)
        {
            var data = RecorderProbe.RiteResultSnapshot();
            try
            {
                data["pointerX"] = eventData?.position.x;
                data["pointerY"] = eventData?.position.y;
                data["pointerButton"] = eventData?.button.ToString();
            }
            catch { /* optional */ }
            RecorderProbe.Enter("RiteResultPanelController.OnPointerClick", data);
        }

        private static void Postfix()
        {
            RecorderProbe.Exit(
                "RiteResultPanelController.OnPointerClick",
                RecorderProbe.RiteResultSnapshot());
        }
    }

    [HarmonyPatch(typeof(RiteResultPanelController), nameof(RiteResultPanelController.OnNext))]
    internal static class RiteResultOnNextPatch
    {
        private static void Prefix() =>
            RecorderProbe.Enter("RiteResultPanelController.OnNext", RecorderProbe.RiteResultSnapshot());

        private static void Postfix() =>
            RecorderProbe.Exit("RiteResultPanelController.OnNext", RecorderProbe.RiteResultSnapshot());
    }

    [HarmonyPatch(typeof(RiteResultPanelController), "DoNext")]
    internal static class RiteResultDoNextPatch
    {
        private static void Prefix() =>
            RecorderProbe.Enter("RiteResultPanelController.DoNext", RecorderProbe.RiteResultSnapshot());

        private static void Postfix() =>
            RecorderProbe.Exit("RiteResultPanelController.DoNext", RecorderProbe.RiteResultSnapshot());
    }

    [HarmonyPatch(typeof(SudanBreakerNewController), nameof(SudanBreakerNewController.OnPointerClick))]
    internal static class SudanBreakerOnPointerClickPatch
    {
        private static void Prefix()
        {
            var data = RecorderProbe.RiteResultSnapshot();
            try
            {
                var breaker = GameBindings.Controller?.SudanBreakerController;
                data["sudanBreakerActive"] = breaker != null && GameBindings.IsUiActive(breaker);
                data["sudanBreakerWaiting"] = GameBindings.IsSudanBreakerWaiting;
            }
            catch { /* optional */ }
            RecorderProbe.Enter("SudanBreakerNewController.OnPointerClick", data);
        }

        private static void Postfix()
        {
            var data = RecorderProbe.RiteResultSnapshot();
            try { data["sudanBreakerWaiting"] = GameBindings.IsSudanBreakerWaiting; }
            catch { /* optional */ }
            RecorderProbe.Exit("SudanBreakerNewController.OnPointerClick", data);
        }
    }

    [HarmonyPatch(typeof(SudanBoxController), nameof(SudanBoxController.OnPointerClick))]
    internal static class SudanBoxOnPointerClickPatch
    {
        private static void Prefix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Enter("SudanBoxController.OnPointerClick", RecorderProbe.SudanSnapshot());
        }

        private static void Postfix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Exit("SudanBoxController.OnPointerClick", RecorderProbe.SudanSnapshot());
        }
    }

    [HarmonyPatch(typeof(WizardController), nameof(WizardController.RedrawSudanCard))]
    internal static class WizardRedrawSudanCardPatch
    {
        private static void Prefix(Card card)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.SudanSnapshot();
            try
            {
                if (card != null)
                {
                    data["cardUid"] = card.uid;
                    data["cardId"] = card.id;
                }
            }
            catch { /* optional */ }
            RecorderProbe.Enter("WizardController.RedrawSudanCard", data);
        }

        private static void Postfix(Card card)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.SudanSnapshot();
            try
            {
                if (card != null)
                {
                    data["cardUid"] = card.uid;
                    data["cardId"] = card.id;
                }
            }
            catch { /* optional */ }
            RecorderProbe.Exit("WizardController.RedrawSudanCard", data);
        }
    }

    [HarmonyPatch(typeof(GameController), nameof(GameController.OnPrevRound))]
    internal static class GameOnPrevRoundPatch
    {
        private static void Prefix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Enter("GameController.OnPrevRound", RecorderProbe.SudanSnapshot());
        }

        private static void Postfix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Exit("GameController.OnPrevRound", RecorderProbe.SudanSnapshot());
        }
    }

    [HarmonyPatch(typeof(GameController), nameof(GameController.OnNextRound))]
    internal static class GameOnNextRoundPatch
    {
        private static void Prefix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Enter("GameController.OnNextRound", RecorderProbe.SudanSnapshot());
        }

        private static void Postfix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Exit("GameController.OnNextRound", RecorderProbe.SudanSnapshot());
        }
    }

    [HarmonyPatch(typeof(OptionController), nameof(OptionController.OnConfirm))]
    internal static class OptionOnConfirmPatch
    {
        private static void Prefix(OptionController __instance)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Enter("OptionController.OnConfirm", OptionSnapshot(__instance));
        }

        private static void Postfix(OptionController __instance)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Exit("OptionController.OnConfirm", OptionSnapshot(__instance));
        }

        private static Dictionary<string, object> OptionSnapshot(OptionController option)
        {
            var data = new Dictionary<string, object>();
            try { data["optionIndex"] = option?.CurrentOptionIndex; } catch { /* optional */ }
            try
            {
                var current = option?.CurrentOption;
                if (current != null && !string.IsNullOrEmpty(current.text))
                {
                    data["optionText"] = current.text;
                }
            }
            catch { /* optional */ }

            if (!data.ContainsKey("optionText") || data["optionText"] == null)
            {
                try
                {
                    var idx = option != null ? option.CurrentOptionIndex : -1;
                    if (option?.Options != null && idx >= 0 && idx < option.Options.childCount)
                    {
                        var child = option.Options.GetChild(idx);
                        var tmp = child != null ? child.GetComponentInChildren<TMPro.TMP_Text>(true) : null;
                        if (tmp != null && !string.IsNullOrEmpty(tmp.text))
                        {
                            data["optionText"] = tmp.text;
                        }
                    }
                }
                catch { /* optional */ }
            }

            try
            {
                data["optionCount"] = option?.Options != null ? option.Options.childCount : 0;
            }
            catch { /* optional */ }
            return data;
        }
    }

    [HarmonyPatch(typeof(ConfirmController), nameof(ConfirmController.OnConfirm))]
    internal static class ConfirmOnConfirmPatch
    {
        private static void Prefix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Enter("ConfirmController.OnConfirm", new Dictionary<string, object>());
        }

        private static void Postfix()
        {
            if (!RecorderProbe.IsRecordingActive) return;
            RecorderProbe.Exit("ConfirmController.OnConfirm", new Dictionary<string, object>());
        }
    }

    [HarmonyPatch(typeof(CardController), nameof(CardController.CardSplit))]
    internal static class CardSplitPatch
    {
        private static void Prefix(CardController __instance, int count)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.CardInfo(__instance?.card);
            data["splitCount"] = count;
            try { data["stackCountBefore"] = __instance?.card != null ? Math.Max(1, __instance.card.count) : null; }
            catch { /* optional */ }
            RecorderProbe.Enter("CardController.CardSplit", data);
        }

        private static void Postfix(CardController __instance, int count, Card __result)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = RecorderProbe.CardInfo(__result ?? __instance?.card);
            data["splitCount"] = count;
            try { data["splitResultUid"] = __result?.uid; } catch { /* optional */ }
            try { data["splitResultCount"] = __result != null ? Math.Max(1, __result.count) : null; }
            catch { /* optional */ }
            RecorderProbe.Exit("CardController.CardSplit", data);
        }
    }

    [HarmonyPatch(typeof(RiteController), nameof(RiteController.OnSubmit))]
    internal static class RiteControllerOnSubmitPatch
    {
        private static void Prefix(RiteController __instance)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = new Dictionary<string, object>();
            try
            {
                data["riteUid"] = __instance?.rite?.uid;
                data["riteId"] = __instance?.rite?.id;
                data["riteName"] = RecorderProbe.SafeRiteNamePublic(__instance?.rite);
            }
            catch { /* optional */ }
            RecorderProbe.Enter("RiteController.OnSubmit", data);
        }

        private static void Postfix(RiteController __instance)
        {
            if (!RecorderProbe.IsRecordingActive) return;
            var data = new Dictionary<string, object>();
            try
            {
                data["riteUid"] = __instance?.rite?.uid;
                data["riteId"] = __instance?.rite?.id;
                data["riteName"] = RecorderProbe.SafeRiteNamePublic(__instance?.rite);
            }
            catch { /* optional */ }
            RecorderProbe.Exit("RiteController.OnSubmit", data);
        }
    }

#endif
}
