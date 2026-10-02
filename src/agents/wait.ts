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

import type { RuntimeState } from "../agent-state.js";
import type { Db } from "../db.js";
import { AgentNotFoundError } from "./errors.js";

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

  // Pre-flight existence check.
  for (const ref of input) {
    const row = db
      .prepare(
        `SELECT 1 FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id
          WHERE a.name = ? AND ws.name = ?`,
      )
      .get(ref.name, ref.workstreamName);
    if (row === undefined) throw new AgentNotFoundError(ref.name);
  }

  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const any = opts.any === true;
  const startedAt = Date.now();

  // Mutable per-agent tracking.
  const state: AgentWaitAgentState[] = input.map((ref) => ({
    workstreamName: ref.workstreamName,
    name: ref.name,
    status: null,
    wasBusy: false,
    fired: false,
    dead: false,
  }));

  const conditionMet = (): boolean => {
    const done = state.filter((s) => s.fired || s.dead);
    return any ? done.length > 0 : done.length === state.length;
  };

  const refKey = (ref: AgentWaitRef): string => `${ref.workstreamName}/${ref.name}`;

  // Event-driven agents: their settle wakes the loop instead of a poll.
  const abort = new AbortController();
  const watched = new Set<number>();
  let wake: () => void = () => {};
  let woken = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const rearm = (): void => {
    woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  if (opts.watch) {
    const watches = await Promise.all(input.map((ref) => opts.watch?.(ref, abort.signal)));
    watches.forEach((w, i) => {
      const st = state[i];
      if (w === undefined || st === undefined) return;
      watched.add(i);
      st.status = w.initial.status;
      if (w.initial.status === "busy") st.wasBusy = true;
      void w.settled.then(
        (snap) => {
          if (snap.status === null) {
            st.dead = true;
            st.status = null;
          } else if (snap.status === "unknown") {
            // No settle observed: hand the agent back to polling.
            watched.delete(i);
          } else {
            st.status = snap.status;
            st.wasBusy = true;
            st.fired = true;
          }
          wake();
        },
        () => {},
      );
    });
  }
  const finish = (timedOut: boolean): AgentWaitResult => {
    abort.abort();
    return { agents: state, timedOut };
  };

  // One state read over all not-yet-settled polled agents.
  const tick = async (): Promise<void> => {
    const pending = input.filter((_, i) => {
      const st = state[i];
      return st !== undefined && !st.fired && !st.dead && !watched.has(i);
    });
    if (pending.length === 0) return;
    const snapshots = opts.readStatuses ? await opts.readStatuses(pending) : undefined;
    if (snapshots === undefined && opts.readStatus === undefined) {
      throw new Error("waitForAgents: readStatuses or readStatus is required");
    }
    for (let i = 0; i < input.length; i++) {
      const st = state[i];
      const ref = input[i];
      if (st === undefined || ref === undefined) continue;
      if (st.fired || st.dead || watched.has(i)) continue;
      const snap = snapshots?.get(refKey(ref)) ?? (await opts.readStatus?.(ref));
      if (snap === undefined) {
        st.status = "unknown";
        st.unknownReason = "state reader returned no row";
        continue;
      }
      if (snap.status === null) {
        st.dead = true;
        st.status = null;
        continue;
      }
      st.status = snap.status;
      st.unknownReason = snap.status === "unknown" ? snap.unknownReason : undefined;
      if (snap.status === "busy") {
        st.wasBusy = true;
      } else if (snap.status !== "unknown" && st.wasBusy) {
        // Unknown is absence of a reading, not evidence that work ended.
        st.fired = true;
      }
    }
  };

  // Initial pass — seeds wasBusy for agents already busy; an agent that
  // is already idle here just sits pending (it must go busy first).
  await tick();
  if (state.every((agent) => agent.status === "unknown")) opts.onInitialUnknown?.(state);
  if (conditionMet()) return finish(false);

  while (true) {
    const elapsed = Date.now() - startedAt;
    if (timeoutMs > 0 && elapsed >= timeoutMs) return finish(true);
    const remaining = timeoutMs > 0 ? timeoutMs - elapsed : undefined;
    const polled = input.some((_, i) => {
      const st = state[i];
      return st !== undefined && !st.fired && !st.dead && !watched.has(i);
    });
    // Sleep, but never past the deadline (mirrors waitForTasks' clamp).
    // A settle ends the sleep early; with nothing left to poll, only a
    // settle or the deadline does.
    const sleeps: Promise<unknown>[] = [woken];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (polled) sleeps.push(currentWaitSleep(Math.min(pollMs, remaining ?? pollMs)));
    else if (remaining !== undefined) {
      sleeps.push(new Promise((resolve) => (timer = setTimeout(resolve, remaining))));
    }
    await Promise.race(sleeps);
    if (timer) clearTimeout(timer);
    rearm();
    await tick();
    if (conditionMet()) return finish(false);
  }
}
