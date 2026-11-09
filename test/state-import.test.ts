// The state import (spec D5, unit P6a): mu 5's one-shot copy of mu 4's
// `mu-next/mu.db` into `mu5/mu.db`. Every step and refusal of D5 has a test
// here: the lock, refuse-if-exists, unpublished ops, live rows, the new
// machine_id before the upgrade, the no-replace link, a crash leaving only
// `.importing`, and `mu-next` untouched by every outcome.
//
// The source is the populated v13 fixture (test/fixtures/v13-populated.db.gz,
// a real mu 4 file) with its one agent row cleared, unless a test wants it.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, openDb, SchemaTooNewError, SchemaTooOldError } from "../src/db.js";
import { CARRIER_JOBS_DDL } from "../src/db-carrier.js";
import { checkDrift } from "../src/drift.js";
import { flushSegment } from "../src/segments.js";
import { refusePendingStateImport, StateImportPendingError } from "../src/state-dir.js";
import {
  type ImportStep,
  importState,
  importStateIfDue,
  StateImportBusyError,
  StateImportRefusedError,
} from "../src/state-import.js";
import { addTask } from "../src/tasks/edit.js";
import { listTasks } from "../src/tasks.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

const FIXTURE_MACHINE = "a9e6c350-628d-4ed5-a04f-9e226e1bb4cf";

let root: string;
let source: string;
let target: string;
let copy: string;
let lock: string;
let sourceSha: string;

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function raw<T>(path: string, fn: (db: Database.Database) => T): T {
  const r = new Database(path);
  try {
    return fn(r);
  } finally {
    r.close();
  }
}

/** Write the mu 4 source; `edit` runs on it before its hash is taken. */
function writeSource(edit?: (r: Database.Database) => void, opts: { agents?: boolean } = {}): void {
  writeFileSync(
    source,
    gunzipSync(readFileSync(join(__dirname, "fixtures", "v13-populated.db.gz"))),
  );
  raw(source, (r) => {
    if (opts.agents !== true) r.exec("DELETE FROM agents");
    edit?.(r);
  });
  sourceSha = sha(source);
}

/** mu-next is never written: the DB file is byte-identical, and nothing but
 *  SQLite's own reader sidecars (-wal/-shm) appeared beside it. */
function expectSourceUntouched(): void {
  expect(sha(source)).toBe(sourceSha);
  const extra = readdirSync(join(root, "mu-next")).filter(
    (f) => !["mu.db", "mu.db-wal", "mu.db-shm"].includes(f),
  );
  expect(extra).toEqual([]);
}

/** A refusal leaves no mu 5 DB, no copy and no lock. */
function expectNothingImported(): void {
  expect(existsSync(target)).toBe(false);
  expect(existsSync(copy)).toBe(false);
  expect(existsSync(lock)).toBe(false);
  expectSourceUntouched();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mu-state-import-"));
  mkdirSync(join(root, "mu-next"));
  source = join(root, "mu-next", "mu.db");
  target = join(root, "mu5", "mu.db");
  copy = `${target}.importing`;
  lock = join(root, "mu5", "locks", "import");
  writeSource();
});
afterEach(() => rmFixtureDir(root));

describe("a successful import", () => {
  it("copies mu 4's DB to a v14 mu5/mu.db with every row, a new machine_id, no temporary file or lock", async () => {
    const result = await importState(source, target, { syncDir: null });
    expect(result).toMatchObject({ status: "imported", previousMachineId: FIXTURE_MACHINE });
    if (result.status !== "imported") throw new Error("expected an import");
    expect(result.machineId).not.toBe(FIXTURE_MACHINE);
    expect(readdirSync(join(root, "mu5")).sort()).toEqual(["locks", "mu.db"]);
    expect(existsSync(lock)).toBe(false);
    expectSourceUntouched();

    const db = openDb({ path: target });
    try {
      expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({
        version: CURRENT_SCHEMA_VERSION,
      });
      expect(CURRENT_SCHEMA_VERSION).toBe(14);
      expect(db.prepare("SELECT machine_id FROM machine_identity").get()).toEqual({
        machine_id: result.machineId,
      });
      expect(listTasks(db)).toHaveLength(4);
      expect(checkDrift(db).clean).toBe(true);
      // mu 5 is its own sync peer: what it writes carries the new id, and the
      // imported history keeps mu 4's.
      addTask(db, { localId: "after", title: "after the import", workstream: "alpha" });
      const ids = db
        .prepare("SELECT DISTINCT machine_id FROM ops ORDER BY seq")
        .all()
        .map((r) => (r as { machine_id: string }).machine_id);
      expect(ids).toEqual([FIXTURE_MACHINE, result.machineId]);
    } finally {
      db.close();
    }
  });

  it("mints the new machine_id before the v13 upgrade runs", async () => {
    const seen: Partial<Record<ImportStep, string>> = {};
    await importState(source, target, {
      syncDir: null,
      onStep: (step, path) => {
        if (step === "upgrade" || step === "check") {
          seen[step] = raw(path, (r) => {
            const row = r.prepare("SELECT machine_id FROM machine_identity").get();
            return (row as { machine_id: string }).machine_id;
          });
        }
      },
    });
    expect(seen.upgrade).toBeDefined();
    expect(seen.upgrade).not.toBe(FIXTURE_MACHINE);
    expect(seen.check).toBe(seen.upgrade);
  });

  it("importStateIfDue imports the state home's mu-next once, and only without MU_STATE_DIR or MU_DB_PATH", async () => {
    await withEnv("XDG_STATE_HOME", root, async () => {
      await withEnv("MU_STATE_DIR", join(root, "elsewhere"), async () => {
        expect(await importStateIfDue()).toBeNull();
      });
      await withEnv("MU_DB_PATH", join(root, "x.db"), async () => {
        expect(await importStateIfDue()).toBeNull();
      });
      expect(existsSync(target)).toBe(false);
      expect(await importStateIfDue()).toMatchObject({ status: "imported" });
      expect(await importStateIfDue()).toBeNull();
    });
    expect(existsSync(target)).toBe(true);
    expectSourceUntouched();
  });

  it("openDb refuses mu 5's default DB while the import is due, so nothing creates an empty one", async () => {
    await withEnv("XDG_STATE_HOME", root, async () => {
      expect(() => refusePendingStateImport(target)).toThrow(StateImportPendingError);
      refusePendingStateImport(join(root, "other.db"));
      await importState(source, target, { syncDir: null });
      refusePendingStateImport(target);
    });
  });
});

describe("refusals", () => {
  it("never replaces an existing mu5/mu.db: it reports it and reads nothing", async () => {
    mkdirSync(join(root, "mu5"));
    writeFileSync(target, "theirs");
    expect(await importState(source, target, { syncDir: null })).toEqual({ status: "exists" });
    expect(readFileSync(target, "utf8")).toBe("theirs");
    expect(existsSync(copy)).toBe(false);
    expectSourceUntouched();
  });

  it("refuses while an op of mu 4's machine is not in its segment, checked against the old machine_id", async () => {
    const sync = join(root, "sync");
    mkdirSync(sync);
    const err = await importState(source, target, { syncDir: sync }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateImportRefusedError);
    // Clearing the agent row set its claimed task's owner to NULL: a 12th op.
    expect((err as Error).message).toContain(`12 op(s) of machine ${FIXTURE_MACHINE}`);
    expect((err as Error).message).toContain("mu sync");
    expectNothingImported();
  });

  it("imports once every op is published, and with no sync folder at all", async () => {
    const sync = join(root, "sync");
    mkdirSync(sync);
    // mu 4 publishes its ops (a raw handle: the flush only reads the DB).
    const r = new Database(source, { readonly: true });
    try {
      expect((await flushSegment(r, sync)).appended).toBe(12);
    } finally {
      r.close();
    }
    expectSourceUntouched();
    expect(await importState(source, target, { syncDir: sync })).toMatchObject({
      status: "imported",
    });
    expectSourceUntouched();
  });

  it("refuses a snapshot that still holds an agent row", async () => {
    writeSource(undefined, { agents: true });
    const err = await importState(source, target, { syncDir: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateImportRefusedError);
    expect((err as Error).message).toContain("1 agent(s), 0 lease reservation(s)");
    expectNothingImported();
  });

  it("refuses a snapshot that still holds a lease reservation", async () => {
    writeSource((r) => {
      r.exec(CARRIER_JOBS_DDL);
      r.exec(
        "INSERT INTO carrier_jobs (token, workstream, name, host, host_stop, created_at) VALUES ('t', 'alpha', 'w', 'h', 'stop {job}', 'now')",
      );
    });
    const err = await importState(source, target, { syncDir: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateImportRefusedError);
    expect((err as Error).message).toContain("0 agent(s), 1 lease reservation(s)");
    expectNothingImported();
  });

  const delegate = (state: string) => (r: Database.Database) => {
    const task = r.prepare("SELECT id FROM tasks LIMIT 1").get() as { id: number };
    r.prepare(
      "INSERT INTO delegate_calls (task_id, caller, call_id, state, updated_at) VALUES (?, 'c', 'k', ?, 'now')",
    ).run(task.id, state);
  };

  it("refuses an unfinished delegate call, and imports a finished one", async () => {
    for (const state of ["queued", "running", "refused"]) {
      writeSource(delegate(state));
      const err = await importState(source, target, { syncDir: null }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StateImportRefusedError);
      expect((err as Error).message).toContain("1 unfinished delegate call(s)");
      expectNothingImported();
    }
    writeSource(delegate("done"));
    expect(await importState(source, target, { syncDir: null })).toMatchObject({
      status: "imported",
    });
  });

  it("names every reason at once", async () => {
    writeSource(undefined, { agents: true });
    const sync = join(root, "sync");
    mkdirSync(sync);
    const err = (await importState(source, target, { syncDir: sync }).catch((e: unknown) => e)) as {
      reasons: string[];
    };
    expect(err.reasons).toHaveLength(2);
  });

  it("refuses a source that is not mu 4's schema, older or newer", async () => {
    for (const [version, type] of [
      [12, SchemaTooOldError],
      [14, SchemaTooNewError],
    ] as const) {
      writeSource((r) => r.prepare("UPDATE schema_version SET version = ?").run(version));
      await expect(importState(source, target, { syncDir: null })).rejects.toThrow(type);
      expectNothingImported();
    }
  });
});

describe("crash safety", () => {
  it("never replaces a mu5/mu.db that appeared before the link (no-replace link)", async () => {
    const result = await importState(source, target, {
      syncDir: null,
      onStep: (step) => {
        if (step === "link") writeFileSync(target, "racer");
      },
    });
    expect(result).toEqual({ status: "exists" });
    expect(readFileSync(target, "utf8")).toBe("racer");
    expect(existsSync(copy)).toBe(false);
    expectSourceUntouched();
  });

  for (const at of ["machine-id", "upgrade", "check", "link"] as const) {
    it(`a crash before the ${at} step leaves only .importing, which the next run deletes and redoes`, async () => {
      await expect(
        importState(source, target, {
          syncDir: null,
          onStep: (step) => {
            if (step === at) throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
      expect(existsSync(target)).toBe(false);
      const left = readdirSync(join(root, "mu5")).filter((f) => f !== "locks");
      expect(left).toEqual(["mu.db.importing"]);
      expectSourceUntouched();

      expect(await importState(source, target, { syncDir: null })).toMatchObject({
        status: "imported",
      });
      expect(readdirSync(join(root, "mu5")).sort()).toEqual(["locks", "mu.db"]);
      const db = openDb({ path: target });
      expect(listTasks(db)).toHaveLength(4);
      db.close();
    });
  }

  it("a crash before the copy leaves nothing at all", async () => {
    await expect(
      importState(source, target, {
        syncDir: null,
        onStep: (step) => {
          if (step === "copy") throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(copy)).toBe(false);
  });
});

describe("the import lock", () => {
  const holdLock = (pid: number): void => {
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "meta.json"),
      JSON.stringify({ pid, label: "state-import", acquiredAt: "then", token: "held" }),
    );
  };

  it("parallel first opens import once: the second waits, then finds mu5/mu.db", async () => {
    const results = await Promise.all([
      importState(source, target, { syncDir: null }),
      importState(source, target, { syncDir: null }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["exists", "imported"]);
    expect(readdirSync(join(root, "mu5")).sort()).toEqual(["locks", "mu.db"]);
  });

  it("waits for a live holder and gives up untouched", async () => {
    holdLock(process.pid);
    await expect(importState(source, target, { syncDir: null, lockWaitMs: 50 })).rejects.toThrow(
      StateImportBusyError,
    );
    expect(existsSync(target)).toBe(false);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(lock)).toBe(true); // the holder's, never removed
    expectSourceUntouched();
  });

  it("reclaims a dead holder's lock and deletes its leftover copy", async () => {
    holdLock(0x7ffffff0); // no such pid
    writeFileSync(copy, "half a copy");
    expect(await importState(source, target, { syncDir: null, lockWaitMs: 50 })).toMatchObject({
      status: "imported",
    });
    expect(readdirSync(join(root, "mu5")).sort()).toEqual(["locks", "mu.db"]);
  });
});
