// mu — `agent close`: preview and apply, fenced on the agent's identity.
//
// Close is destructive and slow (a pane kill, git cleanup of the worktree,
// the row delete), and every `await` in it is a window in which the agent
// can be replaced under the same name. Three guards, in order:
//
//   1. PREVIEW. `previewClose` writes nothing and prints the blast radius
//      plus `agentRevision` (src/revision.ts). `closeAgent` with
//      `ifRevision` recomputes it under the agent lock and refuses, before
//      anything is killed, when it moved (`RevisionMismatchError`, exit 4).
//   2. LOCK. The whole sequence holds the agent lock, fail-closed and
//      strict (src/agents/lock.ts); a `--worktree` spawn's staging and
//      rollback take the same one, so none of them re-stages the disk
//      state this close is removing.
//   3. IDENTITY. The row is captured with its incarnation. After the
//      kill and the liveness probe it is read again: a different
//      incarnation or pane means the name was replaced, and the close stops
//      (`AgentReplacedError`) before touching the worktree. The final delete
//      and the socket unlink compare the incarnation too (`deleteAgent`'s
//      `expected`): a replacement's row, socket and tasks are never removed.
//
// Without `ifRevision` the SDK closes at once (internal callers, tests);
// guards 2 and 3 still apply. The CLI previews unless `--if` is given.

import { type AgentRow, deleteAgent, getAgentForCleanup } from "../agents.js";
import { type Db, tornDownAtOf } from "../db.js";
import { emitEvent } from "../logs.js";
import { activeMux } from "../mux.js";
import { agentRevision, assertRevision } from "../revision.js";
import {
  assertReleasable,
  getWorktreeAt,
  getWorktreeFor,
  type ReleasedWorktree,
  releaseWorktree,
  type WorktreeState,
  worktreeState,
} from "../worktree.js";
import { AgentPaneStillAliveError, AgentReplacedError } from "./errors.js";
import { withAgentLock } from "./lock.js";

export interface CloseAgentOptions {
  /**
   * Throw the agent's worktree away even when it has uncommitted work.
   * Lossy; never makes a branch. Without it a dirty worktree refuses
   * (WorktreeDirtyError) before anything is killed.
   */
  discard?: boolean;
  /**
   * The `revision` of `previewClose`. Checked under the agent lock before
   * anything is killed (`RevisionMismatchError`, exit 4, nothing done). An
   * agent that no longer exists is a no-op whatever the value: nothing is
   * left to destroy. Absent: close without a preview.
   */
  ifRevision?: number;
}

export interface CloseAgentResult {
  killedPane: boolean;
  deletedRow: boolean;
  /** What the close rule did to the agent's worktree; null when it had none. */
  worktree: ReleasedWorktree | null;
}

/** What `agent close` would do, read only. */
export interface ClosePreview {
  agentName: string;
  workstream: string;
  /** `agent`: a registry row; `orphan-worktree`: only a registered worktree
   *  is left (a failed spawn or an earlier close); `none`: nothing. */
  kind: "agent" | "orphan-worktree" | "none";
  /** `agentRevision`: the value for `--if`. 0 when `kind` is `none`. */
  revision: number;
  /** The registry incarnation (`AgentRow.incarnation`); null without a row. */
  incarnation: number | null;
  paneId: string | null;
  /** Tasks the row owns, any workstream. IN_PROGRESS ones go back to OPEN. */
  ownedTasks: { ref: string; status: string; reverts: boolean }[];
  /** The worktree the close rule would handle; null when none is registered. */
  worktree: { path: string; state: WorktreeState } | null;
  /** True when the close would refuse for uncommitted work (no `discard`). */
  refusesDirty: boolean;
  discard: boolean;
}

function ownedTasksOf(db: Db, agent: AgentRow): ClosePreview["ownedTasks"] {
  const rows = db
    .prepare(
      `SELECT w.name || '/' || t.local_id AS ref, t.status AS status
         FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE t.owner_id = ? ORDER BY w.name, t.local_id`,
    )
    .all(agent.incarnation) as { ref: string; status: string }[];
  return rows.map((r) => ({ ...r, reverts: r.status === "IN_PROGRESS" }));
}

/** The worktree row the close would handle: the one the agent's `cwd` names,
 *  else (an orphan) the newest registered for the name. */
function worktreeOf(db: Db, workstream: string, name: string, agent?: AgentRow) {
  if (agent === undefined) return getWorktreeFor(db, workstream, name);
  return agent.cwd === null ? undefined : getWorktreeAt(db, agent.cwd);
}

/** Preview a close: nothing is written, nothing is killed. The one read an
 *  apply is derived from, for orphans and torn-down workstreams too.
 *
 *  Identity and revision come from ONE read transaction, taken after the
 *  slow worktree check: the agent row, its worktree row, the owned tasks
 *  and the revision are all of the same snapshot, also against another
 *  process's writes. The check awaits git, so
 *  the name may be replaced meanwhile; the snapshot taken before it is then
 *  stale and the read is retried, and a name that will not hold still is
 *  refused (`AgentReplacedError`) rather than described half and half. */
export async function previewClose(
  db: Db,
  name: string,
  opts: { workstream: string; discard?: boolean },
): Promise<ClosePreview> {
  const discard = opts.discard === true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const agent = getAgentForCleanup(db, name, opts.workstream);
    const row = worktreeOf(db, opts.workstream, name, agent);
    const state = row === undefined ? undefined : await worktreeState(row.path, row.base, row.root);
    // No await from here to the return, and ONE read transaction: under WAL
    // its first read pins a snapshot, so another mu process committing a
    // replacement cannot land between the identity and the revision.
    const preview = db.transaction((): ClosePreview | undefined => {
      const now = getAgentForCleanup(db, name, opts.workstream);
      const nowRow = worktreeOf(db, opts.workstream, name, now);
      // The git check above is of the pre-await row: stale when it moved.
      if (
        now?.incarnation !== agent?.incarnation ||
        now?.paneId !== agent?.paneId ||
        nowRow?.path !== row?.path
      ) {
        return undefined;
      }
      return {
        agentName: name,
        workstream: opts.workstream,
        kind: now ? "agent" : nowRow ? "orphan-worktree" : "none",
        revision: agentRevision(db, opts.workstream, name),
        incarnation: now?.incarnation ?? null,
        paneId: now?.paneId ?? null,
        ownedTasks: now ? ownedTasksOf(db, now) : [],
        worktree: nowRow && state ? { path: nowRow.path, state } : null,
        refusesDirty: state === "dirty" && !discard,
        discard,
      };
    })();
    if (preview !== undefined) return preview;
  }
  throw new AgentReplacedError(name, opts.workstream);
}

/**
 * Close an agent: kill its pane, apply the worktree close rule, remove its
 * DB row. Idempotent: an unknown agent is a no-op, a gone pane is fine.
 *
 * The worktree rule (src/worktree.ts `releaseWorktree`): dirty refuses
 * unless `discard`; clean and merged is removed; clean with unmerged
 * commits keeps a branch `mu/<ws>/<agent>-<sha12>` and is removed. The
 * refusal happens BEFORE the pane is killed. With no agent row but a
 * registered worktree (an earlier close or rollback left it) the same rule
 * runs on the leftover, so `agent close <name>` is the one way out.
 *
 * Fenced: see the header. Throws `AgentLockBusyError` (nothing done),
 * `RevisionMismatchError` (nothing done), `AgentReplacedError` (the
 * replacement is untouched).
 */
export async function closeAgent(
  db: Db,
  name: string,
  opts: CloseAgentOptions & { workstream: string },
): Promise<CloseAgentResult> {
  return withAgentLock(db, opts.workstream, name, () => closeLocked(db, name, opts));
}

async function closeLocked(
  db: Db,
  name: string,
  opts: CloseAgentOptions & { workstream: string },
): Promise<CloseAgentResult> {
  const discard = opts.discard === true;
  const previewCommand = `mu agent close ${name} -w ${opts.workstream}`;
  const fence = (): void => {
    assertRevision(opts.ifRevision, agentRevision(db, opts.workstream, name), {
      subject: `agent ${name}`,
      previewCommand,
    });
  };
  const agent = getAgentForCleanup(db, name, opts.workstream);
  if (!agent) {
    const orphan = getWorktreeFor(db, opts.workstream, name);
    if (orphan === undefined) return { killedPane: false, deletedRow: false, worktree: null };
    fence();
    const worktree = await releaseWorktree(db, orphan, { discard });
    emitEvent(db, opts.workstream, "agent.close", closeLine(name, undefined, worktree));
    return { killedPane: false, deletedRow: false, worktree };
  }
  const row = worktreeOf(db, opts.workstream, name, agent);
  if (row !== undefined) await assertReleasable(row, { discard });
  const mux = await activeMux().catch(() => undefined);
  // The awaits above are where a replacement lands. Nothing below may act
  // on a name that is not the incarnation this close captured.
  const replaced = (): boolean => {
    const now = getAgentForCleanup(db, name, opts.workstream);
    return now !== undefined && !sameIncarnation(now, agent);
  };
  // Right before the kill, with nothing awaited in between: the git check
  // above is slow, and the identity (and the preview) must still hold when
  // the pane dies. The kill names the pane of the incarnation checked here.
  if (replaced()) throw new AgentReplacedError(name, opts.workstream);
  fence();
  // (The mux is resolved first, so nothing is awaited between the checks
  // and the kill.) A row that vanished (pruned as a ghost) has no pane left
  // to name: nothing to kill.
  if (getAgentForCleanup(db, name, opts.workstream) !== undefined) {
    await mux?.killPane(agent.paneId).catch(() => {
      /* idempotent — pane may already be gone, or the mux with it */
    });
  }
  // The row rule: never delete (nor release a worktree for) a row whose
  // recorded pane is alive. A pane that survives the kill (moved, or the
  // kill failed) keeps its row. In a torn-down workstream, where teardown
  // already deferred to this verb, a probe that cannot answer keeps it too.
  if (mux !== undefined) {
    let alive: boolean | "unknown" = false;
    try {
      alive = await mux.paneAlive(agent.paneId);
    } catch {
      alive = "unknown";
    }
    if (
      alive === true ||
      (alive === "unknown" && tornDownAtOf(db, agent.workstreamName) !== null)
    ) {
      throw new AgentPaneStillAliveError(name, agent.workstreamName, agent.paneId, alive);
    }
  }
  if (replaced()) throw new AgentReplacedError(name, opts.workstream);
  // Re-checks the state: a write after the pre-check still refuses, with
  // the agent row kept so the close can be retried.
  const worktree = row === undefined ? null : await releaseWorktree(db, row, { discard });
  const deletedRow = deleteAgent(db, name, agent.workstreamName, {
    incarnation: agent.incarnation,
    paneId: agent.paneId,
  });
  if (!deletedRow && replaced()) throw new AgentReplacedError(name, opts.workstream);
  // Machine-local table (`agents`): no trigger, so this emit is the
  // only record.
  emitEvent(db, agent.workstreamName, "agent.close", closeLine(name, agent.paneId, worktree));
  return { killedPane: true, deletedRow, worktree };
}

function sameIncarnation(a: AgentRow, b: AgentRow): boolean {
  return a.incarnation === b.incarnation && a.paneId === b.paneId;
}

function closeLine(name: string, paneId: string | undefined, wt: ReleasedWorktree | null): string {
  const bits = [paneId === undefined ? undefined : `pane=${paneId}`];
  if (wt !== null) {
    bits.push(`worktree ${wt.action}${wt.branch === undefined ? "" : ` as ${wt.branch}`}`);
  }
  const detail = bits.filter((b) => b !== undefined).join(", ");
  return `agent close ${name}${detail === "" ? "" : ` (${detail})`}`;
}
