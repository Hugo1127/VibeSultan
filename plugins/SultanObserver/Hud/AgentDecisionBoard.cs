using System.Collections.Generic;
using VibeSultan.Sultan.Observer.Export;

namespace VibeSultan.Sultan.Observer.Hud
{
    public sealed class AgentDecisionHudItem
    {
        public AgentDecisionDto decision { get; set; }
        public AgentLlmStatsDto stats { get; set; }
    }

    public sealed class AgentDecisionBoard
    {
        public static readonly AgentDecisionBoard Instance = new AgentDecisionBoard();
        private readonly object _gate = new object();
        private readonly List<AgentDecisionHudItem> _items = new List<AgentDecisionHudItem>();

        public void Push(AgentDecisionDto decision)
        {
            lock (_gate)
            {
                _items.Add(new AgentDecisionHudItem
                {
                    decision = decision,
                    // Stats are published immediately before the decision, so capture
                    // the current snapshot to keep each bubble's footer stable.
                    stats = AgentLlmStatsBoard.Instance.Snapshot(),
                });
                while (_items.Count > 4)
                {
                    _items.RemoveAt(0);
                }
            }
        }

        public List<AgentDecisionHudItem> Snapshot()
        {
            lock (_gate)
            {
                return new List<AgentDecisionHudItem>(_items);
            }
        }
    }
}
