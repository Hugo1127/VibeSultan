import fs from "node:fs";
import path from "node:path";
import { EnrichmentQueue } from "./enrichmentQueue.js";
import { EpisodeStore } from "./episodeStore.js";
import { RiteExploreStore } from "./riteExploreStore.js";
import { BacktrackStore } from "./backtrackStore.js";
import { SudanBranchStore } from "./sudanBranchStore.js";
import { SudanRouteStore } from "./sudanRouteStore.js";
import { updateMemorySessionMeta } from "./session.js";

export type NewGameResetResult = {
  ok: boolean;
  error?: string;
  abandonedEpisodes: number;
  abortedEnrichmentJobs: number;
  clearedPendingProbes: boolean;
  clearedActiveBranch: boolean;
  checkpointReset: boolean;
  metaReset: boolean;
};

function emptyActionChainCheckpoint(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    day: null,
    phase: "entry_setup",
    entrySetupDone: false,
    sudanDrawn: false,
    newsChecked: false,
    newsPresent: null,
    newsSummary: null,
    top3: [],
    reviewedCardUids: [],
    inspectedCardUids: [],
    cardBaselineInitialized: false,
    seenCardIds: [],
    newCardUids: [],
    requiredInspectionCardUids: [],
    inspectionReasons: {},
    reviewedRiteUids: [],
    previousMap: [],
    mapChanges: [],
    allocations: [],
    idleCards: [],
    localImproveDone: false,
    utilizationOk: false,
    sudanBreakDone: false,
    sudanRouteProbePending: 0,
    sudanExchangeTierRegression: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Atomically reset run-scoped state after a successful new game boot / start_new_game.
 * Preserves cross-run knowledge: cards/events/interactions, experiences, tips/hypotheses,
 * fingerprint aliases, skills, outcomes.
 */
export function resetRunScopedState(opts: {
  sessionDir: string;
  runId?: string | null;
  gameIndex?: number;
}): NewGameResetResult {
  const sessionDir = opts.sessionDir;
  const result: NewGameResetResult = {
    ok: false,
    abandonedEpisodes: 0,
    abortedEnrichmentJobs: 0,
    clearedPendingProbes: false,
    clearedActiveBranch: false,
    checkpointReset: false,
    metaReset: false,
  };

  try {
    const episodeStore = new EpisodeStore(sessionDir);
    result.abandonedEpisodes = episodeStore.abandonOpenEpisodes("new_game_reset").length;

    const routeStore = new SudanRouteStore(sessionDir);
    const beforeProbes = routeStore.pendingProbes().length;
    routeStore.clearPendingProbes();
    result.clearedPendingProbes = true;
    void beforeProbes;

    const branchStore = new SudanBranchStore(sessionDir);
    branchStore.clearActive();
    result.clearedActiveBranch = true;

    const exploreStore = new RiteExploreStore(sessionDir);
    const backtrackStore = new BacktrackStore(sessionDir);
    if (opts.runId) {
      exploreStore.beginRun(opts.runId, opts.gameIndex);
      backtrackStore.beginRun(opts.runId);
    } else {
      exploreStore.clearActiveRun();
      backtrackStore.clearActiveRun();
    }

    const enrichmentQueue = new EnrichmentQueue(sessionDir);
    result.abortedEnrichmentJobs = enrichmentQueue.abortRunning("new_game_reset");

    const checkpointPath = path.join(sessionDir, "action-chain-checkpoint.json");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      checkpointPath,
      JSON.stringify(emptyActionChainCheckpoint(), null, 2),
      "utf8",
    );
    result.checkpointReset = true;

    updateMemorySessionMeta(sessionDir, {
      lastReviewedDay: null,
      activeHypothesisId: null,
    });
    result.metaReset = true;

    result.ok = true;
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}
