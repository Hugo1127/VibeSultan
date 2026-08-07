using System;
using System.IO;
using BepInEx;
using BepInEx.Logging;
using VibeSultan.Sultan.Observer.State;

namespace VibeSultan.Sultan.Observer.Export
{
    public sealed class StateFileWriter
    {
        private readonly StateHub _hub;
        private readonly ManualLogSource _log;
        private readonly string _filePath;
        private long _lastWrittenVersion = -1;

        public string FilePath => _filePath;

        public StateFileWriter(StateHub hub, ManualLogSource log)
        {
            _hub = hub;
            _log = log;
            var dir = Path.Combine(Paths.PluginPath ?? "BepInEx/plugins", "VibeSultan");
            Directory.CreateDirectory(dir);
            _filePath = Path.Combine(dir, "state.json");
        }

        public void WriteIfUpdated()
        {
            var version = _hub.SnapshotVersion;
            if (version == _lastWrittenVersion || version == 0)
            {
                return;
            }

            try
            {
                var json = _hub.GetCachedJson(indented: true);
                File.WriteAllText(_filePath, json);
                _lastWrittenVersion = version;
            }
            catch (Exception ex)
            {
                _log.LogWarning("Failed to write state.json: " + ex.Message);
            }
        }
    }
}
