/** Sultan game actions (intents + parameterized domain ops). */
export type GameActionOp =
  | "noop"
  | "continue"
  | "execute"
  | "cancel"
  | "reset"
  | "start_new_game"
  | "continue_game"
  | "select_difficulty"
  | "select_event_option"
  | "draw_sudan_card"
  | "open_sudan_box"
  | "close_sudan_box"
  | "exchange_sudan_card"
  | "click_element"
  | "select_card"
  | "inspect_card"
  | "think_card"
  | "open_daily_news"
  | "select_gold_dice"
  | "confirm_gold_dice"
  | "cancel_gold_dice"
  | "open_rite"
  | "place_card_on_rite"
  | "equip_item"
  | "unequip_item"
  | "probe_types"
  // Legacy aliases still accepted by the plugin (mapped to intents).
  | "cancel_card_placement"
  | "start_rite"
  | "clear_rite_submission"
  | "close_rite"
  | "next_day"
  | "next_round"
  | "prev_round";

export interface GameAction {
  id?: string;
  op: GameActionOp | string;
  /** Preferred for select_event_option */
  optionIndex?: number;
  optionId?: string | number;
  /** Preferred for select_card / place_card_on_rite */
  uid?: string | number;
  cardId?: string | number;
  /** Preferred for rite slot ops / reset */
  slotIndex?: number;
  slotId?: string | number;
  slot?: string | number;
  card?: string | number;
  /** Stackable item place amount (金币 CardSplit); prefer slot costMin. */
  count?: number;
  /** Preferred for equip_item / unequip_item */
  characterUid?: string | number;
  charUid?: string | number;
  itemUid?: string | number;
  slotType?: string;
  riteId?: string | number;
  index?: number;
  initId?: number;
  round?: number;
  elementId?: string;
  targetId?: string;
  snapshotVersion?: number;
  [key: string]: unknown;
}

export interface ActionResult {
  id?: string | null;
  op?: string | null;
  ok: boolean;
  error?: string | null;
  detail?: string | null;
  result?: "success" | "no_effect" | "failed" | "accepted" | string | null;
  sceneBeforeVersion?: number | null;
  sceneAfterVersion?: number | null;
  screenChanged?: boolean | null;
  changes?: Record<string, unknown> | null;
  /** Structured cards/rites/resources/counters delta from Observer StateDiffer. */
  stateDelta?: Record<string, unknown> | null;
  forceReobserve?: boolean | null;
}

export type {
  StrategySnapshot,
  EventConfiguration,
  DayPlan,
  Prediction,
  ExperienceRecord,
  StateDelta,
  StrategyEngineOutput,
  StrategyVersionKey,
  ExperienceStatus,
} from "./strategyTypes.js";

export interface SceneDescriptor {
  id?: string | null;
  name?: string | null;
  phase?: string | null;
  modal?: string | null;
  blocking?: boolean;
}

export interface SceneInstruction {
  source?: string | null;
  type?: string | null;
  text?: string | null;
  hint?: string | null;
  preferredOp?: string | null;
}

export interface UiElementInfo {
  elementId: string;
  parentId?: string | null;
  role?: string | null;
  name?: string | null;
  text?: string | null;
  path?: string | null;
  overlayId?: string | null;
  visible?: boolean;
  interactable?: boolean;
  selected?: boolean;
  blocked?: boolean;
  bounds?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  preferredOp?: string | null;
  actionParams?: Record<string, unknown> | null;
  instanceId?: number | null;
}

export interface UiAffordanceInfo {
  action?: string | null;
  targetId?: string | null;
  label?: string | null;
  enabled?: boolean;
  reason?: string | null;
  mapsToOp?: string | null;
  parameters?: Record<string, unknown> | null;
}

export interface SceneSnapshot {
  schemaVersion?: number;
  snapshotVersion: number;
  capturedAt?: string;
  scene?: SceneDescriptor;
  instruction?: SceneInstruction | null;
  elements?: UiElementInfo[];
  affordances?: UiAffordanceInfo[];
  telemetry?: Record<string, unknown>;
  truncated?: boolean;
  diagnostics?: Record<string, unknown>;
}

export interface CardDto {
  uid?: number;
  id?: number;
  bag?: number;
  bagpos?: number;
  life?: number;
  count?: number;
  rare?: number;
  type?: string;
  customName?: string;
  [key: string]: unknown;
}

export interface EquippedItemDto {
  uid?: number;
  id?: number;
  name?: string;
  title?: string;
  type?: string;
  rare?: number;
  slotType?: string;
  /** Catalog text / tip for what the item does. */
  text?: string;
  /** Catalog + runtime tags (attrs like 魅力 kept even when runtime tags are sparse). */
  tags?: Record<string, number>;
  /** Combat/social attr subset from tags (智慧/社交/魅力/体魄/战斗/隐匿/魔力). */
  attrBonus?: Record<string, number>;
  [key: string]: unknown;
}

export interface CardSummaryDto {
  cardId?: number;
  cardUid?: number;
  name?: string;
  title?: string;
  type?: string;
  rare?: number;
  tier?: string;
  text?: string;
  life?: number;
  count?: number;
  tags?: Record<string, number>;
  /** Character equippable slot types (武器/服装/饰品...). */
  equipSlotTypes?: string[];
  /** Runtime equipped items on this character (authority for wear relations). */
  equipped?: EquippedItemDto[];
  equippedCount?: number;
  /** Sum of equipped[].attrBonus (e.g. { 魅力: 1 }). */
  equipBonus?: Record<string, number>;
  [key: string]: unknown;
}

export interface RiteDto {
  uid?: number;
  id?: number;
  start?: boolean;
  life?: number;
  slotsFilled?: number;
  canConfirm?: boolean;
  isCurrent?: boolean;
  slots?: Array<{
    index?: number;
    slotKey?: string;
    text?: string | null;
    conditionType?: string | null;
    condition?: string | null;
    isKey?: number | boolean;
    isEmpty?: boolean;
    isEnemy?: boolean;
    occupied?: boolean;
    cardUid?: number | null;
    cardId?: number | null;
    cardName?: string | null;
    cardSummary?: CardSummaryDto;
    acceptsOp?: string;
  }>;
  [key: string]: unknown;
}

export interface CurrentRiteDto {
  uid?: number;
  id?: number;
  name?: string;
  canConfirm?: boolean;
  slotCount?: number;
  slots?: RiteDto["slots"];
  hint?: string;
  [key: string]: unknown;
}

export interface EventOptionDto {
  index?: number;
  selected?: boolean;
  label?: string;
  tag?: string;
  [key: string]: unknown;
}

export interface ChoiceEventDto {
  kind?: "choice";
  prompt?: string | null;
  identitySeed?: string | null;
  identityQuality?: "stable" | "derived";
  options?: EventOptionDto[];
  [key: string]: unknown;
}

export interface GameStateValues extends Record<string, unknown> {
  day?: number;
  turn?: number;
  resources?: Record<string, unknown>;
  counters?: Record<string, unknown>;
  sudan?: Record<string, unknown>;
  questSummary?: Record<string, unknown>;
  quests?: unknown[];
  handCount?: number | null;
  riteCount?: number | null;
  eventOptionCount?: number | null;
  fingerprint?: string | null;
  initDone?: boolean;
  inGame?: boolean;
  hasGameController?: boolean;
  cards?: CardDto[];
  rites?: RiteDto[];
  /** Open rite panel snapshot (also present in compact /state). */
  currentRite?: CurrentRiteDto | null;
  /** Open story/perk choice with a deterministic content identity seed. */
  currentEvent?: ChoiceEventDto | null;
  events?: EventOptionDto[];
  overlays?: Array<{
    id?: string;
    kind?: string;
    blocking?: boolean;
    dismissOp?: string;
    text?: string | null;
  }>;
  blockingOverlay?: boolean;
  /** BeginGuide finger-tutorial snapshot */
  guide?: {
    active?: boolean;
    type?: string | null;
    text?: string | null;
    textKey?: string | null;
    hint?: string | null;
    preferredOp?: string | null;
  };
  /** Daily news / StoryNotify snapshot */
  dailyNews?: {
    present?: boolean;
    open?: boolean;
    entryAvailable?: boolean;
    title?: string | null;
    summary?: string | null;
    viewed?: boolean;
    badge?: string | null;
    checkRequired?: boolean;
    [key: string]: unknown;
  };
  /** Short agent-facing hint for the current UI step */
  stepHint?: string | null;
  terminal?: boolean;
}

export interface GameState {
  schemaVersion?: number;
  game?: string;
  capturedAt?: string;
  screen?: {
    id?: string;
    name?: string;
    phase?: string;
  };
  terminal?: boolean;
  view?: string;
  values?: GameStateValues;
  actions?: Array<{
    id?: string;
    label?: string;
    enabled?: boolean;
    reason?: string;
    paramsHint?: Record<string, unknown>;
  }>;
  cards?: CardDto[] | unknown;
  rites?: RiteDto[] | unknown;
  events?: EventOptionDto[] | unknown;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HealthResponse {
  ok: boolean;
  plugin?: string;
  game?: string;
  actions?: boolean;
  decisionHud?: boolean;
  fingerprint?: string;
  pluginVersion?: string;
  versionSafe?: boolean;
  /** False when the plugin was built against compile stubs (no game bindings). */
  hasInterop?: boolean;
}

export interface AgentDecision {
  step?: number;
  title: string;
  goal?: string;
  actions?: string[];
  why?: string;
  /** Truncated model reasoning for the in-game HUD (≈100 chars). */
  thinking?: string;
  mood?: "explore" | "exploit" | "wait" | "risk" | "abandon" | string;
  at?: string;
}

export interface AgentLlmStats {
  step?: number;
  totalTokens?: number;
  prefillTokens?: number;
  decodeTokens?: number;
  prefillTokPerSec?: number | null;
  decodeTokPerSec?: number | null;
  elapsedMs?: number;
  firstTokenMs?: number | null;
  at?: string;
}
