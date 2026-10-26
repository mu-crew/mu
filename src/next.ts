// mu — `executeNext`: the executor, slice A (dispatch).
//
// `mu next` performs the judgement-free moves for tasks the orchestrator
// authorised HERE (`mu task auto`): it resumes stored attempts, then spawns,
// claims and briefs ready ones. It never grants or widens permission
// (`authorizeTasks` is not called; `autoPermitted` is only read), never
// decides recovery, acceptance or merge. Recovery of a dead or API-errored
// worker, `--hold` and signals are slice B (v_exec_recover).
//
// One loop, one ordered rule per iteration (cap check, then ingest, then this
// caller's human needs, then selection from FRESH state):
//   1. a stored attempt in flight (reserved … unknown) of a permitted task is
//      RESUMED under its own key, even at its run ceiling (`pendingAttempts`);
//   2. else the first `authorisedReady` task gets a NEW attempt: the run is
//      charged and the attempt reserved in one transaction (src/auto-attempt.ts),
//      then spawned through the guarded `spawnAutoAttempt`.
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

import { SpawnAttemptBusyError, SpawnAttemptGuardError } from "./agents/errors.js";
import { getReceipt, type SpawnReceipt } from "./agents/receipts.js";
import { savedIdentity, spawnAutoAttempt, type TaskSpawnOutcome } from "./agents/task-spawn.js";
import {
  type AttemptEnd,
  type AttemptRecord,
  endAttempt,
  IN_FLIGHT_STATES,
  pendingAttempts,
  planAttempt,
  readAttempt,
  reserveAttempt,
} from "./auto-attempt.js";
import type { Db } from "./db.js";
import { type HumanNeeded, openHumanNeeds, recordHumanNeeded } from "./human-needed.js";
import { NoMultiplexerError } from "./mux/types.js";
import { ambientIngest } from "./sync.js";
import { authorisedReady, autoPermitted } from "./task-auto.js";
import { taskIdFor } from "./tasks/core.js";
import { getTask, listReady } from "./tasks/queries.js";

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
  /** Pull peer state before each effect. Default: the ambient sync ingest. */
  ingest?: () => Promise<unknown>;
}

export interface NextMove {
  /**
   * `spawn` (new attempt), `replay` (stored attempt resumed), `skip` (nothing
   * done), `failed` (unsent), `rolled_back` (a pane was spawned, then the guard
   * stopped the send: undone, charged), `abandoned` (a stored attempt ended:
   * nothing left to do), `needs_human` (a stored attempt that may have landed
   * and cannot be confirmed: never resent, a human need recorded).
   */
  kind: "spawn" | "replay" | "skip" | "failed" | "rolled_back" | "abandoned" | "needs_human";
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
  /** Why the loop ended early: the cap with work left, this caller's human need, or an unsent failure. */
  stopped?: "cap" | "human" | "failed";
  human_needed?: HumanNeeded[];
}

function checkCap(cap: number | undefined): number {
  if (cap === undefined) return DEFAULT_NEXT_CAP;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_NEXT_CAP) {
    throw new NextArgError(`--cap must be an integer from 1 to ${MAX_NEXT_CAP} (got ${cap})`);
  }
  return cap;
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

/** Does this move cost an external effect (a spawn, send, probe or rollback)? */
function counts(m: NextMove): boolean {
  if (m.kind === "skip" || m.kind === "abandoned") return false;
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
}

export async function executeNext(db: Db, opts: ExecuteNextOptions): Promise<NextResult> {
  const cap = checkCap(opts.cap);
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
  const ctx: Ctx = { db, ws, caller: opts.caller, humanStop };

  for (;;) {
    if (out.used >= cap) {
      if (out.stopped === undefined && select(db, ws, done) !== undefined) out.stopped = "cap";
      return out;
    }
    if (!out.dry) await ingest();
    if (humanStop()) return out;
    const next = select(db, ws, done);
    if (next === undefined) return out;
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
      return out;
    }
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
  if (end.state === "needs_human") {
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
  };
  return { guard, refusedAt: () => refusedAt };
}

function outcomeMove(
  kind: "spawn" | "replay",
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
  kind: "spawn" | "replay",
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
