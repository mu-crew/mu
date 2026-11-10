// mu — the schema itself: the version stamps, the DDL (CURRENT_SCHEMA and
// the view SQL), the columns added to v13-era tables in place
// (ADDED_COLUMNS), and the table and entity classification (EXPECTED_TABLES,
// PORTABLE_TABLES, MACHINE_LOCAL_TABLES, SYNCED_ENTITIES). Data only: db.ts
// owns the connection, the upgrade and the refusals, and re-exports the
// public names, so callers keep importing them from db.ts. No runtime import
// back into db.ts.

import { CARRIER_JOBS_DDL } from "./db-carrier.js";
import { CHECKS_DDL } from "./db-checks.js";
import { SPAWN_RECEIPTS_DDL } from "./db-receipts.js";
import { REMOTE_RECOVERY_DDL } from "./db-recovery.js";

/** The task kinds (`tasks.kind`): `work` is the default, `delegate` a
 *  task-backed delegate call, `human` one only a person can close. Synced
 *  per field; a value this build does not know is dropped by the fold, so
 *  a newer peer's kind never trips the CHECK during ingest. */
export const TASK_KINDS = ["work", "delegate", "human"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

const sqlList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(", ");
const TASK_KIND_DDL = `TEXT NOT NULL DEFAULT 'work' CHECK (kind IN (${sqlList(TASK_KINDS)}))`;

/** The states of a delegate call (`delegate_calls.state`). */
export const DELEGATE_CALL_STATES = [
  "queued",
  "starting",
  "running",
  "recording",
  "done",
  "failed",
  "refused",
  "cancelled",
] as const;

/** The states of a stall action (`wait_action_receipts.state`). */
export const WAIT_ACTION_STATES = [
  "reserved",
  "sending",
  "sent",
  "unknown",
  "refused",
  "released",
] as const;
export type WaitActionState = (typeof WAIT_ACTION_STATES)[number];

/** The stall actions a wait may take (`wait_action_receipts.action`). */
export const WAIT_ACTIONS = ["steer", "release"] as const;
export type WaitAction = (typeof WAIT_ACTIONS)[number];

/**
 * Columns added to a table after a v13 DB may already exist, as
 * `[table, column, DDL]`. `CREATE TABLE IF NOT EXISTS` leaves an existing
 * table alone, so applySchema adds each missing one with `ALTER TABLE ADD
 * COLUMN` (idempotent, inside the schema transaction), and schemaIsCurrent
 * reports a DB without one as not current. The DDL must stay a plain
 * nullable/defaulted column: SQLite adds nothing else in place.
 */
export const ADDED_COLUMNS: readonly (readonly [table: string, column: string, ddl: string])[] = [
  ["agents", "command", "TEXT"],
  ["agents", "command_source", "TEXT"],
  // Schema 13: the loop's storage. kind/wave are portable (synced);
  // spawner/host/collected_head are machine-local agent metadata.
  ["tasks", "kind", TASK_KIND_DDL],
  ["tasks", "wave", "TEXT"],
  ["agents", "spawner", "TEXT"],
  ["agents", "host", "TEXT"],
  ["agents", "collected_head", "TEXT"],
  // The remote command gate's spawn-unique token (machine-local): its marker and result key.
  ["agents", "gate_token", "TEXT"],
  // A remote worktree's repo, chosen per spawn (a host profile names a machine).
  ["agents", "repo", "TEXT"],
  ["wait_registrations", "baselines_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["task_auto", "enabled", "INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))"],
  ...["request", "verdict", "agent"].map((c) => ["delegate_calls", c, "TEXT"] as const),
  // The template's process group, recorded before it runs (hosts.ts).
  ["host_channels", "pgid", "INTEGER"],
  ["host_channels", "pgid_start", "TEXT"],
  // A host profile's transport ('session' | 'lease', validated in addHost: SQLite adds no CHECK
  // in place) and a lease profile's stop template (hosts.ts).
  ["host_profiles", "transport", "TEXT NOT NULL DEFAULT 'session'"],
  ["host_profiles", "stop", "TEXT"],
  // A lease profile's attach template: a new carrier for a job that still runs (hosts.ts).
  ["host_profiles", "attach", "TEXT"],
  // The transport of the profile a remote agent was spawned on ('session' | 'lease'): a close
  // decides lease-ness from the row, never from the profile as it is now.
  ["agents", "host_transport", "TEXT"],
  // The channel a pane agent is reached through ('ctl' | 'hooks' | 'mux', machine-local), recorded at
  // spawn: every verb reads it from the row, never from the env (src/channels).
  ["agents", "channel", "TEXT"],
  // A remote hook-harness worker's key on its node, `<origin host>/<pane key>` (spec D11, machine-local):
  // `murmur pane --remote <key>` reads its state there.
  ["agents", "remote_key", "TEXT"],
  // A lease reservation's remote worktree (src/carrier-jobs.ts): which tree it belongs to.
  ["carrier_jobs", "tree_path", "TEXT"],
  ["carrier_jobs", "tree_agent_id", "INTEGER"],
  // The workstream generation the reservation was bound in (src/carrier-jobs.ts).
  ["carrier_jobs", "workstream_id", "INTEGER"],
  // The last `host check` harness probe and its time, JSON (spec D17; src/host-harnesses.ts).
  ["host_profiles", "capabilities", "TEXT"],
  // Plugins spec D4: an agent's delivery high-water mark (src/effects.ts).
  ["agents", "delivery_seq", "INTEGER NOT NULL DEFAULT 0"],
  // Plugins spec D9: a plugin channel's plugin; with `channel`, the channel's identity.
  ["agents", "channel_plugin", "TEXT"],
  // Plugins spec D5: a job record's kind, plugin and fences, its tree's base, the final-collect
  // columns (D10) and an `at-start` kind's first-delivery receipt (D8).
  ...(
    [
      ["kind", "TEXT"],
      ["plugin", "TEXT"],
      ["instance", "TEXT"],
      ["host_id", "INTEGER"],
      ["tree_base", "TEXT"],
      ["collect_repo", "TEXT"],
      ["final_owed", "INTEGER NOT NULL DEFAULT 0"],
      ["stop_gen", "INTEGER"],
      ["collect_next_at", "INTEGER"],
      ["first_msg_id", "TEXT"],
      ["first_inc", "TEXT"],
      // P6d: the in-life collect's current backoff, doubled per failure (D10).
      ["collect_delay_ms", "INTEGER"],
    ] as const
  ).map(([c, ddl]) => ["carrier_jobs", c, ddl] as const),
  // Plugins spec D5: the host identity a recovery pins (src/db-recovery.ts); backfilled from
  // host_exec when added.
  ["remote_recovery", "host_identity", "TEXT"],
];

/** The schema version a fresh DB starts at. v12 adds the kernel columns
 *  (torn_down_at, cwd, base, scored, dispatch_host, kind), task_auto and
 *  the blockers view on top of v11's task substates; v13 adds the loop's
 *  storage (tasks.kind/wave, agents.spawner/host/collected_head and four
 *  machine-local tables); v14 is mu 5's (spec D5). See CHANGELOG.md. */
export const CURRENT_SCHEMA_VERSION = 14;

/** mu 4's schema: the state import's source (src/state-import.ts). */
export const V13 = 13;

/** The lowest schema version `openDb` will accept. There is no ladder:
 *  anything older throws `SchemaTooOldError` (exit 4) and is left
 *  untouched on disk. */
export const MIN_ACCEPTED_SCHEMA_VERSION = 14;

/** The note kinds (`task_notes.kind`). Set once at INSERT, never changed:
 *  a local UPDATE of it raises, and a peer's update cannot match a row. */
export const NOTE_KINDS = ["brief", "report", "verdict", "close", "note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Impact and effort a task gets when its creator gave neither (and the
 *  SQL DEFAULTs of `tasks.impact` / `tasks.effort_days`). Such a task is
 *  unscored (`tasks.scored = 0`). */
export const DEFAULT_IMPACT = 50;
export const DEFAULT_EFFORT_DAYS = 1;

/** Tables a healthy DB must contain. Single source of truth so
 *  `mu doctor` and any other consumer don't drift. Adding a new table
 *  = one new entry here AND a CREATE TABLE in CURRENT_SCHEMA, plus a
 *  CURRENT_SCHEMA_VERSION bump (sync_fingerprints went in without one:
 *  additive, and an older mu ignores it; nor did keep_driving or checks). Sorted; exactly 32 entries. */
export const EXPECTED_TABLES: readonly string[] = [
  "agent_settles",
  "agents",
  "carrier_jobs",
  "checks",
  "delegate_calls",
  "effects",
  "host_channels",
  "host_profiles",
  "hosts",
  "human_needs",
  "keep_driving",
  "machine_identity",
  "op_ctx",
  "op_dying",
  "ops",
  "plugins",
  "remote_recovery",
  "schema_version",
  "spawn_receipts",
  "sync_fingerprints",
  "sync_peers",
  "task_auto",
  "task_edges",
  "task_notes",
  "task_substates",
  "tasks",
  "wait_action_receipts",
  "wait_cursors",
  "wait_registrations",
  "wait_resumes",
  "workstreams",
  "worktrees",
];

// ─── Syncability — which state crosses machines ───────────────────────
//
// Whether an op syncs is a STATIC function of its entity, so it lives
// here as a constant rather than as a `local` column on `ops`. A
// per-row decision is a per-row opportunity to get it wrong, and it
// would cost a column plus a branch at every write site. Downstream
// sync code READS these; it does not re-decide.
//
// Vocabulary (docs/VOCABULARY.md § portable): **portable** tables are
// syncable across machines; **machine-local** tables never leave the
// box. Machine-local ops are still RECORDED — `mu log` and the TUI
// Recent card still show agent spawn/close — they simply never ship.
// "Not synced" is not "not logged".

/** Op entities that cross machines. Everything else is machine-local.
 *  Readonly tuple (not `string[]`) so `SyncedEntity` is a real union
 *  and downstream code gets compile-time checking, not raw strings. */
export const SYNCED_ENTITIES = ["workstream", "task", "edge", "note", "message", "check"] as const;

/** One of the op entities that sync. Derived from the tuple, so
 *  adding an entity is a one-line change with no type to keep in step. */
export type SyncedEntity = (typeof SYNCED_ENTITIES)[number];

/** Op entities this build KNOWS are machine-local: their payloads name
 *  a pane id or an absolute path, so a peer sending one is a real bug
 *  and `applyOp` rejects it loudly.
 *
 *  WHY THIS LIST EXISTS SEPARATELY FROM "not in SYNCED_ENTITIES"
 *  ------------------------------------------------------------
 *  "Unknown" and "known-local" are different failures and were
 *  conflated, which wedged a real fleet. A peer running a LATER (or
 *  earlier) mu wrote `entity:"marker"` ops — legal on the writer, whose
 *  SYNCED_ENTITIES included it. The reader treated every non-synced
 *  entity as a bad peer, so `ingestSegment` recorded a defect and
 *  stopped at that line FOREVER: 87% of a 20,305-line segment never
 *  applied, and `mu sync --repair` (which only resets the watermark)
 *  marched straight back into the same wall.
 *
 *  So the rule is asymmetric on purpose: an entity we know must never
 *  travel is a defect; an entity we simply do not recognise is tolerated
 *  forward-compatibly — recorded in `ops`, projected nowhere, exactly
 *  like 'message'. Reader vocabulary may lag writer vocabulary; that is
 *  a fact of a mixed fleet, not a corruption. */
export const MACHINE_LOCAL_ENTITIES = [
  "agent",
  "workspace",
  "event",
  "broadcast",
  // A provider host's events (plugins spec D1): acquired, released, abandoned.
  "host",
] as const;

export type MachineLocalEntity = (typeof MACHINE_LOCAL_ENTITIES)[number];

/** **Portable** tables: their rows mean the same thing on any machine,
 *  so their ops ship. Mirrors docs/VOCABULARY.md § portable exactly. */
export const PORTABLE_TABLES = [
  "checks",
  "task_edges",
  "task_notes",
  "tasks",
  "workstreams",
] as const;

export type PortableTable = (typeof PORTABLE_TABLES)[number];

/** **Machine-local** tables. Never bulk-copied to a peer, because a
 *  row's meaning does not survive the trip:
 *
 *    agents           holds `pane_id` ('%17') — meaningless elsewhere.
 *    worktrees        holds absolute paths — /home/... vs /Users/...
 *                     on a mixed macOS/Linux fleet.
 *    machine_identity IS the per-machine identity.
 *    op_ctx           the capture context row; defaults at rest.
 *    op_dying         capture's delete-key stash; empty at rest.
 *    schema_version   local bookkeeping.
 *    sync_peers       local bookkeeping (per-peer watermarks).
 *    sync_fingerprints local cache of what the last clean ingest saw.
 *    task_substates   seeded identically on every machine from
 *                     TASK_SUBSTATE_ROWS; code, not data.
 *    task_auto        per-task auto-dispatch state (cli, runs, last
 *                     spawn): about THIS machine's agents.
 *    delegate_calls   one row per task-backed delegate call: the caller,
 *                     call_id and pane-side state of THIS machine.
 *    wait_cursors     per caller and ref, the last wait result consumed.
 *    wait_registrations per caller, the refs a wait still owes it, and
 *                     whether one is in flight (generation CAS), plus the
 *                     unconsumed run baselines of its agent refs.
    human_needs      which caller recorded a `human` task (`mu human-needed`).
                     Rebuild cannot restore it (UNREBUILDABLE_TABLES).
 *    keep_driving     per harness session, the Stop hook's consecutive empty
 *                     blocks and whether its close nudge fired (src/hook-stop.ts).
 *    agent_settles    settled runs already applied (settle replay).
 *    host_profiles    ssh-free command templates per remote host.
 *    plugins          the user's registered plugins: argv and declared seams (spec D14).
 *                     Rebuild cannot restore it (UNREBUILDABLE_TABLES).
 *    effects          every unresolved plugin effect: its key, exact request, instance,
 *                     creator and resolver (plugins spec D4, src/effects.ts). Rebuild loses it.
 *    host_channels    the connection slots a host's `max_sessions` counts:
 *                     one row per live holder (invocation pid or agent pane).
 *    wait_resumes     one row per `mu wait` result that left something owed:
 *                     the full condition set behind `mu wait --resume <id>`.
 *    wait_action_receipts one row per stall action a wait took on a task
 *                     (task id, owner registry id, ctl incarnation, action):
 *                     the exclusion that keeps a nudge to ONE and the record
 *                     of a release. No FK: it must outlive the task and agent.
 *    spawn_receipts   one row per task-bound spawn attempt: the replay and
 *                     crash-recovery journal (reservation, pane identity,
 *                     claim, send state). No FK to `agents`: it must
 *                     outlive the agent it names.
 *    remote_recovery  a deleted remote worker row's worktree, written by
 *                     triggers (src/db-recovery.ts). No FK; rebuild loses it.
 *    carrier_jobs     a lease spawn's name-exclusive reservation of its remote
 *                     job: spawn token, launch state, pane, incarnation, the
 *                     handle and the admitted stop template (src/carrier-jobs.ts).
 *                     No FK, trigger or op: released only after a stop and
 *                     cleanup, a never-launched rollback, or `--abandon-job`;
 *                     rebuild loses it.
 *    ops              see below — the carrier, not cargo.
 *
 *  `ops` is listed here deliberately rather than omitted. It is not
 *  **portable** in the copy-the-table sense: the table is never
 *  wholesale-copied. Individual op ROWS ship, one at a time, filtered
 *  by SYNCED_ENTITIES and carried by per-machine **segments** — and
 *  `seq` is a local-only append cursor that means nothing on a peer.
 *  So for the only question this list answers — "is this table's
 *  content copied across machines?" — the answer for `ops` is no.
 *
 *  Consequence that falls out with no special case: `tasks.owner_id`
 *  is an FK into `agents`, and `agents` is machine-local. Therefore
 *  OWNERSHIP DOES NOT SYNC. The deleted db-sync.ts reached the same
 *  conclusion via an `includeOwners` flag; here it is structural. */
export const MACHINE_LOCAL_TABLES = [
  "agent_settles",
  "agents",
  "carrier_jobs",
  "delegate_calls",
  "effects",
  "host_channels",
  "host_profiles",
  "hosts",
  "human_needs",
  "keep_driving",
  "machine_identity",
  "op_ctx",
  "op_dying",
  "ops",
  "plugins",
  "remote_recovery",
  "schema_version",
  "spawn_receipts",
  "sync_fingerprints",
  "sync_peers",
  "task_auto",
  "task_substates",
  "wait_action_receipts",
  "wait_cursors",
  "wait_registrations",
  "wait_resumes",
  "worktrees",
] as const;

export type MachineLocalTable = (typeof MACHINE_LOCAL_TABLES)[number];

// ─── View DDL — single source of truth ────────────────────────────────
//
// The three views (ready, blocked, goals) get DROPped + CREATEd by
// applySchema whenever openDb finds them missing or different from
// these definitions (schemaIsCurrent). Each constant is self-contained:
// DROP IF EXISTS + CREATE. Running DROP twice in a row is harmless,
// so callers that already DROP up-front can still re-execute these
// without churn.
//
// Exported as named constants so consumers can reference the canonical
// shape (e.g. one-shot migration scripts under scripts/) without
// duplicating SQL.

export const READY_VIEW_SQL = `
DROP VIEW IF EXISTS ready;
CREATE VIEW ready AS
  SELECT t.*
    FROM tasks t
    JOIN workstreams w ON w.id = t.workstream_id AND w.torn_down_at IS NULL
   WHERE t.status = 'OPEN'
     AND t.substate NOT IN ('parked', 'triage')
     AND NOT EXISTS (
       SELECT 1
         FROM task_edges e
         JOIN tasks      b ON e.from_task_id = b.id
        WHERE e.to_task_id = t.id
          AND b.status <> 'CLOSED'
     );
`;

export const BLOCKED_VIEW_SQL = `
DROP VIEW IF EXISTS blocked;
CREATE VIEW blocked AS
  SELECT t.*
    FROM tasks t
    JOIN workstreams w ON w.id = t.workstream_id AND w.torn_down_at IS NULL
   WHERE t.status = 'OPEN'
     AND EXISTS (
       SELECT 1
         FROM task_edges e
         JOIN tasks      b ON e.from_task_id = b.id
        WHERE e.to_task_id = t.id
          AND b.status <> 'CLOSED'
     );
`;

// The direct OPEN blockers of each task: one row per (task, blocker) edge
// whose blocker is not CLOSED. `ready` is the tasks with no row here;
// `blocked` the OPEN tasks with one.
export const BLOCKERS_VIEW_SQL = `
DROP VIEW IF EXISTS blockers;
CREATE VIEW blockers AS
  SELECT e.to_task_id  AS task_id,
         t.local_id    AS task_local_id,
         b.id          AS blocker_id,
         b.local_id    AS blocker_local_id,
         b.status      AS blocker_status
    FROM task_edges e
    JOIN tasks      b ON b.id = e.from_task_id
    JOIN tasks      t ON t.id = e.to_task_id
    JOIN workstreams w ON w.id = t.workstream_id AND w.torn_down_at IS NULL
   WHERE b.status <> 'CLOSED';
`;

// A goal is an active endpoint of the DAG — a task with no dependents
// that we're still working toward. CLOSED is excluded: a finished
// leaf is not an active goal. Parked tasks STAY goals: tracks are
// built from goals, and a parked track is still a track.
export const GOALS_VIEW_SQL = `
DROP VIEW IF EXISTS goals;
CREATE VIEW goals AS
  SELECT t.*
    FROM tasks t
    JOIN workstreams w ON w.id = t.workstream_id AND w.torn_down_at IS NULL
   WHERE t.status <> 'CLOSED'
     AND NOT EXISTS (
       SELECT 1 FROM task_edges WHERE from_task_id = t.id
     );
`;

// ─── SCHEMA (v14) ───────────────────────────────────────────────────────
//
// Per docs/architecture/sdk.md § Surrogate-PK and SDK-boundary discipline.
// Every entity table has:
//   - INTEGER PRIMARY KEY AUTOINCREMENT (surrogate identity)
//   - <scope>_id INTEGER NOT NULL REFERENCES <parent>(id) ON DELETE CASCADE
//   - <name>     TEXT  NOT NULL  (operator-facing, immutable once written)
//   - UNIQUE (<scope>_id, <name>)
//
// Foreign keys are INTEGER. The natural keys (`workstreams.name`,
// `tasks.local_id`) are immutable: the capture KEY_COLUMNS guard refuses
// an UPDATE of them (src/capture.ts), because ops address rows by them. `ops` is the
// documented exception: it has NO foreign keys at all and addresses
// rows by their NATURAL key, because ops outlive the rows (and the
// workstreams) they record.

export const CURRENT_SCHEMA = `
-- ─── Schema versioning ────────────────────────────────────────────────
--
-- Single-row table: the schema version this DB is at (stamped by upgradeSchema).
--
-- capture_version stamps the revision of the capture triggers stored in
-- this file (CAPTURE_VERSION, src/capture.ts). It is separate from
-- "version" on purpose: "version" means tables/columns are
-- incompatible, and openDb refuses an older DB outright, while an older
-- capture revision is upgraded in place (installCapture replaces every
-- trigger and the stamp in one transaction). A DB created before the
-- column existed gets it from installCapture's ALTER (DEFAULT 0).
CREATE TABLE IF NOT EXISTS schema_version (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  version         INTEGER NOT NULL,
  capture_version INTEGER NOT NULL DEFAULT 0
);

-- op_ctx: the op context the capture triggers read (src/capture.ts, the
-- header; src/op-context.ts). One row (seeded by installCapture), written
-- only by the context wrappers inside a transaction they own, so at rest
-- it always holds the defaults. now_ms is the trigger scratchpad for one
-- HLC tick.
CREATE TABLE IF NOT EXISTS op_ctx (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  group_id TEXT,
  actor    TEXT,
  intent   TEXT,
  applying INTEGER NOT NULL DEFAULT 0,
  now_ms   INTEGER NOT NULL DEFAULT 0
);

-- op_dying: natural keys of workstream/task rows mid-DELETE, so cascaded
-- children can still resolve their keys (see src/capture.ts, THE DELETE
-- SUBTLETY). Empty at rest: an AFTER DELETE trigger removes each entry.
CREATE TABLE IF NOT EXISTS op_dying (
  kind TEXT NOT NULL,
  id   INTEGER NOT NULL,
  key  TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

-- machine_identity: one durable identity per DB/machine, seeded by
-- openDb after schema creation. hostname is advisory only.
--
-- last_wall / last_counter are the persisted hybrid logical clock
-- (src/hlc.ts, VOCABULARY § HLC). They live here because every mu
-- invocation is a fresh process — an in-memory counter would reset
-- constantly and mint duplicate HLCs, which UNIQUE (machine_id, hlc)
-- on the ops table would then reject.
CREATE TABLE IF NOT EXISTS machine_identity (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  machine_id   TEXT NOT NULL,
  hostname     TEXT,
  created_at   TEXT NOT NULL,
  last_wall    INTEGER NOT NULL DEFAULT 0,
  last_counter INTEGER NOT NULL DEFAULT 0
);

-- ─── Tables ───────────────────────────────────────────────────────────

-- workstreams: top of the hierarchy. name stays globally unique
-- because it IS a tmux session name; no <scope_id> column because
-- there's no parent.
CREATE TABLE IF NOT EXISTS workstreams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  created_at  TEXT NOT NULL,                 -- ISO 8601
  -- Soft teardown: set = torn down. Views and user-facing reads skip such
  -- rows; ingest still sees them (UNIQUE(name) must hold). Synced.
  torn_down_at TEXT
);


-- agents: one row per managed pane. Per-workstream unique on name.
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                  -- per-workstream unique
  cli           TEXT NOT NULL DEFAULT 'pi',
  pane_id       TEXT NOT NULL,
  status        TEXT NOT NULL,                    -- DEPRECATED (2.0): always 'spawning'; runtime state lives in murmur. Drop at the first v11 migration.
  role          TEXT NOT NULL DEFAULT 'full-access',
  tab           TEXT,
  cwd           TEXT,                           -- worktree path the pane runs in (machine-local)
  base          TEXT,                           -- commit that worktree was created from (machine-local)
  command       TEXT,                           -- the resolved command the pane runs (machine-local); NULL: row predates it
  command_source TEXT,                          -- 'explicit' | 'env' | 'cli-key': where command came from (machine-local)
  spawner       TEXT,                           -- who spawned it: '<workstream>/<agent>' or 'pi:<session>' (machine-local); NULL: unknown
  host          TEXT,                           -- the remote host profile it runs on (machine-local); NULL: local
  collected_head TEXT,                          -- HEAD last collected from a remote worktree (machine-local)
  repo          TEXT,                           -- a remote worktree's repo on its host, made absolute at spawn (machine-local); NULL: none
  gate_token    TEXT,                           -- remote command gate: spawn-unique token, also the key of its remote result record (machine-local); NULL: not a gate
  host_transport TEXT,                          -- the transport of the profile it was spawned on, 'session' | 'lease' (machine-local); NULL: local, or a row older than the column
  channel       TEXT,                           -- the channel mu reaches it through, 'ctl' | 'hooks' | 'mux' (machine-local), recorded at spawn; NULL: a row older than the column (derived)
  channel_plugin TEXT,                          -- a plugin channel's plugin (plugins D9): with channel, its identity; NULL: a built-in
  remote_key    TEXT,                           -- a remote hook-harness worker's key on its node, '<origin host>/<pane key>' (machine-local, spec D11); NULL: none
  delivery_seq  INTEGER NOT NULL DEFAULT 0,     -- plugins D4: the newest delivery effect written to it (src/effects.ts)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, name),
  CHECK (status IN (
    'spawning', 'busy', 'needs_input', 'needs_permission',
    'free', 'unreachable', 'terminated'
  )),
  CHECK (role IN ('full-access', 'read-only'))
);

CREATE INDEX IF NOT EXISTS idx_agents_workstream ON agents (workstream_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);

-- task_substates: the legal (status, substate) pairs. Seeded from
-- TASK_SUBSTATE_ROWS (src/tasks/status.ts) by applySchema; exactly one
-- default per status.
CREATE TABLE IF NOT EXISTS task_substates (
  status     TEXT NOT NULL,
  substate   TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  PRIMARY KEY (status, substate)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_substates_one_default
  ON task_substates (status) WHERE is_default = 1;

-- tasks: per-workstream unique on local_id (TRULY local now —
-- different workstreams may reuse the same local_id).
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  local_id      TEXT NOT NULL,                 -- per-workstream unique
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN',
  -- OPEN | IN_PROGRESS | CLOSED — see VOCABULARY.md.
  substate      TEXT NOT NULL,
  -- Qualifies status. No DEFAULT on purpose: a writer that forgets it
  -- must fail loudly rather than silently pick one.
  -- NOT NULL with defaults: a peer's partial op must create the row; \`scored\` says if given.
  impact        INTEGER NOT NULL DEFAULT 50,
  effort_days   REAL NOT NULL DEFAULT 1,
  scored        INTEGER NOT NULL DEFAULT 0 CHECK (scored IN (0, 1)),
  dispatch_host TEXT,                           -- host \`mu next\` dispatches this task to (synced)
  kind          TEXT NOT NULL DEFAULT 'work'    -- work | delegate | human (synced)
                CHECK (kind IN (${sqlList(TASK_KINDS)})),
  wave          TEXT,                           -- label grouping one fan-out of delegate calls (synced)
  owner_id      INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, local_id),
  CHECK (impact BETWEEN 1 AND 100),
  CHECK (effort_days > 0),
  FOREIGN KEY (status, substate) REFERENCES task_substates (status, substate)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks (workstream_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks (owner_id);

-- task_edges: composite PK by pair. INTEGER FKs into tasks.id.
CREATE TABLE IF NOT EXISTS task_edges (
  from_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  to_task_id   INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (from_task_id, to_task_id),
  CHECK (from_task_id <> to_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_edges_to ON task_edges (to_task_id);

-- task_notes: append-only context. author stays free-text
-- ("orchestrator", "user", "π - mu", "system") — not always a
-- registered agent.
CREATE TABLE IF NOT EXISTS task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Set once at INSERT (a local UPDATE raises: src/capture.ts).
  kind       TEXT NOT NULL DEFAULT 'note'
             CHECK (kind IN ('brief', 'report', 'verdict', 'close', 'note'))
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes (task_id);
${CHECKS_DDL}

-- task_auto: per-task auto-dispatch state (machine-local, never synced).
CREATE TABLE IF NOT EXISTS task_auto (
  task_id    INTEGER PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  cli        TEXT NOT NULL,
  worktree   INTEGER NOT NULL DEFAULT 0 CHECK (worktree IN (0, 1)),
  max_runs   INTEGER NOT NULL DEFAULT 1 CHECK (max_runs > 0),
  runs       INTEGER NOT NULL DEFAULT 0,
  last_spawn TEXT,
  created_at TEXT NOT NULL,
  -- 0 after \`mu task auto --off\`: the row (runs, last_spawn) outlives revoked permission.
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

-- delegate_calls: one row per task-backed delegate call (machine-local); the brief is a task note.
CREATE TABLE IF NOT EXISTS delegate_calls (
  task_id          INTEGER PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  caller           TEXT NOT NULL,
  call_id          TEXT NOT NULL UNIQUE,
  state            TEXT NOT NULL
                   CHECK (state IN (${sqlList(DELEGATE_CALL_STATES)})),
  record_workstream TEXT,
  record_task      TEXT,
  record_label     TEXT,
  error            TEXT,
  updated_at       TEXT NOT NULL,
  request          TEXT,  -- spawn request (JSON)
  verdict          TEXT, agent TEXT  -- parsed label of a done answer; the agent that ran it
);
-- The dashboard's attention scan reads refused and recently failed calls each tick.
CREATE INDEX IF NOT EXISTS idx_delegate_calls_state ON delegate_calls (state, updated_at);

-- human_needs: the caller that recorded a kind=human task (machine-local).
-- The task, its reason brief and its close are portable; who asked is not
-- (a caller names a managed agent or pi session of THIS machine).
CREATE TABLE IF NOT EXISTS human_needs (
  task_id INTEGER PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  caller  TEXT NOT NULL
);

-- wait_cursors: per caller and ref, the last consumed incarnation and
-- runs (machine-local), so a settled run is reported once.
CREATE TABLE IF NOT EXISTS wait_cursors (
  caller      TEXT NOT NULL,
  ref         TEXT NOT NULL,
  incarnation TEXT,
  runs        INTEGER,
  PRIMARY KEY (caller, ref)
);

-- wait_registrations: per caller, the typed refs a wait still owes it
-- (machine-local; src/wait-registration.ts owns the JSON shape). state
-- 'waiting' = a wait is in flight; generation is bumped by each wait that
-- starts, so a finished older wait cannot overwrite a newer one. No foreign
-- keys: a ref outliving its task or agent is still owed its answer. Never
-- holds consumed runs: that is wait_cursors.
CREATE TABLE IF NOT EXISTS wait_registrations (
  caller     TEXT PRIMARY KEY,
  refs_json  TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('armed', 'waiting')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at TEXT NOT NULL,
  -- Per agent ref, the UNCONSUMED run baseline a producer registered
  -- ({afterRuns, incarnation, agentId}); never a consumed cursor.
  baselines_json TEXT NOT NULL DEFAULT '{}'
);

-- agent_settles: one row per (agent, incarnation, runs) already applied
-- (machine-local). No foreign keys on purpose: the evidence that a settled
-- run took effect must outlive the agent and the task. agents.id is
-- AUTOINCREMENT, so a deleted agent's id is never reused.
CREATE TABLE IF NOT EXISTS agent_settles (
  agent_id    INTEGER NOT NULL,
  incarnation TEXT NOT NULL,
  runs        INTEGER NOT NULL,
  task_id     INTEGER,
  PRIMARY KEY (agent_id, incarnation, runs)
);

${SPAWN_RECEIPTS_DDL}
-- wait_resumes: the stored condition set of a wait that ended with something
-- still owed (machine-local; src/wait-resume.ts owns the JSON shape). The
-- result prints only 'mu wait --resume <id>': the refs (with the run baseline
-- and pi incarnation each was seen at), mode, filters, deadline and the callers
-- it ran for live here, so a resume is lossless and its size does not grow with
-- the wait. No foreign keys: a handle outlives the tasks and agents it names.
CREATE TABLE IF NOT EXISTS wait_resumes (
  id         TEXT PRIMARY KEY,
  callers_json TEXT NOT NULL,
  spec_json  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- wait_action_receipts: one row per stall action a wait took (machine-local,
-- never captured or synced). The identity is the TASK (tasks.id), the OWNER
-- (agents.id) and pi's ctl incarnation, plus the action: NOT the wait
-- generation, the task revision or the caller, so every caller, restart and
-- generation shares one exclusion. No foreign keys: the row is evidence that
-- an effect may have happened and must outlive the task and the agent.
-- incarnation '' = ctl named none. state: reserved (nothing written) <
-- sending (the write MAY have happened: never resend) < sent | unknown;
-- refused = a guard stopped it, nothing written; released = a release took
-- effect (written in the release's own transaction).
CREATE TABLE IF NOT EXISTS wait_action_receipts (
  task_id          INTEGER NOT NULL,
  owner_id         INTEGER NOT NULL,
  incarnation      TEXT NOT NULL DEFAULT '',
  action           TEXT NOT NULL CHECK (action IN (${sqlList(WAIT_ACTIONS)})),
  caller           TEXT NOT NULL,
  task_ref         TEXT NOT NULL,
  owner_ref        TEXT NOT NULL,
  pane_id          TEXT NOT NULL,
  preview_revision INTEGER NOT NULL,
  msg_id           TEXT,
  state            TEXT NOT NULL CHECK (state IN (${sqlList(WAIT_ACTION_STATES)})),
  runs             INTEGER,
  detail           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (task_id, owner_id, incarnation, action)
);

-- keep_driving: per harness session, what \`mu hook stop\` has done
-- (machine-local; src/hook-stop.ts). empty_blocks counts the consecutive
-- blocks that delivered no event (capped by MU_KEEP_DRIVING_MAX); a block
-- with events and a turn the user started reset it. close_nudged: the
-- worker's close nudge fired in this session (once per session). Rows idle
-- for a week go with the next write. Additive at schema 13: no bump.
CREATE TABLE IF NOT EXISTS keep_driving (
  session_id   TEXT PRIMARY KEY,
  empty_blocks INTEGER NOT NULL DEFAULT 0 CHECK (empty_blocks >= 0),
  close_nudged INTEGER NOT NULL DEFAULT 0 CHECK (close_nudged IN (0, 1)),
  updated_at   TEXT NOT NULL
);

-- host_profiles: ssh-free command templates for a remote host
-- (machine-local; mu never connects, it expands these).
CREATE TABLE IF NOT EXISTS host_profiles (
  name         TEXT PRIMARY KEY,
  shell        TEXT,                           -- NULL only with plugin (addHost requires it otherwise)
  exec         TEXT,                           -- NULL only with plugin: the plugin is the link
  fetch        TEXT NOT NULL,
  repo         TEXT,                           -- default remote repo for spawns without --root; NULL: none
  max_sessions INTEGER CHECK (max_sessions > 0),
  transport    TEXT NOT NULL DEFAULT 'session', -- 'session' | 'lease' (validated in addHost, no CHECK: ADDED_COLUMNS cannot add one)
  stop         TEXT,                           -- lease only: the template that ends a job given its handle ({job}); NULL for session
  attach       TEXT,                           -- lease only, optional: a new carrier for a running job ({job}, {job_file}); NULL: none
  capabilities TEXT,                           -- the last host check's harness probe and its time (JSON); NULL: never probed
  plugin       TEXT                            -- the registered plugin that is this host's link (plugins.name); NULL: the templates
);

-- plugins: the user's registered plugins (machine-local; spec D14). One row per
-- 'mu plugin add': the argv, and what its handshake declared. No FK from
-- host_profiles.plugin: 'mu plugin rm' refuses while a profile names it.
CREATE TABLE IF NOT EXISTS plugins (
  name          TEXT PRIMARY KEY,
  argv_json     TEXT NOT NULL,                 -- JSON array; the first word an absolute path
  protocol      INTEGER NOT NULL,
  version       TEXT NOT NULL,
  instance      TEXT NOT NULL,                 -- the backend configuration it addresses (the fence)
  seams_json    TEXT NOT NULL,                 -- JSON array of the declared seam names
  caps_json     TEXT NOT NULL,                 -- JSON: the handshake's seams, each with its capabilities
  schema_digest TEXT NOT NULL,
  added_at      TEXT NOT NULL,
  checked_at    TEXT NOT NULL
);

-- effects: every unresolved plugin effect (machine-local; plugins spec D4, D5;
-- src/effects.ts). Written in one immediate transaction with its subject's own
-- change, before the call: the key, the method's params exactly as first sent
-- and their sha256, the plugin instance, the creator and the plugin's process
-- group. Deleted with the definite result. A delivery's seq is the value of its
-- agent's delivery_seq it took. No FK: a subject may go first (an abandon).
CREATE TABLE IF NOT EXISTS effects (
  key               TEXT PRIMARY KEY,
  subject_kind      TEXT NOT NULL CHECK (subject_kind IN ('host', 'job', 'delivery')),
  subject_id        TEXT NOT NULL,           -- hosts.id, carrier_jobs.token, or agents.id
  msg_id            TEXT,                    -- deliveries (and an at-start job.start)
  seq               INTEGER,                 -- deliveries: agents.delivery_seq at intent
  plugin            TEXT NOT NULL,
  method            TEXT NOT NULL,
  params_json       TEXT NOT NULL,
  params_sha        TEXT NOT NULL,
  instance          TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('pending', 'resolving', 'unknown')),
  creator_pid       INTEGER NOT NULL,
  creator_start     TEXT,
  plugin_pgid       INTEGER NOT NULL,
  plugin_pgid_start TEXT,
  resolver_pid      INTEGER,
  resolver_start    TEXT,
  created_at        INTEGER NOT NULL,        -- epoch ms: inFlightMs and dedupe windows count from it
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effects_subject ON effects (subject_kind, subject_id);

-- hosts: provider hosts (machine-local; plugins spec D1, D5; src/host-records.ts).
-- One row per 'mu host acquire', written with its host.acquire effect; mu alone
-- moves 'state'. The facts (handle, deadline, idle window, job slots) are the
-- provider's acquire reply. A name is a profile's or a record's, never both.
CREATE TABLE IF NOT EXISTS hosts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL,             -- plugins.name
  params_json     TEXT NOT NULL,
  repo            TEXT,
  handle          TEXT,                      -- NULL while acquiring
  instance        TEXT,                      -- the provider's instance at acquire (the fence)
  state           TEXT NOT NULL CHECK (state IN ('acquiring', 'ready', 'draining', 'releasing', 'lost')),
  deadline_at     INTEGER,                   -- epoch ms
  idle_reclaim_ms INTEGER,
  max_jobs        INTEGER,
  creator_pid     INTEGER,
  creator_start   TEXT,
  reason          TEXT,                      -- why it is lost
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

${CARRIER_JOBS_DDL}
-- host_channels: the connection slots of a host (machine-local). One row
-- per holder. 'transient' rides an invocation (exec, fetch, check) and is
-- reclaimed only when its pid is proven gone; 'attached' rides an agent's
-- pane (registry id + pane, no pid) and is reclaimed only when that pane is
-- proven dead. 'pgid' is the template's process group, recorded before the
-- command starts: a transient row stays held while that group lives, whatever
-- became of the holder pid (SIGKILL included). 'token' makes every release a
-- compare-and-set. No FK: the
-- row must outlive neither its host nor guess at its holder.
CREATE TABLE IF NOT EXISTS host_channels (
  host      TEXT NOT NULL,
  holder    TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('transient', 'attached')),
  token     TEXT NOT NULL,
  pid       INTEGER,
  pid_start TEXT,
  pgid      INTEGER,
  pgid_start TEXT,
  agent_id  INTEGER,
  pane_id   TEXT,
  opened_at TEXT NOT NULL,
  PRIMARY KEY (host, holder),
  CHECK (kind = 'transient' AND pid IS NOT NULL
         OR kind = 'attached' AND agent_id IS NOT NULL AND pane_id IS NOT NULL)
);

${REMOTE_RECOVERY_DDL}
-- ─── The ops log (VISION.md § 2b, VOCABULARY.md § op / ops log) ──────
--
-- The single append-only record of every change. Sync and
-- history are all queries or replays over this one table.
--
-- Deliberately FK-free. An op must stay readable after the row (and
-- the workstream) it records is gone — a tombstone op for a destroyed
-- workstream is the whole point — so 'key' holds the NATURAL key
-- ('<workstream>/<local_id>'), never a surrogate id. That is also why
-- keys don't collide across machines.
--
--   seq        local-only append cursor (AUTOINCREMENT never recycles)
--   hlc        the ORDERING key across machines (VOCABULARY § HLC)
--   machine_id which peer wrote this op
--   group_id   the op group: all ops of one operator action
--   actor      who caused it (may not be a registered worker)
--   intent     semantic label ('task.close', 'agent.spawn')
--   entity/key what it addresses ('task', 'mu/ops-log')
--   op         'put' (semantic partial update) | 'del' (tombstone)
--   payload    JSON of ONLY the columns that changed
--
-- UNIQUE (machine_id, hlc) is load-bearing: it makes ingest idempotent
-- for free, which is what lets 'mu sync --repair' be nothing more than
-- "re-read that peer's segment from zero".
CREATE TABLE IF NOT EXISTS ops (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  hlc        TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  actor      TEXT,
  intent     TEXT,
  entity     TEXT NOT NULL,
  key        TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('put','del')),
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (machine_id, hlc)
);

-- Four indexes, one per read shape that actually exists:
--   hlc         — replay/rebuild walks the log in HLC order.
--   entity,key  — "what happened to this task" (history + per-field merge).
--   group_id    — 'mu log --group <group>' gathers one action's ops.
--   machine_id,entity,hlc — sync flush seeks this machine's SYNCED ops
--                 past the segment's last hlc, so a trailing run of
--                 machine-local ops (agent.*) costs nothing per flush.
-- (Other machine_id lookups ride the UNIQUE (machine_id, hlc) index;
-- seq is the PK. No speculative index beyond these.)
CREATE INDEX IF NOT EXISTS idx_ops_hlc ON ops (hlc);
CREATE INDEX IF NOT EXISTS idx_ops_entity_key ON ops (entity, key);
CREATE INDEX IF NOT EXISTS idx_ops_group ON ops (group_id);
CREATE INDEX IF NOT EXISTS idx_ops_machine_entity_hlc ON ops (machine_id, entity, hlc);

-- sync_peers: one row per known peer, holding its watermark — how far
-- into that peer's segment we have applied. One integer suffices
-- because segments are append-only and ordered. Rows are created on
-- demand at first ingest; there is no membership list to configure.
-- A Syncthing conflict copy gets its own row, keyed by its file stem.
-- last_seen_at is the ISO time of the last watermark write.
CREATE TABLE IF NOT EXISTS sync_peers (
  machine_id       TEXT PRIMARY KEY,
  last_applied_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_at     TEXT
);

-- sync_fingerprints: the caught-up fingerprint, '<size> <mtimeMs>
-- <manifest sha256>' of a peer segment, recorded with the watermark
-- when ingest read that segment cleanly to its end (src/segments.ts
-- segmentCaughtUp). Keyed like sync_peers; a watermark write without a
-- clean read deletes the row. A cache: losing it costs one full read.
-- The value may carry tab-separated resume fields after the key
-- (src/segment-resume.ts): byte offset and sha256 state for ingest
-- to read only appended bytes.
-- Additive, so no schema bump: an older mu ignores it, and any
-- watermark it writes can no longer match a stale fingerprint.
CREATE TABLE IF NOT EXISTS sync_fingerprints (
  machine_id  TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
);

-- worktrees: the machine-local registry of git worktrees mu created for
-- agents. NOT keyed to agents: the row outlives the agent so a reused
-- name can tell "my own clean leftover" from foreign work (base,
-- last_collected_head). deleteAgent never touches it; closing the
-- worktree (src/worktree.ts) does.
CREATE TABLE IF NOT EXISTS worktrees (
  path                TEXT PRIMARY KEY,
  agent               TEXT NOT NULL,
  workstream          TEXT NOT NULL,
  root                TEXT NOT NULL,            -- the repo checkout the worktree was added from
  base                TEXT NOT NULL,            -- commit the worktree was created at
  last_collected_head TEXT,                     -- HEAD last brought back (remote collect)
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worktrees_workstream ON worktrees (workstream, agent);

-- ─── Views (replaced when stale so the latest definition wins) ────────
-- See READY_VIEW_SQL / BLOCKED_VIEW_SQL / BLOCKERS_VIEW_SQL / GOALS_VIEW_SQL
-- above for the canonical DDL — interpolated here so applySchema is one
-- db.exec(). Every view skips torn-down workstreams.
${READY_VIEW_SQL}
${BLOCKED_VIEW_SQL}
${BLOCKERS_VIEW_SQL}
${GOALS_VIEW_SQL}
`;
