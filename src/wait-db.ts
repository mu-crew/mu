// mu — the database reads and writes behind waitForEvents that need no loop
// state: the CLOSE application of a settled run, the existence check, and
// the open-blocker traversal.

import { settledCloseInput } from "./agents/observe.js";
import { applySettledClose } from "./close-block.js";
import type { Db } from "./db.js";
import type { AgentReading, CloseOutcome, WaitRef } from "./wait-types.js";

/**
 * Apply the CLOSE block of a settled ctl run, once; never throws.
 * undefined when there is nothing to apply: closing is off, the reading is
 * not a ctl-settled run, or it lacks the incarnation or run count.
 * applySettledClose refuses delegate and human tasks.
 */
export function closeSettledRun(
  db: Db,
  ref: WaitRef,
  r: AgentReading,
  enabled: boolean,
): CloseOutcome | undefined {
  if (!enabled || r.settled !== true) return undefined;
  const row = db
    .prepare(
      `SELECT a.id FROM agents a JOIN workstreams w ON w.id = a.workstream_id
        WHERE a.name = ? AND w.name = ?`,
    )
    .get(ref.id, ref.workstream) as { id: number } | undefined;
  const facts = settledCloseInput({
    workstream: ref.workstream,
    name: ref.id,
    agentId: r.agentId ?? row?.id ?? 0,
    status: r.status,
    settled: true,
    ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
    ...(r.runs !== undefined ? { runs: r.runs } : {}),
    ...(r.lastText !== undefined ? { lastText: r.lastText } : {}),
    ...(r.lastTextTruncated !== undefined ? { lastTextTruncated: r.lastTextTruncated } : {}),
    ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
  });
  if (facts === undefined) return undefined;
  try {
    const res = applySettledClose(db, facts);
    return { applied: res.applied, task: res.task, reason: res.reason };
  } catch (e) {
    return { applied: false, task: null, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function agentExists(db: Db, ref: Pick<WaitRef, "workstream" | "id">): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id
          WHERE a.name = ? AND ws.name = ?`,
      )
      .get(ref.id, ref.workstream) !== undefined
  );
}

export * from "./wait-types.js";

/** The open transitive blockers of task row `umbrella`, uncapped, in a stable order. */
export function openBlockers(db: Db, umbrella: number): { id: string; ws: string }[] {
  return db.prepare(BLOCKERS_SQL).all(umbrella) as { id: string; ws: string }[];
}

const BLOCKERS_SQL = `
  WITH RECURSIVE reach(node) AS (
    SELECT e.from_task_id FROM task_edges e WHERE e.to_task_id = ?
    UNION
    SELECT e.from_task_id FROM task_edges e
      JOIN reach r ON e.to_task_id = r.node
      JOIN tasks t ON t.id = r.node
     WHERE t.status <> 'CLOSED'
  )
  SELECT t.local_id AS id, w.name AS ws FROM reach r
    JOIN tasks t ON t.id = r.node JOIN workstreams w ON w.id = t.workstream_id
   ORDER BY w.name, t.local_id`;

/** The registry row id of an agent ref (0 when it has no row): the identity a death or dialog token is pinned to. */
export function agentRowId(db: Db, ref: Pick<WaitRef, "workstream" | "id">): number {
  const row = db
    .prepare(
      `SELECT a.id FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id
        WHERE a.name = ? AND ws.name = ?`,
    )
    .get(ref.id, ref.workstream) as { id: number } | undefined;
  return row?.id ?? 0;
}

/** The ops log head: what a wait that owns no cursor anchors a reaper flip to. */
export function opsHead(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM ops").get() as { s: number }).s;
}

/**
 * The reaper's flip of a task, read from the ops log (durable, never a wait's memory): when the
 * task's LATEST status or substate change is the reaper's (`task.reap`) and came after ops seq `since`, its owner
 * died with the work undone. A later claim, release, park, open or close is a decision, not a
 * death: it is the latest change then, and this returns undefined. `ownerId` is the row the reaper
 * removed (the last owner the log names before the flip; 0 if none), the same token a live wait pins.
 */
export function reapFlip(
  db: Db,
  ref: Pick<WaitRef, "workstream" | "id">,
  since: number,
): { seq: number; ownerId: number } | undefined {
  const key = `${ref.workstream}/${ref.id}`;
  const last = db
    .prepare(
      `SELECT seq, intent FROM ops WHERE entity = 'task' AND key = ?
          AND (json_extract(payload, '$.status') IS NOT NULL OR json_extract(payload, '$.substate') IS NOT NULL)
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(key) as { seq: number; intent: string | null } | undefined;
  if (last === undefined || last.intent !== "task.reap" || last.seq <= since) return undefined;
  const owner = db
    .prepare(
      `SELECT json_extract(payload, '$.owner_id') AS id FROM ops
        WHERE entity = 'task' AND key = ? AND seq < ? AND json_extract(payload, '$.owner_id') IS NOT NULL
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(key, last.seq) as { id: number } | undefined;
  return { seq: last.seq, ownerId: Number(owner?.id ?? 0) };
}

/** The registry row id of a task's current owner (0 when it has none). */
export function taskOwnerRowId(db: Db, ref: Pick<WaitRef, "workstream" | "id">): number {
  const row = db
    .prepare(
      `SELECT COALESCE(t.owner_id, 0) AS id FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE t.local_id = ? AND ws.name = ?`,
    )
    .get(ref.id, ref.workstream) as { id: number } | undefined;
  return row?.id ?? 0;
}
