import type OpenAI from "openai";
import { sleep } from "./retry.js";
import { estimateTextTokens, roundTokPerSec } from "./tokens.js";

export type LlmSpeedStats = {
  prefillTokens: number;
  decodeTokens: number;
  prefillMs: number | null;
  decodeMs: number | null;
  prefillTokPerSec: number | null;
  decodeTokPerSec: number | null;
  firstTokenMs: number | null;
};

export type TimedChatCompletion = {
  message: OpenAI.Chat.Completions.ChatCompletionMessage;
  finishReason: string | null;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  ms: number;
  speed: LlmSpeedStats;
};

type ToolCallAcc = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type TimedChatCompletionOptions = {
  client: OpenAI;
  model: string;
  messages: unknown[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
  estimatePromptTokens: number;
  maxStreamRetries?: number;
  retryIntervalSec?: number;
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isRetryableStreamError(error: unknown): boolean {
  return errorCode(error) === "data_inspection_failed";
}

export async function createTimedChatCompletion(
  opts: TimedChatCompletionOptions,
): Promise<TimedChatCompletion> {
  const maxRetries = Math.max(0, Math.floor(opts.maxStreamRetries ?? 0));
  const intervalSec = Math.max(0, opts.retryIntervalSec ?? 0);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await createTimedChatCompletionAttempt(opts);
    } catch (error) {
      if (!isRetryableStreamError(error) || attempt >= maxRetries) {
        throw error;
      }

      console.warn(
        `[${new Date().toISOString()}] WARN llm_retry ${JSON.stringify({
          phase: "stream",
          attempt: attempt + 1,
          maxRetries,
          code: errorCode(error),
          waitSec: intervalSec,
        })}`,
      );
      await sleep(intervalSec * 1000);
    }
  }

  throw new Error("LLM stream retry exhausted");
}

async function createTimedChatCompletionAttempt(
  opts: TimedChatCompletionOptions,
): Promise<TimedChatCompletion> {
  const t0 = Date.now();
  let firstTokenAt: number | null = null;

  const stream = await createCompletionStream(opts);

  let content = "";
  let reasoningContent = "";
  const toolCallsByIndex = new Map<number, ToolCallAcc>();
  let finishReason: string | null = null;
  let usage: OpenAI.Completions.CompletionUsage | null = null;

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = chunk.usage;
    }
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;

    const reasoningDelta = (delta as { reasoning_content?: string | null }).reasoning_content;
    const hasOutput =
      Boolean(delta.content) ||
      Boolean(reasoningDelta) ||
      Boolean(delta.tool_calls?.length);

    if (hasOutput && firstTokenAt === null) firstTokenAt = Date.now();

    if (typeof delta.content === "string") content += delta.content;
    if (typeof reasoningDelta === "string") reasoningContent += reasoningDelta;
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let acc = toolCallsByIndex.get(idx);
        if (!acc) {
          acc = {
            id: tc.id ?? `call_${idx}`,
            type: "function",
            function: { name: "", arguments: "" },
          };
          toolCallsByIndex.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
    }
  }

  const t1 = Date.now();
  const ms = t1 - t0;
  const firstTokenMs = firstTokenAt !== null ? firstTokenAt - t0 : null;
  const decodeMs =
    firstTokenAt !== null ? Math.max(1, t1 - firstTokenAt) : ms > 0 ? ms : null;
  const prefillMs = firstTokenMs !== null ? Math.max(1, firstTokenMs) : null;

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);

  const message = {
    role: "assistant" as const,
    content: content.length > 0 ? content : null,
    refusal: null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  } as OpenAI.Chat.Completions.ChatCompletionMessage;

  if (reasoningContent.length > 0) {
    (message as { reasoning_content?: string }).reasoning_content = reasoningContent;
  }

  const decodeFallback = estimateTextTokens(
    `${content}${reasoningContent}${toolCalls.length > 0 ? JSON.stringify(toolCalls) : ""}`,
  );

  const prefillTokens = usage?.prompt_tokens ?? opts.estimatePromptTokens;
  const decodeTokens = usage?.completion_tokens ?? decodeFallback;
  const normalizedUsage = usage
    ? {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      }
    : null;

  const prefillDenomMs = prefillMs ?? (ms > 0 ? ms : null);
  const decodeDenomMs = decodeMs;

  return {
    message,
    finishReason,
    usage: normalizedUsage,
    ms,
    speed: {
      prefillTokens,
      decodeTokens,
      prefillMs: prefillDenomMs,
      decodeMs: decodeDenomMs,
      prefillTokPerSec:
        prefillDenomMs !== null ? roundTokPerSec(prefillTokens, prefillDenomMs) : null,
      decodeTokPerSec:
        decodeDenomMs !== null ? roundTokPerSec(decodeTokens, decodeDenomMs) : null,
      firstTokenMs,
    },
  };
}

async function createCompletionStream(opts: {
  client: OpenAI;
  model: string;
  messages: unknown[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
  signal?: AbortSignal;
}): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
  const base = {
    model: opts.model,
    messages: opts.messages as never,
    tools: opts.tools,
    tool_choice: opts.toolChoice,
    stream: true as const,
  };

  try {
    return await opts.client.chat.completions.create(
      { ...base, stream_options: { include_usage: true } },
      { signal: opts.signal },
    );
  } catch {
    if (opts.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return await opts.client.chat.completions.create(base, { signal: opts.signal });
  }
}

export async function streamChatText(opts: {
  client: OpenAI;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
}): Promise<{ text: string; ms: number; firstTokenMs: number | null }> {
  const t0 = Date.now();
  let firstTokenAt: number | null = null;
  let content = "";

  const stream = await createCompletionStream({
    client: opts.client,
    model: opts.model,
    messages: opts.messages,
    signal: opts.signal,
  });
  const sdkStreamController = (
    stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> & {
      controller?: AbortController;
    }
  ).controller;
  const abortSdkStream = () => sdkStreamController?.abort();
  if (opts.signal?.aborted) abortSdkStream();
  opts.signal?.addEventListener("abort", abortSdkStream);

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      const reasoningDelta = (delta as { reasoning_content?: string | null }).reasoning_content;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        content += delta.content;
      } else if (
        typeof reasoningDelta === "string" &&
        reasoningDelta.length > 0 &&
        firstTokenAt === null
      ) {
        firstTokenAt = Date.now();
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", abortSdkStream);
  }

  return {
    text: content.trim(),
    ms: Date.now() - t0,
    firstTokenMs: firstTokenAt !== null ? firstTokenAt - t0 : null,
  };
}
