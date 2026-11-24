// mu — dead `--worktree` stagings. A spawn killed past the reach of its own
// rollback (SIGKILL, a crash) between staging and its pane leaves the
// placeholder row (pane `%pending-<name>`). `mu doctor` lists it; the next
// spawn reclaims it without touching an unregistered directory.

import { type AgentRow, deleteAgent, getAgent, isPendingPaneId, listAgents } from "../agents.js";
import type { Db } from "../db.js";
import { getWorktreeAt, reclaimWorktreePath } from "../worktree.js";
import { withAgentLock } from "./lock.js";

/** A live spawn patches its placeholder within the spawn lock's 15 s acquire
 *  plus pane creation (staging itself holds the agent lock, checked too). */
const STAGING_DEAD_MS = 60_000;

/** Local placeholder rows older than the staging window, counted from the
 *  later of the row and its worktree's registration (a slow create is live). */
export function deadStagings(db: Db, workstream?: string, now = Date.now()): AgentRow[] {
  return listAgents(db, workstream === undefined ? {} : { workstream }).filter((a) => {
    if (!isPendingPaneId(a.paneId) || a.host !== null) return false;
    const made = a.cwd === null ? undefined : getWorktreeAt(db, a.cwd)?.createdAt;
    return now - Math.max(Date.parse(a.updatedAt), made ? Date.parse(made) : 0) > STAGING_DEAD_MS;
  });
}

/**
 * Remove `workstream`'s dead stagings: under the agent lock (a busy lock means
 * a live holder: skipped), only the same placeholder, and its worktree only
 * when it is mu's own unused one. The row predates path admission, so it
 * proves nothing about an unregistered path. Leave that path for recovery.
 * Best-effort per row; returns the names reclaimed.
 */
export async function reclaimDeadStagings(db: Db, workstream: string): Promise<string[]> {
  const done: string[] = [];
  for (const a of deadStagings(db, workstream)) {
    try {
      await withAgentLock(
        db,
        workstream,
        a.name,
        async () => {
          const cur = getAgent(db, a.name, workstream);
          if (cur?.incarnation !== a.incarnation || cur.paneId !== a.paneId) return;
          if (cur.cwd !== null && getWorktreeAt(db, cur.cwd) !== undefined) {
            await reclaimWorktreePath(db, { agent: a.name, workstream, path: cur.cwd });
          }
          if (deleteAgent(db, a.name, workstream, { incarnation: a.incarnation }))
            done.push(a.name);
        },
        { acquireTimeoutMs: 0 },
      );
    } catch {
      // busy or refused: left in place, and listed by `mu doctor`
    }
  }
  return done;
}
