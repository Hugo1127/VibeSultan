import type { AppConfig } from "../config.js";
import type { GameOps } from "./GameOps.js";
import type {
  ActionResult,
  AgentDecision,
  AgentLlmStats,
  GameAction,
  GameState,
  HealthResponse,
  SceneSnapshot,
} from "./types.js";

export class HttpGameOps implements GameOps {
  constructor(private readonly cfg: AppConfig) {}

  async health(): Promise<HealthResponse> {
    return this.getJson<HealthResponse>("/health");
  }

  async getState(views?: string[]): Promise<GameState> {
    const qs =
      views && views.length > 0
        ? `?views=${encodeURIComponent(views.join(","))}`
        : "";
    return this.getJson<GameState>(`/state${qs}`);
  }

  async observeScene(): Promise<SceneSnapshot> {
    return this.getJson<SceneSnapshot>("/scene");
  }

  async submitActions(actions: GameAction[]): Promise<ActionResult[]> {
    if (this.cfg.gameDryRun) {
      console.log("[GameOps:dry-run] submitActions", JSON.stringify(actions, null, 2));
      return actions.map((a, i) => ({
        id: a.id ?? `dry-${i}`,
        op: a.op,
        ok: true,
        detail: "dry_run",
      }));
    }

    const body = await this.postJson<{ ok?: boolean; results?: ActionResult[]; error?: string }>(
      "/actions",
      { actions },
    );
    if (!body.results) {
      return [{ ok: false, error: body.error ?? "no_results" }];
    }
    return body.results;
  }

  async publishDecision(
    decision: AgentDecision,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.cfg.gameDryRun) {
      console.log("[GameOps:dry-run] publishDecision", JSON.stringify(decision, null, 2));
      return { ok: true };
    }
    return this.postJson<{ ok: boolean; error?: string }>("/agent/decision", decision);
  }

  async publishLlmStats(
    stats: AgentLlmStats,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.cfg.gameDryRun) {
      console.log("[GameOps:dry-run] publishLlmStats", JSON.stringify(stats, null, 2));
      return { ok: true };
    }
    return this.postJson<{ ok: boolean; error?: string }>("/agent/llm_stats", stats);
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetch(path, { method: "GET" });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} -> ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, payload: unknown): Promise<T> {
    const res = await this.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new Error(`POST ${path} -> ${res.status}: non-json ${text}`);
    }
    if (!res.ok) {
      throw new Error(`POST ${path} -> ${res.status}: ${text}`);
    }
    return parsed;
  }

  private fetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.cfg.gameBaseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set("User-Agent", this.cfg.httpUserAgent);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.gameTimeoutMs);
    return fetch(url, { ...init, headers, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
  }
}
