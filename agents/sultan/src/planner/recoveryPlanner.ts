import type { GameState } from "../game/types.js";
import type { StrategySnapshot } from "../game/strategyTypes.js";
import {
  BacktrackStore,
  buildFailureSignature,
  type BacktrackFailureNode,
} from "../memory/backtrackStore.js";

export type RecoveryPlan = {
  failureId: string;
  failureSignature: string;
  originDay: number;
  targetDay: number;
  depth: number;
  failedPathSignatures: string[];
  triedSiblingSignatures: string[];
  nextAction: "prev_round" | "try_sibling" | "start_new_game" | "none";
  hint: string;
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dayFromState(state: GameState | null | undefined): number | null {
  return asNumber(state?.values?.day) ?? asNumber(state?.values?.turn);
}

function sudanIdentityFromSnapshot(snapshot: StrategySnapshot | null | undefined): string | null {
  const card = snapshot?.sudanCard;
  if (!card) return null;
  return [card.cardId ?? "?", card.uid ?? "?", card.name ?? "?"].join("|");
}

export function maxBacktrackDepth(snapshot: StrategySnapshot | null | undefined): number {
  const initLife = snapshot?.sudanCard?.initLife ?? null;
  if (typeof initLife === "number" && Number.isFinite(initLife) && initLife > 0) {
    return Math.min(7, Math.max(1, Math.floor(initLife)));
  }
  return 7;
}

export function planTerminalRecovery(opts: {
  store: BacktrackStore;
  runId: string;
  state: GameState | null | undefined;
  snapshot: StrategySnapshot | null | undefined;
  recentPathSignatures?: string[];
  terminalReason?: string | null;
  prevRoundEnabled: boolean;
}): RecoveryPlan {
  const day = dayFromState(opts.state) ?? opts.snapshot?.day ?? 1;
  const sudanIdentity = sudanIdentityFromSnapshot(opts.snapshot);
  const pathSignatures = unique([
    ...(opts.recentPathSignatures ?? []),
    ...(opts.snapshot?.sudanRoutes?.bestRouteLabel
      ? [`route:${opts.snapshot.sudanRoutes.bestRouteLabel}`]
      : []),
  ]);
  const failureSignature = buildFailureSignature({
    sudanIdentity,
    pathSignatures,
    terminalReason: opts.terminalReason,
  });

  const existing = opts.store.activeFailure(opts.runId);
  let depth = 2;
  if (existing && existing.failureSignature === failureSignature) {
    depth = Math.min(maxBacktrackDepth(opts.snapshot), existing.depth + 2);
  }

  const anchors = opts.store.anchors(opts.runId);
  const earliestUseful =
    anchors.find((anchor) =>
      pathSignatures.some((sig) => anchor.executedPathSignatures.includes(sig)),
    )?.day ?? null;
  let targetDay =
    earliestUseful != null
      ? earliestUseful
      : Math.max(1, day - depth);
  targetDay = Math.max(1, Math.min(targetDay, day - 1));
  const cappedDepth = Math.min(maxBacktrackDepth(opts.snapshot), day - targetDay);

  const node = opts.store.createOrRefreshFailure({
    runId: opts.runId,
    failureSignature,
    originDay: day,
    targetDay,
    depth: Math.max(depth, cappedDepth),
    failedPathSignatures: pathSignatures,
    terminalReason: opts.terminalReason,
    sudanIdentity,
  });

  return recoveryPlanFromNode(node, {
    currentDay: day,
    prevRoundEnabled: opts.prevRoundEnabled,
    maxDepth: maxBacktrackDepth(opts.snapshot),
  });
}

export function recoveryPlanFromNode(
  node: BacktrackFailureNode,
  opts: {
    currentDay: number;
    prevRoundEnabled: boolean;
    maxDepth: number;
  },
): RecoveryPlan {
  if (node.status === "recovered") {
    return {
      failureId: node.id,
      failureSignature: node.failureSignature,
      originDay: node.originDay,
      targetDay: node.targetDay,
      depth: node.depth,
      failedPathSignatures: node.failedPathSignatures,
      triedSiblingSignatures: node.triedSiblingSignatures,
      nextAction: "none",
      hint: "Recovery complete; resume normal action chain.",
    };
  }

  if (opts.currentDay > node.targetDay) {
    if (!opts.prevRoundEnabled || node.depth > opts.maxDepth) {
      return {
        failureId: node.id,
        failureSignature: node.failureSignature,
        originDay: node.originDay,
        targetDay: node.targetDay,
        depth: node.depth,
        failedPathSignatures: node.failedPathSignatures,
        triedSiblingSignatures: node.triedSiblingSignatures,
        nextAction: "start_new_game",
        hint: "Cannot rewind further; start_new_game.",
      };
    }
    return {
      failureId: node.id,
      failureSignature: node.failureSignature,
      originDay: node.originDay,
      targetDay: node.targetDay,
      depth: node.depth,
      failedPathSignatures: node.failedPathSignatures,
      triedSiblingSignatures: node.triedSiblingSignatures,
      nextAction: "prev_round",
      hint: `Host recovery rewind toward day ${node.targetDay} (depth=${node.depth}).`,
    };
  }

  return {
    failureId: node.id,
    failureSignature: node.failureSignature,
    originDay: node.originDay,
    targetDay: node.targetDay,
    depth: node.depth,
    failedPathSignatures: node.failedPathSignatures,
    triedSiblingSignatures: node.triedSiblingSignatures,
    nextAction: "try_sibling",
    hint: `Reached target day ${node.targetDay}; try unseen sibling routes, never replay failed paths.`,
  };
}

export function deepenRecoveryTarget(opts: {
  store: BacktrackStore;
  runId: string;
  failure: BacktrackFailureNode;
  currentDay: number;
  snapshot: StrategySnapshot | null | undefined;
}): RecoveryPlan {
  const maxDepth = maxBacktrackDepth(opts.snapshot);
  const nextDepth = Math.min(maxDepth, opts.failure.depth + 2);
  const targetDay = Math.max(1, opts.currentDay - nextDepth);
  opts.store.setFailureStatus({
    runId: opts.runId,
    failureId: opts.failure.id,
    status: "open",
    depth: nextDepth,
    targetDay,
  });
  const refreshed = opts.store.activeFailure(opts.runId) ?? {
    ...opts.failure,
    depth: nextDepth,
    targetDay,
  };
  return recoveryPlanFromNode(refreshed, {
    currentDay: opts.currentDay,
    prevRoundEnabled: true,
    maxDepth,
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
