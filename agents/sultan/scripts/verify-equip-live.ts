/**
 * Live smoke: equip 白银手镯 onto 梅姬, unequip, re-equip.
 * Requires game + new plugin loaded. Does not restart the game.
 */
import assert from "node:assert/strict";
import { config } from "../src/config.js";

const base = config.gameBaseUrl.replace(/\/$/, "");

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.ok, true, `GET ${path} failed: ${res.status}`);
  return res.json();
}

async function postActions(actions: Array<Record<string, unknown>>): Promise<any> {
  const res = await fetch(`${base}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actions }),
  });
  assert.equal(res.ok, true, `POST /actions failed: ${res.status}`);
  return res.json();
}

function cardsFrom(state: any): any[] {
  const values = state?.values ?? {};
  if (Array.isArray(values.cards)) return values.cards;
  if (Array.isArray(state?.cards)) return state.cards;
  return [];
}

function findByName(cards: any[], name: string): any | null {
  return cards.find((c) => c?.name === name) ?? null;
}

async function main(): Promise<void> {
  const health = await getJson("/health");
  assert.equal(health.ok, true);
  console.log("health ok fingerprint=", health.fingerprint);

  const state = await getJson("/state?views=cards,actions,summary");
  const scene = await getJson("/scene");
  const cards = cardsFrom(state);
  const meiji = findByName(cards, "梅姬");
  assert.ok(meiji?.uid != null, "梅姬 not in visible cards");

  const equippedOnMeiji = Array.isArray(meiji.equipped) ? meiji.equipped : [];
  const braceletOnChar = equippedOnMeiji.find((e: any) => e?.name === "白银手镯") ?? null;
  const braceletInCards = findByName(cards, "白银手镯");
  const braceletUid = Number(braceletOnChar?.uid ?? braceletInCards?.uid);
  assert.ok(Number.isFinite(braceletUid), "白银手镯 not in cards or 梅姬.equipped");
  console.log(
    "meiji uid=",
    meiji.uid,
    "equipSlotTypes=",
    meiji.equipSlotTypes,
    "equipped=",
    meiji.equipped,
  );
  console.log("bracelet uid=", braceletUid, "alreadyEquipped=", Boolean(braceletOnChar));

  const actionIds = new Set((state.actions ?? []).map((a: any) => a.id));
  assert.ok(actionIds.has("equip_item"), "state.actions missing equip_item");
  assert.ok(actionIds.has("unequip_item"), "state.actions missing unequip_item");

  if (!braceletOnChar) {
    const equipAffordance = (scene.affordances ?? []).find(
      (a: any) =>
        a?.mapsToOp === "equip_item" &&
        Number(a?.parameters?.characterUid) === Number(meiji.uid) &&
        Number(a?.parameters?.itemUid) === braceletUid,
    );
    assert.ok(equipAffordance, "missing semantic equip affordance for 梅姬+白银手镯");

    const equipRes = await postActions([
      {
        op: "equip_item",
        characterUid: meiji.uid,
        itemUid: braceletUid,
      },
    ]);
    const equipResult = equipRes?.results?.[0] ?? equipRes?.[0] ?? equipRes;
    console.log("equip result=", JSON.stringify(equipResult));
    assert.equal(equipResult?.ok, true, `equip failed: ${equipResult?.error} ${equipResult?.detail}`);

    const afterEquip = await getJson("/state?views=cards");
    const meijiEquipped = findByName(cardsFrom(afterEquip), "梅姬");
    const equipped = Array.isArray(meijiEquipped?.equipped) ? meijiEquipped.equipped : [];
    assert.ok(
      equipped.some((e: any) => Number(e.uid) === braceletUid),
      "梅姬.equipped missing 白银手镯 after equip",
    );
    console.log("after equip equipped=", equipped);
  } else {
    console.log("skip initial equip; bracelet already on 梅姬");
  }

  const unequipRes = await postActions([
    {
      op: "unequip_item",
      characterUid: meiji.uid,
      itemUid: braceletUid,
    },
  ]);
  const unequipResult = unequipRes?.results?.[0] ?? unequipRes?.[0] ?? unequipRes;
  console.log("unequip result=", JSON.stringify(unequipResult));
  assert.equal(unequipResult?.ok, true, `unequip failed: ${unequipResult?.error} ${unequipResult?.detail}`);

  const afterUnequip = await getJson("/state?views=cards");
  const meijiClear = findByName(cardsFrom(afterUnequip), "梅姬");
  const equippedClear = Array.isArray(meijiClear?.equipped) ? meijiClear.equipped : [];
  assert.ok(
    !equippedClear.some((e: any) => Number(e.uid) === braceletUid),
    "梅姬.equipped still has 白银手镯 after unequip",
  );

  const reequipRes = await postActions([
    {
      op: "equip_item",
      characterUid: meiji.uid,
      itemUid: braceletUid,
    },
  ]);
  const reequipResult = reequipRes?.results?.[0] ?? reequipRes?.[0] ?? reequipRes;
  console.log("re-equip result=", JSON.stringify(reequipResult));
  assert.equal(reequipResult?.ok, true, `re-equip failed: ${reequipResult?.error} ${reequipResult?.detail}`);

  const finalState = await getJson("/state?views=cards");
  const meijiFinal = findByName(cardsFrom(finalState), "梅姬");
  const equippedFinal = Array.isArray(meijiFinal?.equipped) ? meijiFinal.equipped : [];
  assert.ok(
    equippedFinal.some((e: any) => Number(e.uid) === braceletUid),
    "梅姬.equipped missing 白银手镯 after re-equip",
  );

  console.log("Live equip/unequip/re-equip verification passed.");
}

await main();
