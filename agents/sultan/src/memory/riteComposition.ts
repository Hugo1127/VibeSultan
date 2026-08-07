import type { EpisodeAssignment } from "./episodeStore.js";

export type SlotCode =
  | `B:${number}`
  | `P:${number}`
  | `P:${number}@${number}`
  | "E"
  | "X";

export type CompositionSlot = {
  slotKey: string;
  slotIndex: number;
  code: SlotCode;
};

/**
 * Canonical composition body used for explore/backtrack dedupe.
 * Format: s1:P:2001,s2:E,s3:B:2010003
 */
export function formatCompositionBody(slots: CompositionSlot[]): string {
  return [...slots]
    .sort((a, b) => compareSlotKey(a.slotKey, b.slotKey) || a.slotIndex - b.slotIndex)
    .map((slot) => `${slot.slotKey}:${slot.code}`)
    .join(",");
}

export function canonicalCompositionSignature(opts: {
  configFingerprint: string;
  riteId: number;
  slots: CompositionSlot[];
}): string {
  const body = formatCompositionBody(opts.slots);
  return `${opts.configFingerprint}:rite:${opts.riteId}:${body}`;
}

export function compositionSlotsFromAssignments(
  assignments: EpisodeAssignment[],
): CompositionSlot[] {
  return assignments.map((assignment) => {
    const slotKey = String(assignment.slotKey ?? `s${assignment.slotIndex}`);
    if (assignment.empty || assignment.cardId == null || assignment.cardId === 0) {
      return {
        slotKey,
        slotIndex: assignment.slotIndex,
        code: "E" as const,
      };
    }
    const count =
      typeof assignment.count === "number" &&
      Number.isFinite(assignment.count) &&
      assignment.count > 1
        ? Math.floor(assignment.count)
        : null;
    const code: SlotCode =
      count != null ? `P:${assignment.cardId}@${count}` : `P:${assignment.cardId}`;
    return { slotKey, slotIndex: assignment.slotIndex, code };
  });
}

export function signatureFromAssignments(opts: {
  configFingerprint: string;
  riteId: number;
  assignments: EpisodeAssignment[];
}): string {
  return canonicalCompositionSignature({
    configFingerprint: opts.configFingerprint,
    riteId: opts.riteId,
    slots: compositionSlotsFromAssignments(opts.assignments),
  });
}

/** Parse legacy `composition=s5:2000001,s7:empty` fragments into slots. */
export function parseLegacyCompositionFragment(raw: string): CompositionSlot[] {
  const match = raw.match(/composition=([^|]+)/i) ?? raw.match(/input=([^|]+)/i);
  const body = (match?.[1] ?? raw).trim();
  if (!body || body === "empty") return [];
  return body
    .split(",")
    .map((part, index) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const [slotRaw, valueRaw] = part.split(":");
      const slotKey = (slotRaw ?? `s${index}`).trim() || `s${index}`;
      const value = (valueRaw ?? "").trim();
      if (!value || value === "empty") {
        return { slotKey, slotIndex: index, code: "E" as const };
      }
      const countMatch = value.match(/^(\d+)@(\d+)$/);
      if (countMatch) {
        const cardId = Number(countMatch[1]);
        const count = Number(countMatch[2]);
        return {
          slotKey,
          slotIndex: index,
          code: `P:${cardId}@${count}` as SlotCode,
        };
      }
      const cardId = Number(value);
      if (!Number.isFinite(cardId)) {
        return { slotKey, slotIndex: index, code: "X" as const };
      }
      return { slotKey, slotIndex: index, code: `P:${cardId}` as SlotCode };
    });
}

export function baselineSignaturesFromRoutes(opts: {
  configFingerprint: string;
  riteId: number;
  routes: string[];
}): string[] {
  const out = new Set<string>();
  for (const route of opts.routes) {
    const slots = parseLegacyCompositionFragment(route);
    if (!slots.length) continue;
    out.add(
      canonicalCompositionSignature({
        configFingerprint: opts.configFingerprint,
        riteId: opts.riteId,
        slots,
      }),
    );
  }
  return [...out];
}

export function bodyFromSignature(signature: string): string {
  const parts = signature.split(":rite:");
  if (parts.length < 2) return signature;
  const rest = parts.slice(1).join(":rite:");
  const idx = rest.indexOf(":");
  return idx >= 0 ? rest.slice(idx + 1) : rest;
}

/** Day-independent path key for failed-path blacklist (no day/UID). */
export function buildPathSignature(opts: {
  sudanIdentity?: string | null;
  routeLabel?: string | null;
  compositionSignature?: string | null;
  prepSignature?: string | null;
}): string {
  const parts = [
    opts.sudanIdentity?.trim() || "sudan:?",
    opts.routeLabel ? `route:${opts.routeLabel}` : null,
    opts.compositionSignature
      ? `comp:${bodyFromSignature(opts.compositionSignature)}`
      : null,
    opts.prepSignature ? `prep:${opts.prepSignature}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join("|");
}

function compareSlotKey(a: string, b: string): number {
  const na = Number(String(a).replace(/^s/i, ""));
  const nb = Number(String(b).replace(/^s/i, ""));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}
