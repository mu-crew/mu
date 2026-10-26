// mu — `executeNext`: the executor, slice A (dispatch).
//
// `mu next` performs the judgement-free moves for tasks the orchestrator
// authorised HERE (`mu task auto`): it recovers dead and API-errored workers,
// resumes stored attempts, then spawns, claims and briefs ready ones. It never
// grants or widens permission (`authorizeTasks` is not called; `autoPermitted`
// is only read), never decides acceptance, merge or teardown.
//
// One pass, one ordered rule per iteration (cap check, signal, ingest, this
// caller's human needs, then selection from FRESH state):
//   0. once per pass, a scan of the in-flight workers (src/next-recover.ts): a
//      DEAD local one is reaped through `deleteAgent`'s id + pane CAS (its task
//      reopens and falls to rule 2 as a retried attempt); a LIVE one whose last
//      run ended in an API error is retried IN PLACE (one run charged, the same
//      pane, a reserved msgId bound to pi's incarnation). A remote worker's
//      tree is never touched; what cannot be acted on is an `attention` move;
//   1. a stored attempt in flight (reserved … unknown) of a permitted task is
//      RESUMED under its own key, even at its run ceiling (`pendingAttempts`);
//   2. else the first `authorisedReady` task gets a NEW attempt: the run is
//      charged and the attempt reserved in one transaction (src/auto-attempt.ts),
//      then spawned through the guarded `spawnAutoAttempt`.
// `hold` then waits (waitWithActions, bounded) for the first event on the
// in-flight workers: a death or an API-errored settle is the executor's own
// (recover, then wait again, all inside the cap and deadline); any other event
// is the orchestrator's and ends the invocation. `signal` stops it between
// effects: an effect in flight finishes (it is journaled, never half-done) and
// the one result says `interrupted`.
// Every stored attempt reaches a terminal state on the FIRST invocation that
// sees it unreconcilable (`endAttempt`): `abandoned` (task closed, agent gone
// before anything was sent) or `needs_human` (the prompt may have landed and
// cannot be confirmed: never resent; a one-line human need is recorded for
// the caller). It is then never replayed and never counted again. A replay
// sends the STORED prompt, never a rebuild. The cap counts every effect
// (replays, probes, spawns, failures, a spawn rolled back by the guard); the
// default is finite. This caller's human need is checked at the top of the
// loop AND right before each spawn and send. `dry` is the same selection over
// the shared read-only planner: no ingest, lock, mux call, receipt probe or
// write.

import {
  AgentRestartedError,
  SpawnAttemptBusyError,
  SpawnAttemptGuardError,
} from "./agents/errors.js";
import { getReceipt, type SpawnReceipt } from "./agents/receipts.js";
import { savedIdentity, spawnAutoAttempt, type TaskSpawnOutcome } from "./agents/task-spawn.js";
import { deleteAgent, getAgent as getAgentRow } from "./agents.js";
import {
  type AttemptEnd,
  type AttemptRecord,
  endAttempt,
  IN_FLIGHT_STATES,
  pendingAttempts,
  planAttempt,
  readAttempt,
  reserveAttempt,
  reserveRetry,
} from "./auto-attempt.js";
import type { Db } from "./db.js";
import { type HumanNeeded, openHumanNeeds, recordHumanNeeded } from "./human-needed.js";
import { NoMultiplexerError } from "./mux/types.js";
import {
  exhaustedAfterDeath,
  idleOnCtl,
  inFlightWorkers,
  liveWorkers,
  OBSERVE_MS,
  type ObserveWorkers,
  observeWorkers,
  type RecoveryAction,
  scanRecovery,
  workerKey,
} from "./next-recover.js";
import { ambientIngest } from "./sync.js";
import { authorisedReady, autoPermitted } from "./task-auto.js";
import { taskIdFor } from "./tasks/core.js";
import { getTask, listReady } from "./tasks/queries.js";
import { waitWithActions } from "./wait-actions.js";
import { ctlAgentHooks } from "./wait-ctl.js";
import {
  WAIT_HEARTBEAT_CAP_MS,
  type WaitOptions,
  type WaitRef,
  type WaitResult,
} from "./wait-types.js";

/** Bad `--cap`: exit 2, nothing done. */
export class NextArgError extends Error {
  override readonly name = "NextArgError";
}

/** Effects one invocation may perform unless `cap` says otherwise. */
export const DEFAULT_NEXT_CAP = 5;
/** The largest `cap` accepted. */
export const MAX_NEXT_CAP = 100;

export interface ExecuteNextOptions {
  workstream: string;
  /** Who is asking (`spawnerFromEnv()`): its open human needs stop dispatch. */
  caller: string;
  /** Plan only: zero writes. */
  dry?: boolean;
  /** Effect budget, an integer 1..100 (default 5). */
  cap?: number;
  /**
   * Worker ceiling: no new pane while this many workers are working (an
   * IN_PROGRESS task, or an attempt in flight); a worker whose task is CLOSED
   * is free. Default: none. Recovery in place and replays that need no pane
   * are never held back.
   */
  workers?: number;
  /** Pull peer state before each effect. Default: the ambient sync ingest. */
  ingest?: () => Promise<unknown>;
  /** After the pass, wait (bounded) for the first event on the in-flight workers; recover and go on while the event is the executor's own. */
  hold?: boolean;
  /** `hold`'s total deadline in ms (default and cap: the wait heartbeat, 1500 s). */
  timeoutMs?: number;
  /** `hold`: what a stall does (default `exit`: the stall ends the invocation). */
  onStall?: "exit" | "warn" | "steer" | "release";
  /** Stop between effects; an effect in flight finishes. The result says `interrupted`. */
  signal?: AbortSignal;
  /** Test seams: the worker reader and the wait. */
  observe?: ObserveWorkers;
  wait?: (db: Db, refs: readonly WaitRef[], o: WaitOptions) => Promise<WaitResult>;
}

export interface NextMove {
  /**
   * `spawn` (new attempt), `replay` (stored attempt resumed), `skip` (nothing
   * done), `failed` (unsent), `rolled_back` (a pane was spawned, then the guard
   * stopped the send: undone, charged), `abandoned` (a stored attempt ended:
   * nothing left to do), `needs_human` (a stored attempt that may have landed
   * and cannot be confirmed: never resent, a human need recorded), `retry`
   * (a live worker that stopped on an API error was sent its brief again, in
   * place), `reap` (a dead worker's row was removed; its task is open again),
   * `attention` (something that needs the orchestrator and was NOT acted on).
   */
  kind:
    | "spawn"
    | "replay"
    | "retry"
    | "reap"
    | "attention"
    | "skip"
    | "failed"
    | "rolled_back"
    | "abandoned"
    | "needs_human";
  task: string;
  attempt?: number;
  key?: string;
  agent?: string;
  cli?: string;
  /** `sent`, `unknown`, or (dry replay) the receipt state it would resume from. */
  state?: string;
  reason?: string;
  stale?: "deleted" | "replaced";
  /** The one receipt probe a replay made, when it made one. */
  checked?: "accepted" | "not-accepted" | "unreachable";
}

export interface NextResult {
  workstream: string;
  dry: boolean;
  cap: number;
  /** Effects counted against the cap. */
  used: number;
  moves: NextMove[];
  /** Why the loop ended early: the cap with work left, this caller's human need, an unsent failure, or a signal. */
  stopped?: "cap" | "human" | "failed" | "interrupted" | "workers";
  /** Dry only: the in-flight workers a live run would observe (a dry run reads no pane and no socket). */
  inFlight?: string[];
  human_needed?: HumanNeeded[];
  /** `hold`: the wait(s) that ended the invocation. */
  held?: {
    /** Waits taken (each recovered event starts another pass). */
    waits: number;
    /** The event that ended the hold: the engine's kind, or `none` (nothing in flight). */
    event: string;
    ref: string | null;
    exit: 0 | 6 | 7 | 130;
    timedOut: boolean;
    /** The ended wait's snapshots of the in-flight workers, cut to what a reader needs. */
    open: { ref: string; status: string | null; lastError?: string }[];
  };
}

function checkCap(cap: number | undefined): number {
  if (cap === undefined) return DEFAULT_NEXT_CAP;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_NEXT_CAP) {
    throw new NextArgError(`--cap must be an integer from 1 to ${MAX_NEXT_CAP} (got ${cap})`);
  }
  return cap;
}

function checkWorkers(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 1 || n > MAX_NEXT_CAP) {
    throw new NextArgError(`--workers must be an integer from 1 to ${MAX_NEXT_CAP} (got ${n})`);
  }
  return n;
}

function checkTimeout(ms: number | undefined): number {
  if (ms === undefined) return WAIT_HEARTBEAT_CAP_MS;
  if (!Number.isFinite(ms) || ms < 0) {
    throw new NextArgError(`--timeout must be a number of seconds, 0 or more (got ${ms / 1000})`);
  }
  return ms === 0 ? WAIT_HEARTBEAT_CAP_MS : Math.min(ms, WAIT_HEARTBEAT_CAP_MS);
}

/** The first candidate not yet handled this invocation: stored attempts, then fresh ready work. */
function select(
  db: Db,
  ws: string,
  done: ReadonlySet<string>,
): { task: string; resume: boolean } | undefined {
  const pending = pendingAttempts(db, ws).find((t) => !done.has(t));
  if (pending !== undefined) return { task: pending, resume: true };
  const ready = authorisedReady(db, ws).find((t) => !done.has(t.name));
  return ready === undefined ? undefined : { task: ready.name, resume: false };
}

/** Would running this candidate create a pane? A fresh attempt, or a stored one that never got one. */
function needsPane(db: Db, ws: string, c: { task: string; resume: boolean }): boolean {
  if (!c.resume) return true;
  const id = taskIdFor(db, c.task, ws);
  const receipt = id === null ? undefined : readAttempt(db, id).receipt;
  return receipt?.state === "reserved";
}

/** Does this move cost an external effect (a spawn, send, probe or rollback)? */
function counts(m: NextMove): boolean {
  if (m.kind === "skip" || m.kind === "abandoned" || m.kind === "attention") return false;
  if (m.kind === "needs_human") return m.checked !== undefined;
  return true;
}

/** What one live invocation shares with its steps. */
interface Ctx {
  db: Db;
  ws: string;
  caller: string;
  /** This caller's open human need? Records the stop on the result when so. */
  humanStop: () => boolean;
  /** The worker ceiling, when one was given. */
  workers: number | undefined;
}

/** Thrown out of a hold's `beforePoll` when this caller's human need opened mid-wait. */
class HoldHumanStop extends Error {}

const DEAD_OR_ERRORED = (r: WaitResult): boolean => {
  const e = r.event;
  if (e.kind === "dead") return true;
  if (e.kind !== "settled" || e.ref === null) return false;
  const snap = r.refs.find(
    (s) =>
      s.ref.kind === e.ref?.kind && s.ref.workstream === e.ref.workstream && s.ref.id === e.ref.id,
  );
  return snap?.lastError !== undefined && snap.close?.applied !== true;
};

const refText = (r: WaitRef): string =>
  r.kind === "delegate" ? `delegate:${r.id}` : `${r.kind}:${r.workstream}/${r.id}`;

export async function executeNext(db: Db, opts: ExecuteNextOptions): Promise<NextResult> {
  const cap = checkCap(opts.cap);
  const timeoutMs = checkTimeout(opts.timeoutMs);
  const workers = checkWorkers(opts.workers);
  const ws = opts.workstream;
  const out: NextResult = { workstream: ws, dry: opts.dry === true, cap, used: 0, moves: [] };
  const done = new Set<string>();
  const ingest = opts.ingest ?? (() => ambientIngest(db, { quiet: true }));
  const humanStop = (): boolean => {
    const needs = openHumanNeeds(db, opts.caller);
    if (needs.length === 0) return false;
    out.stopped = "human";
    out.human_needed = needs;
    return true;
  };
  const ctx: Ctx = { db, ws, caller: opts.caller, humanStop, workers };
  const observe = opts.observe ?? observeWorkers(db);
  const deadline = Date.now() + timeoutMs;
  const aborted = (): boolean => {
    if (opts.signal?.aborted !== true) return false;
    out.stopped = "interrupted";
    return true;
  };

  /** What is left that only the orchestrator can fix: a dead worker whose task has no run left. Once per task per invocation. */
  const told = new Set<string>();
  const tell = (task: string, reason: string, agent?: string): void => {
    if (told.has(`${task}|${reason}`)) return;
    told.add(`${task}|${reason}`);
    out.moves.push({ kind: "attention", task, ...(agent !== undefined ? { agent } : {}), reason });
  };
  const attend = (): void => {
    for (const a of exhaustedAfterDeath(db, ws)) tell(a.task, a.reason);
  };

  /** One pass: recover, resume, then allocate, until nothing is left, the cap, a human need, a failure or a signal. */
  const pass = async (): Promise<void> => {
    let actions: Extract<RecoveryAction, { kind: "reap" | "retry" }>[] | undefined;
    for (;;) {
      if (aborted()) return;
      if (out.used >= cap) {
        if (
          out.stopped === undefined &&
          (select(db, ws, done) !== undefined || (actions?.length ?? 0) > 0)
        ) {
          out.stopped = "cap";
        }
        return;
      }
      if (!out.dry) await ingest();
      if (aborted()) return;
      if (humanStop()) return;
      if (actions === undefined) {
        // One scan per pass, after the first ingest: attention is free, effects are queued.
        const found: RecoveryAction[] = out.dry
          ? []
          : await scanRecovery(
              db,
              ws,
              observe,
              opts.signal !== undefined ? { signal: opts.signal } : {},
            );
        if (aborted()) return;
        if (out.dry) out.inFlight = inFlightWorkers(db, ws).map((w) => w.task);
        actions = [];
        for (const a of found) {
          if (a.kind === "attention") tell(a.task, a.reason, a.agent);
          else actions.push(a);
        }
      }
      const act = actions.shift();
      if (act !== undefined && !out.dry) {
        const move = await recover(ctx, act, observe, opts.signal);
        // A retried worker is done for this pass: its own unknown send is probed by the NEXT invocation.
        if (act.kind === "retry") done.add(act.task);
        out.moves.push(move);
        if (counts(move)) out.used++;
        if (move.kind === "failed") {
          out.stopped = "failed";
          return;
        }
        continue;
      }
      const next = select(db, ws, done);
      if (next === undefined) {
        attend();
        return;
      }
      if (workers !== undefined && needsPane(db, ws, next) && liveWorkers(db, ws) >= workers) {
        // Nothing reserved, nothing charged: a slot frees when a worker's task closes.
        tell(
          next.task,
          `worker ceiling ${workers} reached (${liveWorkers(db, ws)} working): no new pane until one finishes`,
        );
        out.stopped = "workers";
        return;
      }
      done.add(next.task);
      const move = out.dry
        ? planMove(db, ws, next.task, next.resume)
        : next.resume
          ? await resume(ctx, next.task)
          : await allocate(ctx, next.task);
      out.moves.push(move);
      if (counts(move)) out.used++;
      if (move.kind === "failed" && !out.dry) {
        out.stopped = "failed";
        return;
      }
    }
  };

  for (let waits = 0; ; ) {
    const before = out.used;
    await pass();
    // A ceiling stop is what `--hold` is for: a worker closing frees the slot.
    const atCeiling = out.stopped === "workers";
    if (opts.hold !== true || out.dry || (out.stopped !== undefined && !atCeiling)) return out;
    if (waits > 0 && out.used === before) return out; // the event was the executor's, and it could do nothing
    const inFlight = inFlightWorkers(db, ws);
    if (inFlight.length === 0) {
      out.held = { waits, event: "none", ref: null, exit: 0, timedOut: false, open: [] };
      return out;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      out.held = { waits, event: "heartbeat", ref: null, exit: 0, timedOut: true, open: [] };
      return out;
    }
    const refs: WaitRef[] = inFlight.flatMap((w): WaitRef[] => [
      { kind: "task", workstream: ws, id: w.task },
      {
        kind: "agent",
        workstream: w.agent.workstreamName,
        id: w.agent.name,
        ...(w.runs !== null ? { afterRuns: w.runs } : {}),
        ...(w.incarnation !== null ? { incarnation: w.incarnation } : {}),
      },
    ]);
    waits++;
    let res: WaitResult;
    try {
      res = await (opts.wait ?? waitWithActions)(db, refs, {
        callers: opts.caller === "" ? [] : [opts.caller],
        mode: "first",
        eventScope: "refs",
        timeoutMs: left,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        onStall: opts.onStall ?? "exit",
        ...ctlAgentHooks(db),
        beforePoll: async () => {
          if (humanStop()) throw new HoldHumanStop();
        },
      });
    } catch (err) {
      if (err instanceof HoldHumanStop) return out;
      if (err instanceof AgentRestartedError) {
        out.moves.push({ kind: "attention", task: "", reason: err.message });
        out.held = { waits, event: "restarted", ref: null, exit: 7, timedOut: false, open: [] };
        return out;
      }
      throw err;
    }
    out.held = {
      waits,
      event: res.event.kind,
      ref: res.event.ref === null ? null : refText(res.event.ref),
      exit: res.exit,
      timedOut: res.timedOut,
      open: res.refs
        .filter((x) => !x.fired && !x.dead)
        .slice(0, 8)
        .map((x) => ({
          ref: refText(x.ref),
          status: x.status,
          ...(x.lastError !== undefined ? { lastError: x.lastError.slice(0, 200) } : {}),
        })),
    };
    if (res.interrupted) {
      out.stopped = "interrupted";
      return out;
    }
    const freed = atCeiling && res.event.kind === "closed";
    if (res.event.kind === "heartbeat" || (!DEAD_OR_ERRORED(res) && !freed)) return out;
    if (atCeiling) out.stopped = undefined;
    done.clear();
  }
}

/** The dry plan of one candidate: what a live run would do, read-only. */
function planMove(db: Db, ws: string, task: string, resume: boolean): NextMove {
  const taskId = taskIdFor(db, task, ws);
  if (resume && taskId !== null) {
    const { record, receipt } = readAttempt(db, taskId);
    if (record !== undefined && receipt !== undefined) {
      const base = { task, attempt: record.attempt, key: record.key, cli: record.cli };
      const end = unreconcilable(db, ws, task, receipt);
      if (end !== undefined) return { kind: end.state, ...base, reason: end.reason };
      return {
        kind: "replay",
        ...base,
        agent: receipt.name,
        state: receipt.state,
      };
    }
  }
  const planned = planAttempt(db, ws, task);
  if (!planned.ok) return { kind: "skip", task, reason: planned.reason };
  const p = planned.plan;
  return { kind: "spawn", task, attempt: p.attempt, key: p.key, agent: p.name, cli: p.cli };
}

/**
 * Can the stored attempt never progress? Read-only. `abandoned`: nothing was
 * sent, or the task is over. `needs_human`: the prompt may have landed and
 * there is nothing to ask. Undefined: it can still be resumed (or probed).
 */
function unreconcilable(
  db: Db,
  ws: string,
  task: string,
  receipt: SpawnReceipt,
): AttemptEnd | undefined {
  const t = getTask(db, task, ws);
  if (t === undefined) return { state: "abandoned", reason: "the task is gone" };
  if (t.status === "CLOSED") return { state: "abandoned", reason: "the task is closed" };
  const sent = receipt.state === "sending" || receipt.state === "unknown";
  const lost = (reason: string): AttemptEnd => ({
    state: sent ? "needs_human" : "abandoned",
    reason,
  });
  if (receipt.state === "reserved") {
    return t.ownerId === null ? undefined : lost("the task is owned by another agent");
  }
  const id = savedIdentity(db, receipt);
  if (id.stale !== undefined) {
    return lost(`the agent of this attempt is ${id.stale}`);
  }
  if (sent && receipt.transport !== "ctl") {
    return lost("the send went through the pane: there is no receipt to ask");
  }
  return undefined;
}

/**
 * End a stored attempt (terminal: never replayed or counted again). A
 * `needs_human` end first records the caller's one-line human need (a repeat
 * is a no-op), so a crash between the two leaves the attempt retryable.
 */
function park(ctx: Ctx, task: string, record: AttemptRecord, end: AttemptEnd): NextMove {
  // A caller with no identity (a plain shell) has no human-need record to keep: the move says it.
  if (end.state === "needs_human" && ctx.caller !== "") {
    recordHumanNeeded(ctx.db, {
      workstream: ctx.ws,
      caller: ctx.caller,
      reason: `attempt ${record.key} of task ${task} may have been delivered and cannot be confirmed (${end.reason}); never resent`,
    });
  }
  const taskId = taskIdFor(ctx.db, task, ctx.ws);
  if (taskId !== null) endAttempt(ctx.db, taskId, record.key, end);
  return {
    kind: end.state,
    task,
    attempt: record.attempt,
    key: record.key,
    cli: record.cli,
    reason: end.reason,
  };
}

/** The guard of an attempt: this caller's human need and permission (and, before the pane, still ready) just before each effect. */
function guardOf(ctx: Ctx, task: string, key: string) {
  let refusedAt: "spawn" | "send" | undefined;
  const guard = (phase: "spawn" | "send"): void => {
    const stop = (why: string): never => {
      refusedAt = phase;
      throw new SpawnAttemptGuardError(task, key, why);
    };
    if (ctx.humanStop()) stop("this caller has an open human need");
    const taskId = taskIdFor(ctx.db, task, ctx.ws);
    if (taskId === null || !autoPermitted(ctx.db, taskId)) {
      stop("it is no longer authorised for this machine");
    }
    if (phase === "spawn" && !listReady(ctx.db, ctx.ws).some((t) => t.name === task)) {
      stop("it is no longer ready");
    }
    if (
      phase === "spawn" &&
      ctx.workers !== undefined &&
      liveWorkers(ctx.db, ctx.ws) >= ctx.workers
    ) {
      stop(`the worker ceiling ${ctx.workers} is reached`);
    }
  };
  return { guard, refusedAt: () => refusedAt };
}

function outcomeMove(
  kind: "spawn" | "replay" | "retry",
  task: string,
  rec: Pick<AttemptRecord, "attempt" | "key" | "cli">,
  out: TaskSpawnOutcome,
): NextMove {
  const reason = out.reason;
  return {
    kind,
    task,
    attempt: rec.attempt,
    key: rec.key,
    agent: out.agent?.name ?? out.receipt.name,
    cli: rec.cli,
    state: out.state,
    ...(out.stale !== undefined ? { stale: out.stale } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(out.checked !== undefined ? { checked: out.checked } : {}),
  };
}

/** Run one reserved or stored attempt through the guarded spawn, sending its STORED prompt; map its errors to moves. */
async function drive(
  ctx: Ctx,
  task: string,
  kind: "spawn" | "replay" | "retry",
  rec: AttemptRecord,
): Promise<NextMove> {
  const { db, ws } = ctx;
  const g = guardOf(ctx, task, rec.key);
  try {
    const out = await spawnAutoAttempt(db, {
      task,
      text: rec.text,
      key: rec.key,
      guard: g.guard,
      ...(rec.inPlace === true ? { keepAgent: true } : {}),
      spawn: {
        name: rec.name,
        workstream: ws,
        cli: rec.cli,
        ...(rec.worktree ? { worktree: true } : {}),
        nextFree: true,
      },
    });
    const move = outcomeMove(kind, task, rec, out);
    // A replay's probe that still cannot say: the attempt is parked, not probed again.
    if (kind === "replay" && out.state === "unknown") {
      return {
        ...park(ctx, task, rec, {
          state: "needs_human",
          reason: out.reason ?? "the send could not be confirmed",
        }),
        ...(out.checked !== undefined ? { checked: out.checked } : {}),
      };
    }
    return move;
  } catch (err) {
    if (err instanceof NoMultiplexerError) throw err;
    const base = { task, attempt: rec.attempt, key: rec.key, cli: rec.cli };
    if (err instanceof SpawnAttemptBusyError) {
      // Another mu holds this attempt: nothing was done here.
      return { kind: "skip", ...base, reason: `attempt in flight: ${err.message}` };
    }
    if (err instanceof SpawnAttemptGuardError) {
      // Before the pane nothing was done and the reservation stays resumable.
      // At the send a pane was spawned and rolled back: an effect, charged.
      const kind = g.refusedAt() === "send" ? "rolled_back" : "skip";
      return { kind, ...base, reason: err.message };
    }
    const reason = err instanceof Error ? err.message : String(err);
    // An error before any effect (a receipt that disagrees with its stored
    // request, a bad row) leaves the receipt in flight: end it now, or it
    // would be selected and fail on every invocation.
    const taskId = taskIdFor(db, task, ws);
    const left = taskId === null ? undefined : getReceipt(db, taskId, rec.key);
    if (left !== undefined && IN_FLIGHT_STATES.has(left.state)) {
      const sent = left.state === "sending" || left.state === "unknown";
      park(ctx, task, rec, { state: sent ? "needs_human" : "abandoned", reason });
    }
    return { kind: "failed", ...base, reason };
  }
}

async function resume(ctx: Ctx, task: string): Promise<NextMove> {
  const { db, ws } = ctx;
  const taskId = taskIdFor(db, task, ws);
  const { record, receipt } = taskId === null ? {} : readAttempt(db, taskId);
  if (record === undefined || receipt === undefined) {
    return { kind: "skip", task, reason: "no stored attempt" };
  }
  const end = unreconcilable(db, ws, task, receipt);
  if (end !== undefined) return park(ctx, task, record, end);
  return drive(ctx, task, "replay", record);
}

async function allocate(ctx: Ctx, task: string): Promise<NextMove> {
  const reserved = reserveAttempt(ctx.db, ctx.ws, task);
  if (!reserved.ok) {
    return {
      kind: "skip",
      task,
      reason: `attempt ${reserved.code === "in-flight" ? "in flight" : reserved.code}: ${reserved.reason}`,
    };
  }
  return drive(ctx, task, "spawn", reserved.plan);
}

/**
 * One recovery effect, re-validated at the effect (the scan was a moment ago).
 *   reap   the saved registry id + pane compare-and-swap of `deleteAgent` (a
 *          replaced name is kept); the task reopens with the reaper's note and
 *          is allocated again by the same pass, with the brief saying the
 *          previous attempt died. Local workers only.
 *   retry  re-read the worker (still idle on the same pi, at the errored run,
 *          nothing pending, no dialog), then one transaction charges the run
 *          and reserves the in-place attempt, then the guarded journaled send.
 */
async function recover(
  ctx: Ctx,
  act: Extract<RecoveryAction, { kind: "reap" | "retry" }>,
  observe: ObserveWorkers,
  signal: AbortSignal | undefined,
): Promise<NextMove> {
  const { db, ws } = ctx;
  const skip = (reason: string): NextMove => ({ kind: "skip", task: act.task, reason });
  if (ctx.humanStop()) return skip("this caller has an open human need");
  const taskId = taskIdFor(db, act.task, ws);
  if (taskId === null || !autoPermitted(db, taskId)) {
    return skip("it is no longer authorised for this machine");
  }
  if (act.kind === "reap") {
    // The CAS is the scan's saved id + pane (a replaced name is kept); the host is read NOW:
    // a worker that became remote since the scan is not ours to reap.
    const a = act.agent;
    const now = getAgentRow(db, a.name, a.workstreamName);
    if (now?.host != null) return skip("a remote worker is never reaped from here");
    const deleted = deleteAgent(db, a.name, a.workstreamName, {
      paneId: a.paneId,
      incarnation: a.incarnation,
    });
    return deleted
      ? { kind: "reap", task: act.task, agent: a.name, reason: act.why }
      : skip("the worker was replaced before it could be reaped");
  }
  const { agent } = act.target;
  const row = getAgentRow(db, agent.name, ws);
  if (row === undefined) return skip("the worker is gone");
  const now = (
    await observe([row], { ms: OBSERVE_MS, ...(signal !== undefined ? { signal } : {}) })
  ).get(workerKey(row));
  if (
    now === undefined ||
    !idleOnCtl(now) ||
    now.incarnation !== act.target.pi ||
    now.runs !== act.target.errorRuns ||
    now.lastError === undefined
  ) {
    return skip("the worker is no longer idle at the errored run: left to the wait");
  }
  const reserved = reserveRetry(db, ws, act.task, act.target);
  if (!reserved.ok) {
    return skip(
      `retry ${reserved.code === "ceiling" ? "ceiling" : reserved.code}: ${reserved.reason}`,
    );
  }
  const { task: _t, taskId: _i, workstream: _w, revision: _r, ...rec } = reserved.plan;
  const move = await drive(ctx, act.task, "retry", rec);
  return { ...move, reason: move.reason ?? `API error: ${act.error.slice(0, 200)}` };
}
