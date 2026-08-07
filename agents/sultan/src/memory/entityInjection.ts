import type { EntityKnowledgeRecord } from "@vibesultan/agent-learning-core";
import { formatTier } from "../game/cardTier.js";
import type { SlotFeature } from "../game/strategyTypes.js";
import type { RelevantEntityKnowledge } from "./entityRetriever.js";
import type { SultanEntityStores } from "./entityMemory.js";

export function buildEntityMemoryInjection(
  relevant: RelevantEntityKnowledge,
  budgetChars: number,
): string {
  const lines = [
    "## 当前卡牌与事件记忆（按实时手牌/地图检索）",
    "validated=可执行基线（fallback），不是唯一最优；允许按探索规则偏离。provisional/observed 只作待验证线索，禁止当成确定攻略。",
    "探索：处刑剩余≥3、手牌升级、证据偏弱、活跃假设或本局新见该点时可试更优组合；≤1锁死基线，=2时普通仪式回基线；每rite每局最多2次新组合；失败当日回基线；基线中的 empty=可选槽；禁止整堆金/再试真实 contradicted（宿主预检错误不算）。",
    "品阶原则：高阶卡优先高阶任务/苏丹出口；低阶人物优先跑腿日常；向下兼容合法但会浪费高阶卡。",
    "金币/金骰等通货按最小数量成本使用，不按“金卡珍藏”；先读事件内置卡与槽位品阶再分配。",
  ];

  if (
    relevant.cards.length === 0 &&
    relevant.events.length === 0 &&
    relevant.interactions.length === 0
  ) {
    lines.push("- 暂无相关实体记忆；未知卡牌应先 inspect_card 查摘要，书籍/苏丹卡等再用 think_card 探索。");
  }

  for (const card of relevant.cards) {
    const facts = card.facts;
    const title = String(facts.name ?? `cardId=${facts.cardId ?? "?"}`);
    const tier = formatTier(facts.rare);
    const type = typeof facts.type === "string" ? facts.type : null;
    const identity = [title, tier, type].filter(Boolean).join("｜");
    lines.push(
      `- 卡牌【${identity}】 [${card.status}, confidence=${card.confidence.toFixed(2)}, samples=${card.sampleCount}]`,
    );
    const details = [
      textFact(facts.description),
      tagsFact(facts.tags),
      listFact("用途", facts.usages),
      listFact("避免", facts.antiPatterns),
      listFact("未知", facts.unknowns),
    ].filter(Boolean);
    for (const detail of details) lines.push(`  ${detail}`);
  }

  for (const event of relevant.events) {
    const facts = event.facts;
    const title = String(facts.name ?? facts.prompt ?? facts.eventKey ?? event.key);
    lines.push(
      `- 事件【${title}】 [${event.status}, confidence=${event.confidence.toFixed(2)}, samples=${event.sampleCount}]`,
    );
    const details = [
      eventTierFact(facts.slots),
      eventOccupantsFact(facts.slots),
      listFact("成功路线", facts.successfulRoutes),
      listFact("失败方式", facts.failureModes),
      listFact("未知", facts.unknowns),
    ].filter(Boolean);
    for (const detail of details) lines.push(`  ${detail}`);
  }

  for (const interaction of relevant.interactions) {
    const facts = interaction.facts;
    const target =
      facts.optionIndex != null
        ? `option=${facts.optionIndex}`
        : `slot=${facts.slotKey ?? facts.slotIndex ?? "?"}`;
    lines.push(
      `- 组合 cardId=${facts.cardId ?? "?"} → event=${shortEventKey(
        String(facts.eventKey ?? "?"),
      )} ${target} [${interaction.status}, confidence=${interaction.confidence.toFixed(
        2,
      )}, +${interaction.positiveCount}/-${interaction.negativeCount}]`,
    );
    const practices = listFact("最佳实践", facts.bestPractices);
    const failures = listFact("失败方式", facts.failureModes);
    if (practices) lines.push(`  ${practices}`);
    if (failures) lines.push(`  ${failures}`);
    const latest = interaction.evidence.at(-1);
    if (latest) lines.push(`  最近证据：${latest.summary}`);
  }

  if (relevant.unknownCardIds.length > 0) {
    lines.push(
      `- 未知卡牌 cardId=${relevant.unknownCardIds.join(",")}：hand_review 先 inspect_card；书/苏丹卡可再 think_card。`,
    );
  }

  return truncate(lines.join("\n"), budgetChars);
}

export function buildValidatedEntityPlaybook(
  stores: SultanEntityStores,
  budgetChars: number,
): string | null {
  const cards = stores.cards
    .list()
    .filter((record) => record.status === "validated")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
  const events = stores.events
    .list()
    .filter((record) => record.status === "validated")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  const interactions = stores.interactions
    .list()
    .filter((record) => record.status === "validated")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
  if (cards.length + events.length + interactions.length === 0) return null;
  const lines = ["## 已验证实体知识摘要（具体决策仍以实时检索为准）"];
  for (const card of cards) lines.push(`- 卡牌：${entityTitle(card)}`);
  for (const event of events) lines.push(`- 事件：${entityTitle(event)}`);
  for (const interaction of interactions) {
    lines.push(
      `- 组合：cardId=${interaction.facts.cardId ?? "?"} → ${shortEventKey(
        String(interaction.facts.eventKey ?? "?"),
      )}，confidence=${interaction.confidence.toFixed(2)}`,
    );
  }
  return truncate(lines.join("\n"), budgetChars);
}

function entityTitle(record: EntityKnowledgeRecord): string {
  const tier = formatTier(record.facts.rare);
  return `${record.facts.name ?? record.facts.prompt ?? record.key}${tier ? `｜${tier}` : ""} (confidence=${record.confidence.toFixed(2)})`;
}

function eventTierFact(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const tiers = value
    .filter((slot): slot is SlotFeature => Boolean(slot) && typeof slot === "object")
    .map((slot) => slot.requiredTier ?? formatTier(slot.requiredRare))
    .filter((tier): tier is string => Boolean(tier));
  return tiers.length > 0 ? `槽位门槛：${[...new Set(tiers)].join("、")}` : null;
}

function eventOccupantsFact(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const occupants = value
    .filter((slot): slot is SlotFeature => Boolean(slot) && typeof slot === "object")
    .filter((slot) => slot.occupied && slot.occupant)
    .map((slot) => {
      const occupant = slot.occupant!;
      const label = occupant.name ?? `cardId=${occupant.cardId ?? "?"}`;
      const tier = occupant.tier ?? formatTier(occupant.rare);
      return `${slot.slotKey ?? `s${slot.index + 1}`}:${[
        label,
        tier,
        occupant.kind,
      ].filter(Boolean).join("｜")}`;
    });
  return occupants.length > 0
    ? `内置/占位卡：${occupants.slice(0, 6).join("；")}`
    : null;
}

function textFact(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? `说明：${value.trim()}` : null;
}

function tagsFact(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parts = Object.entries(value as Record<string, unknown>)
    .filter(([, raw]) => typeof raw === "number" && Number.isFinite(raw) && raw !== 0)
    .sort(([a], [b]) => a.localeCompare(b, "zh"))
    .map(([key, raw]) => `${key}:${raw as number}`);
  return parts.length > 0 ? `属性：${parts.join("、")}` : null;
}

function listFact(label: string, value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? `${label}：${items.slice(0, 3).join("；")}` : null;
}

function shortEventKey(key: string): string {
  const parts = key.split(":");
  return parts.slice(-2).join(":");
}

function truncate(value: string, budgetChars: number): string {
  return value.length > budgetChars ? `${value.slice(0, budgetChars)}\n…` : value;
}
