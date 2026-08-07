import type {
  ActionResult,
  AgentDecision,
  AgentLlmStats,
  GameAction,
  GameState,
  HealthResponse,
  SceneSnapshot,
} from "./types.js";

/**
 * Abstraction over Sultan Observer HTTP (or mocks).
 * Agent code must depend on this interface only.
 */
export interface GameOps {
  health(): Promise<HealthResponse>;
  /** Compact by default. Pass views e.g. ["cards"], ["rites","events"], or ["full"]. */
  getState(views?: string[]): Promise<GameState>;
  /** Semantic UI observation from the BepInEx plugin. */
  observeScene(): Promise<SceneSnapshot>;
  submitActions(actions: GameAction[]): Promise<ActionResult[]>;
  publishDecision(decision: AgentDecision): Promise<{ ok: boolean; error?: string }>;
  publishLlmStats(stats: AgentLlmStats): Promise<{ ok: boolean; error?: string }>;
}
