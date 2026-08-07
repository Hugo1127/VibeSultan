import type { ReplayDocument, ReplayStep } from "./types.js";

/**
 * Known rite lore used to ground replay narration when entity memory has no brief yet.
 * Keep these short, factual, and altruism-aware.
 */
const RITE_LORE: Record<string, string> = {
  "5002009":
    "事件「还书的少女」(riteId=5002009)：槽位可用苏丹卡硬通，但那会伤害少女（利他负向/害盟友）。完美拯救需要石级（rare=1）奢靡苏丹卡；因此换卡目标是刷出石奢靡，而不是随便换一张能销的牌。",
  还书的少女:
    "事件「还书的少女」：勿用任意苏丹卡伤害少女；目标是找到石级奢靡苏丹卡完美救援。",
};

export function extractFocusRites(steps: ReplayStep[]): Array<{
  uid?: number | string;
  riteId?: number | string;
  name?: string;
}> {
  const out: Array<{ uid?: number | string; riteId?: number | string; name?: string }> = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.action.op !== "open_rite") continue;
    const uid = step.action.uid as number | string | undefined;
    const riteId = step.action.riteId as number | string | undefined;
    const key = `${riteId ?? "?"}:${uid ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const nameFromNote =
      typeof step.note === "string" && /还书/.test(step.note) ? "还书的少女" : undefined;
    out.push({
      uid,
      riteId,
      name: riteId != null && RITE_LORE[String(riteId)] ? "还书的少女" : nameFromNote,
    });
  }
  return out;
}

function loreForRite(riteId?: number | string, name?: string): string | undefined {
  if (riteId != null && RITE_LORE[String(riteId)]) return RITE_LORE[String(riteId)];
  if (name && RITE_LORE[name]) return RITE_LORE[name];
  return undefined;
}

/**
 * Build the episode motive brief that every bubble must ground in.
 * User --motive always wins; otherwise compose from open_rite lore + exchange plan.
 */
export function buildMotiveBrief(
  doc: ReplayDocument,
  userMotive?: string,
): string {
  const manual = userMotive?.trim() || doc.motive?.trim();
  if (manual) return manual;

  const rites = extractFocusRites(doc.steps);
  const exchangeCount = doc.steps.filter((s) => s.action.op === "exchange_sudan_card").length;
  const hasPrevRound = doc.steps.some((s) => s.action.op === "prev_round");
  const hasBox = doc.steps.some((s) => s.action.op === "open_sudan_box");

  const parts: string[] = [];
  parts.push("本段录像是一次有目标的操作演示，不是随机点点。");

  for (const rite of rites) {
    const lore = loreForRite(rite.riteId, rite.name);
    if (lore) {
      parts.push(lore);
    } else {
      parts.push(
        `焦点事件 open_rite uid=${rite.uid ?? "?"} riteId=${rite.riteId ?? "?"}：后续操作都服务于该事件的正确解法。`,
      );
    }
  }

  if (hasBox || exchangeCount > 0) {
    const targetHint = rites.some((r) => loreForRite(r.riteId, r.name)?.includes("石级"))
      ? "目标牌=石级（rare=1）奢靡苏丹卡"
      : "目标牌=该事件完美解所需的苏丹卡品阶/类型";
    parts.push(
      `换卡流程：open_sudan_box 后 exchange_sudan_card ×${exchangeCount || "N"}，` +
        `目的是寻找${targetHint}，不是无脑重抽、也不是因为「征服不好用」。`,
    );
  }
  if (hasPrevRound) {
    parts.push(
      "若本回合未刷到目标牌，用 prev_round 回档再试，避免用错误苏丹卡伤害关键角色。",
    );
  }
  parts.push("利他约束：优先保护/拯救 NPC；拒绝「能过关但害人」的苏丹卡硬通。");

  return parts.join("\n");
}
