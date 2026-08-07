import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GameState, SceneSnapshot } from "../src/game/types.js";
import {
  formatTier,
  isCurrencyCard,
  isStrategicTierCard,
  parseTierFromText,
  tierMatchScore,
  tierName,
} from "../src/game/cardTier.js";
import { buildEntityMemoryInjection } from "../src/memory/entityInjection.js";
import { touchEntitiesFromState } from "../src/memory/entityAdapter.js";
import {
  cardKnowledgeKey,
  createSultanEntityStores,
  riteEventKey,
} from "../src/memory/entityMemory.js";
import { buildStrategySnapshot } from "../src/memory/experienceAdapter.js";
import { generateEventConfigurations } from "../src/planner/candidateGenerator.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-card-tier-"));
}

function testTierModel(): void {
  assert.equal(tierName(1), "石");
  assert.equal(formatTier(3), "银(3)");
  assert.equal(parseTierFromText("需要白银品级人物"), 3);
  assert.equal(parseTierFromText('{"requiredRare":4,"type":"char"}'), 4);
  assert.equal(parseTierFromText("置入1金币"), null);
  assert.equal(parseTierFromText('{"type":"sudan","f:rare-s1.rare<=":0}'), 1);
  assert.equal(parseTierFromText("f:rare-s1.rare<=:1"), 2);
  assert.equal(parseTierFromText("不高于岩石品级的苏丹卡"), 1);
  assert.equal(isCurrencyCard({ name: "金币", type: "item", rare: 4 }), true);
  assert.equal(isStrategicTierCard({ name: "金币", type: "item", rare: 4 }), false);
  assert.equal(isStrategicTierCard({ name: "苏丹", type: "char", rare: 4 }), true);
  assert.ok(
    tierMatchScore({
      card: { name: "铁头", type: "char", rare: 2 },
      requiredRare: 2,
    }) >
      tierMatchScore({
        card: { name: "阿尔图", type: "char", rare: 3 },
        requiredRare: 2,
      }),
  );
}

function builtinRiteState(withSlots = true): GameState {
  const slots = withSlots
    ? [
        {
          index: 0,
          slotKey: "s1",
          text: "宫廷中的苏丹",
          conditionType: "char",
          occupied: true,
          isEnemy: true,
          cardUid: 99,
          cardId: 9001,
          cardName: "苏丹",
          cardSummary: {
            id: 9001,
            name: "苏丹",
            type: "char",
            rare: 4,
            tags: {
              权势: 7,
              贵族: 1,
            },
          },
          acceptsOp: "cancel_card_placement",
        },
        {
          index: 1,
          slotKey: "s2",
          text: "需要青铜品级人物",
          conditionType: "char",
          condition: '{"type":"char","tier":2}',
          occupied: false,
          acceptsOp: "place_card_on_rite",
        },
      ]
    : [];
  return {
    schemaVersion: 1,
    game: "sultan",
    screen: { id: "play", phase: "rite" },
    values: {
      day: 2,
      fingerprint: "cfg-tier",
      cards: [
        { uid: 10, id: 2001, name: "铁头", type: "char", rare: 2, inHand: true, bag: 0 },
      ],
      rites: [
        {
          uid: 20,
          id: 5001001,
          name: "权力的游戏",
          life: 2,
          slots: [],
        },
      ],
      currentRite: {
        uid: 20,
        id: 5001001,
        name: "权力的游戏",
        slots,
      },
    },
  };
}

function testFilledRiteCardTagsAvailableWithoutInspect(): void {
  const state = builtinRiteState();
  const tags = state.values?.currentRite?.slots?.[0]?.cardSummary?.tags;
  assert.equal(tags?.权势, 7);
  assert.equal(tags?.贵族, 1);
}

function testBuiltinCardProjectionAndInjection(): void {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const version = {
    gameFingerprint: "cfg-tier",
    configFingerprint: "cfg-tier",
  };

  touchEntitiesFromState({ stores, state: builtinRiteState() });
  const event = stores.events.get(riteEventKey("cfg-tier", 5001001), version)!;
  const slots = event.facts.slots as Array<Record<string, unknown>>;
  assert.equal(slots.length, 2);
  assert.equal((slots[0]!.occupant as Record<string, unknown>).name, "苏丹");
  assert.equal((slots[0]!.occupant as Record<string, unknown>).tier, "金(4)");
  assert.equal((slots[0]!.occupant as Record<string, unknown>).kind, "builtin");
  assert.deepEqual((slots[0]!.occupant as Record<string, unknown>).tags, {
    权势: 7,
    贵族: 1,
  });
  assert.equal(slots[1]!.requiredRare, 2);

  const sultan = stores.cards.get(cardKnowledgeKey("cfg-tier", 9001), version)!;
  assert.equal(sultan.facts.rare, 4);
  assert.deepEqual(sultan.facts.tags, {
    权势: 7,
    贵族: 1,
  });

  const injection = buildEntityMemoryInjection(
    {
      cards: [sultan],
      events: [event],
      interactions: [],
      unknownCardIds: [],
      currentCardIds: [2001],
      currentEventKeys: [event.key],
    },
    8_000,
  );
  assert.match(injection, /苏丹｜金\(4\)｜builtin/);
  assert.match(injection, /高阶卡优先高阶任务/);

  // A later compact/map-only observation must not erase richer slot facts.
  touchEntitiesFromState({ stores, state: builtinRiteState(false) });
  const preserved = stores.events.get(riteEventKey("cfg-tier", 5001001), version)!;
  assert.equal((preserved.facts.slots as unknown[]).length, 2);
}

function testPlannerPrefersLowTierErrandCard(): void {
  const state = builtinRiteState();
  state.values!.cards = [
    { uid: 10, id: 2001, name: "低阶跑腿者", type: "char", rare: 1, inHand: true, bag: 0 },
    { uid: 11, id: 2002, name: "高阶贵族", type: "char", rare: 4, inHand: true, bag: 0 },
  ];
  const currentRite = state.values!.currentRite as Record<string, unknown>;
  currentRite.slots = [
    {
      index: 1,
      slotKey: "s2",
      text: "日常跑腿",
      conditionType: "char",
      occupied: false,
      acceptsOp: "place_card_on_rite",
    },
  ];
  const scene: SceneSnapshot = {
    snapshotVersion: 3,
    scene: { id: "play", phase: "rite", blocking: false },
    affordances: [
      {
        action: "place",
        targetId: "low",
        enabled: true,
        mapsToOp: "place_card_on_rite",
        parameters: { uid: 10, slotIndex: 1 },
      },
      {
        action: "place",
        targetId: "high",
        enabled: true,
        mapsToOp: "place_card_on_rite",
        parameters: { uid: 11, slotIndex: 1 },
      },
    ],
  };
  const snapshot = buildStrategySnapshot({ state, scene });
  const configs = generateEventConfigurations({ snapshot, state, scene });
  const low = configs.find((config) => config.assignments[0]?.uid === 10)!;
  const high = configs.find((config) => config.assignments[0]?.uid === 11)!;
  assert.ok(low.baseScore > high.baseScore);
}

function main(): void {
  testTierModel();
  testFilledRiteCardTagsAvailableWithoutInspect();
  testBuiltinCardProjectionAndInjection();
  testPlannerPrefersLowTierErrandCard();
  console.log("verify-card-tier: ok");
}

main();
