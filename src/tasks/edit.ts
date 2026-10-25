// mu — task edit/write verbs: add task, add note, update, delete.

import {
  type Db,
  DEFAULT_EFFORT_DAYS,
  DEFAULT_IMPACT,
  type NoteKind,
  resolveWorkstreamId,
  type TaskKind,
} from "../db.js";
import { currentOpContext, withOpContext } from "../op-context.js";
import { assertTaskRevision, taskRevision } from "../revision.js";
import { ensureWorkstream } from "../workstream.js";
import { taskIdFor, touchTask } from "./core.js";
import { cycleErrorFor, dedupeBlockersById, wouldCreateCycle } from "./edges.js";
import {
  CrossWorkstreamEdgeError,
  CycleError,
  TaskExistsError,
  TaskIdInvalidError,
  TaskNotFoundError,
} from "./errors.js";
import { type IdFromTitleResult, idFromTitleVerbose, isValidTaskId } from "./id.js";
import { getTask } from "./queries.js";

export interface AddTaskOptions {
  localId: string;
  workstream: string;
  title: string;
  /** 1..100; enforced by schema CHECK. Omitted = 50, and unless
   *  `effortDays` is given the task is unscored. */
  impact?: number;
  /** > 0; enforced by schema CHECK. Omitted = 1 (see `impact`). */
  effortDays?: number;
  /**
   * Tasks that block this one. Edges inserted as `blocker -> newTask`.
   * Each blocker must already exist AND share this task's workstream
   * (cross-workstream edges are forbidden); cycle check guards each
   * edge. The CLI surfaces this as `--blocked-by`; the SDK key matches.
   */
  blockedBy?: string[];
  /** Start as OPEN/triage (a proposal, e.g. a review finding) instead of OPEN/todo. */
  triage?: boolean;
  /** Task kind (default `work`). `human` starts OPEN/parked, never ready. */
  kind?: TaskKind;
}

/**
 * Atomically create a task and (optionally) its incoming blocked-by
 * edges.
 *
 * The task insert + every edge insert + cycle check happen inside one
 * SQLite transaction. If any blocker is missing or any edge would
 * create a cycle, the entire add rolls back.
 *
 * Cycle check for `addTask` is structurally trivial (a fresh task has
 * no outgoing edges, so `to -> ... -> from` is impossible). It's still
 * called here so the same primitive is exercised by tests.
 */
export function addTask(db: Db, opts: AddTaskOptions) {
  return withOpContext(db, { intent: "task.add", group: "new" }, () => addTaskImpl(db, opts));
}

function addTaskImpl(db: Db, opts: AddTaskOptions) {
  if (!isValidTaskId(opts.localId)) {
    throw new TaskIdInvalidError(opts.localId);
  }

  return db
    .transaction(() => {
      // Auto-create the workstream row so tasks.workstream_id FK is
      // satisfied (preserves spawn-without-init ergonomics).
      ensureWorkstream(db, opts.workstream);
      const wsId = resolveWorkstreamId(db, opts.workstream);

      // Per-workstream uniqueness: a duplicate local_id within the same
      // workstream throws TaskExistsError. Different workstreams may
      // legitimately share local_ids in v5.
      const existing = db
        .prepare("SELECT id FROM tasks WHERE workstream_id = ? AND local_id = ?")
        .get(wsId, opts.localId) as { id: number } | undefined;
      if (existing) {
        throw new TaskExistsError(opts.localId);
      }

      const now = new Date().toISOString();
      const insertResult = db
        .prepare(
          `INSERT INTO tasks (workstream_id, local_id, title, status, substate, kind, impact, effort_days, scored, created_at, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          wsId,
          opts.localId,
          opts.title,
          opts.kind === "human" ? "parked" : opts.triage === true ? "triage" : "todo",
          opts.kind ?? "work",
          opts.impact ?? DEFAULT_IMPACT,
          opts.effortDays ?? DEFAULT_EFFORT_DAYS,
          opts.impact !== undefined || opts.effortDays !== undefined ? 1 : 0,
          now,
          now,
        );
      const newTaskId = Number(insertResult.lastInsertRowid);

      if (opts.blockedBy && opts.blockedBy.length > 0) {
        const requestedBlockers = opts.blockedBy.map((blocker) => {
          const row = lookupEdgeTask(db, wsId, blocker, opts.workstream);
          if (row.workstream !== opts.workstream) {
            throw new CrossWorkstreamEdgeError(
              blocker,
              row.workstream,
              opts.localId,
              opts.workstream,
            );
          }
          if (wouldCreateCycle(db, row.id, newTaskId)) {
            throw new CycleError(blocker, opts.localId);
          }
          return { localId: blocker, id: row.id };
        });
        const canonicalBlockers = dedupeBlockersById(requestedBlockers);
        const insertEdge = db.prepare(
          "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
        );
        for (const blocker of canonicalBlockers) {
          insertEdge.run(blocker.id, newTaskId, now);
        }
      }

      const row = getTask(db, opts.localId, opts.workstream);
      if (!row) throw new Error(`addTask: row missing after insert: ${opts.localId}`);
      // No emitEvent: the INSERT above fired the tasks capture trigger,
      // which already wrote intent='task.add' key='<ws>/<id>' with the
      // full row as payload (v2-retire-log-shim).
      return row;
    })
    .immediate();
}

export interface AddTasksOptions {
  workstream: string;
  /** Umbrellas the NEW tasks block (`mu task add --blocks`): edges
   *  `newTask -> umbrella`, each umbrella same-workstream and cycle-checked. */
  blocks?: readonly string[];
  /** Tasks that block every NEW task (`--blocked-by`). */
  blockedBy?: readonly string[];
  triage?: boolean;
  /** Applied to every task of the batch (see AddTaskOptions). */
  kind?: TaskKind;
  impact?: number;
  effortDays?: number;
  /** Author of every `note` (the brief); also the group's actor. */
  noteAuthor?: string;
}

export interface AddTasksResult {
  /** Local ids, in input order. */
  ids: string[];
  /** Per task, in input order: the id and, for a derived one, whether the
   *  slug was cut (`truncated`) and its un-cut form. */
  derived: IdFromTitleResult[];
  /** False only for an empty batch. */
  changed: boolean;
}

/**
 * Create one or more tasks, each with an optional brief (kind 'brief'),
 * their `blockedBy` edges and their outbound `blocks` edges, in ONE op
 * group and ONE transaction. A duplicate id, invalid id, missing or
 * cross-workstream blocker/umbrella or a cycle rolls back every row, edge
 * and note of the batch.
 *
 * An entry without `id` gets one derived from its title: the slug, then
 * `_2`, `_3`, … the first suffix free in the DB, among the batch's
 * explicit ids and among the ids already derived. The probe runs inside
 * the transaction, so it cannot race another writer.
 */
export function addTasks(
  db: Db,
  input: readonly { id?: string; title: string; note?: string }[],
  opts: AddTasksOptions,
): AddTasksResult {
  if (input.length === 0) return { ids: [], derived: [], changed: false };
  return withOpContext(db, { intent: "task.add", actor: opts.noteAuthor, group: "new" }, () =>
    db
      .transaction((): AddTasksResult => {
        const explicit = new Set(input.flatMap((t) => (t.id !== undefined ? [t.id] : [])));
        const done: { id: string }[] = [];
        const derived: IdFromTitleResult[] = [];
        for (const entry of input) {
          const d: IdFromTitleResult =
            entry.id !== undefined
              ? { id: entry.id, truncated: false, originalSlug: entry.id }
              : idFromTitleVerbose(db, opts.workstream, entry.title, explicit);
          derived.push(d);
          const t = { ...entry, id: d.id };
          done.push(t);
          addTaskImpl(db, {
            localId: t.id,
            workstream: opts.workstream,
            title: t.title,
            ...(opts.blockedBy !== undefined ? { blockedBy: [...opts.blockedBy] } : {}),
            ...(opts.triage === true ? { triage: true } : {}),
            ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
            ...(opts.impact !== undefined ? { impact: opts.impact } : {}),
            ...(opts.effortDays !== undefined ? { effortDays: opts.effortDays } : {}),
          });
          if (t.note !== undefined) {
            const noteOpts: AddNoteOptions = { workstream: opts.workstream, kind: "brief" };
            if (opts.noteAuthor !== undefined) noteOpts.author = opts.noteAuthor;
            insertNote(db, t.id, t.note, noteOpts, false);
          }
        }
        if (opts.blocks !== undefined && opts.blocks.length > 0) {
          addBlocksEdges(db, done, opts.blocks, opts.workstream);
        }
        return { ids: done.map((t) => t.id), derived, changed: true };
      })
      .immediate(),
  );
}

/** Edges `newTask -> umbrella` for every task of a batch. The cycle check
 *  runs after the incoming `blockedBy` edges exist, so `a` blocked by U
 *  and blocking U is caught. */
function addBlocksEdges(
  db: Db,
  input: readonly { id: string }[],
  blocks: readonly string[],
  workstream: string,
): void {
  const wsId = resolveWorkstreamId(db, workstream);
  const umbrellas = new Map<number, string>();
  for (const local of blocks) {
    const row = lookupEdgeTask(db, wsId, local, workstream);
    if (row.workstream !== workstream) {
      throw new CrossWorkstreamEdgeError(input[0]?.id ?? local, workstream, local, row.workstream);
    }
    umbrellas.set(row.id, local);
  }
  const now = new Date().toISOString();
  const insertEdge = db.prepare(
    "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
  );
  for (const t of input) {
    const newId = taskIdFor(db, t.id, workstream);
    if (newId === null) throw new TaskNotFoundError(t.id);
    for (const [umbrellaId, umbrella] of umbrellas) {
      if (wouldCreateCycle(db, newId, umbrellaId)) {
        throw cycleErrorFor(db, t.id, umbrella, newId, umbrellaId, workstream);
      }
      insertEdge.run(newId, umbrellaId, now);
    }
  }
  for (const umbrellaId of umbrellas.keys()) touchTask(db, umbrellaId, now);
}

/** Resolve an edge endpoint named by local id: prefer the
 *  same-workstream task first (v5 per-workstream local_id), then fall
 *  back to a global lookup so a cross-ws endpoint still surfaces
 *  CrossWorkstreamEdgeError (not TaskNotFoundError). Without the
 *  same-ws preference, two tasks of the same local_id (one in this ws,
 *  one elsewhere) could silently bind to the wrong row
 *  (bug_v5_name_clash_silent_misroute). */
function lookupEdgeTask(
  db: Db,
  wsId: number,
  localId: string,
  workstream: string,
): { id: number; workstream: string } {
  const row = (db
    .prepare(
      `SELECT t.id AS id, ws.name AS workstream FROM tasks t
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE t.local_id = ? AND t.workstream_id = ?`,
    )
    .get(localId, wsId) ??
    db
      .prepare(
        `SELECT t.id AS id, ws.name AS workstream FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE t.local_id = ? LIMIT 1`,
      )
      .get(localId)) as { id: number; workstream: string } | undefined;
  if (!row) throw new TaskNotFoundError(localId, workstream);
  return row;
}

export interface AddNoteOptions {
  /** Free-form author label. Convention: agent name, "user", or "orchestrator". */
  author?: string;
  /** Workstream context (operator-facing name). v5: tasks.local_id is
   *  per-workstream unique, so this is required to disambiguate. */
  workstream: string;
  /** Note kind (`task_notes.kind`), set once at INSERT. Default 'note'.
   *  `closeTask` files its reason/evidence notes as 'close'. */
  kind?: NoteKind;
  /** 'new' (default): the note is its own op group. 'inherit': it joins
   *  the CALLER's group, actor and intent (a verdict written inside a
   *  delegate's record group). Honoured by `addNote`; `insertNote` always
   *  inherits. */
  group?: "new" | "inherit";
}

export interface AddNoteResult {
  author: string | null;
  content: string;
  createdAt: string;
  kind: NoteKind;
}

/** The op context of a writer's `group` option. 'inherit' OMITS the group
 *  (withOpContext reads any string other than "new" as a literal group
 *  id) and keeps the outer actor and intent; with no outer context the
 *  call labels itself and mints its own group. */
export function writerContext(
  db: Db,
  intent: string,
  actor: string | undefined,
  group: "new" | "inherit" | undefined,
): { intent?: string; intentIfUnset?: string; actor: string | undefined; group?: "new" } {
  if (group !== "inherit") return { intent, actor, group: "new" };
  return { intentIfUnset: intent, actor: currentOpContext(db).actor ?? actor };
}

export function addNote(
  db: Db,
  taskLocalId: string,
  content: string,
  opts: AddNoteOptions,
): AddNoteResult {
  return withOpContext(db, writerContext(db, "task.note", opts.author, opts.group), () =>
    insertNote(db, taskLocalId, content, opts),
  );
}

/** addNote without its own op context: the note joins the CALLER's
 *  group and intent. For verbs whose note is part of one action (the
 *  `--why` of `close --as` / `park`), so both share one group.
 *  Internal — not re-exported from src/tasks.ts. */
export function insertNote(
  db: Db,
  taskLocalId: string,
  content: string,
  opts: AddNoteOptions,
  /** False when the caller's own UPDATE bumps `updated_at` in the same
   *  group: a second `task` put there would duplicate the change. */
  touch = true,
): AddNoteResult {
  const task = getTask(db, taskLocalId, opts.workstream);
  if (!task) {
    throw new TaskNotFoundError(taskLocalId, opts.workstream);
  }
  const taskId = taskIdFor(db, task.name, task.workstreamName);
  if (taskId === null) throw new TaskNotFoundError(taskLocalId, task.workstreamName);
  const now = new Date().toISOString();
  db.transaction(() => {
    const r = db
      .prepare(
        "INSERT INTO task_notes (task_id, author, content, created_at, kind) VALUES (?, ?, ?, ?, ?)",
      )
      .run(taskId, opts.author ?? null, content, now, opts.kind ?? "note");
    // Bump the parent task so `mu task list --sort recency` surfaces
    // freshly-noted tasks (task_updatedat_not_bumped_by_reparent).
    if (touch) touchTask(db, taskId, now);
    return r;
  }).immediate();
  // No emitEvent: the task_notes INSERT fired the capture trigger
  // (intent='task.note', key='<ws>/<id>#<n>').
  return {
    author: opts.author ?? null,
    content,
    createdAt: now,
    kind: opts.kind ?? "note",
  };
}

export interface DeleteTaskResult {
  /** True iff the row existed and was deleted. False on a dry-run
   *  (preview) AND on the idempotent missing-row case. */
  deleted: boolean;
  /** Number of `task_edges` rows cascaded out (informational). On a
   *  dry-run, this is the would-be count. */
  deletedEdges: number;
  /** Number of `task_notes` rows cascaded out (informational). On a
   *  dry-run, this is the would-be count. */
  deletedNotes: number;
  /** True iff this was a dry-run (`opts.dryRun: true`). On a
   *  dry-run `deleted` is false and the counts are the would-be
   *  counts; the DB is unchanged. Always false on a commit / on a
   *  missing-row idempotent no-op. */
  dryRun: boolean;
  /** True iff a matching task row was found at the time of the
   *  call. Discriminator for the CLI: a dry-run that found nothing
   *  (`present: false`) renders differently from a dry-run that
   *  found an existing task with zero edges and zero notes
   *  (`present: true, deletedEdges: 0, deletedNotes: 0`). */
  present: boolean;
  /** The op group the delete wrote. Null
   *  when nothing was deleted (dry-run or missing row). */
  group: string | null;
  /** The task's revision when it was found (`taskRevision`): a preview
   *  prints it, `--if <rev>` repeats it. Absent for a missing task. */
  revision?: number;
}

export interface DeleteTaskOptions {
  /** The preview revision (`taskRevision`). A commit whose task changed
   *  since throws `RevisionMismatchError` before any write; checked in the
   *  delete's own transaction. Ignored by a dry-run and by a missing task. */
  ifRevision?: number;
  /** When true, return the cascade preview (would-be edge / note
   *  counts) without mutating. The CLI uses this to power the bare
   *  `mu task delete <id>` two-phase pattern (mirrors
   *  `mu workstream teardown`). Surfaced
   *  by feedback ws task
   *  fb_task_delete_no_yes (impact=30): a dogfood report typed
   *  `mu task delete X --yes` (mirroring workstream teardown) and got
   *  'unknown option --yes' — the verb took no confirmation flag at
   *  all. Two failed deletes left long-named tasks lingering. */
  dryRun?: boolean;
}

/**
 * Delete a task. FK CASCADE on `task_edges` (from + to) and
 * `task_notes` cleans the joined rows automatically. Idempotent on
 * a missing task (returns `deleted: false`).
 *
 * Pre-counts the cascade victims for reporting because SQLite's
 * `changes()` only reports rows directly affected by the DELETE.
 *
 * With `opts.dryRun: true`, returns the would-be counts without
 * touching the DB (no mutation, so no op is written). The CLI bare
 * `mu task delete <id>` form uses this; `--yes` calls through with
 * `dryRun: false`.
 */
export function deleteTask(
  db: Db,
  localId: string,
  workstream: string,
  opts: DeleteTaskOptions = {},
): DeleteTaskResult {
  return withOpContext(db, { intent: "task.delete", group: "new" }, () =>
    deleteTaskImpl(db, localId, workstream, opts),
  );
}

function deleteTaskImpl(
  db: Db,
  localId: string,
  workstream: string,
  opts: DeleteTaskOptions,
): DeleteTaskResult {
  const dryRun = opts.dryRun === true;
  const before = getTask(db, localId, workstream);
  if (!before) {
    // Idempotent on a missing row regardless of dryRun.
    return {
      deleted: false,
      deletedEdges: 0,
      deletedNotes: 0,
      dryRun,
      present: false,
      group: null,
    };
  }
  const taskId = taskIdFor(db, localId, before.workstreamName);
  if (taskId === null) {
    return {
      deleted: false,
      deletedEdges: 0,
      deletedNotes: 0,
      dryRun,
      present: false,
      group: null,
    };
  }
  const edgesBefore = (
    db
      .prepare("SELECT COUNT(*) AS n FROM task_edges WHERE from_task_id = ? OR to_task_id = ?")
      .get(taskId, taskId) as { n: number }
  ).n;
  const notesBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM task_notes WHERE task_id = ?").get(taskId) as {
      n: number;
    }
  ).n;
  const revision = taskRevision(db, before.workstreamName, localId);
  if (dryRun) {
    return {
      deleted: false,
      deletedEdges: edgesBefore,
      deletedNotes: notesBefore,
      dryRun: true,
      present: true,
      group: null,
      revision,
    };
  }
  assertTaskRevision(
    db,
    before.workstreamName,
    localId,
    opts.ifRevision,
    `mu task delete ${localId} -w ${before.workstreamName}`,
  );
  // No pre-mutation snapshot: v9 dropped the `snapshots` table and
  // history is the ops log.
  const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  // No emitEvent: the DELETE fired the capture trigger, which wrote a
  // tombstone op (op='del', intent='task.delete').
  const deleted = result.changes > 0;
  return {
    deleted,
    deletedEdges: edgesBefore,
    deletedNotes: notesBefore,
    dryRun: false,
    present: true,
    // deleteTask opened a fresh group around this call.
    group: deleted ? currentOpContext(db).groupId : null,
    revision,
  };
}

export interface UpdateTaskOptions {
  title?: string;
  /** 1..100; enforced by schema CHECK. */
  impact?: number;
  /** > 0; enforced by schema CHECK. */
  effortDays?: number;
}

export interface UpdateTaskResult {
  /** True iff at least one field actually changed. */
  updated: boolean;
  /** The fields whose values differ post-update (in `UpdateTaskOptions`'s
   *  camelCase shape). Empty when `updated: false`. */
  changedFields: string[];
}

/**
 * Update scalar fields on a task. Each option is independently optional;
 * passing none is a typed no-op (returns `updated: false, changedFields: []`).
 * Fields whose new value equals the current value are skipped (no row change).
 *
 * NOT for status (use `closeTask` / `openTask` / `setTaskStatus`), owner
 * (use `claimTask` / `releaseTask`), local_id (rename is deferred), or
 * workstream (cross-workstream moves are deferred).
 */
export interface UpdateTaskScopeOption {
  workstream: string;
}

export function updateTask(
  db: Db,
  localId: string,
  opts: UpdateTaskOptions,
  scope: UpdateTaskScopeOption,
): UpdateTaskResult {
  return withOpContext(db, { intent: "task.update", group: "new" }, () =>
    updateTaskImpl(db, localId, opts, scope),
  );
}

function updateTaskImpl(
  db: Db,
  localId: string,
  opts: UpdateTaskOptions,
  scope: UpdateTaskScopeOption,
): UpdateTaskResult {
  const before = getTask(db, localId, scope.workstream);
  if (!before) throw new TaskNotFoundError(localId, scope.workstream);
  const taskId = taskIdFor(db, before.name, before.workstreamName);
  if (taskId === null) throw new TaskNotFoundError(localId, before.workstreamName);

  const setters: string[] = [];
  const params: unknown[] = [];
  const changedFields: string[] = [];

  if (opts.title !== undefined && opts.title !== before.title) {
    setters.push("title = ?");
    params.push(opts.title);
    changedFields.push("title");
  }
  if (opts.impact !== undefined && opts.impact !== before.impact) {
    setters.push("impact = ?");
    params.push(opts.impact);
    changedFields.push("impact");
  }
  if (opts.effortDays !== undefined && opts.effortDays !== before.effortDays) {
    setters.push("effort_days = ?");
    params.push(opts.effortDays);
    changedFields.push("effortDays");
  }
  // Giving impact or effort scores the task, even at the value it already
  // has (an unscored task's 50 / 1 are defaults, not a judgement).
  if ((opts.impact !== undefined || opts.effortDays !== undefined) && !before.scored) {
    setters.push("scored = 1");
    changedFields.push("scored");
  }

  if (setters.length === 0) {
    return { updated: false, changedFields: [] };
  }

  setters.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(taskId);

  // No emitEvent: the UPDATE fired the capture trigger, whose payload is
  // a semantic partial update naming exactly the changed columns —
  // strictly more useful than the prose "(changed: a, b)" it replaces.
  db.prepare(`UPDATE tasks SET ${setters.join(", ")} WHERE id = ?`).run(...params);
  return { updated: true, changedFields };
}
