import OpenAI from "openai";
import type { Fetch } from "openai/core";
import type { AppConfig } from "../config.js";
import { createRetryFetch, llmRetryBudgetMs } from "./retry.js";

export function createLlmClient(cfg: AppConfig): OpenAI {
  if (!cfg.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is empty — copy env/.env.example to env/.env and set the key");
  }

  const requestTimeoutMs = Math.max(1_000, cfg.llmRequestTimeoutMs);
  const fetchRetry = createRetryFetch({
    maxRetries: cfg.llmMaxRetries,
    intervalSec: cfg.llmRetryIntervalSec,
    requestTimeoutMs,
  }) as unknown as Fetch;

  return new OpenAI({
    apiKey: cfg.openaiApiKey,
    baseURL: cfg.openaiBaseUrl,
    maxRetries: 0,
    timeout: llmRetryBudgetMs({
      requestTimeoutMs,
      maxRetries: cfg.llmMaxRetries,
      intervalSec: cfg.llmRetryIntervalSec,
    }),
    defaultHeaders: {
      "User-Agent": cfg.httpUserAgent,
    },
    fetch: fetchRetry,
  });
}
