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
//
// A LEASE agent (spec 2026-10-28-lease-transport.md § agent close): its pane's
// death is not its job's death. After the liveness proof and `replaced()`, the
// name's `carrier_jobs` reservation is stopped (src/agents/lease-carrier.ts,
// `stopLeaseReservation`): exit 0 is the proof; a hand-back (exit 3), a failure
// or a refusal throws with the agent row and the reservation kept. Then
// `replaced()` again, the job file, the channels and the remote worktree rule,
// unchanged; the reservation is released last. `--force` never skips the stop;
// `--abandon-job` drops the handle without one. With no agent row left, close
// stops the name's reservation the same way before the recovery close.

import { type AgentRow, deleteAgent, getAgentForCleanup, isPendingPaneId } from "../agents.js";
import { type CarrierJob, getCarrierJobByName, listCarrierJobsByName } from "../carrier-jobs.js";
import { unlinkCtlSocket } from "../ctl/path.js";
import type { Db } from "../db.js";
import { resolveHost } from "../host-provider.js";
import { releaseHostChannelsForAgent } from "../hosts.js";
import { readJobFile } from "../jobs/lease.js";
import { viewPid, viewPresent, viewRunning } from "../jobs/view.js";
import { emitEvent } from "../logs.js";
import type { MuxBackend } from "../mux/types.js";
import { activeMux } from "../mux.js";
import { selectRemoteRecovery } from "../remote-recovery.js";
import { closeRemoteWorktree } from "../remote-worktree.js";
import { agentRevision, assertRevision } from "../revision.js";
import { callersOwing, dropOwnedRefs } from "../wait-registration.js";
import {
  assertReleasable,
  awaitExit,
  awaitHelpers,
  getWorktreeAt,
  getWorktreeFor,
  type PaneProcesses,
  paneProcesses,
  type ReleasedWorktree,
  releaseWorktree,
  type WorktreeHolder,
  type WorktreeState,
  worktreeHolders,
  worktreeState,
} from "../worktree.js";
import { closeRecovery, recoveryPreview } from "./close-recovery.js";
import {
  AgentPaneStillAliveError,
  AgentReplacedError,
  CarrierJobKeptError,
  CarrierJobUnresolvedError,
} from "./errors.js";
import { cleanGateResult } from "./gate.js";
import {
  cleanLeaseJobFile,
  type LeaseClose,
  leaseJobFile,
  releaseLeaseClose,
  stopLeaseReservation,
} from "./lease-carrier.js";
import { withAgentLock } from "./lock.js";
import { detachedJob } from "./reattach-view.js";

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
  /**
   * Drop the name's lease job handle (`carrier_jobs` reservation) WITHOUT stopping
   * the job: for a host that is gone for good. Emits an event naming the host and
   * the handle; the job file is left in place. The only way past a stop that cannot
   * run. `force` never stands in for it.
   */
  abandonJob?: boolean;
}

/** What a close did to a lease job: stopped, abandoned, or (never launched) released. */
export interface ClosedCarrierJob {
  host: string;
  job: string | null;
  action: LeaseClose["action"];
}

export interface CloseAgentResult {
  killedPane: boolean;
  deletedRow: boolean;
  /** What the close rule did to the agent's worktree (a remote one included); null when it had none. */
  worktree: ReleasedWorktree | null;
  /** Set when a remote recovery record was closed: its id and whether the record was removed. */
  recovery?: { id: number; deleted: boolean };
  /** Set when a lease job's reservation was closed. */
  carrierJobs?: ClosedCarrierJob[];
}

/** What `agent close` would do, read only. */
export interface ClosePreview {
  agentName: string;
  workstream: string;
  /** `agent`: a registry row; `orphan-worktree`: only a registered worktree
   *  is left (a failed spawn or an earlier close); `recovery`: the agent row
   *  is gone but `remote_recovery` kept its remote worktree; `lease-job`: only
   *  a lease job's `carrier_jobs` reservation is left; `none`: nothing. */
  kind: "agent" | "orphan-worktree" | "recovery" | "lease-job" | "none";
  /** `agentRevision`: the value for `--if`. 0 when `kind` is `none`. */
  revision: number;
  /** The registry incarnation (`AgentRow.incarnation`); null without a row. */
  incarnation: number | null;
  paneId: string | null;
  /** Tasks the row owns, any workstream. IN_PROGRESS ones go back to OPEN. */
  ownedTasks: { ref: string; status: string; reverts: boolean }[];
  /** The worktree the close rule would handle; null when none is registered. */
  worktree: {
    path: string;
    state: WorktreeState;
    /**
     * Other processes inside it now (cwd or an open file), the agent's own
     * pane processes left out: the apply removes the tree under a reader and
     * refuses a writer. Undefined when no scan could prove the answer.
     */
    holders?: WorktreeHolder[];
    /** This user's processes the scan could not inspect: unknown, never taken as absent. */
    hidden?: number[];
  } | null;
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
  /**
   * The name's lease job reservation (`carrier_jobs`), stopped (or with
   * `abandonJob` dropped) before the tree is touched. Null when there is none.
   */
  carrierJob: Pick<CarrierJob, "host" | "job" | "launch" | "paneId" | "reason"> | null;
  /** True when the close would refuse for uncommitted work (no `discard`). */
  refusesDirty: boolean;
  discard: boolean;
  keepBranch: boolean;
  abandonJob: boolean;
}

function carrierJobOf(db: Db, workstream: string, name: string): ClosePreview["carrierJob"] {
  const r = getCarrierJobByName(db, workstream, name);
  return r === undefined
    ? null
    : { host: r.host, job: r.job, launch: r.launch, paneId: r.paneId, reason: r.reason };
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
  opts: {
    workstream: string;
    discard?: boolean;
    keepBranch?: boolean;
    recoveryId?: number;
    abandonJob?: boolean;
    /** Test seam: the holder scan's /proc and lsof. */
    probe?: { proc: string; lsof: string };
  },
): Promise<ClosePreview> {
  const discard = opts.discard === true;
  const abandonJob = opts.abandonJob === true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const agent = getAgentForCleanup(db, name, opts.workstream);
    const row = worktreeOf(db, opts.workstream, name, agent);
    const state = row === undefined ? undefined : await worktreeState(row.path, row.base, row.root);
    const scan =
      row === undefined || state === undefined || state === "missing"
        ? undefined
        : await previewHolders(row.path, agent, opts.probe);
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
          carrierJob: null,
          refusesDirty: false,
          discard,
          keepBranch: opts.keepBranch === true,
          abandonJob,
        };
      }
      const carrierJob = carrierJobOf(db, opts.workstream, name);
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
          carrierJob,
          refusesDirty: false,
          discard,
          keepBranch: opts.keepBranch === true,
          abandonJob,
        };
      }
      return {
        agentName: name,
        workstream: opts.workstream,
        kind: now
          ? "agent"
          : nowRow
            ? "orphan-worktree"
            : carrierJob !== null
              ? "lease-job"
              : "none",
        revision: opts.recoveryId === undefined ? agentRevision(db, opts.workstream, name) : 0,
        incarnation: now?.incarnation ?? null,
        paneId: now?.paneId ?? null,
        ownedTasks: now ? ownedTasksOf(db, now) : [],
        worktree:
          nowRow && state
            ? {
                path: nowRow.path,
                state,
                ...(scan?.holders !== undefined ? { holders: scan.holders } : {}),
                ...(scan !== undefined && scan.hidden.length > 0 ? { hidden: scan.hidden } : {}),
              }
            : null,
        remote: remoteOf(now),
        recovery: null,
        carrierJob,
        refusesDirty: state === "dirty" && !discard,
        discard,
        keepBranch: opts.keepBranch === true,
        abandonJob,
      };
    })();
    if (preview !== undefined) return preview;
  }
  throw new AgentReplacedError(name, opts.workstream);
}

/**
 * Who is inside `path` now, for the preview: the holder scan the apply runs,
 * minus the agent's own pane processes that the kill ends first (its pi, its
 * tools; not one that left the pane's session: processTree). `holders` is
 * undefined when the scan proves nothing; `hidden` names this user's
 * processes /proc would not show (unknown, said as the apply says it).
 */
async function previewHolders(
  path: string,
  agent: AgentRow | undefined,
  probe?: { proc: string; lsof: string },
): Promise<{ holders: WorktreeHolder[] | undefined; hidden: number[] }> {
  const hidden: number[] = [];
  const holders = await worktreeHolders(path, probe, hidden);
  if (holders === undefined || holders.length === 0 || agent === undefined) {
    return { holders, hidden };
  }
  // No pane pid: every holder is shown.
  const own = await activeMux().then(
    async (mux) => (await paneTree(mux, agent)).tree,
    () => new Set<number>(),
  );
  return { holders: holders.filter((h) => !own.has(h.pid)), hidden };
}

/** `agent`'s pane processes (paneProcesses); none when its pid is unknown. */
async function paneTree(mux: MuxBackend, agent: AgentRow): Promise<PaneProcesses> {
  const none: PaneProcesses = { tree: new Set(), groups: new Set() };
  try {
    const pid = await viewPid(agent.paneId, mux);
    return pid === undefined ? none : await paneProcesses(pid);
  } catch {
    return none;
  }
}

/** How long a close waits for the killed pane's processes and helpers to exit before removing its tree. */
const PANE_EXIT_MS = 5000;

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
  const nothing: CloseAgentResult = { killedPane: false, deletedRow: false, worktree: null };
  if (agent === undefined || opts.recoveryId !== undefined) {
    // A named recovery record that is gone is "nothing": no job is stopped for it.
    if (
      opts.recoveryId !== undefined &&
      selectRemoteRecovery(db, opts.workstream, name, opts.recoveryId) === undefined
    ) {
      return nothing;
    }
    // No agent row left: the name's lease job is stopped first (same rule as below). A
    // stopped reservation is released before the tree's close, so a tree that refuses
    // (dirty, uncollected) never fences the name; one kept as a tree's pointer (its
    // reason) only after that very tree's close. (A live agent's is its close's.)
    const jobs = agent === undefined ? listCarrierJobsByName(db, opts.workstream, name) : [];
    if (jobs.length > 0) {
      fence();
      // Several recovery records refuse (ambiguous) before any job is stopped.
      if (orphan === undefined) selectRemoteRecovery(db, opts.workstream, name, opts.recoveryId);
    }
    const closes: LeaseClose[] = [];
    for (const j of jobs) {
      const c = await stopLeaseReservation(db, j, { abandon: opts.abandonJob === true });
      if (c === undefined) continue;
      cleanLeaseJobFile(db, c);
      closes.push(c);
    }
    // Every reservation of the name is decided by now: a stop that failed, or one with no
    // handle it could stop, threw above with all of them kept. Those that point at no tree
    // go first: the stop proved their job gone (or never launched) and the job file is clean.
    const early = closes.filter((c) => c.action !== "abandon" && c.reservation.reason === null);
    const late = closes.filter((c) => !early.includes(c));
    // No agent row holds the name: a raw delete skipped deleteAgent's socket unlink, so the
    // local ctl socket (the carrier's forward) goes here, before the first release. Every
    // job of the name is stopped by now, so the forward is no one's.
    const unlinkEarly = early.length > 0;
    if (unlinkEarly) unlinkCtlSocket(db, name, opts.workstream);
    for (const c of early) releaseLeaseClose(db, c);
    if (early.length > 0) {
      emitEvent(db, opts.workstream, "agent.close", closeLine(name, undefined, null, early));
    }
    const { result, tree } = await closeTreeWithoutRow(
      db,
      name,
      opts,
      orphan,
      fence,
      jobs.length > 0,
    );
    for (const c of late) {
      // A reservation its rollback kept for a remote tree it could not remove (the reason) is
      // THAT tree's pointer: released only once a close handled that very tree (its host, path
      // and incarnation), never because another tree of the name was closed.
      const r = c.reservation;
      if (c.action === "stopped" && r.reason !== null && !closedKeptTree(r, tree)) {
        throw new CarrierJobKeptError(
          name,
          opts.workstream,
          r.host,
          `job ${r.job} is stopped, but ${r.reason}${tree === undefined ? "" : ` (the close handled ${tree.path} on ${tree.host}, another tree)`}`,
        );
      }
    }
    // (An abandon, or a reservation kept for this tree: the socket goes before its release.)
    if (closes.length > 0 && !unlinkEarly) unlinkCtlSocket(db, name, opts.workstream);
    for (const c of late) releaseLeaseClose(db, c);
    if (closes.length === 0) return result;
    // The early releases were reported before the tree's close.
    if (late.length > 0) {
      emitEvent(db, opts.workstream, "agent.close", closeLine(name, undefined, null, late));
    }
    return { ...result, carrierJobs: closes.map(closedJob) };
  }
  const row = worktreeOf(db, opts.workstream, name, agent);
  if (row !== undefined) await assertReleasable(row, { discard });
  const mux = await activeMux().catch(() => undefined);
  // The pane's processes, read before the kill ends them: the tree is removed
  // only once they are gone (below), or they are named as left in it.
  const pane = row === undefined || mux === undefined ? undefined : await paneTree(mux, agent);
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
  // A detached plugin job outlives its view (plugins spec D3): stopped first, the view after.
  const detached = detachedJob(db, opts.workstream, name) !== undefined;
  const early = detached ? await stopAgentLease(db, agent, opts.abandonJob === true) : undefined;
  if (detached && replaced()) throw new AgentReplacedError(name, opts.workstream);
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
        alive = await viewPresent(agent.paneId, mux);
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
  // A lease job: its pane is proven gone, but not its job. Stop it now, before the
  // tree is touched; any refusal or failure keeps the row and the reservation.
  const lease = detached ? early : await stopAgentLease(db, agent, opts.abandonJob === true);
  if (replaced()) throw new AgentReplacedError(name, opts.workstream);
  if (lease !== undefined) cleanLeaseJobFile(db, lease);
  // Re-checks the state: a write after the pre-check still refuses, with
  // the agent row kept so the close can be retried. A remote worktree is
  // judged only now, after the kill: the pane held the host's channel (at cap
  // 1 the only one). Its pane is dead, so admission reclaims that channel.
  let worktree: ReleasedWorktree | null = null;
  // Set once closeRemoteWorktree is about to run: it returns only when the tree
  // is removed, kept on a branch or gone (anything else throws, row kept), so
  // the row's deletion needs no recovery record.
  let remoteHandled = false;
  if (row !== undefined) {
    // The hangup reached them, but pi saves its session and runs its exit hooks
    // first; its helpers (no hangup reaches them) finish their flush. One bound for both.
    if (pane !== undefined) {
      const until = Date.now() + PANE_EXIT_MS;
      await awaitExit(pane.tree, PANE_EXIT_MS);
      await awaitHelpers(row.path, pane, until - Date.now());
    }
    if (replaced()) throw new AgentReplacedError(name, opts.workstream);
    worktree = await releaseWorktree(db, row, { discard, force: opts.force === true });
  } else if (remoteOf(agent) !== null) {
    remoteHandled = true;
    // The pane is gone (checked above): free its channel by id + pane.
    releaseHostChannelsForAgent(db, agent.incarnation, agent.paneId);
    // Re-read: a plugin job's final collect (its stop, above) recorded the collected head.
    const now =
      lease?.reservation.plugin != null ? getAgentForCleanup(db, name, opts.workstream) : undefined;
    worktree = await closeRemoteWorktree(db, now ?? agent, {
      keepBranch: opts.keepBranch === true,
      force: opts.force === true,
      paneAlive: viewRunning,
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
  const deletedRow = deleteAgent(
    db,
    name,
    agent.workstreamName,
    { incarnation: agent.incarnation, paneId: agent.paneId },
    // Its lease job is stopped (or abandoned on purpose): the tasks reopen as todo.
    { preserve: !remoteHandled, leaseSettled: true },
  );
  if (!deletedRow && replaced()) throw new AgentReplacedError(name, opts.workstream);
  // Last: the reservation, once its job is stopped and its job file and tree are dealt with.
  if (lease !== undefined) releaseLeaseClose(db, lease);
  // A deliberate close ends the agent's ref in every caller's registration: closing on purpose is
  // never a death. Work it left unfinished is still owed through the task refs (the reaper reopens
  // those tasks, and a wait reports them), so nothing owed is lost; the registration shrinks.
  if (deletedRow) dropClosedAgentRefs(db, agent.workstreamName, name);
  // Machine-local table (`agents`): no trigger, so this emit is the
  // only record.
  const closes = lease === undefined ? [] : [lease];
  emitEvent(
    db,
    agent.workstreamName,
    "agent.close",
    closeLine(name, agent.paneId, worktree, closes),
  );
  return {
    killedPane: true,
    deletedRow,
    worktree,
    ...(lease === undefined ? {} : { carrierJobs: [closedJob(lease)] }),
  };
}

/** The remote tree a close with no agent row handled: the recovery record it closed. */
interface ClosedTree {
  host: string;
  path: string;
  agentId: number;
}

/** Did the close handle the tree reservation `r` was kept for (same host, path, incarnation)? */
function closedKeptTree(r: CarrierJob, tree: ClosedTree | undefined): boolean {
  return (
    tree !== undefined &&
    r.treePath !== null &&
    tree.host === r.host &&
    tree.path === r.treePath &&
    tree.agentId === r.treeAgentId
  );
}

/**
 * The tree a close with no agent row handles, after the name's lease jobs are stopped:
 * a removed agent's remote worktree (`remote_recovery`: by id, or the one left when
 * there is no local orphan; a gone record is a no-op), else the local orphan. `fenced`:
 * the revision was checked already. `tree`: the remote tree closed, if any.
 */
async function closeTreeWithoutRow(
  db: Db,
  name: string,
  opts: CloseAgentOptions & { workstream: string },
  orphan: ReturnType<typeof getWorktreeFor>,
  fence: () => void,
  fenced: boolean,
): Promise<{ result: CloseAgentResult; tree?: ClosedTree }> {
  const nothing: CloseAgentResult = { killedPane: false, deletedRow: false, worktree: null };
  if (opts.recoveryId !== undefined || orphan === undefined) {
    const rec = selectRemoteRecovery(db, opts.workstream, name, opts.recoveryId);
    if (rec === undefined) return { result: nothing };
    if (!fenced) fence();
    const result = await closeRecovery(db, rec, {
      keepBranch: opts.keepBranch === true,
      force: opts.force === true,
    });
    return { result, tree: { host: rec.host, path: rec.cwd, agentId: rec.agentId } };
  }
  if (!fenced) fence();
  const worktree = await releaseWorktree(db, orphan, {
    discard: opts.discard === true,
    force: opts.force === true,
  });
  emitEvent(db, opts.workstream, "agent.close", closeLine(name, undefined, worktree));
  return { result: { ...nothing, worktree } };
}

/**
 * Step 4 for a live agent: the name's reservation (bound to this incarnation, or not
 * bound yet: a spawn between its pane and its handshake), stopped or with `abandon`
 * dropped. Undefined for an agent with no reservation (a session agent).
 */
async function stopAgentLease(
  db: Db,
  agent: AgentRow,
  abandon: boolean,
): Promise<LeaseClose | undefined> {
  const jobs = listCarrierJobsByName(db, agent.workstreamName, agent.name);
  const mine =
    jobs.find((j) => j.agentId === agent.incarnation) ?? jobs.find((j) => j.agentId === null);
  if (mine !== undefined) return stopLeaseReservation(db, mine, { abandon });
  // No reservation (a session agent, or a raw delete of a lease one). Lease-ness is the
  // row's recorded transport, never the profile as it is now; a row from before that
  // column falls back to the profile and to a job file at the derived path. A lease agent
  // with no reservation refuses: a job file is then the only pointer to a job, and without
  // one nothing proves that none was dispatched (a spawn in progress, or a carrier that may
  // still publish). `--abandon-job` goes on and leaves any file.
  if (agent.host === null || abandon) return undefined;
  const file = leaseJobFile(db, agent.workstreamName, agent.name);
  const read = readJobFile(file);
  const transport = hostTransportOf(db, agent.incarnation);
  const lease =
    transport === "lease" ||
    (transport === null && (read.kind !== "none" || isLeaseHost(db, agent.host)));
  if (!lease) return undefined;
  throw new CarrierJobUnresolvedError(
    agent.name,
    agent.workstreamName,
    agent.host,
    read.kind === "none"
      ? `no carrier_jobs reservation records its job and no job file is at ${file}`
      : `no carrier_jobs reservation records its job, but its job file ${file} ${read.kind === "handle" ? `names ${read.job}: stop it by hand` : `is ${read.kind}`}`,
  );
}

/** The transport the row recorded at spawn (`agents.host_transport`); null: none recorded. */
function hostTransportOf(db: Db, incarnation: number): string | null {
  const r = db.prepare("SELECT host_transport AS t FROM agents WHERE id = ?").get(incarnation) as
    | { t: string | null }
    | undefined;
  return r?.t ?? null;
}

/** Is `host` a lease profile now (only for a row that recorded no transport)? A gone profile says nothing, so no. */
function isLeaseHost(db: Db, host: string): boolean {
  try {
    return resolveHost(db, host).jobKind?.name === "lease";
  } catch {
    return false;
  }
}

const closedJob = (c: LeaseClose): ClosedCarrierJob => ({
  host: c.reservation.host,
  job: c.reservation.job,
  action: c.action,
});

function sameIncarnation(a: AgentRow, b: AgentRow): boolean {
  return a.incarnation === b.incarnation && a.paneId === b.paneId;
}

function closeLine(
  name: string,
  paneId: string | undefined,
  wt: ReleasedWorktree | null,
  jobs: readonly LeaseClose[] = [],
): string {
  const bits = [paneId === undefined ? undefined : `pane=${paneId}`];
  for (const j of jobs) {
    const what = j.reservation.job === null ? "lease reservation" : `job ${j.reservation.job}`;
    const did =
      j.action === "stopped"
        ? "stopped"
        : j.action === "abandon"
          ? "abandoned"
          : j.action === "kept"
            ? "kept (uncollected work)"
            : "released";
    bits.push(`${what} on ${j.reservation.host} ${did}`);
  }
  if (wt !== null) {
    bits.push(`worktree ${wt.action}${wt.branch === undefined ? "" : ` as ${wt.branch}`}`);
  }
  const detail = bits.filter((b) => b !== undefined).join(", ");
  return `agent close ${name}${detail === "" ? "" : ` (${detail})`}`;
}

/** Drop `<ws>/<name>`'s agent ref (with its fence and DONE mark) from every caller that owes it. */
function dropClosedAgentRefs(db: Db, workstream: string, name: string): void {
  const ref = { kind: "agent" as const, workstream, id: name };
  for (const caller of callersOwing(db, ref)) dropOwnedRefs(db, caller, [ref]);
}
