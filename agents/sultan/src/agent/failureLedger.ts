export type FailureEntry = {
  op: string;
  error: string;
  detail?: string | null;
  fingerprint: string;
  stateKey: string;
  exchangeContextKey?: string;
  step: number;
};

const PARAM_KEYS = [
  "optionIndex",
  "optionId",
  "cardId",
  "uid",
  "slotIndex",
  "slotId",
  "slot",
  "card",
  "riteId",
  "index",
  "initId",
  "round",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function fingerprintAction(action: Record<string, unknown>): string {
  const op = typeof action.op === "string" ? action.op : "?";
  const parts: string[] = [op];
  for (const key of PARAM_KEYS) {
    if (action[key] === undefined || action[key] === null) continue;
    parts.push(`${key}=${JSON.stringify(action[key])}`);
  }
  return parts.join("|");
}

export function stateKeyFromGameState(state: unknown): string {
  if (!isRecord(state)) return "unknown";
  const values = isRecord(state.values) ? state.values : state;
  const day = values.day ?? values.turn ?? "?";
  const screen = isRecord(state.screen) ? state.screen.id : "?";
  const hand = values.handCount ?? "?";
  const sudan = isRecord(values.sudan) ? JSON.stringify(values.sudan) : String(values.sudan ?? "?");
  return `day=${day}|screen=${screen}|hand=${hand}|sudan=${sudan.slice(0, 40)}`;
}

export function exchangeContextKeyFromGameState(state: unknown): string {
  if (!isRecord(state)) return "day=?|sudan=?";
  const values = isRecord(state.values) ? state.values : state;
  const day = values.day ?? values.turn ?? "?";
  const sudan = isRecord(values.sudan) ? values.sudan : {};
  const current = isRecord(sudan.currentCard) ? sudan.currentCard : null;
  const cards = Array.isArray(values.cards) ? values.cards.filter(isRecord) : [];
  const handSudan =
    cards.find((card) => {
      const type = String(card.type ?? "").toLowerCase();
      return (
        card.bag === 0 &&
        (type === "sudan" || type.includes("sudan") || String(card.name ?? "").includes("苏丹"))
      );
    }) ?? null;
  const card = current ?? handSudan;
  const identity = card
    ? `${card.id ?? card.cardId ?? "?"}|${card.uid ?? "?"}|${card.name ?? card.customName ?? "?"}`
    : "?";
  return `day=${day}|sudan=${identity}`;
}

export class ActionFailureLedger {
  private readonly entries: FailureEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 32) {
    this.maxEntries = maxEntries;
  }

  noteFailures(
    step: number,
    stateKey: string,
    results: Array<Record<string, unknown>>,
    submittedActions?: Array<Record<string, unknown>>,
    exchangeContextKey?: string,
  ): void {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const op = typeof r.op === "string" ? r.op : String(submittedActions?.[i]?.op ?? "?");
      if (r?.ok && op === "exchange_sudan_card" && exchangeContextKey) {
        for (let j = this.entries.length - 1; j >= 0; j--) {
          const entry = this.entries[j]!;
          if (entry.op === op && entry.exchangeContextKey === exchangeContextKey) {
            this.entries.splice(j, 1);
          }
        }
      }
      if (!r || r.ok) continue;
      const error = typeof r.error === "string" ? r.error : "unknown_error";
      const source =
        (isRecord(submittedActions?.[i]) ? submittedActions![i] : null) ??
        ({ op, ...r } as Record<string, unknown>);
      this.entries.push({
        op,
        error,
        detail: typeof r.detail === "string" ? r.detail : null,
        fingerprint: fingerprintAction({ ...source, op }),
        stateKey,
        exchangeContextKey,
        step,
      });
      if (this.entries.length > this.maxEntries) {
        this.entries.splice(0, this.entries.length - this.maxEntries);
      }
    }
  }

  matchingForState(stateKey: string): FailureEntry[] {
    return this.entries.filter((e) => e.stateKey === stateKey);
  }

  exchangeFailureCount(exchangeContextKey: string): number {
    const circuitErrors = new Set([
      "exchange_not_applied",
      "exchange_drop_failed",
      "exchange_dropper_not_entered",
      "exchange_card_unchanged",
    ]);
    return this.entries.filter(
      (entry) =>
        entry.op === "exchange_sudan_card" &&
        entry.exchangeContextKey === exchangeContextKey &&
        circuitErrors.has(entry.error),
    ).length;
  }

  isExchangeCircuitOpen(exchangeContextKey: string, threshold = 3): boolean {
    return this.exchangeFailureCount(exchangeContextKey) >= threshold;
  }

  toPromptFacts(stateKey?: string): string {
    const list = stateKey ? this.matchingForState(stateKey) : this.entries;
    if (list.length === 0) return "- actionFailureLedger: (empty)";
    const lines = list.slice(-12).map((e) => {
      const detail = e.detail ? ` detail=${e.detail}` : "";
      return `- fail step=${e.step} ${e.fingerprint} → ${e.error}${detail}`;
    });
    return ["- actionFailureLedger (facts only):", ...lines].join("\n");
  }
}

export function extractSubmittedActions(argsJson: string): Array<Record<string, unknown>> {
  try {
    const args = JSON.parse(argsJson || "{}") as { actions?: unknown };
    if (!Array.isArray(args.actions)) return [];
    return args.actions.filter(isRecord);
  } catch {
    return [];
  }
}
