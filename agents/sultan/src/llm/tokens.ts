import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = getEncoding("cl100k_base");
  }
  return encoder;
}

export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  try {
    return getEncoder().encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export function estimateMessagesTokens(messages: unknown[]): number {
  try {
    return estimateTextTokens(JSON.stringify(messages));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function roundTokPerSec(tokens: number, ms: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || ms <= 0 || tokens < 0) {
    return null;
  }
  return Math.round((tokens / ms) * 1000 * 10) / 10;
}
