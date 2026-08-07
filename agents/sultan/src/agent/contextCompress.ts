import type OpenAI from "openai";
import type { AppConfig } from "../config.js";
import type { AgentLogger } from "../log/AgentLogger.js";
import { streamChatText } from "../llm/timedChat.js";
import { estimateMessagesTokens, estimateTextTokens } from "../llm/tokens.js";

export type ChatMessage = Record<string, unknown>;

const SUMMARY_PREFIX = "## 会话摘要（已压缩）";
const COMPRESS_SYSTEM =
  "你负责把 Sultan Agent 的会话历史压缩成后续游玩步骤可用的事实清单。只写事实与机制错误，不写高分策略。用中文输出。";

export function estimateTokens(messages: ChatMessage[]): number {
  return estimateMessagesTokens(messages);
}

export function takeLastCompleteTurns(messages: ChatMessage[], keepTurns: number): ChatMessage[] {
  if (keepTurns <= 0 || messages.length === 0) return [];

  const assistantIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      assistantIndices.push(i);
      if (assistantIndices.length >= keepTurns) break;
    }
  }

  if (assistantIndices.length === 0) return [];
  const start = Math.min(...assistantIndices);
  return messages.slice(start);
}

function stripReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!m || typeof m !== "object" || !("reasoning_content" in m)) return m;
    const { reasoning_content: _r, ...rest } = m;
    return rest;
  });
}

function findPinnedPrefix(messages: ChatMessage[]): {
  pinned: ChatMessage[];
  restStart: number;
} {
  const pinned: ChatMessage[] = [];
  let i = 0;
  if (messages[0]?.role === "system") {
    pinned.push(messages[0]);
    i = 1;
  }
  if (messages[i]?.role === "user") {
    pinned.push(messages[i]);
    i += 1;
  }
  return { pinned, restStart: i };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function buildDeterministicPlayFacts(state: unknown, extraLines: string[] = []): string {
  if (!isRecord(state) || (!state.values && !state.screen)) {
    return ["## 程序事实快照", ...extraLines].filter(Boolean).join("\n");
  }
  const values = (state.values ?? {}) as Record<string, unknown>;
  const screen = state.screen as { id?: string; phase?: string } | undefined;
  const lines = [
    "## 程序事实快照（只读；不得改写）",
    `- screen: ${screen?.id ?? "?"} phase=${screen?.phase ?? "?"}`,
    `- terminal: ${state.terminal === true}`,
    `- day: ${values.day ?? values.turn ?? "?"}`,
    `- resources: ${JSON.stringify(values.resources ?? {})}`,
    `- counters: ${JSON.stringify(values.counters ?? {})}`,
    `- sudan: ${JSON.stringify(values.sudan ?? {})}`,
    `- questSummary: ${JSON.stringify(values.questSummary ?? {})}`,
    `- handCount: ${values.handCount ?? "?"}`,
    `- riteCount: ${values.riteCount ?? "?"}`,
    `- eventOptionCount: ${values.eventOptionCount ?? "?"}`,
    `- fingerprint: ${values.fingerprint ?? "?"}`,
    "- note: facts only; no strategy advice",
    ...extraLines,
  ];
  return lines.join("\n");
}

function latestGameState(messages: ChatMessage[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content) as Record<string, unknown>;
      if (!parsed.values && !parsed.screen) continue;
      return parsed;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function collectToolErrorLessons(messages: ChatMessage[]): string[] {
  const lessons: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m?.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content) as Record<string, unknown>;
      if (!Array.isArray(parsed.results)) continue;
      for (const r of parsed.results) {
        if (!isRecord(r) || r.ok) continue;
        const op = typeof r.op === "string" ? r.op : "?";
        const error = typeof r.error === "string" ? r.error : "unknown";
        const detail = typeof r.detail === "string" ? r.detail : "";
        const key = `${op}|${error}|${detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lessons.push(`- toolError: op=${op} error=${error}${detail ? ` detail=${detail}` : ""}`);
        if (lessons.length >= 20) return lessons;
      }
    } catch {
      // ignore
    }
  }
  return lessons;
}

const SUMMARY_REQUIREMENTS = [
  "只输出紧凑的 Markdown 清单（不要开场白）。须包含：",
  "- 目标 / 当前界面 / 是否终局",
  "- day/turn、resources、counters、sudan 卡/倒计时",
  "- 手牌数、仪式槽、事件选项数",
  "- 已执行动作与明确失败原因",
  "- 下一步意图（1–2 条，仅意图不写高分策略套路）",
  "只写事实；省略大段原始 JSON。缺失指标写未知。",
  "用中文撰写清单。",
].join("\n");

export function groupCompressTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      const turn: ChatMessage[] = [m];
      i += 1;
      while (i < messages.length && messages[i]?.role === "tool") {
        turn.push(messages[i]!);
        i += 1;
      }
      turns.push(turn);
      continue;
    }
    turns.push([m]);
    i += 1;
  }
  return turns;
}

export function findSoftCutIndex(text: string, maxTokens: number): number {
  if (!text || maxTokens <= 0) return 0;
  if (estimateTextTokens(text) <= maxTokens) return text.length;

  let lo = 1;
  let hi = text.length;
  let bestFit = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTextTokens(text.slice(0, mid)) <= maxTokens) {
      bestFit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return bestFit;
}

export function softSplitText(text: string, maxTokens: number): string[] {
  const budget = Math.max(64, Math.floor(maxTokens));
  if (!text) return [];
  if (estimateTextTokens(text) <= budget) return [text];

  const parts: string[] = [];
  let remaining = text;
  while (estimateTextTokens(remaining) > budget) {
    const cut = findSoftCutIndex(remaining, budget);
    if (cut <= 0) {
      const force = Math.max(1, Math.floor(remaining.length / 2));
      parts.push(remaining.slice(0, force));
      remaining = remaining.slice(force);
      continue;
    }
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

export function expandOversizedTurn(turn: ChatMessage[], budget: number): ChatMessage[][] {
  if (estimateTokens(turn) <= budget) return [turn];

  let splitIdx = -1;
  let splitLen = 0;
  for (let i = 0; i < turn.length; i++) {
    const content = turn[i]?.content;
    if (typeof content === "string" && content.length > splitLen) {
      splitLen = content.length;
      splitIdx = i;
    }
  }

  if (splitIdx < 0 || typeof turn[splitIdx]?.content !== "string") {
    return softSplitText(JSON.stringify(turn), budget).map((chunk, i, arr) => [
      { role: "user", content: `[compress fragment ${i + 1}/${arr.length}]\n${chunk}` },
    ]);
  }

  const overhead = Math.max(64, estimateTokens(turn.filter((_, i) => i !== splitIdx)));
  const contentBudget = Math.max(256, budget - overhead);
  const parts = softSplitText(String(turn[splitIdx]!.content), contentBudget);
  return parts.map((part, i) =>
    turn.map((m, idx) =>
      idx !== splitIdx
        ? m
        : { ...m, content: parts.length > 1 ? `[part ${i + 1}/${parts.length}]\n${part}` : part },
    ),
  );
}

export function splitMessagesIntoSegments(
  messages: ChatMessage[],
  maxSegmentTokens: number,
): ChatMessage[][] {
  const budget = Math.max(1_000, Math.floor(maxSegmentTokens));
  const turns = groupCompressTurns(messages);
  const segments: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    segments.push(current);
    current = [];
    currentTokens = 0;
  };

  for (const turn of turns) {
    for (const piece of expandOversizedTurn(turn, budget)) {
      const pieceTokens = Math.max(1, estimateTokens(piece));
      if (current.length > 0 && currentTokens + pieceTokens > budget) flush();
      current.push(...piece);
      currentTokens += pieceTokens;
      if (currentTokens >= budget) flush();
    }
  }
  flush();
  return segments.length > 0 ? segments : [messages];
}

async function summarizeViaStream(opts: {
  client: OpenAI;
  model: string;
  userContent: string;
  signal?: AbortSignal;
}): Promise<{ text: string; ms: number; firstTokenMs: number | null }> {
  const result = await streamChatText({
    client: opts.client,
    model: opts.model,
    messages: [
      { role: "system", content: COMPRESS_SYSTEM },
      { role: "user", content: opts.userContent },
    ],
    signal: opts.signal,
  });
  if (!result.text) throw new Error("empty_summary");
  return result;
}

export async function compressMessages(opts: {
  client: OpenAI;
  cfg: AppConfig;
  messages: ChatMessage[];
  log: AgentLogger;
  step: number;
  deterministicFacts?: string;
  signal?: AbortSignal;
}): Promise<ChatMessage[]> {
  const { client, cfg, messages, log, step, deterministicFacts, signal } = opts;
  const { pinned, restStart } = findPinnedPrefix(messages);
  if (pinned.length === 0) return messages;

  const keepTurns = Math.max(1, cfg.agentCompressKeepTurns);
  const rest = messages.slice(restStart);
  const recent = takeLastCompleteTurns(rest, keepTurns);
  const recentStartInRest = Math.max(0, rest.length - recent.length);
  const toSummarize = rest.slice(0, recentStartInRest);
  if (toSummarize.length === 0) return messages;

  const middleHistory = stripReasoning(toSummarize);
  const autoFacts = buildDeterministicPlayFacts(latestGameState(messages), [
    ...collectToolErrorLessons(messages),
    ...(deterministicFacts ? [deterministicFacts] : []),
  ]);

  const segmentBudget = Math.max(1_000, cfg.agentCompressSegmentTokens);
  const segments = splitMessagesIntoSegments(middleHistory, segmentBudget);

  let summaryBody: string;
  try {
    const partials: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const streamed = await summarizeViaStream({
        client,
        model: cfg.openaiModel,
        userContent: [
          segments.length > 1
            ? `分段压缩 ${i + 1}/${segments.length}`
            : "请将这段 Sultan Agent 对话压缩为后续继续游玩用的事实清单。",
          SUMMARY_REQUIREMENTS,
          autoFacts ? `程序事实（优先级最高）：\n${autoFacts}` : "",
          "",
          JSON.stringify(stripReasoning(segments[i]!)),
        ]
          .filter(Boolean)
          .join("\n"),
        signal,
      });
      partials.push(streamed.text);
    }
    summaryBody = partials.length === 1 ? partials[0]! : partials.join("\n\n---\n\n");
  } catch (err) {
    if (signal?.aborted) throw err;
    summaryBody = `- 摘要失败：${err instanceof Error ? err.message : String(err)}`;
    log.warn("context_compress_fallback", { step, error: summaryBody });
  }

  summaryBody = `${autoFacts}\n\n${summaryBody}`;
  const rebuilt = [
    ...pinned,
    { role: "user", content: `${SUMMARY_PREFIX}\n\n${summaryBody}` },
    ...recent,
  ];

  log.writeText(`step-${String(step).padStart(2, "0")}-compress.md`, summaryBody);
  log.info("context_compress", { step, afterCount: rebuilt.length });
  return rebuilt;
}

export function compressMessagesDeterministic(opts: {
  cfg: AppConfig;
  messages: ChatMessage[];
  log: AgentLogger;
  step: number;
  deterministicFacts?: string;
  reason: string;
}): ChatMessage[] {
  const { cfg, messages, log, step, deterministicFacts, reason } = opts;
  const { pinned, restStart } = findPinnedPrefix(messages);
  if (pinned.length === 0) return messages;

  const rest = messages.slice(restStart);
  const recent = takeLastCompleteTurns(rest, Math.max(1, cfg.agentCompressKeepTurns));
  const recentStartInRest = Math.max(0, rest.length - recent.length);
  const toSummarize = rest.slice(0, recentStartInRest);
  if (toSummarize.length === 0) return messages;

  const autoFacts = buildDeterministicPlayFacts(latestGameState(messages), [
    ...collectToolErrorLessons(messages),
    ...(deterministicFacts ? [deterministicFacts] : []),
  ]);
  const summaryBody = [autoFacts, `\n- 确定性紧急压缩：${reason}`].join("\n");
  return [
    ...pinned,
    { role: "user", content: `${SUMMARY_PREFIX}\n\n${summaryBody}` },
    ...recent,
  ];
}

export function shouldCompressContext(
  lastPromptTokens: number,
  messages: ChatMessage[],
  triggerTokens: number,
): boolean {
  if (triggerTokens <= 0) return false;
  if (lastPromptTokens >= triggerTokens) return true;
  return estimateTokens(messages) >= triggerTokens;
}
