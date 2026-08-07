using System;
using UnityEngine;

namespace VibeSultan.Sultan.Observer
{
    public sealed class ObserverHost : MonoBehaviour
    {
        public static long TickCount;

        public ObserverHost(IntPtr ptr) : base(ptr)
        {
        }

        private void Awake()
        {
            UnityEngine.Object.DontDestroyOnLoad(gameObject);
        }

        public void Update()
        {
            TickCount++;
            var hub = PluginContext.Hub;
            if (hub == null)
            {
                return;
            }

            try
            {
                if (TickCount == 1 || TickCount % 300 == 0)
                {
                    Plugin.EnsureHost("tick");
                    Plugin.Log?.LogInfo("ObserverHost.Update tick=" + TickCount);
                }

                PluginContext.ActionQueue?.TickMainThread(PluginContext.ActionExecutor);
                PluginContext.VersionGuard?.Refresh();
                hub.Tick(Time.unscaledTime, periodicIntervalSeconds: 0.5f);
                PluginContext.FileWriter?.WriteIfUpdated();
                try { PluginContext.Recorder?.PollThink(); }
                catch (Exception pollEx)
                {
                    Plugin.Log?.LogWarning("Recorder.PollThink failed: " + pollEx.Message);
                }
            }
            catch (Exception ex)
            {
                Plugin.Log?.LogWarning("ObserverHost.Update failed: " + ex.Message);
            }
        }
    }
}
