import type { KnowledgeOutcome } from "@vibesultan/agent-learning-core";
import { tierName } from "../game/cardTier.js";
import type { GameState } from "../game/types.js";
import { bodyFromSignature } from "./riteComposition.js";
import {
  cardKnowledgeKey,
  type SultanEntityStores,
} from "./entityMemory.js";
import { versionKeyFromState } from "./experienceAdapter.js";
import type { RiteExploreTrial } from "./riteExploreStore.js";

const MAX_BRIEF_TRIALS = 3;
const MAX_SLOT_TEXT = 20;

export type ParsedFilledSlot = {
  slotKey: string;
  slotIndex: number;
  cardId: number;
  count: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncateText(text: string, max = MAX_SLOT_TEXT): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Parse filled slots from a composition signature body. Never expose this DSL to the model. */
export function parseFilledSlotsFromSignature(signature: string): ParsedFilledSlot[] {
  const body = bodyFromSignature(signature);
  if (!body) return [];
  const out: ParsedFilledSlot[] = [];
  for (const part of body.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // s6:P:2010001 or s1:P:2000001@5 or s3:B:2010003
    const match = trimmed.match(/^(s\d+)\s*:\s*([PB])\s*:\s*(\d+)(?:@(\d+))?$/i);
    if (!match) continue;
    const slotKey = match[1]!.toLowerCase();
    const cardId = Number(match[3]);
    const count = match[4] != null ? Number(match[4]) : null;
    if (!Number.isFinite(cardId)) continue;
    const slotIndex = Number(slotKey.replace(/^s/i, ""));
    out.push({
      slotKey,
      slotIndex: Number.isFinite(slotIndex) ? slotIndex : out.length,
      cardId,
      count: count != null && Number.isFinite(count) && count > 1 ? count : null,
    });
  }
  return out.sort((a, b) => a.slotIndex - b.slotIndex);
}

function collectCardIndex(
  state: GameState | null | undefined,
): Map<number, { name: string | null; rare: number | null }> {
  const map = new Map<number, { name: string | null; rare: number | null }>();
  const values = isRecord(state?.values) ? state!.values! : {};
  const lists = [
    Array.isArray(values.cards) ? values.cards : [],
    Array.isArray(values.cardsAll) ? values.cardsAll : [],
    Array.isArray(state?.cards) ? state!.cards : [],
  ];
  for (const list of lists) {
    for (const raw of list as unknown[]) {
      if (!isRecord(raw)) continue;
      const cardId = asNumber(raw.id) ?? asNumber(raw.cardId);
      if (cardId == null) continue;
      const name = asString(raw.name) ?? asString(raw.customName);
      const rare = asNumber(raw.rare);
      const prev = map.get(cardId);
      if (!prev || (name && !prev.name)) {
        map.set(cardId, {
          name: name ?? prev?.name ?? null,
          rare: rare ?? prev?.rare ?? null,
        });
      }
    }
  }
  return map;
}

function collectSlotTextIndex(
  state: GameState | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  const rite = isRecord(state?.values?.currentRite) ? state!.values!.currentRite : null;
  const slots = Array.isArray(rite?.slots) ? rite!.slots : [];
  slots.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const slotIndex = asNumber(raw.index) ?? index;
    const slotKey = (asString(raw.slotKey) ?? `s${slotIndex}`).toLowerCase();
    const text = asString(raw.text);
    if (text) map.set(slotKey, truncateText(text));
  });
  return map;
}

function resolveCardLabel(opts: {
  cardId: number;
  count: number | null;
  state?: GameState | null;
  stores?: SultanEntityStores | null;
  gameFingerprint?: string | null;
  cardIndex?: Map<number, { name: string | null; rare: number | null }>;
}): string {
  const fromState = opts.cardIndex?.get(opts.cardId);
  let name = fromState?.name ?? null;
  let rare = fromState?.rare ?? null;

  if (opts.stores) {
    const version = versionKeyFromState(opts.state, opts.gameFingerprint);
    const key = cardKnowledgeKey(version.configFingerprint, opts.cardId);
    const record = opts.stores.cards.get(key, version);
    const facts = record?.facts;
    if (isRecord(facts)) {
      name = name ?? asString(facts.name);
      rare = rare ?? asNumber(facts.rare);
    }
  }

  const base = name ?? `卡#${opts.cardId}`;
  const tier = tierName(rare);
  const withTier = tier ? `${base}(${tier})` : base;
  if (opts.count != null && opts.count > 1) return `${withTier}×${opts.count}`;
  return withTier;
}

function slotLabel(
  slot: ParsedFilledSlot,
  slotTexts: Map<string, string>,
): string {
  const text = slotTexts.get(slot.slotKey.toLowerCase());
  if (text) return `槽${slot.slotIndex}「${text}」`;
  return `槽${slot.slotIndex}`;
}

/**
 * Build a human-readable composition summary from a signature (and optional live state).
 * Must never include the raw signature DSL.
 */
export function buildTrialSummaryZh(opts: {
  signature: string;
  state?: GameState | null;
  stores?: SultanEntityStores | null;
  gameFingerprint?: string | null;
  /** Prefer live currentRite occupied slots when signature matches current board. */
  preferLiveSlots?: boolean;
}): string {
  const slotTexts = collectSlotTextIndex(opts.state);
  const cardIndex = collectCardIndex(opts.state);

  if (opts.preferLiveSlots !== false) {
    const live = summarizeLiveOccupiedSlots({
      state: opts.state,
      stores: opts.stores,
      gameFingerprint: opts.gameFingerprint,
      cardIndex,
      slotTexts,
    });
    if (live) return live;
  }

  const filled = parseFilledSlotsFromSignature(opts.signature);
  if (filled.length === 0) return "（槽位组合未解析）";

  const parts = filled.map((slot) => {
    const card = resolveCardLabel({
      cardId: slot.cardId,
      count: slot.count,
      state: opts.state,
      stores: opts.stores,
      gameFingerprint: opts.gameFingerprint,
      cardIndex,
    });
    return `${slotLabel(slot, slotTexts)}←【${card}】`;
  });
  return parts.join("；");
}

function summarizeLiveOccupiedSlots(opts: {
  state?: GameState | null;
  stores?: SultanEntityStores | null;
  gameFingerprint?: string | null;
  cardIndex: Map<number, { name: string | null; rare: number | null }>;
  slotTexts: Map<string, string>;
}): string | null {
  const rite = isRecord(opts.state?.values?.currentRite)
    ? opts.state!.values!.currentRite
    : null;
  if (!rite) return null;
  const slots = Array.isArray(rite.slots) ? rite.slots : [];
  const cards = collectCardIndex(opts.state);
  const byUid = new Map<number, Record<string, unknown>>();
  const values = isRecord(opts.state?.values) ? opts.state!.values! : {};
  for (const list of [
    Array.isArray(values.cards) ? values.cards : [],
    Array.isArray(values.cardsAll) ? values.cardsAll : [],
    Array.isArray(opts.state?.cards) ? opts.state!.cards : [],
  ]) {
    for (const raw of list as unknown[]) {
      if (!isRecord(raw)) continue;
      const uid = asNumber(raw.uid);
      if (uid != null) byUid.set(uid, raw);
    }
  }

  const parts: string[] = [];
  slots.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const slotIndex = asNumber(raw.index) ?? index;
    const slotKey = (asString(raw.slotKey) ?? `s${slotIndex}`).toLowerCase();
    const cardUid = asNumber(raw.cardUid);
    if (cardUid == null) return;
    const card = byUid.get(cardUid);
    const cardId =
      asNumber(card?.id) ?? asNumber(raw.cardId) ?? asNumber(
        isRecord(raw.cardSummary) ? raw.cardSummary.id : null,
      );
    if (cardId == null) return;
    const count = asNumber(card?.count);
    const label = resolveCardLabel({
      cardId,
      count: count != null && count > 1 ? count : null,
      state: opts.state,
      stores: opts.stores,
      gameFingerprint: opts.gameFingerprint,
      cardIndex: cards,
    });
    const text = opts.slotTexts.get(slotKey);
    const slotPart = text ? `槽${slotIndex}「${text}」` : `槽${slotIndex}`;
    parts.push(`${slotPart}←【${label}】`);
  });
  return parts.length > 0 ? parts.join("；") : null;
}

function outcomeIsNegative(outcome?: KnowledgeOutcome | null): boolean {
  return outcome === "negative";
}

function formatTrialLine(trial: RiteExploreTrial, summaryZh: string): string {
  if (trial.status === "submitted") {
    return `本局已提交过：${summaryZh}；仪式可能已在跑/待结算，不要原样再 execute。`;
  }
  if (trial.status === "settled" && outcomeIsNegative(trial.outcome)) {
    return `本局试过：${summaryZh}；结果不佳，勿原组合重试。`;
  }
  if (trial.status === "void") {
    return `本局曾尝试：${summaryZh}；该次作废，勿无变化重提。`;
  }
  return `本局已完成过该组合：${summaryZh}；勿无变化重提。`;
}

export const HOST_DUPLICATE_HINT =
  "这是宿主防重复，不是游戏判定该槽非法；销卡槽仍可能合法。";

/**
 * Multi-line Chinese brief for a rite's explore trials this run.
 * Never includes composition signature DSL.
 */
export function buildRiteExploreBrief(opts: {
  trials: RiteExploreTrial[];
  riteName?: string | null;
  state?: GameState | null;
  stores?: SultanEntityStores | null;
  gameFingerprint?: string | null;
  /** Append host-duplicate clarification (for gate rejection detail). */
  includeHostDuplicateHint?: boolean;
}): string | null {
  if (!opts.trials.length) return null;

  const sorted = [...opts.trials].sort((a, b) => {
    const sa = a.step ?? 0;
    const sb = b.step ?? 0;
    if (sa !== sb) return sa - sb;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const picked = sorted.slice(-MAX_BRIEF_TRIALS);
  const riteLabel = opts.riteName?.trim() ? `【${opts.riteName.trim()}】` : "该仪式";

  const lines = [
    `本局${riteLabel}探索履历（共${opts.trials.length}次，显示最近${picked.length}次）：`,
  ];
  for (const trial of picked) {
    const summary =
      (trial.summaryZh && trial.summaryZh.trim()) ||
      buildTrialSummaryZh({
        signature: trial.signature,
        state: opts.state,
        stores: opts.stores,
        gameFingerprint: opts.gameFingerprint,
        preferLiveSlots: false,
      });
    lines.push(`- ${formatTrialLine(trial, summary)}`);
  }
  if (opts.includeHostDuplicateHint) {
    lines.push(HOST_DUPLICATE_HINT);
  }
  return lines.join("\n");
}
