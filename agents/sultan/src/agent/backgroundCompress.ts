import type { ChatMessage } from "./contextCompress.js";

export type CompressionSnapshot = {
  generation: number;
  messages: ChatMessage[];
};

export function updateTurnGrowthEwma(
  previous: number,
  observedGrowth: number,
  alpha = 0.35,
): number {
  const growth = Math.max(0, observedGrowth);
  if (previous <= 0) return growth;
  const weight = Math.min(1, Math.max(0, alpha));
  return previous * (1 - weight) + growth * weight;
}

export function shouldStartBackgroundCompression(opts: {
  currentTokens: number;
  triggerTokens: number;
  averageTurnGrowth: number;
  lookaheadTurns: number;
  softRatio: number;
}): boolean {
  if (opts.triggerTokens <= 0) return false;

  const ratio = Math.min(0.95, Math.max(0.1, opts.softRatio));
  const fixedSoftThreshold = opts.triggerTokens * ratio;
  const predictedTokens =
    opts.currentTokens +
    Math.max(0, opts.averageTurnGrowth) * Math.max(0, Math.floor(opts.lookaheadTurns));

  return opts.currentTokens >= fixedSoftThreshold || predictedTokens >= opts.triggerTokens;
}

export function mergeCompressedSnapshot(opts: {
  current: ChatMessage[];
  snapshot: CompressionSnapshot;
  compacted: ChatMessage[];
  generation: number;
}): ChatMessage[] | null {
  if (opts.snapshot.generation !== opts.generation) return null;
  if (opts.current.length < opts.snapshot.messages.length) return null;

  for (let i = 0; i < opts.snapshot.messages.length; i++) {
    if (opts.current[i] !== opts.snapshot.messages[i]) return null;
  }

  return [...opts.compacted, ...opts.current.slice(opts.snapshot.messages.length)];
}
