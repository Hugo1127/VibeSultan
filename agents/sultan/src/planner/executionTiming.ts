import type { EventConfiguration, StrategySnapshot } from "../game/strategyTypes.js";
import type { GameState } from "../game/types.js";

export type ExecutionTimingPolicy =
  | "discover_routes"
  | "accumulate_prepare"
  | "branch_test"
  | "commit_best"
  | "emergency"
  | "unknown";

export interface ExecutionTimingAdvice {
  executionDaysLeft: number | null;
  policy: ExecutionTimingPolicy;
  /** Soft preference to keep accumulating when routes are stable and not expiring. */
  preferDelayBreak: boolean;
  /** Advancing the day without a break plan is lethal. */
  lethalIfUnbroken: boolean;
  hint: string;
}

const SUDAN_HINTS = ["sudan", "苏丹", "杀戮", "纵欲", "征服", "奢靡", "处决", "处刑"];

export function isSudanBreakConfig(cfg: EventConfiguration): boolean {
  for (const a of cfg.assignments) {
    const type = (a.card.type ?? "").toLowerCase();
    if (type === "sudan" || type.includes("sudan")) return true;
    const name = (a.card.name ?? "").toLowerCase();
    if (SUDAN_HINTS.some((h) => name.includes(h))) return true;
  }
  const eventName = (cfg.event.name ?? "").toLowerCase();
  if (SUDAN_HINTS.some((h) => eventName.includes(h))) return true;
  for (const slot of cfg.event.slots ?? []) {
    const text = `${slot.text ?? ""} ${slot.conditionType ?? ""}`.toLowerCase();
    if (SUDAN_HINTS.some((h) => text.includes(h))) return true;
  }
  return false;
}

export function planBreaksSudanCard(configurations: EventConfiguration[]): boolean {
  const ops = new Set(
    configurations.map((c) => {
      if (c.id.startsWith("cfg_op_")) return c.id.slice(7);
      return c.id;
    }),
  );
  const submits = ops.has("execute") || ops.has("start_rite");
  const sudanAssign = configurations.some(isSudanBreakConfig);
  return sudanAssign && (submits || configurations.some((c) => c.id.startsWith("cfg_place_")));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * True when the open rite composition already places a Sudan card
 * (current hand sudan or type/name sudan hints). Used by execute defer gate.
 */
export function compositionIncludesSudanCard(
  state: GameState | null | undefined,
): boolean {
  const rite = isRecord(state?.values?.currentRite) ? state!.values!.currentRite : null;
  if (!rite) return false;
  const sudan = isRecord(state?.values?.sudan) ? state!.values!.sudan : {};
  const current = isRecord(sudan.currentCard) ? sudan.currentCard : null;
  const sudanId = asNumber(current?.id);
  const sudanUid = asNumber(current?.uid);
  const slots = Array.isArray(rite.slots) ? rite.slots : [];
  for (const raw of slots) {
    if (!isRecord(raw)) continue;
    const cardUid = asNumber(raw.cardUid);
    if (cardUid == null) continue;
    if (sudanUid != null && cardUid === sudanUid) return true;
    const summary = isRecord(raw.cardSummary) ? raw.cardSummary : null;
    const cardId =
      asNumber(summary?.cardId) ?? asNumber(summary?.id) ?? asNumber(raw.cardId);
    if (sudanId != null && cardId === sudanId) return true;
    const type = String(summary?.type ?? "").toLowerCase();
    if (type === "sudan" || type.includes("sudan")) return true;
    const name = String(summary?.name ?? summary?.customName ?? "").toLowerCase();
    if (SUDAN_HINTS.some((h) => name.includes(h.toLowerCase()))) return true;
  }
  return false;
}

export const SUDAN_BREAK_DEFERRED_ERROR = "sudan_break_deferred";

export const SUDAN_BREAK_DEFERRED_DETAIL =
  "处刑仍充裕（preferDelayBreak）：销卡路可用 place 记入账本，不必立刻 execute。先 reset/cancel 取回苏丹卡，优先积累；末日、commit_best/emergency、或事件将过期时再提交。";

/**
 * Hard gate: block execute/start_rite that would break the Sudan card while
 * preferDelayBreak is active. Probe via place remains allowed.
 */
export function shouldDeferSudanBreakExecute(opts: {
  snapshot: StrategySnapshot;
  compositionIncludesSudan: boolean;
}): boolean {
  if (!opts.compositionIncludesSudan) return false;
  const advice = adviseExecutionTiming(opts.snapshot);
  if (!advice.preferDelayBreak) return false;
  if (advice.policy === "commit_best" || advice.policy === "emergency") return false;
  if (opts.snapshot.sudanRoutes?.expiringOpportunity === true) return false;
  return true;
}

export function adviseExecutionTiming(snapshot: StrategySnapshot): ExecutionTimingAdvice {
  const left = snapshot.executionDaysLeft ?? null;
  const routes = snapshot.sudanRoutes;
  const coverage = routes?.coverage ?? null;
  const ready = routes?.readyCount ?? 0;
  const needsSupport = routes?.needsSupportCount ?? 0;
  const pendingProbes = routes?.pendingProbes ?? 0;
  const expiring = routes?.expiringOpportunity === true;
  const redrawRemaining = snapshot.sudanCard?.redrawRemaining ?? null;

  if (left == null) {
    return {
      executionDaysLeft: null,
      policy: "unknown",
      preferDelayBreak: false,
      lethalIfUnbroken: false,
      hint: "处刑倒计时未知；先 observe/get_state 确认手牌中全部苏丹卡的 life 与 initLife。",
    };
  }
  if (left <= 0) {
    return {
      executionDaysLeft: left,
      policy: "emergency",
      preferDelayBreak: false,
      lethalIfUnbroken: true,
      hint: "处刑日已到/已过：必须先销苏丹卡；简单模式可 prev_round 回退重试（灵视+1）。",
    };
  }
  if (left === 1) {
    return {
      executionDaysLeft: left,
      policy: "commit_best",
      preferDelayBreak: false,
      lethalIfUnbroken: true,
      hint:
        "处刑最后一天：执行已验证最佳销卡分支；换卡不重置倒计时；无解时勿过天，可 prev_round。",
    };
  }
  if (left === 2) {
    return {
      executionDaysLeft: left,
      policy: "branch_test",
      preferDelayBreak: false,
      lethalIfUnbroken: false,
      hint:
        `距处刑还剩 2 天：试验非支配分支（最佳路线/次优/换卡，每签名只试一次）。换卡剩余=${redrawRemaining ?? "?"}；回退灵视+1。`,
    };
  }

  // 7–3 days: discover + accumulate/prepare.
  // Verified break path (place affordance for current sudan) exits discover even if probes remain.
  const verifiedBreak = routes?.verifiedBreakCount ?? ready + needsSupport;
  if (verifiedBreak > 0) {
    return {
      executionDaysLeft: left,
      policy: "accumulate_prepare",
      preferDelayBreak: !expiring,
      lethalIfUnbroken: false,
      hint: expiring
        ? `处刑还剩 ${left} 天：已有验证销卡路且机会即将过期，可提前执行；verified_break=${verifiedBreak}。`
        : `处刑还剩 ${left} 天：已有验证销卡路（verified_break=${verifiedBreak}）；可继续积累，不必无目标探测；preferDelayBreak 允许延迟 execute。`,
    };
  }

  if (pendingProbes > 0 || (coverage != null && coverage < 0.5) || (ready === 0 && needsSupport === 0)) {
    return {
      executionDaysLeft: left,
      policy: "discover_routes",
      preferDelayBreak: !expiring,
      lethalIfUnbroken: false,
      hint: `处刑还剩 ${left} 天：优先打开新 event 探测苏丹卡合法槽位；pending_probes=${pendingProbes}。`,
    };
  }

  return {
    executionDaysLeft: left,
    policy: "accumulate_prepare",
    preferDelayBreak: !expiring,
    lethalIfUnbroken: false,
    hint: expiring
      ? `处刑还剩 ${left} 天：存在即将过期的优质销卡机会，可提前执行；否则继续准备 ready=${ready} needs_support=${needsSupport}。`
      : `处刑还剩 ${left} 天：积累资源并完成前置任务；路线稳定时可继续准备，不必固定拖到末日。`,
  };
}

/**
 * Score delta for Sudan-break timing under rolling lifecycle policy.
 * Positive favors the plan; used inside lex vector component 1.
 * Fixed early-break penalties (-18/-12/-8) are intentionally removed.
 */
export function scoreExecutionTiming(opts: {
  snapshot: StrategySnapshot;
  configurations: EventConfiguration[];
}): number {
  const advice = adviseExecutionTiming(opts.snapshot);
  const left = advice.executionDaysLeft;
  const breaks = planBreaksSudanCard(opts.configurations);
  const ops = new Set(
    opts.configurations.map((c) => (c.id.startsWith("cfg_op_") ? c.id.slice(7) : c.id)),
  );
  const advancesDay = ops.has("next_day") || ops.has("next_round");
  const exchanges =
    opts.snapshot.sudanCard?.exchangeCircuitOpen !== true &&
    (ops.has("exchange_sudan_card") || ops.has("open_sudan_box"));
  const probes = opts.configurations.some(
    (c) => c.id.startsWith("cfg_open_") || c.id === "cfg_op_open_rite",
  );
  const prepares =
    !breaks &&
    opts.configurations.some(
      (c) =>
        c.id.startsWith("cfg_open_") ||
        (c.id.startsWith("cfg_place_") && !isSudanBreakConfig(c)) ||
        c.id === "cfg_op_inspect_card",
    );
  const routes = opts.snapshot.sudanRoutes;
  const expiring = routes?.expiringOpportunity === true;
  const ready = routes?.readyCount ?? 0;

  if (left == null) return 0;

  if (left <= 1) {
    if (breaks) return 22;
    if (advancesDay) return -20;
    if (exchanges && (opts.snapshot.sudanCard?.redrawRemaining ?? 0) > 0) return 6;
    return prepares ? 4 : -6;
  }

  if (left === 2) {
    if (breaks && ready > 0) return 12;
    if (exchanges) return 10;
    if (breaks) return 8;
    if (prepares || probes) return 5;
    if (advancesDay) return -4;
    return 1;
  }

  // 7–3 days: discover / prepare. Allow early break when opportunity is expiring.
  // When preferDelayBreak, penalize Sudan-breaking execute plans (probe/place still OK).
  if (advice.policy === "discover_routes") {
    if (probes) return 10;
    if (prepares) return 6;
    if (breaks && expiring) return 14;
    if (breaks && advice.preferDelayBreak) return -12;
    if (breaks) return 2;
    return 0;
  }

  if (breaks && expiring) return 16;
  if (breaks && advice.preferDelayBreak) return -10;
  if (breaks && ready > 0 && (routes?.shortestPrepDays ?? 0) <= 0) return 8;
  if (breaks) return 3; // no fixed early-break tax outside defer window
  if (prepares || probes) return 5;
  if (exchanges && left <= 3) return 4;
  return 1;
}
