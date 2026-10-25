import type { ChatMessage } from "./contextCompress.js";

interface ToolCallShape {
  id?: unknown;
}

function toolCallIds(message: ChatMessage): string[] {
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call: ToolCallShape) =>
      call && typeof call.id === "string" && call.id.length > 0 ? call.id : null,
    )
    .filter((id): id is string => id !== null);
}

function toolCallId(message: ChatMessage): string | null {
  if (message?.role !== "tool") return null;
  const id = (message as { tool_call_id?: unknown }).tool_call_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * OpenAI-compatible endpoints reject a request where an assistant message with
 * `tool_calls` is not immediately followed by a tool message for every
 * `tool_call_id`. The agent loop injects "brief" user messages while a tool
 * batch is still running, which violates that adjacency.
 *
 * This rewrites a history into a request-safe shape:
 * - tool results belonging to the pending assistant turn are kept, in order;
 * - other messages that arrived before the batch finished are moved after it;
 * - a call without a recorded result gets a synthetic error result;
 * - orphan/duplicate tool messages are dropped.
 */
export function sanitizeToolMessageOrder(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pending: { ids: string[]; answered: Set<string>; deferred: ChatMessage[] } | null = null;

  const closePending = (): void => {
    if (!pending) return;
    for (const id of pending.ids) {
      if (pending.answered.has(id)) continue;
      out.push({
        role: "tool",
        tool_call_id: id,
        content: JSON.stringify({
          error: "tool_result_missing",
          hint: "该工具调用没有留下结果；先重新 get_state / observe_scene 再行动。",
        }),
      });
    }
    out.push(...pending.deferred);
    pending = null;
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const ids = message.role === "assistant" ? toolCallIds(message) : [];
    if (ids.length > 0) {
      closePending();
      out.push(message);
      pending = { ids, answered: new Set<string>(), deferred: [] };
      continue;
    }

    const callId = toolCallId(message);
    if (pending) {
      if (callId) {
        if (pending.ids.includes(callId) && !pending.answered.has(callId)) {
          out.push(message);
          pending.answered.add(callId);
          if (pending.answered.size === pending.ids.length) closePending();
        }
        // Duplicate or orphan tool result: drop it, the call is not pending.
        continue;
      }

      // The tool batch is still open: hold this message back so the
      // assistant -> tool adjacency stays valid.
      pending.deferred.push(message);
      continue;
    }

    // Tool result with no pending assistant call.
    if (callId) continue;

    out.push(message);
  }

  closePending();
  return out;
}
