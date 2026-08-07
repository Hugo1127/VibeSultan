using VibeSultan.Sultan.Observer.Action;
using VibeSultan.Sultan.Observer.Export;
using VibeSultan.Sultan.Observer.Recording;
using VibeSultan.Sultan.Observer.State;

namespace VibeSultan.Sultan.Observer
{
    /// <summary>
    /// Static wiring so Il2Cpp MonoBehaviour instances can find shared services.
    /// </summary>
    public static class PluginContext
    {
        public static StateHub Hub;
        public static ActionQueue ActionQueue;
        public static ActionExecutor ActionExecutor;
        public static StateFileWriter FileWriter;
        public static GameVersionGuard VersionGuard;
        public static PlayerActionRecorder Recorder;
    }
}
