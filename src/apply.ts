// mu — the APPLY path: how an op lands in the portable tables.
//
// The counterpart to src/capture.ts. Capture answers "a row changed, what
// op records it"; this answers "here is an op, local or from a peer, what
// do the tables look like afterwards". It knows nothing about segments,
// files or watermarks.
//
// LIVE STATE IS REBUILD-OF-THAT-KEY
// ---------------------------------
// The ops log is the canonical record and the tables are a projection of
// it. src/fold.ts defines the projection as a PURE function: the ops of
// one natural key (plus the tombstone horizon covering it) in, the row's
// state out. This module has no merge rule of its own. `applyOp` finds the
// keys the op can change and re-folds each from ALL the ops the log knows
// for it, then makes the table row equal the fold. `mu rebuild` replays
// the log through the same call. So live state equals an HLC-order
// rebuild for EVERY arrival order of the same op set, by construction:
// there is no per-path comparison (put vs del, child vs parent) left to
// get wrong, and no "deferred" op to repair later.
//
// WHAT AN OP CAN CHANGE
//   workstream put   its own row.
//   workstream del   its row, and every task, note and edge beneath it
//                    (the horizon moved).
//   task put         the task row and its workstream (a task put creates
//                    its parent); when the task came into or went out of
//                    existence, also its notes and the edges touching it.
//   task del         the same, always.
//   note put / del   that task's notes.
//   edge put / del   that edge.
//
// PROVENANCE IS THE LOG
// ---------------------
// Every op carries its HLC and names the fields it touched, so "the HLC
// that last wrote field F of key K" is a query over K's handful of ops
// (`idx_ops_entity_key`), not a fact needing a side table. The op being
// applied is passed in beside the log's rows, so record-then-apply and
// apply-then-record fold identically, and re-applying an op is a no-op.
//
// TOMBSTONES ARE JUST OPS. There is no tombstone table: a `del` is an op
// with an HLC, and a put older than the newest `del` covering its key is
// dead whatever the arrival order.

import {
  type Db,
  MACHINE_LOCAL_ENTITIES,
  prepareCached,
  SYNCED_ENTITIES,
  type SyncedEntity,
} from "./db.js";
import {
  foldEdge,
  foldNotes,
  foldTask,
  foldWorkstream,
  type LogOp,
  laterHlc,
  newestDel,
  noteIdentity,
} from "./fold.js";
import { compareHlc } from "./hlc.js";
import { withCaptureSuppressed } from "./op-context.js";

/** An op as applied. Mirrors the `ops` row shape, minus the local-only
 *  `seq` (meaningless on a peer) and the advisory `created_at`. */
export interface Op {
  /** The ordering key. See docs/VOCABULARY.md § HLC. */
  hlc: string;
  /** Which peer minted it. Half of the (machine_id, hlc) identity. */
  machineId: string;
  /** One user-visible action (the op group). */
  groupId: string;
  /** Free text: agent name, "user", "system". */
  actor?: string | null;
  /** Semantic label, e.g. "task.close". */
  intent?: string | null;
  /** Which kind of thing this op addresses. */
  entity: string;
  /** The NATURAL key. Never a surrogate id. */
  key: string;
  /** 'put' = semantic partial update, 'del' = tombstone. */
  op: "put" | "del";
  /** JSON object of ONLY the fields this op touched. */
  payload: string;
}

/** Thrown when an op names an entity this build KNOWS is machine-local
 *  (see `MACHINE_LOCAL_ENTITIES`). Loud by design: a peer shipping a
 *  pane id or an absolute path is a real bug we want reported.
 *
 *  NOT thrown for an entity we merely do not recognise. That is a
 *  reader-behind-writer vocabulary skew in a mixed fleet, and treating
 *  it as a defect froze one peer's watermark permanently — see
 *  `MACHINE_LOCAL_ENTITIES` in src/db.ts for the incident. */
export class OpEntityNotSyncedError extends Error {
  constructor(readonly entity: string) {
    super(
      `op entity ${JSON.stringify(entity)} is machine-local and must never arrive from a peer ` +
        `(synced entities: ${SYNCED_ENTITIES.join(", ")})`,
    );
    this.name = "OpEntityNotSyncedError";
  }
}

/** Thrown when an op's natural key does not parse for its entity. */
export class OpKeyMalformedError extends Error {
  constructor(
    readonly entity: string,
    readonly key: string,
  ) {
    super(`malformed ${entity} key: ${JSON.stringify(key)}`);
    this.name = "OpKeyMalformedError";
  }
}

/** What `applyOp` did, so callers (and tests) can assert on outcomes
 *  rather than re-querying. */
export interface ApplyResult {
  /** True iff the DB changed. False for a dead, superseded or duplicate
   *  op: legitimate and non-exceptional. */
  changed: boolean;
  /** The columns of a task or workstream row the op changed. */
  appliedFields: string[];
}

function isSyncedEntity(entity: string): entity is SyncedEntity {
  return (SYNCED_ENTITIES as readonly string[]).includes(entity);
}

/** Entities this build knows must never travel. Distinct from "unknown":
 *  only these are a defect. */
function isKnownMachineLocalEntity(entity: string): boolean {
  return (MACHINE_LOCAL_ENTITIES as readonly string[]).includes(entity);
}

// ─── Natural key parsing ──────────────────────────────────────────────
//
// The inverse of src/capture.ts's key builders. Kept here rather than
// shared with capture because capture composes keys in SQL and this
// decomposes them in TS; a "shared" helper would be two functions in one
// file pretending to be one thing.

/** `<workstream>/<local_id>` -> its parts. Task ids match
 *  `[a-z][a-z0-9_-]*`, so they never contain '/', making the FIRST '/'
 *  the unambiguous separator. */
function parseTaskKey(key: string): { workstream: string; localId: string } {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) throw new OpKeyMalformedError("task", key);
  const workstream = key.slice(0, slash);
  const localId = key.slice(slash + 1);
  if (workstream.length === 0 || localId.length === 0) {
    throw new OpKeyMalformedError("task", key);
  }
  return { workstream, localId };
}

/** `<task-key>#<origin-id>` -> the task key it hangs off. Task ids
 *  cannot contain '#', so the LAST '#' separates. The origin id is
 *  validated as present (a key without one is malformed) but not
 *  returned: it identifies the note on its ORIGIN machine only, and
 *  `applyNotePut` uses content identity instead. See its comment. */
function parseNoteKey(key: string): { taskKey: string } {
  const hash = key.lastIndexOf("#");
  if (hash <= 0 || hash === key.length - 1) throw new OpKeyMalformedError("note", key);
  return { taskKey: key.slice(0, hash) };
}

/** `<blocker>-><blocked>` -> its parts. Task ids MAY end in '-', so
 *  `demo/a-->demo/b` is a valid key for blocker `demo/a-`; splitting on
 *  the FIRST '->' recovers that correctly, whereas a naive split('->')
 *  would produce three fragments. */
function parseEdgeKey(key: string): { blocker: string; blocked: string } {
  const arrow = key.indexOf("->");
  if (arrow <= 0) throw new OpKeyMalformedError("edge", key);
  const blocker = key.slice(0, arrow);
  const blocked = key.slice(arrow + 2);
  if (blocker.length === 0 || blocked.length === 0) throw new OpKeyMalformedError("edge", key);
  return { blocker, blocked };
}

// ─── The log, as the folds read it ────────────────────────────────────

/** The smallest string above every string starting with `p`. */
const hi = (p: string): string =>
  `${p.slice(0, -1)}${String.fromCharCode(p.charCodeAt(p.length - 1) + 1)}`;

interface LogRow {
  hlc: string;
  op: "put" | "del";
  key: string;
  payload: string;
}

/**
 * Read access to the ops log, plus the op being applied (which the caller
 * may not have recorded yet). Every query returns the union, deduplicated
 * by HLC (an HLC embeds its machine id, so it names one op).
 */
class Log {
  private readonly pending: LogRow | undefined;
  private readonly pendingEntity: string;

  constructor(
    private readonly db: Db,
    op?: Op,
  ) {
    this.pending = op && { hlc: op.hlc, op: op.op, key: op.key, payload: op.payload };
    this.pendingEntity = op?.entity ?? "";
  }

  private withPending(entity: string, rows: LogRow[], inScope: (key: string) => boolean): LogRow[] {
    const p = this.pending;
    if (p === undefined || entity !== this.pendingEntity || !inScope(p.key)) return rows;
    return rows.some((r) => r.hlc === p.hlc) ? rows : [...rows, p];
  }

  /** The ops of one natural key. */
  ofKey(entity: string, key: string): LogOp[] {
    const rows = prepareCached(
      this.db,
      "SELECT hlc, op, key, payload FROM ops WHERE entity = ? AND key = ?",
    ).all(entity, key) as LogRow[];
    return this.withPending(entity, rows, (k) => k === key);
  }

  /** The ops of every key in [lo, hi), grouped by key. */
  range(entity: string, lo: string, hiKey: string): Map<string, LogOp[]> {
    const rows = this.withPending(
      entity,
      prepareCached(
        this.db,
        "SELECT hlc, op, key, payload FROM ops WHERE entity = ? AND key >= ? AND key < ?",
      ).all(entity, lo, hiKey) as LogRow[],
      (k) => k >= lo && k < hiKey,
    );
    const out = new Map<string, LogOp[]>();
    for (const r of rows) {
      const list = out.get(r.key);
      if (list) list.push(r);
      else out.set(r.key, [r]);
    }
    return out;
  }

  /** The oldest task put under workstream `ws` newer than `after`. */
  firstTaskPutAfter(ws: string, after: string | null): string | null {
    const lo = `${ws}/`;
    const row = prepareCached(
      this.db,
      `SELECT MIN(hlc) AS hlc FROM ops
        WHERE entity = 'task' AND op = 'put' AND key >= @lo AND key < @hi
          AND (@after IS NULL OR hlc > @after)`,
    ).get({ lo, hi: hi(lo), after }) as { hlc: string | null };
    const p = this.pending;
    let best = row.hlc;
    if (
      p !== undefined &&
      this.pendingEntity === "task" &&
      p.op === "put" &&
      p.key >= lo &&
      p.key < hi(lo) &&
      (after === null || p.hlc > after)
    ) {
      best = best === null || p.hlc < best ? p.hlc : best;
    }
    return best;
  }

  /** Edge keys naming a task in `scope`: a workstream (`name/`) or one task. */
  edgeKeysTouching(scope: { workstream: string } | { task: string }): string[] {
    const candidates =
      "workstream" in scope
        ? prepareCached(
            this.db,
            `SELECT DISTINCT key FROM ops
              WHERE entity = 'edge' AND (instr(key, @to) > 0 OR (key >= @lo AND key < @hi))`,
          ).all({
            to: `->${scope.workstream}/`,
            lo: `${scope.workstream}/`,
            hi: hi(`${scope.workstream}/`),
          })
        : prepareCached(
            this.db,
            `SELECT DISTINCT key FROM ops
              WHERE entity = 'edge'
                AND ((key >= @lo AND key < @hi) OR substr(key, -length(@to)) = @to)`,
          ).all({ to: `->${scope.task}`, lo: `${scope.task}->`, hi: hi(`${scope.task}->`) });
    const keys = new Set((candidates as { key: string }[]).map((r) => r.key));
    const p = this.pending;
    if (p !== undefined && this.pendingEntity === "edge") keys.add(p.key);
    return [...keys].filter((key) => {
      let ends: { blocker: string; blocked: string };
      try {
        ends = parseEdgeKey(key);
      } catch {
        return false;
      }
      const inScope = (t: string): boolean =>
        "workstream" in scope ? t.startsWith(`${scope.workstream}/`) : t === scope.task;
      return inScope(ends.blocker) || inScope(ends.blocked);
    });
  }
}

/** The newest tombstone covering a task: its own `del` or its workstream's
 *  (a workstream `del` cascades every task, note and edge beneath it). */
function taskHorizon(log: Log, taskKey: string): string | null {
  const { workstream } = parseTaskKey(taskKey);
  return laterHlc(
    newestDel(log.ofKey("task", taskKey)),
    newestDel(log.ofKey("workstream", workstream)),
  );
}

// ─── Reconcile: make a row equal its fold ─────────────────────────────

type Fields = Record<string, string | number | null>;

/** The names of the fields on which `a` and `b` differ, in `a`'s order. */
function differing(a: Fields, b: Fields): string[] {
  return Object.keys(a).filter((k) => a[k] !== b[k]);
}

const workstreamId = (db: Db, name: string): number | null =>
  (
    prepareCached(db, "SELECT id FROM workstreams WHERE name = ?").get(name) as
      | { id: number }
      | undefined
  )?.id ?? null;

/** Surrogate id for a task natural key, or null when absent. */
function taskRowId(db: Db, key: string): number | null {
  const { workstream, localId } = parseTaskKey(key);
  const row = prepareCached(
    db,
    `SELECT t.id AS id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
      WHERE w.name = ? AND t.local_id = ?`,
  ).get(workstream, localId) as { id: number } | undefined;
  return row?.id ?? null;
}

interface Reconciled {
  changed: boolean;
  fields: string[];
}
const UNCHANGED: Reconciled = { changed: false, fields: [] };

function syncWorkstream(db: Db, log: Log, name: string): Reconciled {
  const state = foldWorkstream(log.ofKey("workstream", name), (after) =>
    log.firstTaskPutAfter(name, after),
  );
  const row = prepareCached(
    db,
    "SELECT id, created_at, torn_down_at FROM workstreams WHERE name = ?",
  ).get(name) as { id: number; created_at: string; torn_down_at: string | null } | undefined;
  if (state === null) {
    if (row === undefined) return UNCHANGED;
    // FK CASCADE removes the tasks, notes and edges beneath it.
    prepareCached(db, "DELETE FROM workstreams WHERE id = ?").run(row.id);
    return { changed: true, fields: [] };
  }
  const want: Fields = { created_at: state.createdAt, torn_down_at: state.tornDownAt };
  if (row === undefined) {
    prepareCached(
      db,
      "INSERT INTO workstreams (name, created_at, torn_down_at) VALUES (?, ?, ?)",
    ).run(name, state.createdAt, state.tornDownAt);
    return { changed: true, fields: Object.keys(want) };
  }
  const fields = differing(want, { created_at: row.created_at, torn_down_at: row.torn_down_at });
  if (fields.length === 0) return UNCHANGED;
  prepareCached(db, "UPDATE workstreams SET created_at = ?, torn_down_at = ? WHERE id = ?").run(
    state.createdAt,
    state.tornDownAt,
    row.id,
  );
  return { changed: true, fields };
}

function syncTask(db: Db, log: Log, key: string): Reconciled {
  const { workstream, localId } = parseTaskKey(key);
  const state = foldTask(log.ofKey("task", key), taskHorizon(log, key), localId);
  const existing = prepareCached(
    db,
    `SELECT t.id, t.title, t.status, t.substate, t.impact, t.effort_days, t.scored,
            t.dispatch_host, t.kind, t.wave, t.created_at, t.updated_at
       FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
      WHERE w.name = ? AND t.local_id = ?`,
  ).get(workstream, localId) as (Fields & { id: number }) | undefined;
  if (state === null) {
    if (existing === undefined) return UNCHANGED;
    prepareCached(db, "DELETE FROM tasks WHERE id = ?").run(existing.id);
    return { changed: true, fields: [] };
  }
  const want: Fields = {
    title: state.title,
    status: state.status,
    substate: state.substate,
    impact: state.impact,
    effort_days: state.effortDays,
    scored: state.scored,
    dispatch_host: state.dispatchHost,
    kind: state.kind,
    wave: state.wave,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
  };
  if (existing === undefined) {
    const wsId = workstreamId(db, workstream);
    // The workstream fold keeps the parent of every live task alive.
    if (wsId === null) return UNCHANGED;
    prepareCached(
      db,
      `INSERT INTO tasks (workstream_id, local_id, title, status, substate, impact, effort_days,
                          scored, dispatch_host, kind, wave, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      wsId,
      localId,
      state.title,
      state.status,
      state.substate,
      state.impact,
      state.effortDays,
      state.scored,
      state.dispatchHost,
      state.kind,
      state.wave,
      state.createdAt,
      state.updatedAt,
    );
    return { changed: true, fields: Object.keys(want) };
  }
  const fields = differing(want, existing);
  if (fields.length === 0) return UNCHANGED;
  prepareCached(
    db,
    `UPDATE tasks SET title = ?, status = ?, substate = ?, impact = ?, effort_days = ?,
                      scored = ?, dispatch_host = ?, kind = ?, wave = ?, created_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    state.title,
    state.status,
    state.substate,
    state.impact,
    state.effortDays,
    state.scored,
    state.dispatchHost,
    state.kind,
    state.wave,
    state.createdAt,
    state.updatedAt,
    existing.id,
  );
  return { changed: true, fields };
}

function syncNotes(db: Db, log: Log, taskKey: string): boolean {
  const taskId = taskRowId(db, taskKey);
  if (taskId === null) return false;
  const ops: LogOp[] = [...log.range("note", `${taskKey}#`, `${taskKey}$`).values()].flat();
  const want = foldNotes(ops, taskHorizon(log, taskKey));
  const rows = prepareCached(
    db,
    "SELECT id, author, content, created_at, kind FROM task_notes WHERE task_id = ? ORDER BY id",
  ).all(taskId) as {
    id: number;
    author: string | null;
    content: string;
    created_at: string;
    kind: string;
  }[];
  let changed = false;
  const seen = new Set<string>();
  for (const r of rows) {
    const id = noteIdentity(r.author, r.content, r.created_at);
    if (want.has(id) && !seen.has(id)) {
      seen.add(id);
      continue;
    }
    // Not in the fold, or a repeat of an identity already kept.
    prepareCached(db, "DELETE FROM task_notes WHERE id = ?").run(r.id);
    changed = true;
  }
  for (const [id, n] of want) {
    if (seen.has(id)) continue;
    prepareCached(
      db,
      "INSERT INTO task_notes (task_id, author, content, created_at, kind) VALUES (?, ?, ?, ?, ?)",
    ).run(taskId, n.author, n.content, n.createdAt, n.kind);
    changed = true;
  }
  return changed;
}

function syncEdge(db: Db, log: Log, key: string): boolean {
  const { blocker, blocked } = parseEdgeKey(key);
  const state =
    blocker === blocked
      ? null
      : foldEdge(log.ofKey("edge", key), [taskHorizon(log, blocker), taskHorizon(log, blocked)]);
  const fromId = taskRowId(db, blocker);
  const toId = taskRowId(db, blocked);
  const existing =
    fromId === null || toId === null
      ? undefined
      : (prepareCached(
          db,
          "SELECT created_at FROM task_edges WHERE from_task_id = ? AND to_task_id = ?",
        ).get(fromId, toId) as { created_at: string } | undefined);
  const wanted = state !== null && fromId !== null && toId !== null;
  if (!wanted) {
    if (existing === undefined || fromId === null || toId === null) return false;
    prepareCached(db, "DELETE FROM task_edges WHERE from_task_id = ? AND to_task_id = ?").run(
      fromId,
      toId,
    );
    return true;
  }
  if (existing === undefined) {
    prepareCached(
      db,
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    ).run(fromId, toId, state.createdAt);
    return true;
  }
  if (existing.created_at === state.createdAt) return false;
  prepareCached(
    db,
    "UPDATE task_edges SET created_at = ? WHERE from_task_id = ? AND to_task_id = ?",
  ).run(state.createdAt, fromId, toId);
  return true;
}

/** Re-fold a task's notes and every edge touching it: its existence or
 *  horizon changed. */
function syncDependents(db: Db, log: Log, taskKey: string): boolean {
  let changed = syncNotes(db, log, taskKey);
  for (const key of log.edgeKeysTouching({ task: taskKey })) {
    if (syncEdge(db, log, key)) changed = true;
  }
  return changed;
}

// ─── Per-entity application ───────────────────────────────────────────

function applyWorkstream(db: Db, log: Log, op: Op): ApplyResult {
  const name = op.key;
  if (name.length === 0) throw new OpKeyMalformedError("workstream", name);
  const ws = syncWorkstream(db, log, name);
  let changed = ws.changed;
  if (op.op === "del") {
    // The horizon moved: everything beneath the workstream re-folds.
    const prefix = `${name}/`;
    const taskKeys = [...log.range("task", prefix, hi(prefix)).keys()];
    for (const key of taskKeys) if (syncTask(db, log, key).changed) changed = true;
    for (const key of taskKeys) if (syncNotes(db, log, key)) changed = true;
    const edges = log.edgeKeysTouching({ workstream: name });
    for (const key of edges) if (syncEdge(db, log, key)) changed = true;
  }
  return { changed, appliedFields: ws.fields };
}

function applyTask(db: Db, log: Log, op: Op): ApplyResult {
  const { workstream } = parseTaskKey(op.key);
  const existed = taskRowId(db, op.key) !== null;
  const ws = syncWorkstream(db, log, workstream);
  const task = syncTask(db, log, op.key);
  let changed = ws.changed || task.changed;
  const exists = taskRowId(db, op.key) !== null;
  if ((op.op === "del" || existed !== exists) && syncDependents(db, log, op.key)) changed = true;
  return { changed, appliedFields: task.fields };
}

function applyNote(db: Db, log: Log, op: Op): ApplyResult {
  const { taskKey } = parseNoteKey(op.key);
  return { changed: syncNotes(db, log, taskKey), appliedFields: [] };
}

function applyEdge(db: Db, log: Log, op: Op): ApplyResult {
  parseEdgeKey(op.key);
  return { changed: syncEdge(db, log, op.key), appliedFields: [] };
}

// ─── The seam ─────────────────────────────────────────────────────────

/**
 * Apply one op to the portable tables.
 *
 * SYNCHRONOUS, for the same reason `withOpContext` is: the op context is
 * a per-connection temp table, so two interleaved async apply scopes
 * would clobber each other's `applying` flag with no way to tell whose
 * suppression was in force. Keeping this sync makes that
 * unrepresentable rather than merely discouraged.
 *
 * Runs inside `withCaptureSuppressed`, which is THE echo guard: without
 * it, writing a peer's op to `tasks` would fire the capture trigger,
 * mint a fresh local op, flush that back to the peer, and loop forever.
 * Runs in its own transaction (a savepoint when nested): one op rewrites
 * several rows, and they commit together or not at all.
 *
 * Does NOT insert the op into `ops` — that is the caller's job (which
 * owns segment bookkeeping and the (machine_id, hlc) dedupe). The op is
 * folded in beside the log's rows, so recording it before or after
 * changes nothing and a replay of ops already in the log is a no-op.
 *
 * Idempotent: applying the same op twice makes no second change, which
 * is what lets `mu sync --repair` be nothing more than "re-read that
 * peer's segment from zero".
 */
export function applyOp(db: Db, op: Op): ApplyResult {
  if (isKnownMachineLocalEntity(op.entity)) throw new OpEntityNotSyncedError(op.entity);
  // An entity this build does not recognise is a FORWARD-COMPATIBLE
  // no-op, projected nowhere, exactly like 'message'. Recording the op
  // is the caller's step and is what preserves it for a later build
  // (and for `mu rebuild`) without blocking every op behind it.
  if (!isSyncedEntity(op.entity)) return { changed: false, appliedFields: [] };
  // Log lines live in `ops` only; recording the op IS applying it.
  if (op.entity === "message") return { changed: false, appliedFields: [] };

  return withCaptureSuppressed(db, () =>
    db
      .transaction((): ApplyResult => {
        const log = new Log(db, op);
        switch (op.entity) {
          case "workstream":
            return applyWorkstream(db, log, op);
          case "task":
            return applyTask(db, log, op);
          case "note":
            return applyNote(db, log, op);
          default:
            return applyEdge(db, log, op);
        }
      })
      .immediate(),
  );
}

/**
 * Project the whole log: fold every workstream, task, note set and edge
 * the ops name, once each, into the (empty or stale) tables. This is
 * `mu rebuild`: no arrival order, no incremental step, just the fold. It
 * returns the number of table rows it wrote.
 *
 * Workstreams first (a task's fold needs its parent row), then tasks, then
 * the rows that hang off tasks.
 */
export function projectLog(db: Db): number {
  const log = new Log(db);
  const keys = (entity: string): string[] =>
    (
      prepareCached(db, "SELECT DISTINCT key FROM ops WHERE entity = ?").all(entity) as {
        key: string;
      }[]
    ).map((r) => r.key);
  const taskKeys = keys("task");
  const noteTasks = [...new Set(keys("note").map((k) => parseNoteKey(k).taskKey))];
  const workstreams = new Set([
    ...keys("workstream"),
    ...taskKeys.map((k) => parseTaskKey(k).workstream),
  ]);
  let written = 0;
  return withCaptureSuppressed(db, () =>
    db
      .transaction(() => {
        for (const name of workstreams) if (syncWorkstream(db, log, name).changed) written += 1;
        for (const key of taskKeys) if (syncTask(db, log, key).changed) written += 1;
        for (const key of noteTasks) if (syncNotes(db, log, key)) written += 1;
        for (const key of keys("edge")) if (syncEdge(db, log, key)) written += 1;
        return written;
      })
      .immediate(),
  );
}

/**
 * Apply many ops in HLC order, inside one transaction. The fold makes the
 * order irrelevant to the result; sorting keeps the work in log order.
 */
export function applyOps(db: Db, ops: readonly Op[]): ApplyResult[] {
  const ordered = [...ops].sort((a, b) => compareHlc(a.hlc, b.hlc));
  const run = db.transaction(() => ordered.map((op) => applyOp(db, op)));
  return run.immediate();
}
