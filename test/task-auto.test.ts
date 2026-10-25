// `mu task auto` (v_auto): explicit, host-fenced permission for the executor.
// SDK predicates and authorizeTasks against real temp DBs; the CLI verb in-process.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommandResolverForTests, setCommandResolverForTests } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { discoverPeers, flushSegment, ingestSegment, localMachineId } from "../src/segments.js";
import {
  authorisedReady,
  authorizeTasks,
  autoPermitted,
  getAutoConfig,
  openBlockersClosure,
  TaskAutoArgError,
  TaskAutoRefusedError,
} from "../src/task-auto.js";
import { taskIdFor } from "../src/tasks/core.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { closeTask, parkTask } from "../src/tasks/lifecycle.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-task-auto-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "d");
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
});
afterEach(() => {
  resetCommandResolverForTests();
  try {
    db.close();
  } catch {}
  rmFixtureDir(tempDir);
});

const add = (id: string, ws = "d") => addTask(db, { workstream: ws, localId: id, title: id });
const tid = (id: string, ws = "d") => {
  const n = taskIdFor(db, id, ws);
  if (n === null) throw new Error(`no task ${id}`);
  return n;
};
const auto = (ids: string[], o: Partial<Parameters<typeof authorizeTasks>[2]> = {}) =>
  authorizeTasks(db, ids, { workstream: "d", cli: "pi", worktree: false, maxRuns: 1, ...o });
const host = (id: string) =>
  (
    db.prepare("SELECT dispatch_host AS h FROM tasks WHERE local_id = ?").get(id) as {
      h: string | null;
    }
  ).h;
const FOREIGN = "9f1c8a2e-0000-4000-8000-0000000000bb";

describe("ready is not permission", () => {
  it("an unauthorised ready task is not authorisedReady and not permitted", () => {
    add("a");
    expect(authorisedReady(db, "d")).toEqual([]);
    expect(autoPermitted(db, tid("a"))).toBe(false);
  });

  it("authorising stores config + names this machine; authorisedReady returns it with its config", () => {
    add("a");
    const r = auto(["a"], { cli: "pi-big", worktree: true, maxRuns: 3 });
    expect(r).toEqual({ ids: ["a"], changed: true });
    expect(host("a")).toBe(localMachineId(db));
    expect(getAutoConfig(db, tid("a"))).toMatchObject({
      cli: "pi-big",
      worktree: true,
      maxRuns: 3,
      runs: 0,
      enabled: true,
    });
    expect(autoPermitted(db, tid("a"))).toBe(true);
    expect(authorisedReady(db, "d").map((t) => [t.name, t.auto.cli])).toEqual([["a", "pi-big"]]);
  });

  it("re-authorising identically is a no-op", () => {
    add("a");
    auto(["a"]);
    expect(auto(["a"]).changed).toBe(false);
  });

  it("a task with a local row but another host's designation is not permitted", () => {
    add("a");
    auto(["a"]);
    db.prepare("UPDATE tasks SET dispatch_host = ?").run(FOREIGN);
    expect(autoPermitted(db, tid("a"))).toBe(false);
    expect(authorisedReady(db, "d")).toEqual([]);
  });
});

describe("permission predicate vs ready eligibility", () => {
  it("autoPermitted ignores status; authorisedReady needs ready and runs < max", () => {
    add("a");
    auto(["a"]);
    const id = tid("a");
    db.prepare("UPDATE tasks SET status = 'IN_PROGRESS', substate = 'active'").run();
    expect(autoPermitted(db, id)).toBe(true);
    expect(authorisedReady(db, "d")).toEqual([]);
  });

  it("an exhausted ceiling leaves permission but drops it from authorisedReady", () => {
    add("a");
    auto(["a"], { maxRuns: 2 });
    db.prepare("UPDATE task_auto SET runs = 2").run();
    expect(autoPermitted(db, tid("a"))).toBe(true);
    expect(authorisedReady(db, "d")).toEqual([]);
    db.prepare("UPDATE task_auto SET runs = 1").run();
    expect(authorisedReady(db, "d")).toHaveLength(1);
  });

  it("blocked tasks are authorised but not ready until the blocker closes", () => {
    add("blocker");
    add("t");
    addBlockEdge(db, "d", "t", "blocker");
    auto(["t"]);
    expect(authorisedReady(db, "d")).toEqual([]);
    closeTask(db, "blocker", { workstream: "d", evidence: "done" });
    expect(authorisedReady(db, "d").map((t) => t.name)).toEqual(["t"]);
  });
});

describe("--off", () => {
  it("keeps runs and last_spawn, and re-authorising does not reset them", () => {
    add("a");
    auto(["a"]);
    db.prepare("UPDATE task_auto SET runs = 1, last_spawn = 'auto:attempt-1'").run();
    expect(auto(["a"], { off: true }).changed).toBe(true);
    expect(autoPermitted(db, tid("a"))).toBe(false);
    expect(host("a")).toBeNull();
    expect(getAutoConfig(db, tid("a"))).toMatchObject({
      enabled: false,
      runs: 1,
      lastSpawn: "auto:attempt-1",
    });
    auto(["a"], { cli: "pi2", maxRuns: 5 });
    expect(getAutoConfig(db, tid("a"))).toMatchObject({
      enabled: true,
      cli: "pi2",
      maxRuns: 5,
      runs: 1,
      lastSpawn: "auto:attempt-1",
    });
    expect(autoPermitted(db, tid("a"))).toBe(true);
  });

  it("on a task another host owns: revokes local permission, leaves their designation, and permission stays off if it returns", () => {
    add("a");
    auto(["a"]);
    db.prepare("UPDATE tasks SET dispatch_host = ?").run(FOREIGN);
    expect(auto(["a"], { off: true }).changed).toBe(true);
    expect(host("a")).toBe(FOREIGN);
    expect(getAutoConfig(db, tid("a"))?.enabled).toBe(false);
    // The designation comes back to this machine (LWW): still not permitted.
    db.prepare("UPDATE tasks SET dispatch_host = ?").run(localMachineId(db));
    expect(autoPermitted(db, tid("a"))).toBe(false);
    expect(authorisedReady(db, "d")).toEqual([]);
  });

  it("off on a never-authorised task is a no-op and creates no row", () => {
    add("a");
    expect(auto(["a"], { off: true }).changed).toBe(false);
    expect(getAutoConfig(db, tid("a"))).toBeUndefined();
  });

  it("needs no --cli or valid --max", () => {
    add("a");
    expect(() => auto(["a"], { off: true, cli: "", maxRuns: 0 })).not.toThrow();
  });
});

describe("refusals write nothing", () => {
  it("refuses another host's designated task, and a mixed batch rolls back whole", () => {
    add("a");
    add("b");
    db.prepare("UPDATE tasks SET dispatch_host = ? WHERE local_id = 'b'").run(FOREIGN);
    const opsBefore = db.prepare("SELECT COUNT(*) AS n FROM ops").get();
    expect(() => auto(["a", "b"])).toThrow(TaskAutoRefusedError);
    expect(() => auto(["a", "b"])).toThrow(/another host/);
    expect(getAutoConfig(db, tid("a"))).toBeUndefined();
    expect(host("a")).toBeNull();
    expect(host("b")).toBe(FOREIGN);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops").get()).toEqual(opsBefore);
  });

  it("a missing id later in the batch rolls back the earlier ones", () => {
    add("a");
    expect(() => auto(["a", "nope"])).toThrow(/no such task/);
    expect(getAutoConfig(db, tid("a"))).toBeUndefined();
  });

  it.each([
    ["human", "human"],
    ["delegate", "delegate"],
  ])("refuses a %s task", (kind) => {
    add("k");
    db.prepare("UPDATE tasks SET kind = ?").run(kind);
    expect(() => auto(["k"])).toThrow(new RegExp(`${kind} task`));
    expect(getAutoConfig(db, tid("k"))).toBeUndefined();
  });

  it("refuses parked, triage and CLOSED tasks", () => {
    add("p");
    parkTask(db, "p", { workstream: "d", why: "later" });
    expect(() => auto(["p"])).toThrow(/parked/);
    addTask(db, { workstream: "d", localId: "tr", title: "tr", triage: true } as never);
    expect(() => auto(["tr"])).toThrow(/triage/);
    add("c");
    closeTask(db, "c", { workstream: "d", evidence: "x" });
    expect(() => auto(["c"])).toThrow(/CLOSED/);
  });

  it("refuses the reserved scratch queue", () => {
    expect(() => auto(["a"], { workstream: "scratch" })).toThrow(TaskAutoArgError);
    expect(authorisedReady(db, "scratch")).toEqual([]);
  });

  it("rejects a bad cli key, a bad ceiling and an empty selection before any write", () => {
    add("a");
    expect(() => auto(["a"], { cli: "bad key" })).toThrow(TaskAutoArgError);
    expect(() => auto(["a"], { cli: "" })).toThrow(TaskAutoArgError);
    expect(() => auto(["a"], { maxRuns: 0 })).toThrow(TaskAutoArgError);
    expect(() => auto(["a"], { maxRuns: 1.5 })).toThrow(TaskAutoArgError);
    expect(() => auto([])).toThrow(/no tasks/);
    expect(getAutoConfig(db, tid("a"))).toBeUndefined();
  });

  it("the same local id in another workstream is untouched", () => {
    ensureWorkstream(db, "e");
    add("x");
    add("x", "e");
    auto(["x"]);
    expect(autoPermitted(db, tid("x", "d"))).toBe(true);
    expect(autoPermitted(db, tid("x", "e"))).toBe(false);
    expect(authorisedReady(db, "e")).toEqual([]);
  });
});

describe("--blockers-of", () => {
  // top <- m1, m2 <- leaf (diamond), closed <- m1, other-ws blocker impossible
  const diamond = () => {
    for (const id of ["top", "m1", "m2", "leaf", "done"]) add(id);
    addBlockEdge(db, "d", "top", "m1");
    addBlockEdge(db, "d", "top", "m2");
    addBlockEdge(db, "d", "m1", "leaf");
    addBlockEdge(db, "d", "m2", "leaf");
    addBlockEdge(db, "d", "m1", "done");
    closeTask(db, "done", { workstream: "d", evidence: "x" });
  };

  it("expands the open transitive blockers, deterministically, excluding the umbrella and CLOSED", () => {
    diamond();
    const wsId = (db.prepare("SELECT id FROM workstreams WHERE name = 'd'").get() as { id: number })
      .id;
    expect(openBlockersClosure(db, wsId, tid("top"))).toEqual(["leaf", "m1", "m2"]);
    const r = auto([], { blockersOf: "top" });
    expect(r.ids).toEqual(["leaf", "m1", "m2"]);
    expect(autoPermitted(db, tid("top"))).toBe(false);
    expect(autoPermitted(db, tid("done"))).toBe(false);
    expect(autoPermitted(db, tid("leaf"))).toBe(true);
  });

  it("is not capped by the display frontier depth", () => {
    const n = 40;
    for (let i = 0; i <= n; i++) add(`c${i}`);
    for (let i = 0; i < n; i++) addBlockEdge(db, "d", `c${i}`, `c${i + 1}`);
    expect(auto([], { blockersOf: "c0" }).ids).toHaveLength(n);
  });

  it("merges with explicit ids without duplicates; an umbrella with nothing open is an error", () => {
    diamond();
    expect(auto(["leaf", "top"], { blockersOf: "top" }).ids).toEqual(["leaf", "top", "m1", "m2"]);
    expect(() => auto([], { blockersOf: "leaf" })).toThrow(/no open blockers/);
  });

  it("all or nothing: one unauthorisable blocker refuses the batch", () => {
    diamond();
    db.prepare("UPDATE tasks SET dispatch_host = ? WHERE local_id = 'leaf'").run(FOREIGN);
    expect(() => auto([], { blockersOf: "top" })).toThrow(TaskAutoRefusedError);
    expect(getAutoConfig(db, tid("m1"))).toBeUndefined();
  });
});

describe("op capture", () => {
  it("one group per call, attributed; only the portable host field is captured, never task_auto", () => {
    add("a");
    add("b");
    const before = (
      db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM ops").get() as { m: number }
    ).m;
    auto(["a", "b"], { actor: "orch-1" });
    const ops = db
      .prepare(
        "SELECT entity, key, actor, intent, group_id, payload FROM ops WHERE rowid > ? ORDER BY rowid",
      )
      .all(before) as {
      entity: string;
      actor: string;
      intent: string;
      group_id: string;
      payload: string;
    }[];
    expect(ops.every((o) => o.entity === "task")).toBe(true);
    expect(ops).toHaveLength(2);
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    expect(ops.every((o) => o.actor === "orch-1" && o.intent === "task.auto")).toBe(true);
    expect(ops.every((o) => JSON.parse(o.payload).dispatch_host === localMachineId(db))).toBe(true);
  });
});

describe("two peers (LWW)", () => {
  it("the loser stops being permitted after ingest; the owner's local row never syncs", async () => {
    const dir = join(tempDir, "sync");
    mkdirSync(dir, { recursive: true });
    const other = openDb({ path: join(tempDir, "peer.db") });
    try {
      add("a");
      await flushSegment(db, dir);
      const mine = localMachineId(db);
      const theirs = localMachineId(other);
      const peerOfMe = discoverPeers(dir, theirs).find((p) => p.machineId === mine);
      if (peerOfMe === undefined) throw new Error("no peer");
      ingestSegment(other, peerOfMe);

      // A authorises, then B authorises LATER; both are permitted until they ingest.
      authorizeTasks(db, ["a"], { workstream: "d", cli: "pi", worktree: false, maxRuns: 1 });
      await new Promise((r) => setTimeout(r, 5));
      authorizeTasks(other, ["a"], { workstream: "d", cli: "pi", worktree: false, maxRuns: 1 });
      expect(autoPermitted(db, tid("a"))).toBe(true);
      await flushSegment(other, dir);
      await flushSegment(db, dir);

      const fromOther = discoverPeers(dir, mine).find((p) => p.machineId === theirs);
      if (fromOther === undefined) throw new Error("no peer");
      ingestSegment(db, fromOther);
      expect(host("a")).toBe(theirs);
      expect(autoPermitted(db, tid("a"))).toBe(false);
      expect(authorisedReady(db, "d")).toEqual([]);
      // The loser's local row (counters) is still there, enabled but fenced.
      expect(getAutoConfig(db, tid("a"))?.enabled).toBe(true);

      // B never received A's task_auto row.
      const peerOfMe2 = discoverPeers(dir, theirs).find((p) => p.machineId === mine);
      if (peerOfMe2 === undefined) throw new Error("no peer");
      ingestSegment(other, peerOfMe2);
      expect((other.prepare("SELECT COUNT(*) AS n FROM task_auto").get() as { n: number }).n).toBe(
        1,
      );
      expect(
        autoPermitted(other, (other.prepare("SELECT id FROM tasks").get() as { id: number }).id),
      ).toBe(true);
    } finally {
      other.close();
    }
  });
});

describe("mu task auto (CLI)", () => {
  beforeEach(() => {
    add("a");
    add("b");
    db.close();
  });
  const rows = () => {
    const x = openDb({ path: dbPath });
    try {
      return x
        .prepare(
          "SELECT t.local_id AS id, a.cli, a.worktree, a.max_runs, a.enabled FROM task_auto a JOIN tasks t ON t.id = a.task_id ORDER BY t.local_id",
        )
        .all();
    } finally {
      x.close();
    }
  };

  it("--cli --worktree --max authorises; default max is 1; --json is an envelope", async () => {
    const r = await runCliJson(["task", "auto", "a", "--cli", "pi", "-w", "d", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ ids: ["a"], changed: true, off: false });
    await runCli(
      ["task", "auto", "b", "--cli", "pi-big", "--worktree", "--max", "3", "-w", "d"],
      dbPath,
    );
    expect(rows()).toEqual([
      { id: "a", cli: "pi", worktree: 0, max_runs: 1, enabled: 1 },
      { id: "b", cli: "pi-big", worktree: 1, max_runs: 3, enabled: 1 },
    ]);
  });

  it("--off needs no --cli; a grant without --cli is a usage error (2)", async () => {
    await runCli(["task", "auto", "a", "--cli", "pi", "-w", "d"], dbPath);
    const off = await runCli(["task", "auto", "a", "--off", "-w", "d"], dbPath);
    expect(off.exitCode).toBeNull();
    expect(rows()).toEqual([{ id: "a", cli: "pi", worktree: 0, max_runs: 1, enabled: 0 }]);
    const bad = await runCli(["task", "auto", "b", "-w", "d"], dbPath);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr + bad.stdout).toMatch(/--cli/);
  });

  it("--max 0 and non-numbers are parse errors; a foreign host is exit 4", async () => {
    expect(
      (await runCli(["task", "auto", "a", "--cli", "pi", "--max", "0", "-w", "d"], dbPath))
        .exitCode,
    ).toBe(2);
    expect(
      (await runCli(["task", "auto", "a", "--cli", "pi", "--max", "x", "-w", "d"], dbPath))
        .exitCode,
    ).toBe(2);
    const x = openDb({ path: dbPath });
    x.prepare("UPDATE tasks SET dispatch_host = ? WHERE local_id = 'a'").run(FOREIGN);
    x.close();
    const r = await runCli(["task", "auto", "a", "--cli", "pi", "-w", "d"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.stderr + r.stdout).toMatch(/another host/);
  });

  it("--blockers-of expands in the CLI; a cli key that resolves to nothing is refused before any write", async () => {
    const x = openDb({ path: dbPath });
    addBlockEdge(x, "d", "a", "b");
    x.close();
    const r = await runCliJson(
      ["task", "auto", "--blockers-of", "a", "--cli", "pi", "-w", "d", "--json"],
      dbPath,
    );
    expect(r.data.ids).toEqual(["b"]);
    setCommandResolverForTests(async (c) => ({ ok: false, binary: c }));
    const bad = await runCli(["task", "auto", "a", "--cli", "nope", "-w", "d"], dbPath);
    expect(bad.exitCode).toBe(1);
    expect(rows().map((r) => (r as { id: string }).id)).toEqual(["b"]);
  });
});
