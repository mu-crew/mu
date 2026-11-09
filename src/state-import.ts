// mu — the state import (spec D5): mu 5's one-shot copy of mu 4's
// `<state home>/mu-next/mu.db` into `<state home>/mu5/mu.db`.
//
// Schema 14 broke on-disk compatibility, so mu 5 keeps its state in `mu5`
// and every mu 4 build refuses a v14 file (SchemaTooNewError, exit 4). On
// the first open of the default DB, when `mu5/mu.db` is missing and
// `mu-next/mu.db` exists, handle() runs `importStateIfDue` once:
//
//   1. take the strict lock `mu5/locks/import` (src/file-lock.ts; reclaimed
//      only from a proven-dead pid). A second process waits, then finds
//      `mu5/mu.db` and opens it;
//   2. if `mu5/mu.db` exists, stop: nothing is replaced;
//   3. check nothing on the source: every check runs on the snapshot (5.3);
//   4. copy `mu-next/mu.db` with SQLite's backup API to `mu5/mu.db.importing`;
//   5. on the copy: (1) a new `machine_id`, so mu 4 and mu 5 are two sync
//      peers; (2) today's v13 upgrade in its own transaction; (3) in one
//      immediate transaction, refuse on unpublished ops or live rows, else
//      the 13 -> 14 step;
//   6. link the copy to `mu5/mu.db` (link(2) never replaces), unlink the
//      temporary name, release the lock.
//
// `mu-next` is never written: the source is opened read-only. The copy is
// invisible until step 6, so the link is the commit point. A crash before
// it leaves only the `.importing` file, which the next lock holder deletes
// and redoes. A refusal deletes the copy itself.
//
// This module is a leaf: db.ts never imports it (segments.ts reads db.ts
// exports at load time, so db.ts importing this would be a cycle).

import { randomUUID } from "node:crypto";
import { existsSync, linkSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { type Db, SchemaTooNewError, SchemaTooOldError, upgradeSchema, V13 } from "./db.js";
import { TERMINAL_DELEGATE_STATES } from "./delegates.js";
import { withFileLock } from "./file-lock.js";
import { countUnpublishedOps, syncDir } from "./segments.js";
import { dueStateImport } from "./state-dir.js";

/** The schema the 13 -> 14 step stamps. Not CURRENT_SCHEMA_VERSION: a later
 *  schema needs its own step, never this one stamping it. */
const V14 = 14;

/** How long a second first-open waits for the importing process. */
const DEFAULT_LOCK_WAIT_MS = 10 * 60_000;

/** The steps a test can crash before (`onStep`), in order. */
export type ImportStep = "copy" | "machine-id" | "upgrade" | "check" | "link";

export interface ImportOptions {
  /** The sync folder the unpublished-op check reads; default MU_SYNC_DIR. */
  syncDir?: string | null;
  /** How long to wait for another importer's lock. */
  lockWaitMs?: number;
  /** Test seam, run before each step with the copy's path. A throw is a
   *  crash: nothing is cleaned up. */
  onStep?: (step: ImportStep, copy: string) => void;
}

export type ImportResult =
  | { status: "imported"; previousMachineId: string | null; machineId: string }
  /** `mu5/mu.db` existed (another process imported it): nothing was done. */
  | { status: "exists" };

/** The snapshot holds what mu 5 must not take over. Exit 4; the copy is gone
 *  and `mu-next` untouched, so running mu 5 again after the fix imports. */
export class StateImportRefusedError extends Error {
  override readonly name = "StateImportRefusedError";
  constructor(
    public readonly source: string,
    public readonly reasons: readonly string[],
  ) {
    super(
      `mu 5 did not import ${source} (it is untouched): ${reasons.join("; ")}. Then run mu 5 again.`,
    );
  }
}

/** Another process holds the import lock past the wait. Exit 4. */
export class StateImportBusyError extends Error {
  override readonly name = "StateImportBusyError";
  constructor(public readonly lockPath: string) {
    super(
      `another mu holds the state import lock ${lockPath}; run again once it finishes (a dead holder's lock is reclaimed)`,
    );
  }
}

/** Run the import when it is due (spec D5); null when it is not. One stderr
 *  line when it imported, so `--json` stdout stays clean. */
export async function importStateIfDue(): Promise<ImportResult | null> {
  const due = dueStateImport();
  if (due === null) return null;
  const result = await importState(due.source, due.target);
  if (result.status === "imported") {
    process.stderr.write(
      `mu: imported ${due.source} into ${due.target} (mu 5's state; mu 4's is untouched)\n`,
    );
  }
  return result;
}

/** The import, steps 1 to 6 (see the header). */
export async function importState(
  source: string,
  target: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const lockPath = join(dirname(target), "locks", "import");
  return await withFileLock(lockPath, "state-import", () => importLocked(source, target, opts), {
    strict: true,
    staleLockMs: 0,
    acquireTimeoutMs: opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    onUnavailable: () => {
      throw new StateImportBusyError(lockPath);
    },
  });
}

/** The copy's files: the DB and the journal or WAL sidecars a crash may leave. */
const copyFiles = (copy: string): string[] => [
  copy,
  `${copy}-journal`,
  `${copy}-wal`,
  `${copy}-shm`,
];
const removeCopy = (copy: string): void => {
  for (const f of copyFiles(copy)) rmSync(f, { force: true });
};

async function importLocked(
  source: string,
  target: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  const copy = `${target}.importing`;
  const step = (s: ImportStep): void => opts.onStep?.(s, copy);
  // A crashed holder's leftover; only the lock holder may delete it.
  removeCopy(copy);
  if (existsSync(target)) return { status: "exists" };

  step("copy");
  const src = new Database(source, { readonly: true, fileMustExist: true });
  try {
    src.pragma("busy_timeout = 5000");
    await src.backup(copy);
  } finally {
    src.close();
  }

  let ids: { previous: string | null; next: string };
  const db = new Database(copy);
  try {
    // Work in rollback-journal mode: the copy is then one file, which step 6 links whole.
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    ids = convert(db, step, source, opts.syncDir === undefined ? syncDir() : opts.syncDir);
  } catch (err) {
    db.close();
    if (isRefusal(err)) removeCopy(copy);
    throw err;
  }
  db.close();

  step("link");
  try {
    linkSync(copy, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Made outside the lock (an explicit MU_DB_PATH): never replaced.
    removeCopy(copy);
    return { status: "exists" };
  }
  rmSync(copy);
  return { status: "imported", previousMachineId: ids.previous, machineId: ids.next };
}

/** Step 5 on the open copy; returns the old and new machine ids. */
function convert(
  db: Db,
  step: (s: ImportStep) => void,
  source: string,
  dir: string | null,
): { previous: string | null; next: string } {
  const version = schemaVersion(db);
  if (version !== V13) {
    throw version !== null && version > V13
      ? new SchemaTooNewError(version, V13)
      : new SchemaTooOldError(version ?? 0, V13);
  }

  // 5.1: an UPDATE, since the upgrade's seed does nothing on an existing row.
  step("machine-id");
  const previous =
    (
      db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as
        | { machine_id: string }
        | undefined
    )?.machine_id ?? null;
  const next = randomUUID();
  db.prepare(
    "UPDATE machine_identity SET machine_id = ?, hostname = ?, created_at = ? WHERE id = 1",
  ).run(next, hostname(), new Date().toISOString());

  // 5.2: today's v13 upgrade, in its own transaction (it stays v13).
  step("upgrade");
  upgradeSchema(db, { v13: true });

  // 5.3: check the snapshot and take the 13 -> 14 step, in one transaction.
  step("check");
  db.exec("BEGIN IMMEDIATE");
  try {
    const reasons = refusals(db, previous, dir);
    if (reasons.length > 0) throw new StateImportRefusedError(source, reasons);
    step13To14(db);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { previous, next: currentMachineId(db) ?? next };
}

/** Why the snapshot cannot be imported; empty when it can. */
function refusals(db: Db, previous: string | null, dir: string | null): string[] {
  const reasons: string[] = [];
  // Segments publish only their own machine's ops, so mu 5 (a new machine id)
  // would never publish these. Checked on the snapshot: an op mu 4 committed
  // after the backup started is not in it, and is mu 4's to publish.
  if (dir !== null && previous !== null) {
    const n = countUnpublishedOps(db, dir, previous);
    if (n > 0) {
      reasons.push(
        `${n} op(s) of machine ${previous} are not yet in its segment in ${dir}: run \`mu sync\` with mu 4 first`,
      );
    }
  }
  // These rows own files under mu-next (control sockets, job files, locks,
  // delegate process files): mu 4 closes them.
  const count = (sql: string, ...args: string[]): number =>
    (db.prepare(sql).get(...args) as { n: number }).n;
  const agents = count("SELECT COUNT(*) AS n FROM agents");
  const jobs = count("SELECT COUNT(*) AS n FROM carrier_jobs");
  const delegates = count(
    `SELECT COUNT(*) AS n FROM delegate_calls
      WHERE state NOT IN (${TERMINAL_DELEGATE_STATES.map(() => "?").join(", ")})`,
    ...TERMINAL_DELEGATE_STATES,
  );
  if (agents + jobs + delegates > 0) {
    reasons.push(
      `it still holds ${agents} agent(s), ${jobs} lease reservation(s) and ${delegates} unfinished delegate call(s): close them with mu 4 first`,
    );
  }
  return reasons;
}

/**
 * The 13 -> 14 step (spec D5), inside the check's transaction. Today it is
 * the stamp: schema 14 is the v13 shape. The plugin units add their
 * column-list rebuilds here (carrier_jobs, spawn_receipts, remote_recovery,
 * host_profiles) and their tables to CURRENT_SCHEMA.
 */
export function step13To14(db: Db): void {
  const changed = db
    .prepare("UPDATE schema_version SET version = ? WHERE id = 1 AND version = ?")
    .run(V14, V13).changes;
  if (changed !== 1) throw new Error("the 13 -> 14 step needs a v13 file");
}

function schemaVersion(db: Db): number | null {
  try {
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
      | { version: number }
      | undefined;
    return row?.version ?? null;
  } catch {
    return null; // no schema_version table: older than every versioned mu
  }
}

function currentMachineId(db: Db): string | null {
  const row = db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as
    | { machine_id: string }
    | undefined;
  return row?.machine_id ?? null;
}

const isRefusal = (err: unknown): boolean =>
  err instanceof StateImportRefusedError ||
  err instanceof SchemaTooOldError ||
  err instanceof SchemaTooNewError;
