using Newtonsoft.Json;

namespace VibeSultan.Sultan.Observer.State
{
    public static class StateSerializer
    {
        private static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            NullValueHandling = NullValueHandling.Ignore,
            Formatting = Formatting.None
        };

        private static readonly JsonSerializerSettings IndentedSettings = new JsonSerializerSettings
        {
            NullValueHandling = NullValueHandling.Ignore,
            Formatting = Formatting.Indented
        };

        public static string ToJson(GameState state, bool indented = false)
        {
            return JsonConvert.SerializeObject(state, indented ? IndentedSettings : Settings);
        }
    }
}
