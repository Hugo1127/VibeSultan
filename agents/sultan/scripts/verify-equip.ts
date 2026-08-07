import assert from "node:assert/strict";
import { preflightAction } from "../src/agent/tools.js";
import {
  ActionChainController,
  formatActionChainBrief,
} from "../src/agent/actionChain.js";
import type { GameState, SceneSnapshot } from "../src/game/types.js";

function testPreflightEquip(): void {
  assert.equal(preflightAction({ op: "equip_item" }), "missing_characterUid");
  assert.equal(
    preflightAction({ op: "equip_item", characterUid: 10 }),
    "missing_itemUid",
  );
  assert.equal(
    preflightAction({ op: "equip_item", characterUid: 10, itemUid: 86 }),
    null,
  );
  assert.equal(preflightAction({ op: "unequip_item" }), "missing_itemUid");
  assert.equal(preflightAction({ op: "unequip_item", itemUid: 86 }), null);

  const state: GameState = {
    values: {
      cards: [
        { uid: 10, id: 2000006, type: "char", name: "梅姬", equipSlotTypes: ["武器", "服装", "饰品"], equipped: [] },
        { uid: 86, id: 2000263, type: "item", name: "白银手镯" },
      ],
    },
    actions: [
      { id: "equip_item", enabled: true },
      { id: "unequip_item", enabled: true },
    ],
  };
  assert.equal(
    preflightAction({ op: "equip_item", characterUid: 10, itemUid: 86 }, state),
    null,
  );
  assert.equal(
    preflightAction({ op: "equip_item", characterUid: 99, itemUid: 86 }, state),
    "character_not_found",
  );
  assert.equal(
    preflightAction({ op: "equip_item", characterUid: 10, itemUid: 99 }, state),
    "item_not_found",
  );
}

function testActionChainAllowsEquip(): void {
  const scene: SceneSnapshot = {
    snapshotVersion: 1,
    scene: { id: "play", phase: "play", blocking: false },
    affordances: [
      {
        action: "equip",
        targetId: "semantic:equip_10_86",
        enabled: true,
        mapsToOp: "equip_item",
        parameters: { characterUid: 10, itemUid: 86, slotType: "饰品" },
      },
      {
        action: "unequip",
        targetId: "semantic:unequip_10_86",
        enabled: true,
        mapsToOp: "unequip_item",
        parameters: { characterUid: 10, itemUid: 86, slotType: "饰品" },
      },
    ],
  };
  const state: GameState = {
    schemaVersion: 1,
    game: "sultan",
    terminal: false,
    screen: { id: "play", phase: "play" },
    values: {
      day: 1,
      turn: 1,
      initDone: true,
      inGame: true,
      cards: [
        {
          uid: 10,
          id: 2000006,
          type: "char",
          name: "梅姬",
          equipSlotTypes: ["武器", "服装", "饰品"],
          equipped: [],
          inHand: true,
          bag: 0,
        },
        { uid: 86, id: 2000263, type: "item", name: "白银手镯", inHand: true, bag: 0 },
      ],
      rites: [],
      blockingOverlay: false,
    },
    actions: [
      { id: "equip_item", enabled: true },
      { id: "unequip_item", enabled: true },
      { id: "inspect_card", enabled: true },
      { id: "next_day", enabled: true },
    ],
  };

  const chain = new ActionChainController();
  chain.noteAction({ op: "draw_sudan_card" }, state, scene);
  const brief = chain.applyReport(
    { newsChecked: true, newsPresent: false },
    state,
    scene,
  ).brief;
  assert.equal(brief.phase, "hand_review");
  assert.ok(
    brief.allowedOps.includes("equip_item") || brief.allowedOps.includes("unequip_item"),
    `expected equip ops in ${brief.allowedOps.join(",")}`,
  );
  const text = formatActionChainBrief(brief);
  assert.match(text, /equip_item|unequip_item/);
}

function testMockEquipUnequipLoop(): void {
  const character = {
    uid: 10,
    id: 2000006,
    type: "char",
    name: "梅姬",
    equipSlotTypes: ["武器", "服装", "饰品"],
    equipped: [] as Array<Record<string, unknown>>,
    equipBonus: {} as Record<string, number>,
  };
  const item = {
    uid: 86,
    id: 2000263,
    type: "item",
    name: "白银手镯",
    title: "饰品",
    text: "粗制的白银手镯，勉强为你增色几分。",
    slotType: "饰品",
    tags: { 装备: 1, 饰品: 1, 魅力: 1 },
    attrBonus: { 魅力: 1 },
  };

  // Equip
  assert.equal(character.equipped.length, 0);
  character.equipped.push({
    uid: item.uid,
    id: item.id,
    name: item.name,
    type: item.type,
    title: item.title,
    text: item.text,
    slotType: "饰品",
    tags: item.tags,
    attrBonus: item.attrBonus,
  });
  character.equipBonus = { 魅力: 1 };
  assert.equal(character.equipped.length, 1);
  assert.equal(character.equipped[0]?.uid, 86);
  assert.equal((character.equipped[0]?.attrBonus as Record<string, number>)?.魅力, 1);
  assert.equal(character.equipBonus.魅力, 1);

  // Same-slot occupied policy: must unequip first
  const sameSlotOccupied = character.equipped.some((e) => e.slotType === "饰品");
  assert.equal(sameSlotOccupied, true);

  // Unequip
  character.equipped = character.equipped.filter((e) => e.uid !== 86);
  character.equipBonus = {};
  assert.equal(character.equipped.length, 0);

  // Re-equip
  character.equipped.push({
    uid: item.uid,
    id: item.id,
    name: item.name,
    type: item.type,
    title: item.title,
    text: item.text,
    slotType: "饰品",
    tags: item.tags,
    attrBonus: item.attrBonus,
  });
  character.equipBonus = { 魅力: 1 };
  assert.equal(character.equipped[0]?.name, "白银手镯");
  assert.match(String(character.equipped[0]?.text ?? ""), /增色/);
}

testPreflightEquip();
testActionChainAllowsEquip();
testMockEquipUnequipLoop();
console.log("Equip/unequip verification passed.");
