// Task-side guards (v_guards, part A): `--if <rev>` on delete / block /
// unblock / reparent / claim / release, the exact-key task revision behind
// it, and read-only `candidate_ids` on a wrong id.
//
// Revisions are tested through real SQLite ops. The CLI tests drive the
// verbs in-process, so the whole path (parse → ingest hook → fence → verb)
// is the one a user hits.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import {
  assertRevision,
  RevisionMismatchError,
  taskRevision,
  taskRevisions,
  withTaskFence,
} from "../src/revision.js";
import { applyIncomingOp } from "../src/segments.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, deleteTask } from "../src/tasks/edit.js";
import { claimTask, getTask, getTaskEdges, releaseTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";

let dir: string;
let path: string;
let db: Db;

const add = (ws: string, id: string): void => {
  addTask(db, { workstream: ws, localId: id, title: id, impact: 50, effortDays: 1 });
};
const opCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
const rev = (id: string, ws = "demo"): number => taskRevision(db, ws, id);
const edgeCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-revision-guards-"));
  path = join(dir, "mu.db");
  db = openDb({ path });
  ensureWorkstream(db, "demo");
  ensureWorkstream(db, "other");
  ensureWorkstream(db, "demo-2");
  for (const id of ["t", "u", "a_b", "axb", "blocker"]) add("demo", id);
  add("other", "t");
  add("demo-2", "t");
  insertAgent(db, { name: "w1", workstream: "demo", paneId: "%1" });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

describe("taskRevision", () => {
  it("is the exact-key partition: a sibling underscore id, another workstream and a prefix workstream never move it", () => {
    const r = rev("a_b");
    expect(r).toBeGreaterThan(0);
    addNote(db, "axb", "touch the lookalike (LIKE '_' would match)", { workstream: "demo" });
    addNote(db, "t", "same id elsewhere", { workstream: "other" });
    addNote(db, "t", "same id in a prefix sibling", { workstream: "demo-2" });
    expect(rev("a_b")).toBe(r);
    // Same id elsewhere is a different partition: its revision is its own,
    // and it moved with its own note, not with demo's. (Never compare
    // revisions by magnitude: they are hash-derived, not monotonic.)
    const other = rev("t", "other");
    expect(other).not.toBe(0);
    addNote(db, "t", "demo only", { workstream: "demo" });
    expect(rev("t", "other")).toBe(other);
    expect(rev("t")).not.toBe(r);
  });

  it("moves on EVERY step: a note, a field update, a claim, either end of an edge", async () => {
    const steps: [string, () => void | Promise<void>][] = [
      ["note", () => void addNote(db, "t", "n", { workstream: "demo" })],
      ["blocked end of an edge", () => void addBlockEdge(db, "demo", "t", "u")],
      ["blocker end of an edge", () => void addBlockEdge(db, "demo", "a_b", "t")],
      ["claim", () => claimTask(db, "t", { workstream: "demo", agentName: "w1" }).then(() => {})],
      ["release", () => void releaseTask(db, "t", { workstream: "demo" })],
    ];
    let last = rev("t");
    const uBefore = rev("u");
    for (const [label, step] of steps) {
      await step();
      const now = rev("t");
      expect(now, label).not.toBe(last);
      last = now;
    }
    // u is on the far end of t's blocker edge: it moved once, with the edge.
    expect(rev("u")).not.toBe(uBefore);
    expect(rev("axb")).toBe(rev("axb"));
  });

  it("every task-row column and the owner is its own contribution (updated_at frozen)", () => {
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name='demo'").get() as { id: number }
    ).id;
    const agentId = (db.prepare("SELECT id FROM agents WHERE name='w1'").get() as { id: number })
      .id;
    const frozen = (
      db
        .prepare("SELECT updated_at FROM tasks WHERE local_id='t' AND workstream_id=?")
        .get(wsId) as { updated_at: string }
    ).updated_at;
    const changes: [string, string, unknown[]][] = [
      ["title", "title = ?", ["renamed"]],
      ["impact", "impact = ?", [51]],
      ["effort_days", "effort_days = ?", [2.5]],
      ["scored", "scored = ?", [0]],
      ["dispatch_host", "dispatch_host = ?", ["box"]],
      ["kind", "kind = ?", ["human"]],
      ["wave", "wave = ?", ["w9"]],
      ["created_at", "created_at = ?", ["2001-01-01T00:00:00.000Z"]],
      ["status+substate", "status = ?, substate = ?", ["IN_PROGRESS", "active"]],
      ["substate only", "substate = ?", ["parked"]],
      ["owner", "owner_id = ?", [agentId]],
    ];
    for (const [label, set, args] of changes) {
      // restore a known base (still frozen), then change exactly one thing
      db.prepare(
        "UPDATE tasks SET title='t', impact=50, effort_days=1, scored=1, dispatch_host=NULL, kind='work', wave=NULL, created_at=?, status='OPEN', substate='todo', owner_id=NULL, updated_at=? WHERE local_id='t' AND workstream_id=?",
      ).run("2000-01-01T00:00:00.000Z", frozen, wsId);
      const base = rev("t");
      db.prepare(`UPDATE tasks SET ${set} WHERE local_id='t' AND workstream_id=?`).run(
        ...args,
        wsId,
      );
      expect(
        (
          db
            .prepare("SELECT updated_at FROM tasks WHERE local_id='t' AND workstream_id=?")
            .get(wsId) as { updated_at: string }
        ).updated_at,
        label,
      ).toBe(frozen);
      expect(rev("t"), label).not.toBe(base);
    }
    // updated_at alone moves it too
    const base = rev("t");
    db.prepare("UPDATE tasks SET updated_at = ? WHERE local_id='t' AND workstream_id=?").run(
      "2002-02-02T00:00:00.000Z",
      wsId,
    );
    expect(rev("t")).not.toBe(base);
  });

  it("owner-only: a task's owner moves its revision and a stale --if claim/delete is refused", () => {
    const agentId = (db.prepare("SELECT id FROM agents WHERE name='w1'").get() as { id: number })
      .id;
    const before = rev("u");
    db.prepare(
      "UPDATE tasks SET owner_id = ? WHERE local_id='u' AND workstream_id=(SELECT id FROM workstreams WHERE name='demo')",
    ).run(agentId);
    expect(rev("u")).not.toBe(before);
    expect(() => deleteTask(db, "u", "demo", { ifRevision: before })).toThrow(
      RevisionMismatchError,
    );
    expect(getTask(db, "u", "demo")).toBeDefined();
  });

  it("edge order never matters, direction does: the hash input is canonical", () => {
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name='demo'").get() as { id: number }
    ).id;
    const idOf = (id: string): number =>
      (
        db.prepare("SELECT id FROM tasks WHERE local_id=? AND workstream_id=?").get(id, wsId) as {
          id: number;
        }
      ).id;
    const edge = (from: string, to: string): void => {
      db.prepare(
        "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
      ).run(idOf(from), idOf(to), "2030-01-01T00:00:00.000Z");
    };
    const clear = (): void => void db.prepare("DELETE FROM task_edges").run();
    // t blocked by u and blocker, t blocking a_b and axb: inserted in two orders
    edge("u", "t");
    edge("blocker", "t");
    edge("t", "a_b");
    edge("t", "axb");
    const forward = rev("t");
    clear();
    edge("t", "axb");
    edge("t", "a_b");
    edge("blocker", "t");
    edge("u", "t");
    expect(rev("t")).toBe(forward);
    // direction is part of the input: the same peers on the other sides differ
    clear();
    edge("t", "u");
    edge("t", "blocker");
    edge("a_b", "t");
    edge("axb", "t");
    expect(rev("t")).not.toBe(forward);
  });

  it("the same state gives the same revision on a machine whose rows were created in another order", () => {
    // Row ids (and so the order SQLite returns edges in) differ per machine.
    const other = openDb({ path: join(dir, "peer.db") });
    try {
      ensureWorkstream(other, "demo");
      for (const id of ["blocker", "axb", "a_b", "u", "t"]) {
        addTask(other, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
      }
      for (const d of [db, other]) {
        for (const [blocked, by] of [
          ["t", "u"],
          ["t", "blocker"],
          ["a_b", "t"],
          ["axb", "t"],
        ] as const) {
          addBlockEdge(d, "demo", blocked, by);
        }
        d.prepare(
          "UPDATE tasks SET created_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z'",
        ).run();
      }
      expect(taskRevision(other, "demo", "t")).toBe(rev("t"));
    } finally {
      other.close();
    }
  });

  it("is derived from state: the same state gives the same revision, whatever got it there", () => {
    const r = rev("t");
    addNote(db, "t", "n", { workstream: "demo" });
    expect(rev("t")).not.toBe(r);
    addBlockEdge(db, "demo", "t", "u");
    db.prepare("DELETE FROM task_edges").run();
    // the edge is gone again but the note stays: still not the original
    expect(rev("t")).not.toBe(r);
    expect(Number.isSafeInteger(rev("t"))).toBe(true);
  });

  it("an edge whose other end is in another workstream moves the local end (either direction, via the real apply path)", () => {
    const r = rev("t");
    const peerOp = (key: string, op: "put" | "del" = "put") => ({
      hlc: formatHlc({ wallMs: Date.now() + 60_000, counter: 0, machineId: PEER }),
      machineId: PEER,
      groupId: `g-${key}`,
      actor: "peer",
      intent: null,
      entity: "edge",
      key,
      op,
      payload: JSON.stringify({ created_at: "2030-01-01T00:00:00.000Z" }),
    });
    // local task is the FIRST (blocker) endpoint
    expect(applyIncomingOp(db, peerOp("demo/t->other/t")).changed).toBe(true);
    const r1 = rev("t");
    expect(r1).not.toBe(r);
    expect(rev("t", "other")).not.toBe(0);
    // local task is the SECOND (blocked) endpoint: key starts in `other`
    add("other", "x");
    const u = rev("u");
    expect(applyIncomingOp(db, peerOp("other/x->demo/u")).changed).toBe(true);
    expect(getTaskEdges(db, "u", "demo").blockers).toEqual(["x"]);
    expect(rev("u")).not.toBe(u);
    expect(rev("t")).toBe(r1);
    expect([...taskRevisions(db, "demo").keys()].every((k) => !k.includes("/"))).toBe(true);
  });

  it("a peer's blocker delete drops the edge with no edge op, and still moves the dependent", () => {
    addBlockEdge(db, "demo", "t", "u"); // u blocks t
    const r = rev("t");
    const ops = opCount();
    const res = applyIncomingOp(db, {
      hlc: formatHlc({ wallMs: Date.now() + 60_000, counter: 0, machineId: PEER }),
      machineId: PEER,
      groupId: "g-del",
      actor: "peer",
      intent: null,
      entity: "task",
      key: "demo/u",
      op: "del",
      payload: "{}",
    });
    expect(res.changed).toBe(true);
    expect(getTaskEdges(db, "t", "demo").blockers).toEqual([]);
    // only the peer's own op was logged: the edge vanished under capture suppression
    expect(opCount()).toBe(ops + 1);
    expect(rev("t")).not.toBe(r);
  });

  it("a peer note (capture-suppressed, no updated_at touch) moves the revision", () => {
    const r = rev("t");
    const res = applyIncomingOp(db, {
      hlc: formatHlc({ wallMs: Date.now() + 60_000, counter: 0, machineId: PEER }),
      machineId: PEER,
      groupId: "g-note",
      actor: "peer",
      intent: null,
      entity: "note",
      key: "demo/t#99",
      op: "put",
      payload: JSON.stringify({
        author: "peer",
        content: "hi",
        created_at: "2030-01-01T00:00:00.000Z",
      }),
    });
    expect(res.changed).toBe(true);
    expect(rev("t")).not.toBe(r);
  });

  it("an absent task is revision 0, and reading it writes nothing", () => {
    const ops = opCount();
    expect(rev("ghost")).toBe(0);
    expect(opCount()).toBe(ops);
  });

  it("a moved edge (removed behind the preview) makes the old revision stale", async () => {
    addBlockEdge(db, "demo", "t", "u");
    const r = rev("t");
    db.prepare(
      "DELETE FROM task_edges WHERE to_task_id = (SELECT id FROM tasks WHERE local_id = 't' AND workstream_id = (SELECT id FROM workstreams WHERE name = 'demo'))",
    ).run();
    expect(rev("t")).not.toBe(r);
  });
});

describe("assertRevision", () => {
  const ctx = { subject: "task t", previewCommand: "mu task show t -w demo" };
  it("passes with no --if and on a match; throws a typed error otherwise", () => {
    expect(() => assertRevision(undefined, 5, ctx)).not.toThrow();
    expect(() => assertRevision(5, 5, ctx)).not.toThrow();
    try {
      assertRevision(4, 5, ctx);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RevisionMismatchError);
      const err = e as RevisionMismatchError;
      expect([err.expectedRev, err.currentRev]).toEqual([4, 5]);
      expect(err.message).not.toContain("\n");
      expect(err.message).toContain("mu task show t -w demo");
    }
  });
});

describe("SDK fences refuse before any write", () => {
  it("deleteTask: stale → throws, task and ops untouched; fresh → deletes", () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const ops = opCount();
    expect(() => deleteTask(db, "t", "demo", { ifRevision: stale })).toThrow(RevisionMismatchError);
    expect(opCount()).toBe(ops);
    expect(getTask(db, "t", "demo")).toBeDefined();
    expect(deleteTask(db, "t", "demo", { ifRevision: rev("t") }).deleted).toBe(true);
  });

  it("deleteTask preview writes nothing and reports the revision", () => {
    const ops = opCount();
    const r = deleteTask(db, "t", "demo", { dryRun: true });
    expect(r.revision).toBe(rev("t"));
    expect(opCount()).toBe(ops);
  });

  it("deleteTask of a missing task stays a no-op even with a stale --if", () => {
    expect(deleteTask(db, "ghost", "demo", { ifRevision: 1 })).toMatchObject({
      present: false,
      deleted: false,
    });
  });

  it("claimTask --self and releaseTask: stale → throws, no owner/status change", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    await expect(
      claimTask(db, "t", { workstream: "demo", self: true, ifRevision: stale }),
    ).rejects.toBeInstanceOf(RevisionMismatchError);
    await expect(
      claimTask(db, "t", { workstream: "demo", agentName: "w1", ifRevision: stale }),
    ).rejects.toBeInstanceOf(RevisionMismatchError);
    expect(getTask(db, "t", "demo")?.status).toBe("OPEN");
    await claimTask(db, "t", { workstream: "demo", agentName: "w1", ifRevision: rev("t") });
    expect(getTask(db, "t", "demo")?.ownerName).toBe("w1");
    const stale2 = rev("t") - 1;
    expect(() => releaseTask(db, "t", { workstream: "demo", ifRevision: stale2 })).toThrow(
      RevisionMismatchError,
    );
    expect(getTask(db, "t", "demo")?.ownerName).toBe("w1");
    releaseTask(db, "t", { workstream: "demo", ifRevision: rev("t") });
    expect(getTask(db, "t", "demo")?.ownerName).toBeNull();
  });
});

describe("the fence reads and writes in ONE transaction", () => {
  // A check before BEGIN IMMEDIATE leaves a window for a concurrent writer
  // between compare and write. Observe, per prepared statement, whether the
  // connection was inside a transaction.
  const traced = (): { proxy: Db; log: { sql: string; tx: boolean }[] } => {
    const log: { sql: string; tx: boolean }[] = [];
    const proxy = new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === "prepare") {
          return (sql: string) => {
            log.push({ sql, tx: target.inTransaction });
            return target.prepare(sql);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { proxy, log };
  };
  const readsOfTasks = (log: { sql: string; tx: boolean }[]) =>
    log.filter(
      (l) => /FROM tasks t\s+JOIN workstreams w/.test(l.sql) || /SELECT 1 FROM tasks t/.test(l.sql),
    );

  it("withTaskFence: the existence check and the revision derivation run inside the write transaction", () => {
    const { proxy, log } = traced();
    let ran = false;
    withTaskFence(proxy, "demo", "t", rev("t"), () => {
      ran = true;
    });
    expect(ran).toBe(true);
    const reads = readsOfTasks(log);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every((l) => l.tx)).toBe(true);
  });

  it("withTaskFence: a stale revision is refused inside the transaction and fn never runs", () => {
    let ran = false;
    expect(() =>
      withTaskFence(db, "demo", "t", rev("t") + 1, () => {
        ran = true;
      }),
    ).toThrow(RevisionMismatchError);
    expect(ran).toBe(false);
    expect(db.inTransaction).toBe(false);
  });

  it("claimTask --if: the revision is read inside the claim transaction", async () => {
    const { proxy, log } = traced();
    await claimTask(proxy, "t", { workstream: "demo", agentName: "w1", ifRevision: rev("t") });
    const reads = log.filter(
      (l) => /FROM tasks t\s+JOIN workstreams w/.test(l.sql) && /owner/.test(l.sql),
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((l) => l.tx)).toBe(true);
  });
});

describe("CLI: task delete", () => {
  it("preview carries data.revision and next is the --if <rev> apply", async () => {
    const ops = opCount();
    const r = await runCliJson(["task", "delete", "t", "-w", "demo", "--json"], path);
    expect(r.data).toMatchObject({ dryRun: true, present: true, revision: rev("t") });
    expect(r.doc.next).toEqual({
      mode: "alt",
      commands: [`mu task delete t -w demo --if ${rev("t")}`],
    });
    expect(opCount()).toBe(ops);
  });

  it("--if <rev> applies; --yes still applies (unchanged)", async () => {
    const r = await runCliJson(
      ["task", "delete", "t", "-w", "demo", "--if", String(rev("t")), "--json"],
      path,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ deleted: true, dryRun: false });
    const y = await runCliJson(["task", "delete", "u", "-w", "demo", "--yes", "--json"], path);
    expect(y.data).toMatchObject({ deleted: true });
  });

  it("a stale --if: exit 4, one line naming the fresh preview, nothing deleted", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const ops = opCount();
    const r = await runCli(["task", "delete", "t", "-w", "demo", "--if", String(stale)], path);
    expect(r.exitCode).toBe(4);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("mu task delete t -w demo");
    expect(opCount()).toBe(ops);
    expect(getTask(db, "t", "demo")).toBeDefined();
  });

  it("stale --if in --json: top-level expected_rev / current_rev, one envelope on stdout", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCliJson(
      ["task", "delete", "t", "-w", "demo", "--if", String(stale), "--json"],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(r.doc).toMatchObject({
      ok: false,
      error: "RevisionMismatchError",
      exit: 4,
      expected_rev: stale,
      current_rev: rev("t"),
    });
  });

  it("an unknown id stays a no-op (exit 0) even with --if", async () => {
    const r = await runCliJson(
      ["task", "delete", "ghost", "-w", "demo", "--if", "9", "--json"],
      path,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ present: false, deleted: false });
  });

  it("an unknown id returns read-only candidate_ids from the given workstream only", async () => {
    add("demo", "fix_auth");
    add("other", "fix_authz");
    const ops = opCount();
    const r = await runCliJson(
      ["task", "delete", "fix-auth", "-w", "demo", "--yes", "--json"],
      path,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ present: false, candidate_ids: ["fix_auth"] });
    expect(opCount()).toBe(ops);
    expect(getTask(db, "fix_auth", "demo")).toBeDefined();
  });
});

describe("CLI: a stale preview is refused after a PEER op changed the task", () => {
  const peer = (entity: string, key: string, op: "put" | "del", payload: object = {}) => ({
    hlc: formatHlc({ wallMs: Date.now() + 60_000, counter: 0, machineId: PEER }),
    machineId: PEER,
    groupId: `g-${entity}-${key}`,
    actor: "peer",
    intent: null,
    entity,
    key,
    op,
    payload: JSON.stringify(payload),
  });
  const expectRefused = async (id: string, stale: number, ops: number): Promise<void> => {
    const r = await runCliJson(
      ["task", "delete", id, "-w", "demo", "--if", String(stale), "--json"],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(r.doc).toMatchObject({ error: "RevisionMismatchError", expected_rev: stale });
    expect(opCount()).toBe(ops);
    expect(getTask(db, id, "demo")).toBeDefined();
  };

  it("an incoming edge from another workstream (key starts elsewhere)", async () => {
    add("other", "cross_blocker");
    const preview = await runCliJson(["task", "delete", "u", "-w", "demo", "--json"], path);
    const stale = preview.data.revision as number;
    applyIncomingOp(
      db,
      peer("edge", "other/cross_blocker->demo/u", "put", {
        created_at: "2030-01-01T00:00:00.000Z",
      }),
    );
    expect(getTaskEdges(db, "u", "demo").blockers).toEqual(["cross_blocker"]);
    await expectRefused("u", stale, opCount());
  });

  it("a peer deleting a blocker whose edge it never saw (no edge op)", async () => {
    addBlockEdge(db, "demo", "t", "blocker");
    const stale = rev("t");
    applyIncomingOp(db, peer("task", "demo/blocker", "del"));
    expect(getTaskEdges(db, "t", "demo").blockers).toEqual([]);
    await expectRefused("t", stale, opCount());
  });

  it("a peer note", async () => {
    const stale = rev("u");
    applyIncomingOp(
      db,
      peer("note", "demo/u#99", "put", {
        author: "peer",
        content: "hi",
        created_at: "2030-01-01T00:00:00.000Z",
      }),
    );
    await expectRefused("u", stale, opCount());
  });
});

describe("CLI: task block / unblock / reparent", () => {
  it("block --if stale: exit 4, no edge; fresh: one fence for a multi-blocker batch", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCli(
      ["task", "block", "t", "--by", "u,a_b", "-w", "demo", "--if", String(stale)],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(edgeCount()).toBe(0);
    const ok = await runCliJson(
      ["task", "block", "t", "--by", "u,a_b", "-w", "demo", "--if", String(rev("t")), "--json"],
      path,
    );
    expect(ok.exitCode).toBeNull();
    expect(ok.data).toMatchObject({ addedEdges: 2 });
    expect(edgeCount()).toBe(2);
  });

  it("a failing batch under --if rolls back every edge of it", async () => {
    const r = await runCli(
      ["task", "block", "t", "--by", "u,ghost", "-w", "demo", "--if", String(rev("t"))],
      path,
    );
    expect(r.exitCode).toBe(3);
    expect(edgeCount()).toBe(0);
  });

  it("block without --if keeps today's sequential partial-success", async () => {
    const r = await runCli(["task", "block", "t", "--by", "u,ghost", "-w", "demo"], path);
    expect(r.exitCode).toBe(3);
    expect(edgeCount()).toBe(1);
  });

  it("unblock --if stale: exit 4, edge stays; fresh removes it", async () => {
    addBlockEdge(db, "demo", "t", "u");
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCli(
      ["task", "unblock", "t", "--by", "u", "-w", "demo", "--if", String(stale)],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(edgeCount()).toBe(1);
    await runCli(
      ["task", "unblock", "t", "--by", "u", "-w", "demo", "--if", String(rev("t"))],
      path,
    );
    expect(edgeCount()).toBe(0);
  });

  it("unblock of an unknown blocked id is still a no-op under --if", async () => {
    const r = await runCliJson(
      ["task", "unblock", "ghost", "--by", "u", "-w", "demo", "--if", "3", "--json"],
      path,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ removed: false });
  });

  it("reparent --if stale after an edge moved behind the preview: exit 4, edges unchanged", async () => {
    addBlockEdge(db, "demo", "t", "u");
    const stale = rev("t");
    db.prepare("DELETE FROM task_edges").run(); // an edge moved behind our back
    const r = await runCli(
      ["task", "reparent", "t", "--blocked-by", "a_b", "-w", "demo", "--if", String(stale)],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(edgeCount()).toBe(0);
    const ok = await runCli(
      ["task", "reparent", "t", "--blocked-by", "a_b", "-w", "demo", "--if", String(rev("t"))],
      path,
    );
    expect(ok.exitCode).toBeNull();
    expect(getTaskEdges(db, "t", "demo").blockers).toEqual(["a_b"]);
  });
});

describe("CLI: claim / release", () => {
  it("claim --self --if stale: exit 4, unowned; fresh: claimed", async () => {
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCli(
      ["task", "claim", "t", "--self", "-w", "demo", "--if", String(stale)],
      path,
    );
    expect(r.exitCode).toBe(4);
    expect(getTask(db, "t", "demo")?.status).toBe("OPEN");
    const ok = await runCli(
      ["task", "claim", "t", "--for", "w1", "-w", "demo", "--if", String(rev("t"))],
      path,
    );
    expect(ok.exitCode).toBeNull();
    expect(getTask(db, "t", "demo")?.ownerName).toBe("w1");
  });

  it("release --if stale: exit 4, owner kept", async () => {
    await claimTask(db, "t", { workstream: "demo", agentName: "w1" });
    const stale = rev("t");
    addNote(db, "t", "moved", { workstream: "demo" });
    const r = await runCli(["task", "release", "t", "-w", "demo", "--if", String(stale)], path);
    expect(r.exitCode).toBe(4);
    expect(getTask(db, "t", "demo")?.ownerName).toBe("w1");
  });
});

describe("task show / list expose the revision", () => {
  it("--json show: task.revision; list items carry the same number; human show prints it", async () => {
    addNote(db, "t", "n", { workstream: "demo" });
    const s = await runCliJson(["task", "show", "t", "-w", "demo", "--json"], path);
    expect(s.data.task.revision).toBe(rev("t"));
    const l = await runCliJson(["task", "list", "-w", "demo", "--json"], path);
    const byId = new Map(
      (l.data.items as { id: string; revision: number }[]).map((i) => [i.id, i.revision]),
    );
    expect(byId.get("t")).toBe(rev("t"));
    expect(byId.get("a_b")).toBe(rev("a_b"));
    expect(byId.get("a_b")).not.toBe(byId.get("axb"));
    const h = await runCli(["task", "show", "t", "-w", "demo"], path);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR colour codes
    expect(h.stdout.replace(/\u001b\[[0-9;]*m/g, "")).toContain(`rev=${rev("t")}`);
  });
});

describe("candidate_ids: read-only, exact partition", () => {
  beforeEach(() => {
    add("demo", "fix_auth");
    add("other", "fix_auth_other");
  });

  it("a wrong id lists near ids of THAT workstream (never another), exit 3", async () => {
    const r = await runCliJson(["task", "show", "fix-auth", "-w", "demo", "--json"], path);
    expect(r.exitCode).toBe(3);
    expect(r.doc.candidate_ids).toEqual(["fix_auth"]);
    const other = await runCliJson(["task", "show", "fix-auth", "-w", "other", "--json"], path);
    expect(other.doc.candidate_ids).toEqual(["fix_auth_other"]);
  });

  it("a casefolded id is never written through: block refuses and adds nothing", async () => {
    const ops = opCount();
    const r = await runCliJson(
      ["task", "block", "Fix_Auth", "--by", "u", "-w", "demo", "--json"],
      path,
    );
    expect(r.exitCode).toBe(3);
    expect(r.doc.candidate_ids).toEqual(["fix_auth"]);
    expect(opCount()).toBe(ops);
  });

  it("a missing blocker gets candidates from the blocked task's workstream", async () => {
    const r = await runCliJson(
      ["task", "block", "t", "--by", "fixauth", "-w", "demo", "--json"],
      path,
    );
    expect(r.exitCode).toBe(3);
    expect(r.doc.candidate_ids).toEqual(["fix_auth"]);
  });

  it("unblock keeps its no-op but names near ids of the workstream (blocked and blocker)", async () => {
    const ops = opCount();
    const a = await runCliJson(
      ["task", "unblock", "fix-auth", "--by", "u", "-w", "demo", "--json"],
      path,
    );
    expect(a.exitCode).toBeNull();
    expect(a.data).toMatchObject({ removed: false, candidate_ids: ["fix_auth"] });
    const b = await runCliJson(
      ["task", "unblock", "t", "--by", "fixauth", "-w", "demo", "--json"],
      path,
    );
    expect(b.data).toMatchObject({ removed: false, candidate_ids: ["fix_auth"] });
    const none = await runCliJson(
      ["task", "unblock", "t", "--by", "u", "-w", "demo", "--json"],
      path,
    );
    expect("candidate_ids" in none.data).toBe(false);
    expect(opCount()).toBe(ops);
  });

  it("note, notes, update, tree and park-style lifecycle misses name candidates, writing nothing", async () => {
    const ops = opCount();
    const cases = [
      ["task", "note", "fix-auth", "-m", "text"],
      ["task", "notes", "fix-auth"],
      ["task", "update", "fix-auth", "--title", "x"],
      ["task", "tree", "fix-auth"],
      ["task", "close", "fix-auth", "--as", "wontfix", "--why", "x"],
    ];
    for (const c of cases) {
      const r = await runCliJson([...c, "-w", "demo", "--json"], path);
      expect(r.exitCode, c.join(" ")).toBe(3);
      expect(r.doc.candidate_ids, c.join(" ")).toEqual(["fix_auth"]);
    }
    expect(opCount()).toBe(ops);
    expect(getTask(db, "fix_auth", "demo")?.title).toBe("fix_auth");
  });

  it("claim and release name candidates too; no candidates → no key", async () => {
    const c = await runCliJson(
      ["task", "claim", "fix-auth", "--self", "-w", "demo", "--json"],
      path,
    );
    expect(c.doc.candidate_ids).toEqual(["fix_auth"]);
    const rel = await runCliJson(["task", "release", "fix-auth", "-w", "demo", "--json"], path);
    expect(rel.doc.candidate_ids).toEqual(["fix_auth"]);
    const none = await runCliJson(["task", "show", "zzzzzzzz", "-w", "demo", "--json"], path);
    expect(none.exitCode).toBe(3);
    expect("candidate_ids" in none.doc).toBe(false);
  });

  it("human output names the candidates as a read-only similar: line", async () => {
    const r = await runCli(["task", "show", "fix-auth", "-w", "demo"], path);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("similar: fix_auth");
    expect(r.stderr).not.toMatch(/mu (task (delete|block|close)|sql)/);
  });

  const expectMissWritesNothing = async (argv: string[], ops: number, edges: number) => {
    const r = await runCliJson([...argv, "--json"], path);
    expect(r.exitCode, argv.join(" ")).toBe(3);
    expect(r.doc.candidate_ids, argv.join(" ")).toEqual(["fix_auth"]);
    expect(opCount(), argv.join(" ")).toBe(ops);
    expect(edgeCount(), argv.join(" ")).toBe(edges);
  };

  it("task wait: bare and qualified wrong ids name the candidates of the given workstream", async () => {
    const ops = opCount();
    await expectMissWritesNothing(
      ["task", "wait", "fix-auth", "-w", "demo", "--timeout", "1"],
      ops,
      0,
    );
    await expectMissWritesNothing(["task", "wait", "demo/fix-auth", "--timeout", "1"], ops, 0);
    // qualified into another workstream: that workstream's candidates, not demo's
    const o = await runCliJson(
      ["task", "wait", "other/fix-auth", "--timeout", "1", "--json"],
      path,
    );
    expect(o.exitCode).toBe(3);
    expect(o.doc.candidate_ids).toEqual(["fix_auth_other"]);
  });

  it("task add --blocks / --blocked-by with a wrong id: candidates, and the batch rolls back", async () => {
    const ops = opCount();
    for (const flag of ["--blocks", "--blocked-by"]) {
      await expectMissWritesNothing(
        [
          "task",
          "add",
          "new_task",
          "--title",
          "New task",
          "--impact",
          "50",
          "--effort-days",
          "1",
          flag,
          "fix-auth",
          "-w",
          "demo",
        ],
        ops,
        0,
      );
      expect(getTask(db, "new_task", "demo")).toBeUndefined();
    }
  });
});
