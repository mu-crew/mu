// mu — the settled latch of a waited agent: what it holds and when it is history.
//
// A wait that sees an agent's run settle latches that reading (its CLOSE is already applied) until
// the run is acted on. One rule decides when the latch is history: it is valid ONLY for the exact
// (agentId, incarnation, runs) it captured. `supersededBy` is that predicate, and `rearmLatch` is
// the one way to drop a latch (src/wait.ts calls both, from refresh and from a steer).

import type { AgentReading, AgentWatchHandle, CloseOutcome, WaitRef } from "./wait-types.js";

export interface AgentTrack {
  ref: WaitRef;
  explicit: boolean;
  wasBusy: boolean;
  /** The ctl run count a (re)watch counts past. */
  baseline: number | undefined;
  handle: AgentWatchHandle | undefined;
  needWatch: boolean;
  result: AgentReading | undefined;
  reading: AgentReading | undefined;
  latched:
    | { kind: "settled" | "dead" | "input" | "pane-text" | "exited"; reading: AgentReading }
    | undefined;
  close: CloseOutcome | undefined;
  /** The dialog already returned once is still open: not news again until it changes. */
  muted: boolean;
  /** Owed with no fence, no cursor: counted from now, said so in the snapshot. */
  unknownBaseline: boolean;
  /** The run count a polled settle last re-opened a watch for (once per run: no loop). */
  rewatchedAt?: number;
  /** A watch was wanted but could not be set up (no answering socket); retried when it answers. */
  watchLost?: boolean;
}

/**
 * Drop a settled latch (its close, handle, result) and watch again past `baseline`. A latch holds
 * one settled run until it is acted on; a newer identity or a later run always supersedes it
 * (refresh), and a steer that answers it rearms from the send baseline (driveStalls).
 */
export function rearmLatch(t: AgentTrack, baseline: number, watching: boolean): void {
  t.latched = undefined;
  t.close = undefined;
  t.handle = undefined;
  t.result = undefined;
  t.needWatch = watching;
  t.baseline = baseline;
  t.wasBusy = false;
}

/**
 * THE latch rule (one predicate): a settled latch is valid only for the exact (agentId,
 * incarnation, runs) it captured. An owner reading of another registry row (a respawn under the
 * same name) or another pi process supersedes it from that identity's own run 0; a later run of
 * the same identity supersedes it from the latched run. Returns the rewatch baseline, or undefined
 * while the latch holds. A reading with no run count (dead, unknown) says nothing about it.
 */
export function supersededBy(t: AgentTrack, r: AgentReading): number | undefined {
  const held = t.latched?.kind === "settled" ? t.latched.reading : undefined;
  if (held === undefined || r.runs === undefined) return undefined;
  const differs = <T>(a: T | undefined, b: T | undefined): boolean =>
    a !== undefined && b !== undefined && a !== b;
  if (differs(held.agentId, r.agentId) || differs(held.incarnation, r.incarnation)) return 0;
  if (held.runs !== undefined && r.runs > held.runs) return held.runs;
  return undefined;
}

/**
 * A poll reading of a ctl agent that calls for a (new) watch: sets `needWatch` and says so. Two
 * cases, each at most once per run count (`rewatchedAt`), so a watch that cannot be set up is never
 * retried on every poll (a pending retry counts as a settle owed and would hide a stall):
 *   - the watch could not be set up (`watchLost`: no answering socket, a lease forward that is
 *     down) and the socket answers again;
 *   - a run settled past the baseline while no watch held it (its connection dropped). A poll has
 *     no run text, so its CLOSE block would never apply: the extension answers a watch past the
 *     same baseline at once with the settled run's facts.
 */
export function rewatchOnPoll(t: AgentTrack, r: AgentReading): boolean {
  if (t.watchLost === true && r.ctl === "ok" && t.rewatchedAt !== (r.runs ?? -1)) {
    t.watchLost = false;
    t.rewatchedAt = r.runs ?? -1;
    t.needWatch = true;
    return true;
  }
  if (
    r.status !== "unknown" &&
    r.status !== "busy" &&
    r.source === "ctl" &&
    r.runs !== undefined &&
    t.baseline !== undefined &&
    r.runs > t.baseline &&
    t.rewatchedAt !== r.runs
  ) {
    t.rewatchedAt = r.runs;
    t.needWatch = true;
    return true;
  }
  return false;
}
