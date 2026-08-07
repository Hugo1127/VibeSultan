using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using BepInEx.Logging;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VibeSultan.Sultan.Observer.Action;
using VibeSultan.Sultan.Observer.Hud;
using VibeSultan.Sultan.Observer.State;

namespace VibeSultan.Sultan.Observer.Export
{
    public sealed class HttpStateServer : IDisposable
    {
        public const string Prefix = "http://127.0.0.1:17890/";

        private readonly StateHub _hub;
        private readonly ActionQueue _actionQueue;
        private readonly GameVersionGuard _versionGuard;
        private readonly ManualLogSource _log;
        private HttpListener _listener;
        private Thread _thread;
        private volatile bool _running;

        public bool IsRunning => _running;

        public HttpStateServer(StateHub hub, ActionQueue actionQueue, GameVersionGuard versionGuard, ManualLogSource log)
        {
            _hub = hub;
            _actionQueue = actionQueue;
            _versionGuard = versionGuard;
            _log = log;
        }

        public bool TryStart()
        {
            try
            {
                _listener = new HttpListener();
                _listener.Prefixes.Add(Prefix);
                _listener.Start();
                _running = true;
                _thread = new Thread(ListenLoop)
                {
                    IsBackground = true,
                    Name = "VibeSultan.HttpStateServer"
                };
                _thread.Start();
                _log.LogInfo("HTTP state server listening on " + Prefix);
                return true;
            }
            catch (Exception ex)
            {
                _running = false;
                _log.LogError("HTTP bind failed (file dump still works): " + ex.Message);
                try { _listener?.Close(); } catch { /* ignore */ }
                _listener = null;
                return false;
            }
        }

        private void ListenLoop()
        {
            while (_running && _listener != null && _listener.IsListening)
            {
                HttpListenerContext ctx = null;
                try
                {
                    ctx = _listener.GetContext();
                }
                catch (HttpListenerException)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    _log.LogWarning("HTTP accept error: " + ex.Message);
                    continue;
                }

                try
                {
                    Handle(ctx);
                }
                catch (Exception ex)
                {
                    _log.LogWarning("HTTP handle error: " + ex.Message);
                    try
                    {
                        ctx.Response.StatusCode = 500;
                        ctx.Response.Close();
                    }
                    catch { /* ignore */ }
                }
            }
        }

        private void Handle(HttpListenerContext ctx)
        {
            var path = ctx.Request.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant();
            if (string.IsNullOrEmpty(path))
            {
                path = "/";
            }

            if (path == "/health")
            {
                // Keep /health free of live IL2CPP calls — this runs on the HTTP thread.
                string unityVersion = null;
                try { unityVersion = _versionGuard?.Fingerprint?.Split('|')[0]; }
                catch { /* optional */ }
                var health = new Dictionary<string, object>
                {
                    ["ok"] = true,
                    ["plugin"] = Plugin.PluginName,
                    ["pluginVersion"] = Plugin.PluginVersion,
                    ["game"] = "sultan",
                    ["unity"] = unityVersion,
                    ["actions"] = true,
                    ["state"] = true,
                    ["scene"] = true,
                    ["decisionHud"] = true,
                    ["playerRecorder"] = PluginContext.Recorder != null,
                    ["recording"] = PluginContext.Recorder?.Active ?? false,
                    ["schemaVersion"] = 1,
                    ["sceneSchemaVersion"] = 1,
                    ["versionSafe"] = _versionGuard?.IsSafe ?? true,
                    ["fingerprint"] = _versionGuard?.Fingerprint,
                    ["versionDetail"] = _versionGuard?.Detail,
                    ["hostTicks"] = ObserverHost.TickCount,
                    ["hasInterop"] = State.GameBindings.HasInterop,
                    ["snapshotVersion"] = _hub.SnapshotVersion
                };
                WriteJson(ctx, 200, JsonConvert.SerializeObject(health));
                return;
            }

            if (path == "/state" && IsGet(ctx))
            {
                var views = CompactProjector.ParseViews(ctx.Request.Url.Query);
                var state = _hub.WaitForFreshState();
                var projected = CompactProjector.Project(state, views);
                WriteJson(ctx, 200, JsonConvert.SerializeObject(projected, new JsonSerializerSettings
                {
                    NullValueHandling = NullValueHandling.Ignore
                }));
                return;
            }

            if (path == "/scene" && IsGet(ctx))
            {
                var scene = _hub.WaitForFreshScene();
                WriteJson(ctx, 200, JsonConvert.SerializeObject(scene, new JsonSerializerSettings
                {
                    NullValueHandling = NullValueHandling.Ignore
                }));
                return;
            }

            if (path == "/actions" && IsPost(ctx))
            {
                HandleActions(ctx);
                return;
            }

            if (path == "/record/start" && IsPost(ctx))
            {
                var result = PluginContext.Recorder?.Start()
                             ?? new Dictionary<string, object>
                             {
                                 ["ok"] = false,
                                 ["error"] = "recorder_unavailable"
                             };
                WriteJson(ctx, 200, JsonConvert.SerializeObject(result));
                return;
            }

            if (path == "/record/status" && IsGet(ctx))
            {
                var result = PluginContext.Recorder?.Status()
                             ?? new Dictionary<string, object>
                             {
                                 ["ok"] = false,
                                 ["error"] = "recorder_unavailable"
                             };
                WriteJson(ctx, 200, JsonConvert.SerializeObject(result));
                return;
            }

            if (path == "/record/stop" && IsPost(ctx))
            {
                var result = PluginContext.Recorder?.Stop()
                             ?? new Dictionary<string, object>
                             {
                                 ["ok"] = false,
                                 ["error"] = "recorder_unavailable"
                             };
                WriteJson(ctx, 200, JsonConvert.SerializeObject(result));
                return;
            }

            if (path == "/record/latest" && IsGet(ctx))
            {
                var result = PluginContext.Recorder?.Latest()
                             ?? new Dictionary<string, object>
                             {
                                 ["ok"] = false,
                                 ["error"] = "recorder_unavailable"
                             };
                WriteJson(ctx, 200, JsonConvert.SerializeObject(result));
                return;
            }

            if (path == "/agent/decision" && IsPost(ctx))
            {
                HandleAgentDecision(ctx);
                return;
            }

            if (path == "/agent/llm_stats" && IsPost(ctx))
            {
                HandleAgentLlmStats(ctx);
                return;
            }

            WriteJson(ctx, 404, "{\"error\":\"not_found\"}");
        }

        private void HandleActions(HttpListenerContext ctx)
        {
            string body;
            using (var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding ?? Encoding.UTF8))
            {
                body = reader.ReadToEnd();
            }

            ActionBatchRequest request;
            try
            {
                request = JsonConvert.DeserializeObject<ActionBatchRequest>(body ?? "{}");
            }
            catch
            {
                WriteJson(ctx, 400, "{\"ok\":false,\"error\":\"invalid_json\"}");
                return;
            }

            var actions = request?.actions ?? new List<Newtonsoft.Json.Linq.JObject>();
            var stateBefore = _hub.GetCachedState();
            var before = _hub.GetCachedScene();
            var results = _actionQueue.EnqueueAndWait(actions, 10000);
            _hub.RequestRefresh();
            var after = _hub.WaitForFreshScene(2500);
            var stateAfter = _hub.WaitForFreshState(2500);

            // Wizard/guide UI transitions need another frame. Retry only the same op —
            // never rewrite prev_round into continue/draw (that burns sudan redraws).
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var needsRetry = false;
                for (var i = 0; i < results.Count && i < actions.Count; i++)
                {
                    var result = results[i];
                    if (result == null || result.ok) continue;
                    var op = result.op ?? actions[i]?.Value<string>("op");
                    if (string.Equals(op, "exchange_sudan_card", StringComparison.OrdinalIgnoreCase)
                        && IsTransientExchangeError(result.error))
                    {
                        needsRetry = true;
                        break;
                    }
                    if (string.Equals(op, "prev_round", StringComparison.OrdinalIgnoreCase)
                        && IsTransientPrevRoundError(result.error))
                    {
                        needsRetry = true;
                        break;
                    }
                    if (string.Equals(op, "close_sudan_box", StringComparison.OrdinalIgnoreCase)
                        && string.Equals(result.error, "sudan_box_still_open", StringComparison.Ordinal))
                    {
                        needsRetry = true;
                        break;
                    }
                }
                if (!needsRetry) break;

                Thread.Sleep(150);
                _hub.RequestRefresh();
                after = _hub.WaitForFreshScene(800);
                stateAfter = _hub.WaitForFreshState(800);

                for (var i = 0; i < results.Count && i < actions.Count; i++)
                {
                    var result = results[i];
                    if (result == null || result.ok) continue;
                    var op = result.op ?? actions[i]?.Value<string>("op");
                    var retryable =
                        (string.Equals(op, "exchange_sudan_card", StringComparison.OrdinalIgnoreCase)
                         && IsTransientExchangeError(result.error))
                        || (string.Equals(op, "prev_round", StringComparison.OrdinalIgnoreCase)
                            && IsTransientPrevRoundError(result.error))
                        || (string.Equals(op, "close_sudan_box", StringComparison.OrdinalIgnoreCase)
                            && string.Equals(result.error, "sudan_box_still_open", StringComparison.Ordinal));
                    if (!retryable) continue;
                    var retry = _actionQueue.EnqueueAndWait(
                        new List<JObject> { actions[i] },
                        10000);
                    if (retry != null && retry.Count > 0) results[i] = retry[0];
                }
                _hub.RequestRefresh();
                after = _hub.WaitForFreshScene(2500);
                stateAfter = _hub.WaitForFreshState(2500);
            }

            if (HasExchangeAction(actions) && !ExchangeApplied(stateBefore, stateAfter))
            {
                var exchangeDeadline = Environment.TickCount + 1800;
                while (!ExchangeApplied(stateBefore, stateAfter)
                       && Environment.TickCount < exchangeDeadline)
                {
                    Thread.Sleep(50);
                    _hub.RequestRefresh();
                    after = _hub.WaitForFreshScene(300);
                    stateAfter = _hub.WaitForFreshState(300);
                }
            }

            var diff = SceneDiffer.Compare(before, after);
            var stateDelta = StateDiffer.Compare(stateBefore, stateAfter);
            if (!diff.changed && !StateDeltaChanged(stateDelta) && HasMutatingAction(actions))
            {
                var transitionDeadline = Environment.TickCount + 1200;
                while (!diff.changed && !StateDeltaChanged(stateDelta) && Environment.TickCount < transitionDeadline)
                {
                    Thread.Sleep(50);
                    after = _hub.WaitForFreshScene(300);
                    stateAfter = _hub.WaitForFreshState(300);
                    diff = SceneDiffer.Compare(before, after);
                    stateDelta = StateDiffer.Compare(stateBefore, stateAfter);
                }
            }

            if (ExchangeApplied(stateBefore, stateAfter))
            {
                foreach (var result in results)
                {
                    if (result?.op != "exchange_sudan_card") continue;
                    result.ok = true;
                    result.error = null;
                    result.result = "success";
                    result.detail = (result.detail ?? "exchange_sudan_card")
                                    + " | verified_after_refresh";
                }
            }
            if (diff.changes == null) diff.changes = new Dictionary<string, object>();
            if (StateDeltaChanged(stateDelta))
            {
                diff.changes["state"] = stateDelta;
                if (!diff.changed)
                {
                    diff.changed = true;
                    diff.result = "success";
                }
            }
            var ok = true;
            foreach (var r in results)
            {
                if (!r.ok) ok = false;
                ApplyDiff(r, diff);
                r.stateDelta = stateDelta;
            }

            WriteJson(ctx, 200, JsonConvert.SerializeObject(new ActionBatchResponse
            {
                ok = ok,
                results = results,
                sceneBeforeVersion = diff.sceneBeforeVersion,
                sceneAfterVersion = diff.sceneAfterVersion,
                screenChanged = diff.screenChanged,
                changes = diff.changes,
                stateDelta = stateDelta,
                forceReobserve = results.Exists(r => r.forceReobserve == true)
            }));
        }

        private static bool IsTransientExchangeError(string error)
        {
            return string.Equals(error, "exchange_dropper_not_entered", StringComparison.Ordinal)
                   || string.Equals(error, "exchange_drop_failed", StringComparison.Ordinal)
                   || string.Equals(error, "wizard_opening", StringComparison.Ordinal)
                   || string.Equals(error, "wizard_not_open", StringComparison.Ordinal)
                   || string.Equals(error, "exchange_button_missing", StringComparison.Ordinal)
                   || string.Equals(error, "exchange_ui_settling", StringComparison.Ordinal);
        }

        private static bool IsTransientPrevRoundError(string error)
        {
            return string.Equals(error, "guide_dismissing", StringComparison.Ordinal)
                   || string.Equals(error, "blocked_by_modal", StringComparison.Ordinal);
        }

        private static bool HasExchangeAction(List<JObject> actions)
        {
            if (actions == null) return false;
            foreach (var action in actions)
            {
                if (string.Equals(
                        action?.Value<string>("op"),
                        "exchange_sudan_card",
                        StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static bool ExchangeApplied(GameState before, GameState after)
        {
            try
            {
                var beforeValues = before?.values != null ? JObject.FromObject(before.values) : null;
                var afterValues = after?.values != null ? JObject.FromObject(after.values) : null;
                var beforeSudan = beforeValues?["sudan"] as JObject;
                var afterSudan = afterValues?["sudan"] as JObject;
                if (beforeSudan == null || afterSudan == null) return false;

                var beforeTimes = beforeSudan.Value<int?>("redrawTimes");
                var afterTimes = afterSudan.Value<int?>("redrawTimes");
                var beforeCard = beforeSudan["currentCard"];
                var afterCard = afterSudan["currentCard"];
                return beforeTimes.HasValue
                       && afterTimes.HasValue
                       && afterTimes.Value > beforeTimes.Value
                       && !JToken.DeepEquals(beforeCard, afterCard);
            }
            catch
            {
                return false;
            }
        }

        private static bool StateDeltaChanged(Dictionary<string, object> stateDelta)
        {
            if (stateDelta == null) return false;
            if (stateDelta.TryGetValue("changed", out var flag) && flag is bool b) return b;
            return stateDelta.Count > 1;
        }

        private static bool HasMutatingAction(List<Newtonsoft.Json.Linq.JObject> actions)
        {
            foreach (var action in actions)
            {
                var op = action?.Value<string>("op");
                if (!string.Equals(op, "noop", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(op, "probe_types", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static void ApplyDiff(ActionResultDto result, SceneDiff diff)
        {
            if (result == null || diff == null) return;
            result.sceneBeforeVersion = diff.sceneBeforeVersion;
            result.sceneAfterVersion = diff.sceneAfterVersion;
            result.screenChanged = diff.screenChanged;
            result.changes = diff.changes;

            if (!result.ok)
            {
                result.result = "failed";
                result.forceReobserve = true;
                return;
            }

            if (string.Equals(result.op, "noop", StringComparison.OrdinalIgnoreCase)
                || string.Equals(result.op, "probe_types", StringComparison.OrdinalIgnoreCase))
            {
                result.result = "success";
                result.forceReobserve = false;
                return;
            }

            if (!string.IsNullOrEmpty(result.detail)
                && result.detail.IndexOf("accepted_before_scene_load", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                result.result = "accepted";
                result.forceReobserve = true;
                return;
            }

            result.result = diff.result;
            result.forceReobserve = !diff.changed;
            if (!diff.changed && string.IsNullOrEmpty(result.error))
            {
                result.error = "no_effect";
            }
        }

        private void HandleAgentDecision(HttpListenerContext ctx)
        {
            string body;
            using (var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding ?? Encoding.UTF8))
            {
                body = reader.ReadToEnd();
            }

            try
            {
                var decision = JsonConvert.DeserializeObject<AgentDecisionDto>(body ?? "{}");
                if (decision == null || string.IsNullOrWhiteSpace(decision.title))
                {
                    WriteJson(ctx, 400, "{\"ok\":false,\"error\":\"missing_title\"}");
                    return;
                }

                AgentDecisionBoard.Instance.Push(decision);
                WriteJson(ctx, 200, "{\"ok\":true}");
            }
            catch (Exception ex)
            {
                WriteJson(ctx, 400, JsonConvert.SerializeObject(new { ok = false, error = ex.Message }));
            }
        }

        private void HandleAgentLlmStats(HttpListenerContext ctx)
        {
            string body;
            using (var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding ?? Encoding.UTF8))
            {
                body = reader.ReadToEnd();
            }

            try
            {
                var stats = JsonConvert.DeserializeObject<AgentLlmStatsDto>(body ?? "{}");
                AgentLlmStatsBoard.Instance.Update(stats);
                WriteJson(ctx, 200, "{\"ok\":true}");
            }
            catch (Exception ex)
            {
                WriteJson(ctx, 400, JsonConvert.SerializeObject(new { ok = false, error = ex.Message }));
            }
        }

        private static bool IsGet(HttpListenerContext ctx) =>
            string.Equals(ctx.Request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase);

        private static bool IsPost(HttpListenerContext ctx) =>
            string.Equals(ctx.Request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase);

        private static void WriteJson(HttpListenerContext ctx, int status, string json)
        {
            var bytes = Encoding.UTF8.GetBytes(json ?? "{}");
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.ContentEncoding = Encoding.UTF8;
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            ctx.Response.Close();
        }

        public void Dispose()
        {
            _running = false;
            try { _listener?.Stop(); } catch { /* ignore */ }
            try { _listener?.Close(); } catch { /* ignore */ }
            _listener = null;
        }
    }

    public sealed class AgentDecisionDto
    {
        public int? step { get; set; }
        public string title { get; set; }
        public string goal { get; set; }
        public List<string> actions { get; set; }
        public string why { get; set; }
        public string thinking { get; set; }
        public string mood { get; set; }
    }

    public sealed class AgentLlmStatsDto
    {
        public int? step { get; set; }
        public int? totalTokens { get; set; }
        public int? prefillTokens { get; set; }
        public int? decodeTokens { get; set; }
        public double? prefillTokPerSec { get; set; }
        public double? decodeTokPerSec { get; set; }
        public int? elapsedMs { get; set; }
        public int? firstTokenMs { get; set; }
    }
}
