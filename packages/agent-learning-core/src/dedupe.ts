import type { Hypothesis } from "./types.js";

export interface DuplicateMatch {
  hypothesisId: string;
  similarity: number;
}

export type ConceptExtractor = (text: string) => Set<string>;

const emptyConcepts: ConceptExtractor = () => new Set();

export function findDuplicate(
  claim: string,
  topicKey: string,
  hypotheses: Hypothesis[],
  excludeId?: string,
  threshold = 0.62,
  extractConcepts: ConceptExtractor = emptyConcepts,
): DuplicateMatch | null {
  let best: DuplicateMatch | null = null;
  for (const hypothesis of hypotheses) {
    if (hypothesis.id === excludeId || hypothesis.topicKey !== topicKey) {
      continue;
    }
    const similarity = claimSimilarity(claim, hypothesis.claim, extractConcepts);
    if (
      similarity >= threshold &&
      (!best || similarity > best.similarity)
    ) {
      best = { hypothesisId: hypothesis.id, similarity };
    }
  }
  return best;
}

export function claimSimilarity(
  a: string,
  b: string,
  extractConcepts: ConceptExtractor = emptyConcepts,
): number {
  return Math.max(
    ngramJaccard(a, b),
    conceptJaccard(a, b, extractConcepts),
  );
}

export function ngramJaccard(a: string, b: string, width = 2): number {
  const left = ngrams(normalizeClaim(a), width);
  const right = ngrams(normalizeClaim(b), width);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function conceptJaccard(
  a: string,
  b: string,
  extractConcepts: ConceptExtractor,
): number {
  const left = extractConcepts(a);
  const right = extractConcepts(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const concept of left) {
    if (right.has(concept)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function normalizeClaim(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9０-９]+(?:\.[0-9０-９]+)?/g, "#")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function ngrams(value: string, width: number): Set<string> {
  const result = new Set<string>();
  if (value.length <= width) {
    if (value) result.add(value);
    return result;
  }
  for (let i = 0; i <= value.length - width; i++) {
    result.add(value.slice(i, i + width));
  }
  return result;
}
