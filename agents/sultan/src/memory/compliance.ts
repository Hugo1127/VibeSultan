import type { DecisionTrace } from "@vibesultan/agent-learning-core";

/** Heuristic: did the day window traces exercise the active tip/hypothesis? */
export function strategyExercised(opts: {
  topicKey?: string | null;
  decisionKey?: string | null;
  constraints?: string | null;
  traces: DecisionTrace[];
}): boolean {
  const keys = [
    opts.decisionKey,
    opts.topicKey,
    ...(opts.constraints ? opts.constraints.split(/[,，;；|]/) : []),
  ]
    .map((s) => (s ?? "").toLowerCase().trim())
    .filter((s) => s.length >= 3);

  if (keys.length === 0) return true;
  if (opts.traces.length === 0) return false;

  const blob = opts.traces
    .map((t) => `${t.decisionKey} ${t.action} ${t.rationale ?? ""}`)
    .join("\n")
    .toLowerCase();

  // Topic-specific affordance signals.
  if (opts.topicKey === "early_explore" || opts.topicKey === "map_scout_added") {
    return (
      /open_daily_news|inspect_card|open_rite|report_action_chain|observe_scene/.test(blob) &&
      opts.traces.length >= 2
    );
  }
  if (
    opts.topicKey === "rite_efficiency" ||
    opts.topicKey === "tier_match" ||
    opts.topicKey === "min_gold_cost"
  ) {
    return /place_card_on_rite|execute|open_rite/.test(blob);
  }
  if (opts.topicKey === "sudan_pressure" || opts.topicKey === "execution_timing") {
    return /select_event_option|execute|open_rite|draw_sudan_card/.test(blob);
  }
  if (opts.topicKey === "gold_dice_optional") {
    return /continue|select_gold_dice|confirm_gold_dice|cancel_gold_dice/.test(blob);
  }

  return keys.some((k) => blob.includes(k));
}
