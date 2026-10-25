// mu — the reaper's row-level step, shared by every path that deletes an agent row.
//
// `reapAgentRow` runs INSIDE the caller's transaction (it opens none) and
// does, in order: snapshot the tasks the agent holds IN_PROGRESS, DELETE the
// row (the FK sets tasks.owner_id NULL; its trigger records a remote
// worktree, src/db-recovery.ts), free its host channel, then reopen each snapshotted
// task with a `[reaper]` note. A throw anywhere rolls the lot back with the
// caller's transaction: the row stays, nothing is recorded.
//
// The op context is the CALLER's: `deleteAgent` opens `task.reap`, teardown
// its own `workstream.teardown` group, and the reaper adds no group of its
// own. The note is inserted by task id (not through `addNote`, which looks
// the task up through a LIVE workstream): an owned task in a workstream that
// is already torn down must still be reopened, never left IN_PROGRESS with no
// owner.

import type { Db } from "../db.js";
import { releaseHostChannelsForAgent } from "../hosts.js";
import { withOpContext } from "../op-context.js";

export interface ReapOptions {
  /** False when the caller has itself dealt with the remote worktree (a close that removed it). Default true. */
  preserve?: boolean;
}

/** Delete agent row `agentId` (named `name`, for the note). False when it is already gone. */
export function reapAgentRow(
  db: Db,
  agentId: number,
  name: string,
  opts: ReapOptions = {},
): boolean {
  const stuck = db
    .prepare(
      `SELECT t.id AS taskId FROM tasks t
        WHERE t.owner_id = ? AND t.status = 'IN_PROGRESS'`,
    )
    .all(agentId) as Array<{ taskId: number }>;
  const pane = db.prepare("SELECT pane_id FROM agents WHERE id = ?").get(agentId) as
    | { pane_id: string }
    | undefined;
  if (pane === undefined) return false;
  // The row's AFTER DELETE trigger writes its remote recovery record (src/db-recovery.ts).
  if (db.prepare("DELETE FROM agents WHERE id = ?").run(agentId).changes === 0) return false;
  // A close that has itself removed (or found gone) the tree owes no record.
  if (opts.preserve === false)
    db.prepare("DELETE FROM remote_recovery WHERE agent_id = ?").run(agentId);
  // A remote agent's pane IS its host transport: the row's death frees the
  // channel it held, by registry id + pane (never a name).
  releaseHostChannelsForAgent(db, agentId, pane.pane_id);
  const reopen = db.prepare(
    "UPDATE tasks SET status = 'OPEN', substate = CASE WHEN kind = 'human' THEN 'parked' ELSE 'todo' END, updated_at = ? WHERE id = ?",
  );
  const note = db.prepare(
    "INSERT INTO task_notes (task_id, author, content, created_at, kind) VALUES (?, 'reaper', ?, ?, 'note')",
  );
  for (const t of stuck) {
    const now = new Date().toISOString();
    reopen.run(now, t.taskId);
    // The note keeps its own intent (as `addNote` gave it) inside the caller's group.
    withOpContext(db, { intent: "task.note", actor: "reaper" }, () =>
      note.run(
        t.taskId,
        `[reaper] previous owner ${name} gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared`,
        now,
      ),
    );
  }
  return true;
}
