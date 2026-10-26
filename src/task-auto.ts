// mu — `mu task auto`: explicit, host-fenced permission for the executor.
//
// Ready is not permission. A task is dispatched by `mu next` only when the
// orchestrator authorised it HERE: a machine-local `task_auto` row
// (cli key, worktree mode, run ceiling, `enabled`) AND the synced
// `tasks.dispatch_host` naming this machine, the one host allowed to
// dispatch it. Both are written in ONE op-context transaction.
//
// `--off` flips `enabled` to 0 and keeps the row: `runs` and `last_spawn`
// (the spawn-replay receipt) must survive a re-authorisation, so nothing
// here ever DELETEs or REPLACEs a `task_auto` row.
//
// Two predicates, deliberately separate:
//   autoPermitted(db, taskId)  may this machine steer/release/dispatch the
//                              task? Status-independent (IN_PROGRESS and
//                              exhausted tasks still answer yes).
//   authorisedReady(db, ws)    ready AND permitted AND runs < max_runs.

import type { Db } from "./db.js";
import { say } from "./messages.js";
import { withOpContext } from "./op-context.js";
import { localMachineId } from "./segments.js";
import { type TaskRow, taskIdFor } from "./tasks/core.js";
import { TaskNotFoundError } from "./tasks/errors.js";
import { getTask, listReady } from "./tasks/queries.js";
import { RESERVED_WORKSTREAM_NAMES } from "./workstream.js";

/** A cli key: the lookup key of `MU_<UPPER_CLI>_COMMAND` (hyphen or underscore). */
const CLI_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A refusal that leaves everything unwritten (exit 4). */
export class TaskAutoRefusedError extends Error {
  override readonly name = "TaskAutoRefusedError";
  constructor(
    message: string,
    public readonly workstream: string,
    public readonly taskId: string,
  ) {
    super(message);
  }
}

/** A bad `--cli` / `--max` / empty selection (exit 2). */
export class TaskAutoArgError extends Error {
  override readonly name = "TaskAutoArgError";
}

export interface AuthorizeTasksOptions {
  workstream: string;
  /** The model key `mu next` spawns with. Ignored by `off`. */
  cli: string;
  worktree: boolean;
  /** Run ceiling (> 0). Ignored by `off`. */
  maxRuns: number;
  /** Revoke LOCAL permission (keeps the counters) instead of granting it. */
  off?: boolean;
  /** Also select every open transitive blocker of this task (not the task itself). */
  blockersOf?: string;
  /** Attribution for the captured ops. */
  actor?: string;
}

export interface AuthorizeTasksResult {
  /** The tasks acted on, in selection order. */
  ids: string[];
  /** False when every row and designation was already as asked. */
  changed: boolean;
}

export interface AutoConfig {
  cli: string;
  worktree: boolean;
  maxRuns: number;
  runs: number;
  lastSpawn: string | null;
  enabled: boolean;
}

/** A ready task the executor may act on, with its stored config. */
export interface AuthorisedTask extends TaskRow {
  auto: AutoConfig;
}

interface AutoRow {
  cli: string;
  worktree: number;
  max_runs: number;
  runs: number;
  last_spawn: string | null;
  enabled: number;
}

const configOf = (r: AutoRow): AutoConfig => ({
  cli: r.cli,
  worktree: r.worktree === 1,
  maxRuns: r.max_runs,
  runs: r.runs,
  lastSpawn: r.last_spawn,
  enabled: r.enabled === 1,
});

/** The stored config of one task (surrogate id), enabled or not. */
export function getAutoConfig(db: Db, taskId: number): AutoConfig | undefined {
  const row = db
    .prepare(
      "SELECT cli, worktree, max_runs, runs, last_spawn, enabled FROM task_auto WHERE task_id = ?",
    )
    .get(taskId) as AutoRow | undefined;
  return row === undefined ? undefined : configOf(row);
}

/**
 * May this machine act on the task (steer, release, dispatch)? True iff an
 * ENABLED `task_auto` row exists, the task is `kind=work`, and its synced
 * `dispatch_host` is this machine. Independent of status and of the run
 * ceiling. Resolve the surrogate id with `taskIdFor`.
 */
export function autoPermitted(db: Db, taskId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS x FROM task_auto a JOIN tasks t ON t.id = a.task_id
          WHERE a.task_id = ? AND a.enabled = 1 AND t.kind = 'work' AND t.dispatch_host = ?`,
      )
      .get(taskId, localMachineId(db)) !== undefined
  );
}

/**
 * The tasks `mu next` may dispatch now, in `ready` order: ready (OPEN,
 * unblocked, not parked/triage) AND permitted AND `runs < max_runs`.
 * `kind` human/delegate never qualifies; the reserved scratch queue is empty.
 */
export function authorisedReady(db: Db, workstream: string): AuthorisedTask[] {
  if (RESERVED_WORKSTREAM_NAMES.has(workstream)) return [];
  const rows = db
    .prepare(
      `SELECT t.local_id AS local_id, a.cli, a.worktree, a.max_runs, a.runs, a.last_spawn, a.enabled
         FROM task_auto a
         JOIN tasks t ON t.id = a.task_id
         JOIN workstreams w ON w.id = t.workstream_id AND w.name = ?
        WHERE a.enabled = 1 AND a.runs < a.max_runs
          AND t.kind = 'work' AND t.dispatch_host = ?`,
    )
    .all(workstream, localMachineId(db)) as (AutoRow & { local_id: string })[];
  const byId = new Map(rows.map((r) => [r.local_id, configOf(r)]));
  const out: AuthorisedTask[] = [];
  for (const t of listReady(db, workstream)) {
    const auto = byId.get(t.name);
    if (auto !== undefined) out.push({ ...t, auto });
  }
  return out;
}

/**
 * The local ids of every OPEN or IN_PROGRESS transitive blocker of an
 * umbrella, sorted. Walks only the umbrella's own workstream, uncapped
 * (unlike the display frontier), safe on diamonds and cycles, never walks
 * through a CLOSED task, never lists the umbrella itself.
 */
export function openBlockersClosure(db: Db, workstreamId: number, umbrellaId: number): string[] {
  const blockersOf = db.prepare(
    `SELECT b.id AS id, b.local_id AS local_id, b.status AS status
       FROM task_edges e JOIN tasks b ON b.id = e.from_task_id
      WHERE e.to_task_id = ? AND b.workstream_id = ?`,
  );
  const seen = new Set<number>([umbrellaId]);
  const queue = [umbrellaId];
  const found: string[] = [];
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    const rows = blockersOf.all(cur, workstreamId) as {
      id: number;
      local_id: string;
      status: string;
    }[];
    for (const r of rows) {
      if (seen.has(r.id) || r.status === "CLOSED") continue;
      seen.add(r.id);
      found.push(r.local_id);
      queue.push(r.id);
    }
  }
  return found.sort();
}

/**
 * Grant (or, with `off`, revoke) this machine's permission to dispatch the
 * selected tasks. Grant: upsert the local `task_auto` row (keeping `runs`
 * and `last_spawn`, setting `enabled`) and write the synced `dispatch_host`
 * = this machine. Off: `enabled = 0`, and `dispatch_host` cleared only when
 * this machine owns it. The whole batch is validated inside ONE
 * transaction before any write: a refusal leaves nothing changed.
 */
export function authorizeTasks(
  db: Db,
  ids: readonly string[],
  opts: AuthorizeTasksOptions,
): AuthorizeTasksResult {
  const ws = opts.workstream;
  if (RESERVED_WORKSTREAM_NAMES.has(ws)) {
    throw new TaskAutoArgError(say("task.auto_reserved_ws", ws));
  }
  if (!opts.off) {
    if (!CLI_KEY_RE.test(opts.cli)) {
      throw new TaskAutoArgError(say("task.auto_cli_key", opts.cli));
    }
    if (!Number.isSafeInteger(opts.maxRuns) || opts.maxRuns < 1) {
      throw new TaskAutoArgError(say("task.auto_max", opts.maxRuns));
    }
  }
  return withOpContext(
    db,
    { intent: opts.off ? "task.auto-off" : "task.auto", actor: opts.actor, group: "new" },
    () => {
      const me = localMachineId(db);
      const selected = [...ids];
      if (opts.blockersOf !== undefined) {
        const umbrella = getTask(db, opts.blockersOf, ws);
        if (!umbrella) throw new TaskNotFoundError(opts.blockersOf, ws);
        selected.push(...openBlockersClosure(db, umbrella.workstreamId, tidOf(db, umbrella)));
      }
      const names = [...new Set(selected)];
      if (names.length === 0) {
        throw new TaskAutoArgError(
          opts.blockersOf !== undefined
            ? say("task.auto_no_blockers", opts.blockersOf)
            : say("task.auto_none_given"),
        );
      }

      // Validate the whole batch first.
      const plan: { task: TaskRow; id: number }[] = [];
      for (const name of names) {
        const task = getTask(db, name, ws);
        if (!task) throw new TaskNotFoundError(name, ws);
        const id = tidOf(db, task);
        if (!opts.off) refuseUnauthorisable(task, me);
        plan.push({ task, id });
      }

      // Then write.
      const now = new Date().toISOString();
      let changed = false;
      for (const { task, id } of plan) {
        const row = db
          .prepare("SELECT cli, worktree, max_runs, enabled FROM task_auto WHERE task_id = ?")
          .get(id) as Pick<AutoRow, "cli" | "worktree" | "max_runs" | "enabled"> | undefined;
        if (opts.off) {
          if (row !== undefined && row.enabled === 1) {
            db.prepare("UPDATE task_auto SET enabled = 0 WHERE task_id = ?").run(id);
            changed = true;
          }
          if (task.dispatchHost === me) {
            setHost(db, id, null, now);
            changed = true;
          }
          continue;
        }
        const wt = opts.worktree ? 1 : 0;
        if (row === undefined) {
          db.prepare(
            "INSERT INTO task_auto (task_id, cli, worktree, max_runs, created_at) VALUES (?, ?, ?, ?, ?)",
          ).run(id, opts.cli, wt, opts.maxRuns, now);
          changed = true;
        } else if (
          row.cli !== opts.cli ||
          row.worktree !== wt ||
          row.max_runs !== opts.maxRuns ||
          row.enabled !== 1
        ) {
          db.prepare(
            "UPDATE task_auto SET cli = ?, worktree = ?, max_runs = ?, enabled = 1 WHERE task_id = ?",
          ).run(opts.cli, wt, opts.maxRuns, id);
          changed = true;
        }
        if (task.dispatchHost !== me) {
          setHost(db, id, me, now);
          changed = true;
        }
      }
      return { ids: names, changed };
    },
  );
}

function tidOf(db: Db, task: TaskRow): number {
  const id = taskIdFor(db, task.name, task.workstreamName);
  if (id === null) throw new TaskNotFoundError(task.name, task.workstreamName);
  return id;
}

function setHost(db: Db, taskId: number, host: string | null, now: string): void {
  db.prepare("UPDATE tasks SET dispatch_host = ?, updated_at = ? WHERE id = ?").run(
    host,
    now,
    taskId,
  );
}

/** Why a task cannot be authorised for the executor, or return. */
function refuseUnauthorisable(task: TaskRow, me: string): void {
  const refuse = (why: string): never => {
    throw new TaskAutoRefusedError(
      `cannot authorise ${task.name}: ${why}`,
      task.workstreamName,
      task.name,
    );
  };
  if (task.kind !== "work") refuse(`it is a ${task.kind} task, not a worker job`);
  if (task.status === "CLOSED") refuse("it is CLOSED");
  if (task.substate === "parked") refuse("it is parked (unpark it first)");
  if (task.substate === "triage") refuse("it is in triage (accept it first)");
  if (task.dispatchHost !== null && task.dispatchHost !== me) {
    refuse(`another host (${task.dispatchHost}) is designated to dispatch it`);
  }
}
