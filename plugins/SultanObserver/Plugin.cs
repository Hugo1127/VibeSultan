using System;
using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using Il2CppInterop.Runtime.Injection;
using UnityEngine;
using UnityEngine.SceneManagement;
using VibeSultan.Sultan.Observer.Action;
using VibeSultan.Sultan.Observer.Export;
using VibeSultan.Sultan.Observer.Hud;
using VibeSultan.Sultan.Observer.Recording;
using VibeSultan.Sultan.Observer.State;

namespace VibeSultan.Sultan.Observer
{
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    public class Plugin : BasePlugin
    {
        public const string PluginGuid = "com.vibesultan.sultan.observer";
        public const string PluginName = "VibeSultan Sultan Observer";
        public const string PluginVersion = "0.1.0";

        internal new static ManualLogSource Log;

        private HttpStateServer _http;
        private static GameObject _hostGo;
        private static GameObject _hudGo;
        private static bool _sceneHooked;

        public override void Load()
        {
            Log = base.Log;
            Log.LogInfo("Sultan Observer Load (IL2CPP) v" + PluginVersion);

            try
            {
                ClassInjector.RegisterTypeInIl2Cpp<ObserverHost>();
            }
            catch (Exception ex)
            {
                Log.LogWarning("Il2Cpp ObserverHost inject failed: " + ex.Message);
            }

            try
            {
                ClassInjector.RegisterTypeInIl2Cpp<AgentDecisionHud>();
            }
            catch (Exception ex)
            {
                Log.LogWarning("Il2Cpp AgentDecisionHud inject skipped (IMGUI interop): " + ex.Message);
            }

            var hub = new StateHub();
            var versionGuard = new GameVersionGuard();
            versionGuard.Refresh();
            var actionQueue = new ActionQueue();
            var actionExecutor = new ActionExecutor(versionGuard);
            var fileWriter = new StateFileWriter(hub, Log);
            PluginContext.Hub = hub;
            PluginContext.VersionGuard = versionGuard;
            PluginContext.ActionQueue = actionQueue;
            PluginContext.ActionExecutor = actionExecutor;
            PluginContext.FileWriter = fileWriter;
            var recorder = new PlayerActionRecorder(hub);
            PluginContext.Recorder = recorder;
            try
            {
                recorder.Install();
            }
            catch (Exception ex)
            {
                Log.LogWarning("PlayerActionRecorder patch install failed: " + ex.Message);
            }
            _http = new HttpStateServer(hub, actionQueue, versionGuard, Log);
            _http.TryStart();
            hub.RequestRefresh();

            EnsureHost("load");
            HookSceneLoaded();

            try
            {
                var probe = TypeProbe.Probe();
                Log.LogInfo("TypeProbe hitCount=" + (probe.TryGetValue("hitCount", out var c) ? c : 0));
            }
            catch (Exception ex)
            {
                Log.LogWarning("TypeProbe failed: " + ex.Message);
            }

            Log.LogInfo("VersionGuard safe=" + versionGuard.IsSafe + " fp=" + versionGuard.Fingerprint);
        }

        private static void HookSceneLoaded()
        {
            if (_sceneHooked) return;
            try
            {
                SceneManager.sceneLoaded += (UnityEngine.Events.UnityAction<Scene, LoadSceneMode>)OnSceneLoaded;
                _sceneHooked = true;
                Log.LogInfo("SceneManager.sceneLoaded hooked for ObserverHost survival");
            }
            catch (Exception ex)
            {
                Log.LogWarning("sceneLoaded hook failed: " + ex.Message);
            }
        }

        private static void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            EnsureHost("scene:" + scene.name);
        }

        internal static void EnsureHost(string reason)
        {
            try
            {
                if (_hostGo == null)
                {
                    _hostGo = GameObject.Find("VibeSultan.ObserverHost");
                }

                if (_hostGo == null)
                {
                    _hostGo = new GameObject("VibeSultan.ObserverHost");
                    UnityEngine.Object.DontDestroyOnLoad(_hostGo);
                    _hostGo.AddComponent<ObserverHost>();
                    Log?.LogInfo("ObserverHost created (" + reason + ")");
                }
                else if (_hostGo.GetComponent<ObserverHost>() == null)
                {
                    _hostGo.AddComponent<ObserverHost>();
                    Log?.LogInfo("ObserverHost re-attached (" + reason + ")");
                }

                if (_hudGo == null)
                {
                    _hudGo = GameObject.Find("VibeSultan.AgentDecisionHud");
                }

                if (_hudGo == null)
                {
                    try
                    {
                        _hudGo = new GameObject("VibeSultan.AgentDecisionHud");
                        UnityEngine.Object.DontDestroyOnLoad(_hudGo);
                        _hudGo.AddComponent<AgentDecisionHud>();
                    }
                    catch (Exception hudEx)
                    {
                        Log?.LogWarning("HUD attach skipped: " + hudEx.Message);
                    }
                }
            }
            catch (Exception ex)
            {
                Log?.LogWarning("EnsureHost failed (" + reason + "): " + ex.Message);
            }
        }

        public override bool Unload()
        {
            _http?.Dispose();
            _http = null;
            PluginContext.Recorder?.Dispose();
            PluginContext.Recorder = null;
            if (_hostGo != null)
            {
                UnityEngine.Object.Destroy(_hostGo);
                _hostGo = null;
            }

            if (_hudGo != null)
            {
                UnityEngine.Object.Destroy(_hudGo);
                _hudGo = null;
            }

            return true;
        }
    }
}
