import fs from "node:fs";
import type OpenAI from "openai";
import { streamChatText } from "../llm/timedChat.js";
import { loadDecisionExamples } from "./loadDecisionExamples.js";
import { buildMotiveBrief, extractFocusRites } from "./motiveBrief.js";
import type {
  ReplayDecision,
  ReplayDocument,
  ReplayHudStats,
  ReplayStep,
} from "./types.js";

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`LLM response is not JSON: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

function asInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return undefined;
}

function asFloat(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeStats(raw: unknown, stepIndex: number): ReplayHudStats {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const step = asInt(s.step) ?? stepIndex + 1;
  const prefill = asInt(s.prefillTokens) ?? 8_000 + step * 900;
  const decode = asInt(s.decodeTokens) ?? 180 + step * 40;
  const total = asInt(s.totalTokens) ?? prefill + decode;
  const elapsedMs = asInt(s.elapsedMs) ?? 2_500 + step * 350;
  const firstTokenMs = asInt(s.firstTokenMs) ?? 280 + (step % 5) * 40;
  const decodeTokPerSec =
    asFloat(s.decodeTokPerSec) ?? Number((decode / Math.max(0.4, elapsedMs / 1000)).toFixed(1));
  const prefillTokPerSec =
    asFloat(s.prefillTokPerSec) ?? Number((prefill / Math.max(0.2, (firstTokenMs || 300) / 1000)).toFixed(1));
  return {
    step,
    totalTokens: total,
    prefillTokens: prefill,
    decodeTokens: decode,
    prefillTokPerSec,
    decodeTokPerSec,
    elapsedMs,
    firstTokenMs,
  };
}

function pickString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

function normalizeDecision(raw: Record<string, unknown>, stepIndex: number): ReplayDecision {
  const nested =
    raw.decision && typeof raw.decision === "object"
      ? (raw.decision as Record<string, unknown>)
      : raw;
  const title = pickString(nested.title, nested.Title, nested.headline, nested.name);
  if (!title) {
    throw new Error("LLM decision missing title");
  }
  return {
    title,
    goal: pickString(nested.goal, nested.Goal),
    why: pickString(nested.why, nested.Why, nested.reason),
    actions: Array.isArray(nested.actions)
      ? nested.actions.filter((x): x is string => typeof x === "string").map((s) => s.trim())
      : [],
    thinking: pickString(nested.thinking, nested.Thinking).slice(0, 100),
    mood: pickString(nested.mood, nested.Mood) || "explore",
    stats: normalizeStats(nested.stats, stepIndex),
  };
}

/** Deterministic, motive-aligned bubble when the LLM returns unusable JSON. */
function fallbackDecision(opts: {
  step: ReplayStep;
  motive: string;
  focusName?: string;
  exchangeOrdinal: number | null;
  exchangeTotal: number;
}): ReplayDecision {
  const event = opts.focusName ?? "焦点事件";
  const stoneHunt = /石|奢靡|还书|利他/.test(opts.motive);
  const op = String(opts.step.action.op);
  const base = (() => {
    switch (op) {
      case "open_rite":
        return {
          title: `打开${event}`,
          goal: stoneHunt
            ? `确认「${event}」：苏丹卡可硬通但会害人；完美解需要石级奢靡`
            : `查看「${event}」槽位与完美解条件`,
          why: stoneHunt
            ? "利他优先：不能用任意苏丹卡伤害少女；先核实救援条件再换卡"
            : "先读事件再决定后续操作",
          actions: [`open_rite ${event}`],
          thinking: stoneHunt
            ? `点开${event}——硬塞能过，但会害她；要找石奢靡。`
            : `点开${event}，摸清完美解再动手。`,
          mood: "explore",
        };
      case "open_sudan_box":
        return {
          title: stoneHunt ? "开盒刷石奢靡" : "打开苏丹卡盒",
          goal: stoneHunt
            ? `进入苏丹卡盒，开始刷石级奢靡以完美拯救${event}`
            : "打开卡盒准备换卡",
          why: stoneHunt
            ? "当前牌不是目标石奢靡；redraw 仍在，先开盒再交换"
            : "需要换卡时先打开苏丹卡盒",
          actions: ["open_sudan_box"],
          thinking: stoneHunt
            ? "不是随便换能销的牌，是专门刷石级奢靡救少女。"
            : "打开卡盒，按动机换目标牌。",
          mood: "risk",
        };
      case "continue":
        return {
          title: "关掉换卡引导",
          goal: "关闭引导浮层，露出交换槽以便继续刷目标苏丹卡",
          why: "BeginGuide 挡住换卡；清掉才能继续按动机重抽",
          actions: ["continue"],
          thinking: stoneHunt ? "引导挡着，先关掉再刷石奢靡。" : "引导挡着，先关掉再说。",
          mood: "wait",
        };
      case "exchange_sudan_card": {
        const n = opts.exchangeOrdinal ?? 1;
        const total = opts.exchangeTotal || 3;
        return {
          title: stoneHunt ? `第${n}抽只认石奢靡` : `第${n}次交换苏丹卡`,
          goal: stoneHunt
            ? `消耗第 ${n}/${total} 次重抽，寻找石级奢靡苏丹卡`
            : `消耗第 ${n}/${total} 次重抽，寻找动机目标牌`,
          why: stoneHunt
            ? `目标明确是石奢靡救「${event}」；拒绝用错误苏丹卡硬通害人`
            : "按 EPISODE MOTIVE 继续重抽",
          actions: [`exchange_sudan_card #${n}`],
          thinking: stoneHunt
            ? `第${n}抽：只要石奢靡，别的牌再强也不硬通害人。`
            : `第${n}抽：按动机找目标牌。`,
          mood: "risk",
        };
      }
      case "prev_round":
        return {
          title: stoneHunt ? "回档再刷石奢靡" : "回退上一回合",
          goal: stoneHunt
            ? "prev_round 回档，保留「需石奢靡救少女」后再试"
            : "回档重试本段计划",
          why: stoneHunt
            ? "本回合未刷到石奢靡；回档优于用任意苏丹卡伤害少女"
            : "当前尝试失败，回档比硬推更安全",
          actions: ["prev_round"],
          thinking: stoneHunt
            ? "没刷到石奢靡，回档再来——不能害她。"
            : "这轮不行，回上一回合重来。",
          mood: "abandon",
        };
      default:
        return {
          title: `执行 ${op}`,
          goal: `推进本段动机：${opts.motive.slice(0, 40)}`,
          why: "该步骤服务于 EPISODE MOTIVE",
          actions: [op],
          thinking: "按动机继续。",
          mood: "exploit",
        };
    }
  })();
  return {
    ...base,
    stats: normalizeStats({}, opts.step.index),
  };
}

function formatExamples(examples: ReplayDecision[]): string {
  if (examples.length === 0) {
    return "(no historical examples found)";
  }
  return examples
    .map(
      (d, i) =>
        `${i + 1}. ${JSON.stringify({
          title: d.title,
          goal: d.goal,
          why: d.why,
          actions: d.actions,
          mood: d.mood,
          thinking: d.thinking,
        })}`,
    )
    .join("\n");
}

function formatPrior(steps: ReplayStep[], beforeIndex: number, window = 3): string {
  const prior = steps
    .slice(Math.max(0, beforeIndex - window), beforeIndex)
    .filter((s) => s.decision.title.trim().length > 0);
  if (prior.length === 0) return "(none yet)";
  return prior
    .map(
      (s) =>
        `step ${s.index}: ${JSON.stringify({
          action: s.action,
          decision: {
            title: s.decision.title,
            goal: s.decision.goal,
            why: s.decision.why,
            actions: s.decision.actions,
            mood: s.decision.mood,
            thinking: s.decision.thinking,
            stats: s.decision.stats,
          },
        })}`,
    )
    .join("\n");
}

function formatEpisodePlan(steps: ReplayStep[]): string {
  return steps
    .map((s) => {
      const op = String(s.action.op);
      const extra =
        s.action.uid != null
          ? ` uid=${s.action.uid}`
          : s.action.riteId != null
            ? ` riteId=${s.action.riteId}`
            : "";
      return `${s.index}: ${op}${extra}${s.note ? ` (${s.note})` : ""}`;
    })
    .join("\n");
}

function loadRecordingContext(sourcePath: string | undefined): string {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return "(recording context unavailable)";
  }
  try {
    const doc = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as {
      initialState?: { values?: Record<string, unknown> };
      finalState?: { values?: Record<string, unknown> };
    };
    const v = doc.initialState?.values ?? {};
    const f = doc.finalState?.values ?? {};
    const sudan = (v.sudan ?? {}) as Record<string, unknown>;
    const finalSudan = (f.sudan ?? {}) as Record<string, unknown>;
    return JSON.stringify(
      {
        day: v.day ?? v.turn,
        handCount: v.handCount,
        riteCount: v.riteCount,
        sudanCard: (sudan.currentCard as { name?: string } | undefined)?.name ?? sudan.cards,
        redrawRemaining: sudan.redrawRemaining,
        finalSudanCard: (finalSudan.currentCard as { name?: string } | undefined)?.name,
        finalRedrawTimes: finalSudan.redrawTimes,
      },
      null,
      2,
    );
  } catch {
    return "(recording context parse failed)";
  }
}

function describeAction(step: ReplayStep, focusName?: string): string {
  const op = String(step.action.op);
  switch (op) {
    case "open_rite":
      return `打开地图仪式/事件「${focusName ?? "未知事件"}」（uid=${step.action.uid ?? "?"}, riteId=${step.action.riteId ?? "?"}）`;
    case "open_sudan_box":
      return "打开左上角苏丹卡盒，准备抽卡/换卡";
    case "exchange_sudan_card":
      return "交换手上的苏丹卡（选择交换并拖入换卡槽）";
    case "continue":
      return "继续/关闭当前引导或浮层";
    case "prev_round":
      return "回到上一回合（整日回档）";
    case "execute":
      return "确认并执行当前仪式";
    case "cancel":
      return "关闭当前仪式面板";
    default:
      return `执行 ${op}`;
  }
}

function primaryFocusName(doc: ReplayDocument): string | undefined {
  const rites = extractFocusRites(doc.steps);
  return rites[0]?.name;
}

async function annotateOneStep(opts: {
  client: OpenAI;
  model: string;
  prompt: string;
  motive: string;
  examples: ReplayDecision[];
  doc: ReplayDocument;
  step: ReplayStep;
  recordingContext: string;
  exchangeOrdinal: number | null;
  exchangeTotal: number;
}): Promise<ReplayDecision> {
  const focusName = primaryFocusName(opts.doc);
  const system = [
    "You write in-game HUD decision bubbles for a REPLAY narration of Sultan's Game.",
    "Write as if you are the live AI agent explaining strategy to the viewer — NOT as a debug log.",
    "Language: Chinese. Voice: decisive, concrete, game-aware (day, 苏丹卡, 换卡次数, 事件名, 回档, 利他).",
    "",
    "GROUNDING (hard rules — violate = wrong answer):",
    "1. EPISODE MOTIVE below is ground truth. Every title/goal/why/thinking MUST serve that motive.",
    "2. Do NOT invent unrelated reasons (e.g.「征服不好用」「路线不顺」「随便换能销的牌」) unless motive says so.",
    "3. If motive is about 还书的少女 / 石级奢靡 / 利他: exchanges hunt for 石级奢靡 to SAVE the girl; reject Sudan-card hard-clear that harms her.",
    "4. open_rite / open_sudan_box / exchange / prev_round are one plan: inspect event → hunt target card → retry if miss.",
    "5. Mention the event name when known. Mention 石奢靡 / 利他约束 when motive includes them.",
    "",
    "FORBIDDEN in title/goal/why/thinking: raw Harmony method names, phase=enter/exit, sequence numbers, '响应指针', '补齐 gap', English source dump.",
    "REQUIRED fields:",
    "- title: short punchy headline (6-16 Chinese chars ideal)",
    "- goal: what this step achieves toward the EPISODE MOTIVE (1 sentence)",
    "- why: strategic reason tied to motive + day/redraw/回档 (1-2 sentences)",
    "- actions: short op labels, e.g. open_rite 还书的少女 / exchange_sudan_card #2",
    "- thinking: first-person-ish HUD line, <=100 Chinese chars, motive-aligned",
    "- mood: explore|exploit|wait|risk|abandon",
    "- stats: plausible HUD footer counters {step,totalTokens,prefillTokens,decodeTokens,elapsedMs,firstTokenMs,prefillTokPerSec,decodeTokPerSec}",
    "stats.step should be the agent step number (1-based, increasing). Token/time values should look like a real LLM turn (prefill thousands, decode hundreds, elapsed 1-8s).",
    "Match the STYLE of the examples, but MOTIVE overrides example content when they conflict. Return ONLY one JSON object.",
  ].join("\n");

  const user = [
    `EPISODE MOTIVE (must ground every field):\n${opts.motive}`,
    `\nStyle prompt (voice only; never override motive):\n${opts.prompt}`,
    `\nGame / recording context:\n${opts.recordingContext}`,
    `\nFull replay plan (${opts.doc.steps.length} steps):\n${formatEpisodePlan(opts.doc.steps)}`,
    focusName ? `\nFocus event name: ${focusName}` : "",
    `\nHistorical bubble style examples (copy density & voice; ignore conflicting motives):\n${formatExamples(opts.examples)}`,
    `\nRecent filled bubbles:\n${formatPrior(opts.doc.steps, opts.step.index)}`,
    `\nCurrent step ${opts.step.index + 1}/${opts.doc.steps.length}:`,
    `player-facing action: ${describeAction(opts.step, focusName)}`,
    `raw action json: ${JSON.stringify(opts.step.action)}`,
    opts.exchangeOrdinal != null
      ? `this is exchange ${opts.exchangeOrdinal}/${opts.exchangeTotal} — still hunting the motive target card`
      : "",
    opts.step.note ? `mapper note (do not quote literally): ${opts.step.note}` : "",
    `suggested stats.step: ${opts.step.index + 1}`,
    "\nWrite a DETAILED decision bubble JSON for this step (title/goal/why/thinking/actions/mood/stats).",
    "Remember: goal/why must explicitly connect this click to the EPISODE MOTIVE.",
  ]
    .filter(Boolean)
    .join("\n");

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text } = await streamChatText({
        client: opts.client,
        model: opts.model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              attempt === 1
                ? user
                : `${user}\n\nRETRY: previous reply was invalid. Return ONLY one JSON object with non-empty string "title".`,
          },
        ],
      });
      return normalizeDecision(extractJsonObject(text), opts.step.index);
    } catch (error) {
      if (attempt === 2) {
        console.warn(
          `annotate step ${opts.step.index + 1} LLM failed (${error instanceof Error ? error.message : String(error)}); using motive fallback`,
        );
      }
    }
  }
  return fallbackDecision({
    step: opts.step,
    motive: opts.motive,
    focusName,
    exchangeOrdinal: opts.exchangeOrdinal,
    exchangeTotal: opts.exchangeTotal,
  });
}

export async function annotateReplayDocument(opts: {
  client: OpenAI;
  model: string;
  doc: ReplayDocument;
  prompt: string;
  motive?: string;
  logsRoot: string;
  onProgress?: (index: number, total: number, decision: ReplayDecision) => void;
}): Promise<ReplayDocument> {
  const motive = buildMotiveBrief(opts.doc, opts.motive);
  const examples = loadDecisionExamples(opts.logsRoot, 10);
  const recordingContext = loadRecordingContext(opts.doc.sourceRecordingPath);
  const exchangeIndexes = opts.doc.steps
    .map((s, i) => (s.action.op === "exchange_sudan_card" ? i : -1))
    .filter((i) => i >= 0);
  const exchangeTotal = exchangeIndexes.length;

  const doc: ReplayDocument = {
    ...opts.doc,
    prompt: opts.prompt,
    motive,
    steps: opts.doc.steps.map((s) => ({
      ...s,
      action: { ...s.action },
      decision: {
        ...s.decision,
        actions: [...(s.decision.actions ?? [])],
        stats: s.decision.stats ? { ...s.decision.stats } : {},
      },
      source: { ...s.source },
    })),
  };

  for (let i = 0; i < doc.steps.length; i++) {
    const step = doc.steps[i]!;
    const exchangePos = exchangeIndexes.indexOf(i);
    const decision = await annotateOneStep({
      client: opts.client,
      model: opts.model,
      prompt: opts.prompt,
      motive,
      examples,
      doc,
      step,
      recordingContext,
      exchangeOrdinal: exchangePos >= 0 ? exchangePos + 1 : null,
      exchangeTotal,
    });
    step.decision = decision;
    opts.onProgress?.(i + 1, doc.steps.length, decision);
  }

  return doc;
}
