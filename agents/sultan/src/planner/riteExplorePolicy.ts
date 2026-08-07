import type { EntityKnowledgeRecord } from "@vibesultan/agent-learning-core";
import type { GameAction, GameState } from "../game/types.js";
import { adviseExecutionTiming } from "./executionTiming.js";
import { buildStrategySnapshot } from "../memory/experienceAdapter.js";
import {
  baselineSignaturesFromRoutes,
  buildPathSignature,
  signatureFromAssignments,
} from "../memory/riteComposition.js";
import { riteEventKey, type SultanEntityStores } from "../memory/entityMemory.js";
import type { EpisodeAssignment } from "../memory/episodeStore.js";
import type { RiteExploreStore } from "../memory/riteExploreStore.js";
import {
  buildRiteExploreBrief,
  HOST_DUPLICATE_HINT,
} from "../memory/riteExploreBrief.js";
import { versionKeyFromState } from "../memory/experienceAdapter.js";
import { isHostNoiseEvidence } from "../memory/hostActionErrors.js";

export type RiteExploreDecision =
  | { allow: true; isNovel: boolean; signature: string; eventKey: string; riteId: number; remaining: number }
  | { allow: false; error: string; detail: string; signature?: string; eventKey?: string; riteId?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isSudanOrientedAction(
  action: GameAction,
  state: GameState | null | undefined,
): boolean {
  const sudan = isRecord(state?.values?.sudan) ? state!.values!.sudan : {};
  const current = isRecord(sudan.currentCard) ? sudan.currentCard : null;
  const sudanId = asNumber(current?.id);
  if (sudanId == null) return false;
  // Heuristic: if current rite slots mention sudan card or event name looks like break outlet.
  const rite = isRecord(state?.values?.currentRite) ? state!.values!.currentRite : null;
  if (!rite) return false;
  const name = String(rite.name ?? "").toLowerCase();
  if (/苏丹|杀戮|纵欲|征服|奢靡|处刑|处决/.test(name)) return true;
  const slots = Array.isArray(rite.slots) ? rite.slots : [];
  for (const raw of slots) {
    if (!isRecord(raw)) continue;
    const summary = isRecord(raw.cardSummary) ? raw.cardSummary : null;
    const cardId = asNumber(summary?.cardId) ?? asNumber(summary?.id) ?? asNumber(raw.cardId);
    if (cardId === sudanId) return true;
    const type = String(summary?.type ?? "").toLowerCase();
    if (type.includes("sudan") || type === "sudan") return true;
  }
  return false;
}

export function previewCompositionFromState(
  state: GameState | null | undefined,
  configFingerprint: string,
): { riteId: number; eventKey: string; assignments: EpisodeAssignment[] } | null {
  const rite = isRecord(state?.values?.currentRite) ? state!.values!.currentRite : null;
  const riteId = asNumber(rite?.id);
  if (riteId == null || !rite) return null;
  const eventKey = riteEventKey(configFingerprint, riteId);
  const slots = Array.isArray(rite.slots) ? rite.slots : [];
  const cards = Array.isArray(state?.values?.cards)
    ? state!.values!.cards!
    : Array.isArray(state?.cards)
      ? state!.cards
      : [];
  const byUid = new Map<number, Record<string, unknown>>();
  for (const raw of cards as unknown[]) {
    if (!isRecord(raw)) continue;
    const uid = asNumber(raw.uid);
    if (uid != null) byUid.set(uid, raw);
  }
  const assignments: EpisodeAssignment[] = [];
  slots.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const slotIndex = asNumber(raw.index) ?? index;
    const slotKey = asString(raw.slotKey) ?? `s${slotIndex}`;
    const cardUid = asNumber(raw.cardUid);
    const acceptsOp = asString(raw.acceptsOp);
    if (cardUid != null) {
      const card = byUid.get(cardUid);
      const cardId = asNumber(card?.id) ?? asNumber(raw.cardId);
      if (cardId == null) return;
      assignments.push({
        cardId,
        cardUid,
        slotIndex,
        slotKey,
        empty: false,
        count: asNumber(card?.count) ?? asNumber((raw as { count?: unknown }).count),
        interactionKey: `${configFingerprint}:interaction:${cardId}:slot:${slotKey}`,
      });
      return;
    }
    const placeable = acceptsOp === "place_card_on_rite" || acceptsOp == null;
    if (!placeable) return;
    assignments.push({
      cardId: 0,
      cardUid: null,
      slotIndex,
      slotKey,
      empty: true,
      interactionKey: `${configFingerprint}:interaction:0:slot:${slotKey}`,
    });
  });
  return { riteId, eventKey, assignments };
}

export function collectBaselineSignatures(opts: {
  stores: SultanEntityStores;
  configFingerprint: string;
  riteId: number;
  eventKey: string;
}): string[] {
  const fp = opts.stores.fingerprints.resolve(opts.configFingerprint);
  const keys = opts.stores.fingerprints.expandKeys([
    riteEventKey(fp, opts.riteId),
    opts.eventKey,
  ]);
  const events = opts.stores.events
    .list()
    .filter((record) => keys.includes(record.key))
    .filter((record) => record.status === "validated" || record.status === "provisional");
  const out = new Set<string>();
  for (const event of events) {
    const routes = Array.isArray(event.facts.successfulRoutes)
      ? event.facts.successfulRoutes.filter((r): r is string => typeof r === "string")
      : [];
    for (const sig of baselineSignaturesFromRoutes({
      configFingerprint: fp,
      riteId: opts.riteId,
      routes,
    })) {
      out.add(sig);
    }
  }
  return [...out];
}

export function compositionHitsContradicted(opts: {
  stores: SultanEntityStores;
  configFingerprint: string;
  eventKey: string;
  assignments: EpisodeAssignment[];
}): boolean {
  const fpFamily = new Set(opts.stores.fingerprints.expand(opts.configFingerprint));
  const eventKeys = new Set(
    opts.stores.fingerprints.expandKeys([opts.eventKey]),
  );
  for (const assignment of opts.assignments) {
    if (assignment.empty || assignment.cardId == null || assignment.cardId === 0) continue;
    const hit = opts.stores.interactions.list().some((record) => {
      if (!isBlockingGameContradiction(record)) return false;
      if (!fpFamily.has(record.version.configFingerprint)) return false;
      if (Number(record.facts.cardId) !== assignment.cardId) return false;
      const slot = String(record.facts.slotKey ?? record.facts.slotIndex ?? "");
      const assignSlot = String(assignment.slotKey ?? assignment.slotIndex);
      if (slot && assignSlot && slot !== assignSlot) return false;
      const ek = String(record.facts.eventKey ?? "");
      return eventKeys.has(ek) || opts.stores.fingerprints.expandKeys([ek]).some((k) => eventKeys.has(k));
    });
    if (hit) return true;
  }
  return false;
}

/**
 * Only hard-block when contradicted status is backed by real game-negative
 * evidence (not host preflight noise like plan_single_step_only).
 */
export function isBlockingGameContradiction(record: {
  status?: string;
  evidence?: Array<{
    outcome?: string | null;
    summary?: string | null;
    context?: Record<string, unknown> | null;
  }>;
}): boolean {
  if (record.status !== "contradicted") return false;
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  return evidence.some(
    (item) => item.outcome === "negative" && !isHostNoiseEvidence(item),
  );
}

export function evaluateRiteExploreGate(opts: {
  action: GameAction;
  state: GameState | null | undefined;
  stores: SultanEntityStores;
  exploreStore: RiteExploreStore;
  runId: string;
  gameFingerprint?: string | null;
  backtrackStore?: import("../memory/backtrackStore.js").BacktrackStore | null;
}): RiteExploreDecision | null {
  if (opts.action.op !== "execute" && opts.action.op !== "start_rite") return null;

  const rawVersion = versionKeyFromState(opts.state, opts.gameFingerprint);
  const configFingerprint = opts.stores.fingerprints.resolve(rawVersion.configFingerprint);
  const preview = previewCompositionFromState(opts.state, configFingerprint);
  if (!preview || preview.assignments.length === 0) return null;

  const signature = signatureFromAssignments({
    configFingerprint,
    riteId: preview.riteId,
    assignments: preview.assignments,
  });
  const snapshot = buildStrategySnapshot({
    state: opts.state,
    gameFingerprint: opts.gameFingerprint,
  });
  const pathSignature = buildPathSignature({
    sudanIdentity: snapshot.sudanCard?.identity ?? null,
    routeLabel:
      (isRecord(opts.state?.values?.currentRite)
        ? asString(opts.state!.values!.currentRite!.name)
        : null) ?? String(preview.riteId),
    compositionSignature: signature,
  });
  if (
    opts.backtrackStore?.isFailedPath(opts.runId, pathSignature) ||
    opts.backtrackStore?.isFailedPath(opts.runId, signature)
  ) {
    return {
      allow: false,
      error: "failed_path_blacklist",
      detail: "path signature is blacklisted after terminal failure",
      signature,
      eventKey: preview.eventKey,
      riteId: preview.riteId,
    };
  }

  const baselines = collectBaselineSignatures({
    stores: opts.stores,
    configFingerprint,
    riteId: preview.riteId,
    eventKey: preview.eventKey,
  });
  const isBaseline = baselines.includes(signature);
  const remaining = opts.exploreStore.remainingBudget(preview.eventKey, opts.runId);

  if (compositionHitsContradicted({
    stores: opts.stores,
    configFingerprint,
    eventKey: preview.eventKey,
    assignments: preview.assignments,
  })) {
    return {
      allow: false,
      error: "rite_explore_contradicted",
      detail: "composition matches contradicted interaction evidence",
      signature,
      eventKey: preview.eventKey,
      riteId: preview.riteId,
    };
  }

  if (opts.exploreStore.hasTried(preview.eventKey, signature, opts.runId)) {
    const trials = opts.exploreStore.listTrials(preview.eventKey, opts.runId);
    const currentRite = isRecord(opts.state?.values?.currentRite)
      ? opts.state!.values!.currentRite
      : null;
    const brief = buildRiteExploreBrief({
      trials,
      riteName: asString(currentRite?.name),
      state: opts.state,
      stores: opts.stores,
      gameFingerprint: opts.gameFingerprint,
      includeHostDuplicateHint: true,
    });
    return {
      allow: false,
      error: "rite_explore_signature_duplicate",
      // Human-readable only — never put composition DSL signature in detail.
      detail: brief ?? HOST_DUPLICATE_HINT,
      signature,
      eventKey: preview.eventKey,
      riteId: preview.riteId,
    };
  }

  if (isBaseline) {
    return {
      allow: true,
      isNovel: false,
      signature,
      eventKey: preview.eventKey,
      riteId: preview.riteId,
      remaining,
    };
  }

  const timing = adviseExecutionTiming(snapshot);
  const sudanOriented = isSudanOrientedAction(opts.action, opts.state);
  const breaksCurrentSudan = compositionIncludesCurrentSudan(
    preview.assignments,
    opts.state,
  );

  // Last day: lock ordinary novel comps, but allow compositions that place the current sudan card.
  if (
    timing.executionDaysLeft != null &&
    timing.executionDaysLeft <= 1 &&
    !breaksCurrentSudan
  ) {
    return {
      allow: false,
      error: "rite_explore_commit_locked",
      detail: "executionDaysLeft<=1 locks baseline; novel compositions blocked",
      signature,
      eventKey: preview.eventKey,
      riteId: preview.riteId,
    };
  }

  if (timing.executionDaysLeft === 2 && !sudanOriented && !breaksCurrentSudan) {
    return {
      allow: false,
      error: "rite_explore_branch_window",
      detail: "executionDaysLeft=2: ordinary rites must stay on baseline",
      signature,
      eventKey: preview.eventKey,
      riteId: preview.riteId,
    };
  }

  // Sudan-break compositions are exempt from novel budget (baseline often has empty sudan slot).
  if (
    !breaksCurrentSudan &&
    opts.exploreStore.exploreCount(preview.eventKey, opts.runId) >=
      opts.exploreStore.maxNovelPerRite()
  ) {
    return {
      allow: false,
      error: "rite_explore_limit",
      detail: `novel explore budget exhausted for ${preview.eventKey}`,
      signature,
      eventKey: preview.eventKey,
      riteId: preview.riteId,
    };
  }

  return {
    allow: true,
    isNovel: true,
    signature,
    eventKey: preview.eventKey,
    riteId: preview.riteId,
    remaining: breaksCurrentSudan
      ? remaining
      : Math.max(0, remaining - 1),
  };
}

/** True when any non-empty assignment is the current sudan card (by id or uid). */
export function compositionIncludesCurrentSudan(
  assignments: EpisodeAssignment[],
  state: GameState | null | undefined,
): boolean {
  const sudan = isRecord(state?.values?.sudan) ? state!.values!.sudan : {};
  const current = isRecord(sudan.currentCard) ? sudan.currentCard : null;
  const sudanId = asNumber(current?.id);
  const sudanUid = asNumber(current?.uid);
  if (sudanId == null && sudanUid == null) return false;
  return assignments.some((a) => {
    if (a.empty || a.cardId == null || a.cardId === 0) return false;
    if (sudanId != null && a.cardId === sudanId) return true;
    if (sudanUid != null && a.cardUid === sudanUid) return true;
    return false;
  });
}

export function annotateExploreConfigurations(opts: {
  configurations: import("../game/strategyTypes.js").EventConfiguration[];
  stores: SultanEntityStores;
  exploreStore: RiteExploreStore;
  backtrackStore?: import("../memory/backtrackStore.js").BacktrackStore | null;
  runId: string;
  state: GameState | null | undefined;
  gameFingerprint?: string | null;
  failedPathBoost?: boolean;
}): import("../game/strategyTypes.js").EventConfiguration[] {
  const rawVersion = versionKeyFromState(opts.state, opts.gameFingerprint);
  const configFingerprint = opts.stores.fingerprints.resolve(rawVersion.configFingerprint);
  const snapshot = buildStrategySnapshot({
    state: opts.state,
    gameFingerprint: opts.gameFingerprint,
  });
  const timing = adviseExecutionTiming(snapshot);
  const sudanIdentity = snapshot.sudanCard?.identity ?? null;

  return opts.configurations.map((config) => {
    const riteId = config.event.riteId;
    if (riteId == null || !config.assignments.length) return config;
    const eventKey = riteEventKey(configFingerprint, riteId);
    const assignments: EpisodeAssignment[] = config.assignments.map((a) => ({
      cardId: a.card.cardId ?? 0,
      cardUid: a.uid ?? null,
      slotIndex: a.slotIndex,
      slotKey: `s${a.slotIndex}`,
      empty: a.card.cardId == null || a.card.cardId === 0,
      count: a.count,
      interactionKey: `${configFingerprint}:interaction:${a.card.cardId ?? 0}:slot:s${a.slotIndex}`,
    }));
    const signature = signatureFromAssignments({
      configFingerprint,
      riteId,
      assignments,
    });
    const pathSignature = buildPathSignature({
      sudanIdentity,
      routeLabel: config.event.name ?? String(riteId),
      compositionSignature: signature,
    });
    const baselines = collectBaselineSignatures({
      stores: opts.stores,
      configFingerprint,
      riteId,
      eventKey,
    });
    const isBaseline = baselines.includes(signature);
    const remaining = opts.exploreStore.remainingBudget(eventKey, opts.runId);
    let exploreKind: "baseline" | "novel" | "blocked" = isBaseline ? "baseline" : "novel";
    let exploreBlockedReason: string | null = null;

    if (
      opts.backtrackStore?.isFailedPath(opts.runId, pathSignature) ||
      opts.backtrackStore?.isFailedPath(opts.runId, signature)
    ) {
      exploreKind = "blocked";
      exploreBlockedReason = "failed_path";
    } else if (opts.exploreStore.hasTried(eventKey, signature, opts.runId)) {
      exploreKind = "blocked";
      exploreBlockedReason = "rite_explore_signature_duplicate";
    } else if (
      compositionHitsContradicted({
        stores: opts.stores,
        configFingerprint,
        eventKey,
        assignments,
      })
    ) {
      exploreKind = "blocked";
      exploreBlockedReason = "rite_explore_contradicted";
    } else if (!isBaseline) {
      const breaksCurrentSudan = compositionIncludesCurrentSudan(assignments, opts.state);
      if (
        timing.executionDaysLeft != null &&
        timing.executionDaysLeft <= 1 &&
        !breaksCurrentSudan
      ) {
        exploreKind = "blocked";
        exploreBlockedReason = "rite_explore_commit_locked";
      } else if (timing.executionDaysLeft === 2 && !breaksCurrentSudan) {
        exploreKind = "blocked";
        exploreBlockedReason = "rite_explore_branch_window";
      } else if (
        !breaksCurrentSudan &&
        opts.exploreStore.exploreCount(eventKey, opts.runId) >=
          opts.exploreStore.maxNovelPerRite()
      ) {
        exploreKind = "blocked";
        exploreBlockedReason = "rite_explore_limit";
      }
    }

    const recoveryPriority =
      opts.failedPathBoost && exploreKind !== "blocked" && !isBaseline
        ? 8
        : exploreKind === "baseline"
          ? 2
          : 0;

    return {
      ...config,
      exploreKind,
      exploreRemaining: remaining,
      exploreBlockedReason,
      pathSignature,
      recoveryPriority,
      baseScore: config.baseScore + recoveryPriority,
    };
  });
}

export function filterBlockedExploreConfigurations(
  configurations: import("../game/strategyTypes.js").EventConfiguration[],
): import("../game/strategyTypes.js").EventConfiguration[] {
  return configurations.filter((c) => c.exploreKind !== "blocked");
}

export function summarizeEntityBaselines(
  events: EntityKnowledgeRecord[],
  configFingerprint: string,
  riteId: number,
): string[] {
  const routes = events.flatMap((event) =>
    Array.isArray(event.facts.successfulRoutes)
      ? event.facts.successfulRoutes.filter((r): r is string => typeof r === "string")
      : [],
  );
  return baselineSignaturesFromRoutes({ configFingerprint, riteId, routes });
}
