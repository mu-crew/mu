// mu — waitForAgents: block until agents finish working.
//
// The off-the-cuff / scratch pattern: spawn one or more task-less
// helpers, send them work, then wait until they're done before reading
// their output. Unlike `mu task wait` (which watches the task DAG),
// scratch/subagent flows have NO task to wait on — the only signal is
// the agent's own runtime status. This is that primitive.
//
// "Done" semantics (chosen in dogfood): an agent fires when it
// transitions **busy → any other state**. The agent MUST have been
// observed `busy` first, so a helper that is already idle when the wait
// starts does NOT instantly fire — the caller is waiting for *this*
// piece of work to finish, not for "is idle right now". An agent that
// never goes busy (e.g. the prompt didn't land) just keeps the wait
// pending until timeout, which is the honest outcome.
//
// Mirrors waitForTasks' shape: poll cadence + sleep test-seam, a
// beforePoll hook so the CLI can re-detect live status each tick
// without this SDK module importing tmux, --any/--all, and a timeout.
// The CLI wrapper maps the result to task-wait-symmetric exit codes.
//
// This is an ADAPTER: the one loop is waitForEvents (src/wait.ts). The
// types, the "busy first" rule's result shape and the hooks below are the
// old surface, kept until `mu wait` replaces the callers (v_wait_cli).

import type { RuntimeState } from "../agent-state.js";
import type { CtlBlocked } from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { type AgentReading, type WaitSnapshot, waitForEvents } from "../wait.js";

// ─── Test seam: poll-sleep (mirrors waitForTasks / tmux setSleepForTests)
let currentWaitSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setAgentWaitSleepForTests(
  impl: ((ms: number) => Promise<void>) | undefined,
): (ms: number) => Promise<void> {
  const previous = currentWaitSleep;
  currentWaitSleep = impl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return previous;
}

/** A single agent the wait verb is watching. Each ref carries its own
 *  workstream so a cross-workstream wait can span sessions, mirroring
 *  TaskWaitRef. */
export interface AgentWaitRef {
  workstreamName: string;
  name: string;
}

/** Snapshot of one watched agent at a poll tick. Supplied by the
 *  caller's state-reader hook so this SDK stays free of mux imports. */
export interface AgentStatusSnapshot {
  /** Current runtime state, or null when the pane is gone (dead). */
  status: RuntimeState | null;
  /** Why the state is unknown, when the source supplied a reason. */
  unknownReason?: string;
  /** Final assistant text of the settled run (control-socket watches only). */
  lastText?: string;
  /** Error that ended the settled run (control-socket watches only). */
  lastError?: string;
  /** The pi session file holding the run's transcript (control-socket watches only). */
  sessionFile?: string;
  /** The watch ended because pi opened an extension dialog, not on a
   *  settle (control-socket watches only). */
  blocked?: CtlBlocked;
}

export interface AgentWaitOptions {
  /** When true, succeed as soon as ONE agent fires. Default false:
   *  every listed agent must fire. */
  any?: boolean;
  /** Maximum time to wait, in ms. Default 600_000 (10 min). 0 = forever. */
  timeoutMs?: number;
  /** Poll interval. Default 1000ms; overridable for tests. */
  pollMs?: number;
  /** Preferred batch reader, called once per tick. Map keys are
   *  `<workstream>/<name>`. */
  readStatuses?: (
    refs: readonly AgentWaitRef[],
  ) => Promise<ReadonlyMap<string, AgentStatusSnapshot>>;
  /** Legacy per-agent reader. Used only when `readStatuses` is absent. */
  readStatus?: (ref: AgentWaitRef) => Promise<AgentStatusSnapshot>;
  /**
   * Event-driven watcher, consulted once per agent before the first tick.
   * Returning a watch takes the agent out of polling: `initial` is its
   * state now, and `settled` resolves when its current or next run ends
   * (`status: null` = it died; `unknown` = no settle seen, poll it
   * instead). Returning undefined keeps it polled. The
   * signal aborts outstanding watches when the wait returns.
   */
  watch?: (ref: AgentWaitRef, signal: AbortSignal) => Promise<AgentWatch | undefined>;
  /** Called once when every watched agent is unknown on the first tick. */
  onInitialUnknown?: (agents: readonly AgentWaitAgentState[]) => void;
}

export interface AgentWatch {
  initial: AgentStatusSnapshot;
  /** The run count the watch waits past (ctl `afterRuns`): a re-wait with
   *  `--after-runs <this>` still catches a run that settles in between. */
  afterRuns?: number;
  /** Resolves when the run ends. A REJECTION is fatal and propagates out of
   *  the wait (an agent that restarted: its run is gone). It is never read
   *  as "no settle seen". */
  settled: Promise<AgentStatusSnapshot>;
}

export interface AgentWaitAgentState {
  workstreamName: string;
  name: string;
  /** State at exit time (null = pane gone / dead). */
  status: RuntimeState | null;
  /** True once we observed this agent `busy` at any tick. */
  wasBusy: boolean;
  /** True when the agent fired: was busy, then moved to a non-busy
   *  live status. */
  fired: boolean;
  /** Why the current state is unknown, when supplied by its source. */
  unknownReason?: string;
  /** Final assistant text of the settled run; set only for control-socket
   *  (pi) agents, absent for polled ones. */
  lastText?: string;
  /** Error that ended the settled run (API error after pi's retries). */
  lastError?: string;
  /** The pi session file holding the run's transcript; control-socket agents only. */
  sessionFile?: string;
  /** Set when the wait ended on an extension dialog pi is waiting on: the
   *  run is not finished (`fired` stays false). Control-socket agents only. */
  blocked?: CtlBlocked;
  /** The run baseline this wait counted from (control-socket agents only):
   *  re-wait with `--after-runs <afterRuns>` so a run that settles before
   *  the re-wait starts is still returned. */
  afterRuns?: number;
  /** True when the agent's pane vanished mid-wait. Surfaced separately
   *  so the CLI can exit non-zero rather than treating a crash as a
   *  clean finish. */
  dead: boolean;
}

export interface AgentWaitResult {
  /** Per-agent state at exit, same order as input. */
  agents: AgentWaitAgentState[];
  /** True when we exited on the timeout, not because the condition met. */
  timedOut: boolean;
}

/**
 * Block until watched agents finish (busy → any other state).
 *
 * Pre-flight: every agent in `input` MUST exist; missing ones throw
 * AgentNotFoundError before any waiting begins (loud-fail; a typo'd
 * name silently waiting forever is the worst UX, mirrors waitForTasks).
 *
 * Returns the final per-agent state; the CLI decides exit codes
 * (0 met / 5 timeout / 6 a watched agent died).
 */
export async function waitForAgents(
  db: Db,
  input: readonly AgentWaitRef[],
  opts: AgentWaitOptions,
): Promise<AgentWaitResult> {
  if (input.length === 0) throw new Error("waitForAgents: refs must be non-empty");
  const refKey = (ref: AgentWaitRef): string => `${ref.workstreamName}/${ref.name}`;

  const stateOf = (snap: WaitSnapshot | undefined, ref: AgentWaitRef): AgentWaitAgentState => ({
    workstreamName: ref.workstreamName,
    name: ref.name,
    status: snap === undefined ? null : (snap.status as RuntimeState | null),
    wasBusy: snap?.wasBusy === true,
    fired: snap?.fired === true,
    dead: snap?.dead === true,
    ...(snap?.unknownReason !== undefined ? { unknownReason: snap.unknownReason } : {}),
    ...(snap?.lastText !== undefined ? { lastText: snap.lastText } : {}),
    ...(snap?.lastError !== undefined ? { lastError: snap.lastError } : {}),
    ...(snap?.sessionFile !== undefined ? { sessionFile: snap.sessionFile } : {}),
    ...(snap?.blocked !== undefined ? { blocked: snap.blocked } : {}),
    ...(snap?.afterRuns !== undefined ? { afterRuns: snap.afterRuns } : {}),
  });
  const statesOf = (snaps: readonly WaitSnapshot[]): AgentWaitAgentState[] => {
    const byKey = new Map(snaps.map((s) => [`${s.ref.workstream}/${s.ref.id}`, s]));
    return input.map((ref) => stateOf(byKey.get(refKey(ref)), ref));
  };
  const toReading = (snap: AgentStatusSnapshot): AgentReading => ({
    status: snap.status,
    ...(snap.unknownReason !== undefined ? { reason: snap.unknownReason } : {}),
    ...(snap.lastText !== undefined ? { lastText: snap.lastText } : {}),
    ...(snap.lastError !== undefined ? { lastError: snap.lastError } : {}),
    ...(snap.sessionFile !== undefined ? { sessionFile: snap.sessionFile } : {}),
    ...(snap.blocked !== undefined ? { blocked: snap.blocked } : {}),
  });
  const { readStatuses, readStatus, watch } = opts;

  const res = await waitForEvents(
    db,
    input.map((r) => ({ kind: "agent" as const, workstream: r.workstreamName, id: r.name })),
    {
      all: opts.any !== true,
      uncapped: true,
      timeoutMs: opts.timeoutMs ?? 600_000,
      pollMs: opts.pollMs ?? 1000,
      sync: false,
      applyClose: false,
      sleep: (ms) => currentWaitSleep(ms),
      readAgents: async (refs) => {
        const pending = refs.map((r) => ({ workstreamName: r.workstream, name: r.id }));
        const snapshots = readStatuses ? await readStatuses(pending) : undefined;
        if (snapshots === undefined && readStatus === undefined) {
          throw new Error("waitForAgents: readStatuses or readStatus is required");
        }
        const out = new Map<string, AgentReading>();
        for (const ref of pending) {
          const snap = snapshots?.get(refKey(ref)) ?? (await readStatus?.(ref));
          if (snap !== undefined) out.set(refKey(ref), toReading(snap));
        }
        return out;
      },
      ...(watch
        ? {
            watchAgent: async (ref: { workstream: string; id: string }, signal: AbortSignal) => {
              const w = await watch({ workstreamName: ref.workstream, name: ref.id }, signal);
              if (w === undefined) return undefined;
              return {
                initial: toReading(w.initial),
                ...(w.afterRuns !== undefined ? { afterRuns: w.afterRuns } : {}),
                settled: w.settled.then(toReading),
              };
            },
          }
        : {}),
      ...(opts.onInitialUnknown
        ? {
            onInitialUnknown: (snaps: readonly WaitSnapshot[]) =>
              opts.onInitialUnknown?.(statesOf(snaps)),
          }
        : {}),
    },
  );
  return { agents: statesOf(res.refs), timedOut: res.timedOut };
}
