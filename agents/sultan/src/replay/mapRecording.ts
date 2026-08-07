import type { GameAction } from "../game/types.js";
import {
  emptyDecision,
  type RecordedCall,
  type RecordingDocument,
  type ReplayDocument,
  type ReplayStep,
} from "./types.js";

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function dataOf(event: RecordedCall): Record<string, unknown> {
  return event.data && typeof event.data === "object" ? event.data : {};
}

function actionKey(action: GameAction): string {
  return JSON.stringify({
    op: action.op,
    uid: action.uid ?? null,
    cardId: action.cardId ?? null,
    slotIndex: action.slotIndex ?? null,
    characterUid: action.characterUid ?? null,
    itemUid: action.itemUid ?? null,
    optionIndex: action.optionIndex ?? null,
    count: action.count ?? null,
  });
}

/** Ops that are often intentionally repeated back-to-back with the same key. */
function isRepeatableOp(op: string): boolean {
  // place_card_on_rite is NOT repeatable: TryUpdateCard+DropCard(+SetCard) share one place.
  // continue IS repeatable: multi-page rite results need several DoNext clicks.
  return op === "exchange_sudan_card" || op === "inspect_card" || op === "continue";
}

function placeFromSlotData(
  data: Record<string, unknown>,
  method: string,
): { action: GameAction; note?: string } | { skip: string } {
  const uid = asNumber(data.cardUid);
  const slotIndex = asNumber(data.slotIndex);
  if (uid === undefined || slotIndex === undefined) {
    return { skip: "place_card missing cardUid/slotIndex" };
  }
  const action: GameAction = { op: "place_card_on_rite", uid, slotIndex };
  const cardId = asNumber(data.cardId);
  if (cardId !== undefined) action.cardId = cardId;
  const count = asNumber(data.cardCount) ?? asNumber(data.splitCount) ?? asNumber(data.count);
  if (count !== undefined && count > 1) action.count = count;
  return { action, note: `from ${method}` };
}

function tryMapHarmonyEvent(
  event: RecordedCall,
  ctx: {
    submitOpen: boolean;
    suppressCloseUntilSeq: number;
    lastOpenRiteUid: number | undefined;
    lastOpenRiteSeq: number;
  },
): { action: GameAction; note?: string } | { skip: string } {
  const method = event.method ?? "";
  const data = dataOf(event);

  if (method === "RiteController.OnSubmit") {
    if (event.phase === "enter") {
      ctx.submitOpen = true;
      return { skip: "wait for OnSubmit exit" };
    }
    ctx.submitOpen = false;
    // Opening a rite often emits a trailing OnClose; ignore it briefly.
    ctx.suppressCloseUntilSeq = Math.max(ctx.suppressCloseUntilSeq, event.sequence + 8);
    const uid = asNumber(data.riteUid);
    if (uid === undefined) {
      return { skip: "open_rite missing riteUid" };
    }
    ctx.lastOpenRiteUid = uid;
    ctx.lastOpenRiteSeq = event.sequence;
    const action: GameAction = { op: "open_rite", uid };
    const riteId = asNumber(data.riteId);
    if (riteId !== undefined) action.riteId = riteId;
    return { action, note: `from ${method}` };
  }

  // Prefer real drag/place paths.
  if (method === "CardSlotController.DropCard" || method === "RitePanelShowController.TryUpdateCard") {
    // Opening a map rite sync-fills prefilled slots (NPC/book) via SetCard/Drop noise
    // while OnSubmit is in flight — those are not player places.
    if (ctx.submitOpen) {
      return { skip: "place during open_rite sync" };
    }
    if (method === "RitePanelShowController.TryUpdateCard" && data.result === false) {
      return { skip: "TryUpdateCard result=false" };
    }
    return placeFromSlotData(data, method);
  }

  // Gold/stack place often only hits SetCard (no DropCard). Accept fills of empty slots.
  if (method === "CardSlotController.SetCard" || method === "RitePanelShowController.SetCard") {
    if (ctx.submitOpen) {
      return { skip: "SetCard during open_rite sync" };
    }
    if (asBool(data.slotWasEmpty) !== true) {
      return { skip: "SetCard sync/replace; need DropCard/TryUpdateCard or empty-slot fill" };
    }
    return placeFromSlotData(data, method);
  }

  if (method === "CardController.CardSplit") {
    // Context only — count rides on the following SetCard/DropCard place.
    return { skip: "CardSplit is place context; count comes from SetCard/Drop" };
  }

  if (method === "RitePanelShowController.RequestUpdate") {
    return { skip: "RequestUpdate has no stable slotIndex" };
  }

  if (method === "RitePanelShowController.OnConfirm") {
    // Result / close churn after execute should not become cancel.
    ctx.suppressCloseUntilSeq = Math.max(ctx.suppressCloseUntilSeq, event.sequence + 120);
    return { action: { op: "execute" }, note: `from ${method}` };
  }
  if (method === "RitePanelShowController.OnStop") {
    return { action: { op: "reset" }, note: `from ${method}` };
  }
  if (method === "RitePanelShowController.OnClose") {
    // Opening a map rite / result pages / day advance often fire OnClose — not cancel.
    if (ctx.submitOpen || event.sequence <= ctx.suppressCloseUntilSeq) {
      return { skip: "OnClose during/after open_rite/execute/result churn" };
    }
    return { action: { op: "cancel" }, note: `from ${method}` };
  }

  if (method === "CardController.CardEquip") {
    if (data.result === false) {
      return { skip: "CardEquip result=false" };
    }
    const characterUid = asNumber(data.characterUid);
    const itemUid = asNumber(data.itemUid);
    if (characterUid === undefined || itemUid === undefined) {
      return { skip: "equip missing characterUid/itemUid" };
    }
    return {
      action: { op: "equip_item", characterUid, itemUid },
      note: `from ${method}`,
    };
  }

  if (method === "CardController.RemoveFromSlot") {
    const itemUid = asNumber(data.itemUid);
    if (itemUid === undefined) {
      return { skip: "unequip missing itemUid" };
    }
    return {
      action: { op: "unequip_item", itemUid },
      note: `from ${method}`,
    };
  }

  if (method === "GameController.DoIThink") {
    const uid =
      asNumber(data.cardUid) ??
      asNumber(data.ithinkCardUid) ??
      asNumber(data.thinkCurrentUid) ??
      asNumber(data.currentDragUid);
    if (uid === undefined) {
      return { skip: "inspect missing card uid" };
    }
    const action: GameAction = { op: "inspect_card", uid };
    const cardId =
      asNumber(data.cardId) ?? asNumber(data.ithinkCardId) ?? asNumber(data.thinkCurrentId);
    if (cardId !== undefined) action.cardId = cardId;
    return { action, note: `from ${method}` };
  }

  if (method === "RiteResultPanelController.DoNext") {
    // Spam-click DoNext floods the log; OnNext / SudanBreaker are the real page advances.
    return { skip: "DoNext spam; prefer OnNext/SudanBreaker" };
  }

  if (
    method === "RiteResultPanelController.OnNext" ||
    method === "SudanBreakerNewController.OnPointerClick"
  ) {
    // Result-page advances often also fire OnClose; keep cancel suppressed.
    ctx.suppressCloseUntilSeq = Math.max(ctx.suppressCloseUntilSeq, event.sequence + 80);
    return { action: { op: "continue" }, note: `from ${method}` };
  }

  if (method === "RiteResultPanelController.OnPointerClick") {
    return { skip: "pointer click folded into OnNext/SudanBreaker when present" };
  }

  if (method === "SudanBoxController.OnPointerClick") {
    return { action: { op: "open_sudan_box" }, note: `from ${method}` };
  }

  if (method === "WizardController.RedrawSudanCard") {
    return { action: { op: "exchange_sudan_card" }, note: `from ${method}` };
  }

  if (method === "GameController.OnPrevRound") {
    return { action: { op: "prev_round" }, note: `from ${method}` };
  }

  if (method === "GameController.OnNextRound") {
    ctx.suppressCloseUntilSeq = Math.max(ctx.suppressCloseUntilSeq, event.sequence + 120);
    return { action: { op: "next_day" }, note: `from ${method}` };
  }

  if (method === "OptionController.OnConfirm") {
    const optionIndex = asNumber(data.optionIndex);
    if (optionIndex === undefined || optionIndex < 0) {
      return { skip: "select_event_option missing optionIndex" };
    }
    ctx.suppressCloseUntilSeq = Math.max(ctx.suppressCloseUntilSeq, event.sequence + 80);
    const action: GameAction = { op: "select_event_option", optionIndex };
    return { action, note: `from ${method}` };
  }

  if (method === "ConfirmController.OnConfirm") {
    // Generic confirm dialogs (e.g. prev_round warning) resolve via continue.
    return { action: { op: "continue" }, note: `from ${method}` };
  }

  if (
    method === "BeginGuideController.OnClose" ||
    method === "BeginGuideButtonHandler.Click"
  ) {
    // If Wizard is already open, guide close is a side-effect — do NOT emit continue.
    // continue while wizardChoiceMenu is up fails with need_wizard_choice; the next
    // exchange_sudan_card selects「交换手上的苏丹卡」itself.
    const wizardBusy =
      asBool(data.wizardActive) === true ||
      asBool(data.wizardChoiceMenu) === true ||
      asBool(data.wizardRedrawDropperActive) === true;
    if (wizardBusy) {
      return { skip: "BeginGuide close while wizard open; exchange owns the choice" };
    }
    // IntentRouter.continue follows BeginGuide.preferredOp / dismisses the finger guide.
    return { action: { op: "continue" }, note: `from ${method}` };
  }

  return { skip: `unmapped method=${method}` };
}

function tryMapPollEvent(
  event: RecordedCall,
  prevSudan: Record<string, unknown> | null,
  ctx: { lastOpenRiteUid: number | undefined; lastOpenRiteSeq: number },
): Array<{ action: GameAction; note?: string } | { skip: string }> {
  if (event.method !== "sudan_state") {
    return [{ skip: `ignored poll method=${event.method}` }];
  }

  const data = dataOf(event);
  const prev = prevSudan ?? {};
  const out: Array<{ action: GameAction; note?: string } | { skip: string }> = [];

  const redraw = asNumber(data.redrawTimes);
  const prevRedraw = asNumber(prev.redrawTimes);
  if (redraw !== undefined && prevRedraw !== undefined && redraw > prevRedraw) {
    const delta = Math.min(redraw - prevRedraw, 5);
    for (let i = 0; i < delta; i++) {
      out.push({
        action: { op: "exchange_sudan_card" },
        note: `poll sudan_state redraw ${prevRedraw + i}->${prevRedraw + i + 1}`,
      });
    }
  }

  const round = asNumber(data.playerRound);
  const prevRound = asNumber(prev.playerRound);
  if (round !== undefined && prevRound !== undefined && round < prevRound) {
    out.push({
      action: { op: "prev_round" },
      note: `poll sudan_state round ${prevRound}->${round}`,
    });
  }
  // Backup next_day if OnNextRound probe was missed.
  if (round !== undefined && prevRound !== undefined && round > prevRound) {
    out.push({
      action: { op: "next_day" },
      note: `poll sudan_state round ${prevRound}->${round}`,
    });
  }

  // Guide dismissed (finger tutorial closed) — continue lets IntentRouter clear it.
  // Harmony BeginGuideController.OnClose is preferred; poll is backup only.
  const guideActive = asBool(data.beginGuideActive);
  const prevGuideActive = asBool(prev.beginGuideActive);
  if (guideActive === false && prevGuideActive === true) {
    out.push({
      action: { op: "continue" },
      note: "poll sudan_state beginGuide dismissed",
    });
  }

  // Do NOT map wizardActive false→true to open_sudan_box: wizard often opens as a
  // side-effect of the box click / guide close. Harmony OnPointerClick is authoritative.

  // Backup open_rite if OnSubmit probe was missed — skip when Harmony already opened same uid.
  const ritePanel = asBool(data.ritePanelActive);
  const prevRitePanel = asBool(prev.ritePanelActive);
  const riteUid = asNumber(data.currentRiteUid);
  const recentlyOpenedSame =
    riteUid !== undefined &&
    ctx.lastOpenRiteUid === riteUid &&
    event.sequence - ctx.lastOpenRiteSeq < 40;
  if (
    out.length === 0 &&
    ritePanel === true &&
    prevRitePanel === false &&
    riteUid !== undefined &&
    !recentlyOpenedSame
  ) {
    const action: GameAction = { op: "open_rite", uid: riteUid };
    const riteId = asNumber(data.currentRiteId);
    if (riteId !== undefined) action.riteId = riteId;
    out.push({
      action,
      note: `poll sudan_state rite panel opened uid=${riteUid}`,
    });
  }

  if (out.length === 0) {
    out.push({ skip: "sudan_state delta without actionable change" });
  }
  return out;
}

/**
 * Collapse enter/exit pairs without reordering: remove the enter placeholder and
 * append the exit at the current end so sequence order stays correct.
 */
function selectEvents(events: RecordedCall[]): RecordedCall[] {
  const selected: RecordedCall[] = [];
  const enterIndex = new Map<string, number>();

  const reindex = () => {
    enterIndex.clear();
    for (let i = 0; i < selected.length; i++) {
      const e = selected[i]!;
      if (e.phase !== "enter") continue;
      const key = `${e.frame ?? -1}|${e.method}`;
      enterIndex.set(key, i);
    }
  };

  for (const event of events) {
    if (!event || typeof event.method !== "string") continue;
    if (event.phase === "recording") continue;
    if (event.phase === "poll") {
      if (event.method === "sudan_state") {
        selected.push(event);
      }
      continue;
    }

    // Keep both OnSubmit enter/exit so mapper can detect in-flight open churn.
    if (event.method === "RiteController.OnSubmit") {
      selected.push(event);
      continue;
    }

    const frame = event.frame ?? -1;
    const foldKey = `${frame}|${event.method}`;

    if (event.phase === "enter") {
      enterIndex.set(foldKey, selected.length);
      selected.push(event);
      continue;
    }

    if (event.phase === "exit") {
      const idx = enterIndex.get(foldKey);
      if (idx !== undefined && selected[idx]?.phase === "enter") {
        selected.splice(idx, 1);
        reindex();
        selected.push(event);
      } else {
        selected.push(event);
      }
      continue;
    }

    selected.push(event);
  }

  // Guarantee timeline order even when exit replaces a much earlier enter.
  selected.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return selected;
}

function samePlaceTarget(a: GameAction, b: GameAction): boolean {
  return (
    a.op === "place_card_on_rite" &&
    b.op === "place_card_on_rite" &&
    a.uid === b.uid &&
    a.slotIndex === b.slotIndex
  );
}

function pushStep(
  steps: ReplayStep[],
  event: RecordedCall,
  mapped: { action: GameAction; note?: string },
  lastActionKey: { value: string },
): void {
  // Merge TryUpdateCard/DropCard/SetCard for the same uid+slot into one place.
  // Prefer the richer count when one probe carries stack amount and another does not.
  if (steps.length > 0 && mapped.action.op === "place_card_on_rite") {
    const last = steps[steps.length - 1]!;
    if (samePlaceTarget(last.action, mapped.action)) {
      const prevCount = asNumber(last.action.count);
      const nextCount = asNumber(mapped.action.count);
      if (nextCount !== undefined && (prevCount === undefined || nextCount > prevCount)) {
        last.action.count = nextCount;
      }
      if (mapped.action.cardId !== undefined && last.action.cardId === undefined) {
        last.action.cardId = mapped.action.cardId;
      }
      last.note = `${last.note ?? ""}; ${mapped.note ?? "merged place"}`.replace(/^; /, "");
      lastActionKey.value = actionKey(last.action);
      return;
    }
  }

  const key = actionKey(mapped.action);
  if (key === lastActionKey.value && !isRepeatableOp(String(mapped.action.op))) {
    return;
  }
  // Still collapse exact same-source duplicates (harmony exit + poll same redraw).
  if (
    key === lastActionKey.value &&
    isRepeatableOp(String(mapped.action.op)) &&
    steps.length > 0 &&
    steps[steps.length - 1]!.source.sequence === event.sequence
  ) {
    return;
  }
  lastActionKey.value = key;
  steps.push({
    index: steps.length,
    source: {
      sequence: event.sequence,
      phase: event.phase,
      method: event.method,
    },
    action: mapped.action,
    decision: emptyDecision(),
    note: mapped.note,
  });
}

/** Catch redraw jumps that polls skipped (e.g. 2→3 only visible on next harmony probe). */
function emitRedrawDelta(
  steps: ReplayStep[],
  event: RecordedCall,
  data: Record<string, unknown>,
  prevRedraw: { value: number | undefined },
  lastActionKey: { value: string },
): void {
  const redraw = asNumber(data.redrawTimes);
  if (redraw === undefined || prevRedraw.value === undefined) {
    if (redraw !== undefined) prevRedraw.value = redraw;
    return;
  }
  if (redraw > prevRedraw.value) {
    const delta = Math.min(redraw - prevRedraw.value, 5);
    for (let i = 0; i < delta; i++) {
      pushStep(
        steps,
        event,
        {
          action: { op: "exchange_sudan_card" },
          note: `redraw gap ${prevRedraw.value + i}->${prevRedraw.value + i + 1} via ${event.method}`,
        },
        lastActionKey,
      );
    }
  }
  prevRedraw.value = redraw;
}

export function mapRecordingToReplay(
  recording: RecordingDocument,
  opts?: { sourceRecordingPath?: string; id?: string },
): ReplayDocument {
  const events = Array.isArray(recording.events) ? recording.events : [];
  const selected = selectEvents(events);
  const steps: ReplayStep[] = [];
  const lastActionKey = { value: "" };
  const ctx = {
    submitOpen: false,
    suppressCloseUntilSeq: -1,
    lastOpenRiteUid: undefined as number | undefined,
    lastOpenRiteSeq: -1,
  };
  let prevSudan: Record<string, unknown> | null = null;
  const prevRedraw = { value: undefined as number | undefined };

  for (const event of events) {
    if (event.phase === "poll" && event.method === "sudan_baseline") {
      prevSudan = dataOf(event);
      prevRedraw.value = asNumber(prevSudan.redrawTimes);
      break;
    }
  }

  for (const event of selected) {
    // Track OnSubmit enter even if we skipped pushing it (enter filtered in tryMap).
    if (event.method === "RiteController.OnSubmit" && event.phase === "enter") {
      ctx.submitOpen = true;
    }

    const data = dataOf(event);
    emitRedrawDelta(steps, event, data, prevRedraw, lastActionKey);

    // Keep sudan prev in sync from harmony probes that carry SudanSnapshot fields,
    // so later polls do not re-emit side-effect transitions (wizard/guide).
    if (
      event.phase !== "poll" &&
      (data.wizardActive !== undefined || data.beginGuideActive !== undefined)
    ) {
      prevSudan = { ...(prevSudan ?? {}), ...data };
    }

    if (event.phase === "poll") {
      const mappedList = tryMapPollEvent(event, prevSudan, ctx);
      prevSudan = data;
      for (const mapped of mappedList) {
        if ("skip" in mapped) continue;
        // redraw exchanges already emitted by emitRedrawDelta
        if (mapped.action.op === "exchange_sudan_card") continue;
        // Guide continue already emitted from BeginGuideController.OnClose.
        if (
          mapped.action.op === "continue" &&
          lastActionKey.value === actionKey({ op: "continue" })
        ) {
          continue;
        }
        // next_day from poll is backup; skip if Harmony OnNextRound already emitted.
        if (
          mapped.action.op === "next_day" &&
          lastActionKey.value === actionKey({ op: "next_day" })
        ) {
          continue;
        }
        pushStep(steps, event, mapped, lastActionKey);
      }
      continue;
    }

    const mapped = tryMapHarmonyEvent(event, ctx);
    if ("skip" in mapped) continue;
    // RedrawSudanCard exchanges also covered by redraw delta when data carries redrawTimes.
    if (
      mapped.action.op === "exchange_sudan_card" &&
      asNumber(data.redrawTimes) !== undefined
    ) {
      continue;
    }
    pushStep(steps, event, mapped, lastActionKey);
  }

  // Drop continue that only sits between open_sudan_box and exchange — redundant
  // and often fails with need_wizard_choice during replay.
  for (let i = steps.length - 2; i >= 1; i--) {
    const prev = steps[i - 1]!;
    const cur = steps[i]!;
    const next = steps[i + 1]!;
    if (
      cur.action.op === "continue" &&
      prev.action.op === "open_sudan_box" &&
      next.action.op === "exchange_sudan_card"
    ) {
      steps.splice(i, 1);
    }
  }

  // Premature OnNextRound (clicked next day before result pages clear) leaves
  // next_day → continue* → next_day. Keep only the later day advance.
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.action.op !== "next_day") continue;
    let j = i + 1;
    while (j < steps.length && steps[j]!.action.op === "continue") j++;
    if (j < steps.length && steps[j]!.action.op === "next_day" && j > i + 0) {
      steps.splice(i, 1);
      i--;
    }
  }

  // Overnight rites: humans often hit next_day right after execute; result OnNext
  // only appears after the day advances. Bubble next_day to sit immediately after execute.
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.action.op !== "execute") continue;
    let j = i + 1;
    while (j < steps.length && j <= i + 6 && steps[j]!.action.op === "continue") j++;
    if (j < steps.length && j <= i + 6 && steps[j]!.action.op === "next_day" && j > i + 1) {
      const [dayStep] = steps.splice(j, 1);
      steps.splice(i + 1, 0, dayStep!);
    }
  }

  // Collapse spam continues from the same probe (e.g. 4× SudanBreaker click).
  for (let i = steps.length - 1; i >= 1; i--) {
    const cur = steps[i]!;
    const prev = steps[i - 1]!;
    if (
      cur.action.op === "continue" &&
      prev.action.op === "continue" &&
      cur.source.method === prev.source.method
    ) {
      steps.splice(i, 1);
    }
  }

  // Re-index after possible skips.
  for (let i = 0; i < steps.length; i++) {
    steps[i]!.index = i;
  }

  const id = opts?.id ?? recording.id ?? `replay-${Date.now()}`;
  return {
    version: 1,
    id,
    sourceRecordingPath: opts?.sourceRecordingPath ?? recording.filePath ?? "",
    createdAt: new Date().toISOString(),
    steps,
  };
}
