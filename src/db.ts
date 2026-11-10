// mu — DB module.
//
// Opens <state-dir>/mu.db (or the MU_DB_PATH override; see defaultDbPath),
// enables WAL + foreign keys, applies the schema idempotently, and
// exposes the live Database handle.
//
// Schema (v14; the DDL and EXPECTED_TABLES, the exact list of 29 tables, are
// in src/db-schema.ts, re-exported here), by group:
//   - entity (portable: they sync): workstreams, tasks, task_edges, task_notes,
//     checks (src/db-checks.ts).
//     tasks carries substate (status qualifier; a composite FK
//     (status, substate) -> task_substates, DEFERRABLE INITIALLY DEFERRED,
//     checked at COMMIT so apply's one-field-at-a-time UPDATEs pass), kind,
//     wave, scored, dispatch_host; task_notes carries kind.
//   - machine-local entity: agents (with cwd, base, spawner, host,
//     collected_head), worktrees, task_auto, delegate_calls, human_needs,
//     wait_cursors, wait_registrations, wait_resumes, wait_action_receipts,
//     agent_settles, spawn_receipts, host_profiles, host_channels,
//     remote_recovery, carrier_jobs, keep_driving
//   - ops log:  ops (the single append-only record of every change:
//               VISION.md § 2b)
//   - sync:     sync_peers (per-peer watermarks),
//               sync_fingerprints (caught-up fingerprints)
//   - meta:     schema_version, machine_identity, op_ctx (op context),
//               op_dying (delete-key stash)
//   - lookup:   task_substates (legal (status, substate) pairs, seeded
//               from code when missing)
//   - views:    ready, blocked, blockers, goals
// PORTABLE_TABLES / MACHINE_LOCAL_TABLES classify every table.
//
// The surrogate-INTEGER-PK discipline (docs/architecture/sdk.md): every
// entity table has an INTEGER PK (`checks`: a ULID); FKs reference INTEGER
// ids; the operator-facing TEXT name is per-scope unique via UNIQUE
// (<scope_id>, <name>). `ops` is the exception: `ops.key` holds the NATURAL
// key (`ws/local_id`), never a surrogate id, so keys don't collide across machines.
//
// IMPORTANT: there is no migration ladder. openDb accepts only
// CURRENT_SCHEMA_VERSION (14) and completes a v14 file that lacks later
// additions in ONE transaction (upgradeSchema: columns, tables, triggers
// and both stamps together). Every older DB is rejected with
// SchemaTooOldError (exit 4), and a DB newer than this build with
// SchemaTooNewError (exit 4); a mu 4 (v13) file only via src/state-import.ts.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import {
  CAPTURE_VERSION,
  CaptureTooNewError,
  installCaptureLocked,
  sqliteTooOld,
  storedCaptureVersion,
} from "./capture.js";
import {
  CARRIER_JOBS_REBUILD,
  carrierJobsPreReservation,
  carrierJobsStopRequired,
} from "./db-carrier.js";
import { checksTableMissing, refoldStoredChecks } from "./db-checks.js";
import { SPAWN_RECEIPTS_REBUILD, spawnReceiptsPreHooks } from "./db-receipts.js";
import { LEGACY_RECOVERY_TRIGGERS, RECOVERY_TRIGGERS } from "./db-recovery.js";
import {
  ADDED_COLUMNS,
  BLOCKED_VIEW_SQL,
  BLOCKERS_VIEW_SQL,
  CURRENT_SCHEMA,
  CURRENT_SCHEMA_VERSION,
  GOALS_VIEW_SQL,
  MIN_ACCEPTED_SCHEMA_VERSION,
  READY_VIEW_SQL,
  V13,
} from "./db-schema.js";
import { say } from "./messages.js";
import { defaultStateDir, refusePendingStateImport, xdgStateHome } from "./state-dir.js";
import { TASK_SUBSTATE_ROWS } from "./tasks/status.js";

export {
  BLOCKED_VIEW_SQL,
  BLOCKERS_VIEW_SQL,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_EFFORT_DAYS,
  DEFAULT_IMPACT,
  DELEGATE_CALL_STATES,
  EXPECTED_TABLES,
  GOALS_VIEW_SQL,
  MACHINE_LOCAL_ENTITIES,
  MACHINE_LOCAL_TABLES,
  type MachineLocalEntity,
  type MachineLocalTable,
  NOTE_KINDS,
  type NoteKind,
  PORTABLE_TABLES,
  type PortableTable,
  READY_VIEW_SQL,
  SYNCED_ENTITIES,
  type SyncedEntity,
  TASK_KINDS,
  type TaskKind,
  V13,
  WAIT_ACTION_STATES,
  WAIT_ACTIONS,
  type WaitAction,
  type WaitActionState,
} from "./db-schema.js";
export { defaultStateDir };

export type Db = DatabaseType;

const statementCache = new WeakMap<Db, Map<string, Statement>>();

/**
 * `db.prepare(sql)`, compiled once per connection and reused.
 *
 * better-sqlite3 has no statement cache, so a hot loop that calls
 * `db.prepare` per row pays SQL compilation every time. Ingest applies
 * thousands of ops and prepared ~10 statements per op, which made SQL
 * compilation most of a large catch-up's cost. Use this on per-op paths;
 * one-off queries keep plain `db.prepare`. `sql` must come from a fixed
 * template (the cache never evicts). Not for a statement a caller
 * `.iterate()`s while re-entering the same SQL: a busy statement throws.
 */
export function prepareCached(db: Db, sql: string): Statement {
  let byDb = statementCache.get(db);
  if (byDb === undefined) {
    byDb = new Map();
    statementCache.set(db, byDb);
  }
  let stmt = byDb.get(sql);
  if (stmt === undefined) {
    stmt = db.prepare(sql);
    byDb.set(sql, stmt);
  }
  return stmt;
}

export interface OpenDbOptions {
  /**
   * Absolute path to the SQLite file. Defaults to MU_DB_PATH env var or
   * the XDG state path (see `defaultDbPath`). Use a per-test temp path
   * in tests.
   */
  path?: string;

  /**
   * If true, opens the DB read-only. Used by `mu sql` and similar read-only
   * surfaces to enforce no-mutation guarantees at the connection level.
   */
  readonly?: boolean;
}

/**
 * Resolve the canonical DB path:
 *   MU_DB_PATH > <state-dir>/mu.db
 */
export function defaultDbPath(): string {
  if (process.env.MU_DB_PATH) return process.env.MU_DB_PATH;
  return join(defaultStateDir(), "mu.db");
}

/**
 * Open the mu database. Creates the parent directory and applies the schema
 * idempotently when it is missing or differs from this build (an
 * up-to-date DB opens without a write). Safe to call from many short-lived processes
 * concurrently — WAL mode handles cross-process writes.
 */
export function openDb(options: OpenDbOptions = {}): Db {
  const path = options.path ?? defaultDbPath();
  refuseUserDbDuringTests(path);
  refusePendingStateImport(path);
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { readonly: options.readonly ?? false });

  if (!options.readonly) {
    // Wait up to 5s for a competing writer's lock instead of throwing
    // SQLITE_BUSY immediately. Every `mu` invocation is a separate
    // short-lived process and a parallel fan-out (`for n in …; do mu
    // agent spawn … & done`) opens the same DB from N processes at
    // once — without this, the losers of a write-lock race die with
    // 'database is locked' and roll back their agent. WAL handles
    // concurrent readers; busy_timeout handles concurrent writers.
    // busy_timeout only covers a lock taken at BEGIN, so every write
    // transaction runs as `db.transaction(fn).immediate()` (or `BEGIN
    // IMMEDIATE`). A deferred one that reads first and then writes gets
    // SQLITE_BUSY_SNAPSHOT at once if another process committed in
    // between, and busy_timeout does not retry that.
    db.pragma("busy_timeout = 5000");
    // The capture triggers need unixepoch('subsec') (SQLite 3.42): below
    // it every HLC would be zero-time. Refuse before touching the file.
    const sqliteVersion = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    if (sqliteTooOld(sqliteVersion)) {
      closeQuietly(db);
      throw new SqliteTooOldError(sqliteVersion);
    }
    // Detect schema version BEFORE any DDL so a real v<12 DB is not
    // silently stamped by the CREATE-IF-NOT-EXISTS in the schema, and
    // before `journal_mode = WAL`, which rewrites the file header:
    // a refused DB must be left byte-for-byte untouched.
    // One read transaction: a process creating this DB can commit
    // between two bare reads, and "no schema_version table, then a
    // workstreams table" read as a pre-versioning v1 DB.
    const { version: detectedVersion, capture: detectedCapture } = db.transaction(() => ({
      version: detectExistingSchemaVersion(db),
      capture: storedCaptureVersion(db),
    }))();
    try {
      refuseUnusableStamps(detectedVersion, detectedCapture);
      setWalMode(db);
      db.pragma("foreign_keys = ON");
      // Skip the DDL write transaction when the DB already matches this
      // build (schema, capture stamp and stored triggers): the upgrade
      // takes the write lock and rewrites the views, which bumps the
      // schema cookie on every open, so every `mu` call, reads included,
      // queued behind any writer and forced every other connection to
      // re-parse the schema (f_opendb_schema_write).
      if (
        detectedVersion !== CURRENT_SCHEMA_VERSION ||
        detectedCapture !== CAPTURE_VERSION ||
        !schemaIsCurrent(db)
      ) {
        upgradeSchema(db);
      }
      seedMachineIdentity(db);
    } catch (err) {
      closeQuietly(db);
      throw err;
    }
  } else {
    db.pragma("foreign_keys = ON");
  }

  return db;
}

function closeQuietly(db: Db): void {
  try {
    db.close();
  } catch {
    // best effort
  }
}

/**
 * Hard guard: refuse to open
 * the user's REAL default mu.db when running under vitest. Tests
 * MUST point at a per-test temp DB (via MU_DB_PATH or the explicit
 * `{ path }` option). A test that forgets to override either one
 * silently mutated the dev box's live state — we observed a stray
 * 'demo' workstream row replicated from test/tui-acceptance.integration.test.ts
 * into ~/.local/state/mu/mu.db (now ~/.local/state/mu5/mu.db). The guard throws a useful diagnostic
 * the moment the offending openDb() call is made; the failing test's
 * stack trace then names the leak source directly.
 *
 * Test mode = `VITEST` set (every vitest fork) or `NODE_ENV === "test"`.
 *
 * The user's REAL DB path is computed from HOME / XDG_STATE_HOME
 * directly (NOT from defaultDbPath() — which would honour MU_DB_PATH
 * and produce the temp path the test set, defeating the check).
 * MU_STATE_DIR is deliberately not consulted: test/_setup.ts deletes
 * the user's MU_* vars in every fork, so any MU_STATE_DIR seen here was
 * set by a test to a temp dir (test/disk-recon.test.ts opens
 * <MU_STATE_DIR>/mu.db), and guarding it would refuse that temp DB.
 * Outside the test runner the guard is a no-op.
 */
function refuseUserDbDuringTests(path: string): void {
  const inTest = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
  if (!inTest) return;
  const home = process.env.HOME ?? homedir();
  // The 5.x default (<state home>/mu5), 4.x's and 3.x's: a test must reach none.
  const realDbs = ["mu5", "mu-next", "mu"].map((dir) =>
    resolve(join(xdgStateHome(home), dir, "mu.db")),
  );
  const realDb = realDbs.find((p) => p === resolve(path));
  if (realDb !== undefined) {
    throw new Error(say("db.test_real_db", realDb));
  }
}

// ─── Resolve helpers (operator-facing name -> surrogate id) ───────────
//
// docs/architecture/sdk.md § Surrogate-PK and SDK-boundary discipline:
//
//   PUBLIC SDK functions take operator-facing names (workstream + local
//   id + agent name). Internal helpers take surrogate ids. Resolution
//   happens at the public-function entry, exactly once.
//
// `resolveWorkstreamId` throws a typed error from this leaf module —
// `WorkstreamNotFoundError` is defined here, so there is no cycle.

export class WorkstreamNotFoundError extends Error {
  override readonly name: string = "WorkstreamNotFoundError";
  /** `near` are live workstreams with a similar name; `init` says `mu workstream init` is the fix
   *  (the name is valid and not reserved). Both only shape the message. */
  constructor(
    public readonly workstream: string,
    hints: { near?: readonly string[]; init?: boolean } = {},
  ) {
    super(say("workstream.not_found", workstream, hints.near, hints.init));
  }
}

/** A verb named a **torn down** workstream (`workstreams.torn_down_at`
 *  set). It is a kind of not-found (exit 3), but says why and how to get
 *  the name back: `workstream init` previews, then `--if <rev>` reuses it. */
export class WorkstreamTornDownError extends WorkstreamNotFoundError {
  override readonly name: string = "WorkstreamTornDownError";
  constructor(
    workstream: string,
    public readonly tornDownAt: string,
  ) {
    super(workstream);
    this.message = say("workstream.torn_down", workstream, tornDownAt);
  }
}

/** When `workstream` is torn down: its `torn_down_at`; else null (live or
 *  unknown). */
export function tornDownAtOf(db: Db, workstream: string): string | null {
  const row = db.prepare("SELECT torn_down_at FROM workstreams WHERE name = ?").get(workstream) as
    | { torn_down_at: string | null }
    | undefined;
  return row?.torn_down_at ?? null;
}

/** Resolve a workstream name to its INTEGER surrogate id. Throws
 *  WorkstreamNotFoundError on miss, and WorkstreamTornDownError when the
 *  row exists torn down (ingest, which must still find it, queries
 *  `workstreams` directly). Pure: no auto-create — callers
 *  that want the auto-create-or-resolve semantics use
 *  `ensureWorkstream` from src/workstream.ts (which returns void;
 *  follow up with `resolveWorkstreamId` if the id is needed).
 */
export function resolveWorkstreamId(db: Db, workstream: string): number {
  const row = db
    .prepare("SELECT id, torn_down_at FROM workstreams WHERE name = ?")
    .get(workstream) as { id: number; torn_down_at: string | null } | undefined;
  if (!row) throw new WorkstreamNotFoundError(workstream);
  if (row.torn_down_at !== null) throw new WorkstreamTornDownError(workstream, row.torn_down_at);
  return row.id;
}

/** Resolve a workstream name to its id, returning null on miss instead
 *  of throwing. A torn-down workstream is a miss too. Tolerant on purpose:
 *  agent and reaper paths use it, and a peer's teardown can reach a machine
 *  that still has agent rows (and live panes) in that workstream. */
export function tryResolveWorkstreamId(db: Db, workstream: string): number | null {
  const row = db
    .prepare("SELECT id FROM workstreams WHERE name = ? AND torn_down_at IS NULL")
    .get(workstream) as { id: number } | undefined;
  return row ? row.id : null;
}

/** Like `tryResolveWorkstreamId` for user-facing task reads: null when the
 *  name is unknown (callers decide), but a torn-down workstream THROWS
 *  `WorkstreamTornDownError`, so every verb says why instead of "no tasks". */
export function tryResolveLiveWorkstreamId(db: Db, workstream: string): number | null {
  const row = db
    .prepare("SELECT id, torn_down_at FROM workstreams WHERE name = ?")
    .get(workstream) as { id: number; torn_down_at: string | null } | undefined;
  if (!row) return null;
  if (row.torn_down_at !== null) throw new WorkstreamTornDownError(workstream, row.torn_down_at);
  return row.id;
}

/**
 * Thrown by openDb when the on-disk DB is older than the current
 * schema. There is no in-place migration ladder; the old DB is left
 * untouched. Maps to exit code 4 (conflict) in cli.ts handle().
 */
export class SchemaTooOldError extends Error {
  override readonly name = "SchemaTooOldError";
  constructor(
    public readonly detectedVersion: number,
    public readonly requiredVersion: number,
  ) {
    super(say("db.schema_old", detectedVersion, requiredVersion));
  }
}

/**
 * Thrown by openDb when the on-disk DB was written by a NEWER mu.
 * The DB is left untouched. Maps to exit code 4 (conflict).
 */
export class SchemaTooNewError extends Error {
  override readonly name = "SchemaTooNewError";
  constructor(
    public readonly detectedVersion: number,
    public readonly supportedVersion: number,
    /** Which stamp was newer: the table schema, or the capture triggers. */
    public readonly stamp: "schema" | "capture" = "schema",
  ) {
    super(say("db.schema_new", detectedVersion, supportedVersion, stamp));
  }
}

/**
 * Thrown by openDb when the linked SQLite is older than 3.42: the capture
 * triggers mint HLCs with `unixepoch('subsec')`, which older versions
 * return NULL for. Maps to exit code 4 (conflict). Nothing was touched.
 */
export class SqliteTooOldError extends Error {
  override readonly name = "SqliteTooOldError";
  constructor(public readonly sqliteVersion: string) {
    super(say("db.sqlite_old", sqliteVersion));
  }
}

/** How long openDb retries the switch to WAL while another process holds the lock. */
const WAL_SWITCH_RETRY_MS = 5000;

/**
 * `journal_mode = WAL`, retried on SQLITE_BUSY. On a fresh file the
 * switch needs an exclusive lock, and SQLite can return SQLITE_BUSY
 * for it without calling the busy handler, so busy_timeout does not
 * cover it: N processes opening a new DB at once lost one with
 * "database is locked". Once the file is WAL the switch is a no-op.
 */
function setWalMode(db: Db): void {
  const deadline = Date.now() + WAL_SWITCH_RETRY_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const busy = typeof code === "string" && code.startsWith("SQLITE_BUSY");
      if (!busy || Date.now() >= deadline) throw err;
      Atomics.wait(pause, 0, 0, 10 + Math.floor(Math.random() * 20));
    }
  }
}

/**
 * Sniff an existing DB's schema version BEFORE applySchema runs, so we
 * can distinguish:
 *   - Brand-new DB: no tables at all -> returns null (fresh, will be
 *     stamped to CURRENT_SCHEMA_VERSION by applySchema).
 *   - Pre-versioning DB (had the original tables before schema_version existed):
 *     workstreams exists, schema_version doesn't -> returns 1.
 *   - Already-versioned DB: schema_version row present -> returns its
 *     value.
 */
function detectExistingSchemaVersion(db: Db): number | null {
  const hasVersionTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { name: string } | undefined;
  if (hasVersionTable) {
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
      | { version: number }
      | undefined;
    return row?.version ?? null;
  }
  // No schema_version table. Check whether any of the original
  // tables exist; if so this is a pre-versioning DB.
  const hasWorkstreams = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workstreams'")
    .get() as { name: string } | undefined;
  if (hasWorkstreams) return 1;
  return null;
}

/** Seed the singleton machine_identity row (id=1) on first open.
 *  No-op once a row exists. The machine_id it writes is the identity
 *  every op is stamped with (`ops.machine_id`) and the name of this
 *  machine's segment. */
function seedMachineIdentity(db: Db): void {
  const row = db.prepare("SELECT COUNT(*) AS count FROM machine_identity").get() as {
    count: number;
  };
  if (row.count !== 0) return;
  db.prepare(
    `INSERT OR IGNORE INTO machine_identity (id, machine_id, hostname, created_at)
     VALUES (1, ?, ?, ?)`,
  ).run(randomUUID(), hostname(), new Date().toISOString());
}

/** Refuse a file this build must not touch, from the stamps read before
 *  any write: a newer schema or capture revision (a later mu wrote it) or
 *  a schema older than MIN_ACCEPTED_SCHEMA_VERSION. */
function refuseUnusableStamps(
  version: number | null,
  capture: number | null,
  minVersion = MIN_ACCEPTED_SCHEMA_VERSION,
): void {
  if (version !== null && version > CURRENT_SCHEMA_VERSION) {
    // A newer mu wrote this DB. Its writes would fail here in confusing
    // ways (unknown columns, constraints this build does not know).
    throw new SchemaTooNewError(version, CURRENT_SCHEMA_VERSION);
  }
  if (capture !== null && capture > CAPTURE_VERSION) {
    // Same for the stored triggers: a newer mu's capture rules are not
    // ours to replace or run. (An OLDER stamp is upgraded in place.)
    throw new SchemaTooNewError(capture, CAPTURE_VERSION, "capture");
  }
  if (version !== null && version < minVersion) {
    // Loud-fail: leave the old file untouched; the message says how to preserve it.
    throw new SchemaTooOldError(version, MIN_ACCEPTED_SCHEMA_VERSION);
  }
}

/**
 * Bring the file to this build in ONE transaction: the schema DDL, the
 * added columns, the schema stamp, the machine identity, the capture
 * triggers and the capture stamp commit together or not at all. Another
 * connection therefore never sees new columns under old capture rules,
 * and a failure anywhere leaves the old columns, triggers and stamps as
 * they were.
 *
 * Idempotent: tables use CREATE TABLE IF NOT EXISTS; views are dropped and
 * recreated so the latest definition wins; a column a v13 DB lacks is
 * added by ALTER (ADDED_COLUMNS). `BEGIN IMMEDIATE` takes the write lock
 * first (paired with busy_timeout in openDb), so two processes opening
 * one fresh DB cannot interleave a DROP VIEW between the other's DROP and
 * CREATE. Both stamps are re-read under that lock: a concurrent opener
 * that already upgraded makes this a no-op, and a newer mu that stamped
 * the file meanwhile is refused with the file untouched.
 *
 * `v13`: the state import's step 5.2 (spec D5), on its copy of a mu 4 DB:
 * completes a v13 file and leaves it stamped 13 for the 13 -> 14 step.
 *
 * Exported for the upgrade tests, which wrap `db` to inject a failure.
 */
export function upgradeSchema(db: Db, opts: { v13?: boolean } = {}): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = detectExistingSchemaVersion(db);
    const v13 = opts.v13 === true && version === V13;
    refuseUnusableStamps(version, storedCaptureVersion(db), v13 ? V13 : undefined);
    // An older v13 file holds `check` ops it recorded but never projected (spec D8).
    const refoldChecks = version !== null && checksTableMissing(db);
    if (version !== CURRENT_SCHEMA_VERSION || !schemaIsCurrent(db)) applySchemaDdl(db);
    // Stamp after the DDL, in the same transaction. A fresh DB gets its
    // row here; an older capture stamp is raised to this build.
    db.prepare(
      `INSERT INTO schema_version (id, version) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version`,
    ).run(v13 ? V13 : CURRENT_SCHEMA_VERSION);
    // The triggers mint HLCs from this row.
    seedMachineIdentity(db);
    installCaptureLocked(db);
    if (refoldChecks) refoldStoredChecks(db);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    if (err instanceof CaptureTooNewError) {
      throw new SchemaTooNewError(err.stored, CAPTURE_VERSION, "capture");
    }
    throw err;
  }
}

/** A v13 file from before host profiles stopped requiring a repo: `repo` is NOT NULL. */
function hostProfilesRepoRequired(db: Db): boolean {
  const row = db
    .prepare("SELECT \"notnull\" AS nn FROM pragma_table_info('host_profiles') WHERE name = 'repo'")
    .get() as { nn: number } | undefined;
  return row?.nn === 1;
}

/** host_profiles before `plugin` (shell and exec NOT NULL): rebuilt, rows kept (plugins spec D5). */
function hostProfilesPrePlugin(db: Db): boolean {
  const cols = db.prepare("SELECT name FROM pragma_table_info('host_profiles')").all() as {
    name: string;
  }[];
  return cols.length > 0 && !cols.some((c) => c.name === "plugin");
}

/** `table` renamed aside, recreated by CURRENT_SCHEMA, and every column it had copied back. */
function rebuildInPlace(db: Db, table: string): void {
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_pre_plugin`);
  db.exec(CURRENT_SCHEMA);
  const cols = (
    db.prepare("SELECT name FROM pragma_table_info(?)").all(`${table}_pre_plugin`) as {
      name: string;
    }[]
  )
    .map((c) => `"${c.name}"`)
    .join(", ");
  db.exec(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${table}_pre_plugin`);
  db.exec(`DROP TABLE ${table}_pre_plugin`);
}

/** The DDL half of upgradeSchema; the caller owns the transaction. */
function applySchemaDdl(db: Db): void {
  // No migration (the profile names a machine now): an older file's profiles
  // are dropped, and its recovery triggers replaced by the _v2 ones below.
  if (hostProfilesRepoRequired(db)) db.exec("DROP TABLE host_profiles");
  for (const t of LEGACY_RECOVERY_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  // carrier_jobs before reservations (one row per agent incarnation, no token): set
  // aside, then copied whole into the final shape below. Never dropped while it holds
  // a handle: the copy and the drop commit together or not at all.
  const oldCarrierJobs = carrierJobsPreReservation(db);
  if (oldCarrierJobs) db.exec("ALTER TABLE carrier_jobs RENAME TO carrier_jobs_pre_reservation");
  // spawn_receipts before the `hooks` transport: set aside and copied whole (same
  // columns, same order) into the widened CHECK below, in this one transaction.
  const oldReceipts = spawnReceiptsPreHooks(db);
  if (oldReceipts) db.exec("ALTER TABLE spawn_receipts RENAME TO spawn_receipts_pre_hooks");
  db.exec(CURRENT_SCHEMA);
  if (oldCarrierJobs) {
    db.exec(CARRIER_JOBS_REBUILD);
    db.exec("DROP TABLE carrier_jobs_pre_reservation");
  }
  if (oldReceipts) {
    db.exec(SPAWN_RECEIPTS_REBUILD);
    db.exec("DROP TABLE spawn_receipts_pre_hooks");
  }
  // Columns a v13 DB written before they existed still lacks.
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  // host_profiles before `plugin` and carrier_jobs before plugin jobs, completed above: each
  // set aside and copied whole into its shape with the nullable columns (plugins spec D5).
  // The recovery triggers read host_profiles and the name index sits on carrier_jobs, so they
  // go first (a rename would carry them to the copy); CURRENT_SCHEMA puts them back.
  if (hostProfilesPrePlugin(db)) {
    for (const t of RECOVERY_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    rebuildInPlace(db, "host_profiles");
  }
  if (carrierJobsStopRequired(db)) {
    db.exec("DROP INDEX IF EXISTS idx_carrier_jobs_name");
    rebuildInPlace(db, "carrier_jobs");
  }
  // Seed the legal (status, substate) pairs from code. INSERT OR
  // IGNORE keeps it idempotent; the table is machine-local and never
  // synced, so every machine derives it from the same constant.
  const seed = db.prepare(
    "INSERT OR IGNORE INTO task_substates (status, substate, is_default) VALUES (?, ?, ?)",
  );
  for (const [status, substate, isDefault] of TASK_SUBSTATE_ROWS) {
    seed.run(status, substate, isDefault);
  }
}

/** Names CURRENT_SCHEMA creates with IF NOT EXISTS, and the exact SQL
 *  SQLite stores for each view (the CREATE statement minus its `;`). */
interface ExpectedObjects {
  tables: string[];
  triggers: string[];
  indexes: string[];
  views: Map<string, string>;
}
let expectedCache: ExpectedObjects | undefined;
function expectedObjects(): ExpectedObjects {
  if (expectedCache !== undefined) return expectedCache;
  const names = (re: RegExp): string[] =>
    [...CURRENT_SCHEMA.matchAll(re)].map((m) => m[1]).filter((n) => n !== undefined);
  const views = new Map<string, string>();
  for (const sql of [READY_VIEW_SQL, BLOCKED_VIEW_SQL, BLOCKERS_VIEW_SQL, GOALS_VIEW_SQL]) {
    const m = /CREATE VIEW (\w+)[^;]*/.exec(sql);
    if (m?.[1] !== undefined) views.set(m[1], m[0]);
  }
  expectedCache = {
    tables: names(/CREATE TABLE IF NOT EXISTS (\w+)/g),
    triggers: names(/CREATE TRIGGER IF NOT EXISTS (\w+)/g),
    indexes: names(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g),
    views,
  };
  return expectedCache;
}

export { SPAWN_RECEIPT_STATES, type SpawnReceiptState } from "./db-receipts.js";

function hasColumn(db: Db, table: string, column: string): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ?").get(table, column) !==
    undefined
  );
}

/** True when applySchema would change nothing: every table, index and
 *  seeded substate row exists, and every view's stored SQL equals this
 *  build's definition. Reads only, so openDb on an up-to-date DB takes
 *  no write lock and leaves PRAGMA schema_version alone. */
function schemaIsCurrent(db: Db): boolean {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master").all() as {
    type: string;
    name: string;
    sql: string | null;
  }[];
  const have = new Map(rows.map((r) => [`${r.type}:${r.name}`, r.sql]));
  const expected = expectedObjects();
  if (expected.tables.some((t) => !have.has(`table:${t}`))) return false;
  if (expected.triggers.some((t) => !have.has(`trigger:${t}`))) return false;
  if (ADDED_COLUMNS.some(([t, c]) => !hasColumn(db, t, c))) return false;
  if (LEGACY_RECOVERY_TRIGGERS.some((t) => have.has(`trigger:${t}`))) return false;
  if (hostProfilesRepoRequired(db)) return false;
  if (hostProfilesPrePlugin(db)) return false;
  if (carrierJobsPreReservation(db)) return false;
  if (carrierJobsStopRequired(db)) return false;
  if (spawnReceiptsPreHooks(db)) return false;
  if (expected.indexes.some((i) => !have.has(`index:${i}`))) return false;
  for (const [name, sql] of expected.views) {
    if (have.get(`view:${name}`) !== sql) return false;
  }
  const pairs = new Set(
    (
      db.prepare("SELECT status, substate FROM task_substates").all() as {
        status: string;
        substate: string;
      }[]
    ).map((r) => `${r.status}/${r.substate}`),
  );
  return TASK_SUBSTATE_ROWS.every(([status, substate]) => pairs.has(`${status}/${substate}`));
}
