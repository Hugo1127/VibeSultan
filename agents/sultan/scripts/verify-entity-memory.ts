import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GameState, SceneSnapshot } from "../src/game/types.js";
import {
  applyRiteSettlement,
  inspectSummary,
  recordEntityKnowledge,
  reliableCardInspection,
  touchEntitiesFromState,
} from "../src/memory/entityAdapter.js";
import {
  backfillEntitySkeletons,
  cardKnowledgeKey,
  choiceEventKey,
  createSultanEntityStores,
  interactionKnowledgeKey,
  riteEventKey,
} from "../src/memory/entityMemory.js";
import { buildEntityMemoryInjection } from "../src/memory/entityInjection.js";
import {
  cardInspectionRequirement,
  retrieveRelevantEntityKnowledge,
} from "../src/memory/entityRetriever.js";
import { recordEpisodeActions } from "../src/memory/episodeAdapter.js";
import { EpisodeStore } from "../src/memory/episodeStore.js";
import { EpisodeTracker } from "../src/memory/episodeTracker.js";
import {
  createMemorySession,
  openMemorySession,
} from "../src/memory/session.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-entity-memory-"));
}

function sampleState(opts?: {
  occupied?: boolean;
  terminal?: boolean;
  riteResult?: Record<string, unknown>;
  config?: string;
  phase?: string;
}): GameState {
  const occupied = opts?.occupied === true;
  return {
    schemaVersion: 1,
    game: "sultan",
    terminal: opts?.terminal === true,
    screen: {
      id: "play",
      phase: opts?.phase ?? (opts?.riteResult ? "rite_result" : "rite"),
    },
    values: {
      day: 2,
      fingerprint: opts?.config ?? "cfg-a",
      cards: [
        {
          uid: 10,
          id: 2001,
          name: "Hero",
          type: "char",
          rare: 1,
          bag: 0,
          inHand: true,
        },
      ],
      rites: [
        {
          uid: 20,
          id: 5001,
          name: "Estate",
          life: 2,
          slotsFilled: occupied ? 1 : 0,
          isCurrent: true,
          slots: [
            {
              index: 0,
              slotKey: "worker",
              conditionType: "char",
              occupied,
              cardUid: occupied ? 10 : null,
            },
          ],
        },
      ],
      currentRite: {
        uid: 20,
        id: 5001,
        name: "Estate",
        slots: [
          {
            index: 0,
            slotKey: "worker",
            conditionType: "char",
            occupied,
            cardUid: occupied ? 10 : null,
          },
        ],
      },
      riteResult: opts?.riteResult,
      currentEvent: {
        kind: "choice",
        prompt: "Choose a reward",
        identitySeed: "choice-seed",
        identityQuality: "derived",
        options: [{ index: 0, label: "Gold" }],
      },
      events: [{ index: 0, label: "Gold" }],
      resources: { gold: 1 },
      counters: {},
    },
    actions: [{ id: "place_card_on_rite", enabled: true }],
  };
}

function testSessionBootstrapAndMigration(): void {
  const root = tempDir();
  const session = createMemorySession(root, "entity-session");
  for (const file of [
    "cards.json",
    "events.json",
    "interactions.json",
    "pending-episodes.json",
    "fingerprint-aliases.json",
  ]) {
    assert.ok(fs.existsSync(path.join(session.dir, file)), `${file} should exist`);
  }

  fs.rmSync(path.join(session.dir, "cards.json"));
  fs.rmSync(path.join(session.dir, "events.json"));
  fs.writeFileSync(
    path.join(session.dir, "experiences.json"),
    JSON.stringify({
      version: 1,
      experiences: [
        {
          id: "exp-legacy",
          status: "observed",
          version: { gameFingerprint: "g1", configFingerprint: "cfg-a" },
          actionSignature: "open_rite",
          contextSignature: "day=1",
          eventFeatures: [{ riteId: 5001, name: "Estate" }],
          cardFeatures: [{ cardId: 2001, name: "Hero" }],
          sampleCount: 0,
          positiveCount: 0,
          negativeCount: 0,
          confidence: 0,
          notes: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  openMemorySession(root, session.id);
  const stores = createSultanEntityStores(session.dir);
  assert.equal(stores.cards.list().length, 1);
  assert.equal(stores.events.list().length, 1);
  const second = backfillEntitySkeletons(session.dir);
  assert.deepEqual(second, { cards: 0, events: 0 });
}

function testIdentityAndUpsert(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const state = sampleState();
  touchEntitiesFromState({ stores, state, gameFingerprint: "g1", runId: "run-1" });
  touchEntitiesFromState({ stores, state, gameFingerprint: "g1", runId: "run-1" });
  assert.equal(stores.cards.list().length, 1);
  assert.equal(stores.events.list().filter((record) => record.facts.eventKind === "rite").length, 1);
  assert.equal(
    choiceEventKey("cfg-a", "Choose", ["A", "B"]),
    choiceEventKey("cfg-a", " choose ", ["a", "b"]),
  );
  assert.notEqual(
    choiceEventKey("cfg-a", "Choose", ["A", "B"]),
    choiceEventKey("cfg-a", "Choose", ["A", "C"]),
  );
}

function testPlaceExecuteDelayedSettle(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const tracker = new EpisodeTracker(new EpisodeStore(dir));
  const before = sampleState();
  touchEntitiesFromState({ stores, state: before, gameFingerprint: "g1", runId: "run-1" });

  const placed = sampleState({ occupied: true });
  recordEntityKnowledge({
    stores,
    stateBefore: before,
    stateAfter: placed,
    sceneAfter: {
      snapshotVersion: 1,
      instruction: {
        source: "card-detail",
        type: "inspect",
        text: "Hero can govern the estate",
      },
    } satisfies SceneSnapshot,
    actions: [{ op: "place_card_on_rite", uid: 10, slotIndex: 0 }],
    results: [{ op: "place_card_on_rite", ok: true }],
    experienceIds: ["exp-place"],
    gameFingerprint: "g1",
    runId: "run-1",
  });
  recordEpisodeActions({
    tracker,
    stateBefore: before,
    stateAfter: placed,
    actions: [{ op: "place_card_on_rite", uid: 10, slotIndex: 0 }],
    results: [{ op: "place_card_on_rite", ok: true }],
    experienceIds: ["exp-place"],
    gameFingerprint: "g1",
    fingerprints: stores.fingerprints,
    step: 1,
  });

  recordEpisodeActions({
    tracker,
    stateBefore: placed,
    stateAfter: sampleState({ occupied: true, phase: "play" }),
    actions: [{ op: "execute" }],
    results: [{ op: "execute", ok: true }],
    experienceIds: ["exp-execute"],
    gameFingerprint: "g1",
    fingerprints: stores.fingerprints,
    step: 2,
  });

  const delayed = sampleState({
    occupied: true,
    riteResult: { active: true, successCount: 3, successThreshold: 2, rewardSummary: "+1" },
  });
  const settlements = tracker.observeState(delayed, {
    step: 3,
    experienceId: "exp-continue",
  });
  assert.equal(settlements.length, 1);
  const updates = applyRiteSettlement({
    stores,
    settlement: settlements[0]!,
    runId: "run-1",
  });
  tracker.markApplied(settlements[0]!.episode.id);
  assert.ok(updates.some((update) => update.kind === "card"));
  assert.ok(updates.some((update) => update.kind === "event"));
  assert.ok(updates.some((update) => update.kind === "interaction"));

  const version = { gameFingerprint: "g1", configFingerprint: "cfg-a" };
  const eventKey = riteEventKey("cfg-a", 5001);
  const interactionKey = interactionKnowledgeKey({
    configFingerprint: "cfg-a",
    cardId: 2001,
    eventKey,
    slotIndex: 0,
    slotKey: "worker",
  });
  const interaction = stores.interactions.get(interactionKey, version);
  assert.ok(interaction);
  assert.equal(interaction!.positiveCount, 1);
  assert.equal(interaction!.evidence.filter((row) => row.sourceId === settlements[0]!.episode.id).length, 1);

  const card = stores.cards.get(cardKnowledgeKey("cfg-a", 2001), version)!;
  assert.equal(card.sampleCount, 1);
  assert.ok(Array.isArray(card.facts.usages) && (card.facts.usages as string[]).length > 0);

  // Duplicate settle evidence is ignored.
  applyRiteSettlement({ stores, settlement: settlements[0]!, runId: "run-1" });
  assert.equal(stores.cards.get(cardKnowledgeKey("cfg-a", 2001), version)!.sampleCount, 1);

  stores.cards.upsertFacts(cardKnowledgeKey("cfg-a", 2001), version, {
    usages: [...((card.facts.usages as string[]) ?? []), "Govern Estate worker slot"],
    unknowns: [],
  });
  for (let i = 0; i < 2; i++) {
    stores.interactions.addEvidence(interactionKey, version, {
      outcome: "positive",
      summary: `repeat success ${i}`,
    });
  }
  assert.equal(stores.interactions.get(interactionKey, version)?.status, "validated");

  const relevant = retrieveRelevantEntityKnowledge({
    stores,
    state: placed,
    gameFingerprint: "g1",
  });
  assert.equal(relevant.cards.length, 1);
  assert.equal(relevant.interactions.length, 1);
  const injection = buildEntityMemoryInjection(relevant, 5000);
  assert.match(injection, /Govern Estate/);
  assert.match(injection, /validated/);
  assert.ok(buildEntityMemoryInjection(relevant, 120).length <= 122);
}

function testChoiceAndInspectGuards(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const before = sampleState();
  touchEntitiesFromState({ stores, state: before, gameFingerprint: "g1", runId: "run-1" });
  const after = sampleState();
  (after.values as Record<string, unknown>).resources = { gold: 1 };

  recordEntityKnowledge({
    stores,
    stateBefore: before,
    stateAfter: after,
    actions: [{ op: "select_event_option", optionIndex: 0 }],
    results: [{ op: "select_event_option", ok: true, stateDelta: { changed: true } }],
    experienceIds: ["exp-choice"],
    gameFingerprint: "g1",
    runId: "run-1",
  });
  const choice = stores.events.list().find((record) => record.facts.eventKind === "choice");
  assert.ok(choice);
  assert.equal(choice!.sampleCount, 0);
  assert.equal(choice!.evidence.at(-1)?.outcome, "inconclusive");

  assert.equal(
    inspectSummary({
      snapshotVersion: 1,
      instruction: { text: "天数|金币|手牌|苏丹|继续|影响力" },
      elements: [{ elementId: "hud", text: "天数|金币|手牌|苏丹|继续|影响力" }],
    }),
    null,
  );
  assert.match(
    inspectSummary({
      snapshotVersion: 1,
      instruction: {
        source: "card-detail",
        type: "inspect",
        text: "Hero governs estates for gold",
      },
    }) ?? "",
    /Hero governs/,
  );

  // Currency cardSummary repeats 金币 in name/tags — must still count as reliable inspect.
  const goldReliable = reliableCardInspection({
    action: { op: "inspect_card", uid: 199 },
    result: {
      op: "inspect_card",
      ok: true,
      detail:
        "uid=199 id=2000029 cardSummary={name=金币; title=普通道具; type=item; rare=4; text=有人说金钱可以买到任何东西；tags=可堆叠:1,金币:1}",
    },
    stateBefore: {
      ...before,
      values: {
        ...before.values,
        cards: [{ uid: 199, id: 2000029, name: "金币", type: "item", rare: 4, inHand: true }],
      },
    },
  });
  assert.ok(goldReliable?.description, "gold cardSummary must not be treated as HUD dump");
  assert.equal(
    cardInspectionRequirement({
      stores,
      state: before,
      cardId: 2000029,
      gameFingerprint: "g1",
      cardHint: { name: "金币", type: "item", rare: 4 },
    }),
    null,
    "currency cards must not require inspect",
  );

  // Sudan card prose mentioning 苏丹卡 must verify (distinct HUD kinds, not repeats).
  const sudanReliable = reliableCardInspection({
    action: { op: "inspect_card", uid: 8 },
    result: {
      op: "inspect_card",
      ok: true,
      detail:
        "uid=8 id=2010005 cardSummary={name=纵欲; title=苏丹卡; type=sudan; rare=1; text=这是一张石品阶苏丹卡。; tags=苏丹卡:1,社交:1}",
    },
  });
  assert.ok(sudanReliable?.description, "sudan cardSummary must not be treated as HUD dump");

  assert.equal(
    cardInspectionRequirement({
      stores,
      state: before,
      cardId: 2001,
      gameFingerprint: "g1",
    }),
    "usage_unknown",
  );
  recordEntityKnowledge({
    stores,
    stateBefore: before,
    stateAfter: after,
    actions: [{ op: "inspect_card", uid: 10 }],
    results: [{
      op: "inspect_card",
      ok: true,
      detail:
        "uid=10 id=2001 cardSummary={name=阿尔图; title=被选中的人; type=char; rare=3; text=你自己; tags=智慧:2,体魄:3,贵族:1}",
    }],
    experienceIds: ["exp-inspect"],
    gameFingerprint: "g1",
    runId: "run-1",
  });
  assert.equal(
    cardInspectionRequirement({
      stores,
      state: after,
      cardId: 2001,
      gameFingerprint: "g1",
    }),
    null,
  );
  const inspected = stores.cards.get(cardKnowledgeKey("cfg-a", 2001), {
    gameFingerprint: "g1",
    configFingerprint: "cfg-a",
  });
  assert.deepEqual(inspected?.facts.tags, {
    智慧: 2,
    体魄: 3,
    贵族: 1,
  });
  assert.match(
    buildEntityMemoryInjection(
      retrieveRelevantEntityKnowledge({
        stores,
        state: after,
        gameFingerprint: "g1",
      }),
      5000,
    ),
    /属性：.*体魄:3/,
  );
}

function testContradictedCardsAreNotInjected(): void {
  const root = tempDir();
  const session = createMemorySession(root, "contradicted-filter");
  const stores = createSultanEntityStores(session.dir);
  const version = { gameFingerprint: "g1", configFingerprint: "cfg-a" };
  stores.cards.touch({
    key: cardKnowledgeKey("cfg-a", 2001),
    kind: "card",
    version,
    facts: { cardId: 2001, name: "BadHero" },
  });
  stores.cards.setStatus(cardKnowledgeKey("cfg-a", 2001), version, "contradicted");
  // Force negative confidence residual for defensive filter.
  const rawPath = path.join(session.dir, "cards.json");
  const file = JSON.parse(fs.readFileSync(rawPath, "utf8")) as {
    entities: Array<{ key: string; confidence: number; status: string }>;
  };
  const row = file.entities.find((e) => e.key.includes("2001"));
  assert.ok(row);
  row!.status = "contradicted";
  row!.confidence = -0.1;
  fs.writeFileSync(rawPath, JSON.stringify(file, null, 2), "utf8");
  const stores2 = createSultanEntityStores(session.dir);
  const state = sampleState();
  const relevant = retrieveRelevantEntityKnowledge({
    stores: stores2,
    state,
    gameFingerprint: "g1",
  });
  assert.equal(relevant.cards.length, 0);
  assert.deepEqual(relevant.unknownCardIds, []);
  assert.doesNotMatch(buildEntityMemoryInjection(relevant, 2000), /BadHero/);
}

function main(): void {
  testSessionBootstrapAndMigration();
  testIdentityAndUpsert();
  testPlaceExecuteDelayedSettle();
  testChoiceAndInspectGuards();
  testContradictedCardsAreNotInjected();
  console.log("verify-entity-memory: ok");
}

main();
