// mu — agent registry CRUD primitives + the five high-level verbs
// (spawn, send, read, list, close) that the CLI in step 7 will wrap.
//
// Layering inside this file:
//
//   - Types & raw-row mapping (RawAgentRow / rowFromDb)
//   - CRUD primitives        (insertAgent, getAgent, listAgents,
//                              deleteAgent)
//   - Verbs                  (spawnAgent, sendToAgent, readAgent,
//                              closeAgent, listLiveAgents)
//
// The verbs compose the CRUD primitives with the mux and reconciliation
// layers. They are deliberately thin.

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  agentKey,
  type CtlLink,
  type RuntimeState,
  readAgentStates,
  type StateSource,
} from "./agent-state.js";
import { type Db, resolveWorkstreamId, tryResolveWorkstreamId } from "./db.js";
import { GLYPH } from "./glyphs.js";
import { emitEvent } from "./logs.js";
import { withOpContext } from "./op-context.js";
import { type ReconcileMode, type ReconcileReport, reconcile } from "./reconcile.js";
import { addNote, listTasksByOwner } from "./tasks.js";

// Re-export the cluster modules so external callers continue to
// `import { AgentNotFoundError, spawnAgent, ... } from "./agents.js"`.
export {
  type AbortAgentOptions,
  type AbortResult,
  abortAgent,
  DEFAULT_ABORT_TIMEOUT_MS,
} from "./agents/abort.js";
export {
  type AdoptAgentOptions,
  type AdoptAgentResult,
  adoptAgent,
} from "./agents/adopt.js";
export { type DelegateOutcome, delegateOutcome } from "./agents/delegate.js";
export {
  AgentAbortNeedsCtlError,
  AgentAbortTimeoutError,
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  WorkspacePreservedError,
} from "./agents/errors.js";
export {
  foregroundPgid,
  isKickSignal,
  type KickAgentOptions,
  type KickAgentResult,
  type KickProcessExecutor,
  type KickSignal,
  kickAgent,
  NoForegroundProcessError,
  parsePsTtyOutput,
  resetKickProcessExecutor,
  setKickProcessExecutor,
} from "./agents/kick.js";
export {
  type CommandResolutionResult,
  type CommandResolver,
  checkCommandResolvable,
  defaultSpawnCtlMs,
  defaultSpawnLivenessMs,
  defaultSpawnReadinessMs,
  envVarNameForCli,
  resetCommandResolverForTests,
  resolveCliCommand,
  resolveCliCommandWithSource,
  type SpawnAgentOptions,
  type SpawnCtl,
  type SpawnedAgent,
  setCommandResolverForTests,
  spawnAgent,
  speaksMuCtl,
} from "./agents/spawn.js";
export {
  agentCtlSocket,
  chooseTransport,
  expectsCtl,
  type SendResult,
  sendViaTransport,
  type Transport,
  type TransportSendOptions,
} from "./agents/transport.js";
export {
  type AgentStatusSnapshot,
  type AgentWaitAgentState,
  type AgentWaitOptions,
  type AgentWaitRef,
  type AgentWaitResult,
  type AgentWatch,
  setAgentWaitSleepForTests,
  waitForAgents,
} from "./agents/wait.js";

import { AgentNotFoundError, WorkspacePreservedError } from "./agents/errors.js";
import {
  agentCtlSocket,
  type SendResult,
  sendViaTransport,
  type TransportSendOptions,
} from "./agents/transport.js";
import { ctlSocketPath } from "./ctl/path.js";
import { activeMux, type CaptureOptions, type MuxPane } from "./mux.js";
import { freeWorkspace, getWorkspaceForAgent, isWorkspaceClean } from "./workspace.js";
// (freeWorkspace is used by the spawn rollback paths below, not by closeAgent.
// Closing an agent is intentionally a separate concern from freeing its workspace;
// see the closeAgent docstring.)
import { ensureWorkstream, isScratchWorkstream } from "./workstream.js";

export interface AgentRow {
  name: string;
  /** Foreign-name reference to the owning workstream. */
  workstreamName: string;
  cli: string;
  paneId: string;
  role: string;
  /** Window name; null when the agent has its own window named after itself. */
  tab: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

export interface LiveAgent extends AgentRow {
  state: RuntimeState;
  source: StateSource;
  /** Control-socket link: ok / missing / refused for pi agents, n/a otherwise. */
  ctl?: CtlLink;
  /** ISO 8601 time when the source entered this state. */
  since: string | null;
  reason?: string;
  idle?: boolean;
}

/** Default idle threshold. Matches today's `mu task wait --stuck-after`
 *  default so the two paths agree on what counts as 'stalled'. */
const DEFAULT_IDLE_THRESHOLD_MS = 300_000;

/**
 * Read the operator-tunable idle threshold (`MU_IDLE_THRESHOLD_MS`).
 * Returns the default on any unparsable / negative value rather than
 * throwing — env-var typos shouldn't crash `mu state`.
 */
export function idleThresholdMs(): number {
  const env = process.env.MU_IDLE_THRESHOLD_MS;
  if (env === undefined || env === "") return DEFAULT_IDLE_THRESHOLD_MS;
  const n = Number.parseInt(env, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_THRESHOLD_MS;
  return n;
}

/**
 * Decide whether an agent is in the 'idle but assigned' state. Pure
 * read on (agents, tasks); no side effects. Exported so `listLiveAgents`,
 * the renderers, and tests can share one source of truth.
 *
 * Scratch agents own no task, so for them idle past the threshold is
 * enough: a leftover delegate pane is then flagged in `mu state -w
 * scratch` / `mu agent list` instead of piling up unseen.
 */
export function computeAgentIdle(db: Db, agent: LiveAgent, now: number = Date.now()): boolean {
  if (agent.state !== "needs_input" || agent.since === null) return false;
  const threshold = idleThresholdMs();
  if (threshold <= 0) return false;
  const since = Date.parse(agent.since);
  if (!Number.isFinite(since)) return false;
  if (now - since < threshold) return false;
  if (isScratchWorkstream(agent.workstreamName)) return true;
  const wsId = tryResolveWorkstreamId(db, agent.workstreamName);
  if (wsId === null) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM tasks t
         JOIN agents a ON a.id = t.owner_id
        WHERE a.name = ? AND a.workstream_id = ? AND t.status = 'IN_PROGRESS'`,
    )
    .get(agent.name, wsId) as { n: number };
  return row.n > 0;
}

export interface InsertAgentInput {
  name: string;
  workstream: string;
  paneId: string;
  /** Defaults to "pi" via schema DEFAULT. */
  cli?: string;
  /** Defaults to "full-access" via schema DEFAULT. */
  role?: string;
  tab?: string | null;
}

interface RawAgentRow {
  name: string;
  /** Joined from workstreams.name. */
  workstream: string;
  cli: string;
  pane_id: string;
  role: string;
  tab: string | null;
  created_at: string;
  updated_at: string;
}

/** SELECT clause that joins agents to workstreams, exposing the
 *  operator-facing workstream name as `workstream`. Used by every
 *  read path. */
const SELECT_AGENT_COLS = `
  a.name AS name,
  ws.name AS workstream,
  a.cli AS cli,
  a.pane_id AS pane_id,
  a.role AS role,
  a.tab AS tab,
  a.created_at AS created_at,
  a.updated_at AS updated_at
`;

const AGENT_FROM_JOIN = "FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id";

function rowFromDb(row: RawAgentRow): AgentRow {
  return {
    name: row.name,
    workstreamName: row.workstream,
    cli: row.cli,
    paneId: row.pane_id,
    role: row.role,
    tab: row.tab,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resolve an agent's surrogate id by (workstream, name). Returns
 *  null on miss. */
function agentIdByName(db: Db, name: string, workstream: string): number | null {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return null;
  const row = db
    .prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ?")
    .get(name, wsId) as { id: number } | undefined;
  return row ? row.id : null;
}

export function insertAgent(db: Db, input: InsertAgentInput): AgentRow {
  // Auto-create the workstreams row if missing so the FK on
  // agents.workstream_id is always satisfied. Preserves the ergonomics
  // where you could spawn without explicit `mu init`.
  ensureWorkstream(db, input.workstream);
  const workstreamId = resolveWorkstreamId(db, input.workstream);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agents (name, workstream_id, cli, pane_id, status, role, tab, created_at, updated_at)
     VALUES (@name, @workstreamId, COALESCE(@cli, 'pi'), @paneId, 'spawning',
             COALESCE(@role, 'full-access'), @tab, @now, @now)`,
  ).run({
    name: input.name,
    workstreamId,
    cli: input.cli ?? null,
    paneId: input.paneId,
    role: input.role ?? null,
    tab: input.tab ?? null,
    now,
  });
  const row = getAgent(db, input.name, input.workstream);
  if (!row) throw new Error(`agents.insertAgent: row not found after insert: ${input.name}`);
  return row;
}

/**
 * Look up an agent by its tmux pane id (e.g. `%4`). Returns undefined if
 * no agent currently owns that pane. Used by `mu me` and friends to
 * answer "which agent am I?" from `$TMUX_PANE` without the LLM having to
 * remember its own name.
 *
 * Note: `pane_id` is not declared UNIQUE in the schema (a managed agent
 * could in theory be re-spawned into the same recycled pane id) but in
 * practice tmux pane ids are unique within a server's lifetime, and
 * reconcile prunes ghosts. We return the first match.
 */
export function getAgentByPane(db: Db, paneId: string): AgentRow | undefined {
  const row = db
    .prepare(`SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} WHERE a.pane_id = ? LIMIT 1`)
    .get(paneId) as RawAgentRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

export function getAgent(db: Db, name: string, workstream: string): AgentRow | undefined {
  // v5: agents.name is per-workstream unique, not globally unique.
  // Workstream is required so the same name in two workstreams
  // resolves unambiguously.
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return undefined;
  const row = db
    .prepare(
      `SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} WHERE a.name = ? AND a.workstream_id = ?`,
    )
    .get(name, wsId) as RawAgentRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

export function listAgents(db: Db, opts: { workstream?: string } = {}): AgentRow[] {
  if (opts.workstream === undefined) {
    const rows = db
      .prepare(`SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} ORDER BY ws.name, a.name`)
      .all() as RawAgentRow[];
    return rows.map(rowFromDb);
  }
  const wsId = tryResolveWorkstreamId(db, opts.workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} WHERE a.workstream_id = ? ORDER BY a.name`,
    )
    .all(wsId) as RawAgentRow[];
  return rows.map(rowFromDb);
}

// ─── Pane title composition (mu's durable context) ───────────────────
//
// mu owns the pane title as identity plus task context. Runtime status is
// sampled only when a mu process reconciles, so putting it here leaves a stale
// glyph after the agent stops. A continuously updated observer may append live
// status in tmux chrome without competing with mu for the title.
//
//   worker-a
//   worker-a · build_x
//   worker-a · <glyph multi>2 tasks
//
// The agent name MUST remain the first ' · '-separated token so the
// claim protocol's pane-title-as-identity fallback (currentPaneTitle
// in src/tmux.ts) keeps working. Adopted panes that haven't been
// re-titled by mu just have the name (one token) — still parses.

/** Maximum total length for a composed pane title. tmux truncates
 *  silently in some chrome positions; we truncate the task id
 *  ourselves so the suffix is predictable. */
const MAX_TITLE_LEN = 64;

/**
 * Placeholder pane-id prefix used during the `--workspace` pre-stage in
 * spawnAgent (src/agents/spawn.ts).
 *
 * The placeholder unblocks the FK-ordering cycle:
 *   - vcs_workspaces.agent FK requires an agents row
 *   - agents.pane_id is NOT NULL
 *   - pane creation needs the workspace path as cwd
 * So we insert the agent with a placeholder pane_id, then create the
 * workspace, then the real pane, then patch pane_id.
 *
 * Because no real tmux pane has this prefix, a naive mutating reconcile
 * pass would treat the placeholder row as a ghost and prune it
 * (→ FK-failure on the workspace insert mid-spawn). Reconcile now guards
 * against it explicitly via isPendingPaneId(), and refreshAgentTitle skips
 * placeholders for the same reason.
 *
 * Bug surfaced as bug_agent_spawn_workspace_fk_failure.
 */
export const PENDING_PANE_PREFIX = "%pending-";

/** Build the placeholder pane id for an agent during workspace pre-stage. */
export function pendingPaneIdFor(agentName: string): string {
  return `${PENDING_PANE_PREFIX}${agentName}`;
}

/** True iff `paneId` is a `--workspace` pre-stage placeholder (not yet patched
 *  to the real tmux pane id). */
export function isPendingPaneId(paneId: string): boolean {
  return paneId.startsWith(PENDING_PANE_PREFIX);
}

/** Build the pane title for `agent` based on current DB state.
 *  Pure (no tmux side effect; no DB write). Read-only on the DB. */
export function composeAgentTitle(db: Db, agent: AgentRow): string {
  // Scope by the agent's workstream so a same-named worker in another
  // workstream can't pollute this title's task list.
  const tasks = listTasksByOwner(db, agent.workstreamName, agent.name);
  let title = agent.name;
  if (tasks.length === 1) {
    title += ` · ${tasks[0]?.name}`;
  } else if (tasks.length > 1) {
    title += ` · ${GLYPH.multi}${tasks.length} tasks`;
  }
  if (title.length > MAX_TITLE_LEN) title = `${title.slice(0, MAX_TITLE_LEN - 1)}…`;
  return title;
}

/** Push a fresh pane title for `agentName`. Best-effort — a missing
 *  agent, a placeholder pane id, or a tmux failure are all swallowed
 *  silently (titles are decorative; never block the calling verb). */
export async function refreshAgentTitle(
  db: Db,
  agentName: string,
  workstream: string,
): Promise<void> {
  const agent = getAgent(db, agentName, workstream);
  if (!agent) return;
  if (isPendingPaneId(agent.paneId)) return; // workspace pre-stage placeholder; see PENDING_PANE_PREFIX
  const title = composeAgentTitle(db, agent);
  // Best-effort all the way down, including "no mux reachable at all":
  // pane titles are decorative and must never fail the calling verb.
  await activeMux()
    .then((mux) => mux.setPaneTitle(agent.paneId, title))
    .catch(() => {});
}

/**
 * Delete an agent row. Returns true if a row was matched. Idempotent;
 * deleting an agent that doesn't exist returns false without throwing.
 *
 * Reaper side-effect: any task that was IN_PROGRESS owned by this
 * agent gets flipped back to OPEN with a `[reaper]` task_note and a
 * `task reap` event in `agent_logs`. The FK on `tasks.owner` is
 * `ON DELETE SET NULL` so the owner column resets automatically; the
 * extra step here is the status revert. Without this an agent that
 * crashed (or was explicitly closed mid-task) leaves the task graph
 * in a wrong state — IN_PROGRESS forever, with no owner to release.
 */
export function deleteAgent(db: Db, name: string, workstream: string): boolean {
  const deleted = deleteAgentRow(db, name, workstream);
  if (deleted) unlinkCtlSocket(db, name, workstream);
  return deleted;
}

/**
 * Remove the agent's local control socket file. For a remote agent ssh's
 * `-L` forward leaves that file behind when the connection dies; it
 * probes as `refused`, never `ok`, but it is litter. A local pi removes
 * its own on quit. Best-effort: the row is already gone.
 */
function unlinkCtlSocket(db: Db, name: string, workstream: string): void {
  if (db.memory) return;
  try {
    rmSync(ctlSocketPath(workstream, name, dirname(db.name)), { force: true });
  } catch {
    /* best-effort */
  }
}

function deleteAgentRow(db: Db, name: string, workstream: string): boolean {
  // Wrap the whole reaper sequence (snapshot stuck tasks → DELETE
  // agent → per-task UPDATE + addNote + emitEvent) in a single
  // synchronous better-sqlite3 transaction. Without this, a throw
  // mid-loop (FK race after workstream teardown, addNote/emitEvent
  // regression, OOM, …) would leave the agent row deleted (FK
  // CASCADE already SET NULL on tasks.owner_id) but only PART of
  // the reaper trail written: leftover IN_PROGRESS tasks with no
  // owner and no `[reaper]` note explaining how they got there.
  // Reconcile / `mu task wait --stuck-after` would then surface
  // them as ownerless zombies with no breadcrumb.
  // `task.reap` intent so the tasks-trigger ops this produces are
  // attributable. Without it the reaper's status revert landed as
  // intent=NULL typed ops (measured), unrenderable by the one formatter
  // v2-log-verb builds — the same defect as the prose events, in the
  // other direction.
  return withOpContext(db, { intent: "task.reap", actor: "reaper", group: "new" }, () =>
    db.transaction(() => {
      // Snapshot the stuck tasks BEFORE the DELETE; the FK CASCADE
      // (SET NULL on owner_id) makes the post-delete query
      // indistinguishable from "never owned by this agent."
      const agentId = agentIdByName(db, name, workstream);
      if (agentId === null) {
        // Already gone — idempotent return. (Could happen if reconcile
        // pruned a ghost concurrently.) The DELETE is a no-op.
        return false;
      }
      const stuck = db
        .prepare(
          `SELECT t.id AS taskId, t.local_id AS localId, ws.name AS workstream
             FROM tasks t
             JOIN workstreams ws ON ws.id = t.workstream_id
            WHERE t.owner_id = ? AND t.status = 'IN_PROGRESS'`,
        )
        .all(agentId) as Array<{ taskId: number; localId: string; workstream: string }>;

      const result = db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
      if (result.changes === 0) return false;

      for (const t of stuck) {
        db.prepare(
          "UPDATE tasks SET status = 'OPEN', substate = 'todo', updated_at = ? WHERE id = ?",
        ).run(new Date().toISOString(), t.taskId);
        addNote(
          db,
          t.localId,
          `[reaper] previous owner ${name} gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared`,
          { author: "reaper", workstream: t.workstream },
        );
        // No emitEvent: the UPDATE above fired the tasks capture
        // trigger. Reap is the one site the orchestrator's split did not
        // predict — it DOES mutate a portable table, so a trigger sees
        // it, but it ran outside any withOpContext and so produced
        // intent=NULL typed ops. The fix is the intent above, not a
        // second prose row. The `[reaper]` task_note is the
        // human-readable breadcrumb, and it is itself a captured op.
      }
      return true;
    })(),
  );
}

// ────────────────────────────────────────────────────────────────────────
// High-level verbs (spawn, send, read, list, close)
// ────────────────────────────────────────────────────────────────────────

/** Allowed agent name shape: lowercase alpha first, then alnum/underscore/
 *  hyphen. Mirrors docs/reference/naming.md. */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

/**
 * Send text to an agent and submit it. A pi agent gets it through its
 * control socket (AgentCtlUnreachableError when that does not answer —
 * never a silent paste); a non-pi CLI, a slash command, or `via: "mux"`
 * goes through the mux paste path. See src/agents/transport.ts.
 */
export async function sendToAgent(
  db: Db,
  name: string,
  text: string,
  opts: TransportSendOptions & { workstream: string },
): Promise<SendResult> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name);
  return sendViaTransport(agent, text, {
    ...opts,
    socket: opts.socket ?? agentCtlSocket(db, agent),
  });
}

/**
 * Read scrollback from an agent's pane. With no options, returns the full
 * scrollback (`-S - -E -`); with `lines: N`, returns only the last N lines.
 */
export async function readAgent(
  db: Db,
  name: string,
  opts: CaptureOptions & { workstream: string },
): Promise<string> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name);
  // Load-bearing: the scrollback IS the output of this verb.
  return (await activeMux()).capturePane(agent.paneId, opts);
}

export interface CloseAgentOptions {
  /**
   * Lossy override: when true, free the agent's workspace BEFORE
   * deleting the agent regardless of whether it's clean. (We control
   * the order rather than relying on FK cascade, which leaves the
   * on-disk dir orphaned.) Any pending changes / commits since fork
   * are gone unless the caller frees with `--commit` separately first.
   *
   * When false (default), behaviour depends on workspace state:
   *   - clean (no uncommitted changes AND no commits since fork):
   *     silently auto-free. allow_mu_agent_close_without_discard.
   *   - dirty (uncommitted changes OR commits since fork): throw
   *     WorkspacePreservedError so the caller decides explicitly.
   * Surfaced as a real bug in the multi-agent dogfood teardown.
   */
  discardWorkspace?: boolean;
}

export interface CloseAgentResult {
  killedPane: boolean;
  deletedRow: boolean;
  /** True iff the agent had an associated workspace AND we proactively
   *  freed it — either because the caller passed `discardWorkspace:
   *  true` (lossy) or because the workspace was clean and we
   *  auto-freed (allow_mu_agent_close_without_discard). False on the
   *  no-workspace path (nothing to free) and on the refused path (we
   *  threw before doing anything). */
  workspaceFreed: boolean;
  /** True iff `workspaceFreed` was triggered by the clean-workspace
   *  auto-free path (no uncommitted changes AND no commits since
   *  fork) rather than the explicit `discardWorkspace: true` override.
   *  Lets the CLI render an accurate message ("auto-freed (clean)"
   *  vs "workspace discarded") and gives JSON consumers a stable
   *  signal. False on every other path. */
  workspaceAutoFreedClean: boolean;
}

/**
 * Close an agent: kill its tmux pane and remove its DB row. Idempotent:
 *   - if the agent doesn't exist in the DB, returns a no-op result
 *   - if the tmux pane is already gone, killPane swallows the error
 *
 * Workspace handling: closing an agent and freeing its workspace are
 * separate concerns (agent lifecycle vs disk artifacts). Three cases:
 *
 *   - No workspace: close proceeds normally.
 *   - Workspace exists AND is CLEAN (no uncommitted changes, no
 *     commits since fork): silently auto-free (so a workspace that
 *     contains nothing worth preserving doesn't make the operator
 *     type --discard-workspace just to clean it up). Surfaced by
 *     allow_mu_agent_close_without_discard — a misconfigured-spawn
 *     teardown was needlessly forced through the lossy flag.
 *   - Workspace exists AND has either uncommitted changes OR commits
 *     since fork: REFUSE with WorkspacePreservedError so the operator
 *     decides explicitly. Two resolutions:
 *       1. `freeWorkspace(db, name)` first, then `closeAgent(db, name)`.
 *          Preserves the option to `--commit` pending changes.
 *       2. `closeAgent(db, name, { discardWorkspace: true })`.
 *          One-shot; lossy.
 *
 * The CLI surfaces these as the two actionable nextSteps on the
 * `WorkspacePreservedError` thrown by the refuse path.
 */
export async function closeAgent(
  db: Db,
  name: string,
  opts: CloseAgentOptions & { workstream: string },
): Promise<CloseAgentResult> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) {
    return {
      killedPane: false,
      deletedRow: false,
      workspaceFreed: false,
      workspaceAutoFreedClean: false,
    };
  }
  const ws = getWorkspaceForAgent(db, name, agent.workstreamName);
  // allow_mu_agent_close_without_discard: silently auto-free a clean
  // workspace (no uncommitted changes AND no commits since fork) so
  // the user doesn't have to type --discard-workspace for a workspace
  // that contains nothing worth preserving. Only refuse when there's
  // actually something to lose. The flag stays as the lossy override
  // for non-clean workspaces.
  let autoFreeClean = false;
  if (ws !== undefined && opts.discardWorkspace !== true) {
    autoFreeClean = await isWorkspaceClean(ws);
    if (!autoFreeClean) {
      throw new WorkspacePreservedError(name, ws.path);
    }
  }
  // No pre-mutation snapshot: v9 dropped the `snapshots` table and
  // rollback is inverse ops over the ops log (`mu undo`).
  // Free the workspace BEFORE the agent (so the on-disk dir is
  // removed cleanly, not orphaned by FK cascade). freeWorkspace is
  // idempotent on missing rows.
  let workspaceFreed = false;
  if (ws !== undefined && (opts.discardWorkspace === true || autoFreeClean)) {
    await freeWorkspace(db, name, { commit: false, workstream: agent.workstreamName });
    workspaceFreed = true;
  }
  await activeMux()
    .then((mux) => mux.killPane(agent.paneId))
    .catch(() => {
      /* idempotent — pane may already be gone, or the mux with it */
    });
  const deletedRow = deleteAgent(db, name, agent.workstreamName);
  // Machine-local table (`agents`): no trigger, so this emit is the
  // only record.
  emitEvent(
    db,
    agent.workstreamName,
    "agent.close",
    `agent close ${name} (pane=${agent.paneId}${
      workspaceFreed
        ? autoFreeClean
          ? ", workspace auto-freed (clean)"
          : ", workspace discarded"
        : ""
    })`,
  );
  return {
    killedPane: true,
    deletedRow,
    workspaceFreed,
    workspaceAutoFreedClean: workspaceFreed && autoFreeClean,
  };
}

export interface ListLiveAgentsOptions {
  workstream: string;
  tmuxSession?: string;
  /**
   * Which kind of reconciliation pass to run. Forwarded to
   * `reconcile()`'s same-name option. Default `"full"` (the
   * documented mutating behaviour `mu agent list` has always had,
   * now also used by `mu state`).
   *
   * `mu doctor` and `mu undo` pass `"report-only"`: count drift,
   * mutate nothing. `mu undo` MUST use this so a post-restore
   * reconcile doesn't delete the rows the snapshot just restored
   * (snap_undo_reconcile_destroys_recovered_agents).
   *
   * Mid-spawn placeholders (pane id `%pending-<name>`) are protected
   * directly in reconcile's prune loop, independent of mode
   * (bug_agent_spawn_workspace_fk_failure).
   *
   * BREAKING: this replaces the previous `dryRun?: boolean`
   * option. Migration: `dryRun: true` → `mode: "report-only"`;
   * default (`dryRun: false` / unset) → `mode: "full"`.
   */
  mode?: ReconcileMode;
}

export interface LiveAgentsView {
  /** All registered agents in the workstream, post-reconcile. */
  agents: LiveAgent[];
  /** Panes in the tmux session that look like agents but aren't registered. */
  orphans: MuxPane[];
  /** Diagnostic numbers from the reconcile pass; useful for `mu doctor`. */
  report: ReconcileReport;
}

/**
 * Return the live, reality-reconciled view of agents in a workstream.
 * `mu state` and `mu agent list` call this with the default `mode: "full"`
 * (mutating); read-only diagnostic / restore paths
 * (`mu doctor`, `mu undo`) call it with `mode: "report-only"` to mutate
 * nothing at all.
 */
export async function listLiveAgents(db: Db, opts: ListLiveAgentsOptions): Promise<LiveAgentsView> {
  const report = await reconcile(db, {
    workstream: opts.workstream,
    ...(opts.tmuxSession !== undefined ? { tmuxSession: opts.tmuxSession } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
  });
  const baseAgents = listAgents(db, { workstream: opts.workstream });
  const readings = await readAgentStates(baseAgents, { stateDir: dirname(db.name) });
  const now = Date.now();
  const agents: LiveAgent[] = baseAgents.map((agent) => {
    const reading = readings.get(agentKey(agent)) ?? {
      state: "unknown" as const,
      source: "none" as const,
      since: null,
      alive: true,
      reason: "state unavailable",
    };
    const live: LiveAgent = {
      ...agent,
      state: reading.state,
      source: reading.source,
      ctl: reading.ctl ?? "n/a",
      since: reading.since === null ? null : new Date(reading.since).toISOString(),
      ...(reading.reason !== undefined ? { reason: reading.reason } : {}),
    };
    return computeAgentIdle(db, live, now) ? { ...live, idle: true } : live;
  });
  return { agents, orphans: report.orphans, report };
}
