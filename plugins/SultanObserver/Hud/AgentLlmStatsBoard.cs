using VibeSultan.Sultan.Observer.Export;

namespace VibeSultan.Sultan.Observer.Hud
{
    public sealed class AgentLlmStatsBoard
    {
        public static readonly AgentLlmStatsBoard Instance = new AgentLlmStatsBoard();
        private readonly object _gate = new object();
        private AgentLlmStatsDto _stats;

        public void Update(AgentLlmStatsDto stats)
        {
            lock (_gate)
            {
                _stats = stats;
            }
        }

        public AgentLlmStatsDto Snapshot()
        {
            lock (_gate)
            {
                return _stats;
            }
        }
    }
}
