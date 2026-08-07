import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  createTimedChatCompletion,
  isRetryableStreamError,
} from "../src/llm/timedChat.js";

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function main(): Promise<void> {
  let retryableCalls = 0;
  const retryableClient = {
    chat: {
      completions: {
        create: async () => {
          retryableCalls += 1;
          const call = retryableCalls;
          return {
            async *[Symbol.asyncIterator]() {
              if (call === 1) {
                throw codedError("data_inspection_failed");
              }
              yield {
                choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
              };
            },
          };
        },
      },
    },
  } as unknown as OpenAI;

  const result = await createTimedChatCompletion({
    client: retryableClient,
    model: "test-model",
    messages: [],
    estimatePromptTokens: 0,
    maxStreamRetries: 2,
    retryIntervalSec: 0,
  });

  assert.equal(retryableCalls, 2);
  assert.equal(result.message.content, "ok");
  assert.equal(isRetryableStreamError(codedError("data_inspection_failed")), true);

  let fatalCalls = 0;
  const fatalClient = {
    chat: {
      completions: {
        create: async () => {
          fatalCalls += 1;
          return {
            async *[Symbol.asyncIterator]() {
              throw codedError("invalid_request_error");
            },
          };
        },
      },
    },
  } as unknown as OpenAI;

  await assert.rejects(
    createTimedChatCompletion({
      client: fatalClient,
      model: "test-model",
      messages: [],
      estimatePromptTokens: 0,
      maxStreamRetries: 2,
      retryIntervalSec: 0,
    }),
    { message: "invalid_request_error" },
  );
  assert.equal(fatalCalls, 1);

  console.log("LLM stream retry verification passed.");
}

await main();
