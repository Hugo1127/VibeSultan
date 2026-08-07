import fs from "node:fs";
import path from "node:path";
import type { ReplayDecision } from "./types.js";

type ToolCallLine = {
  event?: string;
  step?: number;
  name?: string;
  args?: string | Record<string, unknown>;
};

/**
 * Hand-picked bubbles in the live agent HUD voice (from recent runs + sudan replay ops).
 * Always injected so annotate quality does not depend on whichever run is newest.
 */
export const CURATED_DECISION_EXAMPLES: ReplayDecision[] = [
  {
    title: "处理今日消息",
    goal: "读取并总结 day10 的 StoryNotify",
    why: "行动链 phase=daily_news，dailyNews 已弹出且未查看，需先总结再进入地图盘点",
    actions: ["open_daily_news"],
    thinking: "今日消息还没看，先把 StoryNotify 读完再盘图。",
    mood: "exploit",
  },
  {
    title: "盘点手牌并检查未知卡",
    goal: "完成 hand_review，查清 7 张 mustInspect 卡用途",
    why: "行动链要求真实 inspect_card 取得 cardSummary；为后续苏丹路线探测与分配做准备",
    actions: ["inspect_card x7"],
    thinking: "先摸清手牌，再决定苏丹卡往哪条线塞。",
    mood: "explore",
  },
  {
    title: "检查猎人故事集",
    goal: "取得 uid=246 的 cardSummary",
    why: "mustInspect 需真实 inspect；单步规划限制，逐张查清书籍加成",
    actions: ["inspect_card 246"],
    thinking: "这本猎人故事集还没翻过，先看能加什么。",
    mood: "explore",
  },
  {
    title: "打开还书的少女",
    goal: "确认「还书的少女」槽位：可用苏丹卡硬通，但会害少女；完美解要石级奢靡",
    why: "利他优先：不能为了销卡伤害少女；先 open_rite 核实完美救援条件再决定换卡",
    actions: ["open_rite 还书的少女"],
    thinking: "点开还书的少女——硬塞苏丹卡能过，但会害她；要找石奢靡。",
    mood: "explore",
  },
  {
    title: "开盒寻找石级奢靡",
    goal: "打开苏丹卡盒，开始刷石级（rare=1）奢靡，以便完美拯救还书的少女",
    why: "手里不是石奢靡就不能完美救援；redrawRemaining>0，先 open_sudan_box 再换卡",
    actions: ["open_sudan_box"],
    thinking: "不是随便换能销的牌，是专门刷石级奢靡救少女。",
    mood: "risk",
  },
  {
    title: "关掉换卡手指引导",
    goal: "关闭 REDRAW_SUDAN_CARD 引导，露出交换菜单与拖放槽",
    why: "BeginGuide 挡在 Wizard 选择上；关掉后才能拖卡刷石奢靡",
    actions: ["continue"],
    thinking: "引导挡着换卡，先关掉才能刷石奢靡。",
    mood: "wait",
  },
  {
    title: "第一次刷石奢靡",
    goal: "消耗第 1 次重抽，把当前苏丹卡换掉，寻找石级奢靡",
    why: "第 1/3 次；目标明确是石奢靡救少女，不是换「更好销」的征服/杀戮",
    actions: ["exchange_sudan_card #1"],
    thinking: "第一抽：只要石级奢靡，别的牌再强也不用硬通害人。",
    mood: "risk",
  },
  {
    title: "第二次继续刷石奢靡",
    goal: "第 2 次重抽，继续寻找石级奢靡苏丹卡",
    why: "上一张仍不是石奢靡；利他约束下拒绝用错误苏丹卡完成还书的少女",
    actions: ["exchange_sudan_card #2"],
    thinking: "还不是石奢靡，再换——救少女比销卡要紧。",
    mood: "risk",
  },
  {
    title: "第三次仍未刷到",
    goal: "用尽本回合最后一次重抽，仍锁定「石奢靡」目标",
    why: "第 3/3 次；若仍不是石奢靡，准备 prev_round 回档再试，绝不害少女硬通",
    actions: ["exchange_sudan_card #3"],
    thinking: "最后一抽；没有石奢靡就回档，不拿少女换过关。",
    mood: "risk",
  },
  {
    title: "回档再刷石奢靡",
    goal: "prev_round 回上一回合，保留「需石奢靡救少女」信息后再试",
    why: "三次都没刷到石级奢靡；回档重试优于用任意苏丹卡伤害少女",
    actions: ["prev_round"],
    thinking: "没刷到石奢靡，回档再来——不能害她。",
    mood: "abandon",
  },
  {
    title: "推进结果页",
    goal: "关闭 rite_result 浮层，回到可操作主界面",
    why: "阻塞浮层需先 continue，才能继续地图/换卡操作",
    actions: ["continue"],
    thinking: "结果页还挡着，点一下推进。",
    mood: "wait",
  },
  {
    title: "检查杀戮苏丹卡",
    goal: "取得当前杀戮苏丹卡摘要与倒计时",
    why: "mustInspect/处刑压力；确认品阶与剩余天数后再决定换卡或销卡",
    actions: ["inspect_card 苏丹卡"],
    thinking: "先看清这张杀戮还能撑几天。",
    mood: "explore",
  },
];

function parseArgs(args: string | Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asDecision(raw: unknown): ReplayDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const title = typeof d.title === "string" ? d.title.trim() : "";
  if (!title) return null;
  return {
    title,
    goal: typeof d.goal === "string" ? d.goal : "",
    why: typeof d.why === "string" ? d.why : "",
    actions: Array.isArray(d.actions)
      ? d.actions.filter((x): x is string => typeof x === "string")
      : [],
    thinking: typeof d.thinking === "string" ? d.thinking : "",
    mood: typeof d.mood === "string" ? d.mood : "",
  };
}

function richness(d: ReplayDecision): number {
  return (
    d.title.length +
    d.goal.length * 2 +
    d.why.length * 3 +
    d.thinking.length +
    d.actions.join(" ").length
  );
}

function listRunDirs(logsRoot: string): string[] {
  const runsDir = path.join(logsRoot, "runs");
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(runsDir, d.name))
    .sort()
    .reverse();
}

/** Load recent decision bubbles from agent run events.jsonl + curated seeds. */
export function loadDecisionExamples(
  logsRoot: string,
  limit = 10,
): ReplayDecision[] {
  const fromLogs: ReplayDecision[] = [];
  const seen = new Set<string>();

  for (const runDir of listRunDirs(logsRoot)) {
    const eventsPath = path.join(runDir, "events.jsonl");
    if (!fs.existsSync(eventsPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(eventsPath, "utf8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.includes('"tool_call"') || !line.includes("decision")) continue;
      let parsed: ToolCallLine;
      try {
        parsed = JSON.parse(line) as ToolCallLine;
      } catch {
        continue;
      }
      if (parsed.event !== "tool_call") continue;
      const args = parseArgs(parsed.args);
      if (!args) continue;
      const decision = asDecision(args.decision);
      if (!decision) continue;
      // Prefer substantial narration over one-line stubs.
      if (decision.why.length < 12 && decision.goal.length < 10) continue;
      const key = `${decision.title}|${decision.goal}|${decision.why}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fromLogs.push(decision);
    }
  }

  fromLogs.sort((a, b) => richness(b) - richness(a));

  const out: ReplayDecision[] = [];
  const outKeys = new Set<string>();
  const push = (d: ReplayDecision) => {
    const key = `${d.title}|${d.goal}`;
    if (outKeys.has(key)) return;
    outKeys.add(key);
    out.push(d);
  };

  // Curated first (stable style), then richest live examples.
  for (const d of CURATED_DECISION_EXAMPLES) push(d);
  for (const d of fromLogs) {
    if (out.length >= limit + CURATED_DECISION_EXAMPLES.length) break;
    push(d);
  }

  return out.slice(0, Math.max(limit, CURATED_DECISION_EXAMPLES.length));
}
