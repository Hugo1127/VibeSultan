using System;
using System.Threading;
using UnityEngine;

namespace VibeSultan.Sultan.Observer.State
{
    public sealed class StateHub
    {
        private readonly object _gate = new object();
        private readonly StateReader _reader = new StateReader();
        private readonly UiAdapterRegistry _uiRegistry = new UiAdapterRegistry();
        private readonly SemanticUiScanner _uiScanner;

        private GameState _cachedState;
        private SceneSnapshot _cachedScene;
        private string _cachedJsonCompact = "{}";
        private string _cachedJsonIndented = "{}";
        private long _snapshotVersion;
        private long _sceneVersion;
        private long _sceneCaptureGeneration;
        private bool _forceRefresh;
        private float _nextPeriodicCapture;

        public StateHub()
        {
            _uiScanner = new SemanticUiScanner(_uiRegistry);
        }

        public UiAdapterRegistry UiRegistry => _uiRegistry;

        public long SnapshotVersion
        {
            get
            {
                lock (_gate)
                {
                    return _snapshotVersion;
                }
            }
        }

        public string GetCachedJson(bool indented)
        {
            lock (_gate)
            {
                return indented ? _cachedJsonIndented : _cachedJsonCompact;
            }
        }

        public GameState GetCachedState()
        {
            lock (_gate)
            {
                return _cachedState ?? GameState.CreateEmpty();
            }
        }

        public SceneSnapshot GetCachedScene()
        {
            lock (_gate)
            {
                return _cachedScene ?? new SceneSnapshot
                {
                    snapshotVersion = _sceneVersion,
                    capturedAt = DateTimeOffset.Now.ToString("o"),
                    scene = new SceneDescriptor { id = "unknown", phase = "unknown" }
                };
            }
        }

        public void RequestRefresh()
        {
            lock (_gate)
            {
                _forceRefresh = true;
            }
        }

        public GameState WaitForFreshState(int timeoutMs = 2000)
        {
            long versionBefore;
            lock (_gate)
            {
                versionBefore = _snapshotVersion;
                _forceRefresh = true;
            }

            var deadline = Environment.TickCount + timeoutMs;
            while (Environment.TickCount < deadline)
            {
                long version;
                GameState state;
                lock (_gate)
                {
                    version = _snapshotVersion;
                    state = _cachedState;
                }

                if (version > versionBefore && state != null)
                {
                    return state;
                }

                Thread.Sleep(10);
            }

            // Never call CaptureNow() here: WaitForFreshState runs on the HTTP listener
            // thread. Touching IL2CPP (GameApplication.global / Card.*, etc.) off the
            // Unity main thread can AccessViolation and kill the process.
            // Return empty/cached state until ObserverHost.Tick captures on main thread.
            return GetCachedState();
        }

        public SceneSnapshot WaitForFreshScene(int timeoutMs = 2000)
        {
            long generationBefore;
            lock (_gate)
            {
                generationBefore = _sceneCaptureGeneration;
            }
            RequestRefresh();
            var deadline = Environment.TickCount + timeoutMs;
            while (Environment.TickCount < deadline)
            {
                lock (_gate)
                {
                    if (_sceneCaptureGeneration > generationBefore && _cachedScene != null)
                    {
                        return _cachedScene;
                    }
                }
                Thread.Sleep(10);
            }
            return GetCachedScene();
        }

        public void Tick(float unscaledTime, float periodicIntervalSeconds = 0.5f)
        {
            bool shouldCapture;
            lock (_gate)
            {
                shouldCapture = _forceRefresh || unscaledTime >= _nextPeriodicCapture;
                if (shouldCapture)
                {
                    _forceRefresh = false;
                    _nextPeriodicCapture = unscaledTime + periodicIntervalSeconds;
                }
            }

            if (!shouldCapture)
            {
                return;
            }

            CaptureNow();
        }

        public GameState CaptureNow()
        {
            GameState state;
            SceneSnapshot scene = null;
            try
            {
                state = _reader.Read();
            }
            catch (Exception ex)
            {
                state = GameState.CreateEmpty();
                state.unity.version = Application.unityVersion;
                state.unity.frame = Time.frameCount;
                state.raw["error"] = "capture_failed";
                state.raw["exception"] = ex.GetType().Name + ": " + ex.Message;
                Plugin.Log?.LogWarning("State capture failed: " + ex);
            }

            long nextVersion;
            lock (_gate)
            {
                nextVersion = _sceneVersion + 1;
            }
            try
            {
                scene = _uiScanner.Capture(state, nextVersion);
            }
            catch (Exception ex)
            {
                scene = new SceneSnapshot
                {
                    snapshotVersion = nextVersion,
                    capturedAt = DateTimeOffset.Now.ToString("o"),
                    scene = new SceneDescriptor
                    {
                        id = state?.screen?.id,
                        name = state?.screen?.name,
                        phase = state?.screen?.phase
                    }
                };
                scene.diagnostics["captureError"] = ex.GetType().Name + ": " + ex.Message;
                Plugin.Log?.LogWarning("Semantic UI capture failed: " + ex.Message);
            }

            var compact = StateSerializer.ToJson(state, indented: false);
            var indentedJson = StateSerializer.ToJson(state, indented: true);

            lock (_gate)
            {
                var sceneChanged = _cachedScene == null || SceneDiffer.Compare(_cachedScene, scene).changed;
                if (sceneChanged)
                {
                    _sceneVersion = nextVersion;
                    _uiRegistry.CommitSnapshot(nextVersion, _sceneVersion);
                }
                else
                {
                    _uiRegistry.CommitSnapshot(nextVersion, _sceneVersion);
                    scene.snapshotVersion = _sceneVersion;
                }
                _cachedState = state;
                _cachedScene = scene;
                _cachedJsonCompact = compact;
                _cachedJsonIndented = indentedJson;
                _snapshotVersion++;
                _sceneCaptureGeneration++;
            }

            return state;
        }
    }
}
