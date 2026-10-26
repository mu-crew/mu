// mu — workstream-level operations.
//
// One workstream = one mux session + N agents + M tasks (and their
// edges/notes) all sharing the workstream column. 0.1.0 ships `mu init`
// (create the mux session) and `mu workstream teardown` (this module: nuke the
// mux session and every DB row tagged with the workstream name).
//
// `teardownWorkstream` is SOFT and needs a preview revision (`--if <rev>`):
// it kills the session, deletes the
// machine-local agent rows and sets `workstreams.torn_down_at`. Tasks,
// edges and notes stay. It is idempotent on every leg:
//   - mux session already gone         → nothing to kill
//   - no agents for this name          → nothing to delete
//   - workstream never existed at all  → returns all-zero counts
//
// Both summarize and teardown take an optional `muxSession` override so
// tests (and the rare workstream whose mux session was created with a
// non-default name) work without env-var gymnastics.

import { readdirSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import { reapAgentRow } from "./agents/reap.js";
import { WORKSTREAM_OPS_WHERE } from "./compact.js";
import { unlinkCtlSocket } from "./ctl/path.js";
import { type Db, tornDownAtOf } from "./db.js";
import { say } from "./messages.js";
import { activeMux } from "./mux.js";
import { withOpContext } from "./op-context.js";
import { listWorktrees } from "./worktree.js";

/**
 * Allowed workstream-name shape: lowercase alpha first, then alnum,
 * underscore, or hyphen, up to 32 chars total. Mirrors the agent-name
 * rule in docs/reference/naming.md.
 *
 * Critically, this rule excludes `.` and `:` — tmux silently rewrites
 * `.` to `_` in session names (because `.` is the window/pane separator
 * in tmux's `session:window.pane` target syntax) and `:` is reserved
 * outright. A workstream name with `.` would create a session that mu
 * couldn't subsequently look up, breaking every downstream verb. We
 * fail loud at init time instead.
 */
const WORKSTREAM_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Reserved prefix — mu auto-prepends `mu-` to derive the tmux session
 *  name (so workstream `auth` lives in tmux session `mu-auth`). A
 *  workstream named `mu-auth` would produce session `mu-mu-auth`,
 *  which the user almost certainly didn't intend. Fail loud rather
 *  than silently double-prefix. */
export const RESERVED_WORKSTREAM_PREFIX = "mu-";

/** Reserved workstream names that may only be auto-created on spawn,
 *  never via `mu workstream init`. `scratch` is the off-the-cuff bucket
 *  for ad-hoc agents you'll keep talking to without crew/DAG ceremony;
 *  it auto-creates on first `mu agent spawn <name> -w scratch` (via
 *  `ensureWorkstream`, which stays permissive) but `init` is rejected
 *  loud so the operator doesn't treat it as a durable crew workstream.
 *  See docs/VOCABULARY.md "scratch workstream". */
export const RESERVED_WORKSTREAM_NAMES = new Set(["scratch"]);

// ─── Best-effort mux reads ─────────────────────────────────────────
//
// Every workstream READ decorates DB truth with mux liveness. The DB
// half always works, so an unreachable mux must degrade the decoration
// ("no sessions", "not alive") rather than fail `mu workstream list`
// on a box where nobody is running a multiplexer right now.

/** True iff the mux reports panes in `session` (a live session always
 *  holds its `_mu` pane, and both backends drop a session with its last
 *  pane). Best-effort: an unreachable mux reads as "not alive". */
async function sessionAlive(session: string): Promise<boolean> {
  try {
    return (await (await activeMux()).listPanes(session)).length > 0;
  } catch {
    return false;
  }
}

/** True iff `name` is a scratch/ephemeral workstream (special-cased by
 *  the staleness nudge, the TUI ephemeral marker, the kept-alive
 *  session on spawn, and the `teardown --empty` exemption). */
export function isScratchWorkstream(name: string): boolean {
  return RESERVED_WORKSTREAM_NAMES.has(name);
}

/**
 * The workstream implied by the mux session the caller sits in, or
 * null. Best-effort: this is one rung of the -w resolution ladder, so
 * an unreachable mux means "no ambient answer", never a thrown verb.
 */
export async function resolveMuxSessionWorkstreamName(): Promise<string | null> {
  try {
    const name = await (await activeMux()).currentSessionName();
    if (name?.startsWith(RESERVED_WORKSTREAM_PREFIX)) {
      return name.slice(RESERVED_WORKSTREAM_PREFIX.length);
    }
  } catch {
    // fall through: mux context is best-effort for workstream resolution
  }
  return null;
}

export function isValidWorkstreamName(name: string): boolean {
  if (!WORKSTREAM_NAME_RE.test(name)) return false;
  if (name.startsWith(RESERVED_WORKSTREAM_PREFIX)) return false;
  return true;
}

/** A workstream name collision. Exported SDK error class mapped to exit
 *  4 (conflict) by `classifyError`; no mu verb throws it today
 *  (`ensureWorkstream` is idempotent). Invalid names throw
 *  `WorkstreamNameInvalidError`. */
export class WorkstreamExistsError extends Error {
  override readonly name: string = "WorkstreamExistsError";
  constructor(public readonly workstream: string) {
    super(say("workstream.exists", workstream));
  }
}

export class WorkstreamNameInvalidError extends Error {
  override readonly name = "WorkstreamNameInvalidError";
  constructor(public readonly attempted: string) {
    super(
      say("workstream.name_invalid", attempted, attempted.startsWith(RESERVED_WORKSTREAM_PREFIX)),
    );
  }
}

function assertValidWorkstreamName(name: string): void {
  if (!isValidWorkstreamName(name)) throw new WorkstreamNameInvalidError(name);
}

/** Thrown by `mu workstream init` when the operator tries to create a
 *  reserved workstream (e.g. `scratch`) explicitly. The name is not
 *  invalid — it auto-creates on spawn — it just can't be `init`ed. */
export class WorkstreamNameReservedError extends Error {
  override readonly name = "WorkstreamNameReservedError";
  constructor(public readonly attempted: string) {
    super(say("workstream.name_reserved", attempted));
  }
}

/** A destructive verb was given a preview revision that no longer matches:
 *  the workstream (its ops, agents or worktrees) changed since the preview.
 *  Exit 4, nothing was done. One stderr line: the message names the
 *  preview command (`inlineNext`). */
export class WorkstreamRevisionMismatchError extends Error {
  override readonly name = "WorkstreamRevisionMismatchError";
  constructor(
    public readonly workstream: string,
    public readonly expected: number,
    public readonly actual: number,
    /** The command that previews again. */
    public readonly previewCommand: string = `mu workstream teardown ${workstream}`,
  ) {
    super(say("workstream.changed", workstream, expected, actual, previewCommand));
  }
}

/** `workstream init --if` over a torn-down name would hard-delete rows
 *  while this machine still has agent rows (so possibly live panes) in it.
 *  A peer's teardown can reach a machine that still runs its agents. Exit 4. */
export class WorkstreamHasAgentsError extends Error {
  override readonly name = "WorkstreamHasAgentsError";
  constructor(
    public readonly workstream: string,
    public readonly agents: readonly string[],
  ) {
    super(say("workstream.has_agents", workstream, agents));
  }
}

/** A teardown found registered panes still alive outside its session
 *  (moved by hand): killing the session would not stop them, and deleting
 *  their rows would orphan them. Exit 4, nothing was done. */
export class WorkstreamPanesLiveError extends Error {
  override readonly name = "WorkstreamPanesLiveError";
  constructor(
    public readonly workstream: string,
    public readonly agents: readonly string[],
  ) {
    super(say("workstream.panes_live", workstream, agents));
  }
}

/** `workstream init --if` over a torn-down name found its mux session still
 *  alive: the old rows are not deleted while panes may run. Exit 4. */
export class WorkstreamSessionLiveError extends Error {
  override readonly name = "WorkstreamSessionLiveError";
  constructor(
    public readonly workstream: string,
    public readonly session: string,
  ) {
    super(say("workstream.session_live", workstream, session));
  }
}

/** Reject reserved names for the explicit `mu workstream init` path.
 *  `ensureWorkstream` (the auto-create-on-spawn path) deliberately does
 *  NOT call this — spawning into `scratch` must Just Work. A torn-down
 *  `scratch` is the exception: init is how the name comes back (a spawn
 *  into it is refused until then). */
export function assertWorkstreamInitable(name: string, db?: Db): void {
  if (!RESERVED_WORKSTREAM_NAMES.has(name)) return;
  if (db !== undefined && tornDownAtOf(db, name) !== null) return;
  throw new WorkstreamNameReservedError(name);
}

// ─── Revision ──────────────────────────────────────────────────────────

/**
 * The preview **revision** of a workstream: a number that changes whenever
 * anything a destructive verb would act on changes. It hashes the newest
 * op touching the workstream's keys (0 if none), and the machine-local
 * state ops cannot see: agent names + pane ids and registered worktree
 * paths. An agent spawned after the preview therefore invalidates `--if`.
 * Read only: safe for a preview.
 */
export function workstreamRevision(db: Db, name: string): number {
  const maxSeq = (
    db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM ops WHERE ${WORKSTREAM_OPS_WHERE}`)
      .get({ ws: name }) as { n: number }
  ).n;
  const agents = listAgentPanes(db, name).map((a) => `${a.name}@${a.paneId}`);
  const worktrees = listWorktrees(db, name)
    .map((w) => w.path)
    .sort();
  return crc32(`${maxSeq}\n${agents.join(",")}\n${worktrees.join(",")}`);
}

/** The revision of a sweep, from its members' revisions (name → revision):
 *  a member added, removed or changed since the preview changes it. */
export function sweepRevision(members: ReadonlyMap<string, number>): number {
  const parts = [...members]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, r]) => `${n}:${r}`);
  return crc32(parts.join("\n"));
}

/**
 * Ensure a row exists in the `workstreams` table for `name`. Idempotent;
 * INSERT OR IGNORE so concurrent callers race safely. Called by
 * `insertAgent` and `addTask` so callers don't need to remember to call
 * `mu init` before adding a task / spawning an agent (preserves the
 * spawn-without-init ergonomics now that agents.workstream and
 * tasks.workstream are real FKs into this table).
 *
 * Validates the name before inserting; throws `WorkstreamNameInvalidError`
 * for names tmux would silently mangle (containing '.' or ':') or that
 * exceed 32 chars / start with a non-letter.
 *
 * Returns true iff a row was actually inserted (vs. already present).
 */
export function ensureWorkstream(db: Db, name: string): boolean {
  assertValidWorkstreamName(name);
  return withOpContext(db, { intent: "workstream.init", group: "new" }, () =>
    ensureWorkstreamImpl(db, name),
  );
}

function ensureWorkstreamImpl(db: Db, name: string): boolean {
  const result = db
    .prepare(
      "INSERT INTO workstreams (name, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM workstreams WHERE name = ?)",
    )
    .run(name, new Date().toISOString(), name);
  const created = result.changes > 0;
  // No emitEvent: the workstreams INSERT fired the capture trigger
  // (intent='workstream.init', key=<name>).
  return created;
}

export interface WorkstreamSummary {
  /** The workstream's own name. */
  name: string;
  /** Mux session name, defaults to `mu-<name>`. */
  muxSession: string;
  /** True iff the mux session `<muxSession>` is alive right now. */
  muxAlive: boolean;
  /** Rows in `agents` for this workstream. */
  agentCount: number;
  /** Rows in `tasks` for this workstream. */
  taskCount: number;
  /** Rows in `task_notes` whose task is in this workstream. */
  noteCount: number;
  /** Rows in `task_edges` whose `from_task` is in this workstream. */
  edgeCount: number;
  /** Registered worktrees (`worktrees` rows) of this workstream. Surfaced so
   *  the teardown dry-run can warn about per-agent worktrees that need
   *  cleanup. */
  worktreeCount: number;
  /** True iff a row exists in the `workstreams` table itself. False
   *  for tmux-only `mu-*` sessions that mu never observed via
   *  `mu workstream init`. Surfaced so teardown can clean up bare
   *  registry rows (workstream row exists, no agents/tasks/etc.) —
   *  otherwise such rows are orphaned forever (the previous
   *  `nothingToDo` heuristic short-circuited on them). */
  registered: boolean;
}

export interface TeardownResult {
  /** True iff killing the mux session actually killed something. */
  killedMux: boolean;
  /** Number of machine-local `agents` rows deleted (their panes are gone). */
  deletedAgents: number;
  /** Rows KEPT because their recorded pane was alive (or could not be asked)
   *  after the kill: orphaned, in a torn-down workstream.
   *  `mu agent close <name> -w <ws>` removes one. */
  orphanedAgents: { name: string; paneId: string; reason: "alive" | "unknown" }[];
  /** Rows that STAY (the teardown is soft): tasks, and their notes and
   *  edges. Reported so the output says what a later `init --if` would
   *  hard-delete. */
  tasks: number;
  notes: number;
  edges: number;
  /** Worktrees left alone: teardown never removes one. Their registry rows
   *  stay; `mu agent close <agent> -w <ws>` applies the close rule to one. */
  keptWorktrees: { agent: string; path: string }[];
}

export interface WorkstreamOptions {
  workstream: string;
  /** Override the mux session name. Defaults to `mu-<workstream>`. */
  muxSession?: string;
}

export interface TeardownWorkstreamOptions extends WorkstreamOptions {
  /** The preview revision (`workstreamRevision`). Required: the guarantee
   *  is code, not a CLI convention. A mismatch throws
   *  `WorkstreamRevisionMismatchError` before anything is touched. */
  ifRevision: number;
}

/** One past **teardown**, reconstructed from the ops log. */
export interface TornDownWorkstream {
  /** The workstream's name. Not unique across the list: a name can be
   *  torn down, recreated and torn down again, and each is its own
   *  entry (the group id is the identity). */
  name: string;
  /** The teardown's op group (`mu log --group <group>`). */
  group: string;
  /** ISO timestamp of the teardown. */
  at: string;
  /** Rows the teardown removed, so the entry conveys what is at stake
   *  without a second query per row. */
  tasks: number;
  notes: number;
  edges: number;
  /** True when a LATER put recreated this workstream, i.e. the
   *  name was reused. Kept in the list rather than filtered out:
   *  silently hiding it would make the list disagree with `mu log`. */
  recreated: boolean;
  /** `soft`: the row is still here with `torn_down_at` set (its rows stay;
   *  counts are what is kept). `hard`: a pre-cut-over teardown found in the
   *  log (its rows were deleted; counts are what it removed). */
  kind: "soft" | "hard";
}

/**
 * Every **teardown**, newest first: the soft ones (rows with
 * `torn_down_at` set, the current kind) and, from history, the hard ones
 * a pre-cut-over build wrote (a `workstream` del op, intent
 * `workstream.teardown`: old teardowns stay final).
 *
 * The list exists so a teardown from last month is reachable (its op
 * group id feeds `mu log --group`) without hand-written SQL over `ops`.
 * Hard entries are read straight from the log rather than from a side
 * table: the log already holds them, and a projection would be one more
 * thing that can disagree with it.
 */
export function listTornDownWorkstreams(db: Db): TornDownWorkstream[] {
  const soft = (
    db
      .prepare(
        `SELECT w.name AS name, w.torn_down_at AS at,
                COALESCE((SELECT o.group_id FROM ops o
                           WHERE o.entity = 'workstream' AND o.key = w.name AND o.op = 'put'
                             AND o.intent = 'workstream.teardown'
                           ORDER BY o.hlc DESC LIMIT 1), '') AS "group"
           FROM workstreams w
          WHERE w.torn_down_at IS NOT NULL`,
      )
      .all() as { name: string; at: string; group: string }[]
  ).map(
    (r): TornDownWorkstream => ({
      name: r.name,
      group: r.group,
      at: r.at,
      tasks: countTasks(db, r.name),
      notes: countNotes(db, r.name),
      edges: countEdges(db, r.name),
      recreated: false,
      kind: "soft",
    }),
  );
  const hard = db
    .prepare(
      `SELECT o.key                AS name,
              o.group_id           AS "group",
              o.created_at         AS at,
              (SELECT COUNT(*) FROM ops t
                WHERE t.group_id = o.group_id AND t.entity = 'task'  AND t.op = 'del') AS tasks,
              (SELECT COUNT(*) FROM ops n
                WHERE n.group_id = o.group_id AND n.entity = 'note'  AND n.op = 'del') AS notes,
              (SELECT COUNT(*) FROM ops e
                WHERE e.group_id = o.group_id AND e.entity = 'edge'  AND e.op = 'del') AS edges,
              EXISTS (SELECT 1 FROM ops p
                       WHERE p.entity = 'workstream' AND p.key = o.key
                         AND p.op = 'put' AND p.hlc > o.hlc)                           AS recreated
         FROM ops o
        WHERE o.entity = 'workstream'
          AND o.op     = 'del'
          AND o.intent = 'workstream.teardown'`,
    )
    .all()
    .map((r): TornDownWorkstream => {
      const row = r as Omit<TornDownWorkstream, "recreated" | "kind"> & { recreated: number };
      return { ...row, recreated: row.recreated === 1, kind: "hard" };
    });
  return [...soft, ...hard].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * Discover every registered workstream: the rows in the `workstreams`
 * table (canonical DB source; populated by `mu init` and auto-created by
 * insertAgent / addTask), each decorated with mux liveness. A `mu-*` mux
 * session with no row is not discovered: the DB owns the workstream list.
 *
 * Returns one `WorkstreamSummary` per workstream, sorted by name.
 */
export async function listWorkstreams(db: Db): Promise<WorkstreamSummary[]> {
  const names = (
    db.prepare("SELECT name FROM workstreams WHERE torn_down_at IS NULL ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  return Promise.all(names.map((name) => summarize(db, { workstream: name })));
}

/**
 * Discover every REGISTERED workstream that has no user-meaningful
 * state attached: a row in `workstreams` with zero tasks, zero
 * agents, zero worktrees. Mux session presence and agent_logs
 * entries do NOT disqualify — the session itself was created at
 * init time and contains no agent panes; the events are audit, not
 * state.
 *
 * Unregistered `mu-*` mux sessions (no `workstreams` row) are never
 * seen: the sweep iterates DB rows only. "No DB row" only means THIS
 * DB does not know the session: a run against a throwaway `MU_DB_PATH`
 * sees every real workstream as unregistered, and sweeping them killed
 * a live crew's agent panes. An explicit
 * `mu workstream teardown <name>` still tears one down by name.
 *
 * The `scratch` workstream is NEVER returned: its idle session is kept
 * alive on purpose (see mux.ensureSession), so the next delegate
 * does not pay for creating it. `mu workstream teardown scratch`
 * still tears it down.
 *
 * Used by `mu workstream teardown --empty` to sweep empty
 * workstreams in one command (instead of the per-name jq incantation
 * over `mu workstream list --json`). Returns one `WorkstreamSummary`
 * per match, sorted by name.
 */
export async function listEmptyWorkstreams(db: Db): Promise<WorkstreamSummary[]> {
  const registeredRows = db
    .prepare(
      `SELECT ws.name AS name
         FROM workstreams ws
         LEFT JOIN tasks          t  ON t.workstream_id  = ws.id
         LEFT JOIN agents         a  ON a.workstream_id  = ws.id
         LEFT JOIN worktrees      v  ON v.workstream      = ws.name
        WHERE ws.torn_down_at IS NULL
        GROUP BY ws.id, ws.name
       HAVING COUNT(DISTINCT t.id)  = 0
          AND COUNT(DISTINCT a.id)  = 0
          AND COUNT(DISTINCT v.path) = 0
        ORDER BY ws.name`,
    )
    .all() as { name: string }[];
  return Promise.all(
    registeredRows
      .filter((r) => !isScratchWorkstream(r.name))
      .map((r) => summarizeWorkstream(db, { workstream: r.name })),
  );
}

export async function summarizeWorkstream(
  db: Db,
  opts: WorkstreamOptions,
): Promise<WorkstreamSummary> {
  return summarize(db, opts);
}

async function summarize(db: Db, opts: WorkstreamOptions): Promise<WorkstreamSummary> {
  const muxSession = opts.muxSession ?? `mu-${opts.workstream}`;
  return {
    name: opts.workstream,
    muxSession,
    muxAlive: await sessionAlive(muxSession),
    agentCount: countAgents(db, opts.workstream),
    taskCount: countTasks(db, opts.workstream),
    noteCount: countNotes(db, opts.workstream),
    edgeCount: countEdges(db, opts.workstream),
    worktreeCount: listWorktrees(db, opts.workstream).length,
    registered: isRegistered(db, opts.workstream),
  };
}

function isRegistered(db: Db, workstream: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM workstreams WHERE name = ? AND torn_down_at IS NULL")
    .get(workstream) as { x: number } | undefined;
  return row !== undefined;
}

/**
 * Tear down a workstream (soft): kill its mux session, delete its
 * machine-local agent rows and set `torn_down_at`. Worktrees are never
 * removed. Tasks, edges and notes STAY (a later `init --if` is what
 * hard-deletes them, after a preview). Needs the preview revision.
 *
 * ORDER IS THE GUARANTEE. Nothing is written before the session is known
 * dead: the revision check reads only; the mux probe PROPAGATES ("could
 * not ask" is not "dead"); a registered pane outside the session is asked
 * about by id and blocks the teardown while it lives; the kill comes before
 * any DB change; the DB commit is last, one op group. A failure at any step
 * leaves the workstream live and the command re-runnable.
 *
 * Idempotent: an unknown or already-torn-down name has nothing to do.
 */
export async function teardownWorkstream(
  db: Db,
  opts: TeardownWorkstreamOptions,
): Promise<TeardownResult> {
  const muxSession = opts.muxSession ?? `mu-${opts.workstream}`;

  const revision = workstreamRevision(db, opts.workstream);
  if (revision !== opts.ifRevision) {
    throw new WorkstreamRevisionMismatchError(opts.workstream, opts.ifRevision, revision);
  }

  const agentsBefore = listAgentPanes(db, opts.workstream);
  const tasksBefore = countTasks(db, opts.workstream);
  const notesBefore = countNotes(db, opts.workstream);
  const edgesBefore = countEdges(db, opts.workstream);
  const worktreesBefore = listWorktrees(db, opts.workstream);

  // Mux session first: if killSession throws we don't want any DB state
  // changed with panes still running. (killSession is itself idempotent
  // on missing sessions — a real throw here is an unexpected mux error.)
  // Load-bearing: teardown must actually kill the session, not silently
  // report success while leaving panes running.
  const mux = await activeMux();
  // The probe PROPAGATES: "could not ask" is not "dead". Swallowing it
  // here would change DB state while panes may still run.
  const sessionPanes = new Set((await mux.listPanes(muxSession)).map((p) => p.paneId));
  // The session kill covers the panes in it. A registered pane that is NOT
  // in it (moved to another session by hand) survives the kill, so it is
  // asked about by its own id; failing to ask propagates too.
  const strays: string[] = [];
  for (const a of agentsBefore) {
    if (sessionPanes.has(a.paneId)) continue;
    if (await mux.paneAlive(a.paneId)) strays.push(a.name);
  }
  if (strays.length > 0) throw new WorkstreamPanesLiveError(opts.workstream, strays);
  const muxAliveBefore = sessionPanes.size > 0;
  if (muxAliveBefore) {
    await mux.killSession(muxSession);
  }

  // Worktrees are NOT touched: teardown never removes one (the registry's
  // close rule belongs to `mu agent close`). They stay registered and on
  // disk; the result lists them.

  // THE ROW RULE: a row is deleted only when its recorded pane is known
  // dead, asked by pane id AFTER the kill (a pane moved out of the session
  // while it was being killed survives it), and nothing is unlinked or
  // deleted for a row before that answer. Alive or unknown keeps the row
  // (orphaned: it lives in a torn-down workstream) and the result says so.
  // A dead pane stays dead (tmux never reuses an id), so the answer holds
  // through the transaction below.
  const dead: { name: string; paneId: string; incarnation: number }[] = [];
  const orphaned: TeardownResult["orphanedAgents"] = [];
  for (const a of agentsBefore) {
    let reason: "alive" | "unknown" | undefined;
    try {
      if (await mux.paneAlive(a.paneId)) reason = "alive";
    } catch {
      reason = "unknown";
    }
    if (reason === undefined) dead.push(a);
    else orphaned.push({ name: a.name, paneId: a.paneId, reason });
  }

  // Unlink each DEAD agent's control socket (ssh -L forwards leave theirs
  // behind) BEFORE the DELETE: the agent rows are how a retry finds the
  // sockets, so an interrupted unlink must leave them in place. Then reap
  // sock/<ws>/ only if empty, never recursively: hashed long paths
  // share sock/h/ across workstreams, so a workstream named "h" must
  // not take the others' sockets with it. A kept row keeps its socket.
  // Only for the incarnation that was asked about: a replacement registered
  // since owns the socket path now (its transaction check below then aborts).
  const sameRow = db.prepare(
    `SELECT 1 FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id
      WHERE a.id = ? AND a.name = ? AND a.pane_id = ? AND ws.name = ?`,
  );
  for (const a of dead) {
    if (sameRow.get(a.incarnation, a.name, a.paneId, opts.workstream) !== undefined)
      unlinkCtlSocket(db, a.name, opts.workstream);
  }
  if (!db.memory) {
    const sockDir = join(dirname(db.name), "sock", opts.workstream);
    try {
      if (readdirSync(sockDir).length === 0) rmdirSync(sockDir);
    } catch {
      // Missing or non-empty: nothing of ours left to reap.
    }
  }

  // The DB commit, last, in ONE op group (intent workstream.teardown):
  // delete the dead agents' rows, then set torn_down_at (one captured
  // put). Nothing cascades from either: tasks, edges and notes stay. The
  // whole revision is read again INSIDE the transaction: an op, agent or
  // worktree that appeared since the preview (a sweep member changed while
  // an earlier one was being killed, a racing spawn) aborts the commit
  // instead of being swept up unseen.
  const tornDownAt = new Date().toISOString();
  withOpContext(db, { intent: "workstream.teardown", group: "new" }, () =>
    db
      .transaction(() => {
        const now = workstreamRevision(db, opts.workstream);
        if (now !== opts.ifRevision) {
          throw new WorkstreamRevisionMismatchError(opts.workstream, opts.ifRevision, now);
        }
        // Each dead row goes through THE reaper step (src/agents/reap.ts), in
        // this transaction and group: its remote worktree is recorded and
        // what it owned reopens, exactly as a pane that died on its own.
        for (const a of dead) {
          if (!sameRow.get(a.incarnation, a.name, a.paneId, opts.workstream)) continue;
          reapAgentRow(db, a.incarnation, a.name);
        }
        db.prepare(
          "UPDATE workstreams SET torn_down_at = ? WHERE name = ? AND torn_down_at IS NULL",
        ).run(tornDownAt, opts.workstream);
      })
      .immediate(),
  );
  // No emitEvent: the UPDATE fired the capture trigger (op='put',
  // intent='workstream.teardown', payload {torn_down_at}).

  return {
    killedMux: muxAliveBefore,
    deletedAgents: dead.length,
    orphanedAgents: orphaned,
    tasks: tasksBefore,
    notes: notesBefore,
    edges: edgesBefore,
    keptWorktrees: worktreesBefore.map((w) => ({ agent: w.agent, path: w.path })),
  };
}

/** What `workstream init` would permanently delete when the name is torn
 *  down, or null when it is live or unknown. */
export interface ReinitPreview {
  tornDownAt: string;
  tasks: number;
  notes: number;
  edges: number;
  revision: number;
}

export function previewReinit(db: Db, name: string): ReinitPreview | null {
  const tornDownAt = tornDownAtOf(db, name);
  if (tornDownAt === null) return null;
  return {
    tornDownAt,
    tasks: countTasks(db, name),
    notes: countNotes(db, name),
    edges: countEdges(db, name),
    revision: workstreamRevision(db, name),
  };
}

/**
 * Reuse a torn-down name: hard-delete the old row (the FK cascade removes
 * its tasks, edges and notes, each captured as today's tombstones) and
 * create the new one, in ONE op group (intent workstream.init). Needs the
 * preview revision. Refuses while the old mux session is alive (the probe
 * runs first and propagates) or while this machine still has agent rows in
 * the old workstream: a peer's teardown can reach a machine whose panes live.
 */
export async function reinitWorkstream(
  db: Db,
  name: string,
  ifRevision: number,
  muxSession = `mu-${name}`,
): Promise<void> {
  assertValidWorkstreamName(name);
  // The mux is asked FIRST and the probe propagates: "could not ask" is not
  // "dead", and nothing is deleted while panes may run (the teardown rule).
  if (tornDownAtOf(db, name) !== null) {
    if ((await (await activeMux()).listPanes(muxSession)).length > 0) {
      throw new WorkstreamSessionLiveError(name, muxSession);
    }
  }
  withOpContext(db, { intent: "workstream.init", group: "new" }, () =>
    db
      .transaction(() => {
        if (tornDownAtOf(db, name) === null) return;
        const revision = workstreamRevision(db, name);
        if (revision !== ifRevision) {
          throw new WorkstreamRevisionMismatchError(
            name,
            ifRevision,
            revision,
            `mu workstream init ${name}`,
          );
        }
        const agents = listAgentPanes(db, name).map((a) => a.name);
        if (agents.length > 0) throw new WorkstreamHasAgentsError(name, agents);
        // No agent row is left to cascade (checked above, same transaction):
        // the delete of each row recorded its remote worktree.
        db.prepare("DELETE FROM workstreams WHERE name = ?").run(name);
        ensureWorkstreamImpl(db, name);
      })
      .immediate(),
  );
}

// ─── Counts ────────────────────────────────────────────────────────────

function listAgentPanes(
  db: Db,
  workstream: string,
): { name: string; paneId: string; incarnation: number }[] {
  const rows = db
    .prepare(
      `SELECT a.name, a.pane_id AS paneId, a.id AS incarnation FROM agents a
         JOIN workstreams ws ON ws.id = a.workstream_id
        WHERE ws.name = ?
        ORDER BY a.name, a.pane_id`,
    )
    .all(workstream) as { name: string; paneId: string; incarnation: number }[];
  return rows;
}

function countAgents(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agents a
         JOIN workstreams ws ON ws.id = a.workstream_id
        WHERE ws.name = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}

function countTasks(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE ws.name = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}

function countNotes(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM task_notes n
         JOIN tasks      t  ON t.id = n.task_id
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE ws.name = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}

function countEdges(db: Db, workstream: string): number {
  // Count edges whose blocker (from_task) is in the workstream. Since
  // cross-workstream edges are forbidden by addTask, this equals the
  // edge count for the workstream subgraph.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM task_edges e
         JOIN tasks      t  ON t.id = e.from_task_id
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE ws.name = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}
