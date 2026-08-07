import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  type KnowledgeOutcome,
  type KnowledgeVersionKey,
} from "@vibesultan/agent-learning-core";
import type { EpisodeStateSnapshot, OutcomeSignal } from "./episodeOutcome.js";

export type EpisodePhase =
  | "placement"
  | "submitted"
  | "awaiting_result"
  | "awaiting_day_verify"
  | "pending_strategic"
  | "settled"
  | "abandoned"
  | "rewound";

export interface EpisodeAssignment {
  cardId: number | null;
  cardUid?: number | null;
  slotIndex: number;
  slotKey?: string | null;
  interactionKey: string;
  experienceId?: string;
  /** True when a player-intervenable slot was left empty. */
  empty?: boolean;
  /** Stackable place amount (金币); omit or 1 means single unit. */
  count?: number | null;
}

export interface StrategicTargets {
  cardIds?: number[];
  namePatterns?: string[];
}

export interface PendingEpisode {
  id: string;
  kind: "rite" | "choice";
  phase: EpisodePhase;
  version: KnowledgeVersionKey;
  eventKey: string;
  riteId: number;
  riteUid?: number | null;
  day?: number | null;
  composition: EpisodeAssignment[];
  inputSummary?: string;
  baseline?: EpisodeStateSnapshot;
  immediateSignals?: OutcomeSignal[];
  executeExperienceId?: string;
  settlementExperienceIds: string[];
  runId?: string;
  openedStep?: number;
  updatedStep?: number;
  outcome?: KnowledgeOutcome;
  settlement?: Record<string, unknown>;
  /** Scrub / mismatch flag: do not trust settlement for entity learning. */
  quarantined?: boolean;
  /** Sudan trial branch id; rewound branches must not update canonical entity knowledge. */
  branchId?: string | null;
  /** Altruistic choice: wait for target follower card before positive settlement. */
  strategicTargets?: StrategicTargets;
  /** Max days to wait for strategic payoff (default 30). */
  horizonDays?: number;
  applied: boolean;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
}

export interface EpisodeStoreFile {
  version: 1;
  episodes: PendingEpisode[];
}

export class EpisodeStore {
  readonly filePath: string;

  constructor(sessionDir: string) {
    fs.mkdirSync(sessionDir, { recursive: true });
    this.filePath = path.join(sessionDir, "pending-episodes.json");
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, { version: 1, episodes: [] } satisfies EpisodeStoreFile);
    }
  }

  list(): PendingEpisode[] {
    return this.load().episodes;
  }

  listOpen(): PendingEpisode[] {
    return this.list().filter(
      (episode) =>
        episode.phase !== "settled" &&
        episode.phase !== "abandoned" &&
        episode.phase !== "rewound",
    );
  }

  quarantineBranch(branchId: string): PendingEpisode[] {
    const file = this.load();
    const now = new Date().toISOString();
    const touched: PendingEpisode[] = [];
    for (const episode of file.episodes) {
      if (episode.branchId !== branchId) continue;
      episode.quarantined = true;
      episode.phase = "rewound";
      episode.applied = false;
      episode.updatedAt = now;
      touched.push(episode);
    }
    if (touched.length) this.persist(file);
    return touched;
  }

  /** Mark all open episodes abandoned so a new run cannot settle them. */
  abandonOpenEpisodes(_reason = "new_game_reset"): PendingEpisode[] {
    const file = this.load();
    const now = new Date().toISOString();
    const touched: PendingEpisode[] = [];
    for (const episode of file.episodes) {
      if (
        episode.phase === "settled" ||
        episode.phase === "abandoned" ||
        episode.phase === "rewound"
      ) {
        continue;
      }
      episode.phase = "abandoned";
      episode.applied = false;
      episode.updatedAt = now;
      touched.push(episode);
    }
    if (touched.length) this.persist(file);
    return touched;
  }

  get(id: string): PendingEpisode | undefined {
    return this.list().find((episode) => episode.id === id);
  }

  findOpen(eventKey: string, runId?: string): PendingEpisode | undefined {
    return this.listOpen()
      .filter(
        (episode) =>
          episode.eventKey === eventKey &&
          (!runId || !episode.runId || episode.runId === runId),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  create(input: Omit<PendingEpisode, "id" | "createdAt" | "updatedAt">): PendingEpisode {
    const now = new Date().toISOString();
    const episode: PendingEpisode = {
      ...input,
      id: `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
    };
    const file = this.load();
    file.episodes.push(episode);
    this.persist(file);
    return episode;
  }

  update(
    id: string,
    patch: Partial<Omit<PendingEpisode, "id" | "createdAt">>,
  ): PendingEpisode | undefined {
    const file = this.load();
    const index = file.episodes.findIndex((episode) => episode.id === id);
    if (index < 0) return undefined;
    const updated: PendingEpisode = {
      ...file.episodes[index]!,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    };
    file.episodes[index] = updated;
    this.persist(file);
    return updated;
  }

  compact(keepSettled = 100): void {
    const file = this.load();
    const open = file.episodes.filter(
      (episode) =>
        episode.phase !== "settled" &&
        episode.phase !== "abandoned" &&
        episode.phase !== "rewound",
    );
    const closed = file.episodes
      .filter(
        (episode) =>
          episode.phase === "settled" ||
          episode.phase === "abandoned" ||
          episode.phase === "rewound",
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, keepSettled);
    file.episodes = [...open, ...closed];
    this.persist(file);
  }

  private load(): EpisodeStoreFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<EpisodeStoreFile>;
      return {
        version: 1,
        episodes: Array.isArray(raw.episodes) ? raw.episodes : [],
      };
    } catch {
      return { version: 1, episodes: [] };
    }
  }

  private persist(file: EpisodeStoreFile): void {
    atomicWriteJson(this.filePath, file);
  }
}
