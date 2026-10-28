// mu — agent registry CRUD + send / read / list, and the re-exports of the
// src/agents/ cluster (spawnAgent and closeAgent live in agents/spawn.ts and
// agents/close.ts).
//
// Layering inside this file:
//
//   - Types & raw-row mapping (RawAgentRow / rowFromDb)
//   - CRUD primitives        (insertAgent, getAgent, listAgents,
//                              deleteAgent)
//   - Verbs                  (sendToAgent, readAgent, listLiveAgents)
//
// The verbs compose the CRUD primitives with the mux and reconciliation
// layers. They are deliberately thin.

import { dirname } from "node:path";
import {
  agentKey,
  type CtlLink,
  type RuntimeState,
  readAgentStates,
  type StateReading,
  type StateSource,
} from "./agent-state.js";
import { reapAgentRow } from "./agents/reap.js";
import { type Db, resolveWorkstreamId, tryResolveWorkstreamId } from "./db.js";
import type { CommandSource } from "./mux/types.js";
import { withOpContext } from "./op-context.js";
import { type ReconcileMode, type ReconcileReport, reconcile } from "./reconcile.js";

// Re-export the cluster modules so external callers continue to
// `import { AgentNotFoundError, spawnAgent, ... } from "./agents.js"`.
export {
  type AbortAgentOptions,
  type AbortResult,
  abortAgent,
  DEFAULT_ABORT_TIMEOUT_MS,
  type InterruptResult,
  interruptAgent,
} from "./agents/abort.js";
export {
  type CloseAgentOptions,
  type CloseAgentResult,
  type ClosePreview,
  closeAgent,
  previewClose,
} from "./agents/close.js";
export { type DelegateOutcome, delegateOutcome } from "./agents/delegate.js";
export {
  AgentAbortNeedsCtlError,
  AgentAbortTimeoutError,
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentDiedOnSpawnError,
  AgentEmptySendError,
  AgentExistsError,
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
  AgentLockBusyError,
  AgentNameExhaustedError,
  AgentNotFoundError,
  AgentNotInWorkstreamError,
  AgentPaneDeadError,
  AgentPaneStillAliveError,
  AgentReplacedError,
  AgentRestartedError,
  AgentSendIndeterminateError,
  AgentSendUnsupportedError,
  AgentSlashCommandUnsupportedError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
  CarrierJobUnstoppedError,
  SpawnAttemptBusyError,
  SpawnAttemptFailedError,
  SpawnAttemptGuardError,
  SpawnReceiptConflictError,
  SpawnTaskStateError,
  SpawnTrustDialogError,
} from "./agents/errors.js";
export { withAgentLock } from "./agents/lock.js";
export {
  type AgentObservation,
  type ObservedAgent,
  type ObservedWatch,
  observationFromReading,
  observeAgentStates,
  settledCloseInput,
  watchAgentRun,
} from "./agents/observe.js";
export type { SpawnReceipt } from "./agents/receipts.js";
export {
  type CommandResolutionResult,
  type CommandResolver,
  checkCommandResolvable,
  defaultSpawnCtlMs,
  defaultSpawnLivenessMs,
  envVarNameForCli,
  nextFreeAgentName,
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
  type AutoAttemptRequest,
  pinBrief,
  spawnAutoAttempt,
  spawnForTask,
  type TaskSpawnOutcome,
  type TaskSpawnRequest,
} from "./agents/task-spawn.js";
export {
  agentCtlSocket,
  CTL_SLASH_COMMANDS,
  checkMessage,
  expectsCtl,
  isSlashCommand,
  type MessageCheck,
  parseSessionCommand,
  requireFeature,
  respawnCommand,
  type SendResult,
  sendViaTransport,
  type Transport,
  type TransportSendOptions,
} from "./agents/transport.js";

import {
  AgentExistsError,
  AgentNotFoundError,
  AgentReplacedError,
  CarrierJobUnstoppedError,
} from "./agents/errors.js";
import {
  agentCtlSocket,
  recordSend,
  type SendResult,
  sendViaTransport,
  type TransportSendOptions,
} from "./agents/transport.js";
import { getCarrierJobByName } from "./carrier-jobs.js";
import { unlinkCtlSocket } from "./ctl/path.js";
import type { CtlTool } from "./ctl/protocol.js";
import { activeMux, type CaptureOptions, type MuxPane } from "./mux.js";
import { resolveActorIdentity } from "./tasks/claim.js";
import { ensureWorkstream, isScratchWorkstream } from "./workstream.js";

export interface AgentRow {
  /**
   * The registry incarnation: the row's surrogate id. AUTOINCREMENT never
   * reuses one, so a name that is deleted and created again (or a pane id
   * that is reused) is always a NEW incarnation. Every destructive agent
   * write compares it (`deleteAgent`'s `expected`, `agent close --if`).
   * Not pi's `incarnation` (a string, the `--inc` of `agent wait`).
   */
  incarnation: number;
  name: string;
  /** Foreign-name reference to the owning workstream. */
  workstreamName: string;
  cli: string;
  paneId: string;
  role: string;
  /** Window name; null when the agent has its own window named after itself. */
  tab: string | null;
  /** Directory the pane started in (its worktree under `--worktree`); null when spawned without a cwd. */
  cwd: string | null;
  /** Commit the worktree was created at; null without `--worktree`. */
  base: string | null;
  /** The command the pane was started with (machine-local); null for a row older than this column. */
  command: string | null;
  /** Where `command` came from; null with it. */
  commandSource: CommandSource | null;
  /** Who spawned it: `<workstream>/<agent>` for a managed caller, else
   *  `pi:<PI_SESSION_ID>`; null when unknown (older rows, no identity). */
  spawner: string | null;
  /** The remote host profile it runs on; null for a local agent. */
  host: string | null;
  /** HEAD last collected from its remote worktree; null until one is. */
  collectedHead: string | null;
  /** A remote worktree's repo on its host (absolute, chosen at spawn); null otherwise. */
  repo: string | null;
  /** Set for a remote command gate (`spawn --host` of a non-pi command): its spawn-unique token, the key of the remote result record. Null for every other agent. */
  gateToken: string | null;
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
  /** The running tool of a pi agent (ctl read); null = none, absent = unknown. Not in `AgentOutput`. */
  tool?: CtlTool | null;
}

/** Default idle threshold for the derived `idle` flag (`mu state`, TUI).
 *  Deliberately looser than `mu task wait --stuck-after` (2 min), which
 *  acts on the stall rather than just displaying it. */
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
  cwd?: string | null;
  base?: string | null;
  /** The resolved command and where it came from, kept so an outdated
   *  extension can be respawned exactly. */
  command?: string | null;
  commandSource?: CommandSource | null;
  /** Who spawned it (see AgentRow.spawner); never guessed from task ownership. */
  spawner?: string | null;
  host?: string | null;
  collectedHead?: string | null;
  repo?: string | null;
  gateToken?: string | null;
  /** The lease spawn's own `carrier_jobs` reservation token: the one the name fence lets through. */
  reservation?: string;
}

interface RawAgentRow {
  id: number;
  name: string;
  /** Joined from workstreams.name. */
  workstream: string;
  cli: string;
  pane_id: string;
  role: string;
  tab: string | null;
  cwd: string | null;
  base: string | null;
  command: string | null;
  command_source: string | null;
  spawner: string | null;
  host: string | null;
  collected_head: string | null;
  repo: string | null;
  gate_token: string | null;
  created_at: string;
  updated_at: string;
}

/** SELECT clause that joins agents to workstreams, exposing the
 *  operator-facing workstream name as `workstream`. Used by every
 *  read path. */
const SELECT_AGENT_COLS = `
  a.id AS id,
  a.name AS name,
  ws.name AS workstream,
  a.cli AS cli,
  a.pane_id AS pane_id,
  a.role AS role,
  a.tab AS tab,
  a.cwd AS cwd,
  a.base AS base,
  a.command AS command,
  a.command_source AS command_source,
  a.spawner AS spawner,
  a.host AS host,
  a.collected_head AS collected_head,
  a.repo AS repo,
  a.gate_token AS gate_token,
  a.created_at AS created_at,
  a.updated_at AS updated_at
`;

const AGENT_FROM_JOIN = "FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id";

function rowFromDb(row: RawAgentRow): AgentRow {
  return {
    incarnation: row.id,
    name: row.name,
    workstreamName: row.workstream,
    cli: row.cli,
    paneId: row.pane_id,
    role: row.role,
    tab: row.tab,
    cwd: row.cwd,
    base: row.base,
    command: row.command,
    commandSource:
      row.command_source === "explicit" ||
      row.command_source === "env" ||
      row.command_source === "cli-key"
        ? row.command_source
        : null,
    spawner: row.spawner,
    host: row.host,
    collectedHead: row.collected_head,
    repo: row.repo,
    gateToken: row.gate_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resolve an agent's surrogate id by (workstream, name). Returns
 *  null on miss. Sees agents of a torn-down workstream too: their rows
 *  outlive the teardown while their pane lives, and cleanup must reach them. */
function agentIdByName(db: Db, name: string, workstream: string): number | null {
  const row = db
    .prepare(
      `SELECT a.id AS id FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id
        WHERE a.name = ? AND ws.name = ?`,
    )
    .get(name, workstream) as { id: number } | undefined;
  return row ? row.id : null;
}

export function insertAgent(db: Db, input: InsertAgentInput): AgentRow {
  // Auto-create the workstreams row if missing so the FK on
  // agents.workstream_id is always satisfied. Preserves the ergonomics
  // where you could spawn without an explicit `mu workstream init`.
  ensureWorkstream(db, input.workstream);
  const workstreamId = resolveWorkstreamId(db, input.workstream);
  const now = new Date().toISOString();
  let inserted: number;
  try {
    // The name fence, in the same statement: no row while (workstream, name) holds a
    // carrier_jobs reservation other than the caller's own (src/carrier-jobs.ts).
    inserted = db
      .prepare(
        `INSERT INTO agents (name, workstream_id, cli, pane_id, status, role, tab, cwd, base, command, command_source, spawner, host, collected_head, repo, gate_token, created_at, updated_at)
       SELECT @name, @workstreamId, COALESCE(@cli, 'pi'), @paneId, 'spawning',
               COALESCE(@role, 'full-access'), @tab, @cwd, @base, @command, @commandSource,
               @spawner, @host, @collectedHead, @repo, @gateToken, @now, @now
       WHERE NOT EXISTS (SELECT 1 FROM carrier_jobs c
                         WHERE c.workstream = @workstream AND c.name = @name AND c.token IS NOT @reservation)`,
      )
      .run({
        name: input.name,
        workstream: input.workstream,
        workstreamId,
        cli: input.cli ?? null,
        paneId: input.paneId,
        role: input.role ?? null,
        tab: input.tab ?? null,
        cwd: input.cwd ?? null,
        base: input.base ?? null,
        command: input.command ?? null,
        commandSource: input.commandSource ?? null,
        spawner: input.spawner ?? null,
        host: input.host ?? null,
        collectedHead: input.collectedHead ?? null,
        repo: input.repo ?? null,
        gateToken: input.gateToken ?? null,
        reservation: input.reservation ?? null,
        now,
      }).changes;
  } catch (err) {
    // UNIQUE (workstream_id, name): a concurrent spawn took the
    // name between the caller's existence check and this insert.
    if ((err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new AgentExistsError(input.name);
    }
    throw err;
  }
  if (inserted === 0) {
    const r = getCarrierJobByName(db, input.workstream, input.name);
    if (r !== undefined) throw new CarrierJobUnstoppedError(input.name, r);
    throw new Error(`agents.insertAgent: row not inserted: ${input.name}`);
  }
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

/**
 * Like `getAgent`, but also finds an agent whose workstream is torn down
 * (a teardown that kept its row because the pane lived, or a peer's
 * teardown that reached this machine). For cleanup only: every other verb
 * treats a torn-down workstream as gone.
 */
export function getAgentForCleanup(db: Db, name: string, workstream: string): AgentRow | undefined {
  const row = db
    .prepare(`SELECT ${SELECT_AGENT_COLS} ${AGENT_FROM_JOIN} WHERE a.name = ? AND ws.name = ?`)
    .get(name, workstream) as RawAgentRow | undefined;
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

/**
 * Placeholder pane-id prefix used during the `--worktree` pre-stage in
 * spawnAgent (src/agents/spawn.ts).
 *
 * The worktree is created before the pane exists (the pane starts in it),
 * and the name must be claimed against a parallel spawn of the same name
 * while that happens. So spawn inserts the agent row with a placeholder
 * pane_id, creates the worktree, then the real pane, then patches pane_id.
 *
 * Because no real pane has this prefix, a naive mutating reconcile pass
 * would treat the placeholder row as a ghost and prune it mid-spawn.
 * Reconcile guards against it explicitly via isPendingPaneId().
 */
export const PENDING_PANE_PREFIX = "%pending-";

/** Build the placeholder pane id for an agent during worktree pre-stage. */
export function pendingPaneIdFor(agentName: string): string {
  return `${PENDING_PANE_PREFIX}${agentName}`;
}

/** True iff `paneId` is a `--worktree` pre-stage placeholder (not yet patched
 *  to the real tmux pane id). */
export function isPendingPaneId(paneId: string): boolean {
  return paneId.startsWith(PENDING_PANE_PREFIX);
}

/**
 * Delete an agent row. Returns true if a row was matched. Idempotent;
 * deleting an agent that doesn't exist returns false without throwing.
 *
 * Reaper side-effect: any task that was IN_PROGRESS owned by this
 * agent gets flipped back to OPEN with a `[reaper]` task_note, and a
 * remote worker's worktree is recorded in `remote_recovery` first, all in
 * one transaction (src/agents/reap.ts). The FK on `tasks.owner` is
 * `ON DELETE SET NULL` so the owner column resets automatically; the
 * extra step here is the status revert. Without this an agent that
 * crashed (or was explicitly closed mid-task) leaves the task graph
 * in a wrong state — IN_PROGRESS forever, with no owner to release.
 */
export function deleteAgent(
  db: Db,
  name: string,
  workstream: string,
  /**
   * Compare-and-swap, checked inside the reaper transaction: delete only
   * if the row still has this pane id (a bare string) and/or this
   * incarnation. Same name but another pane or incarnation means the agent
   * was replaced: it is kept (false), with its row, socket and tasks.
   */
  expected?: string | AgentIdentity,
  /**
   * `preserve: false` skips the remote recovery record: only for a close that
   * has itself just removed (or found gone) the worktree. Every other
   * deleter keeps what the row says about it (src/remote-recovery.ts).
   */
  opts: { preserve?: boolean } = {},
): boolean {
  const deleted = deleteAgentRow(db, name, workstream, expected, opts);
  if (deleted) unlinkCtlSocket(db, name, workstream);
  return deleted;
}

/** Which incarnation of a name a destructive write means. */
export interface AgentIdentity {
  paneId?: string;
  incarnation?: number;
}

function deleteAgentRow(
  db: Db,
  name: string,
  workstream: string,
  expected: string | AgentIdentity | undefined,
  opts: { preserve?: boolean },
): boolean {
  const want: AgentIdentity =
    typeof expected === "string" ? { paneId: expected } : (expected ?? {});
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
    db
      .transaction(() => {
        // Snapshot the stuck tasks BEFORE the DELETE; the FK CASCADE
        // (SET NULL on owner_id) makes the post-delete query
        // indistinguishable from "never owned by this agent."
        const agentId = agentIdByName(db, name, workstream);
        if (agentId === null) {
          // Already gone — idempotent return. (Could happen if reconcile
          // pruned a ghost concurrently.) The DELETE is a no-op.
          return false;
        }
        // Same name, different pane or incarnation: the agent was replaced; keep it.
        if (want.incarnation !== undefined && agentId !== want.incarnation) return false;
        if (want.paneId !== undefined) {
          const cur = db.prepare("SELECT pane_id FROM agents WHERE id = ?").get(agentId) as
            | { pane_id: string }
            | undefined;
          if (cur?.pane_id !== want.paneId) return false;
        }
        return reapAgentRow(db, agentId, name, {
          preserve: opts.preserve !== false,
        });
      })
      .immediate(),
  );
}

// ────────────────────────────────────────────────────────────────────────
// High-level verbs (spawn, send, read, list, close)
// ────────────────────────────────────────────────────────────────────────

/** Allowed agent name shape: lowercase alpha first, then alnum/underscore/
 *  hyphen. Mirrors docs/reference/naming.md. */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Longest name AGENT_NAME_RE accepts. */
export const MAX_AGENT_NAME_LEN = 32;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

/**
 * Send text to an agent and submit it. A pi agent gets it through its
 * control socket (AgentCtlUnreachableError when that does not answer —
 * never a silent paste), `/new` / `/reload` / `/compact` included; a
 * non-pi CLI gets one atomic herdr `agent prompt`; on tmux it is refused
 * (AgentSendUnsupportedError). See src/agents/transport.ts.
 */
export async function sendToAgent(
  db: Db,
  name: string,
  text: string,
  opts: TransportSendOptions & {
    workstream: string;
    /**
     * The registry id + pane the caller means (a just-spawned agent): the
     * name now holding another one is refused (AgentReplacedError), the
     * prompt never goes to a replacement.
     */
    expect?: { incarnation: number; paneId: string };
  },
): Promise<SendResult> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name);
  if (
    opts.expect !== undefined &&
    (agent.incarnation !== opts.expect.incarnation || agent.paneId !== opts.expect.paneId)
  ) {
    throw new AgentReplacedError(name, opts.workstream, "sent to");
  }
  const sent = await sendViaTransport(agent, text, {
    ...opts,
    socket: opts.socket ?? agentCtlSocket(db, agent),
  });
  const source = await resolveActorIdentity();
  recordSend(
    db,
    agent,
    opts.fresh ? "fresh" : opts.mode === "steer" ? "steer" : "plain",
    Buffer.byteLength(text),
    {
      transport: sent.transport,
      command: sent.command,
      state: sent.state,
      since: sent.since,
    },
    source,
  );
  return sent;
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
  return (await activeMux()).capture(agent.paneId, opts);
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
   * `mu doctor` passes `"report-only"`: count drift, mutate nothing.
   *
   * Mid-spawn placeholders (pane id `%pending-<name>`) are protected
   * directly in reconcile's prune loop, independent of mode
   * (see PENDING_PANE_PREFIX).
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
 * (mutating); the read-only diagnostic (`mu doctor`) calls it with
 * `mode: "report-only"` to mutate nothing at all.
 */
export async function listLiveAgents(db: Db, opts: ListLiveAgentsOptions): Promise<LiveAgentsView> {
  const report = await reconcile(db, {
    workstream: opts.workstream,
    ...(opts.tmuxSession !== undefined ? { tmuxSession: opts.tmuxSession } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
  });
  return { agents: await readLiveAgents(db, opts.workstream), orphans: report.orphans, report };
}

/**
 * The registered agents of a workstream with their computed runtime state
 * (ctl probe, idle flag), WITHOUT reconciling: no mux read, nothing reaped,
 * no write. The read-only half of {@link listLiveAgents}; `stateSnapshot`
 * (and so `mu state --me` and the dashboard) uses it.
 */
export async function readLiveAgents(
  db: Db,
  workstream: string,
  /** Only the agent of this name (`mu me` reads itself, not its neighbours' sockets). */
  only?: string,
  /**
   * A reading cache keyed by `agentKey` (the dashboard's slow tier). With `probe: false`
   * an agent already in the cache is NOT probed (no socket, no subprocess): only agents
   * missing from it are, and their readings are added. `probe: true` re-reads every agent
   * and refreshes the cache. Absent: probe every agent, cache nothing.
   */
  states?: { cache: Map<string, StateReading>; probe: boolean },
): Promise<LiveAgent[]> {
  const baseAgents = listAgents(db, { workstream }).filter(
    (a) => only === undefined || a.name === only,
  );
  const stateDir = dirname(db.name);
  let readings: ReadonlyMap<string, StateReading>;
  if (states === undefined) readings = await readAgentStates(baseAgents, { stateDir });
  else {
    const due = states.probe
      ? baseAgents
      : baseAgents.filter((a) => !states.cache.has(agentKey(a)));
    if (due.length > 0) {
      for (const [k, r] of await readAgentStates(due, { stateDir })) states.cache.set(k, r);
    }
    readings = states.cache;
  }
  const now = Date.now();
  return baseAgents.map((agent) => {
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
      ...(reading.tool !== undefined ? { tool: reading.tool } : {}),
    };
    return computeAgentIdle(db, live, now) ? { ...live, idle: true } : live;
  });
}
