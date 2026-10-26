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
// The cap counts every effect (replays, probes, spawns, failures); the
// default is finite. `dry` is the same selection over the shared read-only
// planner: no ingest, lock, mux call, receipt probe or write.

import { SpawnAttemptBusyError, SpawnAttemptGuardError } from "./agents/errors.js";
import { spawnAutoAttempt, type TaskSpawnOutcome } from "./agents/task-spawn.js";
import {
  type AttemptPlan,
  type AttemptRecord,
  pendingAttempts,
  planAttempt,
  readAttempt,
  reserveAttempt,
} from "./auto-attempt.js";
import type { Db } from "./db.js";
import { type HumanNeeded, openHumanNeeds } from "./human-needed.js";
import { NoMultiplexerError } from "./mux/types.js";
import { ambientIngest } from "./sync.js";
import { authorisedReady, autoPermitted } from "./task-auto.js";
import { buildTaskBrief } from "./task-brief.js";
import { taskIdFor } from "./tasks/core.js";
import { listReady } from "./tasks/queries.js";

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
  /** `spawn` (new attempt), `replay` (stored attempt resumed), `skip` (nothing done), `failed` (unsent). */
  kind: "spawn" | "replay" | "skip" | "failed";
  task: string;
  attempt?: number;
  key?: string;
  agent?: string;
  cli?: string;
  /** `sent`, `unknown`, or (dry replay) the receipt state it would resume from. */
  state?: string;
  reason?: string;
  stale?: "deleted" | "replaced";
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

  for (;;) {
    if (out.used >= cap) {
      if (select(db, ws, done) !== undefined) out.stopped = "cap";
      return out;
    }
    if (!out.dry) await ingest();
    if (humanStop()) return out;
    const next = select(db, ws, done);
    if (next === undefined) return out;
    done.add(next.task);
    if (out.dry) {
      const move = planMove(db, ws, next.task, next.resume);
      out.moves.push(move);
      if (move.kind !== "skip") out.used++;
      continue;
    }
    const move = next.resume ? await resume(db, ws, next.task) : await allocate(db, ws, next.task);
    out.moves.push(move);
    if (move.kind === "skip") continue; // nothing was done: no budget spent, and `done` ends the retry
    out.used++;
    if (move.kind === "failed") {
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
    if (record !== undefined) {
      return {
        kind: "replay",
        task,
        attempt: record.attempt,
        key: record.key,
        agent: receipt?.name ?? record.name,
        cli: record.cli,
        ...(receipt !== undefined ? { state: receipt.state } : {}),
      };
    }
  }
  const planned = planAttempt(db, ws, task);
  if (!planned.ok) return { kind: "skip", task, reason: planned.reason };
  const p = planned.plan;
  return { kind: "spawn", task, attempt: p.attempt, key: p.key, agent: p.name, cli: p.cli };
}

/** The guard of an attempt: permission (and, before the pane, still ready) just before each effect. */
function guardOf(db: Db, ws: string, task: string, key: string) {
  return (phase: "spawn" | "send"): void => {
    const taskId = taskIdFor(db, task, ws);
    const stop = (why: string): never => {
      throw new SpawnAttemptGuardError(task, key, why);
    };
    if (taskId === null || !autoPermitted(db, taskId)) {
      stop("it is no longer authorised for this machine");
    }
    if (phase === "spawn" && !listReady(db, ws).some((t) => t.name === task)) {
      stop("it is no longer ready");
    }
  };
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
  };
}

/** Run one reserved or stored attempt through the guarded spawn; map its unsent errors to moves. */
async function drive(
  db: Db,
  ws: string,
  task: string,
  kind: "spawn" | "replay",
  rec: AttemptRecord,
  text: string,
): Promise<NextMove> {
  try {
    const out = await spawnAutoAttempt(db, {
      task,
      text,
      key: rec.key,
      guard: guardOf(db, ws, task, rec.key),
      spawn: {
        name: rec.name,
        workstream: ws,
        cli: rec.cli,
        ...(rec.worktree ? { worktree: true } : {}),
        nextFree: true,
      },
    });
    return outcomeMove(kind, task, rec, out);
  } catch (err) {
    if (err instanceof NoMultiplexerError) throw err;
    const base = { task, attempt: rec.attempt, key: rec.key, cli: rec.cli };
    if (err instanceof SpawnAttemptBusyError) {
      // Another mu holds this attempt: nothing was done here.
      return { kind: "skip", ...base, reason: `attempt in flight: ${err.message}` };
    }
    if (err instanceof SpawnAttemptGuardError) {
      // Permission or readiness moved. Before the pane the reservation stays
      // resumable; at the send the attempt was rolled back and failed (charged).
      return { kind: "skip", ...base, reason: err.message };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "failed", ...base, reason };
  }
}

async function resume(db: Db, ws: string, task: string): Promise<NextMove> {
  const taskId = taskIdFor(db, task, ws);
  const { record } = taskId === null ? {} : readAttempt(db, taskId);
  if (record === undefined) return { kind: "skip", task, reason: "no stored attempt" };
  // The stored pins, not the newest notes: the replay must be the request that was reserved.
  const brief = buildTaskBrief(db, ws, task, {
    retry: record.retry,
    pin: { brief: record.brief, report: record.report },
  });
  return drive(db, ws, task, "replay", record, brief.text);
}

async function allocate(db: Db, ws: string, task: string): Promise<NextMove> {
  const reserved = reserveAttempt(db, ws, task);
  if (!reserved.ok) {
    return {
      kind: "skip",
      task,
      reason: `attempt ${reserved.code === "in-flight" ? "in flight" : reserved.code}: ${reserved.reason}`,
    };
  }
  const p: AttemptPlan = reserved.plan;
  return drive(db, ws, task, "spawn", p, p.text);
}
