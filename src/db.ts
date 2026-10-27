// mu — DB module.
//
// Opens <state-dir>/mu.db (or the MU_DB_PATH override; see defaultDbPath),
// enables WAL + foreign keys, applies the schema idempotently, and
// exposes the live Database handle.
//
// Schema (v13; EXPECTED_TABLES below is the exact list, 26 tables), by group:
//   - entity (portable: they sync): workstreams, tasks, task_edges, task_notes.
//     tasks carries substate (status qualifier; a composite FK
//     (status, substate) -> task_substates, DEFERRABLE INITIALLY DEFERRED,
//     checked at COMMIT so apply's one-field-at-a-time UPDATEs pass), kind,
//     wave, scored, dispatch_host; task_notes carries kind.
//   - machine-local entity: agents (with cwd, base, spawner, host,
//     collected_head), worktrees, task_auto, delegate_calls, human_needs,
//     wait_cursors, wait_registrations, wait_resumes, wait_action_receipts,
//     agent_settles, spawn_receipts, host_profiles, host_channels,
//     remote_recovery
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
// v9 dropped v8's separate change-recording mechanisms (`agent_logs`,
// `snapshots`, `workstream_sync`, the `archived_*` tables) for the one
// **ops log**; sync and history are queries or replays over it
// (docs/VOCABULARY.md § op, ops log, watermark).
//
// The surrogate-INTEGER-PK discipline introduced in v5 is unchanged:
// per docs/architecture/sdk.md § Surrogate-PK and SDK-boundary discipline,
// every entity table has an INTEGER PK; FKs reference INTEGER ids;
// the operator-facing TEXT name is per-scope unique via
// UNIQUE (<scope_id>, <name>). `ops` is the deliberate exception: it
// holds the NATURAL key (`ws/local_id`) in `ops.key`, never a
// surrogate id, which is exactly why keys don't collide across
// machines.
//
// IMPORTANT: there is no migration ladder. openDb accepts only
// CURRENT_SCHEMA_VERSION (13) and completes a v13 file that lacks later
// additions in ONE transaction (upgradeSchema: columns, tables, triggers
// and both stamps together). Every older DB is rejected with
// SchemaTooOldError (exit 4), and a DB newer than this build with
// SchemaTooNewError (exit 4).

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
import { REMOTE_RECOVERY_DDL } from "./db-recovery.js";
import { say } from "./messages.js";
import { defaultStateDir, xdgStateHome } from "./state-dir.js";
import { TASK_SUBSTATE_ROWS } from "./tasks/status.js";

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
 * into ~/.local/state/mu/mu.db (now ~/.local/state/mu-next/mu.db). The guard throws a useful diagnostic
 * the moment the offending openDb() call is made; the failing test's
 * stack trace then names the leak source directly.
 *
 * Test mode = `process.env.VITEST` is defined OR `NODE_ENV === "test"`.
 * vitest sets VITEST="true" in every fork; the NODE_ENV branch is for
 * other runners that may invoke openDb during tests.
 *
 * The user's REAL DB path is computed from HOME / XDG_STATE_HOME
 * directly (NOT from defaultDbPath() — which would honour MU_DB_PATH
 * and produce the temp path the test set, defeating the check).
 * MU_STATE_DIR is deliberately not consulted: test/_setup.ts deletes
 * the user's MU_* vars in every fork, so any MU_STATE_DIR seen here was
 * set by a test to a temp dir (test/disk-recon.test.ts opens
 * <MU_STATE_DIR>/mu.db), and guarding it would refuse that temp DB.
 * Production code paths (the `mu` CLI binary) never set VITEST, so
 * the guard is a complete no-op outside the test runner.
 */
function refuseUserDbDuringTests(path: string): void {
  const inTest = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
  if (!inTest) return;
  const home = process.env.HOME ?? homedir();
  // mu-next's default, and 3.x's: a test must reach neither.
  const realDbs = ["mu-next", "mu"].map((dir) => resolve(join(xdgStateHome(home), dir, "mu.db")));
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
function refuseUnusableStamps(version: number | null, capture: number | null): void {
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
  if (version !== null && version < MIN_ACCEPTED_SCHEMA_VERSION) {
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
 * Exported for the upgrade tests, which wrap `db` to inject a failure.
 */
export function upgradeSchema(db: Db): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = detectExistingSchemaVersion(db);
    refuseUnusableStamps(version, storedCaptureVersion(db));
    if (version !== CURRENT_SCHEMA_VERSION || !schemaIsCurrent(db)) applySchemaDdl(db);
    // Stamp after the DDL, in the same transaction. A fresh DB gets its
    // row here; an older capture stamp is raised to this build.
    db.prepare(
      `INSERT INTO schema_version (id, version) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version`,
    ).run(CURRENT_SCHEMA_VERSION);
    // The triggers mint HLCs from this row.
    seedMachineIdentity(db);
    installCaptureLocked(db);
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

/** The DDL half of upgradeSchema; the caller owns the transaction. */
function applySchemaDdl(db: Db): void {
  db.exec(CURRENT_SCHEMA);
  // Columns a v13 DB written before they existed still lacks.
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
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

/** The states of a task-bound spawn attempt (`spawn_receipts.state`). */
export const SPAWN_RECEIPT_STATES = [
  "reserved",
  "pane",
  "claimed",
  "sending",
  "sent",
  "unknown",
  "failed",
] as const;
export type SpawnReceiptState = (typeof SPAWN_RECEIPT_STATES)[number];

/**
 * Columns added to a table after a v13 DB may already exist, as
 * `[table, column, DDL]`. `CREATE TABLE IF NOT EXISTS` leaves an existing
 * table alone, so applySchema adds each missing one with `ALTER TABLE ADD
 * COLUMN` (idempotent, inside the schema transaction), and schemaIsCurrent
 * reports a DB without one as not current. The DDL must stay a plain
 * nullable/defaulted column: SQLite adds nothing else in place.
 */
const ADDED_COLUMNS: readonly (readonly [table: string, column: string, ddl: string])[] = [
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
  ["wait_registrations", "baselines_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["task_auto", "enabled", "INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))"],
  ...["request", "verdict", "agent"].map((c) => ["delegate_calls", c, "TEXT"] as const),
  // The template's process group, recorded before it runs (hosts.ts).
  ["host_channels", "pgid", "INTEGER"],
  ["host_channels", "pgid_start", "TEXT"],
];

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

/** The schema version a fresh DB starts at. v12 adds the kernel columns
 *  (torn_down_at, cwd, base, scored, dispatch_host, kind), task_auto and
 *  the blockers view on top of v11's task substates; v13 adds the loop's
 *  storage (tasks.kind/wave, agents.spawner/host/collected_head and four
 *  machine-local tables). See CHANGELOG.md. */
export const CURRENT_SCHEMA_VERSION = 13;

/** The lowest schema version `openDb` will accept. There is no ladder:
 *  anything older throws `SchemaTooOldError` (exit 4) and is left
 *  untouched on disk. */
const MIN_ACCEPTED_SCHEMA_VERSION = 13;

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
 *  additive, and an older mu ignores it). Sorted; exactly 26 entries. */
export const EXPECTED_TABLES: readonly string[] = [
  "agent_settles",
  "agents",
  "delegate_calls",
  "host_channels",
  "host_profiles",
  "human_needs",
  "machine_identity",
  "op_ctx",
  "op_dying",
  "ops",
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
export const SYNCED_ENTITIES = ["workstream", "task", "edge", "note", "message"] as const;

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
export const MACHINE_LOCAL_ENTITIES = ["agent", "workspace", "event", "broadcast"] as const;

export type MachineLocalEntity = (typeof MACHINE_LOCAL_ENTITIES)[number];

/** **Portable** tables: their rows mean the same thing on any machine,
 *  so their ops ship. Mirrors docs/VOCABULARY.md § portable exactly. */
export const PORTABLE_TABLES = ["task_edges", "task_notes", "tasks", "workstreams"] as const;

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
 *    agent_settles    settled runs already applied (settle replay).
 *    host_profiles    ssh-free command templates per remote host.
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
  "delegate_calls",
  "host_channels",
  "host_profiles",
  "human_needs",
  "machine_identity",
  "op_ctx",
  "op_dying",
  "ops",
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

// ─── SCHEMA (v13) ───────────────────────────────────────────────────────
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

const CURRENT_SCHEMA = `
-- ─── Schema versioning ────────────────────────────────────────────────
--
-- Single-row table tracking which schema version this DB is at. Migrations
-- read and update this; the row is INSERT-OR-IGNOREd by applySchema with
-- the current version on a fresh DB.
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
  gate_token    TEXT,                           -- remote command gate: spawn-unique token, also the key of its remote result record (machine-local); NULL: not a gate
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
  -- NOT NULL with defaults until flag day: a peer's partial op must be
  -- able to create the row. \`scored\` says whether they were given.
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

-- spawn_receipts: one row per task-bound spawn attempt (machine-local). The
-- journal agent spawn --task writes BEFORE each external effect and that a
-- replay reads back. agent_id/pane_id name the registry incarnation it
-- created and carry NO foreign key on purpose: the receipt must outlive the
-- agent (a deleted or replaced name is "stale", never the replacement).
-- state: reserved (nothing happened yet) < pane (agent row + pane exist)
-- < claimed (task owned by agent_id) < sending (the send MAY have been
-- written: never resend) < sent | unknown; failed = definitely unsent and
-- rolled back. attempt_key is 'manual:<k>' for a manual spawn.
CREATE TABLE IF NOT EXISTS spawn_receipts (
  task_id     INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  attempt_key TEXT NOT NULL,
  name        TEXT NOT NULL,
  workstream  TEXT NOT NULL,
  request_sha TEXT NOT NULL,
  msg_id      TEXT NOT NULL,
  agent_id    INTEGER,
  pane_id     TEXT,
  transport   TEXT CHECK (transport IN ('ctl', 'mux')),
  incarnation TEXT,
  runs        INTEGER,
  state       TEXT NOT NULL
              CHECK (state IN (${sqlList(SPAWN_RECEIPT_STATES)})),
  detail      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, attempt_key)
);

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

-- host_profiles: ssh-free command templates for a remote host
-- (machine-local; mu never connects, it expands these).
CREATE TABLE IF NOT EXISTS host_profiles (
  name         TEXT PRIMARY KEY,
  shell        TEXT NOT NULL,
  exec         TEXT NOT NULL,
  fetch        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  max_sessions INTEGER CHECK (max_sessions > 0)
);

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
