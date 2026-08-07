/**
 * Host/planner preflight errors that must never become game negative evidence
 * or block rite explore as "contradicted".
 */
const HOST_ACTION_ERROR_CODES = new Set([
  "plan_single_step_only",
  "action_not_enabled",
  "rite_explore_signature_duplicate",
  "rite_explore_limit",
  "rite_explore_contradicted",
  "rite_explore_commit_locked",
  "rite_explore_branch_window",
  "failed_path_blacklist",
  "recovery_rewind_required",
  "day_close_hard_issue",
  "day_close_improvement_available",
  "day_close_blocked",
  "exchange_circuit_open",
  "sudan_break_path_ready",
  "sudan_break_deferred",
  "use_explicit_next_day",
  "missing_uid",
  "missing_slotIndex",
  "missing_optionIndex",
  "missing_elementId",
  "missing_characterUid",
  "missing_itemUid",
  "missing_snapshotVersion",
  "card_not_found",
  "character_not_found",
  "item_not_found",
  "option_out_of_range",
  "invalid_slotIndex",
  "tool_exception",
  "unknown_tool",
]);

const HOST_NOISE_SUMMARY_RE =
  /plan_single_step_only|action_not_enabled|rite_explore_|failed_path_blacklist|recovery_rewind_required|day_close_|exchange_circuit_open|sudan_break_path_ready|sudan_break_deferred|use_explicit_next_day|missing_|_not_found|option_out_of_range|invalid_slotIndex|tool_exception|unknown_tool/i;

export function isHostSideActionError(error: unknown): boolean {
  if (typeof error !== "string" || !error.trim()) return false;
  const code = error.trim();
  if (HOST_ACTION_ERROR_CODES.has(code)) return true;
  return HOST_NOISE_SUMMARY_RE.test(code);
}

/** True when evidence summary/context looks like host preflight noise, not rite outcome. */
export function isHostNoiseEvidence(evidence: {
  summary?: string | null;
  context?: Record<string, unknown> | null;
  outcome?: string | null;
}): boolean {
  const summary = String(evidence.summary ?? "");
  if (HOST_NOISE_SUMMARY_RE.test(summary)) return true;
  const ctxError = evidence.context?.error ?? evidence.context?.hostError;
  if (isHostSideActionError(ctxError)) return true;
  return false;
}
