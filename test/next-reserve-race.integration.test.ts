// reserveAttempt across PROCESSES (v_exec_dispatch round 2). One thread cannot
// show the IMMEDIATE transaction matters (sync transactions serialise there),
// so N node processes reserve the same tasks at the same instant against one
// DB file. Needs `dist/` (npm run build first), like spawn-parallel-race.
//
// Without `.immediate()` and the run-counter CAS, a deferred read-then-write
// transaction throws SQLITE_BUSY (_SNAPSHOT) out of reserveAttempt.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { authorizeTasks } from "../src/task-auto.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const execFileP = promisify(execFile);
const DIST = join(process.cwd(), "dist", "index.js");
const describeIfBuilt = existsSync(DIST) ? describe : describe.skip;

const CHILD = `
const { openDb, reserveAttempt } = await import(process.env.MU_DIST);
const db = openDb({ path: process.env.MU_DB_PATH });
const tasks = JSON.parse(process.env.MU_TASKS);
const at = Number(process.env.MU_AT);
while (Date.now() < at) {}
const out = [];
for (const t of tasks) {
  try {
    const r = reserveAttempt(db, "d", t);
    out.push({ t, ok: r.ok, code: r.ok ? undefined : r.code });
  } catch (e) {
    out.push({ t, error: String(e && e.message) });
  }
}
console.log(JSON.stringify(out));
`;

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-resrace-"));
  dbPath = join(dir, "mu.db");
});
afterEach(() => rmFixtureDir(dir));

describeIfBuilt("reserveAttempt, real cross-process race", () => {
  it("4 processes x 40 tasks at once: exactly one reservation and one charge per task, no errors", async () => {
    const tasks = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "d");
    for (const t of tasks) {
      addTask(db, { workstream: "d", localId: t, title: t });
      addNote(db, t, `brief ${t}`, { workstream: "d", kind: "brief", author: "o" });
      authorizeTasks(db, [t], { workstream: "d", cli: "pi", worktree: false, maxRuns: 5 });
    }
    db.close();
    const at = Date.now() + 1500;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        execFileP("node", ["--input-type=module", "-e", CHILD], {
          env: {
            ...process.env,
            MU_DB_PATH: dbPath,
            MU_DIST: DIST,
            MU_TASKS: JSON.stringify(tasks),
            MU_AT: String(at),
            MU_SYNC_DIR: "",
          },
          maxBuffer: 1 << 24,
        }).then(
          (r) =>
            JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "[]") as Record<string, unknown>[],
        ),
      ),
    );
    const flat = results.flat();
    expect(flat.filter((r) => r.error !== undefined)).toEqual([]);
    for (const t of tasks) {
      expect(flat.filter((r) => r.t === t && r.ok === true)).toHaveLength(1);
    }
    const check = openDb({ path: dbPath });
    try {
      const rows = check.prepare("SELECT runs FROM task_auto").all() as { runs: number }[];
      expect(rows).toHaveLength(40);
      expect(rows.every((r) => r.runs === 1)).toBe(true);
      const receipts = check.prepare("SELECT attempt_key FROM spawn_receipts").all() as {
        attempt_key: string;
      }[];
      expect(receipts).toHaveLength(40);
      expect(receipts.every((r) => r.attempt_key === "auto:1")).toBe(true);
    } finally {
      check.close();
    }
  }, 60_000);
});
