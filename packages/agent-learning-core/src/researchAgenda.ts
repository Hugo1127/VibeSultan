import type { ExperimentPlan } from "./types.js";
import type { Hypothesis } from "./types.js";
import type { OutcomeClass } from "./types.js";

export interface TopicAgenda {
  topicKey: string;
  attempts: number;
  recentOutcomes: OutcomeClass[];
  coolingDown: boolean;
}

export interface ResearchAgenda {
  topics: TopicAgenda[];
  pendingValidate: Hypothesis[];
  retryCandidates: Hypothesis[];
  nextExperiment: ExperimentPlan | null;
  nextHypothesis: Hypothesis | null;
}

export function buildResearchAgenda(
  hypotheses: Hypothesis[],
  ledgerQueue: ExperimentPlan[] = [],
): ResearchAgenda {
  const byTopic = new Map<string, Hypothesis[]>();
  for (const hypothesis of hypotheses) {
    const list = byTopic.get(hypothesis.topicKey) ?? [];
    list.push(hypothesis);
    byTopic.set(hypothesis.topicKey, list);
  }

  const topics = [...byTopic.entries()].map(([topicKey, entries]) => {
    const recent = [...entries]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 3)
      .map((entry) => entry.outcomeClass);
    return {
      topicKey,
      attempts: entries.length,
      recentOutcomes: recent,
      coolingDown:
        recent.length >= 3 &&
        recent.every((outcome) =>
          ["confounded", "noncompliant", "no_headroom", "infra_failure"].includes(
            outcome,
          ),
        ),
    };
  });

  const pendingValidate = hypotheses
    .filter(
      (h) =>
        h.status === "candidate" &&
        h.nextAction === "await_validate" &&
        Boolean(h.primaryMetric),
    )
    .sort((a, b) => a.sessionIndex - b.sessionIndex || a.createdAt.localeCompare(b.createdAt));

  const retryCandidates = hypotheses
    .filter(
      (h) =>
        h.status === "inconclusive" &&
        h.nextAction === "retry_same" &&
        Boolean(h.primaryMetric),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const cooledTopicKeys = new Set(
    topics.filter((t) => t.coolingDown).map((t) => t.topicKey),
  );

  const nextFromLedger =
    ledgerQueue.find((plan) => {
      const hypothesis = hypotheses.find((h) => h.id === plan.hypothesisId);
      return hypothesis && !cooledTopicKeys.has(hypothesis.topicKey);
    }) ?? ledgerQueue[0] ?? null;

  const nextHypothesis =
    pendingValidate.find((h) => !cooledTopicKeys.has(h.topicKey)) ??
    retryCandidates.find((h) => !cooledTopicKeys.has(h.topicKey)) ??
    pendingValidate[0] ??
    retryCandidates[0] ??
    null;

  return {
    topics,
    pendingValidate,
    retryCandidates,
    nextExperiment: nextFromLedger,
    nextHypothesis,
  };
}

export function selectNextExperiment(
  hypotheses: Hypothesis[],
  ledgerQueue: ExperimentPlan[],
): { plan: ExperimentPlan | null; hypothesis: Hypothesis | null } {
  const agenda = buildResearchAgenda(hypotheses, ledgerQueue);
  if (agenda.nextExperiment) {
    const hypothesis =
      hypotheses.find((h) => h.id === agenda.nextExperiment!.hypothesisId) ??
      agenda.nextHypothesis;
    return { plan: agenda.nextExperiment, hypothesis: hypothesis ?? null };
  }
  return { plan: null, hypothesis: agenda.nextHypothesis };
}
