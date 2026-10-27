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

import { type AgentRow, deleteAgent, getAgentForCleanup, isPendingPaneId } from "../agents.js";
import type { Db } from "../db.js";
import { releaseHostChannelsForAgent } from "../hosts.js";
import { emitEvent } from "../logs.js";
import { activeMux } from "../mux.js";
import { closeRemoteWorktree, localPaneAlive } from "../remote-agent.js";
import { selectRemoteRecovery } from "../remote-recovery.js";
import { agentRevision, assertRevision } from "../revision.js";
import { runInFlight, setAgentDone, workOf } from "../wait-owed.js";
import {
  assertReleasable,
  getWorktreeAt,
  getWorktreeFor,
  type ReleasedWorktree,
  releaseWorktree,
  type WorktreeState,
  worktreeState,
} from "../worktree.js";
import { closeRecovery, recoveryPreview } from "./close-recovery.js";
import { AgentPaneStillAliveError, AgentReplacedError } from "./errors.js";
import { cleanGateResult } from "./gate.js";
import { withAgentLock } from "./lock.js";

export interface CloseAgentOptions {
  /**
   * Throw the agent's worktree away even when it has uncommitted work.
   * Lossy; never makes a branch. Without it a dirty worktree refuses
   * (WorktreeDirtyError) before anything is killed.
   */
  discard?: boolean;
  /**
   * A remote worktree whose HEAD was never collected: keep it as the remote
   * branch `mu/<ws>/<agent>-<sha12>` and remove the worktree. Never overrides
   * uncommitted work, and `discard` does not stand in for it. A local
   * worktree always keeps its branch; the flag is ignored there.
   */
  keepBranch?: boolean;
  /**
   * The `revision` of `previewClose`. Checked under the agent lock before
   * anything is killed (`RevisionMismatchError`, exit 4, nothing done). An
   * agent that no longer exists is a no-op whatever the value: nothing is
   * left to destroy. Absent: close without a preview.
   */
  ifRevision?: number;
  /**
   * Close the remote worktree a REMOVED agent left (`remote_recovery`, the
   * original registry incarnation it names), not a live agent. Required when
   * several records share the name; without it exactly one selects itself.
   * Refuses while an agent holds the name or the path.
   */
  recoveryId?: number;
  /**
   * Close past a refusal the caller owns: the pane's liveness could not be
   * checked (the probe failed, or no multiplexer answers), a process has a
   * file in the worktree open for writing, or no scan could prove none has
   * (no /proc, no lsof). Never overrides a pane that answers alive, nor
   * uncommitted work. Without it these refuse (`AgentPaneStillAliveError`
   * state `unknown`, `WorktreeHeldError`) with everything kept.
   */
  force?: boolean;
}

export interface CloseAgentResult {
  killedPane: boolean;
  deletedRow: boolean;
  /** What the close rule did to the agent's worktree (a remote one included); null when it had none. */
  worktree: ReleasedWorktree | null;
  /** Set when a remote recovery record was closed: its id and whether the record was removed. */
  recovery?: { id: number; deleted: boolean };
}

/** What `agent close` would do, read only. */
export interface ClosePreview {
  agentName: string;
  workstream: string;
  /** `agent`: a registry row; `orphan-worktree`: only a registered worktree
   *  is left (a failed spawn or an earlier close); `recovery`: the agent row
   *  is gone but `remote_recovery` kept its remote worktree; `none`: nothing. */
  kind: "agent" | "orphan-worktree" | "recovery" | "none";
  /** `agentRevision`: the value for `--if`. 0 when `kind` is `none`. */
  revision: number;
  /** The registry incarnation (`AgentRow.incarnation`); null without a row. */
  incarnation: number | null;
  paneId: string | null;
  /** Tasks the row owns, any workstream. IN_PROGRESS ones go back to OPEN. */
  ownedTasks: { ref: string; status: string; reverts: boolean }[];
  /** The worktree the close rule would handle; null when none is registered. */
  worktree: { path: string; state: WorktreeState } | null;
  /**
   * The remote worktree of a `--host --worktree` agent that the close removes
   * under the remote rule (`closeRemoteWorktree`), read from the row alone:
   * a preview runs no remote command (at `--max-sessions 1` the live pane
   * holds the only channel). Null for a local or `--cwd`-only agent.
   */
  remote: { host: string; path: string; base: string; collectedHead: string | null } | null;
  /**
   * The selected recovery record (`kind` `recovery`), under its own id: the
   * ORIGINAL registry incarnation, never `incarnation`. `refusal` is why an
   * apply would refuse right now (a current agent, a changed profile), null
   * when it would go on. Null otherwise.
   */
  recovery: {
    id: number;
    aside: string;
    reason: string;
    preservedAt: string;
    refusal: string | null;
  } | null;
  /** True when the close would refuse for uncommitted work (no `discard`). */
  refusesDirty: boolean;
  discard: boolean;
  keepBranch: boolean;
}

function remoteOf(agent: AgentRow | undefined): ClosePreview["remote"] {
  if (agent?.host == null || agent.cwd === null || agent.base === null) return null;
  return {
    host: agent.host,
    path: agent.cwd,
    base: agent.base,
    collectedHead: agent.collectedHead,
  };
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
  // A remote agent's cwd is a path on its host: the local registry knows nothing
  // of it (its remote worktree is closed by `closeRemoteWorktree`).
  if (agent.host !== null) return undefined;
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
  opts: { workstream: string; discard?: boolean; keepBranch?: boolean; recoveryId?: number },
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
      // A removed agent's remote worktree: asked for by id, or the one left
      // when nothing else is. Several records refuse (ambiguous) here.
      const rec =
        opts.recoveryId !== undefined || (now === undefined && nowRow === undefined)
          ? selectRemoteRecovery(db, opts.workstream, name, opts.recoveryId)
          : undefined;
      // A named record that is gone is "nothing", never the live agent.
      if (rec === undefined && opts.recoveryId !== undefined) {
        return {
          agentName: name,
          workstream: opts.workstream,
          kind: "none",
          revision: 0,
          incarnation: null,
          paneId: null,
          ownedTasks: [],
          worktree: null,
          remote: null,
          recovery: null,
          refusesDirty: false,
          discard,
          keepBranch: opts.keepBranch === true,
        };
      }
      if (rec !== undefined) {
        return {
          agentName: name,
          workstream: opts.workstream,
          kind: "recovery",
          revision: agentRevision(db, opts.workstream, name, opts.recoveryId),
          incarnation: null,
          paneId: null,
          ownedTasks: [],
          worktree: null,
          ...recoveryPreview(db, rec),
          refusesDirty: false,
          discard,
          keepBranch: opts.keepBranch === true,
        };
      }
      return {
        agentName: name,
        workstream: opts.workstream,
        kind: now ? "agent" : nowRow ? "orphan-worktree" : "none",
        revision: opts.recoveryId === undefined ? agentRevision(db, opts.workstream, name) : 0,
        incarnation: now?.incarnation ?? null,
        paneId: now?.paneId ?? null,
        ownedTasks: now ? ownedTasksOf(db, now) : [],
        worktree: nowRow && state ? { path: nowRow.path, state } : null,
        remote: remoteOf(now),
        recovery: null,
        refusesDirty: state === "dirty" && !discard,
        discard,
        keepBranch: opts.keepBranch === true,
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
    assertRevision(opts.ifRevision, agentRevision(db, opts.workstream, name, opts.recoveryId), {
      subject: `agent ${name}`,
      previewCommand,
    });
  };
  const agent = getAgentForCleanup(db, name, opts.workstream);
  const orphan = agent ? undefined : getWorktreeFor(db, opts.workstream, name);
  // A removed agent's remote worktree (`remote_recovery`): by id, or the one
  // left when there is no row and no local orphan. A gone record is a no-op.
  if (opts.recoveryId !== undefined || (agent === undefined && orphan === undefined)) {
    const rec = selectRemoteRecovery(db, opts.workstream, name, opts.recoveryId);
    if (rec === undefined) return { killedPane: false, deletedRow: false, worktree: null };
    fence();
    return closeRecovery(db, rec, {
      keepBranch: opts.keepBranch === true,
      force: opts.force === true,
    });
  }
  if (!agent) {
    if (orphan === undefined) return { killedPane: false, deletedRow: false, worktree: null };
    fence();
    const worktree = await releaseWorktree(db, orphan, { discard, force: opts.force === true });
    emitEvent(db, opts.workstream, "agent.close", closeLine(name, undefined, worktree));
    return { killedPane: false, deletedRow: false, worktree };
  }
  const row = worktreeOf(db, opts.workstream, name, agent);
  if (row !== undefined) await assertReleasable(row, { discard });
  const mux = await activeMux().catch(() => undefined);
  // Before the kill (the pane then answers nothing): is its run still going?
  const running = await runInFlight(agent);
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
  // The row rule: never delete (nor release a claim, a worktree or a host
  // channel for) a row whose recorded pane may be alive. A pane that survives
  // the kill (moved, or the kill failed) keeps its row; so does one nobody
  // could ask (the probe failed, or no multiplexer answers), in every
  // workstream, unless `force` says it is gone. A pending placeholder never
  // had a pane. Past this check the pane is gone (proven, or forced).
  let alive: boolean | "unknown" = false;
  let why: string | undefined;
  if (!isPendingPaneId(agent.paneId)) {
    if (mux === undefined) {
      alive = "unknown";
      why = "no multiplexer answers";
    } else {
      try {
        alive = await mux.paneAlive(agent.paneId);
      } catch (err) {
        alive = "unknown";
        why = err instanceof Error ? err.message.split("\n")[0] : String(err);
      }
    }
  }
  if (alive === true || (alive === "unknown" && opts.force !== true)) {
    throw new AgentPaneStillAliveError(name, agent.workstreamName, agent.paneId, alive, why);
  }
  if (replaced()) throw new AgentReplacedError(name, opts.workstream);
  // Re-checks the state: a write after the pre-check still refuses, with
  // the agent row kept so the close can be retried. A remote worktree is
  // judged only now, after the kill: the pane held the host's channel (at cap
  // 1 the only one). Its pane is dead, so admission reclaims that channel.
  let worktree: ReleasedWorktree | null = null;
  // Set once closeRemoteWorktree is about to run: it returns only when the tree
  // is removed, kept on a branch or gone (anything else throws, row kept), so
  // the row's deletion needs no recovery record.
  let remoteHandled = false;
  if (row !== undefined)
    worktree = await releaseWorktree(db, row, { discard, force: opts.force === true });
  else if (remoteOf(agent) !== null) {
    remoteHandled = true;
    // The pane is gone (checked above): free its channel by id + pane.
    releaseHostChannelsForAgent(db, agent.incarnation, agent.paneId);
    worktree = await closeRemoteWorktree(db, agent, {
      keepBranch: opts.keepBranch === true,
      force: opts.force === true,
      paneAlive: localPaneAlive,
      beforeRemove: () => {
        if (replaced()) throw new AgentReplacedError(name, opts.workstream);
      },
    });
    if (replaced()) throw new AgentReplacedError(name, opts.workstream);
  }
  // A remote command gate: its pane is dead (probed above), so free its channel by id + pane and
  // remove ITS result record (its own token's files; a replacement has another token). Best effort:
  // a host that cannot answer leaves one stray file, never a blocked close.
  if (agent.gateToken !== null && agent.host !== null) {
    releaseHostChannelsForAgent(db, agent.incarnation, agent.paneId);
    await cleanGateResult(db, agent);
    if (replaced()) throw new AgentReplacedError(name, opts.workstream);
  }
  const openAtClose = workOf(db, agent.incarnation).open;
  const deletedRow = deleteAgent(
    db,
    name,
    agent.workstreamName,
    { incarnation: agent.incarnation, paneId: agent.paneId },
    { preserve: !remoteHandled },
  );
  if (!deletedRow && replaced()) throw new AgentReplacedError(name, opts.workstream);
  // A deliberate close of a worker with no open task and no run in flight is the end of its work,
  // not a death: the wait engine drops its ref (src/wait-owed.ts). A busy one is still news.
  if (deletedRow && !running && openAtClose === 0)
    setAgentDone(db, agent.workstreamName, name, true);
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
