import type { Outcome } from "./types.js";

export interface LearningCurvePoint {
  index: number;
  score: number | null;
  bestSoFar: number | null;
}

/** Best-so-far sequence from nullable numeric scores. */
export function computeBestSoFar(scores: Array<number | null>): Array<number | null> {
  let peak: number | null = null;
  return scores.map((score) => {
    if (typeof score === "number" && Number.isFinite(score)) {
      peak = peak == null ? score : Math.max(peak, score);
    }
    return peak;
  });
}

export function learningCurveFromOutcomes(
  outcomes: Outcome[],
  metricName = "score",
): LearningCurvePoint[] {
  const scores = outcomes.map((outcome) => {
    if (typeof outcome.score === "number") return outcome.score;
    const metric = outcome.metrics[metricName];
    return typeof metric === "number" ? metric : null;
  });
  const bestSoFar = computeBestSoFar(scores);
  return scores.map((score, index) => ({
    index,
    score,
    bestSoFar: bestSoFar[index] ?? null,
  }));
}

export function peakScore(points: LearningCurvePoint[]): number | null {
  const values = points
    .map((p) => p.bestSoFar)
    .filter((v): v is number => typeof v === "number");
  return values.length > 0 ? Math.max(...values) : null;
}
