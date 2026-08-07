import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ExperienceRecord } from "@vibesultan/agent-learning-core";
import type { GameOps } from "../game/GameOps.js";
import type {
  DayCandidateLedger,
  DayCloseReviewResult,
  DayPlan,
} from "../game/strategyTypes.js";
import type { ActionResult, GameAction, GameState, SceneSnapshot } from "../game/types.js";
import { buildStrategySnapshot } from "../memory/experienceAdapter.js";
import {
  formatDayCloseReviewBrief,
  reviewDayCloseAllocations,
} from "../planner/dayCloseReview.js";
import type {
  ActionChainController,
  ActionChainReport,
} from "./actionChain.js";
import {
  riteEventKey,
  type SultanEntityStores,
} from "../memory/entityMemory.js";
import { versionKeyFromState } from "../memory/experienceAdapter.js";
import { buildRiteExploreBrief } from "../memory/riteExploreBrief.js";
import type { RiteExploreStore } from "../memory/riteExploreStore.js";
import type { BacktrackStore } from "../memory/backtrackStore.js";
import { evaluateRiteExploreGate } from "../planner/riteExplorePolicy.js";
import {
  compositionIncludesSudanCard,
  shouldDeferSudanBreakExecute,
  SUDAN_BREAK_DEFERRED_DETAIL,
  SUDAN_BREAK_DEFERRED_ERROR,
} from "../planner/executionTiming.js";
import type { RecoveryPlan } from "../planner/recoveryPlanner.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Resolve catalog riteId/name/eventKey for an open_rite action from pre-open state. */
function resolveOpenRiteExploreKey(
  state: GameState | null | undefined,
  action: GameAction,
  gameFingerprint?: string | null,
): { riteId: number; riteName: string | null; eventKey: string } | null {
  const uid = asNumber(action.uid);
  const values = isRecord(state?.values) ? state!.values! : {};
  const rites = [
    ...(Array.isArray(values.rites) ? values.rites : []),
    ...(Array.isArray(state?.rites) ? state!.rites : []),
  ];
  let riteId: number | null = null;
  let riteName: string | null = null;
  if (uid != null) {
    for (const raw of rites) {
      if (!isRecord(raw)) continue;
      if (asNumber(raw.uid) !== uid) continue;
      riteId = asNumber(raw.id) ?? asNumber(raw.riteId);
      riteName = asString(raw.name);
      break;
    }
  }
  const current = isRecord(values.currentRite) ? values.currentRite : null;
  if (riteId == null && current && (uid == null || asNumber(current.uid) === uid)) {
    riteId = asNumber(current.id) ?? asNumber(current.riteId);
    riteName = riteName ?? asString(current.name);
  }
  if (riteId == null) return null;
  const version = versionKeyFromState(state, gameFingerprint);
  return {
    riteId,
    riteName,
    eventKey: riteEventKey(version.configFingerprint, riteId),
  };
}

const GAME_OPS = [
  "noop",
  "continue",
  "execute",
  "cancel",
  "reset",
  "start_new_game",
  "continue_game",
  "select_difficulty",
  "select_event_option",
  "draw_sudan_card",
  "open_sudan_box",
  "exchange_sudan_card",
  "select_card",
  "inspect_card",
  "think_card",
  "open_daily_news",
  "select_gold_dice",
  "confirm_gold_dice",
  "cancel_gold_dice",
  "open_rite",
  "place_card_on_rite",
  "equip_item",
  "unequip_item",
  "probe_types",
  // Legacy aliases (plugin maps to intents).
  "click_element",
  "cancel_card_placement",
  "start_rite",
  "clear_rite_submission",
  "close_rite",
  "next_day",
  "next_round",
  "prev_round",
] as const;

export const agentTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "observe_scene",
      description:
        "观察当前结构化 UI。返回当前 scene/modal、屏幕指令、可见文本、可交互 elements 和 enabled affordances。行动前优先调用；行动链阶段只约束优先级，仍以实时界面为准。",
      parameters: {
        type: "object",
        properties: {
          decision: {
            type: "object",
            properties: {
              title: { type: "string" },
              goal: { type: "string" },
              why: { type: "string" },
              mood: {
                type: "string",
                enum: ["explore", "exploit", "wait", "risk", "abandon"],
              },
              actions: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description:
        "点击 observe_scene 当前快照中 enabled 的元素。必须原样使用 elementId 和 snapshotVersion；过期、遮挡、不可交互元素会被拒绝。",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          snapshotVersion: { type: "number" },
          decision: {
            type: "object",
            properties: {
              title: { type: "string" },
              goal: { type: "string" },
              why: { type: "string" },
              mood: {
                type: "string",
                enum: ["explore", "exploit", "wait", "risk", "abandon"],
              },
              actions: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        required: ["elementId", "snapshotVersion"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_state",
      description:
        "读取 Sultan 状态。默认 COMPACT：day/turn、counters、sudan、guide/stepHint、currentRite、riteResult、questSummary、handCount（UI可见手牌数）、bag0Count/inventoryCount、riteCount、eventOptionCount、overlays、actions[]。views=cards 只返回界面可见手牌；隐藏库存用 views=cards_all。要完整地图点列表用 views=rites（或 values）；summary 会去掉 rites[]。角色卡含 equipSlotTypes、equipped[]（含 title/text/tags/attrBonus）、equipBonus（穿戴属性合计）与 tags；穿戴关系以 equipped[] 为准，物品静态 tags.已装备不能当作已穿在谁身上。仪式放卡前先读 currentRite.slots（text/condition/costMin/placeCountHint；occupied 槽的 cardSummary 已含运行时 rare/tier/life/tags 等完整决策信息，无需额外 inspect）或 scene 的 semantic:rite_slot_* / rite_slot_card_*。金币堆叠看 cards[].count，放卡只用 costMin。有 guide.active 时先读 guide.preferredOp。views 还可选：full|summary|values|rites|events|quests|actions|diagnostics。",
      parameters: {
        type: "object",
        properties: {
          views: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "strategySnapshot",
                "strategy",
                "full",
                "summary",
                "values",
                "cards",
                "cards_all",
                "inventory",
                "rites",
                "events",
                "overlays",
                "quests",
                "actions",
                "diagnostics",
              ],
            },
          },
          decision: {
            type: "object",
            properties: {
              title: { type: "string" },
              goal: { type: "string" },
              why: { type: "string" },
              mood: {
                type: "string",
                enum: ["explore", "exploit", "wait", "risk", "abandon"],
              },
              actions: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_actions",
      description:
        "提交动作批并推进游戏。continue 只确认/关闭当前浮层（prompt/rite_result/guide 等），主界面无浮层时 continue 无效。过天必须显式 next_day（next_round 同义）。next_day 前宿主会做日终分配快速检定：硬问题（可复用余牌有已验证正收益槽、分配漂移、处刑末日可销未销）会拒绝；仅收益可提升时返回建议，调整后重试，或填 dayCloseReviewOverride 非空理由后跳过。失败终局由宿主按 recovery plan 连续 prev_round 回到目标决策日（禁止重走 failed path），无法挽回则 start_new_game 重开。其它：execute / cancel / reset；需要参数时用 open_rite、place_card_on_rite、equip_item、unequip_item、select_event_option、draw_sudan_card、open_sudan_box、exchange_sudan_card、inspect_card、think_card、open_daily_news、select_gold_dice 等。inspect_card 只查摘要；think_card 把卡拖进俺寻思发现事件（书/苏丹卡/情报等）。换卡用 open_sudan_box 打开卡盒后 exchange_sudan_card（精确点「交换手上的苏丹卡」，不点「再来一张」；不重置处刑倒计时）。请附带 decision。",
      parameters: {
        type: "object",
        properties: {
          decision: {
            type: "object",
            properties: {
              title: { type: "string" },
              goal: { type: "string" },
              why: { type: "string" },
              mood: {
                type: "string",
                enum: ["explore", "exploit", "wait", "risk", "abandon"],
              },
              actions: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
            additionalProperties: false,
          },
          dayCloseReviewOverride: {
            type: "string",
            description:
              "非空时跳过 next_day 的软收益改进建议（硬问题仍会拦截）。说明为何跳过，例如资源不足、证据不全、故意保留牌。",
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                op: { type: "string", enum: [...GAME_OPS] },
                optionIndex: { type: "number" },
                optionId: { type: ["string", "number"] },
                uid: { type: ["string", "number"] },
                cardId: { type: ["string", "number"] },
                slotIndex: { type: "number" },
                slotId: { type: ["string", "number"] },
                slot: { type: ["string", "number"] },
                card: { type: ["string", "number"] },
                count: {
                  type: "number",
                  description:
                    "For stackable items like 金币: how many units to place after CardSplit. Prefer slot costMin (e.g. 1 for bookstore). Omit to auto-split by costMin.",
                },
                characterUid: {
                  type: ["string", "number"],
                  description: "For equip_item/unequip_item: owned character/follower uid.",
                },
                charUid: { type: ["string", "number"] },
                itemUid: {
                  type: ["string", "number"],
                  description: "For equip_item/unequip_item: equippable item uid.",
                },
                slotType: {
                  type: "string",
                  description: "Optional equip slot type (武器/服装/饰品).",
                },
                riteId: { type: ["string", "number"] },
                index: { type: "number" },
                initId: { type: "number" },
                round: { type: "number" },
                elementId: { type: "string" },
                targetId: { type: "string" },
                snapshotVersion: { type: "number" },
              },
              required: ["op"],
              additionalProperties: true,
            },
          },
        },
        required: ["actions"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report_action_chain",
      description:
        "提交行动链阶段结果：今日消息摘要、Top3、已盘点手牌/地图点、卡牌分配、未分配原因、是否完成局部优化。UID 必须来自最新 state/scene。",
      parameters: {
        type: "object",
        properties: {
          phase: {
            type: "string",
            enum: [
              "entry_setup",
              "sudan_draw",
              "daily_news",
              "hand_review",
              "map_review",
              "synthesis",
              "allocation",
              "local_improve",
              "end_day_gate",
            ],
          },
          newsChecked: { type: "boolean" },
          newsPresent: { type: "boolean" },
          newsSummary: { type: ["string", "null"] },
          top3: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                why: { type: "string" },
                priority: { type: "number" },
              },
              required: ["title", "why"],
              additionalProperties: false,
            },
          },
          reviewedCardUids: {
            type: "array",
            items: { type: "number" },
            description:
              "已复核的已知卡牌 UID；mustInspect 中的卡不能靠此字段绕过真实 inspect_card。",
          },
          inspectedCardUids: {
            type: "array",
            items: { type: "number" },
            description:
              "仅用于报告宿主已验证的检查状态；mustInspect 卡由宿主自动确认，自报不会解锁。",
          },
          reviewedRiteUids: { type: "array", items: { type: "number" } },
          allocations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                cardUid: { type: "number" },
                riteUid: { type: "number" },
                slotIndex: { type: "number" },
                why: { type: "string" },
              },
              required: ["cardUid", "riteUid", "slotIndex"],
              additionalProperties: false,
            },
          },
          idleCards: {
            type: "array",
            items: {
              type: "object",
              properties: {
                cardUid: { type: "number" },
                reason: { type: "string", enum: ["reserved", "no_positive_slot"] },
                detail: { type: "string" },
              },
              required: ["cardUid", "reason"],
              additionalProperties: false,
            },
          },
          localImproveDone: { type: "boolean" },
          sudanBreakDone: {
            type: "boolean",
            description:
              "Host-verified state. Omit normally; false may clear a stale report, true is rejected",
          },
          notes: { type: "string" },
          decision: {
            type: "object",
            properties: {
              title: { type: "string" },
              goal: { type: "string" },
              why: { type: "string" },
              mood: {
                type: "string",
                enum: ["explore", "exploit", "wait", "risk", "abandon"],
              },
              actions: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
];

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonNegativeInt(v: unknown): v is number {
  return isNumber(v) && Number.isInteger(v) && v >= 0;
}

function coerceNonNegativeInt(v: unknown): number | null {
  if (isNonNegativeInt(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

function asState(state?: GameState | null): GameState | null {
  return state && typeof state === "object" ? state : null;
}

function cardsFrom(state?: GameState | null): Array<{ uid?: number }> {
  const s = asState(state);
  const raw = (s?.cards ?? s?.values?.cards) as unknown;
  return Array.isArray(raw) ? (raw as Array<{ uid?: number }>) : [];
}

function sudanCardUid(state?: GameState | null): number | null {
  const s = asState(state);
  const sudan = (s?.values?.sudan ?? (s as { sudan?: unknown } | null)?.sudan) as
    | { currentCard?: { uid?: number } }
    | undefined;
  return coerceNonNegativeInt(sudan?.currentCard?.uid);
}

function eventsFrom(state?: GameState | null): Array<{ index?: number }> {
  const s = asState(state);
  const raw = (s?.events ?? s?.values?.events) as unknown;
  return Array.isArray(raw) ? (raw as Array<{ index?: number }>) : [];
}

function enabledOps(state?: GameState | null): Set<string> | null {
  const actions = asState(state)?.actions;
  if (!actions) return null;
  const set = new Set<string>();
  for (const a of actions) {
    if (a?.id && a.enabled !== false) set.add(a.id);
  }
  return set;
}

function enabledOpsFromScene(scene?: SceneSnapshot | null): Set<string> | null {
  if (!scene?.affordances) return null;
  const set = new Set<string>();
  for (const a of scene.affordances) {
    if (a?.enabled !== false && typeof a.mapsToOp === "string" && a.mapsToOp) {
      set.add(a.mapsToOp);
    }
  }
  return set.size > 0 ? set : null;
}

export function preflightAction(
  action: GameAction,
  state?: GameState | null,
  scene?: SceneSnapshot | null,
): string | null {
  const op = action.op;
  const enabled = enabledOps(state);
  const sceneOps = enabledOpsFromScene(scene);
  const allowed =
    (typeof op === "string" && sceneOps?.has(op) === true) ||
    (typeof op === "string" && enabled?.has(op) === true);
  if (
    enabled &&
    enabled.size > 0 &&
    typeof op === "string" &&
    !allowed &&
    op !== "noop" &&
    op !== "probe_types" &&
    op !== "click_element"
  ) {
    // Soft check: allow ops advertised by latest state OR latest scene affordances.
    return "action_not_enabled";
  }

  switch (op) {
    case "noop":
    case "continue":
    case "execute":
    case "cancel":
    case "reset":
    case "start_new_game":
    case "continue_game":
    case "select_difficulty":
    case "draw_sudan_card":
    case "open_sudan_box":
    case "exchange_sudan_card":
    case "open_daily_news":
    case "select_gold_dice":
    case "confirm_gold_dice":
    case "cancel_gold_dice":
    case "open_rite":
    case "start_rite":
    case "clear_rite_submission":
    case "close_rite":
    case "next_day":
    case "next_round":
    case "prev_round":
    case "probe_types":
      return null;
    case "inspect_card":
    case "think_card": {
      const uid = coerceNonNegativeInt(action.uid) ?? coerceNonNegativeInt(action.cardId);
      if (uid === null) return "missing_uid";
      const cards = cardsFrom(state);
      const sudanUid = sudanCardUid(state);
      if (
        cards.length > 0 &&
        !cards.some((c) => c.uid === uid) &&
        sudanUid !== uid
      ) {
        return "card_not_found";
      }
      return null;
    }
    case "click_element":
      if (typeof action.elementId !== "string" || !action.elementId.trim()) {
        return "missing_elementId";
      }
      if (!isNonNegativeInt(action.snapshotVersion)) return "missing_snapshotVersion";
      return null;
    case "select_event_option": {
      const index =
        coerceNonNegativeInt(action.optionIndex) ??
        coerceNonNegativeInt(action.index) ??
        coerceNonNegativeInt(action.optionId);
      if (index === null) return "missing_optionIndex";
      const events = eventsFrom(state);
      if (events.length > 0 && !events.some((e) => e.index === index)) {
        return "option_out_of_range";
      }
      return null;
    }
    case "select_card": {
      const uid = coerceNonNegativeInt(action.uid) ?? coerceNonNegativeInt(action.cardId);
      if (uid === null) return "missing_uid";
      const cards = cardsFrom(state);
      if (cards.length > 0 && !cards.some((c) => c.uid === uid)) {
        return "card_not_found";
      }
      return null;
    }
    case "place_card_on_rite": {
      const uid =
        coerceNonNegativeInt(action.uid) ??
        coerceNonNegativeInt(action.cardId) ??
        coerceNonNegativeInt(action.card);
      const slot =
        coerceNonNegativeInt(action.slotIndex) ??
        coerceNonNegativeInt(action.slotId) ??
        coerceNonNegativeInt(action.slot) ??
        coerceNonNegativeInt(action.index);
      if (uid === null) return "missing_uid";
      if (slot === null) return "missing_slotIndex";
      const cards = cardsFrom(state);
      if (cards.length > 0 && !cards.some((c) => c.uid === uid)) {
        return "card_not_found";
      }
      return null;
    }
    case "cancel_card_placement": {
      const slot =
        coerceNonNegativeInt(action.slotIndex) ??
        coerceNonNegativeInt(action.slotId) ??
        coerceNonNegativeInt(action.slot) ??
        coerceNonNegativeInt(action.index);
      // slotIndex optional at runtime (removes current), but prefer providing it.
      if (slot !== null && slot < 0) return "invalid_slotIndex";
      return null;
    }
    case "equip_item": {
      const characterUid =
        coerceNonNegativeInt(action.characterUid) ?? coerceNonNegativeInt(action.charUid);
      const itemUid =
        coerceNonNegativeInt(action.itemUid) ??
        coerceNonNegativeInt(action.uid) ??
        coerceNonNegativeInt(action.cardId);
      if (characterUid === null) return "missing_characterUid";
      if (itemUid === null) return "missing_itemUid";
      const cards = cardsFrom(state);
      if (cards.length > 0) {
        if (!cards.some((c) => c.uid === characterUid)) return "character_not_found";
        if (!cards.some((c) => c.uid === itemUid)) return "item_not_found";
      }
      return null;
    }
    case "unequip_item": {
      const itemUid =
        coerceNonNegativeInt(action.itemUid) ??
        coerceNonNegativeInt(action.uid) ??
        coerceNonNegativeInt(action.cardId);
      if (itemUid === null) return "missing_itemUid";
      return null;
    }
    default:
      return null;
  }
}

export function isTerminalState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;
  if (s.terminal === true) return true;
  const values = s.values as { terminal?: boolean } | undefined;
  if (values?.terminal === true) return true;
  const screen = s.screen as { phase?: string; id?: string } | undefined;
  return screen?.phase === "terminal" || screen?.id === "terminal";
}

function questSummaryOf(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  const direct = s.questSummary;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const values = s.values;
  if (values && typeof values === "object" && !Array.isArray(values)) {
    const nested = (values as Record<string, unknown>).questSummary;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return null;
}

/** True when terminal state is a victory ending (not a recoverable game-over). */
export function isVictoryTerminal(state: unknown): boolean {
  if (!isTerminalState(state)) return false;
  return questSummaryOf(state)?.success === true;
}

function enabledActionIds(state: unknown): Set<string> {
  const ids = new Set<string>();
  if (!state || typeof state !== "object") return ids;
  const s = state as Record<string, unknown>;
  const lists = [s.actions, (s.values as { actions?: unknown } | undefined)?.actions];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as { id?: unknown; enabled?: unknown };
      if (typeof a.id === "string" && a.id && a.enabled !== false) ids.add(a.id);
    }
  }
  return ids;
}

/**
 * Recovery ops still available after terminal.
 * Failure game-over: prefer prev_round, else start_new_game.
 * Victory: optionally start_new_game for another run.
 */
export function terminalRecoveryOps(state: unknown): string[] {
  if (!isTerminalState(state)) return [];
  const enabled = enabledActionIds(state);
  const ops: string[] = [];
  if (enabled.has("prev_round")) ops.push("prev_round");
  if (enabled.has("start_new_game")) ops.push("start_new_game");
  return ops;
}

export function formatTerminalRecoveryHint(state: unknown): string | null {
  if (!isTerminalState(state)) return null;
  const recovery = terminalRecoveryOps(state);
  const victory = isVictoryTerminal(state);
  const overReason = questSummaryOf(state)?.overReason;
  const reasonText =
    overReason != null && overReason !== -2147483648 ? ` overReason=${String(overReason)}` : "";
  if (victory) {
    return (
      `终局（胜利）${reasonText}。可总结本局；若要继续练级可用 start_new_game 重开。` +
      (recovery.length ? ` 可用: ${recovery.join(", ")}` : "")
    );
  }
  if (recovery.includes("prev_round")) {
    return (
      `终局（失败/可恢复）${reasonText}。宿主将按 recovery plan 连续 prev_round 回到目标决策日；` +
      `到达后禁止重走 failed path，优先未试 sibling。无法回退时 start_new_game。可用: ${recovery.join(", ")}`
    );
  }
  if (recovery.includes("start_new_game")) {
    return (
      `终局（失败）${reasonText}。无法回退时不要停止：用 start_new_game 果断重开。` +
      `可用: ${recovery.join(", ")}`
    );
  }
  return `终局${reasonText}。当前无恢复动作，可总结后停止。`;
}

export function screenId(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  return (state as { screen?: { id?: string } }).screen?.id;
}

/** Keep HUD thinking snippets short (count Unicode code points). */
export function truncateHudThinking(text: string, maxChars = 100): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) return normalized;
  return chars.slice(0, Math.max(0, maxChars - 1)).join("") + "…";
}

async function publishEmbeddedDecision(
  ops: GameOps,
  decisionRaw: unknown,
  step?: number,
  thinking?: string,
): Promise<{ ok: boolean; error?: string } | null> {
  if (decisionRaw === undefined || decisionRaw === null) return null;
  if (typeof decisionRaw !== "object" || Array.isArray(decisionRaw)) {
    return { ok: false, error: "invalid_decision" };
  }
  const d = decisionRaw as Record<string, unknown>;
  const title = typeof d.title === "string" ? d.title.trim() : "";
  if (!title) return { ok: false, error: "missing_title" };
  const actions = Array.isArray(d.actions)
    ? d.actions.filter((a): a is string => typeof a === "string")
    : undefined;
  const thinkingText =
    typeof thinking === "string" && thinking.trim()
      ? truncateHudThinking(thinking)
      : undefined;
  return ops.publishDecision({
    step,
    title,
    goal: typeof d.goal === "string" ? d.goal : undefined,
    actions,
    why: typeof d.why === "string" ? d.why : undefined,
    thinking: thinkingText || undefined,
    mood: typeof d.mood === "string" ? d.mood : undefined,
  });
}

function compactScene(scene: SceneSnapshot): SceneSnapshot {
  const enabledTargets = new Set(
    (scene.affordances ?? [])
      .filter((a) => a.enabled !== false && typeof a.targetId === "string")
      .map((a) => a.targetId as string),
  );
  const elements = (scene.elements ?? [])
    .filter(
      (e) =>
        e.visible !== false &&
        (e.interactable === true ||
          enabledTargets.has(e.elementId) ||
          (typeof e.text === "string" && e.text.trim().length > 0)),
    )
    .filter((e) => !isMainChromeNoise(e.elementId))
    .slice(0, 80)
    .map(({ instanceId: _instanceId, path: _path, ...rest }) => rest);
  return {
    ...scene,
    elements,
    affordances: (scene.affordances ?? [])
      .filter((a) => a.enabled !== false)
      .slice(0, 80),
  };
}

function isMainChromeNoise(elementId: string | undefined): boolean {
  if (!elementId) return false;
  return (
    elementId.startsWith("semantic:main_status_") ||
    elementId.startsWith("semantic:main_card_tier_") ||
    elementId === "semantic:main_execution_day" ||
    elementId === "semantic:main_achievements" ||
    elementId === "semantic:main_story_book" ||
    elementId === "semantic:main_draw_cards" ||
    elementId === "semantic:main_game_menu" ||
    elementId === "semantic:main_sort_cards" ||
    elementId === "semantic:main_card_panel" ||
    elementId === "semantic:main_history"
  );
}

/** Shrink action diffs for the LLM: keep phase/instruction/state, cap list noise. */
function compactActionResult(result: ActionResult): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>) };
  if (out.changes && typeof out.changes === "object") {
    out.changes = compactChangeBag(out.changes as Record<string, unknown>);
  }
  if (out.stateDelta && typeof out.stateDelta === "object") {
    out.stateDelta = compactChangeBag(out.stateDelta as Record<string, unknown>);
  }
  return out;
}

function compactChangeBag(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ("added" in (value as object) || "removed" in (value as object))
    ) {
      const bag = value as Record<string, unknown>;
      const added = Array.isArray(bag.added) ? bag.added.slice(0, 16) : bag.added;
      const removed = Array.isArray(bag.removed) ? bag.removed.slice(0, 16) : bag.removed;
      const changed = Array.isArray(bag.changed) ? bag.changed.slice(0, 16) : bag.changed;
      out[key] = {
        ...bag,
        added,
        removed,
        ...(changed !== undefined ? { changed } : {}),
        truncated:
          bag.truncated === true ||
          (Array.isArray(bag.added) && bag.added.length > 16) ||
          (Array.isArray(bag.removed) && bag.removed.length > 16),
      };
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function validateSceneClick(
  scene: SceneSnapshot | null | undefined,
  elementId: string,
  snapshotVersion: number,
): string | null {
  if (!scene) return "observe_scene_required";
  if (scene.snapshotVersion !== snapshotVersion) return "stale_scene";
  const affordance = (scene.affordances ?? []).find(
    (a) => a.targetId === elementId && a.action === "click",
  );
  if (!affordance) return "element_not_clickable";
  if (affordance.enabled === false) return affordance.reason ?? "element_disabled";
  return null;
}

function actionMatchesPlan(action: GameAction, plan?: DayPlan | null): boolean {
  if (!plan || plan.steps.length === 0) return true;
  const first = plan.steps[0]?.action;
  if (!first) return true;
  if (String(action.op) !== String(first.op)) return false;
  for (const key of ["uid", "slotIndex", "optionIndex", "elementId"] as const) {
    if (first[key] !== undefined && action[key] !== undefined && `${action[key]}` !== `${first[key]}`) {
      return false;
    }
  }
  return true;
}

function mapsToNextDay(
  scene: SceneSnapshot | null | undefined,
  elementId: string,
): boolean {
  const aff = (scene?.affordances ?? []).find(
    (a) => a.targetId === elementId && a.action === "click",
  );
  const op = String(aff?.mapsToOp ?? "").toLowerCase();
  return op === "next_day" || op === "next_round";
}

export function runDayCloseReviewGate(opts: {
  state?: GameState | null;
  scene?: SceneSnapshot | null;
  actionChain?: ActionChainController | null;
  dayCloseLedger?: DayCandidateLedger | null;
  experiences?: ExperienceRecord[];
  gameFingerprint?: string | null;
  exchangeCircuitOpen?: boolean;
  overrideReason?: string | null;
}): {
  allow: boolean;
  error?: string;
  review: DayCloseReviewResult | null;
  brief?: string;
} {
  const state = opts.state ?? null;
  const scene = opts.scene ?? null;
  const snapshot = buildStrategySnapshot({
    state,
    scene,
    gameFingerprint: opts.gameFingerprint,
    exchangeCircuitOpen: opts.exchangeCircuitOpen,
  });
  const allocations = opts.actionChain?.checkpoint.allocations ?? [];
  const idleCards = opts.actionChain?.checkpoint.idleCards ?? [];
  const review = reviewDayCloseAllocations({
    snapshot,
    state,
    scene,
    allocations,
    idleCards,
    ledger: opts.dayCloseLedger,
    experiences: opts.experiences,
    sudanBreakDone: opts.actionChain?.checkpoint.sudanBreakDone === true,
    sudanExchangeTierRegression:
      opts.actionChain?.checkpoint.sudanExchangeTierRegression ?? null,
  });
  const brief = formatDayCloseReviewBrief(review);
  if (review.hardIssues.length > 0) {
    return {
      allow: false,
      error: "day_close_hard_issue",
      review,
      brief,
    };
  }
  // Soft block only for score improvements (or unexplained soft idle).
  // Explained idle (reserved/no_positive_slot) stays advisory in the brief.
  const explainedIdle = new Set(
    (opts.actionChain?.checkpoint.idleCards ?? []).map((i) => i.cardUid),
  );
  const hasSoftImprove = review.softIssues.some((i) => i.code === "score_improvement");
  const hasUnexplainedIdleSoft = review.softIssues.some(
    (i) =>
      i.code === "idle_reusable_positive_slot" &&
      (i.cardUid == null || !explainedIdle.has(i.cardUid)),
  );
  const override =
    typeof opts.overrideReason === "string" && opts.overrideReason.trim().length > 0
      ? opts.overrideReason.trim()
      : null;
  if ((hasSoftImprove || hasUnexplainedIdleSoft) && !override) {
    return {
      allow: false,
      error: "day_close_improvement_available",
      review,
      brief,
    };
  }
  return { allow: true, review, brief };
}

export async function runTool(
  ops: GameOps,
  name: string,
  argsJson: string,
  opts?: {
    step?: number;
    latestState?: GameState | null;
    latestScene?: SceneSnapshot | null;
    activePlan?: DayPlan | null;
    actionChain?: ActionChainController | null;
    dayCloseLedger?: DayCandidateLedger | null;
    experiences?: ExperienceRecord[];
    gameFingerprint?: string | null;
    exchangeCircuitOpen?: boolean;
    /** Verified sudan break routes for current card (ready + needs_support). */
    verifiedBreakCount?: number;
    /** Days left until sudan execution deadline. */
    executionDaysLeft?: number | null;
    thinking?: string;
    entityStores?: SultanEntityStores | null;
    exploreStore?: RiteExploreStore | null;
    backtrackStore?: BacktrackStore | null;
    runId?: string | null;
    recoveryPlan?: RecoveryPlan | null;
  },
): Promise<unknown> {
  let args: Record<string, unknown> = {};
  if (argsJson && argsJson.trim()) {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  }

  if (name === "get_state") {
    const decision = await publishEmbeddedDecision(
      ops,
      args.decision,
      opts?.step,
      opts?.thinking,
    );
    const views = Array.isArray(args.views)
      ? (args.views as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined;
    const state = await ops.getState(views && views.length > 0 ? views : undefined);
    return decision ? { ...state, decision } : state;
  }

  if (name === "observe_scene") {
    const decision = await publishEmbeddedDecision(
      ops,
      args.decision,
      opts?.step,
      opts?.thinking,
    );
    const scene = compactScene(await ops.observeScene());
    return decision ? { ...scene, decision } : scene;
  }

  if (name === "click_element") {
    const decision = await publishEmbeddedDecision(
      ops,
      args.decision,
      opts?.step,
      opts?.thinking,
    );
    const elementId = typeof args.elementId === "string" ? args.elementId : "";
    const snapshotVersion = coerceNonNegativeInt(args.snapshotVersion);
    if (!elementId) return { results: [{ op: "click_element", ok: false, error: "missing_elementId" }] };
    if (snapshotVersion === null) {
      return { results: [{ op: "click_element", ok: false, error: "missing_snapshotVersion" }] };
    }
    const sceneError = validateSceneClick(opts?.latestScene, elementId, snapshotVersion);
    if (sceneError) {
      return {
        results: [{ op: "click_element", ok: false, error: sceneError }],
        forceReobserve: true,
        ...(decision ? { decision } : {}),
      };
    }
    // Forbid bypassing day-close review via semantic next_day click.
    if (mapsToNextDay(opts?.latestScene, elementId)) {
      return {
        results: [
          {
            op: "click_element",
            ok: false,
            error: "use_explicit_next_day",
            detail: "Day advance must use submit_actions op=next_day so day-close review can run.",
          },
        ],
        forceReobserve: false,
        ...(decision ? { decision } : {}),
      };
    }
    const results = await ops.submitActions([
      { op: "click_element", elementId, snapshotVersion },
    ]);
    return {
      results: results.map(compactActionResult),
      forceReobserve: results.some((r) => r.forceReobserve === true),
      ...(decision ? { decision } : {}),
    };
  }

  if (name === "report_action_chain") {
    const decision = await publishEmbeddedDecision(
      ops,
      args.decision,
      opts?.step,
      opts?.thinking,
    );
    const chain = opts?.actionChain;
    if (!chain) {
      return { ok: false, error: "action_chain_unavailable", ...(decision ? { decision } : {}) };
    }
    const report: ActionChainReport = {
      phase: typeof args.phase === "string" ? (args.phase as ActionChainReport["phase"]) : undefined,
      newsChecked: typeof args.newsChecked === "boolean" ? args.newsChecked : undefined,
      newsPresent: typeof args.newsPresent === "boolean" ? args.newsPresent : undefined,
      newsSummary:
        typeof args.newsSummary === "string" || args.newsSummary === null
          ? (args.newsSummary as string | null)
          : undefined,
      top3: Array.isArray(args.top3) ? (args.top3 as ActionChainReport["top3"]) : undefined,
      reviewedCardUids: Array.isArray(args.reviewedCardUids)
        ? (args.reviewedCardUids as number[])
        : undefined,
      inspectedCardUids: Array.isArray(args.inspectedCardUids)
        ? (args.inspectedCardUids as number[])
        : undefined,
      reviewedRiteUids: Array.isArray(args.reviewedRiteUids)
        ? (args.reviewedRiteUids as number[])
        : undefined,
      allocations: Array.isArray(args.allocations)
        ? (args.allocations as ActionChainReport["allocations"])
        : undefined,
      idleCards: Array.isArray(args.idleCards)
        ? (args.idleCards as ActionChainReport["idleCards"])
        : undefined,
      localImproveDone:
        typeof args.localImproveDone === "boolean" ? args.localImproveDone : undefined,
      sudanBreakDone: typeof args.sudanBreakDone === "boolean" ? args.sudanBreakDone : undefined,
      notes: typeof args.notes === "string" ? args.notes : undefined,
    };
    const result = chain.applyReport(report, opts?.latestState, opts?.latestScene);
    return {
      ok: result.ok,
      error: result.error ?? null,
      brief: result.brief,
      ...(decision ? { decision } : {}),
    };
  }

  if (name === "submit_actions") {
    const decision = await publishEmbeddedDecision(
      ops,
      args.decision,
      opts?.step,
      opts?.thinking,
    );
    const actions = (args.actions as GameAction[]) ?? [];
    const rejected: Array<{
      id?: string;
      op?: string;
      ok: false;
      error: string;
      missing?: string[];
      detail?: string;
    }> = [];
    const accepted: GameAction[] = [];
    // Strategy engine: only the first action of a batch is executed per turn.
    const limited = actions.slice(0, 1);
    let dayCloseReview: DayCloseReviewResult | null = null;
    let dayCloseBrief: string | undefined;
    const overrideReason =
      typeof args.dayCloseReviewOverride === "string" ? args.dayCloseReviewOverride : null;

    for (const a of limited) {
      const requestedOp = String(a.op ?? "");
      if (
        opts?.exchangeCircuitOpen === true &&
        (requestedOp === "open_sudan_box" || requestedOp === "exchange_sudan_card")
      ) {
        rejected.push({
          id: a.id,
          op: a.op,
          ok: false,
          error: "exchange_circuit_open",
        });
        continue;
      }
      // Block exchange when a verified break path already exists and we still have ≥3 days.
      if (
        (requestedOp === "open_sudan_box" || requestedOp === "exchange_sudan_card") &&
        (opts?.verifiedBreakCount ?? 0) > 0 &&
        (opts?.executionDaysLeft ?? null) != null &&
        (opts!.executionDaysLeft as number) >= 3
      ) {
        rejected.push({
          id: a.id,
          op: a.op,
          ok: false,
          error: "sudan_break_path_ready",
          detail:
            "verified break path exists; exchange blocked while executionDaysLeft>=3 (preferDelayBreak ok, do not upgrade tier)",
        });
        continue;
      }
      const err = preflightAction(a, opts?.latestState, opts?.latestScene);
      if (err) {
        rejected.push({ id: a.id, op: a.op, ok: false, error: err });
        continue;
      }
      const op = requestedOp;
      if (
        opts?.recoveryPlan?.nextAction === "prev_round" &&
        op !== "prev_round" &&
        op !== "continue"
      ) {
        rejected.push({
          id: a.id,
          op: a.op,
          ok: false,
          error: "recovery_rewind_required",
          detail: opts.recoveryPlan.hint,
        });
        continue;
      }
      if (op === "execute" || op === "start_rite") {
        const snapshot = buildStrategySnapshot({
          state: opts?.latestState,
          scene: opts?.latestScene,
          gameFingerprint: opts?.gameFingerprint,
        });
        if (
          shouldDeferSudanBreakExecute({
            snapshot,
            compositionIncludesSudan: compositionIncludesSudanCard(opts?.latestState),
          })
        ) {
          rejected.push({
            id: a.id,
            op: a.op,
            ok: false,
            error: SUDAN_BREAK_DEFERRED_ERROR,
            detail: SUDAN_BREAK_DEFERRED_DETAIL,
          });
          continue;
        }
      }
      if (
        (op === "execute" || op === "start_rite") &&
        opts?.entityStores &&
        opts?.exploreStore &&
        opts?.runId
      ) {
        const gate = evaluateRiteExploreGate({
          action: a,
          state: opts.latestState,
          stores: opts.entityStores,
          exploreStore: opts.exploreStore,
          backtrackStore: opts.backtrackStore,
          runId: opts.runId,
          gameFingerprint: opts.gameFingerprint,
        });
        if (gate && !gate.allow) {
          rejected.push({
            id: a.id,
            op: a.op,
            ok: false,
            error: gate.error,
            detail: gate.detail,
          });
          continue;
        }
      }
      if (op === "next_day" || op === "next_round") {
        const gate = runDayCloseReviewGate({
          state: opts?.latestState,
          scene: opts?.latestScene,
          actionChain: opts?.actionChain,
          dayCloseLedger: opts?.dayCloseLedger,
          experiences: opts?.experiences,
          gameFingerprint: opts?.gameFingerprint,
          exchangeCircuitOpen: opts?.exchangeCircuitOpen,
          overrideReason,
        });
        dayCloseReview = gate.review;
        dayCloseBrief = gate.brief;
        if (!gate.allow) {
          rejected.push({
            id: a.id,
            op: a.op,
            ok: false,
            error: gate.error ?? "day_close_blocked",
            detail: gate.brief,
            missing: gate.review?.hardIssues.map((i) => i.code),
          });
          continue;
        }
      }
      if (opts?.activePlan && !actionMatchesPlan(a, opts.activePlan)) {
        // Soft warn: still allow, but mark for replan awareness.
        a.id = a.id ?? "off_plan";
      }
      accepted.push(a);
    }
    if (actions.length > 1) {
      rejected.push({
        op: actions[1]?.op,
        ok: false,
        error: "plan_single_step_only",
      });
    }
    const results = accepted.length > 0 ? await ops.submitActions(accepted) : [];
    if (opts?.actionChain && accepted.length > 0 && results[0]?.ok) {
      opts.actionChain.noteAction(accepted[0]!, opts.latestState, opts.latestScene);
    }

    let riteExploreBrief: string | null = null;
    const firstAccepted = accepted[0];
    if (
      firstAccepted?.op === "open_rite" &&
      results[0]?.ok === true &&
      results[0]?.error !== "no_effect" &&
      opts?.exploreStore
    ) {
      const meta = resolveOpenRiteExploreKey(
        opts.latestState,
        firstAccepted,
        opts.gameFingerprint,
      );
      if (meta) {
        const trials = opts.exploreStore.listTrials(meta.eventKey, opts.runId);
        riteExploreBrief = buildRiteExploreBrief({
          trials,
          riteName: meta.riteName,
          state: opts.latestState,
          stores: opts.entityStores,
          gameFingerprint: opts.gameFingerprint,
        });
      }
    }

    return {
      results: [...rejected, ...results.map(compactActionResult)],
      planHint: opts?.activePlan
        ? {
            planId: opts.activePlan.id,
            firstAction: opts.activePlan.steps[0]?.action ?? null,
          }
        : null,
      actionChain: opts?.actionChain?.brief(opts.latestState, opts.latestScene) ?? null,
      dayCloseReview,
      dayCloseBrief: dayCloseBrief ?? null,
      ...(riteExploreBrief ? { riteExploreBrief } : {}),
      ...(decision ? { decision } : {}),
    };
  }

  return { error: "unknown_tool", name };
}
