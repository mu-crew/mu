// mu — the wait loop's pick: which ready items one wait fires (`selectEvent`). Pure: no DB, no
// loop state. Moved out of src/wait.ts (the loop) under the file cap; see that file's comment for
// the semantics of `first` and `all`.

import { failedGate, type Item, sameDeath, urgency } from "./wait-item.js";
import { closedByRun } from "./wait-types.js";

/** The event a wait returns and every item it fires with it (consumed together). */
export interface Chosen {
  event: Item;
  fired: Item[];
}

/** Rank order: never-returned events first, then urgency, a failed gate, targets, input order. */
export const rankItems = (a: Item, b: Item): number =>
  // Never-returned events first: an event that was already returned once (an
  // unchanged dialog, a dead pane, a stall) never outranks one that was not.
  Number(a.seen === true) - Number(b.seen === true) ||
  urgency(a.kind) - urgency(b.kind) ||
  // Under --all a failed gate is the firing event, so its code is the exit.
  Number(failedGate(b)) - Number(failedGate(a)) ||
  Number(b.target) - Number(a.target) ||
  a.order - b.order;

/**
 * One fact, one event: a settled run whose CLOSE block closed task T, and T's own close, are the
 * same news. Delivering either consumes the other, so the second is not owed.
 */
const sameClose = (a: Item, b: Item): boolean =>
  a.kind === "settled" &&
  a.ref.kind === "agent" &&
  closedByRun(a.snap.close) === b.ref.id &&
  a.ref.workstream === b.ref.workstream &&
  b.ref.kind === "task" &&
  b.kind === "closed";

/** The items one fact fires together with `best`: its close or settle twin, its same death. */
const companionsOf = (ready: readonly Item[], best: Item): Item[] =>
  ready.filter(
    (i) => i !== best && (sameClose(i, best) || sameClose(best, i) || sameDeath(i, best)),
  );

/** What this wait fires now, or undefined to keep waiting. */
export function selectEvent(items: readonly Item[], mode: "first" | "all"): Chosen | undefined {
  const ready = items.filter((i) => i.ready).sort(rankItems);
  if (mode !== "all") {
    const best = ready[0];
    if (best === undefined) return undefined;
    return { event: best, fired: [best, ...companionsOf(ready, best)] };
  }
  const urgent = ready.find(
    (i) =>
      i.kind === "input" ||
      i.kind === "stall" ||
      (!i.target && (i.kind === "dead" || i.kind === "delegate")),
  );
  if (urgent !== undefined) {
    const companions = ready.filter((i) => i !== urgent && sameDeath(i, urgent));
    return { event: urgent, fired: [urgent, ...companions] };
  }
  const targets = items.some((i) => i.target) ? items.filter((i) => i.target) : [...items];
  if (targets.length === 0 || !targets.every((i) => i.done)) return undefined;
  const sorted = [...targets].sort(rankItems);
  const best = sorted.find((i) => i.ready) ?? sorted[0];
  return best === undefined ? undefined : { event: best, fired: targets.filter((i) => i.done) };
}
