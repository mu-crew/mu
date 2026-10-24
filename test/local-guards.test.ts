// Local-write guards (k_local_guards): three persistent triggers that
// refuse, for LOCAL writes only (`applying = 0`), a claim that steals an
// owned task, a close without evidence, and a close to `done` while a
// blocker is open. Ingest and import accept what the log says, so every
// guard is also proven silent under `withCaptureSuppressed`.
//
// The triggers are tested through a plain better-sqlite3 connection on
// the file (no SDK, no op context unless a test opens one), because that
// is the path a guard exists to cover.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { applyOp, type Op } from "../src/apply.js";
import { GUARD_ALREADY_OWNED, GUARD_NEEDS_EVIDENCE, GUARD_OPEN_BLOCKERS } from "../src/capture.js";
import { type Db, openDb } from "../src/db.js";
import { checkCloseGuards } from "../src/fleet-hazards.js";
import { formatHlc } from "../src/hlc.js";
import { withCaptureSuppressed, withOpContext } from "../src/op-context.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, insertNote } from "../src/tasks/edit.js";
import {
  CloseNeedsEvidenceError,
  closeTask,
  getTask,
  listNotes,
  TaskHasOpenBlockersError,
} from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

let dir: string;
let path: string;
let db: Db;
/** A plain connection: no SDK, no context. What a guard must catch. */
let raw: InstanceType<typeof Database>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-local-guards-"));
  path = join(dir, "mu.db");
  db = openDb({ path });
  ensureWorkstream(db, "demo");
  for (const id of ["t", "u", "blocker", "a_b", "axb"]) {
    addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
  }
  insertAgent(db, { name: "w1", workstream: "demo", paneId: "%1" });
  insertAgent(db, { name: "w2", workstream: "demo", paneId: "%2" });
  raw = new Database(path);
  raw.pragma("foreign_keys = ON");
});

afterEach(() => {
  for (const c of [raw, db]) {
    try {
      c.close();
    } catch {}
  }
  rmFixtureDir(dir);
});

const taskId = (id: string): number =>
  (db.prepare("SELECT id FROM tasks WHERE local_id = ?").get(id) as { id: number }).id;
const agentId = (name: string): number =>
  (db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as { id: number }).id;
const message = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};
const setOwner = (c: { prepare: Db["prepare"] }, id: string, owner: number | null): void => {
  c.prepare("UPDATE tasks SET owner_id = ? WHERE local_id = ?").run(owner, id);
};
const closeRaw = (id: string, substate = "done", c: { prepare: Db["prepare"] } = raw): void => {
  c.prepare("UPDATE tasks SET status = 'CLOSED', substate = ? WHERE local_id = ?").run(
    substate,
    id,
  );
};
const statusOf = (id: string): string =>
  (db.prepare("SELECT status FROM tasks WHERE local_id = ?").get(id) as { status: string }).status;

describe("claim CAS (_cap_tasks_claim_cas)", () => {
  it("refuses an owner change from one agent to another", () => {
    setOwner(raw, "t", agentId("w1"));
    expect(message(() => setOwner(raw, "t", agentId("w2")))).toBe(GUARD_ALREADY_OWNED);
    expect(
      (db.prepare("SELECT owner_id FROM tasks WHERE local_id = 't'").get() as { owner_id: number })
        .owner_id,
    ).toBe(agentId("w1"));
  });

  it("allows claim (NULL -> agent), release (agent -> NULL) and a same-owner rewrite", () => {
    setOwner(raw, "t", agentId("w1"));
    setOwner(raw, "t", agentId("w1"));
    setOwner(raw, "t", null);
    setOwner(raw, "t", agentId("w2"));
  });

  it("is silent under withCaptureSuppressed (ingest/import apply what the log says)", () => {
    setOwner(raw, "t", agentId("w1"));
    expect(() => withCaptureSuppressed(db, () => setOwner(db, "t", agentId("w2")))).not.toThrow();
  });
});

describe("close needs evidence (_cap_tasks_close_evidence)", () => {
  it("refuses a bare close from a plain connection", () => {
    expect(message(() => closeRaw("t"))).toBe(GUARD_NEEDS_EVIDENCE);
    expect(statusOf("t")).toBe("OPEN");
  });

  it("accepts a close-kind note written earlier in the SAME op group", () => {
    withOpContext(db, { intent: "task.close", group: "new" }, () => {
      insertNote(db, "t", "CLOSE: ran it", { workstream: "demo", kind: "close" });
      db.prepare(
        "UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = 't'",
      ).run();
    });
    expect(statusOf("t")).toBe("CLOSED");
  });

  it("refuses the note written AFTER the status update", () => {
    const msg = message(() =>
      withOpContext(db, { intent: "task.close", group: "new" }, () => {
        db.prepare(
          "UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = 't'",
        ).run();
        insertNote(db, "t", "CLOSE: late", { workstream: "demo", kind: "close" });
      }),
    );
    expect(msg).toBe(GUARD_NEEDS_EVIDENCE);
  });

  it("refuses a close-kind note from an EARLIER group, and a note of another kind", () => {
    addNote(db, "t", "CLOSE: old", { workstream: "demo", kind: "close" });
    expect(message(() => closeRaw("t"))).toBe(GUARD_NEEDS_EVIDENCE);
    const msg = message(() =>
      withOpContext(db, { intent: "task.close", group: "new" }, () => {
        insertNote(db, "u", "CLOSE: wrong kind", { workstream: "demo" });
        db.prepare(
          "UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = 'u'",
        ).run();
      }),
    );
    expect(msg).toBe(GUARD_NEEDS_EVIDENCE);
  });

  it("matches the note op by exact key: a LIKE-wildcard lookalike task's note op does not satisfy it", () => {
    // `a_b` already holds a close note from an EARLIER group; this group
    // writes only `axb`'s note. Under `key LIKE 'demo/a_b#%'` (`_` is a
    // wildcard) axb's op would pass for a_b.
    addNote(db, "a_b", "CLOSE: stale", { workstream: "demo", kind: "close" });
    const msg = message(() =>
      withOpContext(db, { intent: "task.close", group: "new" }, () => {
        insertNote(db, "axb", "CLOSE: for axb", { workstream: "demo", kind: "close" });
        db.prepare(
          "UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = 'a_b'",
        ).run();
      }),
    );
    expect(msg).toBe(GUARD_NEEDS_EVIDENCE);
  });

  it("needs a SURVIVING note: one written then deleted in the group is no evidence", () => {
    const msg = message(() =>
      withOpContext(db, { intent: "task.close", group: "new" }, () => {
        insertNote(db, "t", "CLOSE: gone", { workstream: "demo", kind: "close" });
        db.prepare("DELETE FROM task_notes WHERE task_id = ?").run(taskId("t"));
        db.prepare(
          "UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = 't'",
        ).run();
      }),
    );
    expect(msg).toBe(GUARD_NEEDS_EVIDENCE);
  });

  it("a CLOSED -> CLOSED reclassification is a close and needs fresh evidence", () => {
    closeTask(db, "t", { workstream: "demo", as: "wontfix", why: "not now" });
    expect(message(() => closeRaw("t", "duplicate"))).toBe(GUARD_NEEDS_EVIDENCE);
    expect(() =>
      closeTask(db, "t", { workstream: "demo", as: "duplicate", why: "same as u" }),
    ).not.toThrow();
  });

  it("is silent under withCaptureSuppressed", () => {
    expect(() => withCaptureSuppressed(db, () => closeRaw("t", "done", db))).not.toThrow();
    expect(() =>
      withCaptureSuppressed(db, () =>
        db
          .prepare("UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = 'u'")
          .run(),
      ),
    ).not.toThrow();
  });
});

describe("close refuses open blockers (_cap_tasks_close_blockers)", () => {
  /** Run `fn` as a close that already carries evidence, so only the
   *  blocker guard can object. */
  const withEvidence = (id: string, fn: () => void): void =>
    withOpContext(db, { intent: "task.close", group: "new" }, () => {
      insertNote(db, id, "CLOSE: ok", { workstream: "demo", kind: "close" });
      fn();
    });

  beforeEach(() => {
    addBlockEdge(db, "demo", "t", "blocker");
  });

  it("refuses a close to done while a blocker is open", () => {
    expect(
      message(() =>
        withEvidence("t", () =>
          db
            .prepare("UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = 't'")
            .run(),
        ),
      ),
    ).toBe(GUARD_OPEN_BLOCKERS);
    expect(statusOf("t")).toBe("OPEN");
  });

  it("exempts the other substates: they do not claim the work happened", () => {
    withEvidence("t", () =>
      db
        .prepare("UPDATE tasks SET status = 'CLOSED', substate = 'wontfix' WHERE local_id = 't'")
        .run(),
    );
    expect(statusOf("t")).toBe("CLOSED");
  });

  it("reclassifying a CLOSED/wontfix task to done is checked like any close to done", () => {
    withEvidence("t", () =>
      db
        .prepare("UPDATE tasks SET status = 'CLOSED', substate = 'wontfix' WHERE local_id = 't'")
        .run(),
    );
    expect(
      message(() =>
        withEvidence("t", () =>
          db.prepare("UPDATE tasks SET substate = 'done' WHERE local_id = 't'").run(),
        ),
      ),
    ).toBe(GUARD_OPEN_BLOCKERS);
  });

  it("passes once the blocker is CLOSED", () => {
    closeTask(db, "blocker", { workstream: "demo", evidence: "built" });
    expect(() => closeTask(db, "t", { workstream: "demo", evidence: "ok" })).not.toThrow();
  });

  it("is silent under withCaptureSuppressed", () => {
    expect(() => withCaptureSuppressed(db, () => closeRaw("t", "done", db))).not.toThrow();
  });
});

describe("closeTask maps the guards to typed errors and writes nothing on refusal", () => {
  const opCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

  it("done without evidence: CloseNeedsEvidenceError, no op, no note", () => {
    const before = opCount();
    expect(() => closeTask(db, "t", { workstream: "demo" })).toThrow(CloseNeedsEvidenceError);
    expect(() => closeTask(db, "t", { workstream: "demo", evidence: "  " })).toThrow(
      CloseNeedsEvidenceError,
    );
    expect(opCount()).toBe(before);
    expect(getTask(db, "t", "demo")?.status).toBe("OPEN");
  });

  it("done with open blockers: TaskHasOpenBlockersError naming them; the evidence note rolls back", () => {
    addBlockEdge(db, "demo", "t", "blocker");
    addBlockEdge(db, "demo", "t", "u");
    const before = opCount();
    let caught: unknown;
    try {
      closeTask(db, "t", { workstream: "demo", evidence: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TaskHasOpenBlockersError);
    expect((caught as TaskHasOpenBlockersError).blockerIds).toEqual(["blocker", "u"]);
    expect(opCount()).toBe(before);
    expect(listNotes(db, "t", "demo")).toEqual([]);
  });

  it("a non-done close needs --why only, and its note is the evidence", () => {
    closeTask(db, "t", { workstream: "demo", as: "wontfix", why: "out of scope" });
    expect(listNotes(db, "t", "demo").map((n) => n.content)).toEqual(["WONTFIX: out of scope"]);
  });

  it("the evidence note and the status put share one op group, note first", () => {
    closeTask(db, "t", { workstream: "demo", evidence: "npm test: 12 passed" });
    const rows = db
      .prepare("SELECT entity, op, group_id FROM ops WHERE intent = 'task.close' ORDER BY seq")
      .all() as { entity: string; group_id: string }[];
    expect(rows.map((r) => r.entity)).toEqual(["note", "task"]);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
    const kind = db.prepare("SELECT kind FROM task_notes WHERE task_id = ?").get(taskId("t")) as {
      kind: string;
    };
    expect(kind.kind).toBe("close");
  });

  it("an idempotent retry of an already-done close needs no evidence and writes nothing", () => {
    closeTask(db, "t", { workstream: "demo", evidence: "once" });
    const before = opCount();
    expect(closeTask(db, "t", { workstream: "demo" })).toMatchObject({ changed: false });
    expect(opCount()).toBe(before);
  });
});

describe("ingest is never blocked", () => {
  const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";
  const peerOp = (key: string, payload: Record<string, unknown>): Op => ({
    hlc: formatHlc({ wallMs: 2_000_000_000_000, counter: 0, machineId: PEER }),
    machineId: PEER,
    groupId: "peer-grp",
    actor: "peer",
    intent: "task.close",
    entity: "task",
    key,
    op: "put",
    payload: JSON.stringify(payload),
  });

  it("applies a peer close of a task with open blockers and no close note", () => {
    addBlockEdge(db, "demo", "t", "blocker");
    const r = applyOp(db, peerOp("demo/t", { status: "CLOSED", substate: "done" }));
    expect(r.changed).toBe(true);
    expect(statusOf("t")).toBe("CLOSED");
    expect(listNotes(db, "t", "demo")).toEqual([]);
  });

  it("applies a peer owner change without touching local ownership (owner never syncs)", () => {
    setOwner(raw, "t", agentId("w1"));
    expect(() => applyOp(db, peerOp("demo/t", { owner_id: agentId("w2") }))).not.toThrow();
    expect(
      (db.prepare("SELECT owner_id FROM tasks WHERE local_id = 't'").get() as { owner_id: number })
        .owner_id,
    ).toBe(agentId("w1"));
  });
});

describe("mu doctor reports what the guards would have refused (warn, not fail)", () => {
  it("lists CLOSED/done tasks with open blockers and CLOSED tasks with no close note", () => {
    const [blockers, evidence] = checkCloseGuards(db);
    expect([blockers?.severity, evidence?.severity]).toEqual(["ok", "ok"]);

    addBlockEdge(db, "demo", "t", "blocker");
    withCaptureSuppressed(db, () => {
      closeRaw("t", "done", db);
      db.prepare(
        "UPDATE tasks SET status = 'CLOSED', substate = 'wontfix' WHERE local_id = 'u'",
      ).run();
    });
    const [b2, e2] = checkCloseGuards(db);
    expect(b2).toMatchObject({ name: "closed-blockers", severity: "warn" });
    expect(b2?.detail).toContain("demo/t");
    expect(b2?.detail).not.toContain("demo/u");
    expect(e2).toMatchObject({ name: "closed-evidence", severity: "warn" });
    expect(e2?.detail).toContain("demo/t");
    expect(e2?.detail).toContain("demo/u");
  });

  it("caps each list at 10 ids", () => {
    for (let i = 0; i < 12; i++) {
      addTask(db, { workstream: "demo", localId: `m${i}`, title: "m", impact: 50, effortDays: 1 });
    }
    withCaptureSuppressed(db, () =>
      db
        .prepare("UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id LIKE 'm%'")
        .run(),
    );
    const evidence = checkCloseGuards(db)[1];
    expect(evidence?.detail.match(/demo\/m\d+/g)).toHaveLength(10);
    expect(evidence?.detail).toContain("12 total");
  });
});

describe("mu task close --as done", () => {
  it("without --evidence: UsageError (exit 2) naming the flag, before any write", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
    db.close();
    const r = await runCli(["task", "close", "t", "-w", "demo"], path);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--evidence");
    db = openDb({ path });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n).toBe(before);
    expect(statusOf("t")).toBe("OPEN");
  });

  it("with open blockers: exit 4 and a Next: pointing at the tree", async () => {
    addBlockEdge(db, "demo", "t", "blocker");
    db.close();
    const r = await runCli(["task", "close", "t", "-w", "demo", "--evidence", "x"], path);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("blocker");
    expect(r.stderr).toContain("mu task tree t -w demo");
    db = openDb({ path });
  });

  it("--as wontfix --why closes without --evidence", async () => {
    db.close();
    const r = await runCli(
      ["task", "close", "t", "-w", "demo", "--as", "wontfix", "--why", "nope"],
      path,
    );
    expect(r.exitCode).toBeNull();
    db = openDb({ path });
    expect(statusOf("t")).toBe("CLOSED");
  });
});
