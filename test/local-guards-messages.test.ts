// k_local_guards round 2: what the agent READS when a guard refuses. One
// line, exit code per family, and the exact next command. Driven through
// the CLI (runCli) so the stderr line counts are the real ones.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { checkCloseGuards } from "../src/fleet-hazards.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let path: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-guard-msgs-"));
  path = join(dir, "mu.db");
  db = openDb({ path });
  ensureWorkstream(db, "demo");
  for (const id of ["t", "blocker"]) {
    addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
  }
  insertAgent(db, { name: "w1", workstream: "demo", paneId: "%1" });
  insertAgent(db, { name: "w2", workstream: "demo", paneId: "%2" });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const lines = (s: string): string[] => s.split("\n").filter((l) => l.trim() !== "");
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const sql = async (stmt: string) => {
  db.close();
  const r = await runCli(["sql", "--write", "--table", stmt], path);
  db = openDb({ path });
  return r;
};
const sqlJson = async (stmt: string) => {
  db.close();
  const r = await runCliJson(["sql", "--write", stmt], path);
  db = openDb({ path });
  return r;
};

describe("mu sql: a guard's RAISE is a typed error with the next command (a missing reason is exit 2)", () => {
  it("single statement: close with no close note", async () => {
    const r = await sql("UPDATE tasks SET status='CLOSED', substate='done' WHERE local_id='t'");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("mu task close <id> -w <ws> --evidence");
    expect(count("SELECT COUNT(*) n FROM tasks WHERE status='CLOSED'")).toBe(0);
  });

  it("--json names the typed error, not SqliteError", async () => {
    const r = await sqlJson("UPDATE tasks SET status='CLOSED', substate='done' WHERE local_id='t'");
    expect(r.exitCode).toBe(2);
    expect(r.doc).toMatchObject({ error: "CloseNeedsEvidenceError", exit: 2 });
  });

  it("multi statement: a note first, then a close over an open blocker; all rolled back", async () => {
    addBlockEdge(db, "demo", "t", "blocker");
    const notes = count("SELECT COUNT(*) n FROM task_notes");
    const r = await sql(
      `INSERT INTO task_notes (task_id, content, kind, author, created_at)
         SELECT id, 'CLOSE: x', 'close', 'me', '2026-01-01T00:00:00.000Z' FROM tasks WHERE local_id='t';
       UPDATE tasks SET status='CLOSED', substate='done' WHERE local_id='t';`,
    );
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("open blockers");
    expect(r.stderr).toContain("mu task tree <id> -w <ws>");
    expect(count("SELECT COUNT(*) n FROM task_notes")).toBe(notes);
    expect(count("SELECT COUNT(*) n FROM tasks WHERE status='CLOSED'")).toBe(0);
  });

  it("owner moved from one agent to another", async () => {
    db.prepare(
      "UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name='w1') WHERE local_id='t'",
    ).run();
    const r = await sql(
      "UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name='w2') WHERE local_id='t'",
    );
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("release it first");
    expect(r.stderr).toContain("mu task release <id> -w <ws>");
    expect(
      count(
        "SELECT COUNT(*) n FROM tasks WHERE owner_id = (SELECT id FROM agents WHERE name='w1')",
      ),
    ).toBe(1);
  });

  it("an unrelated SQL error is still a plain error (exit 1)", async () => {
    const r = await sql("UPDATE nope SET x = 1");
    expect(r.exitCode).toBe(1);
  });
});

describe("mu task close without --evidence: exit 2, ONE stderr line, nothing written", () => {
  const closeNoEvidence = async (...extra: string[]) => {
    const ops = count("SELECT COUNT(*) n FROM ops");
    db.close();
    const r = await runCli(["task", "close", "t", "-w", "demo", ...extra], path);
    db = openDb({ path });
    expect(count("SELECT COUNT(*) n FROM ops")).toBe(ops);
    return r;
  };

  const closeNoEvidenceJson = async () => {
    const ops = count("SELECT COUNT(*) n FROM ops");
    db.close();
    const r = await runCliJson(["task", "close", "t", "-w", "demo", "--json"], path);
    db = openDb({ path });
    expect(count("SELECT COUNT(*) n FROM ops")).toBe(ops);
    return r;
  };

  it("plain close", async () => {
    const r = await closeNoEvidence();
    expect(r.exitCode).toBe(2);
    expect(lines(r.stderr)).toHaveLength(1);
    expect(r.stderr).toContain('mu task close t -w demo --evidence "<command + result>"');
  });

  it("--if-ready on a READY task is the same refusal, not exit 4", async () => {
    const r = await closeNoEvidence("--if-ready");
    expect(r.exitCode).toBe(2);
    expect(lines(r.stderr)).toHaveLength(1);
  });

  it("--if-ready on a blocked task still skips quietly (exit 0, no write)", async () => {
    addBlockEdge(db, "demo", "t", "blocker");
    const r = await closeNoEvidence("--if-ready");
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("Skipped");
  });

  it("other usage errors still print help", async () => {
    db.close();
    const r = await runCli(["task", "close", "t", "-w", "demo", "--as", "done", "--bogus"], path);
    db = openDb({ path });
    expect(r.exitCode).toBe(2);
    expect(lines(r.stderr).length).toBeGreaterThan(1);
  });

  it("--json keeps the one-line envelope without a usage block", async () => {
    const r = await closeNoEvidenceJson();
    expect(r.exitCode).toBe(2);
    const env = r.doc as unknown as { error: string; usage?: unknown };
    expect(env.error).toBe("CloseNeedsEvidenceError");
    expect(env.usage).toBeUndefined();
  });
});

describe("mu doctor closed-evidence: the advertised repair works", () => {
  it("does not advertise `mu task note`; open + close --evidence clears the warning", async () => {
    withCaptureSuppressed(db, () =>
      db.prepare("UPDATE tasks SET status='CLOSED', substate='done' WHERE local_id='t'").run(),
    );
    const before = checkCloseGuards(db)[1];
    expect(before).toMatchObject({ name: "closed-evidence", severity: "warn" });
    const fix = (before?.remediation ?? []).join("\n");
    expect(fix).not.toContain("mu task note");
    expect(fix).toContain("mu task open <ws>/<id>");
    expect(fix).toContain('mu task close <ws>/<id> --evidence "<command + result>"');

    db.close();
    expect((await runCli(["task", "open", "t", "-w", "demo"], path)).exitCode).toBeNull();
    const r = await runCli(
      ["task", "close", "t", "-w", "demo", "--evidence", "npm test exit 0"],
      path,
    );
    expect(r.exitCode).toBeNull();
    db = openDb({ path });
    expect(checkCloseGuards(db)[1]).toMatchObject({ name: "closed-evidence", severity: "ok" });
  });
});
