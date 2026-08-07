using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VibeSultan.Sultan.Observer.Action
{
    public sealed class ActionBatchRequest
    {
        [JsonProperty("actions")]
        public List<JObject> actions { get; set; }
    }

    public sealed class ActionResultDto
    {
        [JsonProperty("id")]
        public string id { get; set; }

        [JsonProperty("op")]
        public string op { get; set; }

        [JsonProperty("ok")]
        public bool ok { get; set; }

        [JsonProperty("error")]
        public string error { get; set; }

        [JsonProperty("detail")]
        public string detail { get; set; }

        [JsonProperty("result")]
        public string result { get; set; }

        [JsonProperty("sceneBeforeVersion")]
        public long? sceneBeforeVersion { get; set; }

        [JsonProperty("sceneAfterVersion")]
        public long? sceneAfterVersion { get; set; }

        [JsonProperty("screenChanged")]
        public bool? screenChanged { get; set; }

        [JsonProperty("changes")]
        public Dictionary<string, object> changes { get; set; }

        [JsonProperty("stateDelta")]
        public Dictionary<string, object> stateDelta { get; set; }

        [JsonProperty("forceReobserve")]
        public bool? forceReobserve { get; set; }
    }

    public sealed class ActionBatchResponse
    {
        [JsonProperty("results")]
        public List<ActionResultDto> results { get; set; }

        [JsonProperty("ok")]
        public bool ok { get; set; }

        [JsonProperty("sceneBeforeVersion")]
        public long? sceneBeforeVersion { get; set; }

        [JsonProperty("sceneAfterVersion")]
        public long? sceneAfterVersion { get; set; }

        [JsonProperty("screenChanged")]
        public bool screenChanged { get; set; }

        [JsonProperty("changes")]
        public Dictionary<string, object> changes { get; set; }

        [JsonProperty("stateDelta")]
        public Dictionary<string, object> stateDelta { get; set; }

        [JsonProperty("forceReobserve")]
        public bool forceReobserve { get; set; }
    }
}
