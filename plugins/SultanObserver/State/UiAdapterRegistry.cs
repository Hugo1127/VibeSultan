using System;
using System.Collections.Generic;
#if GAME_INTEROP
using UnityEngine;
#endif

namespace VibeSultan.Sultan.Observer.State
{
    /// <summary>
    /// Per-snapshot whitelist of UI elements that may be invoked by click_element.
    /// Runtime Unity handles never leave the plugin process.
    /// </summary>
    public sealed class UiAdapterRegistry
    {
        public sealed class ElementHandle
        {
            public string elementId;
            public long snapshotVersion;
            public string mapsToOp;
            public Dictionary<string, object> actionParams;
            public bool visible;
            public bool interactable;
            public bool blocked;
#if GAME_INTEROP
            public GameObject gameObject;
            public System.Action click;
#endif
        }

        public sealed class ResolveResult
        {
            public ElementHandle handle;
            public string error;
        }

        private readonly object _gate = new object();
        private Dictionary<string, ElementHandle> _handles =
            new Dictionary<string, ElementHandle>(StringComparer.OrdinalIgnoreCase);
        private Dictionary<string, ElementHandle> _stagingHandles;
        private long _stagingVersion;
        private long _snapshotVersion;

        public long SnapshotVersion
        {
            get
            {
                lock (_gate) return _snapshotVersion;
            }
        }

        public void BeginSnapshot(long snapshotVersion)
        {
            lock (_gate)
            {
                _stagingVersion = snapshotVersion;
                _stagingHandles = new Dictionary<string, ElementHandle>(StringComparer.OrdinalIgnoreCase);
            }
        }

        public void Register(ElementHandle handle)
        {
            if (handle == null || string.IsNullOrWhiteSpace(handle.elementId)) return;
            lock (_gate)
            {
                if (_stagingHandles == null || handle.snapshotVersion != _stagingVersion) return;
                _stagingHandles[handle.elementId] = handle;
            }
        }

        public void CommitSnapshot(long fromVersion, long toVersion)
        {
            lock (_gate)
            {
                if (_stagingHandles == null || _stagingVersion != fromVersion) return;
                foreach (var handle in _stagingHandles.Values)
                {
                    handle.snapshotVersion = toVersion;
                }
                _handles = _stagingHandles;
                _stagingHandles = null;
                _stagingVersion = 0;
                _snapshotVersion = toVersion;
            }
        }

        public ResolveResult Resolve(string elementId, long snapshotVersion)
        {
            lock (_gate)
            {
                if (snapshotVersion != _snapshotVersion)
                {
                    return new ResolveResult { error = "stale_scene" };
                }
                if (string.IsNullOrWhiteSpace(elementId) || !_handles.TryGetValue(elementId, out var handle))
                {
                    return new ResolveResult { error = "element_not_found" };
                }
                if (!handle.visible)
                {
                    return new ResolveResult { error = "element_not_visible" };
                }
                if (!handle.interactable)
                {
                    return new ResolveResult { error = "not_interactable" };
                }
                if (handle.blocked)
                {
                    return new ResolveResult { error = "blocked_by_modal" };
                }
                return new ResolveResult { handle = handle };
            }
        }
    }
}
