// `mu doctor` exit codes and state counts, end to end through runCli.
//
// f_doctor_fail_row_exit0: a `fail` row (the DB inside MU_SYNC_DIR) used
// to print FAIL and exit 0; it now exits 5 after printing the report,
// in both the human and --json forms. WARN rows still exit 0.
// f_doctor_ops_rows_count: `ops rows` counted only the workstream
// entity's own ops (key = <ws>), not its tasks' (<ws>/<id>).
//
// Fast tier: in-process runCli, per-test temp DB and state dir, mocked
// tmux (so the mux health probe and reconcile never reach a real server).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const STATE_KEY = "MU_STATE_DIR";
const SYNC_KEY = "MU_SYNC_DIR";
const SESSION_KEY = "MU_SESSION";

let tempDir: string;
let dbPath: string;
let mux: MuxHarness;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-doctor-exit-"));
  dbPath = join(tempDir, "mu.db");
  process.env[STATE_KEY] = tempDir;
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "demo");
  // An underscore neighbour: `demo_x/...` must not count toward `demo`.
  ensureWorkstream(db, "demo_x");
  for (const id of ["t1", "t2", "t3"]) {
    addTask(db, { localId: id, workstream: "demo", title: id, impact: 50, effortDays: 1 });
  }
  addTask(db, { localId: "u1", workstream: "demo_x", title: "u1", impact: 50, effortDays: 1 });
  db.close();
  mux = installMux("tmux", [
    ["-V", "tmux 3.4"],
    ["", ""],
  ]);
});

afterEach(() => {
  mux.restore();
  for (const key of [STATE_KEY, SYNC_KEY, SESSION_KEY]) delete process.env[key];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("mu doctor exit code", () => {
  it("exits 0 with no FAIL row", async () => {
    const r = await runCli(["doctor"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode, r.stderr).toBeNull();
    expect(r.stdout).toContain("db-vs-sync");
  });

  it("exits 0 when only a WARN row fires", async () => {
    // An orphan workspace dir is a `warn` in the disk section.
    mkdirSync(join(tempDir, "workspaces", "demo", "ghost"), { recursive: true });
    const r = await runCli(["doctor"], dbPath);
    expect(r.stdout).toContain("ws-dirs");
    expect(r.exitCode, r.stderr).toBeNull();
  });

  it("exits 5 after printing the report when the DB is inside MU_SYNC_DIR", async () => {
    process.env[SYNC_KEY] = tempDir;
    const r = await runCli(["doctor"], dbPath);
    expect(r.exitCode).toBe(5);
    // The whole report is printed before the failure.
    expect(r.stdout).toContain("INSIDE MU_SYNC_DIR");
    expect(r.stdout).toContain("ops log");
    expect(r.stderr).toContain("db-vs-sync");
  });

  it("--json emits the payload, then exits 5 on a FAIL row", async () => {
    process.env[SYNC_KEY] = tempDir;
    const r = await runCli(["doctor", "--json"], dbPath);
    expect(r.exitCode).toBe(5);
    const parsed = JSON.parse(r.stdout.trim().split("\n")[0] ?? "") as {
      fleet: { name: string; severity: string }[];
    };
    expect(parsed.fleet.find((h) => h.name === "db-vs-sync")?.severity).toBe("fail");
  });
});

describe("mu doctor state counts", () => {
  it("ops rows counts the workstream's task ops, not only its own row", async () => {
    process.env[SESSION_KEY] = "demo";
    const db = openDb({ path: dbPath });
    const expected = (
      db.prepare("SELECT COUNT(*) AS n FROM ops WHERE key = 'demo' OR key LIKE 'demo/%'").get() as {
        n: number;
      }
    ).n;
    db.close();
    // workstream op + 3 task ops at least; demo_x's ops excluded.
    expect(expected).toBeGreaterThanOrEqual(4);

    const r = await runCli(["doctor", "--json"], dbPath);
    expect(r.exitCode, r.stderr).toBeNull();
    const parsed = JSON.parse(r.stdout.trim()) as { state: { logs: number; tasks: number } };
    expect(parsed.state.tasks).toBe(3);
    expect(parsed.state.logs).toBe(expected);

    const human = await runCli(["doctor"], dbPath);
    expect(human.stdout).toMatch(new RegExp(`ops rows\\s+: ${expected}\\b`));
  });
});
