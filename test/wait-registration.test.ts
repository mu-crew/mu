// wait_registrations: the machine-local record of what a caller owes a wait.
// Real SQLite, no mux. Registration never consumes anything: wait_cursors
// (the consumed runs) is not touched by any function here.

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent, isValidAgentName } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { isValidTaskId } from "../src/tasks/id.js";
import {
  beginWait,
  endWait,
  type RegisteredRef,
  readWaitRegistration,
  registerOwnedWait,
  WAIT_REF_KINDS,
  WAIT_REGISTRATION_MAX_REFS,
  WaitRegistrationError,
} from "../src/wait-registration.js";
import { ensureWorkstream, isValidWorkstreamName } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

// Each constructor makes the entity it names exist (registration refuses a
// ref to nothing); a syntactically bad id is left alone so the syntax
// refusal is what the test sees. `ghost` refs name nothing.
const ensureTask = (workstream: string, id: string): void => {
  ensureWorkstream(db, workstream);
  const has = db
    .prepare(
      "SELECT 1 FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ? AND t.local_id = ?",
    )
    .get(workstream, id);
  if (has) return;
  addTask(db, { workstream, localId: id, title: id });
};
const task = (id: string, workstream = "w"): RegisteredRef => {
  if (isValidTaskId(id) && isValidWorkstreamName(workstream)) ensureTask(workstream, id);
  return { kind: "task", workstream, id };
};
const agent = (id: string, workstream = "w"): RegisteredRef => {
  if (isValidAgentName(id) && isValidWorkstreamName(workstream)) {
    ensureWorkstream(db, workstream);
    if (
      !db
        .prepare(
          "SELECT 1 FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.name = ? AND ws.name = ?",
        )
        .get(id, workstream)
    ) {
      insertAgent(db, { name: id, workstream, paneId: `%${id}` });
    }
  }
  return { kind: "agent", workstream, id };
};
const delegate = (id: string, workstream = "w"): RegisteredRef => {
  const local = `call-${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
  ensureTask(workstream, local);
  const row = db
    .prepare(
      "SELECT t.id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ? AND t.local_id = ?",
    )
    .get(workstream, local) as { id: number };
  if (!db.prepare("SELECT 1 FROM delegate_calls WHERE call_id = ?").get(id)) {
    db.prepare(
      "INSERT INTO delegate_calls (task_id, caller, call_id, state, updated_at) VALUES (?, 'c', ?, 'queued', 'n')",
    ).run(row.id, id);
  }
  return { kind: "delegate", workstream, id };
};
const keys = (caller: string) =>
  readWaitRegistration(db, caller)?.refs.map((r) => `${r.kind}:${r.workstream}/${r.id}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-reg-"));
  db = openDb({ path: join(dir, "mu.db") });
});
afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

describe("registerOwnedWait", () => {
  it("stores typed refs, armed, generation 0; nothing registered reads undefined", () => {
    expect(readWaitRegistration(db, "w/orch")).toBeUndefined();
    const reg = registerOwnedWait(db, "w/orch", [task("t1"), agent("w1")]);
    expect(reg).toMatchObject({ caller: "w/orch", state: "armed", generation: 0 });
    expect(keys("w/orch")).toEqual(["agent:w/w1", "task:w/t1"]);
    expect(readWaitRegistration(db, "w/orch")).toEqual(reg);
  });

  it("merges and dedupes across calls, in one canonical order", () => {
    registerOwnedWait(db, "c", [task("b"), task("a")]);
    registerOwnedWait(db, "c", [task("a"), delegate("d1"), task("c", "z")]);
    expect(keys("c")).toEqual(["delegate:w/d1", "task:w/a", "task:w/b", "task:z/c"]);
  });

  it("the same id of another kind or workstream is another ref", () => {
    registerOwnedWait(db, "c", [task("x"), agent("x"), task("x", "other")]);
    expect(keys("c")).toEqual(["agent:w/x", "task:other/x", "task:w/x"]);
  });

  it("callers are independent", () => {
    registerOwnedWait(db, "a", [task("t1")]);
    registerOwnedWait(db, "b", [task("t2")]);
    expect(keys("a")).toEqual(["task:w/t1"]);
    expect(keys("b")).toEqual(["task:w/t2"]);
  });

  it("is idempotent: the same refs again change nothing, not even updated_at's refs", () => {
    registerOwnedWait(db, "c", [task("t1")]);
    const before = readWaitRegistration(db, "c");
    registerOwnedWait(db, "c", [task("t1")]);
    expect(readWaitRegistration(db, "c")?.refs).toEqual(before?.refs);
    expect(readWaitRegistration(db, "c")?.generation).toBe(before?.generation);
  });

  it("registering while a wait is in flight keeps state and generation", () => {
    registerOwnedWait(db, "c", [task("t1")]);
    const w = beginWait(db, "c");
    registerOwnedWait(db, "c", [task("t2")]);
    expect(readWaitRegistration(db, "c")).toMatchObject({
      state: "waiting",
      generation: w?.generation,
    });
    expect(keys("c")).toEqual(["task:w/t1", "task:w/t2"]);
  });

  it.each<[string, string, RegisteredRef[]]>([
    ["a blank caller", " ", [{ kind: "task", workstream: "w", id: "t1" }]],
    ["a bad workstream", "c", [{ kind: "task", workstream: "Bad Name", id: "t1" }]],
    ["a bad task id", "c", [{ kind: "task", workstream: "w", id: "Not Valid" }]],
    ["a bad agent name", "c", [{ kind: "agent", workstream: "w", id: "Bad Name" }]],
    ["an empty delegate id", "c", [{ kind: "delegate", workstream: "w", id: "" }]],
    [
      "an absurdly long delegate id",
      "c",
      [{ kind: "delegate", workstream: "w", id: "d".repeat(513) }],
    ],
    [
      "an unknown kind",
      "c",
      [{ kind: "pane", workstream: "w", id: "x" } as unknown as RegisteredRef],
    ],
    ["an empty list", "c", []],
  ])("refuses %s and stores nothing", (_why, caller, refs) => {
    expect(() => registerOwnedWait(db, caller, refs)).toThrow(WaitRegistrationError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM wait_registrations").get()).toEqual({ n: 0 });
  });

  it("a delegate call id registers exactly as delegate_calls stores it (no private grammar)", () => {
    const ids = [`pi:${"a".repeat(36)}:toolu_01${"X".repeat(30)}`, "call_abc|fc_123", "c1"];
    registerOwnedWait(
      db,
      "c",
      ids.map((id) => delegate(id)),
    );
    expect(keys("c")).toEqual(ids.map((id) => `delegate:w/${id}`).sort());
  });

  describe("refs must exist now (checked inside the registering transaction)", () => {
    const count = () => db.prepare("SELECT COUNT(*) AS n FROM wait_registrations").get();
    it.each(WAIT_REF_KINDS)("a missing %s is refused in one line naming it", (kind) => {
      task("real"); // the workstream exists; only the ref is missing
      const ref = { task: "nope", agent: "ghost", delegate: "nocall" }[kind];
      let msg = "";
      try {
        registerOwnedWait(db, "c", [{ kind, workstream: "w", id: ref }]);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toBe(`wait registration: no ${kind} w/${ref}; nothing registered`);
      expect(count()).toEqual({ n: 0 });
    });

    it("a missing workstream is refused, naming it", () => {
      expect(() =>
        registerOwnedWait(db, "c", [{ kind: "task", workstream: "nows", id: "t" }]),
      ).toThrow(/^wait registration: no workstream nows /);
      expect(count()).toEqual({ n: 0 });
    });

    it("all or nothing: a valid ref beside a phantom stores neither, and keeps what was owed", () => {
      registerOwnedWait(db, "c", [task("keep")]);
      const good = task("good");
      expect(() =>
        registerOwnedWait(db, "c", [good, { kind: "agent", workstream: "w", id: "ghost" }]),
      ).toThrow(/no agent w\/ghost/);
      expect(keys("c")).toEqual(["task:w/keep"]);
    });

    it("an entity of ANOTHER workstream does not satisfy the ref", () => {
      task("only-in-w");
      agent("only-agent");
      delegate("only-call");
      ensureWorkstream(db, "other");
      for (const kind of WAIT_REF_KINDS) {
        const id = { task: "only-in-w", agent: "only-agent", delegate: "only-call" }[kind];
        expect(() => registerOwnedWait(db, "c", [{ kind, workstream: "other", id }])).toThrow(
          /nothing registered/,
        );
      }
      expect(count()).toEqual({ n: 0 });
    });

    it("a ref whose entity is deleted AFTER registration stays owed", () => {
      registerOwnedWait(db, "c", [task("soon-gone")]);
      db.prepare("DELETE FROM tasks WHERE local_id = 'soon-gone'").run();
      expect(keys("c")).toEqual(["task:w/soon-gone"]);
      registerOwnedWait(db, "c", [task("fresh")]); // re-registering the survivor is not needed
      expect(keys("c")).toEqual(["task:w/fresh", "task:w/soon-gone"]);
    });
  });

  it("one bad ref refuses the whole call: earlier valid refs are not stored", () => {
    registerOwnedWait(db, "c", [task("keep")]);
    expect(() => registerOwnedWait(db, "c", [task("ok"), task("BAD")])).toThrow(
      WaitRegistrationError,
    );
    expect(keys("c")).toEqual(["task:w/keep"]);
  });

  it("is bounded: more than the cap refuses, exactly the cap is accepted", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => task(`t${i}`));
    registerOwnedWait(db, "c", many(WAIT_REGISTRATION_MAX_REFS));
    expect(keys("c")).toHaveLength(WAIT_REGISTRATION_MAX_REFS);
    expect(() => registerOwnedWait(db, "c", [task("one-more")])).toThrow(/at most/);
    expect(keys("c")).toHaveLength(WAIT_REGISTRATION_MAX_REFS);
  });

  it("never touches wait_cursors, ops, or the cursor's consumed runs", () => {
    db.prepare(
      "INSERT INTO wait_cursors (caller, ref, incarnation, runs) VALUES ('c', 'agent:w/w1', 'i', 7)",
    ).run();
    const w1 = agent("w1"); // fixture ops first; only registration is measured
    const ops = db.prepare("SELECT COUNT(*) AS n FROM ops").get();
    registerOwnedWait(db, "c", [w1]);
    beginWait(db, "c");
    expect(db.prepare("SELECT * FROM wait_cursors").all()).toEqual([
      { caller: "c", ref: "agent:w/w1", incarnation: "i", runs: 7 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops").get()).toEqual(ops);
  });
});

describe("beginWait / endWait: one active wait per caller", () => {
  it("beginWait returns the refs and a generation, and marks the row waiting", () => {
    registerOwnedWait(db, "c", [task("t1"), agent("w1")]);
    const w = beginWait(db, "c");
    expect(w).toEqual({ generation: 1, refs: [agent("w1"), task("t1")], baselines: {} });
    expect(readWaitRegistration(db, "c")).toMatchObject({ state: "waiting", generation: 1 });
  });

  it("nothing registered, or nothing left owed: beginWait is undefined and writes nothing", () => {
    expect(beginWait(db, "c")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM wait_registrations").get()).toEqual({ n: 0 });
    registerOwnedWait(db, "c", [task("t1")]);
    const w = beginWait(db, "c");
    endWait(db, "c", w?.generation ?? -1, [task("t1")]);
    expect(beginWait(db, "c")).toBeUndefined();
  });

  it("endWait removes ONLY the delivered refs: an undelivered sibling stays owed", () => {
    registerOwnedWait(db, "c", [task("a"), task("b"), delegate("d1")]);
    const w = beginWait(db, "c");
    const r = endWait(db, "c", w?.generation ?? -1, [task("a")]);
    expect(r).toEqual({ applied: true });
    expect(readWaitRegistration(db, "c")).toMatchObject({ state: "armed" });
    expect(keys("c")).toEqual(["delegate:w/d1", "task:w/b"]);
  });

  it("endWait with nothing delivered (timeout, interrupt) keeps every ref and re-arms", () => {
    registerOwnedWait(db, "c", [task("a"), task("b")]);
    const w = beginWait(db, "c");
    endWait(db, "c", w?.generation ?? -1, []);
    expect(readWaitRegistration(db, "c")).toMatchObject({ state: "armed" });
    expect(keys("c")).toEqual(["task:w/a", "task:w/b"]);
  });

  it("a ref registered mid-wait survives the wait's end, even when delivered refs go", () => {
    registerOwnedWait(db, "c", [task("a")]);
    const w = beginWait(db, "c");
    registerOwnedWait(db, "c", [delegate("late")]);
    endWait(db, "c", w?.generation ?? -1, [task("a")]);
    expect(keys("c")).toEqual(["delegate:w/late"]);
  });

  it("a ref delivered but already gone (or never registered) is not an error", () => {
    registerOwnedWait(db, "c", [task("a")]);
    const w = beginWait(db, "c");
    expect(endWait(db, "c", w?.generation ?? -1, [task("zzz")])).toEqual({ applied: true });
    expect(keys("c")).toEqual(["task:w/a"]);
  });

  it("a newer wait supersedes an older one: the older finally cannot overwrite it", () => {
    registerOwnedWait(db, "c", [task("a"), task("b")]);
    const older = beginWait(db, "c");
    const newer = beginWait(db, "c"); // e.g. the older process died or was re-run
    expect(newer?.generation).toBeGreaterThan(older?.generation ?? 0);
    expect(endWait(db, "c", older?.generation ?? -1, [task("a")])).toEqual({ applied: false });
    expect(readWaitRegistration(db, "c")).toMatchObject({
      state: "waiting",
      generation: newer?.generation,
    });
    expect(keys("c")).toEqual(["task:w/a", "task:w/b"]);
    expect(endWait(db, "c", newer?.generation ?? -1, [task("b")])).toEqual({ applied: true });
    expect(keys("c")).toEqual(["task:w/a"]);
  });

  it("a second endWait of the same generation is a no-op (replay-safe)", () => {
    registerOwnedWait(db, "c", [task("a"), task("b")]);
    const w = beginWait(db, "c");
    endWait(db, "c", w?.generation ?? -1, [task("a")]);
    registerOwnedWait(db, "c", [task("a")]); // owed again after the first end
    expect(endWait(db, "c", w?.generation ?? -1, [task("a")])).toEqual({ applied: false });
    expect(keys("c")).toEqual(["task:w/a", "task:w/b"]);
  });

  it("generations only grow, also after every owed ref was delivered (the row is kept)", () => {
    registerOwnedWait(db, "c", [task("a")]);
    const g1 = beginWait(db, "c")?.generation ?? 0;
    endWait(db, "c", g1, [task("a")]);
    expect(readWaitRegistration(db, "c")).toMatchObject({ refs: [], state: "armed" });
    registerOwnedWait(db, "c", [task("a")]);
    const g2 = beginWait(db, "c")?.generation ?? 0;
    expect(g2).toBeGreaterThan(g1);
    // The first wait's generation can no longer match.
    expect(endWait(db, "c", g1, [task("a")])).toEqual({ applied: false });
  });

  it("endWait of an unknown caller is a no-op", () => {
    expect(endWait(db, "nobody", 1, [])).toEqual({ applied: false });
  });

  it("a failure inside endWait rolls the whole write back", () => {
    registerOwnedWait(db, "c", [task("a"), task("b")]);
    const w = beginWait(db, "c");
    const before = readWaitRegistration(db, "c");
    expect(() =>
      endWait(db, "c", w?.generation ?? -1, [{ kind: "bogus" } as unknown as RegisteredRef]),
    ).toThrow(WaitRegistrationError);
    expect(readWaitRegistration(db, "c")).toEqual(before);
  });

  it("holds no write lock between begin and end: another connection writes meanwhile", () => {
    registerOwnedWait(db, "c", [task("a")]);
    beginWait(db, "c");
    const other = new Database(join(dir, "mu.db"));
    try {
      other.pragma("busy_timeout = 100");
      expect(() =>
        other.prepare("UPDATE schema_version SET version = version WHERE id = 1").run(),
      ).not.toThrow();
    } finally {
      other.close();
    }
  });

  // A second THREAD (own connection) takes the write lock, signals, holds it
  // ~50ms, runs `sql`, commits. The caller registers while it is held.
  const withWriterHolding = (sql: string, during: () => void): void => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(
      `const { workerData: w } = require("node:worker_threads");
       const D = require("better-sqlite3");
       const d = new D(w.path);
       d.pragma("busy_timeout = 5000");
       d.exec("BEGIN IMMEDIATE");
       Atomics.store(w.flag, 0, 1); Atomics.notify(w.flag, 0);
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
       d.exec(w.sql); d.exec("COMMIT"); d.close();
       Atomics.store(w.flag, 0, 2); Atomics.notify(w.flag, 0);`,
      { eval: true, workerData: { path: join(dir, "mu.db"), flag, sql } },
    );
    try {
      expect(Atomics.wait(flag, 0, 0, 5000)).not.toBe("timed-out"); // lock is held now
      during();
      Atomics.wait(flag, 0, 1, 5000); // the writer committed
    } finally {
      void worker.terminate();
    }
  };

  it("registerOwnedWait takes the write lock at BEGIN: a writer committing meanwhile is waited for, not a stale-snapshot BUSY", () => {
    const a = task("a");
    const b = task("b");
    registerOwnedWait(db, "c", [a]);
    withWriterHolding("UPDATE schema_version SET version = version WHERE id = 1", () => {
      expect(keys("c")).toEqual(["task:w/a"]);
      registerOwnedWait(db, "c", [b]);
    });
    expect(keys("c")).toEqual(["task:w/a", "task:w/b"]);
  });

  it("existence is checked after the lock is taken: a ref deleted by the writer ahead of us is refused", () => {
    const doomed = task("doomed");
    withWriterHolding("DELETE FROM tasks WHERE local_id = 'doomed'", () => {
      expect(() => registerOwnedWait(db, "c", [doomed])).toThrow(/no task w\/doomed/);
    });
    expect(readWaitRegistration(db, "c")).toBeUndefined();
  });

  it("two connections racing beginWait get distinct generations", () => {
    registerOwnedWait(db, "c", [task("a")]);
    const db2 = openDb({ path: join(dir, "mu.db") });
    try {
      const a = beginWait(db, "c");
      const b = beginWait(db2, "c");
      expect(a?.generation).not.toBe(b?.generation);
    } finally {
      db2.close();
    }
  });
});

describe("storage", () => {
  it("a corrupt refs_json reads as an error, never as an empty (lost) registration", () => {
    registerOwnedWait(db, "c", [task("a")]);
    db.prepare("UPDATE wait_registrations SET refs_json = 'not json'").run();
    expect(() => readWaitRegistration(db, "c")).toThrow(WaitRegistrationError);
  });

  it("state and generation are constrained", () => {
    registerOwnedWait(db, "c", [task("a")]);
    expect(() => db.prepare("UPDATE wait_registrations SET state = 'done'").run()).toThrow(
      /CHECK/i,
    );
    expect(() => db.prepare("UPDATE wait_registrations SET generation = -1").run()).toThrow(
      /CHECK/i,
    );
  });
});
