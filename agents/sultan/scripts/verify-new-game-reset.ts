import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ExperienceStore,
  HypothesisStore,
  TipStore,
} from "@vibesultan/agent-learning-core";
import { createSultanEntityStores } from "../src/memory/entityMemory.js";
import { EpisodeStore } from "../src/memory/episodeStore.js";
import { SudanRouteStore } from "../src/memory/sudanRouteStore.js";
import { SudanBranchStore } from "../src/memory/sudanBranchStore.js";
import { EnrichmentQueue } from "../src/memory/enrichmentQueue.js";
import { resetRunScopedState } from "../src/memory/newGameReset.js";
import { updateMemorySessionMeta } from "../src/memory/session.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-newgame-"));
}

function seedPollutedSession(dir: string): {
  tipCount: number;
  experienceCount: number;
  cardCount: number;
} {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        id: path.basename(dir),
        createdAt: new Date().toISOString(),
        lastReviewedDay: 9,
        activeHypothesisId: "hyp_old",
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "action-chain-checkpoint.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        day: 6,
        phase: "allocation",
        entrySetupDone: true,
        sudanDrawn: true,
        newsChecked: true,
        seenCardIds: [1, 2, 3],
        allocations: [{ cardUid: 1, riteUid: 2, slotIndex: 0 }],
        sudanRouteProbePending: 114,
        top3: [{ title: "old", why: "old" }],
        reviewedCardUids: [],
        inspectedCardUids: [],
        cardBaselineInitialized: true,
        newCardUids: [],
        requiredInspectionCardUids: [],
        inspectionReasons: {},
        reviewedRiteUids: [],
        previousMap: [],
        mapChanges: [],
        idleCards: [],
        localImproveDone: true,
        utilizationOk: true,
        sudanBreakDone: false,
        newsPresent: false,
        newsSummary: null,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  const stores = createSultanEntityStores(dir);
  stores.cards.touch({
    key: "cfg:card:1",
    kind: "card",
    version: { gameFingerprint: "g1", configFingerprint: "cfg" },
    facts: { cardId: 1, name: "Hero" },
  });

  const episodes = new EpisodeStore(dir);
  episodes.create({
    kind: "rite",
    phase: "submitted",
    version: { configFingerprint: "cfg", contentHash: "e1" },
    eventKey: "cfg:rite:1",
    riteId: 1,
    composition: [],
    settlementExperienceIds: [],
    applied: false,
    runId: "old-run",
  });

  const routes = new SudanRouteStore(dir);
  routes.markPendingProbe("cfg:event:probe1");
  routes.markPendingProbe("cfg:event:probe2");
  routes.setLastSudanIdentity(9001, "9001|1|old");

  const branches = new SudanBranchStore(dir);
  branches.startTrial({
    anchorDay: 6,
    anchorSignature: "anchor",
    actionSignature: "sig",
    actions: ["execute"],
    sudanCardId: 9001,
    sudanIdentity: "9001|1|old",
    mapSignature: "map",
    baseline: { insight: 0, redrawTimes: 0, redrawRemaining: 1 },
  });

  const queue = new EnrichmentQueue(dir);
  queue.enqueue({
    entityKind: "card",
    key: "cfg:card:1",
    version: { configFingerprint: "cfg", contentHash: "c1" },
    generation: "g1",
    evidenceSnapshot: {},
  });
  queue.claimNext();

  const tips = new TipStore(dir);
  tips.create({
    decisionKey: "keep",
    title: "keep",
    body: "cross-run tip",
    sourceInstanceId: "old",
  });
  const hyps = new HypothesisStore(dir);
  hyps.create({
    claim: "keep hyp",
    rationale: "cross-run",
    constraints: "none",
    sourceInstanceId: "old",
    sessionIndex: 1,
  });
  const experiences = new ExperienceStore(dir);
  experiences.createOrAccumulate({
    version: { gameFingerprint: "g1", configFingerprint: "cfg" },
    actionSignature: "execute",
    contextSignature: "day:6",
    runId: "old-run",
    positive: true,
  });

  return {
    tipCount: tips.list().length,
    experienceCount: experiences.list().length,
    cardCount: stores.cards.list().length,
  };
}

function testResetClearsRunStateKeepsKnowledge(): void {
  const dir = tempDir();
  const before = seedPollutedSession(dir);

  const reset = resetRunScopedState({
    sessionDir: dir,
    runId: "new-run",
    gameIndex: 2,
  });
  assert.equal(reset.ok, true);
  assert.ok(reset.abandonedEpisodes >= 1);
  assert.equal(reset.checkpointReset, true);
  assert.equal(reset.metaReset, true);

  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as {
    lastReviewedDay: number | null;
    activeHypothesisId: string | null;
  };
  assert.equal(meta.lastReviewedDay, null);
  assert.equal(meta.activeHypothesisId, null);

  const checkpoint = JSON.parse(
    fs.readFileSync(path.join(dir, "action-chain-checkpoint.json"), "utf8"),
  ) as {
    day: number | null;
    allocations: unknown[];
    seenCardIds: unknown[];
    sudanRouteProbePending: number;
    phase: string;
  };
  assert.equal(checkpoint.day, null);
  assert.equal(checkpoint.allocations.length, 0);
  assert.equal(checkpoint.seenCardIds.length, 0);
  assert.equal(checkpoint.sudanRouteProbePending, 0);
  assert.equal(checkpoint.phase, "entry_setup");

  const episodes = new EpisodeStore(dir);
  assert.equal(episodes.listOpen().length, 0);
  assert.ok(episodes.list().some((e) => e.phase === "abandoned"));

  const routes = new SudanRouteStore(dir);
  assert.equal(routes.pendingProbes().length, 0);

  const branches = new SudanBranchStore(dir);
  assert.equal(branches.active(), null);

  const stores = createSultanEntityStores(dir);
  assert.equal(stores.cards.list().length, before.cardCount);

  const tips = new TipStore(dir);
  const experiences = new ExperienceStore(dir);
  assert.equal(tips.list().length, before.tipCount);
  assert.equal(experiences.list().length, before.experienceCount);

  updateMemorySessionMeta(dir, { lastReviewedDay: null, activeHypothesisId: null });
  const meta2 = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as {
    lastReviewedDay: number | null;
  };
  assert.equal(meta2.lastReviewedDay, null);
}

testResetClearsRunStateKeepsKnowledge();
console.log("verify-new-game-reset: ok");
