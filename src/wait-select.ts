// mu — the wait loop's pick: which ready items one wait fires (`selectEvent`). Pure: no DB, no
// loop state. Moved out of src/wait.ts (the loop) under the file cap; see that file's comment for
// the semantics of `first` and `all`.
//
// `ready` (the ready batch, `mu wait --ready`): first's pick, and when that event is not urgent,
// every other ready, never-returned completion too, in rank order, up to READY_BATCH_MAX events.
// An urgent event (dead, input, stall) fires alone, so exits 6 and 7 mean what they mean under
// `first`. Opt-in: a client that reads only `firing` never passes it, so it loses nothing.

import { failedGate, type Item, isCompletion, refKey, sameDeath, urgency } from "./wait-item.js";
import { closedByRun, type WaitResult } from "./wait-types.js";

/** The most events one `--ready` wait fires (sized so a full batch of long texts fits the 4 KB result unpaged). */
export const READY_BATCH_MAX = 5;

/** The event a wait returns and every item it fires with it (consumed together). */
export interface Chosen {
  event: Item;
  fired: Item[];
  /** One group per event, `event`'s first: an event and its companions (one fact). `fired` is their union. */
  groups: Item[][];
}

const isUrgent = (i: Item): boolean =>
  i.kind === "dead" || i.kind === "input" || i.kind === "stall";

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
export function selectEvent(
  items: readonly Item[],
  mode: "first" | "all" | "ready",
): Chosen | undefined {
  const ready = items.filter((i) => i.ready).sort(rankItems);
  if (mode !== "all") {
    const best = ready[0];
    if (best === undefined) return undefined;
    const groups = [[best, ...companionsOf(ready, best)]];
    if (mode === "ready" && !isUrgent(best) && isCompletion(best)) {
      const taken = new Set(groups[0]);
      for (const i of ready) {
        if (groups.length >= READY_BATCH_MAX) break;
        if (taken.has(i) || i.seen === true || isUrgent(i) || !isCompletion(i)) continue;
        const group = [i, ...companionsOf(ready, i).filter((c) => !taken.has(c))];
        for (const g of group) taken.add(g);
        groups.push(group);
      }
    }
    return { event: best, fired: groups.flat(), groups };
  }
  const urgent = ready.find(
    (i) =>
      i.kind === "input" ||
      i.kind === "stall" ||
      (!i.target && (i.kind === "dead" || i.kind === "delegate")),
  );
  if (urgent !== undefined) {
    const fired = [urgent, ...ready.filter((i) => i !== urgent && sameDeath(i, urgent))];
    return { event: urgent, fired, groups: [fired] };
  }
  const targets = items.some((i) => i.target) ? items.filter((i) => i.target) : [...items];
  if (targets.length === 0 || !targets.every((i) => i.done)) return undefined;
  const sorted = [...targets].sort(rankItems);
  const best = sorted.find((i) => i.ready) ?? sorted[0];
  if (best === undefined) return undefined;
  const fired = targets.filter((i) => i.done);
  return { event: best, fired, groups: [fired] };
}

/**
 * The per-member commit guard: `chosen` without the members another process consumed since this
 * wait read its cursors (`stale`), which turn not ready. Every member is checked, companions too:
 * a companion has its own token, and a wait that saw only it (an explicit wait on the task a
 * settled run closed) consumed it without the rest of its group. A group left empty is dropped.
 * The firing event itself is the caller's to check first (stale there means select again), so
 * it stays first in the first group.
 */
export function dropStale(chosen: Chosen, stale: (i: Item | undefined) => boolean): Chosen {
  const groups = chosen.groups
    .map((g) => g.filter((i) => i === chosen.event || !stale(i)))
    .filter((g) => g.length > 0);
  const fired = groups.flat();
  // A dropped member is another wait's delivery: not ready (so never marked owed) here.
  for (const i of chosen.fired) if (!fired.includes(i)) i.ready = false;
  return { ...chosen, groups, fired };
}

/**
 * A superseded caller consumed nothing: narrow `r.delivered` to the members whose owner's
 * generation applied (`lost` says it did not), mark the others owed (the newer wait returns
 * them), and say whether the firing event itself was consumed. Mutates `r`.
 */
export function narrowSuperseded(
  r: WaitResult,
  fired: readonly Item[],
  lost: (i: Item) => boolean,
  event: Item | undefined,
): void {
  if (event !== undefined) r.eventConsumed = !lost(event);
  const gone = new Set(fired.filter((i) => isCompletion(i) && lost(i)).map((i) => refKey(i.ref)));
  r.delivered = r.delivered.filter((ref) => !gone.has(refKey(ref)));
  r.refs = r.refs.map((snap) => (gone.has(refKey(snap.ref)) ? { ...snap, owed: true } : snap));
  r.owed = (r.owed ?? 0) + gone.size;
}
