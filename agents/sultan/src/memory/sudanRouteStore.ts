import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "@vibesultan/agent-learning-core";

export type SudanRouteStatus =
  | "compatible"
  | "ready"
  | "needs_support"
  | "incompatible"
  | "dominated"
  | "unknown";

/** Max pending sudan route probes kept after prune. */
export const MAX_PENDING_PROBES = 8;

export interface SudanRouteRecord {
  key: string;
  configFingerprint: string;
  sudanCardId: number;
  sudanCardName?: string | null;
  eventKey: string;
  eventName?: string | null;
  riteId?: number | null;
  riteUid?: number | null;
  slotIndex: number;
  slotKey?: string | null;
  status: SudanRouteStatus;
  firstSeenDay?: number | null;
  lastSeenDay?: number | null;
  eventLife?: number | null;
  unfilledSlots?: number[];
  estimatedPrepDays?: number | null;
  resourceCostHint?: string | null;
  knownOutcome?: "success" | "fail" | "unknown" | null;
  confidence: number;
  evidenceIds: string[];
  updatedAt: string;
}

export interface SudanRouteStoreFile {
  version: 1;
  routes: SudanRouteRecord[];
  /** Pending event/card keys waiting for probe (advisory). */
  pendingProbes: string[];
  lastSudanCardId?: number | null;
  lastSudanIdentity?: string | null;
}

export function sudanRouteKey(opts: {
  configFingerprint: string;
  sudanCardId: number;
  eventKey: string;
  slotIndex: number;
}): string {
  return `${opts.configFingerprint}|sudan:${opts.sudanCardId}|${opts.eventKey}|slot:${opts.slotIndex}`;
}

export class SudanRouteStore {
  readonly filePath: string;

  constructor(sessionDir: string) {
    fs.mkdirSync(sessionDir, { recursive: true });
    this.filePath = path.join(sessionDir, "sudan-routes.json");
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, {
        version: 1,
        routes: [],
        pendingProbes: [],
      } satisfies SudanRouteStoreFile);
    }
  }

  list(): SudanRouteRecord[] {
    return this.load().routes;
  }

  pendingProbes(): string[] {
    return this.load().pendingProbes;
  }

  get(key: string): SudanRouteRecord | undefined {
    return this.list().find((route) => route.key === key);
  }

  upsert(input: Omit<SudanRouteRecord, "updatedAt"> & { updatedAt?: string }): SudanRouteRecord {
    const file = this.load();
    const now = new Date().toISOString();
    const next: SudanRouteRecord = {
      ...input,
      evidenceIds: [...(input.evidenceIds ?? [])],
      updatedAt: input.updatedAt ?? now,
    };
    const idx = file.routes.findIndex((route) => route.key === next.key);
    if (idx >= 0) {
      const prev = file.routes[idx]!;
      file.routes[idx] = {
        ...prev,
        ...next,
        firstSeenDay: prev.firstSeenDay ?? next.firstSeenDay,
        evidenceIds: uniqueStrings([...(prev.evidenceIds ?? []), ...(next.evidenceIds ?? [])]),
        confidence: Math.max(prev.confidence ?? 0, next.confidence ?? 0),
        updatedAt: now,
      };
    } else {
      file.routes.push(next);
    }
    this.persist(file);
    return this.get(next.key)!;
  }

  markPendingProbe(probeKey: string): void {
    const file = this.load();
    if (!file.pendingProbes.includes(probeKey)) {
      file.pendingProbes.push(probeKey);
      this.persist(file);
    }
  }

  clearPendingProbe(probeKey: string): void {
    const file = this.load();
    const next = file.pendingProbes.filter((key) => key !== probeKey);
    if (next.length !== file.pendingProbes.length) {
      file.pendingProbes = next;
      this.persist(file);
    }
  }

  clearPendingProbes(): void {
    const file = this.load();
    if (file.pendingProbes.length === 0 && file.lastSudanIdentity == null) return;
    file.pendingProbes = [];
    file.lastSudanCardId = null;
    file.lastSudanIdentity = null;
    this.persist(file);
  }

  /**
   * Drop stale probes (gone map uids / other sudan cards) and cap queue length.
   * Keeps newest entries when over MAX_PENDING_PROBES.
   */
  prunePendingProbes(opts: {
    liveRiteUids?: Iterable<number | null | undefined>;
    currentSudanCardId?: number | null;
    maxPending?: number;
  }): { before: number; after: number; removed: string[] } {
    const file = this.load();
    const before = file.pendingProbes.length;
    const liveUids = new Set<number>();
    for (const uid of opts.liveRiteUids ?? []) {
      if (typeof uid === "number" && Number.isFinite(uid)) liveUids.add(uid);
    }
    const currentSudanId = opts.currentSudanCardId ?? null;
    const maxPending = Math.max(0, opts.maxPending ?? MAX_PENDING_PROBES);

    const kept: string[] = [];
    const removed: string[] = [];
    for (const probe of file.pendingProbes) {
      const sudanMatch = /^sudan:(\d+)$/.exec(probe);
      if (sudanMatch) {
        const id = Number(sudanMatch[1]);
        if (currentSudanId != null && id !== currentSudanId) {
          removed.push(probe);
          continue;
        }
        kept.push(probe);
        continue;
      }
      const eventMatch = /^event:added:(\d+):/.exec(probe);
      if (eventMatch) {
        const uid = Number(eventMatch[1]);
        if (liveUids.size > 0 && !liveUids.has(uid)) {
          removed.push(probe);
          continue;
        }
        kept.push(probe);
        continue;
      }
      kept.push(probe);
    }

    // Cap: keep newest (tail); drop oldest from head.
    let capped = kept;
    if (capped.length > maxPending) {
      const overflow = capped.slice(0, capped.length - maxPending);
      removed.push(...overflow);
      capped = capped.slice(capped.length - maxPending);
    }

    if (removed.length > 0 || capped.length !== file.pendingProbes.length) {
      file.pendingProbes = capped;
      this.persist(file);
    }
    return { before, after: capped.length, removed };
  }

  setLastSudanIdentity(cardId: number | null, identity: string | null): void {
    const file = this.load();
    file.lastSudanCardId = cardId;
    file.lastSudanIdentity = identity;
    this.persist(file);
  }

  lastSudanIdentity(): { cardId: number | null; identity: string | null } {
    const file = this.load();
    return {
      cardId: file.lastSudanCardId ?? null,
      identity: file.lastSudanIdentity ?? null,
    };
  }

  summarize(opts?: { sudanCardId?: number | null }): {
    total: number;
    compatible: number;
    ready: number;
    needsSupport: number;
    incompatible: number;
    verifiedBreak: number;
    pendingProbes: number;
    bestReady: SudanRouteRecord | null;
    shortestPrepDays: number | null;
  } {
    const routes = this.list().filter((route) =>
      opts?.sudanCardId == null ? true : route.sudanCardId === opts.sudanCardId,
    );
    const ready = routes.filter((route) => route.status === "ready");
    const needsSupport = routes.filter((route) => route.status === "needs_support");
    const incompatible = routes.filter((route) => route.status === "incompatible");
    const compatible = routes.filter(
      (route) =>
        route.status === "compatible" ||
        route.status === "ready" ||
        route.status === "needs_support",
    );
    // Verified break: place affordance accepted for current sudan (ready or needs_support).
    const verifiedBreak = ready.length + needsSupport.length;
    const bestReady =
      [...ready, ...needsSupport].sort((a, b) => {
        const rank = (s: string) => (s === "ready" ? 0 : 1);
        const rankDiff = rank(a.status) - rank(b.status);
        if (rankDiff !== 0) return rankDiff;
        const lifeA = a.eventLife ?? 99;
        const lifeB = b.eventLife ?? 99;
        if (lifeA !== lifeB) return lifeA - lifeB;
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      })[0] ?? null;
    const prepValues = routes
      .filter((route) => route.status !== "incompatible")
      .map((route) => route.estimatedPrepDays)
      .filter((value): value is number => typeof value === "number");
    return {
      total: routes.length,
      compatible: compatible.length,
      ready: ready.length,
      needsSupport: needsSupport.length,
      incompatible: incompatible.length,
      verifiedBreak,
      pendingProbes: this.pendingProbes().length,
      bestReady,
      shortestPrepDays: prepValues.length ? Math.min(...prepValues) : null,
    };
  }

  private load(): SudanRouteStoreFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SudanRouteStoreFile;
      return {
        version: 1,
        routes: Array.isArray(raw.routes) ? raw.routes : [],
        pendingProbes: Array.isArray(raw.pendingProbes) ? raw.pendingProbes : [],
        lastSudanCardId: raw.lastSudanCardId ?? null,
        lastSudanIdentity: raw.lastSudanIdentity ?? null,
      };
    } catch {
      return { version: 1, routes: [], pendingProbes: [] };
    }
  }

  private persist(file: SudanRouteStoreFile): void {
    atomicWriteJson(this.filePath, file);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
