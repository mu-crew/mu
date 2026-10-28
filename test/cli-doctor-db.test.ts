// `mu doctor` db block: page integrity (`--deep` runs PRAGMA quick_check),
// missing tables, schema_version drift, foreign_keys. rr_r6_doctor_integrity_gap:
// the README promised "integrity" and no test pinned the block at all.
//
// Fast tier: in-process runCli, per-test temp DB, mocked tmux.

import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, type Db, openDb } from "../src/db.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson, runCli as runCliRaw } from "./_runCli.js";

const STATE_KEY = "MU_STATE_DIR";

interface DbData {
  db: {
    schema: { ok: boolean; missing: string[] };
    schemaVersion: { value: number | null; expected: number; status: string };
    integrity: { mode: string; ok: boolean | null; problems: string[] };
    journalMode: string;
    foreignKeys: boolean;
  };
}

const runCli = async (args: string[], db: string) => {
  const r = await runCliRaw(args, db);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips colour codes
  return { ...r, stdout: r.stdout.replace(/\u001b\[[0-9;]*m/g, "") };
};

let tempDir: string;
let dbPath: string;
let mux: MuxHarness;

/** `cmdDoctorJson` on an already-open handle (openDb itself would refuse these DBs). */
async function doctorData(db: Db): Promise<DbData> {
  const { cmdDoctorJson } = await import("../src/cli/doctor.js");
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    await cmdDoctorJson(db, {});
  } catch {
    // a failing document (drift on the doctored DB) still carries the report
  } finally {
    console.log = log;
  }
  return (JSON.parse(lines.join("")) as { data: DbData }).data;
}

/** Run `fn` on a raw connection (no mu hooks, unsafe so it may rewrite the schema). */
function raw(fn: (d: Database.Database) => void): void {
  const d = new Database(dbPath);
  try {
    d.unsafeMode(true);
    fn(d);
  } finally {
    d.close();
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-doctor-db-"));
  dbPath = join(tempDir, "mu.db");
  process.env[STATE_KEY] = tempDir;
  openDb({ path: dbPath }).close();
  mux = installMux("tmux", [
    ["-V", "tmux 3.4"],
    ["", ""],
  ]);
});

afterEach(() => {
  mux.restore();
  delete process.env[STATE_KEY];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("mu doctor db block", () => {
  it("a healthy DB: schema ok, version current, foreign keys on, integrity skipped without --deep", async () => {
    const r = await runCliJson<DbData>(["doctor", "--json"], dbPath);
    expect(r.exitCode, r.stderr).toBeNull();
    expect(r.data.db.schema).toMatchObject({ ok: true, missing: [] });
    expect(r.data.db.schemaVersion).toEqual({
      value: CURRENT_SCHEMA_VERSION,
      expected: CURRENT_SCHEMA_VERSION,
      status: "ok",
    });
    expect(r.data.db.foreignKeys).toBe(true);
    expect(r.data.db.journalMode).toBe("wal");
    expect(r.data.db.integrity).toEqual({ mode: "skipped", ok: null, problems: [] });
  });

  it("housekeeping: delegates-old is quiet with none, a note with the prune commands otherwise", async () => {
    type Hk = {
      housekeeping: { oldDelegates: { name: string; severity: string; remediation: string[] } };
    };
    const quiet = await runCliJson<Hk>(["doctor", "--json"], dbPath);
    expect(quiet.data.housekeeping.oldDelegates).toMatchObject({
      name: "delegates-old",
      severity: "ok",
      remediation: [],
    });
    const db = openDb({ path: dbPath });
    try {
      const { registerDelegateCall, finishDelegate } = await import("../src/delegates.js");
      registerDelegateCall(db, {
        callId: "c",
        caller: "pi:s",
        workstream: "scratch",
        request: { text: "x", label: "c" },
        state: "starting",
      });
      finishDelegate(db, "c", { outcome: "done", text: "VERDICT: CONFIRMED", author: "d" });
      db.prepare(
        "UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'delegate'",
      ).run();
    } finally {
      db.close();
    }
    const noted = await runCliJson<Hk>(["doctor", "--json"], dbPath);
    expect(noted.exitCode, noted.stderr).toBeNull();
    expect(noted.data.housekeeping.oldDelegates.remediation.join("\n")).toContain(
      "mu delegates prune --yes",
    );
    const human = await runCli(["doctor"], dbPath);
    expect(human.stdout).toMatch(
      /delegates-old\s+: note 1 closed delegate task\(s\) older than 30 days/,
    );
    expect(human.stdout).toContain("mu delegates prune              # dry run");
  });

  it("--deep runs quick_check and reports ok", async () => {
    const r = await runCliJson<DbData>(["doctor", "--deep", "--json"], dbPath);
    expect(r.exitCode, r.stderr).toBeNull();
    expect(r.data.db.integrity).toEqual({ mode: "deep", ok: true, problems: [] });
    const human = await runCli(["doctor", "--deep"], dbPath);
    expect(human.stdout).toMatch(/integrity\s+: ok \(quick_check\)/);
    const shallow = await runCli(["doctor"], dbPath);
    expect(shallow.stdout).toMatch(/integrity\s+: skipped \(run `mu doctor --deep`/);
  });

  it("a schema_version row changed after open shows as future", async () => {
    const db = openDb({ path: dbPath });
    try {
      db.prepare("UPDATE schema_version SET version = 99 WHERE id = 1").run();
      expect((await doctorData(db)).db.schemaVersion).toMatchObject({
        value: 99,
        status: "future",
      });
    } finally {
      db.close();
    }
  });

  it("a missing table is named in the schema row, and foreign_keys off shows", async () => {
    const db = openDb({ path: dbPath });
    try {
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TABLE wait_resumes");
      const { db: report } = await doctorData(db);
      expect(report.schema.ok).toBe(false);
      expect(report.schema.missing).toEqual(["wait_resumes"]);
      expect(report.foreignKeys).toBe(false);
    } finally {
      db.close();
    }
  });

  it("--deep on a DB with a corrupt index fails: exit 5, integrity row names quick_check problems", async () => {
    // Overwrite one index's root page with garbage (schema untouched, so the DB
    // still opens): page-level damage only quick_check finds.
    let root = 0;
    let pageSize = 0;
    raw((d) => {
      d.pragma("journal_mode = DELETE");
      root = (
        d.prepare("SELECT rootpage AS r FROM sqlite_master WHERE name = 'idx_ops_hlc'").get() as {
          r: number;
        }
      ).r;
      pageSize = d.pragma("page_size", { simple: true }) as number;
    });
    const fd = openSync(dbPath, "r+");
    try {
      writeSync(fd, Buffer.alloc(pageSize, 0xab), 0, pageSize, (root - 1) * pageSize);
    } finally {
      closeSync(fd);
    }
    const json = await runCliJson<DbData>(["doctor", "--deep", "--json"], dbPath);
    expect(json.exitCode).toBe(5);
    expect(json.data.db.integrity.ok).toBe(false);
    expect(json.data.db.integrity.problems.length).toBeGreaterThan(0);
    const human = await runCli(["doctor", "--deep"], dbPath);
    expect(human.exitCode).toBe(5);
    expect(human.stdout).toMatch(/integrity\s+: FAIL \(quick_check\)/);
    // Without --deep the page walk is skipped, so the shallow doctor does not trip on it.
    const shallow = await runCliJson<DbData>(["doctor", "--json"], dbPath);
    expect(shallow.data.db.integrity.mode).toBe("skipped");
  });
});
