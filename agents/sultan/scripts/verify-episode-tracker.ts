import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GameState } from "../src/game/types.js";
import { applyRiteSettlement } from "../src/memory/entityAdapter.js";
import {
  cardKnowledgeKey,
  createSultanEntityStores,
  interactionKnowledgeKey,
  riteEventKey,
} from "../src/memory/entityMemory.js";
import { recordEpisodeActions } from "../src/memory/episodeAdapter.js";
import { EpisodeStore } from "../src/memory/episodeStore.js";
import { EpisodeTracker } from "../src/memory/episodeTracker.js";
import { FingerprintAliasStore } from "../src/memory/fingerprintAlias.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-episode-"));
}

function state(opts?: {
  occupied?: boolean;
  phase?: string;
  riteResult?: Record<string, unknown> | null;
  fingerprint?: string;
  emptyCurrentRite?: boolean;
}): GameState {
  const occupied = opts?.occupied !== false;
  return {
    schemaVersion: 1,
    game: "sultan",
    screen: { id: "play", phase: opts?.phase ?? "rite" },
    values: {
      day: 3,
      fingerprint: opts?.fingerprint ?? "cfg-full",
      cards: [{ uid: 10, id: 2001, name: "Hero", type: "char", inHand: true }],
      rites: [
        {
          uid: 20,
          id: 5001,
          name: "Estate",
          isCurrent: true,
          slots: [
            {
              index: 0,
              slotKey: "worker",
              occupied,
              cardUid: occupied ? 10 : null,
            },
          ],
        },
      ],
      currentRite: opts?.emptyCurrentRite
        ? null
        : {
            uid: 20,
            id: 5001,
            name: "Estate",
            slots: [
              {
                index: 0,
                slotKey: "worker",
                occupied,
                cardUid: occupied ? 10 : null,
              },
            ],
          },
      riteResult: opts?.riteResult ?? null,
    },
  };
}

function testCompositionFallbackAndSettlement(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const tracker = new EpisodeTracker(new EpisodeStore(dir), 20);
  const version = { gameFingerprint: "g1", configFingerprint: "cfg-full" };
  const eventKey = riteEventKey("cfg-full", 5001);
  const interactionKey = interactionKnowledgeKey({
    configFingerprint: "cfg-full",
    cardId: 2001,
    eventKey,
    slotIndex: 0,
    slotKey: "worker",
  });

  stores.cards.touch({
    key: cardKnowledgeKey("cfg-full", 2001),
    kind: "card",
    version,
    facts: { cardId: 2001, name: "Hero", unknowns: ["usage_unknown"] },
  });
  stores.events.touch({
    key: eventKey,
    kind: "event",
    version,
    facts: { eventKey, eventKind: "rite", riteId: 5001, name: "Estate" },
  });
  stores.interactions.touch({
    key: interactionKey,
    kind: "interaction",
    version,
    facts: { interactionKey, cardId: 2001, eventKey, slotIndex: 0, slotKey: "worker" },
  });

  recordEpisodeActions({
    tracker,
    stateBefore: state({ occupied: false }),
    stateAfter: state({ occupied: true }),
    actions: [{ op: "place_card_on_rite", uid: 10, slotIndex: 0 }],
    results: [{ op: "place_card_on_rite", ok: true }],
    experienceIds: ["exp-place"],
    gameFingerprint: "g1",
    fingerprints: stores.fingerprints,
    step: 1,
  });

  // Execute with empty currentRite — composition must fall back to placement / rites[].
  recordEpisodeActions({
    tracker,
    stateBefore: state({ occupied: true, emptyCurrentRite: true }),
    stateAfter: state({ occupied: true, emptyCurrentRite: true, phase: "play" }),
    actions: [{ op: "execute" }],
    results: [{ op: "execute", ok: true }],
    experienceIds: ["exp-execute"],
    gameFingerprint: "g1",
    fingerprints: stores.fingerprints,
    step: 2,
  });

  const open = tracker.store.listOpen();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.phase, "submitted");
  assert.equal(open[0]!.composition.length, 1);
  assert.equal(open[0]!.composition[0]!.cardId, 2001);

  const first = tracker.observeState(
    state({
      occupied: true,
      phase: "rite_result",
      riteResult: { active: true, successCount: 3, successThreshold: 2, rewardSummary: "+1 gold" },
    }),
    { step: 3, experienceId: "exp-continue" },
  );
  assert.equal(first.length, 1);
  assert.equal(first[0]!.outcome, "positive");

  const updates = applyRiteSettlement({ stores, settlement: first[0]! });
  tracker.markApplied(first[0]!.episode.id);
  assert.ok(updates.some((update) => update.kind === "card"));
  assert.ok(updates.some((update) => update.kind === "event"));
  assert.ok(updates.some((update) => update.kind === "interaction"));

  const card = stores.cards.get(cardKnowledgeKey("cfg-full", 2001), version)!;
  assert.equal(card.sampleCount, 1);
  assert.ok(Array.isArray(card.facts.usages) && (card.facts.usages as string[]).length > 0);

  // Repeat observe must not double-count after applied.
  const again = tracker.observeState(
    state({
      occupied: true,
      phase: "rite_result",
      riteResult: { active: true, successCount: 3, successThreshold: 2 },
    }),
    { step: 4 },
  );
  assert.equal(again.length, 0);
  assert.equal(stores.cards.get(cardKnowledgeKey("cfg-full", 2001), version)!.sampleCount, 1);
}

function testAbandonAndCrashRecovery(): void {
  const dir = tempDir();
  const store = new EpisodeStore(dir);
  const tracker = new EpisodeTracker(store, 2);
  tracker.recordSubmit({
    version: { gameFingerprint: "g1", configFingerprint: "cfg" },
    eventKey: "cfg:rite:1",
    riteId: 1,
    composition: [],
    step: 1,
  });
  const abandoned = tracker.abandonExpired(10);
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0]!.phase, "abandoned");

  // Crash recovery: reopen store and load unapplied settlement.
  const tracker2 = new EpisodeTracker(new EpisodeStore(dir), 2);
  tracker2.recordSubmit({
    version: { gameFingerprint: "g1", configFingerprint: "cfg" },
    eventKey: "cfg:rite:2",
    riteId: 2,
    step: 1,
  });
  tracker2.store.update(tracker2.store.listOpen()[0]!.id, {
    outcome: "positive",
    settlement: { summary: "recovered", successCount: 1, successThreshold: 1 },
    phase: "awaiting_result",
  });
  assert.equal(tracker2.unappliedSettlements().length, 1);
}

function testFingerprintAlias(): void {
  const dir = tempDir();
  const aliases = new FingerprintAliasStore(dir);
  assert.equal(aliases.observe("4deecf6d"), "4deecf6d");
  assert.equal(aliases.observe("bc74fa40"), "bc74fa40");
  assert.equal(aliases.resolve("4deecf6d"), "bc74fa40");
  const keys = aliases.expandKeys(["4deecf6d:card:2001"]);
  assert.ok(keys.includes("bc74fa40:card:2001"));
  assert.ok(keys.includes("4deecf6d:card:2001"));
}

function testCrossDayCardAndCounterVerify(): void {
  const dir = tempDir();
  const tracker = new EpisodeTracker(new EpisodeStore(dir));
  const baselineState: GameState = {
    schemaVersion: 1,
    game: "sultan",
    screen: { id: "play", phase: "rite" },
    values: {
      day: 2,
      fingerprint: "cfg",
      cards: [{ uid: 1, id: 2001, name: "阿尔图", type: "char" }],
      counters: { 谗言: 0 },
      resources: { gold: 1 },
    },
  };
  tracker.recordSubmit({
    version: { gameFingerprint: "g1", configFingerprint: "cfg" },
    eventKey: "cfg:rite:5001001",
    riteId: 5001001,
    day: 2,
    composition: [
      {
        cardId: 0,
        slotIndex: 4,
        slotKey: "s5",
        empty: true,
        interactionKey: "cfg:interaction:0:x:slot:s5",
      },
    ],
    state: baselineState,
    step: 1,
  });

  // Story result without dice → defer to cross-day verify.
  const immediate = tracker.observeState(
    {
      ...baselineState,
      screen: { id: "play", phase: "rite_result" },
      values: {
        ...baselineState.values,
        riteResult: {
          active: true,
          stage: "result_page",
          title: "权力的游戏",
          body: "请经常出现在宫廷里。",
          rewardSummary: null,
          successCount: null,
          successThreshold: null,
        },
      },
    },
    { step: 2 },
  );
  assert.equal(immediate.length, 0);
  assert.equal(tracker.store.listOpen()[0]!.phase, "awaiting_day_verify");

  // Leave result page: still waiting.
  assert.equal(
    tracker.observeState(
      {
        ...baselineState,
        screen: { id: "play", phase: "play" },
        values: { ...baselineState.values, riteResult: { active: false } },
      },
      { step: 3 },
    ).length,
    0,
  );

  // Next day: gained 猜忌 card → negative hard evidence.
  const settled = tracker.observeDayAdvance(
    {
      schemaVersion: 1,
      game: "sultan",
      screen: { id: "play", phase: "play" },
      values: {
        day: 3,
        fingerprint: "cfg",
        cards: [
          { uid: 1, id: 2001, name: "阿尔图", type: "char" },
          { uid: 9, id: 2099, name: "猜忌", type: "item" },
        ],
        counters: { 谗言: 1 },
        resources: { gold: 1 },
      },
    },
    { step: 4, previousDay: 2 },
  );
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.outcome, "negative");
  assert.match(settled[0]!.summary, /input=s5:empty/);
  assert.match(settled[0]!.summary, /gained_penalty_card/);
}

function testCrossDayPlacedCardWritesUsages(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const tracker = new EpisodeTracker(new EpisodeStore(dir));
  const version = { gameFingerprint: "g1", configFingerprint: "cfg" };
  const eventKey = riteEventKey("cfg", 5001001);
  const cardKey = cardKnowledgeKey("cfg", 2001);
  const interactionKey = interactionKnowledgeKey({
    configFingerprint: "cfg",
    cardId: 2001,
    eventKey,
    slotIndex: 4,
    slotKey: "s5",
  });

  stores.events.touch({
    key: eventKey,
    kind: "event",
    version,
    facts: { riteId: 5001001, name: "权力的游戏" },
  });
  stores.cards.touch({
    key: cardKey,
    kind: "card",
    version,
    facts: { cardId: 2001, name: "阿尔图", unknowns: ["usage_unknown"] },
  });
  stores.interactions.touch({
    key: interactionKey,
    kind: "interaction",
    version,
    facts: { cardId: 2001, eventKey, slotIndex: 4, slotKey: "s5" },
  });

  const baselineState: GameState = {
    schemaVersion: 1,
    game: "sultan",
    screen: { id: "play", phase: "rite" },
    values: {
      day: 5,
      fingerprint: "cfg",
      cards: [{ uid: 1, id: 2001, name: "阿尔图", type: "char" }],
      counters: { 谗言: 0 },
    },
  };
  tracker.recordSubmit({
    version,
    eventKey,
    riteId: 5001001,
    day: 5,
    composition: [
      {
        cardId: 2001,
        cardUid: 1,
        slotIndex: 4,
        slotKey: "s5",
        empty: false,
        interactionKey,
      },
    ],
    state: baselineState,
    step: 1,
  });

  tracker.observeState(
    {
      ...baselineState,
      screen: { id: "play", phase: "rite_result" },
      values: {
        ...baselineState.values,
        riteResult: {
          active: true,
          title: "权力的游戏",
          body: "你的身影出现在宫廷。",
          successCount: null,
          successThreshold: null,
        },
      },
    },
    { step: 2 },
  );
  tracker.observeState(
    {
      ...baselineState,
      screen: { id: "play", phase: "play" },
      values: { ...baselineState.values, riteResult: { active: false } },
    },
    { step: 3 },
  );

  // Placed noble, next day no 猜忌 → positive for the card input.
  const settled = tracker.observeDayAdvance(
    {
      ...baselineState,
      values: {
        day: 6,
        fingerprint: "cfg",
        cards: [{ uid: 1, id: 2001, name: "阿尔图", type: "char" }],
        counters: { 谗言: 0 },
      },
    },
    { step: 4, previousDay: 5 },
  );
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.outcome, "positive");
  assert.match(settled[0]!.summary, /avoided_penalty_with_input/);

  const updates = applyRiteSettlement({ stores, settlement: settled[0]! });
  tracker.markApplied(settled[0]!.episode.id);
  assert.ok(updates.some((update) => update.kind === "card"));
  assert.ok(updates.some((update) => update.kind === "event"));

  const card = stores.cards.get(cardKey, version)!;
  assert.equal(card.sampleCount, 1);
  assert.equal(card.positiveCount, 1);
  assert.ok(Array.isArray(card.facts.usages) && (card.facts.usages as string[]).length > 0);
  assert.match(String((card.facts.usages as string[])[0]), /composition=s5:2001/);
  assert.deepEqual(card.facts.unknowns, []);
}

function testTitleMismatchDoesNotApplyToEntities(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const tracker = new EpisodeTracker(new EpisodeStore(dir), 20);
  const version = { gameFingerprint: "g1", configFingerprint: "cfg-full" };
  const eventKey = riteEventKey("cfg-full", 5001);
  const interactionKey = interactionKnowledgeKey({
    configFingerprint: "cfg-full",
    cardId: 2001,
    eventKey,
    slotKey: "worker",
  });
  tracker.recordPlacement({
    version,
    eventKey,
    riteId: 5001,
    riteUid: 20,
    day: 3,
    runId: "run-mismatch",
    step: 1,
    assignment: {
      cardId: 2001,
      cardUid: 10,
      slotIndex: 0,
      slotKey: "worker",
      interactionKey,
    },
  });
  recordEpisodeActions({
    tracker,
    stores,
    state: state({ occupied: true, phase: "rite" }),
    actions: [{ op: "execute" }],
    results: [{ ok: true }],
    runId: "run-mismatch",
    step: 2,
  });
  // Panel title belongs to a different rite — must quarantine, not apply.
  const settlements = tracker.observeState(
    state({
      phase: "rite_result",
      riteResult: {
        active: true,
        title: "<mspace=76>权力的游戏</mspace>",
        tip: "NewText",
        body: "unrelated panel",
      },
    }),
    { step: 3 },
  );
  assert.equal(settlements.length, 0);
  const open = new EpisodeStore(dir).list().find((e) => e.riteId === 5001);
  assert.equal(open?.quarantined, true);
  assert.equal(open?.settlement?.tip, null);
  const updates = applyRiteSettlement({
    stores,
    settlement: {
      episode: open!,
      outcome: "positive",
      summary: "should-not-apply",
      result: open!.settlement ?? {},
    },
  });
  assert.equal(updates.length, 0);
}

function main(): void {
  testCompositionFallbackAndSettlement();
  testAbandonAndCrashRecovery();
  testFingerprintAlias();
  testCrossDayCardAndCounterVerify();
  testCrossDayPlacedCardWritesUsages();
  testTitleMismatchDoesNotApplyToEntities();
  console.log("verify-episode-tracker: ok");
}

main();
