import assert from "node:assert/strict";
import { sanitizeToolMessageOrder } from "../src/agent/messageOrder.js";

type Msg = Record<string, unknown>;

function assistantWithCalls(...ids: string[]): Msg {
  return {
    role: "assistant",
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: "function",
      function: { name: "submit_actions", arguments: "{}" },
    })),
  };
}

function toolResult(id: string): Msg {
  return { role: "tool", tool_call_id: id, content: `{"ok":true,"id":"${id}"}` };
}

function user(content: string): Msg {
  return { role: "user", content };
}

/** The invariant the provider enforces: tool_calls must be answered immediately. */
function assertToolAdjacency(messages: Msg[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const calls = message.tool_calls as Array<{ id: string }> | undefined;
    if (!calls || calls.length === 0) continue;

    const following = messages.slice(i + 1, i + 1 + calls.length);
    assert.equal(
      following.length,
      calls.length,
      `assistant at ${i} is not followed by enough tool messages`,
    );
    for (const call of calls) {
      assert.ok(
        following.some((m) => m.role === "tool" && m.tool_call_id === call.id),
        `missing tool result for ${call.id}`,
      );
      assert.equal(following.filter((m) => m.tool_call_id === call.id).length, 1);
    }
  }
}

// 1. The failure seen in production: user brief injected before the tool result.
{
  const broken = [
    user("system-ish brief"),
    assistantWithCalls("call_1"),
    user("【当前行动链】流程建议"),
    toolResult("call_1"),
  ];
  const fixed = sanitizeToolMessageOrder(broken);
  assertToolAdjacency(fixed);
  assert.deepEqual(
    fixed.map((m) => m.role),
    ["user", "assistant", "tool", "user"],
  );
  assert.equal(fixed[3]!.content, "【当前行动链】流程建议");
}

// 2. Missing tool result gets a synthetic error so the next request is valid.
{
  const fixed = sanitizeToolMessageOrder([assistantWithCalls("call_2")]);
  assertToolAdjacency(fixed);
  assert.equal(fixed.length, 2);
  assert.equal(fixed[1]!.role, "tool");
  assert.equal(fixed[1]!.tool_call_id, "call_2");
  assert.match(String(fixed[1]!.content), /tool_result_missing/);
}

// 3. Two calls, only one answered: the gap is filled, order kept.
{
  const fixed = sanitizeToolMessageOrder([
    assistantWithCalls("call_3", "call_4"),
    toolResult("call_3"),
    user("next turn brief"),
  ]);
  assertToolAdjacency(fixed);
  assert.equal(fixed.filter((m) => m.role === "tool").length, 2);
  assert.equal(fixed.filter((m) => m.role === "user").length, 1);
  assert.equal(fixed.at(-1)!.role, "user");
}

// 4. Orphan tool result with no pending assistant call is dropped.
{
  const fixed = sanitizeToolMessageOrder([toolResult("call_orphan"), user("hi")]);
  assert.deepEqual(
    fixed.map((m) => m.role),
    ["user"],
  );
}

// 5. A valid history is returned unchanged.
{
  const valid = [user("hi"), assistantWithCalls("call_5"), toolResult("call_5")];
  assert.deepEqual(sanitizeToolMessageOrder(valid), valid);
}

console.log("Message order verification passed.");
