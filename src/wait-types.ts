// mu — the types and errors of waitForEvents (src/wait.ts): refs, events,
// snapshots, results, the options and the agent reader/watch shapes.

import type { RuntimeState } from "./agent-state.js";
import type { CtlBlocked } from "./ctl/protocol.js";
import type { VerdictTally } from "./delegates.js";
import type { TaskStatus } from "./tasks/status.js";
import type { CursorToken } from "./wait-cursor.js";
import type { WaitRefKind } from "./wait-registration.js";

/** The heartbeat cap: no wait outlives it; a requested 0 means this. */
export const WAIT_HEARTBEAT_CAP_MS = 1_500_000;

export interface WaitRef {
  kind: WaitRefKind;
  workstream: string;
  /** Task or agent local id; a delegate's call id. */
  id: string;
  /** Agent: ctl settled-run baseline (a `send` reply's `runs`). */
  afterRuns?: number;
  /** Agent: pin pi's process incarnation; another one is AgentRestartedError. */
  incarnation?: string;
}

export type WaitEventKind =
  | "closed"
  | "settled"
  | "input"
  | "dead"
  | "stall"
  | "delegate"
  | "pane-exit"
  | "heartbeat"
  | "interrupted";

export interface WaitEvent {
  kind: WaitEventKind;
  ref: WaitRef | null;
  incarnation?: string;
  runs?: number;
}

export interface CloseOutcome {
  applied: boolean;
  task: string | null;
  reason: string;
}

/** The facts of one ref at the moment the wait returned. */
export interface WaitSnapshot {
  ref: WaitRef;
  /** Task: its status. Agent: runtime state (null = pane gone). Delegate: the call's state. */
  status: string | null;
  substate?: string;
  owner?: string | null;
  ownerWorkstream?: string;
  incarnation?: string;
  runs?: number;
  lastText?: string;
  lastError?: string;
  sessionFile?: string;
  blocked?: CtlBlocked;
  unknownReason?: string;
  /** Agent: the ctl run count this wait counted from. */
  afterRuns?: number;
  /** Agent: observed busy during this wait. */
  wasBusy?: boolean;
  /** Delegate: the parsed verdict label of a done answer. */
  verdict?: string | null;
  /** The ref's completion condition is met (task at target, agent settled, delegate terminal). */
  fired: boolean;
  dead: boolean;
  /** What applying the settled run's CLOSE block did (agent refs; absent when none was tried). */
  close?: CloseOutcome;
}

export interface WaitResult {
  event: WaitEvent;
  /** Targets in input order, then the delivered refs that are not targets. */
  refs: WaitSnapshot[];
  timedOut: boolean;
  interrupted: boolean;
  /** 0 fired or timed out, 6 dead, 7 input or stall, 130 interrupted. */
  exit: 0 | 6 | 7 | 130;
  /** The caller's consumed tokens after this wait (empty without a caller). */
  cursor: Record<string, CursorToken>;
  /** The wave's tally, when `wave` was given. */
  wave?: VerdictTally;
  /** True when a newer wait of this caller superseded this one: nothing was consumed. */
  superseded?: boolean;
  /** Everything watched is done and was already delivered: nothing is owed. */
  drained?: boolean;
}

/** What an agent read or watch reports; an AgentObservation satisfies it. */
export interface AgentReading {
  status: RuntimeState | null;
  settled?: boolean;
  reason?: string;
  incarnation?: string;
  runs?: number;
  pending?: boolean;
  blocked?: CtlBlocked;
  lastText?: string;
  lastTextTruncated?: boolean;
  lastError?: string;
  sessionFile?: string;
  agentId?: number;
}

export interface AgentWatchHandle {
  initial: AgentReading;
  afterRuns?: number;
  /** Resolves when the run ends. A REJECTION is fatal (the agent restarted). */
  settled: Promise<AgentReading>;
}

export interface WaitOptions {
  /** Whose registration, cursors and delegate calls this wait owns. Without one there are none. */
  caller?: string;
  /** Delegate calls of this wave (this caller's) are targets; the result carries their tally. */
  wave?: { workstream: string; name: string };
  /** The open transitive blockers of this task are targets, re-read each iteration. */
  blockersOf?: { workstream: string; id: string };
  /** Every target must be done (default: the first event ends the wait). */
  all?: boolean;
  /** Task target status (default CLOSED). */
  status?: TaskStatus;
  /** `idle` (default): a run ending. `text`: a bounded regex over a settled run's lastText or a done task's report. */
  until?: "idle" | { text: string };
  /** Default and cap WAIT_HEARTBEAT_CAP_MS; 0 means the cap. */
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called before every iteration; a throw propagates. */
  beforePoll?: () => Promise<void>;
  /** One batched, non-blocking read per iteration, keyed `<workstream>/<name>`. */
  readAgents?: (
    refs: readonly WaitRef[],
    signal: AbortSignal,
  ) => Promise<ReadonlyMap<string, AgentReading>>;
  /**
   * The blocking read of a future settle (the ctl `wait`): raced, never
   * awaited serially. undefined = poll the agent instead. `ctx.owed` marks a
   * ref the caller only owns (registered): its unconsumed runs still count,
   * so with no `ref.afterRuns` the hook counts past `ctx.cursor` (same
   * incarnation) or from run 0.
   */
  watchAgent?: (
    ref: WaitRef,
    signal: AbortSignal,
    ctx: { owed: boolean; cursor?: CursorToken },
  ) => Promise<AgentWatchHandle | undefined>;
  /** Apply settled CLOSE blocks (default true). Needs ctl facts: a polled reading never closes. */
  applyClose?: boolean;
  /** Ingest peers every iteration and flush before returning (default true). */
  sync?: boolean;
  /** Called once when every watched agent target reads unknown on the first iteration. */
  onInitialUnknown?: (agents: readonly WaitSnapshot[]) => void;
  /** Called with the targets' snapshots every iteration, before the pick; a throw propagates (the task adapter's stuck logic). */
  inspect?: (snaps: readonly WaitSnapshot[]) => Promise<void>;
  /** Poll sleep seam (the adapters'). Default: an abortable timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Adapters only: timeoutMs 0 means forever and there is no cap, as the legacy waits had it. */
  uncapped?: boolean;
}

/** A wait with nothing to wait for. */
export class WaitNothingError extends Error {
  override readonly name = "WaitNothingError";
  constructor() {
    super("wait: nothing to wait for (no refs given and none owed to this caller)");
  }
}

/** A ref the caller may not wait on (another caller's delegate call). */
export class WaitRefError extends Error {
  override readonly name = "WaitRefError";
}
