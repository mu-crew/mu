// mu — the types and errors of waitForEvents (src/wait.ts): refs, events,
// snapshots, results, the options and the agent reader/watch shapes.

import type { RuntimeState, StateReading } from "./agent-state.js";
import type { AgentObservation } from "./agents/observe.js";
import type { CtlBlocked } from "./ctl/protocol.js";
import type { VerdictTally } from "./delegates.js";
import type { HumanNeeded } from "./human-needed.js";
import type { TaskStatus } from "./tasks/status.js";
import type { CursorToken } from "./wait-cursor.js";
import type { WaitRefKind } from "./wait-registration.js";

/** The heartbeat cap: no wait outlives it; a requested 0 means this. */
export const WAIT_HEARTBEAT_CAP_MS = 1_500_000;

/** Default `stuckAfterMs`: how long an IN_PROGRESS task's owner may sit needs_input before the wait reports a stall. */
export const DEFAULT_STUCK_AFTER_MS = 120_000;
/** The same for an owner read over a working control socket: ctl's idle is exact, so only an `orchestrator send` racing the settle needs the grace. */
export const DEFAULT_CTL_STUCK_AFTER_MS = 5_000;

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
  /** A remote command gate's command ended with a numeric status (`WaitResult.exit`, `snapshot.exit`). */
  | "exited"
  /** An agent with no control socket: its pane tail matched `until.text`. Never a settled run. */
  | "pane-text"
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
  /** Agent: the registry row id (a number; never pi's incarnation string). */
  agentId?: number;
  paneId?: string;
  /** Agent: true only for a ctl run that ended `settled`. */
  settled?: boolean;
  /** Agent: `lastText` lost its head to the cap, so a CLOSE block in it cannot be trusted. */
  lastTextTruncated?: boolean;
  /** Agent: `pane` when `lastText` is a non-pi pane's tail (no ctl text exists for it). */
  textSource?: "pane";
  /** Agent: the ctl run count this wait counted from. */
  afterRuns?: number;
  /** Agent: observed busy during this wait. */
  wasBusy?: boolean;
  /** Agent: owed with no fence and no cursor, so counted from the run count probed now: an earlier run is NOT reported as completion. */
  unknownBaseline?: boolean;
  /** Delegate: the parsed verdict label of a done answer. */
  verdict?: string | null;
  /** Delegate: its own task's local id (the answer is that task's report note), the `<ws>/<task>` it judges, its wave. */
  callTask?: string;
  record?: string;
  wave?: string;
  /** Task: its owner has been stalled long enough to report (IN_PROGRESS, owner needs_input or ctl broken). */
  stuck?: boolean;
  /** Task, stuck: why (`needs_input`, or the broken control socket's reason) and how long, in seconds. */
  stuckWhy?: string;
  stuckSecs?: number;
  /** Task, stuck: the owner's ctl settled-run count, when its socket answered (pi owners). */
  ownerRuns?: number;
  /** Agent (a remote command gate): the command's own numeric exit status, authoritative. */
  exit?: number;
  /** The ref's completion condition is met (task at target, agent settled, delegate terminal). */
  fired: boolean;
  dead: boolean;
  /** What applying the settled run's CLOSE block did (agent refs; absent when none was tried). On a stuck task: the owner's refused CLOSE. */
  close?: CloseOutcome;
}

/** What a handled stall did; `disposition` says whether the wait goes on. */
export interface StallActionResult {
  /** `continue`: keep waiting (the ref is not consumed). `return`: end the wait with the stall. */
  disposition: "continue" | "return";
  action: "steer" | "release";
  state: "sent" | "released" | "refused" | "unknown" | "budget-exhausted";
  msgId?: string;
  incarnation?: string;
  /** The ctl run baseline after a send: the wait counts the owner's next run from here. */
  afterRuns?: number;
  reason?: string;
}

/** What the engine knows when it hands a stall to `handleStall`. The hook owns policy and effects. */
export interface WaitStallContext {
  /** The caller that owns the stalled ref (the first of the set when none does). */
  caller: string;
  /** That caller's registration generation; null for an unregistered explicit wait (not a bypass of ownership). */
  generation: number | null;
  /** The stalled TASK (its owner is `owner`). */
  ref: WaitRef;
  /** `tasks.id` of the stalled task. */
  taskId: number;
  /** The task's revision when the stall was seen. */
  revision: number;
  /** The task's owner: registry id, pane and the authoritative ctl facts. */
  owner: AgentObservation;
  /** Stable for one observation of one stall: task, owner id, ctl incarnation, runs, since. */
  stallToken: string;
  /** Milliseconds left to the wait's deadline when the hook was called. */
  deadlineMs: number;
  /** Aborts when the wait aborts or returns: a not-yet-written action must not be written. */
  signal: AbortSignal;
}

export interface WaitResult {
  /** The event that ended the wait; `heartbeat` on a timeout, `interrupted` on an abort. */
  event: WaitEvent;
  /** Targets in input order, then the delivered refs that are not targets. */
  refs: WaitSnapshot[];
  timedOut: boolean;
  interrupted: boolean;
  /** 0 fired or timed out, 6 dead, 7 input or stall, 130 interrupted; an `exited` gate's own status (23 stays 23), the first nonzero of the gates that ended. */
  exit: number;
  /** The callers' consumed tokens after this wait (empty without callers). */
  cursor: Record<string, CursorToken>;
  /** Open human needs of the callers (never another caller's). */
  humanNeeds: HumanNeeded[];
  /** A delegate report fired: the other owned delegate reports this wait consumed with it. */
  alsoFiring?: WaitRef[];
  /** More ready delegate reports than one wait hands back: how many stay owed for the next wait. */
  alsoFiringMore?: number;
  /** The wave's tally over the callers' calls, when `wave` was given. */
  tally?: VerdictTally;
  /** What `handleStall` did for a returned stall. */
  action?: StallActionResult;
  /** True when a newer wait of the same caller superseded this one: nothing was consumed. */
  superseded?: boolean;
  /** Everything watched is done and was already delivered: nothing is owed. */
  drained?: boolean;
  /** The reaper-flip anchor this wait used: a resume of it keeps it. */
  sinceSeq?: number;
}

/** What an agent read or watch reports; an AgentObservation satisfies it. */
export interface AgentReading {
  status: RuntimeState | null;
  /** A remote command gate that ended: its numeric exit status (status is then null; `exit` decides, not "dead"). */
  exit?: number;
  settled?: boolean;
  reason?: string;
  incarnation?: string;
  runs?: number;
  pending?: boolean;
  blocked?: CtlBlocked;
  lastText?: string;
  lastTextTruncated?: boolean;
  /** `pane`: `lastText` is the tail of a NON-pi pane (it has no control socket, so no ctl text): matched by `until.text` only, never a CLOSE source. */
  textSource?: "pane";
  lastError?: string;
  sessionFile?: string;
  agentId?: number;
  paneId?: string;
  /** When the state began (ms epoch); stall detection reads it. */
  since?: number | null;
  source?: StateReading["source"];
  /** How the control socket answered (pi agents). */
  ctl?: StateReading["ctl"];
}

/** The unconsumed run baseline a producer registered for an agent ref. */
export interface AgentBaseline {
  afterRuns: number;
  incarnation?: string;
  agentId?: number;
}

export interface AgentWatchHandle {
  initial: AgentReading;
  afterRuns?: number;
  /** Set when an owed ref had no fence and no cursor: the baseline the watch probed and counted from. */
  unknownBaseline?: AgentBaseline;
  /** Resolves when the run ends. A REJECTION is fatal (the agent restarted). */
  settled: Promise<AgentReading>;
}

export interface WaitOptions {
  /**
   * Who owns this wait: a SET, because one orchestrator is known under two
   * names: the managed `<ws>/<agent>` (spawned workers, human needs) and
   * `pi:<session>` (delegate calls). Owned refs, delegates, human needs and
   * the wave tally are the union over the set. `[]` is an explicit-refs wait:
   * no registration, no cursors, no owned refs, never an all-caller fallback.
   * See `currentCallers`.
   */
  callers: readonly string[];
  /** `first` (default): the first event ends the wait. `all`: every target must be done. */
  mode?: "first" | "all";
  /** `owned` (default): the callers' owned refs also end the wait. `refs`: only the listed refs do. */
  eventScope?: "owned" | "refs";
  /** Delegate calls of this wave (the callers' only) are targets; the result carries their tally. */
  wave?: { workstream?: string; name: string };
  /** The open transitive blockers of this task are targets, re-read each iteration. */
  blockersOf?: { workstream: string; id: string };
  /** Task target status (default CLOSED). */
  status?: TaskStatus;
  /** `idle` (default): a run ending. `text`: a bounded regex over a settled run's lastText or a done task's report. */
  until?: "idle" | { text: string };
  /** Default and cap WAIT_HEARTBEAT_CAP_MS; 0 means the cap. */
  timeoutMs?: number;
  /** Ops seq a reaper flip must come after to be a death this wait reports (default: the ops head at start; a resume passes the stored one). */
  sinceSeq?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /**
   * How long an IN_PROGRESS work task's owner may sit needs_input (or with a
   * dead control socket) before the wait reports a `stall`. Default 120 s,
   * 5 s for an owner read over a working ctl socket; an explicit value
   * applies to both; 0 disables detection.
   */
  stuckAfterMs?: number;
  /**
   * `exit` (default): a stall ends the wait. `warn`: the stall is flagged
   * (`stuck` on the snapshot, an `agent.stall` event) and the wait goes on.
   * `steer`/`release`: call `handleStall` (no handler: same as exit).
   */
  onStall?: "exit" | "warn" | "steer" | "release";
  /**
   * Narrow what the callers OWN to one workstream: registered and discovered
   * refs by their workstream, delegate calls by their own or their record's.
   * Explicit refs, a wave and `blockersOf` are never narrowed.
   */
  scope?: string;
  /** Raced with the loop, never awaited serially; called once per `stallToken`. */
  handleStall?: (ctx: WaitStallContext) => Promise<StallActionResult>;
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
   * ref the callers have registered (explicit or not): its unconsumed runs
   * still count, from the fence, else the cursor, else the probed run count.
   * `ctx.baseline` is the producer's registered unconsumed baseline (already
   * checked against the registry id; the hook checks the incarnation) and
   * `ctx.cursor` the consumed token.
   */
  watchAgent?: (
    ref: WaitRef,
    signal: AbortSignal,
    ctx: { owed: boolean; cursor?: CursorToken; baseline?: AgentBaseline },
  ) => Promise<AgentWatchHandle | undefined>;
  /** Apply settled CLOSE blocks (default true). Needs ctl facts: a polled reading never closes. */
  applyClose?: boolean;
  /** Ingest peers every iteration and flush before returning (default true). */
  sync?: boolean;
  /** Called every iteration with the snapshots of everything the wait is watching (the CLI's heartbeat and stall warning). */
  onPicture?: (snaps: readonly WaitSnapshot[]) => void;
  /** Called once when every watched agent target reads unknown on the first iteration. */
  onInitialUnknown?: (agents: readonly WaitSnapshot[]) => void;
  /** Poll sleep seam. Default: an abortable timer. */
  sleep?: (ms: number) => Promise<void>;
  /** `mu agent wait`: timeoutMs 0 means forever and there is no heartbeat cap. */
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
