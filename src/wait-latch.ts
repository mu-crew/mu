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
