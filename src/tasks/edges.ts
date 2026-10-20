// mu — task edge reads and mutations.

import type { Db } from "../db.js";
import { withOpContext } from "../op-context.js";
import { lookupTaskAnyWorkstream, taskIdFor, touchTask } from "./core.js";
import { CrossWorkstreamEdgeError, CycleError, TaskNotFoundError } from "./errors.js";
import { getTask } from "./queries.js";
import type { TaskStatus, TaskSubstate } from "./status.js";

export interface TaskEdges {
  /** Tasks that must close before this one can start (blockers). */
  blockers: string[];
  /** Tasks that this one blocks (dependents). */
  dependents: string[];
}

export interface CanonicalBlocker {
  localId: string;
  id: number;
}

export function dedupeBlockersById(blockers: readonly CanonicalBlocker[]): CanonicalBlocker[] {
  const seen = new Set<number>();
  const canonical: CanonicalBlocker[] = [];
  for (const blocker of blockers) {
    if (seen.has(blocker.id)) continue;
    seen.add(blocker.id);
    canonical.push(blocker);
  }
  return canonical;
}

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  if (rightSet.size !== right.length) return false;
  return left.every((value) => rightSet.has(value));
}

/** One end of an edge with the neighbour's current status attached.
 *  Used by `mu task show` to group blockers/dependents into
 *  "still gating" vs "satisfied" buckets without making the renderer
 *  do a second round-trip to the DB per neighbour. */
export interface TaskEdgeWithStatus {
  name: string;
  status: TaskStatus;
  substate: TaskSubstate;
}

export interface TaskEdgesWithStatus {
  /** Tasks that must close before this one can start (blockers),
   *  carrying each blocker's current status. */
  blockers: TaskEdgeWithStatus[];
  /** Tasks that this one blocks (dependents), carrying each
   *  dependent's current status. */
  dependents: TaskEdgeWithStatus[];
}

/**
 * Direct (one-hop) edges for a task. For transitive prerequisites, use
 * `getPrerequisites()`; this helper is the immediate-neighbour view used
 * by `mu task show`.
 */
export function getTaskEdges(db: Db, taskLocalId: string, workstream: string): TaskEdges {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return { blockers: [], dependents: [] };
  const blockers = (
    db
      .prepare(
        `SELECT t.local_id AS id FROM task_edges e
           JOIN tasks t ON t.id = e.from_task_id
          WHERE e.to_task_id = ? ORDER BY t.local_id`,
      )
      .all(taskId) as { id: string }[]
  ).map((r) => r.id);
  const dependents = (
    db
      .prepare(
        `SELECT t.local_id AS id FROM task_edges e
           JOIN tasks t ON t.id = e.to_task_id
          WHERE e.from_task_id = ? ORDER BY t.local_id`,
      )
      .all(taskId) as { id: string }[]
  ).map((r) => r.id);
  return { blockers, dependents };
}

/**
 * Same one-hop edge view as `getTaskEdges`, but each neighbour is
 * returned as `{ name, status }` so callers can group / colour by
 * status without an N+1 round-trip. Used by `mu task show` to split
 * "blocked by" (still-gating) from "satisfied" (already-CLOSED)
 * blockers, and the symmetric split on the dependents side
 * (task_show_blocked_by_renders_closed). OPEN and IN_PROGRESS stay in
 * the still-gating bucket; CLOSED is satisfied.
 */
export function getTaskEdgesWithStatus(
  db: Db,
  taskLocalId: string,
  workstream: string,
): TaskEdgesWithStatus {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return { blockers: [], dependents: [] };
  const blockers = db
    .prepare(
      `SELECT t.local_id AS name, t.status AS status, t.substate AS substate FROM task_edges e
         JOIN tasks t ON t.id = e.from_task_id
        WHERE e.to_task_id = ? ORDER BY t.local_id`,
    )
    .all(taskId) as TaskEdgeWithStatus[];
  const dependents = db
    .prepare(
      `SELECT t.local_id AS name, t.status AS status, t.substate AS substate FROM task_edges e
         JOIN tasks t ON t.id = e.to_task_id
        WHERE e.from_task_id = ? ORDER BY t.local_id`,
    )
    .all(taskId) as TaskEdgeWithStatus[];
  return { blockers, dependents };
}

/**
 * All tasks transitively reachable from `taskId` via reverse-edge
 * traversal (i.e. the set of tasks that block this one), including the
 * task itself.
 */
export function getPrerequisites(db: Db, taskLocalId: string, workstream: string): Set<string> {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return new Set([taskLocalId]);
  // Walk reverse edges in surrogate-id space, then translate back to
  // local_id strings. The seed must be the surrogate id; the result
  // includes the seed task itself (callers like the tracks union-find
  // rely on the inclusive set).
  const rows = db
    .prepare(
      `WITH RECURSIVE reach(node) AS (
         SELECT ?
         UNION
         SELECT from_task_id FROM task_edges, reach WHERE to_task_id = reach.node
       )
       SELECT t.local_id AS local_id FROM reach r JOIN tasks t ON t.id = r.node`,
    )
    .all(taskId) as { local_id: string }[];
  return new Set(rows.map((r) => r.local_id));
}

/**
 * Adding edge `from -> to` creates a cycle iff there's already a path
 * `to -> ... -> from`. SQL recursive CTE expresses this exactly.
 */
export function wouldCreateCycle(db: Db, fromId: number, toId: number): boolean {
  if (fromId === toId) return true;
  const result = db
    .prepare(
      `WITH RECURSIVE forward(node) AS (
         SELECT ?
         UNION
         SELECT to_task_id FROM task_edges, forward WHERE from_task_id = forward.node
       )
       SELECT 1 AS hit FROM forward WHERE node = ? LIMIT 1`,
    )
    .get(toId, fromId) as { hit: number } | undefined;
  return result !== undefined;
}

/**
 * Shortest existing path `toId -> … -> fromId` (task local ids, both ends
 * included), i.e. what adding edge `fromId -> toId` would close into a
 * cycle. Null when there is none. Tracks visited nodes per path, so it
 * terminates even on cycles already present (e.g. created by sync).
 */
export function findCyclePath(db: Db, fromId: number, toId: number): string[] | null {
  if (fromId === toId) {
    const t = db.prepare("SELECT local_id FROM tasks WHERE id = ?").get(fromId) as
      | { local_id: string }
      | undefined;
    return t ? [t.local_id] : null;
  }
  // BFS with parent pointers: linear in edges, shortest by construction,
  // and terminates on cycles already present (each node is visited once).
  // A per-path recursive CTE is exponential on wide DAGs.
  const next = db.prepare("SELECT to_task_id AS id FROM task_edges WHERE from_task_id = ?");
  const parent = new Map<number, number>([[toId, toId]]);
  let frontier = [toId];
  while (frontier.length > 0 && !parent.has(fromId)) {
    const nextFrontier: number[] = [];
    for (const node of frontier) {
      for (const { id } of next.all(node) as { id: number }[]) {
        if (parent.has(id)) continue;
        parent.set(id, node);
        nextFrontier.push(id);
      }
    }
    frontier = nextFrontier;
  }
  if (!parent.has(fromId)) return null;
  const ids: number[] = [];
  for (let n = fromId; ; ) {
    ids.unshift(n);
    if (n === toId) break;
    const p = parent.get(n);
    if (p === undefined) return null;
    n = p;
  }
  const name = db.prepare("SELECT local_id FROM tasks WHERE id = ?");
  return ids.map(
    (id) => (name.get(id) as { local_id: string } | undefined)?.local_id ?? String(id),
  );
}

/** Build a CycleError for edge `blocker -> blocked`, with the closing path. */
export function cycleErrorFor(
  db: Db,
  blocker: string,
  blocked: string,
  blockerId: number,
  blockedId: number,
  workstream?: string,
): CycleError {
  return new CycleError(
    blocker,
    blocked,
    findCyclePath(db, blockerId, blockedId) ?? [],
    workstream,
  );
}

export interface BlockEdgeResult {
  /** True iff a row was actually inserted (vs. already present). */
  added: boolean;
}

/**
 * Add the edge `blocker → blocked` ('blocker blocks blocked').
 * Idempotent (existing edge → `added: false`). Validates:
 *
 *   - both tasks exist
 *   - same workstream (cross-workstream edges forbidden)
 *   - no cycle (the new edge wouldn't form a path blocked → ... → blocker)
 *   - blocker ≠ blocked (no self-reference)
 */
export function addBlockEdge(
  db: Db,
  workstream: string,
  blocked: string,
  blocker: string,
): BlockEdgeResult {
  return withOpContext(db, { intent: "task.block", group: "new" }, () =>
    addBlockEdgeImpl(db, workstream, blocked, blocker),
  );
}

function addBlockEdgeImpl(
  db: Db,
  workstream: string,
  blocked: string,
  blocker: string,
): BlockEdgeResult {
  if (blocked === blocker) {
    // Surface as a typed CycleError so the CLI maps it to exit 4 (conflict)
    // rather than letting the schema CHECK fire as a generic SQL error.
    throw new CycleError(blocker, blocked);
  }
  const blockedRow = getTask(db, blocked, workstream);
  if (!blockedRow) throw new TaskNotFoundError(blocked);
  // Resolve the blocker in the dependent's workstream first, then
  // globally so a cross-workstream blocker surfaces
  // CrossWorkstreamEdgeError (clearer than TaskNotFoundError). Cycle
  // check + same-workstream guard run after.
  const blockerRow = lookupTaskAnyWorkstream(db, blocker, blockedRow.workstreamName);
  if (!blockerRow) throw new TaskNotFoundError(blocker);
  if (blockedRow.workstreamName !== blockerRow.workstreamName) {
    throw new CrossWorkstreamEdgeError(
      blocker,
      blockerRow.workstreamName,
      blocked,
      blockedRow.workstreamName,
    );
  }
  const blockedId = taskIdFor(db, blocked, blockedRow.workstreamName);
  const blockerId = taskIdFor(db, blocker, blockerRow.workstreamName);
  if (blockedId === null || blockerId === null) throw new TaskNotFoundError(blocked);
  if (wouldCreateCycle(db, blockerId, blockedId)) {
    throw cycleErrorFor(db, blocker, blocked, blockerId, blockedId, blockedRow.workstreamName);
  }
  const now = new Date().toISOString();
  const added = db
    .transaction(() => {
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
        )
        .run(blockerId, blockedId, now);
      if (result.changes > 0) {
        // Bump the BLOCKED task — its blocker set changed. The blocker
        // itself is unaffected. Aligned with reparentTask, which also
        // bumps the FROM_TASK side (the task whose blockers shifted).
        touchTask(db, blockedId, now);
        return true;
      }
      return false;
    })
    .immediate();
  // No emitEvent: the task_edges INSERT fired the capture trigger
  // (intent='task.block', key='<ws>/<blocker>-><ws>/<blocked>').
  return { added };
}

export interface RemoveBlockEdgeResult {
  /** True iff a row was actually deleted (vs. no such edge). */
  removed: boolean;
}

/**
 * Remove the edge `blocker → blocked`. Idempotent (no edge →
 * `removed: false`). Does NOT validate task existence — if the
 * edge is gone there's nothing to do, regardless of whether the
 * tasks are gone too.
 */
export function removeBlockEdge(
  db: Db,
  workstream: string,
  blocked: string,
  blocker: string,
): RemoveBlockEdgeResult {
  return withOpContext(db, { intent: "task.unblock", group: "new" }, () =>
    removeBlockEdgeImpl(db, workstream, blocked, blocker),
  );
}

function removeBlockEdgeImpl(
  db: Db,
  workstream: string,
  blocked: string,
  blocker: string,
): RemoveBlockEdgeResult {
  const blockedRow = getTask(db, blocked, workstream);
  if (!blockedRow) return { removed: false };
  const blockerRow = getTask(db, blocker, workstream);
  if (!blockerRow) return { removed: false };
  const blockedId = taskIdFor(db, blocked, blockedRow.workstreamName);
  const blockerId = taskIdFor(db, blocker, blockerRow.workstreamName);
  if (blockedId === null || blockerId === null) return { removed: false };
  const removed = db
    .transaction(() => {
      const result = db
        .prepare("DELETE FROM task_edges WHERE from_task_id = ? AND to_task_id = ?")
        .run(blockerId, blockedId);
      if (result.changes > 0) {
        // Bump the BLOCKED task — its blocker set just shrank.
        touchTask(db, blockedId);
        return true;
      }
      return false;
    })
    .immediate();
  if (removed) {
    // No emitEvent: the DELETE fired the capture trigger, writing an
    // edge tombstone with intent='task.unblock'.
  }
  return { removed };
}

export interface ReparentTaskResult {
  /** Edges removed (i.e. all incoming `to_task = taskId` edges). */
  removedEdges: number;
  /** Edges added (after duplicate blockers are canonicalised). */
  addedEdges: number;
}

/**
 * Atomically replace every incoming edge of `taskId` with new ones
 * `blocker[i] → taskId`. Pass an empty `blockers` array to clear all
 * incoming edges (the task becomes ready iff its status allows).
 *
 * Validates ALL new blockers up-front (existence + same workstream +
 * cycle check); if any fails, no DELETE happens — the call is fully
 * atomic via a single transaction.
 *
 * Cycle reasoning: removing the existing incoming edges to `taskId`
 * doesn't change `taskId`'s OUTGOING reachability, so
 * `wouldCreateCycle(db, blocker, taskId)` evaluated against the
 * pre-state gives the right answer for each new edge.
 */
export function reparentTask(
  db: Db,
  taskLocalId: string,
  blockers: readonly string[],
  scope: { workstream: string },
): ReparentTaskResult {
  // One group for the whole reparent: it DELETEs the old blocker edges
  // and INSERTs the new ones, which is one operator action and must
  // undo as one.
  return withOpContext(db, { intent: "task.reparent", group: "new" }, () =>
    reparentTaskImpl(db, taskLocalId, blockers, scope),
  );
}

function reparentTaskImpl(
  db: Db,
  taskLocalId: string,
  blockers: readonly string[],
  scope: { workstream: string },
): ReparentTaskResult {
  const task = getTask(db, taskLocalId, scope.workstream);
  if (!task) throw new TaskNotFoundError(taskLocalId);
  const taskSurrogateId = taskIdFor(db, task.name, task.workstreamName);
  if (taskSurrogateId === null) throw new TaskNotFoundError(taskLocalId);

  // Resolve every blocker up-front to its surrogate id; do all
  // existence + same-workstream + cycle checks before any DELETE.
  // Look up blockers in the task's workstream first, then across all
  // workstreams so a blocker that exists only in a DIFFERENT workstream surfaces CrossWorkstreamEdgeError (clearer
  // than TaskNotFoundError). Duplicate blockers are an ergonomic input
  // accident from repeat/CSV forms, so silently canonicalise by
  // surrogate id while preserving first-seen order.
  const requestedBlockers: CanonicalBlocker[] = [];
  for (const blockerLocalId of blockers) {
    if (blockerLocalId === taskLocalId) {
      throw new CycleError(blockerLocalId, taskLocalId);
    }
    const blocker = lookupTaskAnyWorkstream(db, blockerLocalId, task.workstreamName);
    if (!blocker) throw new TaskNotFoundError(blockerLocalId);
    if (blocker.workstreamName !== task.workstreamName) {
      throw new CrossWorkstreamEdgeError(
        blockerLocalId,
        blocker.workstreamName,
        taskLocalId,
        task.workstreamName,
      );
    }
    const blockerId = taskIdFor(db, blocker.name, blocker.workstreamName);
    if (blockerId === null) throw new TaskNotFoundError(blockerLocalId);
    if (wouldCreateCycle(db, blockerId, taskSurrogateId)) {
      throw cycleErrorFor(
        db,
        blockerLocalId,
        taskLocalId,
        blockerId,
        taskSurrogateId,
        task.workstreamName,
      );
    }
    requestedBlockers.push({ localId: blockerLocalId, id: blockerId });
  }
  const canonicalBlockers = dedupeBlockersById(requestedBlockers);
  const blockerIds = canonicalBlockers.map((blocker) => blocker.id);
  const currentBlockerIds = (
    db
      .prepare("SELECT from_task_id AS id FROM task_edges WHERE to_task_id = ?")
      .all(taskSurrogateId) as { id: number }[]
  ).map((row) => row.id);

  if (sameNumberSet(currentBlockerIds, blockerIds)) {
    return { removedEdges: 0, addedEdges: 0 };
  }

  return db
    .transaction(() => {
      const removed = db
        .prepare("DELETE FROM task_edges WHERE to_task_id = ?")
        .run(taskSurrogateId);
      const insertEdge = db.prepare(
        "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
      );
      const now = new Date().toISOString();
      for (const blockerId of blockerIds) {
        insertEdge.run(blockerId, taskSurrogateId, now);
      }
      // Bump the reparented task itself — its blocker set just changed.
      touchTask(db, taskSurrogateId, now);
      // No emitEvent: every edge DELETE and INSERT in this transaction
      // fired the capture trigger under intent='task.reparent'.
      return { removedEdges: removed.changes, addedEdges: blockerIds.length };
    })
    .immediate();
}

export interface EdgeCycle {
  workstream: string;
  /** Local ids around the cycle, `a -> b -> … -> a` (first id not repeated). */
  path: string[];
  /** Local ids of an edge on it: `blocker` blocks `blocked`. Removing it breaks this cycle. */
  blocker: string;
  blocked: string;
}

/**
 * Cycles already present in task_edges. addBlockEdge refuses to make one,
 * but sync can merge two locally valid edges into one (apply never
 * rejects a peer's edge). Cycle members never become ready. One cycle is
 * reported per strongly-connected stretch; breaking it may reveal another.
 */
export function findEdgeCycles(db: Db): EdgeCycle[] {
  const rows = db
    .prepare(
      `SELECT e.from_task_id AS f, e.to_task_id AS t, w.name AS ws
         FROM task_edges e
         JOIN tasks a ON a.id = e.from_task_id
         JOIN workstreams w ON w.id = a.workstream_id
        ORDER BY w.name, e.from_task_id, e.to_task_id`,
    )
    .all() as { f: number; t: number; ws: string }[];
  // Peel nodes with no in-edges or no out-edges until stable: what is
  // left lies on, or between, cycles.
  let live = rows;
  for (;;) {
    const ins = new Set(live.map((r) => r.t));
    const outs = new Set(live.map((r) => r.f));
    const kept = live.filter((r) => ins.has(r.f) && outs.has(r.t));
    if (kept.length === live.length) break;
    live = kept;
  }
  const name = db.prepare("SELECT local_id FROM tasks WHERE id = ?");
  const local = (id: number): string =>
    (name.get(id) as { local_id: string } | undefined)?.local_id ?? String(id);
  const seen = new Set<number>();
  const cycles: EdgeCycle[] = [];
  for (const r of live) {
    if (seen.has(r.f) && seen.has(r.t)) continue;
    const path = findCyclePath(db, r.f, r.t); // r.t -> … -> r.f
    if (path === null) continue;
    cycles.push({
      workstream: r.ws,
      path: [local(r.f), ...path.slice(0, -1)],
      blocker: local(r.f),
      blocked: local(r.t),
    });
    const ids = db
      .prepare(
        "SELECT id FROM tasks WHERE workstream_id = (SELECT workstream_id FROM tasks WHERE id = ?) AND local_id IN (" +
          path.map(() => "?").join(",") +
          ")",
      )
      .all(r.f, ...path) as { id: number }[];
    for (const { id } of ids) seen.add(id);
  }
  return cycles;
}
