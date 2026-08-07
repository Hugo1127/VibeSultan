import fs from "node:fs";
import path from "node:path";
import type { GameAction, GameState, SceneSnapshot } from "../game/types.js";
import {
  formatTier,
  isCurrencyCard,
  isStrategicTierCard,
} from "../game/cardTier.js";
import type { CardInspectionReason } from "../memory/entityRetriever.js";
import {
  adviseExecutionTiming,
  type ExecutionTimingAdvice,
} from "../planner/executionTiming.js";
import { buildStrategySnapshot } from "../memory/experienceAdapter.js";

export type ActionChainPhase =
  | "entry_setup"
  | "sudan_draw"
  | "daily_news"
  | "hand_review"
  | "map_review"
  | "synthesis"
  | "allocation"
  | "local_improve"
  | "end_day_gate"
  | "recovery_rewind"
  | "blocked"
  | "terminal";

export type CardDisposition =
  | "assigned"
  | "reserved"
  | "no_positive_slot"
  | "unknown"
  | "inspected";

export interface Top3Item {
  title: string;
  why: string;
  priority?: number;
}

export interface CardAllocation {
  cardUid: number;
  riteUid: number;
  slotIndex: number;
  why?: string;
}

export interface IdleCardReason {
  cardUid: number;
  reason: "reserved" | "no_positive_slot";
  detail?: string;
}

export interface MapPointSignature {
  riteUid: number;
  riteId?: number | null;
  name?: string | null;
  life?: number | null;
  started?: boolean;
  slotsFilled?: number | null;
  canConfirm?: boolean;
  slotSig?: string;
  /** Config slot preview length; >0 enables soft map_review without open_rite. */
  slotPreviewCount?: number;
  handMatchCount?: number | null;
  /** True when preview has a sudan-like slot or rite name looks like a break outlet. */
  sudanOutletHint?: boolean;
}

export interface CardReviewItem {
  uid: number;
  cardId: number | null;
  name: string | null;
  tier: string | null;
  reason: CardInspectionReason | "new_card";
}

export interface ActionChainCheckpoint {
  schemaVersion: 1;
  day: number | null;
  phase: ActionChainPhase;
  entrySetupDone: boolean;
  sudanDrawn: boolean;
  newsChecked: boolean;
  newsPresent: boolean | null;
  newsSummary: string | null;
  top3: Top3Item[];
  reviewedCardUids: number[];
  inspectedCardUids: number[];
  cardBaselineInitialized: boolean;
  seenCardIds: number[];
  newCardUids: number[];
  requiredInspectionCardUids: number[];
  inspectionReasons: Record<string, CardInspectionReason>;
  reviewedRiteUids: number[];
  previousMap: MapPointSignature[];
  mapChanges: string[];
  allocations: CardAllocation[];
  idleCards: IdleCardReason[];
  localImproveDone: boolean;
  utilizationOk: boolean;
  /** True after a same-day Sudan-card break was reported or observed. */
  sudanBreakDone: boolean;
  /** Advisory: pending sudan route probes (new card / new event). */
  sudanRouteProbePending: number;
  /**
   * After exchange raised sudan rare without a verified break path.
   * Soft day-close hint; cleared on successful break or identity reset.
   */
  sudanExchangeTierRegression?: {
    rareBefore: number;
    rareAfter: number;
    identityAfter: string;
  } | null;
  /** Host-driven multi-day recovery rewind. */
  recoveryActive?: boolean;
  recoveryTargetDay?: number | null;
  recoveryDepth?: number | null;
  recoveryFailedPaths?: string[];
  recoveryHint?: string | null;
  updatedAt: string;
}

export interface ActionChainBrief {
  phase: ActionChainPhase;
  day: number | null;
  done: string[];
  missing: string[];
  allowedOps: string[];
  nextHint: string;
  top3: Top3Item[];
  newsSummary: string | null;
  mapChanges: string[];
  newCards: CardReviewItem[];
  requiredInspections: CardReviewItem[];
  utilization: {
    reusableAssignable: number;
    assigned: number;
    coverage: number;
    idle: IdleCardReason[];
  };
  executionTiming: ExecutionTimingAdvice;
  canAdvanceDay: boolean;
  sudanRouteProbePending?: number;
  recoveryActive?: boolean;
  recoveryTargetDay?: number | null;
  recoveryDepth?: number | null;
  recoveryFailedPaths?: string[];
  recoveryHint?: string | null;
}

export interface ActionChainReport {
  phase?: ActionChainPhase;
  newsChecked?: boolean;
  newsPresent?: boolean;
  newsSummary?: string | null;
  top3?: Top3Item[];
  reviewedCardUids?: number[];
  inspectedCardUids?: number[];
  reviewedRiteUids?: number[];
  allocations?: CardAllocation[];
  idleCards?: IdleCardReason[];
  localImproveDone?: boolean;
  sudanBreakDone?: boolean;
  notes?: string;
}

const CONTINUOUS_RITE_HINTS = [
  "治理家业",
  "权力的游戏",
  "浴场",
  "书店",
  "家业",
  "上朝",
  "court",
  "estate",
  "bath",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function enabledOps(state?: GameState | null, scene?: SceneSnapshot | null): Set<string> {
  const set = new Set<string>();
  for (var a of state?.actions ?? []) {
    if (a?.id && a.enabled !== false) set.add(a.id);
  }
  for (var aff of scene?.affordances ?? []) {
    if (aff?.enabled !== false && typeof aff.mapsToOp === "string" && aff.mapsToOp) {
      set.add(aff.mapsToOp);
    }
  }
  return set;
}

function phaseOf(state?: GameState | null): string {
  return String(state?.screen?.phase ?? "").toLowerCase();
}

function dayOf(state?: GameState | null): number | null {
  return asNumber(state?.values?.day) ?? asNumber(state?.values?.turn);
}

function guideActive(state?: GameState | null): boolean {
  const g = state?.values?.guide;
  return isRecord(g) && g.active === true;
}

function blocking(state?: GameState | null, scene?: SceneSnapshot | null): boolean {
  return (
    Boolean(state?.values?.blockingOverlay) ||
    Boolean(scene?.scene?.blocking) ||
    guideActive(state)
  );
}

/**
 * Overlays that continue must dismiss (prompt/guide/etc.). Soft daily_news is NOT
 * hard-blocking: plugin routes play+!overlayBlocking continue → next_day even when
 * modal=daily_news / StoryNotify is open.
 */
function hardBlockingForContinue(
  state?: GameState | null,
  scene?: SceneSnapshot | null,
): boolean {
  if (guideActive(state)) return true;
  if (Boolean(state?.values?.blockingOverlay)) return true;
  if (scene?.scene?.blocking !== true) return false;
  const modal = String(scene?.scene?.modal ?? "").toLowerCase();
  return modal !== "daily_news";
}

function screenPhase(state?: GameState | null, scene?: SceneSnapshot | null): string {
  const fromState = phaseOf(state);
  if (fromState) return fromState;
  return String(scene?.scene?.phase ?? "").toLowerCase();
}

/** True when a rite panel is actually open for interaction (not a stale Current ref). */
function ritePanelOpen(state?: GameState | null, scene?: SceneSnapshot | null): boolean {
  const phase = screenPhase(state, scene);
  if (phase === "rite") return true;
  if (scene?.scene?.phase?.toLowerCase() === "rite") return true;
  const elements = scene?.elements ?? [];
  return elements.some(
    (el) =>
      el?.elementId === "semantic:rite_panel" ||
      (typeof el?.elementId === "string" && el.elementId.startsWith("semantic:rite_")),
  );
}

function handCards(state?: GameState | null): Array<Record<string, unknown>> {
  const values = isRecord(state?.values) ? state!.values! : {};
  const raw = Array.isArray(values.cards)
    ? values.cards
    : Array.isArray(state?.cards)
      ? state!.cards
      : [];
  return (raw as unknown[])
    .filter(isRecord)
    .filter((c) => c.inHand === true || c.bag === 0 || c.inHand == null);
}

function riteLooksLikeSudanOutlet(
  name: string | null | undefined,
  slotPreview: unknown,
): boolean {
  if (/sudan|苏丹|杀戮|纵欲|征服|奢靡|权力的游戏|处刑|处决/i.test(name ?? "")) {
    return true;
  }
  if (!Array.isArray(slotPreview)) return false;
  for (const raw of slotPreview) {
    if (!isRecord(raw)) continue;
    const ct = (asString(raw.conditionType) ?? "").toLowerCase();
    const blob = `${asString(raw.condition) ?? ""} ${asString(raw.text) ?? ""}`;
    if (ct.includes("sudan") || /sudan|苏丹|杀戮|纵欲|征服|奢靡/i.test(blob)) {
      return true;
    }
  }
  return false;
}

function riteSignatureFromRecord(rite: Record<string, unknown>): MapPointSignature | null {
  const riteUid = asNumber(rite.uid) ?? asNumber(rite.riteUid);
  if (riteUid == null || riteUid < 0) return null;
  const slots = Array.isArray(rite.slots) ? (rite.slots as unknown[]) : [];
  const slotSig = slots
    .filter(isRecord)
    .map(
      (s) =>
        `${asNumber(s.index) ?? "?"}:${s.occupied === true ? asNumber(s.cardUid) ?? "x" : "_"}`,
    )
    .join(",");
  const slotPreview = Array.isArray(rite.slotPreview) ? rite.slotPreview : [];
  const name = asString(rite.name) ?? asString(rite.customName) ?? asString(rite.label);
  return {
    riteUid,
    riteId: asNumber(rite.id) ?? asNumber(rite.riteId),
    name,
    life: asNumber(rite.life),
    started: rite.start === true || rite.started === true,
    slotsFilled: asNumber(rite.slotsFilled),
    canConfirm: rite.canConfirm === true,
    slotSig: slotSig || undefined,
    slotPreviewCount: slotPreview.length,
    handMatchCount: asNumber(rite.handMatchCount),
    sudanOutletHint: riteLooksLikeSudanOutlet(name, slotPreview),
  };
}

/** Prefer richer signatures (slots / name / life) when merging duplicate uids. */
function mergeRiteSignature(prev: MapPointSignature, next: MapPointSignature): MapPointSignature {
  const prevScore =
    (prev.slotSig ? 4 : 0) +
    (prev.name ? 2 : 0) +
    (prev.life != null ? 1 : 0) +
    (prev.slotsFilled != null ? 1 : 0) +
    ((prev.slotPreviewCount ?? 0) > 0 ? 2 : 0);
  const nextScore =
    (next.slotSig ? 4 : 0) +
    (next.name ? 2 : 0) +
    (next.life != null ? 1 : 0) +
    (next.slotsFilled != null ? 1 : 0) +
    ((next.slotPreviewCount ?? 0) > 0 ? 2 : 0);
  if (nextScore > prevScore) return { ...prev, ...next, riteUid: next.riteUid };
  return {
    ...next,
    ...prev,
    riteUid: prev.riteUid,
    name: prev.name ?? next.name,
    life: prev.life ?? next.life,
    slotsFilled: prev.slotsFilled ?? next.slotsFilled,
    slotSig: prev.slotSig || next.slotSig,
    slotPreviewCount: Math.max(prev.slotPreviewCount ?? 0, next.slotPreviewCount ?? 0),
    handMatchCount: prev.handMatchCount ?? next.handMatchCount,
    sudanOutletHint: prev.sudanOutletHint === true || next.sudanOutletHint === true,
  };
}

/**
 * Live map inventory: merge state.values.rites, top-level state.rites,
 * scene.telemetry.mapRites, and open_rite affordances. Compact /state often
 * strips values.rites; scene telemetry still lists visible map points.
 */
function mapRites(state?: GameState | null, scene?: SceneSnapshot | null): MapPointSignature[] {
  const byUid = new Map<number, MapPointSignature>();
  const ingest = (raw: unknown) => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const sig = riteSignatureFromRecord(item);
      if (!sig) continue;
      const prev = byUid.get(sig.riteUid);
      byUid.set(sig.riteUid, prev ? mergeRiteSignature(prev, sig) : sig);
    }
  };

  const values = isRecord(state?.values) ? state!.values! : {};
  ingest(values.rites);
  ingest(state?.rites);

  const telemetry = isRecord(scene?.telemetry) ? scene!.telemetry! : {};
  ingest(telemetry.mapRites);

  for (const aff of scene?.affordances ?? []) {
    if (aff?.enabled === false || aff.mapsToOp !== "open_rite" || !isRecord(aff.parameters)) {
      continue;
    }
    const uid = asNumber(aff.parameters.uid) ?? asNumber(aff.parameters.riteUid);
    if (uid == null) continue;
    ingest([
      {
        uid,
        id: aff.parameters.id,
        name: asString(aff.label) ?? asString(aff.parameters.name),
        life: aff.parameters.life,
        handMatchCount: aff.parameters.handMatchCount,
        slotPreview: aff.parameters.slotPreview,
      },
    ]);
  }

  return [...byUid.values()].sort((a, b) => a.riteUid - b.riteUid);
}

/** Put added: first so the agent notices newly spawned map points. */
export function prioritizeMapChanges(changes: string[]): string[] {
  const added: string[] = [];
  const rest: string[] = [];
  for (const change of changes) {
    if (change.startsWith("added:")) added.push(change);
    else rest.push(change);
  }
  return added.concat(rest);
}

function dailyNews(state?: GameState | null): Record<string, unknown> {
  const values = isRecord(state?.values) ? state!.values! : {};
  return isRecord(values.dailyNews) ? values.dailyNews : {};
}

function isContinuousRite(name?: string | null): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return CONTINUOUS_RITE_HINTS.some((h) => lower.includes(h.toLowerCase()));
}

function isReusableCard(card: Record<string, unknown>): boolean {
  const type = asString(card.type)?.toLowerCase() ?? "";
  // Consumables / one-shot items are typically non-char and high rarity or tagged.
  if (type === "char" || type === "character" || type === "follower") return true;
  if (type === "sudan") return false;
  if (
    type === "item" &&
    (isStrategicTierCard({
      type,
      rare: asNumber(card.rare),
      name: asString(card.name),
    }) ||
      isCurrencyCard({
        type,
        rare: asNumber(card.rare),
        name: asString(card.name),
      }))
  ) {
    return false;
  }
  if (type === "consumable" || type === "once") return false;
  // Default: treat ordinary cards as reusable until proven otherwise.
  return type !== "sudan";
}

function emptyCheckpoint(day: number | null = null): ActionChainCheckpoint {
  return {
    schemaVersion: 1,
    day,
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
    recoveryActive: false,
    recoveryTargetDay: null,
    recoveryDepth: null,
    recoveryFailedPaths: [],
    recoveryHint: null,
    updatedAt: new Date().toISOString(),
  };
}

function sudanCardsInHand(state?: GameState | null): Array<Record<string, unknown>> {
  return handCards(state).filter((c) => {
    const type = (asString(c.type) ?? "").toLowerCase();
    const name = (asString(c.name) ?? asString(c.customName) ?? "").toLowerCase();
    return type === "sudan" || type.includes("sudan") || name.includes("苏丹");
  });
}

function diffMap(prev: MapPointSignature[], next: MapPointSignature[]): string[] {
  const changes: string[] = [];
  const prevBy = new Map(prev.map((p) => [p.riteUid, p]));
  const nextBy = new Map(next.map((p) => [p.riteUid, p]));
  for (var n of next) {
    const p = prevBy.get(n.riteUid);
    if (!p) {
      changes.push(`added:${n.riteUid}:${n.name ?? "?"}`);
      continue;
    }
    if (p.life !== n.life) changes.push(`life:${n.riteUid}:${p.life}->${n.life}`);
    if (p.started !== n.started) changes.push(`started:${n.riteUid}:${p.started}->${n.started}`);
    if (p.slotsFilled !== n.slotsFilled) {
      changes.push(`slots:${n.riteUid}:${p.slotsFilled}->${n.slotsFilled}`);
    }
    if ((p.slotSig ?? "") !== (n.slotSig ?? "")) {
      changes.push(`slotSig:${n.riteUid}`);
    }
  }
  for (var p of prev) {
    if (!nextBy.has(p.riteUid)) changes.push(`removed:${p.riteUid}:${p.name ?? "?"}`);
  }
  return changes;
}

export class ActionChainController {
  private cp: ActionChainCheckpoint;
  private readonly checkpointPath: string | null;
  private readonly inspectionRequirement?: (
    card: Record<string, unknown>,
    state?: GameState | null,
  ) => CardInspectionReason | null;

  constructor(opts?: {
    memoryDir?: string | null;
    initial?: ActionChainCheckpoint | null;
    inspectionRequirement?: (
      card: Record<string, unknown>,
      state?: GameState | null,
    ) => CardInspectionReason | null;
  }) {
    this.checkpointPath = opts?.memoryDir
      ? path.join(opts.memoryDir, "action-chain-checkpoint.json")
      : null;
    this.inspectionRequirement = opts?.inspectionRequirement;
    this.cp = opts?.initial ?? this.load() ?? emptyCheckpoint();
  }

  get checkpoint(): ActionChainCheckpoint {
    return {
      ...this.cp,
      top3: [...this.cp.top3],
      seenCardIds: [...this.cp.seenCardIds],
      newCardUids: [...this.cp.newCardUids],
      requiredInspectionCardUids: [...this.cp.requiredInspectionCardUids],
      inspectionReasons: { ...this.cp.inspectionReasons },
      allocations: [...this.cp.allocations],
    };
  }

  setSudanRouteProbePending(count: number): void {
    this.cp.sudanRouteProbePending = Math.max(0, count);
    this.save();
  }

  setSudanExchangeTierRegression(
    value: ActionChainCheckpoint["sudanExchangeTierRegression"],
  ): void {
    this.cp.sudanExchangeTierRegression = value ?? null;
    this.save();
  }

  setSudanBreakVerified(done: boolean): void {
    this.cp.sudanBreakDone = done;
    if (done) this.cp.sudanExchangeTierRegression = null;
    this.save();
  }

  setRecoveryPlan(plan: {
    targetDay: number;
    depth: number;
    failedPathSignatures: string[];
    hint?: string | null;
  }): void {
    this.cp.recoveryActive = true;
    this.cp.recoveryTargetDay = plan.targetDay;
    this.cp.recoveryDepth = plan.depth;
    this.cp.recoveryFailedPaths = [...plan.failedPathSignatures];
    this.cp.recoveryHint = plan.hint ?? null;
    this.cp.phase = "recovery_rewind";
    this.save();
  }

  clearRecoveryPlan(): void {
    this.cp.recoveryActive = false;
    this.cp.recoveryTargetDay = null;
    this.cp.recoveryDepth = null;
    this.cp.recoveryFailedPaths = [];
    this.cp.recoveryHint = null;
    this.save();
  }

  resetForNewGame(): void {
    this.cp = emptyCheckpoint(null);
    this.save();
  }

  private load(): ActionChainCheckpoint | null {
    if (!this.checkpointPath || !fs.existsSync(this.checkpointPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.checkpointPath, "utf8")) as ActionChainCheckpoint;
      if (raw?.schemaVersion !== 1) return null;
      const defaults = emptyCheckpoint(raw.day ?? null);
      return {
        ...defaults,
        ...raw,
        reviewedCardUids: Array.isArray(raw.reviewedCardUids) ? raw.reviewedCardUids : [],
        inspectedCardUids: Array.isArray(raw.inspectedCardUids) ? raw.inspectedCardUids : [],
        seenCardIds: Array.isArray(raw.seenCardIds) ? raw.seenCardIds : [],
        newCardUids: Array.isArray(raw.newCardUids) ? raw.newCardUids : [],
        requiredInspectionCardUids: Array.isArray(raw.requiredInspectionCardUids)
          ? raw.requiredInspectionCardUids
          : [],
        inspectionReasons: isRecord(raw.inspectionReasons)
          ? (raw.inspectionReasons as Record<string, CardInspectionReason>)
          : {},
      };
    } catch {
      return null;
    }
  }

  private save(): void {
    this.cp.updatedAt = new Date().toISOString();
    if (!this.checkpointPath) return;
    try {
      fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true });
      fs.writeFileSync(this.checkpointPath, JSON.stringify(this.cp, null, 2), "utf8");
    } catch {
      // best-effort
    }
  }

  observe(state?: GameState | null, scene?: SceneSnapshot | null): ActionChainBrief {
    const day = dayOf(state);
    const cards = handCards(state);
    if (this.cp.day != null && day != null && day !== this.cp.day) {
      const liveRites = mapRites(state, scene);
      const prevMap = this.cp.previousMap.length ? this.cp.previousMap : liveRites;
      const seenCardIds = [...this.cp.seenCardIds];
      const cardBaselineInitialized = this.cp.cardBaselineInitialized;
      this.cp = emptyCheckpoint(day);
      this.cp.entrySetupDone = true;
      this.cp.sudanDrawn = true;
      // Keep prior baseline so added:/removed: stay meaningful; refreshMapInventory
      // will recompute if liveRites was empty at this instant and fills in later.
      this.cp.previousMap = prevMap;
      this.cp.mapChanges =
        liveRites.length > 0 ? prioritizeMapChanges(diffMap(prevMap, liveRites)) : [];
      this.cp.seenCardIds = seenCardIds;
      this.cp.cardBaselineInitialized = cardBaselineInitialized;
    } else if (this.cp.day == null && day != null) {
      this.cp.day = day;
    }
    const liveSudan = isRecord(state?.values?.sudan) ? state!.values!.sudan : null;
    if (
      this.cp.sudanBreakDone &&
      (isRecord(liveSudan?.currentCard) || sudanCardsInHand(state).length > 0)
    ) {
      // A reported/previously inferred break must never override live game state.
      this.cp.sudanBreakDone = false;
    }
    this.updateCardTracking(cards, state);

    const ops = enabledOps(state, scene);
    const phase = phaseOf(state);
    const terminal = state?.terminal === true || phase === "terminal";
    const news = dailyNews(state);
    const rites = mapRites(state, scene);
    const cardUids = new Set(
      cards.map((c) => asNumber(c.uid)).filter((u): u is number => u != null),
    );
    const riteUids = new Set(rites.map((r) => r.riteUid));

    // Drop stale UIDs after state changes.
    this.cp.reviewedCardUids = this.cp.reviewedCardUids.filter((u) => cardUids.has(u));
    this.cp.inspectedCardUids = this.cp.inspectedCardUids.filter((u) => cardUids.has(u));
    this.cp.newCardUids = this.cp.newCardUids.filter((u) => cardUids.has(u));
    this.cp.requiredInspectionCardUids = this.cp.requiredInspectionCardUids.filter((u) =>
      cardUids.has(u),
    );
    this.cp.reviewedRiteUids = this.cp.reviewedRiteUids.filter((u) => riteUids.has(u));
    // Allocations require BOTH card and rite still present (AND, not OR).
    this.cp.allocations = this.cp.allocations.filter(
      (a) => cardUids.has(a.cardUid) && riteUids.has(a.riteUid),
    );
    const assignedUids = new Set(this.cp.allocations.map((a) => a.cardUid));
    this.cp.idleCards = this.cp.idleCards.filter(
      (i) => cardUids.has(i.cardUid) && !assignedUids.has(i.cardUid),
    );

    if (this.cp.recoveryActive) {
      const day = asNumber(state?.values?.day) ?? asNumber(state?.values?.turn);
      if (day != null && this.cp.recoveryTargetDay != null && day <= this.cp.recoveryTargetDay) {
        // Reached target — clear host rewind lock and resume normal phase derivation below.
        this.cp.recoveryActive = false;
      } else {
        this.cp.phase = "recovery_rewind";
        this.cp.utilizationOk = this.utilizationSatisfied(state, scene);
        this.refreshMapInventory(rites);
        this.save();
        return this.brief(state, scene);
      }
    }

    if (
      !this.cp.entrySetupDone &&
      (phase === "boot" ||
        phase === "main_menu" ||
        phase === "difficulty" ||
        phase === "story" ||
        phase === "change_name" ||
        phase === "prompt" ||
        phase === "wizard" ||
        ops.has("select_difficulty") ||
        ops.has("select_event_option"))
    ) {
      this.cp.phase = "entry_setup";
    } else if (
      !this.cp.sudanDrawn &&
      (phase === "sudan_draw" || ops.has("draw_sudan_card") || guideActive(state))
    ) {
      this.cp.entrySetupDone = true;
      this.cp.phase = "sudan_draw";
    } else if (terminal) {
      this.cp.phase = "terminal";
    } else if (blocking(state, scene) && phase !== "play" && phase !== "rite") {
      this.cp.phase = "blocked";
    } else {
      this.cp.entrySetupDone = true;
      if (phase === "sudan_draw" || ops.has("draw_sudan_card")) {
        this.cp.phase = "sudan_draw";
      } else if (!this.cp.newsChecked) {
        this.cp.phase = "daily_news";
      } else if (!this.handReviewComplete(cards)) {
        this.cp.phase = "hand_review";
      } else if (!this.mapReviewComplete(rites)) {
        this.cp.phase = "map_review";
      } else if (this.cp.top3.length === 0) {
        this.cp.phase = "synthesis";
      } else if (!this.cp.localImproveDone || !this.utilizationSatisfied(state, scene)) {
        this.cp.phase =
          this.cp.allocations.length === 0 && this.cp.idleCards.length === 0
            ? "allocation"
            : "local_improve";
      } else {
        this.cp.phase = "end_day_gate";
      }
    }

    // Auto-skip when no StoryNotify popup. StoryEntry/story book is NOT daily news.
    if (
      this.cp.phase === "daily_news" &&
      news.present === false &&
      news.open !== true
    ) {
      this.cp.newsChecked = true;
      this.cp.newsPresent = false;
      if (!this.cp.newsSummary) this.cp.newsSummary = null;
    }

    this.cp.utilizationOk = this.utilizationSatisfied(state, scene);
    this.refreshMapInventory(rites);

    this.save();
    return this.brief(state, scene);
  }

  /**
   * Keep mapChanges fresh whenever a non-empty live inventory is available.
   * Day-boundary may have run with compact/empty rites (only "removed:") —
   * recompute once scene/state lists the real map so "added:" appears.
   * previousMap stays as the baseline (session/day-start); do not overwrite
   * it with the live set or added markers disappear mid-day.
   */
  private refreshMapInventory(rites: MapPointSignature[]): void {
    if (rites.length === 0) return;
    if (this.cp.previousMap.length === 0) {
      this.cp.previousMap = rites;
      if (this.cp.mapChanges.length === 0) this.cp.mapChanges = [];
      return;
    }
    this.cp.mapChanges = prioritizeMapChanges(diffMap(this.cp.previousMap, rites));
  }

  private updateCardTracking(
    cards: Array<Record<string, unknown>>,
    state?: GameState | null,
  ): void {
    const identities = cards
      .map((card) => ({
        card,
        uid: asNumber(card.uid),
        cardId: asNumber(card.id) ?? asNumber(card.cardId),
      }))
      .filter(
        (item): item is {
          card: Record<string, unknown>;
          uid: number;
          cardId: number | null;
        } => item.uid != null,
      );

    if (!this.cp.cardBaselineInitialized) {
      this.cp.cardBaselineInitialized = true;
      this.cp.seenCardIds = [
        ...new Set(
          identities
            .map((item) => item.cardId)
            .filter((cardId): cardId is number => cardId != null),
        ),
      ];
      this.cp.newCardUids = [];
    } else {
      const seen = new Set(this.cp.seenCardIds);
      for (const item of identities) {
        if (item.cardId == null || seen.has(item.cardId)) continue;
        seen.add(item.cardId);
        if (!this.cp.newCardUids.includes(item.uid)) this.cp.newCardUids.push(item.uid);
      }
      this.cp.seenCardIds = [...seen];
    }

    const required: number[] = [];
    const reasons: Record<string, CardInspectionReason> = {};
    for (const item of identities) {
      if (this.cp.inspectedCardUids.includes(item.uid)) continue;
      const reason = this.inspectionRequirement
        ? this.inspectionRequirement(item.card, state)
        : this.cp.newCardUids.includes(item.uid)
          ? "missing_knowledge"
          : null;
      if (!reason) continue;
      required.push(item.uid);
      reasons[String(item.uid)] = reason;
    }
    this.cp.requiredInspectionCardUids = required;
    this.cp.inspectionReasons = reasons;
  }

  private handReviewComplete(cards: Array<Record<string, unknown>>): boolean {
    if (cards.length === 0) return true;
    return cards.every((c) => {
      const uid = asNumber(c.uid);
      if (uid == null) return true;
      if (this.cp.requiredInspectionCardUids.includes(uid)) {
        return this.cp.inspectedCardUids.includes(uid);
      }
      return this.cp.reviewedCardUids.includes(uid) || this.cp.inspectedCardUids.includes(uid);
    });
  }

  private addedMapUids(): Set<number> {
    const set = new Set<number>();
    for (const change of this.cp.mapChanges) {
      const match = /^added:(\d+)/.exec(change);
      if (match) set.add(Number(match[1]));
    }
    return set;
  }

  /**
   * Soft-review: config slotPreview present and point is not a must-open target.
   * Must-open: mapChanges added:, missing slotPreview, or sudan_route_probe pending on sudan outlet.
   */
  private canSoftReviewRite(rite: MapPointSignature, addedUids: Set<number>): boolean {
    if (addedUids.has(rite.riteUid)) return false;
    if ((rite.slotPreviewCount ?? 0) <= 0) return false;
    if (this.cp.sudanRouteProbePending > 0 && rite.sudanOutletHint === true) {
      return false;
    }
    return true;
  }

  private mapReviewComplete(rites: MapPointSignature[]): boolean {
    if (rites.length === 0) return true;
    const addedUids = this.addedMapUids();
    return rites.every(
      (r) =>
        this.cp.reviewedRiteUids.includes(r.riteUid) || this.canSoftReviewRite(r, addedUids),
    );
  }

  private reusableAssignable(
    state?: GameState | null,
    scene?: SceneSnapshot | null,
  ): Array<Record<string, unknown>> {
    const cards = handCards(state);
    const hasPositiveSlots =
      (scene?.affordances ?? []).some(
        (a) => a?.enabled !== false && a.mapsToOp === "place_card_on_rite",
      ) ||
      mapRites(state, scene).some(
        (r) => isContinuousRite(r.name) || (r.life != null && r.life > 0) || !r.started,
      );
    if (!hasPositiveSlots) return [];
    return cards.filter((c) => isReusableCard(c));
  }

  utilizationSatisfied(state?: GameState | null, scene?: SceneSnapshot | null): boolean {
    const reusable = this.reusableAssignable(state, scene);
    if (reusable.length === 0) return true;
    const assigned = new Set(this.cp.allocations.map((a) => a.cardUid));
    const idleOk = new Map(this.cp.idleCards.map((i) => [i.cardUid, i.reason]));
    for (var card of reusable) {
      const uid = asNumber(card.uid);
      if (uid == null) continue;
      if (assigned.has(uid)) continue;
      const reason = idleOk.get(uid);
      if (reason === "reserved" || reason === "no_positive_slot") continue;
      return false;
    }
    return true;
  }

  applyReport(
    report: ActionChainReport,
    state?: GameState | null,
    scene?: SceneSnapshot | null,
  ): { ok: boolean; error?: string; brief: ActionChainBrief } {
    if (report.sudanBreakDone === true) {
      return {
        ok: false,
        error: "sudan_break_not_verified",
        brief: this.brief(state, scene),
      };
    }
    const cardUids = new Set(
      handCards(state)
        .map((c) => asNumber(c.uid))
        .filter((u): u is number => u != null),
    );
    const riteUids = new Set(mapRites(state, scene).map((r) => r.riteUid));
    const requiredInspections = new Set(this.cp.requiredInspectionCardUids);

    for (const uid of report.inspectedCardUids ?? []) {
      if (requiredInspections.has(uid)) {
        return {
          ok: false,
          error: `inspection_evidence_required:${uid}`,
          brief: this.brief(state, scene),
        };
      }
    }
    for (const uid of report.reviewedCardUids ?? []) {
      if (requiredInspections.has(uid)) {
        return {
          ok: false,
          error: `inspection_evidence_required:${uid}`,
          brief: this.brief(state, scene),
        };
      }
    }

    if (report.newsChecked != null) this.cp.newsChecked = report.newsChecked;
    if (report.newsPresent != null) this.cp.newsPresent = report.newsPresent;
    if (report.newsSummary !== undefined) this.cp.newsSummary = report.newsSummary ?? null;
    if (report.top3) {
      if (report.top3.length > 3) {
        return { ok: false, error: "top3_too_long", brief: this.brief(state, scene) };
      }
      this.cp.top3 = report.top3.slice(0, 3);
    }
    if (report.reviewedCardUids) {
      for (var uid of report.reviewedCardUids) {
        if (!cardUids.has(uid)) {
          return { ok: false, error: `unknown_card_uid:${uid}`, brief: this.brief(state, scene) };
        }
      }
      this.cp.reviewedCardUids = [...new Set(report.reviewedCardUids)];
    }
    if (report.inspectedCardUids) {
      for (var uid of report.inspectedCardUids) {
        if (!cardUids.has(uid)) {
          return { ok: false, error: `unknown_card_uid:${uid}`, brief: this.brief(state, scene) };
        }
      }
      this.cp.inspectedCardUids = [...new Set(report.inspectedCardUids)];
      for (var uid of this.cp.inspectedCardUids) {
        if (!this.cp.reviewedCardUids.includes(uid)) this.cp.reviewedCardUids.push(uid);
      }
    }
    if (report.reviewedRiteUids) {
      for (var uid of report.reviewedRiteUids) {
        if (!riteUids.has(uid)) {
          return { ok: false, error: `unknown_rite_uid:${uid}`, brief: this.brief(state, scene) };
        }
      }
      this.cp.reviewedRiteUids = [...new Set(report.reviewedRiteUids)];
    }
    if (report.allocations) {
      const seenSlots = new Set<string>();
      const seenCards = new Set<number>();
      for (var a of report.allocations) {
        if (!cardUids.has(a.cardUid)) {
          return {
            ok: false,
            error: `unknown_card_uid:${a.cardUid}`,
            brief: this.brief(state, scene),
          };
        }
        if (!riteUids.has(a.riteUid) && riteUids.size > 0) {
          return {
            ok: false,
            error: `unknown_rite_uid:${a.riteUid}`,
            brief: this.brief(state, scene),
          };
        }
        const slotKey = `${a.riteUid}:${a.slotIndex}`;
        if (seenSlots.has(slotKey)) {
          return { ok: false, error: `duplicate_slot:${slotKey}`, brief: this.brief(state, scene) };
        }
        if (seenCards.has(a.cardUid)) {
          return {
            ok: false,
            error: `duplicate_card:${a.cardUid}`,
            brief: this.brief(state, scene),
          };
        }
        seenSlots.add(slotKey);
        seenCards.add(a.cardUid);
      }
      this.cp.allocations = report.allocations;
    }
    if (report.idleCards) {
      const assignedAfter =
        report.allocations != null
          ? new Set(report.allocations.map((a) => a.cardUid))
          : new Set(this.cp.allocations.map((a) => a.cardUid));
      for (var idle of report.idleCards) {
        if (!cardUids.has(idle.cardUid)) {
          return {
            ok: false,
            error: `unknown_card_uid:${idle.cardUid}`,
            brief: this.brief(state, scene),
          };
        }
        if (idle.reason !== "reserved" && idle.reason !== "no_positive_slot") {
          return { ok: false, error: "invalid_idle_reason", brief: this.brief(state, scene) };
        }
        if (assignedAfter.has(idle.cardUid)) {
          return {
            ok: false,
            error: `idle_and_assigned:${idle.cardUid}`,
            brief: this.brief(state, scene),
          };
        }
      }
      this.cp.idleCards = report.idleCards;
    }
    if (report.localImproveDone != null) this.cp.localImproveDone = report.localImproveDone;
    if (report.sudanBreakDone === false) this.cp.sudanBreakDone = false;

    this.cp.utilizationOk = this.utilizationSatisfied(state, scene);
    this.save();
    return { ok: true, brief: this.observe(state, scene) };
  }

  noteAction(action: GameAction, state?: GameState | null, scene?: SceneSnapshot | null): void {
    const op = String(action.op ?? "");
    if (op === "start_new_game") {
      // Full reset — a new run must re-enter entry_setup / sudan_draw.
      this.cp = emptyCheckpoint(null);
      this.save();
      return;
    }
    if (op === "draw_sudan_card") {
      this.cp.sudanDrawn = true;
      this.cp.entrySetupDone = true;
    }
    if (op === "select_difficulty" || op === "select_event_option" || op === "execute") {
      // Progress through entry UI; final draw still required separately.
      if (phaseOf(state) !== "sudan_draw") this.cp.entrySetupDone = true;
    }
    if (op === "open_daily_news") {
      this.cp.newsChecked = true;
      const news = dailyNews(state);
      this.cp.newsPresent = news.present !== false;
      if (typeof news.summary === "string") this.cp.newsSummary = news.summary;
    }
    if (op === "open_rite") {
      const uid = asNumber(action.uid) ?? asNumber(action.riteId);
      if (uid != null && !this.cp.reviewedRiteUids.includes(uid)) {
        this.cp.reviewedRiteUids.push(uid);
      }
    }
    if (op === "place_card_on_rite") {
      const cardUid = asNumber(action.uid) ?? asNumber(action.cardId);
      const slotIndex = asNumber(action.slotIndex) ?? asNumber(action.slotId);
      const current = isRecord(state?.values?.currentRite) ? state!.values!.currentRite : null;
      const riteUid = asNumber(current?.uid) ?? asNumber(action.riteId);
      if (cardUid != null && riteUid != null && slotIndex != null) {
        this.cp.allocations = this.cp.allocations.filter(
          (a) => a.cardUid !== cardUid && !(a.riteUid === riteUid && a.slotIndex === slotIndex),
        );
        this.cp.allocations.push({ cardUid, riteUid, slotIndex });
        this.cp.idleCards = this.cp.idleCards.filter((i) => i.cardUid !== cardUid);
        this.cp.localImproveDone = false;
      }
    }
    if (op === "reset" || op === "cancel_card_placement" || op === "clear_rite_submission") {
      this.cp.localImproveDone = false;
      // Clear stale allocations for the currently open rite (placements were undone).
      const current = isRecord(state?.values?.currentRite) ? state!.values!.currentRite : null;
      const riteUid = asNumber(current?.uid) ?? asNumber(action.riteId);
      if (riteUid != null) {
        this.cp.allocations = this.cp.allocations.filter((a) => a.riteUid !== riteUid);
      } else {
        // No current rite context — drop all reported placements; they are no longer trusted.
        this.cp.allocations = [];
      }
    }
    if (op === "next_day" || op === "next_round") {
      // Day advance handled on next observe via day change.
    }
    this.save();
    this.observe(state, scene);
  }

  confirmCardInspection(uid: number): void {
    if (!this.cp.inspectedCardUids.includes(uid)) this.cp.inspectedCardUids.push(uid);
    if (!this.cp.reviewedCardUids.includes(uid)) this.cp.reviewedCardUids.push(uid);
    this.cp.requiredInspectionCardUids = this.cp.requiredInspectionCardUids.filter(
      (candidate) => candidate !== uid,
    );
    delete this.cp.inspectionReasons[String(uid)];
    this.save();
  }

  /**
   * Advisory checklist status. Does NOT authorize or block next_day —
   * resources may force skipping a day with an incomplete chain.
   */
  canAdvanceDay(state?: GameState | null, scene?: SceneSnapshot | null): {
    ok: boolean;
    missing: string[];
  } {
    const brief = this.observe(state, scene);
    return { ok: brief.canAdvanceDay, missing: brief.missing };
  }

  /** @deprecated Day advance is explicit next_day; keep for older callers. */
  isTrueNextDayContinue(state?: GameState | null, scene?: SceneSnapshot | null): boolean {
    const phase = screenPhase(state, scene);
    if (phase !== "play") return false;
    if (hardBlockingForContinue(state, scene)) return false;
    if (ritePanelOpen(state, scene)) return false;
    return true;
  }

  private cardReviewItems(
    cards: Array<Record<string, unknown>>,
    uids: number[],
    defaultReason: CardReviewItem["reason"],
  ): CardReviewItem[] {
    const wanted = new Set(uids);
    return cards
      .filter((card) => wanted.has(asNumber(card.uid) ?? -1))
      .map((card) => {
        const uid = asNumber(card.uid)!;
        return {
          uid,
          cardId: asNumber(card.id) ?? asNumber(card.cardId),
          name: asString(card.name) ?? asString(card.customName),
          tier: formatTier(card.rare),
          reason: this.cp.inspectionReasons[String(uid)] ?? defaultReason,
        };
      });
  }

  brief(state?: GameState | null, scene?: SceneSnapshot | null): ActionChainBrief {
    const ops = enabledOps(state, scene);
    const cards = handCards(state);
    const rites = mapRites(state, scene);
    const reusable = this.reusableAssignable(state, scene);
    const assigned = new Set(this.cp.allocations.map((a) => a.cardUid));
    const assignedReusable = reusable.filter((c) => assigned.has(asNumber(c.uid) ?? -1)).length;
    const missing: string[] = [];
    const done: string[] = [];

    if (this.cp.entrySetupDone) done.push("entry_setup");
    else missing.push("entry_setup");
    if (this.cp.sudanDrawn) done.push("sudan_draw");
    else if (ops.has("draw_sudan_card") || phaseOf(state) === "sudan_draw") missing.push("sudan_draw");
    if (this.cp.newsChecked) done.push("daily_news");
    else missing.push("daily_news");
    if (this.handReviewComplete(cards)) done.push("hand_review");
    else {
      missing.push("hand_review");
      if (this.cp.requiredInspectionCardUids.length > 0) {
        missing.push(`inspection_required:${this.cp.requiredInspectionCardUids.length}`);
      }
    }
    if (this.mapReviewComplete(rites)) done.push("map_review");
    else missing.push(`map_review:${rites.length - this.cp.reviewedRiteUids.length}_left`);
    if ((this.cp.sudanRouteProbePending ?? 0) > 0) {
      missing.push(`sudan_route_probe:${this.cp.sudanRouteProbePending}`);
    } else {
      done.push("sudan_route_probe");
    }
    if (this.cp.top3.length > 0) done.push("synthesis");
    else if (this.handReviewComplete(cards) && this.mapReviewComplete(rites)) {
      missing.push("synthesis_top3");
    }
    if (this.cp.localImproveDone) done.push("local_improve");
    else if (this.cp.top3.length > 0) missing.push("local_improve");
    if (this.utilizationSatisfied(state, scene)) done.push("utilization");
    else missing.push("reusable_card_coverage");

    const snapshot = buildStrategySnapshot({ state, scene });
    const timing = adviseExecutionTiming(snapshot);
    const sudanHand = sudanCardsInHand(state);
    const sudanAllocated = this.cp.allocations.some((a) =>
      sudanHand.some((c) => asNumber(c.uid) === a.cardUid),
    );
    if (
      (timing.policy === "commit_best" || timing.policy === "emergency") &&
      !this.cp.sudanBreakDone
    ) {
      if (sudanHand.length > 0 && !sudanAllocated) {
        missing.push("execution_break_today");
      } else if (sudanHand.length > 0 && sudanAllocated && !this.cp.sudanBreakDone) {
        missing.push("execution_submit_today");
      } else if (timing.lethalIfUnbroken && sudanHand.length === 0 && !this.cp.sudanBreakDone) {
        // No sudan card visible in hand projection — still warn, but do not hard-block
        // solely on missing projection; strategy brief carries the lethal hint.
        done.push("execution_timing_reviewed");
      }
    } else if (timing.policy === "branch_test" && !this.cp.sudanBreakDone) {
      missing.push("sudan_branch_test");
    } else if (timing.preferDelayBreak) {
      done.push("execution_delay_ok");
    }
    if (this.cp.sudanBreakDone) done.push("sudan_break_done");

    const allowed = this.allowedOpsForPhase(this.cp.phase, ops);
    // sudan_route_probe / sudan_branch_test / execution_* are advisory and do not
    // hard-gate next_day (host day-close review also keeps them soft).
    const hardMissing = missing.filter(
      (m) =>
        m !== "entry_setup" &&
        m !== "sudan_draw" &&
        !m.startsWith("sudan_route_probe") &&
        m !== "sudan_branch_test" &&
        m !== "execution_break_today" &&
        m !== "execution_submit_today",
    );
    const canAdvanceDay =
      hardMissing.length === 0 &&
      this.cp.newsChecked &&
      this.handReviewComplete(cards) &&
      this.mapReviewComplete(rites) &&
      this.cp.top3.length > 0 &&
      this.cp.localImproveDone &&
      this.utilizationSatisfied(state, scene);

    return {
      phase: this.cp.phase,
      day: this.cp.day,
      done,
      missing,
      allowedOps: allowed,
      nextHint: this.nextHint(this.cp.phase, missing, timing),
      top3: this.cp.top3,
      newsSummary: this.cp.newsSummary,
      mapChanges: this.cp.mapChanges,
      newCards: this.cardReviewItems(cards, this.cp.newCardUids, "new_card"),
      requiredInspections: this.cardReviewItems(
        cards,
        this.cp.requiredInspectionCardUids,
        "missing_knowledge",
      ),
      utilization: {
        reusableAssignable: reusable.length,
        assigned: assignedReusable,
        coverage: reusable.length === 0 ? 1 : assignedReusable / reusable.length,
        idle: this.cp.idleCards,
      },
      executionTiming: timing,
      canAdvanceDay,
      sudanRouteProbePending: this.cp.sudanRouteProbePending ?? 0,
      recoveryActive: this.cp.recoveryActive === true,
      recoveryTargetDay: this.cp.recoveryTargetDay ?? null,
      recoveryDepth: this.cp.recoveryDepth ?? null,
      recoveryFailedPaths: this.cp.recoveryFailedPaths ?? [],
      recoveryHint: this.cp.recoveryHint ?? null,
    };
  }

  private allowedOpsForPhase(phase: ActionChainPhase, ops: Set<string>): string[] {
    const base = ["observe_scene", "get_state", "report_action_chain"];
    const pick = (...wanted: string[]) => wanted.filter((op) => ops.has(op) || op.startsWith("report"));
    switch (phase) {
      case "entry_setup":
        return [
          ...base,
          ...pick(
            "continue",
            "execute",
            "select_difficulty",
            "select_event_option",
            "start_new_game",
            "continue_game",
          ),
        ];
      case "sudan_draw":
        return [...base, ...pick("draw_sudan_card", "continue")];
      case "daily_news":
        return [...base, ...pick("open_daily_news", "next_day", "cancel")];
      case "hand_review":
        return [
          ...base,
          ...pick(
            "inspect_card",
            "think_card",
            "select_card",
            "open_sudan_box",
            "exchange_sudan_card",
            "equip_item",
            "unequip_item",
            "next_day",
            "continue",
            "cancel",
          ),
        ];
      case "map_review":
        return [
          ...base,
          ...pick(
            "open_rite",
            "inspect_card",
            "think_card",
            "open_sudan_box",
            "exchange_sudan_card",
            "cancel",
            "next_day",
            "continue",
            "reset",
            "prev_round",
          ),
        ];
      case "synthesis":
        return [
          ...base,
          ...pick("open_rite", "get_state", "open_sudan_box", "exchange_sudan_card", "next_day"),
        ];
      case "allocation":
      case "local_improve":
        return [
          ...base,
          ...pick(
            "open_rite",
            "place_card_on_rite",
            "equip_item",
            "unequip_item",
            "execute",
            "reset",
            "cancel",
            "inspect_card",
            "think_card",
            "open_sudan_box",
            "exchange_sudan_card",
            "prev_round",
            "next_day",
          ),
        ];
      case "end_day_gate":
        return [
          ...base,
          ...pick(
            "next_day",
            "reset",
            "open_rite",
            "place_card_on_rite",
            "equip_item",
            "unequip_item",
            "execute",
            "open_sudan_box",
            "exchange_sudan_card",
            "prev_round",
            "continue",
          ),
        ];
      case "blocked":
        return [
          ...base,
          ...pick(
            "continue",
            "execute",
            "reset",
            "cancel",
            "draw_sudan_card",
            "exchange_sudan_card",
          ),
        ];
      case "recovery_rewind":
        return [...base, ...pick("prev_round", "continue", "start_new_game")];
      case "terminal":
        return [...base, ...pick("prev_round", "start_new_game", "continue")];
      default:
        return [...base, ...[...ops]];
    }
  }

  private nextHint(
    phase: ActionChainPhase,
    missing: string[],
    timing?: ExecutionTimingAdvice,
  ): string {
    const execHint = timing?.hint ? ` ${timing.hint}` : "";
    switch (phase) {
      case "entry_setup":
        return "完成开局选择/加点，再进入抽卡。";
      case "sudan_draw":
        return "抽取苏丹卡后正式进入每日循环。";
      case "daily_news":
        return "仅处理已弹出的 StoryNotify 今日消息；无弹层则跳过。禁止打开一千零一夜/成就面板。";
      case "hand_review":
        return "盘点手牌与石/铜/银/金品阶；未知用途用 inspect_card 查摘要；书籍/苏丹卡/情报等可用 think_card 拖进俺寻思发现事件（成功后跟进新生地图点，忽略临时「俺寻思」仪式）；需要属性加成时用 equip_item/unequip_item。";
      case "map_review":
        return `先读 mapRites/rites 的 slotPreview 与 handMatchHints，优先 open 有匹配或 mapChanges added: 的点；已知常驻点有非空 preview 可跳过。sudan_route_probe / 新生点仍须 open_rite 读 place affordance。${execHint}`;
      case "synthesis":
        return `汇总消息/手牌/地图/苏丹路线覆盖，report_action_chain 提交 Top3。${execHint}`;
      case "allocation":
        return `按滚动策略分配：7-3 天准备路线，2 天试验分支（含换卡），1 天提交最佳；换卡不重置倒计时。${execHint}`;
      case "local_improve":
        return `局部调整分配；分支试验失败可用 prev_round（灵视+1）回退。${execHint}`;
      case "end_day_gate":
        return missing.length
          ? `建议补全: ${missing.join(", ")}；苏丹路线/换卡/末日销卡均为 advisory，不硬拦 next_day。${execHint}`
          : `当日流程完成；next_day 前宿主做日终分配检定（苏丹项为软提示）。${execHint}`;
      case "blocked":
        return "先处理引导或阻塞弹层（continue/execute/reset/exchange_sudan_card）；rite_result/苏丹折断对号变灰时仍用 continue 点空白，禁止 start_new_game；过天用 next_day。";
      case "recovery_rewind":
        return `宿主按 recovery plan 连续 prev_round 回到目标日 ${this.cp.recoveryTargetDay ?? "?"}（depth=${this.cp.recoveryDepth ?? "?"}）；禁止重走 failed path；途中可 continue 关浮层。`;
      case "terminal":
        return "失败终局由宿主按 recovery plan 连续 prev_round 回到目标决策日；禁止重走 failed path；无法回退则 start_new_game。胜利结局可总结后停止。";
      default:
        return "先 observe_scene 再行动。";
    }
  }
}

export function formatActionChainBrief(brief: ActionChainBrief): string {
  const lines = [
    "【当前行动链】流程建议；过天用显式 next_day（continue 只关浮层）。next_day 前宿主做日终分配检定。仍以实时 scene/affordances 为准。",
    `phase=${brief.phase} day=${brief.day ?? "?"} checklistReady=${brief.canAdvanceDay} (advisory)`,
    `done: ${brief.done.join(", ") || "none"}`,
    `missing: ${brief.missing.join(", ") || "none"}`,
    `allowedOps: ${brief.allowedOps.join(", ")}`,
    `next: ${brief.nextHint}`,
    `utilization: ${brief.utilization.assigned}/${brief.utilization.reusableAssignable} coverage=${brief.utilization.coverage.toFixed(2)}`,
    `executionTiming: left=${brief.executionTiming.executionDaysLeft ?? "?"} policy=${brief.executionTiming.policy} | ${brief.executionTiming.hint}`,
    `sudanRouteProbePending: ${brief.sudanRouteProbePending ?? 0}`,
  ];
  if (brief.recoveryActive) {
    lines.push(
      `recovery: targetDay=${brief.recoveryTargetDay ?? "?"} depth=${brief.recoveryDepth ?? "?"} failedPaths=${(brief.recoveryFailedPaths ?? []).length}` +
        (brief.recoveryHint ? ` | ${brief.recoveryHint}` : ""),
    );
  }
  if (brief.newsSummary) lines.push(`news: ${brief.newsSummary}`);
  if (brief.top3.length) {
    lines.push(
      `top3: ${brief.top3.map((t, i) => `${i + 1}.${t.title}`).join(" | ")}`,
    );
  }
  if (brief.mapChanges.length) {
    const ordered = prioritizeMapChanges(brief.mapChanges);
    const addedCount = ordered.filter((c) => c.startsWith("added:")).length;
    const head = ordered.slice(0, 8).join("; ");
    const more = ordered.length > 8 ? ` (+${ordered.length - 8} more)` : "";
    lines.push(
      `mapChanges: ${head}${more}` +
        (addedCount > 0
          ? ` | NEW map points=${addedCount} — prioritize open_rite on added: uids before old errands`
          : ""),
    );
  }
  if (brief.newCards.length) {
    lines.push(
      `newCards: ${brief.newCards
        .map((card) => `${card.uid}:${card.name ?? `cardId=${card.cardId ?? "?"}`}${card.tier ? `:${card.tier}` : ""}`)
        .join(", ")}`,
    );
  }
  if (brief.requiredInspections.length) {
    lines.push(
      `mustInspect: ${brief.requiredInspections
        .map((card) => `${card.uid}:${card.name ?? `cardId=${card.cardId ?? "?"}`}:${card.reason}`)
        .join(", ")}（必须真实 inspect_card 并取得可靠 cardSummary；report 自报无效）`,
    );
  }
  if (brief.utilization.idle.length) {
    lines.push(
      `idle: ${brief.utilization.idle
        .map((i) => `${i.cardUid}:${i.reason}`)
        .join(", ")}`,
    );
  }
  lines.push(
    "完成阶段后调用 report_action_chain；next_day 前宿主做日终分配检定（硬问题拦截，软改进可 dayCloseReviewOverride）。",
  );
  return lines.join("\n");
}
