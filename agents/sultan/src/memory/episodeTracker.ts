import type {
  KnowledgeOutcome,
  KnowledgeVersionKey,
} from "@vibesultan/agent-learning-core";
import type { GameState } from "../game/types.js";
import {
  captureEpisodeSnapshot,
  combineOutcomeSignals,
  formatInputComposition,
  scoreCrossDayDelta,
  scoreImmediateRiteResult,
  scoreStrategicSettlement,
  type EpisodeStateSnapshot,
} from "./episodeOutcome.js";
import {
  EpisodeStore,
  type EpisodeAssignment,
  type PendingEpisode,
  type StrategicTargets,
} from "./episodeStore.js";

export interface RiteSettlement {
  episode: PendingEpisode;
  outcome: KnowledgeOutcome;
  summary: string;
  result: Record<string, unknown>;
}

export class EpisodeTracker {
  constructor(
    readonly store: EpisodeStore,
    readonly ttlSteps = 120,
  ) {}

  recordPlacement(input: {
    version: KnowledgeVersionKey;
    eventKey: string;
    riteId: number;
    riteUid?: number | null;
    assignment: EpisodeAssignment;
    day?: number | null;
    runId?: string;
    step?: number;
    branchId?: string | null;
  }): PendingEpisode {
    const existing = this.store.findOpen(input.eventKey, input.runId);
    if (existing) {
      const composition = mergeAssignments(existing.composition, [input.assignment]);
      return this.store.update(existing.id, {
        phase:
          existing.phase === "submitted" ||
          existing.phase === "awaiting_result" ||
          existing.phase === "awaiting_day_verify"
            ? existing.phase
            : "placement",
        riteUid: input.riteUid ?? existing.riteUid,
        composition,
        inputSummary: formatInputComposition(composition),
        updatedStep: input.step,
        branchId: input.branchId ?? existing.branchId ?? null,
      })!;
    }
    return this.store.create({
      kind: "rite",
      phase: "placement",
      version: input.version,
      eventKey: input.eventKey,
      riteId: input.riteId,
      riteUid: input.riteUid,
      day: input.day,
      composition: [input.assignment],
      inputSummary: formatInputComposition([input.assignment]),
      settlementExperienceIds: [],
      runId: input.runId,
      openedStep: input.step,
      updatedStep: input.step,
      branchId: input.branchId ?? null,
      applied: false,
    });
  }

  recordSubmit(input: {
    version: KnowledgeVersionKey;
    eventKey: string;
    riteId: number;
    riteUid?: number | null;
    composition?: EpisodeAssignment[];
    experienceId?: string;
    day?: number | null;
    runId?: string;
    step?: number;
    baseline?: EpisodeStateSnapshot | null;
    state?: GameState | null;
    branchId?: string | null;
  }): PendingEpisode {
    const baseline =
      input.baseline ?? captureEpisodeSnapshot(input.state ?? null);
    const existing = this.store.findOpen(input.eventKey, input.runId);
    if (existing) {
      const composition = mergeAssignments(
        existing.composition,
        input.composition ?? [],
      );
      return this.store.update(existing.id, {
        phase: "submitted",
        riteUid: input.riteUid ?? existing.riteUid,
        composition,
        inputSummary: formatInputComposition(composition),
        baseline: existing.baseline ?? baseline,
        executeExperienceId: input.experienceId ?? existing.executeExperienceId,
        day: input.day ?? existing.day ?? baseline.day,
        updatedStep: input.step,
        branchId: input.branchId ?? existing.branchId ?? null,
      })!;
    }
    const composition = input.composition ?? [];
    return this.store.create({
      kind: "rite",
      phase: "submitted",
      version: input.version,
      eventKey: input.eventKey,
      riteId: input.riteId,
      riteUid: input.riteUid,
      day: input.day ?? baseline.day,
      composition,
      inputSummary: formatInputComposition(composition),
      baseline,
      executeExperienceId: input.experienceId,
      settlementExperienceIds: [],
      runId: input.runId,
      openedStep: input.step,
      updatedStep: input.step,
      branchId: input.branchId ?? null,
      applied: false,
    });
  }

  observeState(
    state: GameState | null | undefined,
    opts?: { step?: number; experienceId?: string },
  ): RiteSettlement[] {
    const open = this.store
      .listOpen()
      .filter(
        (episode) =>
          episode.phase === "submitted" ||
          episode.phase === "awaiting_result" ||
          episode.phase === "awaiting_day_verify",
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (open.length === 0) return [];

    const riteResult = asRecord(state?.values?.riteResult);
    const active = riteResult.active === true || state?.screen?.phase === "rite_result";
    const settlements: RiteSettlement[] = [];

    if (active) {
      const candidates = open.filter(
        (episode) =>
          episode.phase === "submitted" || episode.phase === "awaiting_result",
      );
      if (candidates.length === 0) return [];
      const picked = pickEpisodeForRiteResult(candidates, riteResult, state);
      if (!picked) return [];
      const episode = picked.episode;
      const settlementExperienceIds = opts?.experienceId
        ? [...new Set([...episode.settlementExperienceIds, opts.experienceId])]
        : episode.settlementExperienceIds;
      // Bind identity to the episode's riteId/eventKey; never let a mismatched
      // panel title re-attribute the settlement to another event.
      const mergedSettlement = sanitizeSettlementPayload({
        ...(episode.settlement ?? {}),
        ...riteResult,
        ...(picked.titleMismatch
          ? {
              title: picked.expectedTitle ?? riteResult.title,
              attribution: "episode_riteId",
              panelTitle: riteResult.title,
              titleMismatch: true,
            }
          : {}),
      });
      const immediate = scoreImmediateRiteResult(mergedSettlement, state);
      const updated = this.store.update(episode.id, {
        phase: immediate.decisive ? "awaiting_result" : "awaiting_day_verify",
        settlement: mergedSettlement,
        settlementExperienceIds,
        immediateSignals: immediate.signals,
        baseline: episode.baseline ?? captureEpisodeSnapshot(state),
        quarantined: picked.titleMismatch === true ? true : episode.quarantined,
        updatedStep: opts?.step,
      })!;

      if (immediate.decisive && immediate.outcome) {
        const summary = [
          formatInputComposition(updated.composition),
          `outcome=${immediate.outcome}`,
          ...immediate.signals.map((signal) => `${signal.source}:${signal.detail}`),
        ].join(" | ");
        const settled = this.store.update(updated.id, {
          outcome: immediate.outcome,
          settlement: { ...mergedSettlement, summary },
          quarantined: picked.titleMismatch === true ? true : updated.quarantined,
          updatedStep: opts?.step,
        })!;
        // Mismatched panel title must not pollute entity memory.
        if (!settled.applied && !settled.quarantined) {
          settlements.push({
            episode: settled,
            outcome: immediate.outcome,
            summary,
            result: mergedSettlement,
          });
        }
      }
      return settlements;
    }

    // Left result page: dice-decisive settle; otherwise keep for cross-day verify.
    for (const pending of open) {
      if (pending.applied) continue;
      if (pending.phase === "awaiting_day_verify") continue;
      const stored = asRecord(pending.settlement);
      const immediate = scoreImmediateRiteResult(stored, state);
      if (immediate.decisive && immediate.outcome) {
        const summary = [
          formatInputComposition(pending.composition),
          `outcome=${immediate.outcome}`,
          ...immediate.signals.map((signal) => `${signal.source}:${signal.detail}`),
        ].join(" | ");
        const settled = this.store.update(pending.id, {
          outcome: immediate.outcome,
          settlement: { ...stored, summary },
          immediateSignals: immediate.signals,
          updatedStep: opts?.step,
        })!;
        settlements.push({
          episode: settled,
          outcome: immediate.outcome,
          summary,
          result: stored,
        });
        continue;
      }
      // Only defer episodes that already saw a rite_result page.
      if (pending.phase === "awaiting_result" || Object.keys(stored).length > 0) {
        this.store.update(pending.id, {
          phase: "awaiting_day_verify",
          immediateSignals: immediate.signals,
          settlement: {
            ...stored,
            reason: "awaiting_cross_day_verify",
            summary: "awaiting next-day card/counter verification",
          },
          updatedStep: opts?.step,
        });
      }
    }
    return settlements;
  }

  /** Open an altruistic choice episode that settles when a target card arrives. */
  recordStrategicChoice(input: {
    version: KnowledgeVersionKey;
    eventKey: string;
    optionIndex: number | null;
    optionLabel?: string | null;
    strategicTargets: StrategicTargets;
    horizonDays?: number;
    day?: number | null;
    runId?: string;
    step?: number;
    baseline?: EpisodeStateSnapshot | null;
    branchId?: string | null;
  }): PendingEpisode {
    const existing = this.store
      .listOpen()
      .find(
        (episode) =>
          episode.kind === "choice" &&
          episode.phase === "pending_strategic" &&
          episode.eventKey === input.eventKey &&
          episode.runId === input.runId,
      );
    if (existing) {
      return this.store.update(existing.id, {
        strategicTargets: input.strategicTargets,
        horizonDays: input.horizonDays ?? existing.horizonDays ?? 30,
        baseline: existing.baseline ?? input.baseline ?? undefined,
        updatedStep: input.step,
        branchId: input.branchId ?? existing.branchId ?? null,
      })!;
    }
    return this.store.create({
      kind: "choice",
      phase: "pending_strategic",
      version: input.version,
      eventKey: input.eventKey,
      riteId: 0,
      day: input.day,
      composition: [],
      inputSummary: `choice option ${input.optionIndex ?? "?"}: ${input.optionLabel ?? "unknown"}`,
      baseline: input.baseline ?? undefined,
      settlementExperienceIds: [],
      runId: input.runId,
      openedStep: input.step,
      updatedStep: input.step,
      branchId: input.branchId ?? null,
      strategicTargets: input.strategicTargets,
      horizonDays: input.horizonDays ?? 30,
      applied: false,
      settlement: {
        kind: "pending_strategic",
        optionIndex: input.optionIndex,
        optionLabel: input.optionLabel ?? null,
      },
    });
  }

  /** Settle story/deferred rites after the game day advances. */
  observeDayAdvance(
    state: GameState | null | undefined,
    opts?: { step?: number; previousDay?: number | null },
  ): RiteSettlement[] {
    const after = captureEpisodeSnapshot(state);
    const currentDay = after.day;
    if (currentDay == null) return [];
    const settlements: RiteSettlement[] = [];

    for (const pending of this.store.listOpen()) {
      if (pending.phase === "pending_strategic") {
        const strategic = scoreStrategicSettlement(
          pending.baseline,
          after,
          pending.strategicTargets ?? {},
          {
            openedDay: pending.day ?? pending.baseline?.day ?? null,
            horizonDays: pending.horizonDays ?? 30,
          },
        );
        if (!strategic.outcome) continue;
        const summary = [pending.inputSummary, strategic.summary]
          .filter(Boolean)
          .join(" | ");
        if (strategic.outcome === "inconclusive") {
          this.store.update(pending.id, {
            phase: "abandoned",
            outcome: "inconclusive",
            settlement: {
              ...(pending.settlement ?? {}),
              summary,
              reason: "strategic_timeout",
              strategicSignals: strategic.signals,
              verifyDay: currentDay,
            },
            updatedStep: opts?.step,
          });
          continue;
        }
        const settled = this.store.update(pending.id, {
          outcome: strategic.outcome,
          settlement: {
            ...(pending.settlement ?? {}),
            summary,
            long_term_positive: true,
            strategicSignals: strategic.signals,
            verifyDay: currentDay,
          },
          updatedStep: opts?.step,
        })!;
        settlements.push({
          episode: settled,
          outcome: strategic.outcome,
          summary,
          result: settled.settlement ?? {},
        });
        continue;
      }

      if (pending.phase !== "awaiting_day_verify" && pending.phase !== "awaiting_result") {
        continue;
      }
      if (pending.applied) continue;
      const episodeDay = pending.day ?? pending.baseline?.day ?? null;
      const dayAdvanced =
        episodeDay != null
          ? currentDay > episodeDay
          : opts?.previousDay != null && currentDay > opts.previousDay;
      if (!dayAdvanced) continue;

      const crossDay = scoreCrossDayDelta(pending.baseline, after, {
        composition: pending.composition,
      });
      const immediate = {
        outcome: null as KnowledgeOutcome | null,
        signals: pending.immediateSignals ?? [],
      };
      // Re-score stored rite result as soft immediate signal.
      const storedImmediate = scoreImmediateRiteResult(asRecord(pending.settlement), state);
      immediate.signals = [...immediate.signals, ...storedImmediate.signals];
      immediate.outcome = storedImmediate.decisive ? storedImmediate.outcome : null;

      const combined = combineOutcomeSignals({ immediate, crossDay });
      if (!combined.outcome || combined.outcome === "inconclusive") {
        // Wait one more day max, then abandon.
        if (episodeDay != null && currentDay - episodeDay >= 2) {
          this.store.update(pending.id, {
            phase: "abandoned",
            outcome: "inconclusive",
            settlement: {
              ...(pending.settlement ?? {}),
              reason: "cross_day_inconclusive",
              summary: combined.summary || "no decisive card/counter delta after day advance",
              crossDaySignals: combined.signals,
            },
            updatedStep: opts?.step,
          });
        }
        continue;
      }

      const summary = [
        formatInputComposition(pending.composition),
        combined.summary,
      ].join(" | ");
      const settled = this.store.update(pending.id, {
        outcome: combined.outcome,
        settlement: {
          ...(pending.settlement ?? {}),
          summary,
          crossDaySignals: combined.signals,
          verifyDay: currentDay,
        },
        updatedStep: opts?.step,
      })!;
      settlements.push({
        episode: settled,
        outcome: combined.outcome,
        summary,
        result: settled.settlement ?? {},
      });
    }
    return settlements;
  }

  unappliedSettlements(): RiteSettlement[] {
    return this.store
      .list()
      .filter(
        (episode) =>
          episode.outcome &&
          episode.outcome !== "inconclusive" &&
          !episode.applied &&
          episode.phase !== "abandoned",
      )
      .map((episode) => ({
        episode,
        outcome: episode.outcome!,
        summary: String(episode.settlement?.summary ?? `rite ${episode.riteId} settled`),
        result: episode.settlement ?? {},
      }));
  }

  markApplied(id: string): PendingEpisode | undefined {
    return this.store.update(id, {
      phase: "settled",
      applied: true,
      settledAt: new Date().toISOString(),
    });
  }

  abandonExpired(currentStep: number): PendingEpisode[] {
    const abandoned: PendingEpisode[] = [];
    for (const episode of this.store.listOpen()) {
      // Give cross-day verify more room than in-panel episodes.
      const ttl =
        episode.phase === "awaiting_day_verify" || episode.phase === "pending_strategic"
          ? Math.max(this.ttlSteps, 240)
          : this.ttlSteps;
      const base = episode.updatedStep ?? episode.openedStep;
      if (base == null || currentStep - base <= ttl) continue;
      const updated = this.store.update(episode.id, {
        phase: "abandoned",
        outcome: "inconclusive",
        settlement: {
          ...(episode.settlement ?? {}),
          reason: "episode_ttl_expired",
        },
      });
      if (updated) abandoned.push(updated);
    }
    return abandoned;
  }
}

function mergeAssignments(
  current: EpisodeAssignment[],
  incoming: EpisodeAssignment[],
): EpisodeAssignment[] {
  const merged = new Map<string, EpisodeAssignment>();
  for (const assignment of [...current, ...incoming]) {
    const key = `${assignment.slotKey ?? assignment.slotIndex}`;
    merged.set(key, assignment);
  }
  return [...merged.values()].sort((a, b) => a.slotIndex - b.slotIndex);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRiteTitle(raw: unknown): string {
  return String(raw ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function sanitizeSettlementPayload(
  settlement: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...settlement };
  const tip = String(next.tip ?? "").trim();
  if (!tip || /^new\s*text$/i.test(tip)) {
    next.tip = null;
  }
  return next;
}

function riteNameFromState(
  state: GameState | null | undefined,
  riteId: number,
  riteUid?: number | null,
): string | null {
  const values = asRecord(state?.values);
  const current = asRecord(values.currentRite);
  if (
    (typeof current.id === "number" && current.id === riteId) ||
    (riteUid != null && Number(current.uid) === riteUid)
  ) {
    const name = current.name ?? current.customName;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  const rites = Array.isArray(values.rites) ? values.rites : [];
  for (const raw of rites) {
    const rite = asRecord(raw);
    if (Number(rite.id) === riteId || (riteUid != null && Number(rite.uid) === riteUid)) {
      const name = rite.name ?? rite.customName;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  }
  return null;
}

function titlesMatch(panelTitle: string, expected: string | null): boolean {
  if (!panelTitle || !expected) return false;
  const a = normalizeRiteTitle(panelTitle);
  const b = normalizeRiteTitle(expected);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Prefer the open episode whose rite identity matches the result panel.
 * Falls back to newest candidate but flags titleMismatch so callers can refuse entity apply.
 */
function pickEpisodeForRiteResult(
  candidates: PendingEpisode[],
  riteResult: Record<string, unknown>,
  state: GameState | null | undefined,
): {
  episode: PendingEpisode;
  titleMismatch: boolean;
  expectedTitle: string | null;
} | null {
  if (candidates.length === 0) return null;
  const panelTitle = normalizeRiteTitle(riteResult.title);
  const panelUid =
    typeof riteResult.riteUid === "number"
      ? riteResult.riteUid
      : typeof riteResult.uid === "number"
        ? riteResult.uid
        : null;
  const panelRiteId =
    typeof riteResult.riteId === "number"
      ? riteResult.riteId
      : typeof riteResult.id === "number"
        ? riteResult.id
        : null;

  const scored = candidates.map((episode) => {
    const expectedTitle = riteNameFromState(state, episode.riteId, episode.riteUid);
    let score = 0;
    if (panelUid != null && episode.riteUid != null && panelUid === episode.riteUid) {
      score += 100;
    }
    if (panelRiteId != null && panelRiteId === episode.riteId) score += 80;
    if (titlesMatch(panelTitle, expectedTitle)) score += 60;
    return { episode, expectedTitle, score };
  });
  scored.sort((a, b) => b.score - a.score || b.episode.updatedAt.localeCompare(a.episode.updatedAt));
  const best = scored[0]!;
  const titleMismatch =
    Boolean(panelTitle) &&
    Boolean(best.expectedTitle) &&
    !titlesMatch(panelTitle, best.expectedTitle) &&
    best.score < 60;
  return {
    episode: best.episode,
    titleMismatch,
    expectedTitle: best.expectedTitle,
  };
}
