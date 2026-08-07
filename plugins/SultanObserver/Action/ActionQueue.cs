using System;
using System.Collections.Generic;
using System.Threading;
using Newtonsoft.Json.Linq;
using VibeSultan.Sultan.Observer;

namespace VibeSultan.Sultan.Observer.Action
{
    public sealed class ActionQueue
    {
        private readonly object _gate = new object();
        private readonly Queue<PendingBatch> _pending = new Queue<PendingBatch>();

        private sealed class PendingBatch
        {
            public List<JObject> Actions;
            public List<ActionResultDto> Results;
            public ManualResetEventSlim Done = new ManualResetEventSlim(false);
            public Exception Error;
        }

        public List<ActionResultDto> EnqueueAndWait(List<JObject> actions, int timeoutMs)
        {
            actions ??= new List<JObject>();

            // Only pure no-ops may run on the HTTP thread. Anything that touches
            // IL2CPP/Unity objects (including probe_types → SnapshotBindings) must
            // marshal to the main thread or it can AccessViolation and kill the process.
            if (actions.Count > 0 && actions.TrueForAll(IsThreadSafeOp))
            {
                try
                {
                    return PluginContext.ActionExecutor?.ExecuteBatch(actions)
                           ?? new List<ActionResultDto>
                           {
                               new ActionResultDto { ok = false, error = "executor_missing" }
                           };
                }
                catch (Exception ex)
                {
                    return new List<ActionResultDto>
                    {
                        new ActionResultDto
                        {
                            ok = false,
                            error = "executor_exception",
                            detail = ex.GetType().Name + ": " + ex.Message
                        }
                    };
                }
            }

            var item = new PendingBatch
            {
                Actions = actions
            };

            lock (_gate)
            {
                _pending.Enqueue(item);
            }

            if (!item.Done.Wait(timeoutMs))
            {
                return new List<ActionResultDto>
                {
                    new ActionResultDto
                    {
                        ok = false,
                        error = "timeout",
                        detail = "main_thread_did_not_process_within_" + timeoutMs + "ms"
                    }
                };
            }

            if (item.Error != null)
            {
                return new List<ActionResultDto>
                {
                    new ActionResultDto
                    {
                        ok = false,
                        error = "executor_exception",
                        detail = item.Error.GetType().Name + ": " + item.Error.Message
                    }
                };
            }

            return item.Results ?? new List<ActionResultDto>();
        }

        private static bool IsThreadSafeOp(JObject action)
        {
            var op = action?.Value<string>("op");
            return op == "noop";
        }

        private static bool IsSceneLoadOp(string op)
        {
            return op is "start_new_game" or "continue_game";
        }

        public void TickMainThread(ActionExecutor executor)
        {
            PendingBatch item = null;
            lock (_gate)
            {
                if (_pending.Count > 0)
                {
                    item = _pending.Dequeue();
                }
            }

            if (item == null)
            {
                return;
            }

            var actions = item.Actions ?? new List<JObject>();
            bool mayUnload = false;
            foreach (var action in actions)
            {
                if (IsSceneLoadOp(action?.Value<string>("op")))
                {
                    mayUnload = true;
                    break;
                }
            }

            // Scene loads can destroy this MonoBehaviour mid-call and skip finally.
            // Release the HTTP waiter first with an optimistic accepted result.
            if (mayUnload)
            {
                var optimistic = new List<ActionResultDto>();
                foreach (var action in actions)
                {
                    optimistic.Add(new ActionResultDto
                    {
                        op = action?.Value<string>("op"),
                        ok = true,
                        detail = "accepted_before_scene_load"
                    });
                }

                item.Results = optimistic;
                item.Done.Set();
                try
                {
                    executor.ExecuteBatch(actions);
                }
                catch (Exception ex)
                {
                    Plugin.Log?.LogWarning("Scene-load action failed after waiter release: " + ex);
                }

                Plugin.EnsureHost("after_scene_load_action");
                return;
            }

            try
            {
                var results = new List<ActionResultDto>();
                foreach (var action in actions)
                {
                    try
                    {
                        results.AddRange(executor.ExecuteBatch(new List<JObject> { action }));
                    }
                    catch (Exception ex)
                    {
                        results.Add(new ActionResultDto
                        {
                            op = action?.Value<string>("op"),
                            ok = false,
                            error = "executor_exception",
                            detail = ex.GetType().Name + ": " + ex.Message
                        });
                        Plugin.Log?.LogWarning("Action failed: " + ex);
                    }
                }

                item.Results = results;
            }
            catch (Exception ex)
            {
                item.Error = ex;
                Plugin.Log?.LogWarning("Action batch failed: " + ex);
            }
            finally
            {
                item.Done.Set();
            }
        }
    }
}
