using System;
using System.Collections.Generic;

namespace VibeSultan.Sultan.Observer.State
{
    public sealed class GameState
    {
        public int schemaVersion { get; set; } = 1;
        public string game { get; set; } = "sultan";
        public string capturedAt { get; set; }
        public UnityInfo unity { get; set; } = new UnityInfo();
        public ScreenInfo screen { get; set; } = new ScreenInfo();
        public bool terminal { get; set; }
        public Dictionary<string, object> values { get; set; } = new Dictionary<string, object>();
        public List<ActionInfo> actions { get; set; } = new List<ActionInfo>();
        public Dictionary<string, object> raw { get; set; } = new Dictionary<string, object>();

        public static GameState CreateEmpty()
        {
            return new GameState
            {
                schemaVersion = 1,
                game = "sultan",
                capturedAt = DateTimeOffset.Now.ToString("o"),
                unity = new UnityInfo { version = "unknown", frame = 0 },
                screen = new ScreenInfo { id = "unknown", name = "Unknown", phase = "Unknown" },
                values = new Dictionary<string, object>(),
                actions = new List<ActionInfo>(),
                raw = new Dictionary<string, object>()
            };
        }
    }

    public sealed class UnityInfo
    {
        public string version { get; set; }
        public int frame { get; set; }
        public string productName { get; set; }
    }

    public sealed class ScreenInfo
    {
        public string id { get; set; }
        public string name { get; set; }
        public string phase { get; set; }
    }

    public sealed class ActionInfo
    {
        public string id { get; set; }
        public string label { get; set; }
        public bool enabled { get; set; }
        public string reason { get; set; }
        public Dictionary<string, object> paramsHint { get; set; }
    }
}
