import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "@vibesultan/agent-learning-core";

export type SudanBranchStatus = "active" | "committed" | "rewound" | "dominated";

export interface SudanBranchPendingEvidence {
  experienceIds: string[];
  episodeIds: string[];
  entityKeys: string[];
  notes: string[];
}

export interface SudanBranchRecord {
  branchId: string;
  status: SudanBranchStatus;
  anchorDay: number | null;
  anchorSignature: string;
  actionSignature: string;
  sudanCardId?: number | null;
  sudanIdentity?: string | null;
  mapSignature?: string | null;
  baseline: {
    resources?: Record<string, number | null>;
    counters?: Record<string, number | null>;
    insight?: number | null;
    redrawTimes?: number | null;
    redrawRemaining?: number | null;
  };
  actions: string[];
  experienceIds: string[];
  episodeIds: string[];
  pendingEvidence: SudanBranchPendingEvidence;
  breakResult?: "success" | "fail" | "unknown" | null;
  exchangeResult?: "success" | "fail" | "unknown" | null;
  utility?: number | null;
  insightDelta?: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface SudanBranchStoreFile {
  version: 1;
  branches: SudanBranchRecord[];
  activeBranchId?: string | null;
}

export function branchActionSignature(actions: string[]): string {
  return actions.map((action) => action.trim()).filter(Boolean).join(">");
}

export class SudanBranchStore {
  readonly filePath: string;

  constructor(sessionDir: string) {
    fs.mkdirSync(sessionDir, { recursive: true });
    this.filePath = path.join(sessionDir, "sudan-branches.json");
    if (!fs.existsSync(this.filePath)) {
      atomicWriteJson(this.filePath, {
        version: 1,
        branches: [],
        activeBranchId: null,
      } satisfies SudanBranchStoreFile);
    }
  }

  list(): SudanBranchRecord[] {
    return this.load().branches;
  }

  active(): SudanBranchRecord | null {
    const file = this.load();
    if (!file.activeBranchId) return null;
    return file.branches.find((branch) => branch.branchId === file.activeBranchId) ?? null;
  }

  get(branchId: string): SudanBranchRecord | undefined {
    return this.list().find((branch) => branch.branchId === branchId);
  }

  hasTried(anchorSignature: string, actionSignature: string): boolean {
    return this.list().some(
      (branch) =>
        branch.anchorSignature === anchorSignature &&
        branch.actionSignature === actionSignature &&
        branch.status !== "dominated",
    );
  }

  startTrial(input: {
    anchorDay: number | null;
    anchorSignature: string;
    actionSignature: string;
    actions: string[];
    sudanCardId?: number | null;
    sudanIdentity?: string | null;
    mapSignature?: string | null;
    baseline: SudanBranchRecord["baseline"];
  }): SudanBranchRecord | null {
    if (this.hasTried(input.anchorSignature, input.actionSignature)) {
      return null;
    }
    const file = this.load();
    const now = new Date().toISOString();
    const branch: SudanBranchRecord = {
      branchId: `branch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      status: "active",
      anchorDay: input.anchorDay,
      anchorSignature: input.anchorSignature,
      actionSignature: input.actionSignature,
      sudanCardId: input.sudanCardId ?? null,
      sudanIdentity: input.sudanIdentity ?? null,
      mapSignature: input.mapSignature ?? null,
      baseline: input.baseline,
      actions: [...input.actions],
      experienceIds: [],
      episodeIds: [],
      pendingEvidence: { experienceIds: [], episodeIds: [], entityKeys: [], notes: [] },
      createdAt: now,
      updatedAt: now,
    };
    file.branches.push(branch);
    file.activeBranchId = branch.branchId;
    // Keep at most 5 non-dominated candidates per anchor.
    const sameAnchor = file.branches.filter(
      (item) => item.anchorSignature === input.anchorSignature && item.status !== "dominated",
    );
    if (sameAnchor.length > 5) {
      const overflow = sameAnchor
        .filter((item) => item.branchId !== branch.branchId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, sameAnchor.length - 5);
      for (const item of overflow) {
        item.status = "dominated";
        item.updatedAt = now;
      }
    }
    this.persist(file);
    return branch;
  }

  appendPendingEvidence(
    branchId: string,
    patch: Partial<SudanBranchPendingEvidence>,
  ): SudanBranchRecord | null {
    const file = this.load();
    const branch = file.branches.find((item) => item.branchId === branchId);
    if (!branch || branch.status !== "active") return null;
    branch.pendingEvidence = {
      experienceIds: unique([
        ...branch.pendingEvidence.experienceIds,
        ...(patch.experienceIds ?? []),
      ]),
      episodeIds: unique([
        ...branch.pendingEvidence.episodeIds,
        ...(patch.episodeIds ?? []),
      ]),
      entityKeys: unique([
        ...branch.pendingEvidence.entityKeys,
        ...(patch.entityKeys ?? []),
      ]),
      notes: unique([...branch.pendingEvidence.notes, ...(patch.notes ?? [])]),
    };
    branch.updatedAt = new Date().toISOString();
    this.persist(file);
    return branch;
  }

  commit(branchId: string, patch?: Partial<SudanBranchRecord>): SudanBranchRecord | null {
    return this.close(branchId, "committed", patch);
  }

  markRewound(
    branchId: string,
    insightDelta: number | null,
    patch?: Partial<SudanBranchRecord>,
  ): SudanBranchRecord | null {
    return this.close(branchId, "rewound", {
      ...patch,
      insightDelta,
    });
  }

  markDominated(branchId: string): SudanBranchRecord | null {
    return this.close(branchId, "dominated");
  }

  clearActive(): void {
    const file = this.load();
    file.activeBranchId = null;
    this.persist(file);
  }

  private close(
    branchId: string,
    status: Exclude<SudanBranchStatus, "active">,
    patch?: Partial<SudanBranchRecord>,
  ): SudanBranchRecord | null {
    const file = this.load();
    const branch = file.branches.find((item) => item.branchId === branchId);
    if (!branch) return null;
    const now = new Date().toISOString();
    Object.assign(branch, patch ?? {});
    branch.status = status;
    branch.updatedAt = now;
    branch.closedAt = now;
    if (status === "committed") {
      branch.experienceIds = unique([
        ...branch.experienceIds,
        ...branch.pendingEvidence.experienceIds,
      ]);
      branch.episodeIds = unique([
        ...branch.episodeIds,
        ...branch.pendingEvidence.episodeIds,
      ]);
    }
    if (file.activeBranchId === branchId) {
      file.activeBranchId = null;
    }
    this.persist(file);
    return branch;
  }

  private load(): SudanBranchStoreFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SudanBranchStoreFile;
      return {
        version: 1,
        branches: Array.isArray(raw.branches) ? raw.branches : [],
        activeBranchId: raw.activeBranchId ?? null,
      };
    } catch {
      return { version: 1, branches: [], activeBranchId: null };
    }
  }

  private persist(file: SudanBranchStoreFile): void {
    atomicWriteJson(this.filePath, file);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
