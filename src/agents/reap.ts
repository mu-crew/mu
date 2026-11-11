// mu — the reaper's row-level step, shared by every path that deletes an agent row.
//
// `reapAgentRow` runs INSIDE the caller's transaction (it opens none) and
// does, in order: snapshot the tasks the agent holds IN_PROGRESS, DELETE the
// row (the FK sets tasks.owner_id NULL; its trigger records a remote
// worktree, src/db-recovery.ts), free its host channel, drop its unresolved
// plugin deliveries with an event naming them, then reopen each snapshotted
// task with a `[reaper]` note. A throw anywhere rolls the lot back with the
// caller's transaction: the row stays, nothing is recorded.
//
// A lease row whose reservation holds a job is the exception: pane loss proves its carrier
// gone, not the job, so its tasks reopen OPEN/parked (out of `ready`) unless the caller
// settled the job itself (`leaseSettled`, a close that stopped or abandoned it).
//
// The op context is the CALLER's: `deleteAgent` opens `task.reap`, teardown
// its own `workstream.teardown` group, and the reaper adds no group of its
// own. The note is inserted by task id (not through `addNote`, which looks
// the task up through a LIVE workstream): an owned task in a workstream that
// is already torn down must still be reopened, never left IN_PROGRESS with no
// owner.

import type { Db } from "../db.js";
import { dropDeliveries } from "../effects.js";
import { releaseHostChannelsForAgent } from "../hosts.js";
import { emitEvent } from "../logs.js";
import { withOpContext } from "../op-context.js";
import { shellWord } from "../shell-quote.js";

export interface ReapOptions {
  /** False when the caller has itself dealt with the remote worktree (a close that removed it). Default true. */
  preserve?: boolean;
  /** True when the caller stopped (or abandoned) the row's lease job: its tasks reopen as todo. */
  leaseSettled?: boolean;
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
      `SELECT t.id AS taskId, t.local_id AS localId, w.name AS ws FROM tasks t
        JOIN workstreams w ON w.id = t.workstream_id
        WHERE t.owner_id = ? AND t.status = 'IN_PROGRESS'`,
    )
    .all(agentId) as Array<{ taskId: number; localId: string; ws: string }>;
  const pane = db
    .prepare(
      "SELECT a.pane_id, w.name AS ws FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE a.id = ?",
    )
    .get(agentId) as { pane_id: string; ws: string } | undefined;
  if (pane === undefined) return false;
  // The job this row's reservation holds may still run: the tasks wait for a reattach or close.
  const lease =
    opts.leaseSettled === true
      ? undefined
      : (db
          .prepare(
            "SELECT job, host FROM carrier_jobs WHERE agent_id = ? AND job IS NOT NULL ORDER BY id LIMIT 1",
          )
          .get(agentId) as { job: string; host: string } | undefined);
  // The row's AFTER DELETE trigger writes its remote recovery record (src/db-recovery.ts).
  if (db.prepare("DELETE FROM agents WHERE id = ?").run(agentId).changes === 0) return false;
  // A close that has itself removed (or found gone) the tree owes no record.
  if (opts.preserve === false)
    db.prepare("DELETE FROM remote_recovery WHERE agent_id = ?").run(agentId);
  // A remote agent's pane IS its host transport: the row's death frees the
  // channel it held, by registry id + pane (never a name).
  releaseHostChannelsForAgent(db, agentId, pane.pane_id);
  // Its unresolved plugin deliveries go with it, the loss named (plugins spec D4: "until a human
  // checks or closes"): nothing can resolve a delivery to a row that is gone.
  const lost = dropDeliveries(db, agentId);
  if (lost.length > 0) {
    emitEvent(
      db,
      pane.ws,
      "agent.send",
      `delivery outcome lost with agent ${name}: ${lost.map((e) => `${e.method} ${e.key}`).join(", ")} (never confirmed; a late result is found by its key)`,
    );
  }
  const reopen = db.prepare(
    "UPDATE tasks SET status = 'OPEN', substate = CASE WHEN kind = 'human' OR ? THEN 'parked' ELSE 'todo' END, updated_at = ? WHERE id = ?",
  );
  const note = db.prepare(
    "INSERT INTO task_notes (task_id, author, content, created_at, kind) VALUES (?, 'reaper', ?, ?, 'note')",
  );
  for (const t of stuck) {
    const now = new Date().toISOString();
    reopen.run(lease === undefined ? 0 : 1, now, t.taskId);
    const content =
      lease === undefined
        ? `[reaper] previous owner ${name} gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared`
        : `[reaper] previous owner ${name} gone (pane died); its lease job ${lease.job} on ${lease.host} may still run, so the task is parked: resume with ${resumeHint(name, pane.ws, t.localId, t.ws)}`;
    // The note keeps its own intent (as `addNote` gave it) inside the caller's group.
    withOpContext(db, { intent: "task.note", actor: "reaper" }, () =>
      note.run(t.taskId, content, now),
    );
  }
  return true;
}

/**
 * The two ways out of a parked task, as shell words. `reattach --task` resolves its ids in the
 * agent's workstream, so a task owned across workstreams is claimed back in a second step.
 */
function resumeHint(name: string, aws: string, id: string, tws: string): string {
  const [n, a, i, t] = [name, aws, id, tws].map(shellWord);
  if (aws === tws)
    return `mu agent reattach ${n} -w ${a} --task ${i}, or mu agent close ${n} -w ${a} then mu task unpark ${i}`;
  return `mu agent reattach ${n} -w ${a} then mu task claim ${i} -w ${t} --for ${shellWord(`${aws}/${name}`)} --force, or mu agent close ${n} -w ${a} then mu task unpark ${i} -w ${t}`;
}
