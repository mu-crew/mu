// v_dashboard_core: loadDashboard, the one READ-ONLY projection the dashboard
// tabs share. Real SQLite, mocked mux (fast tier).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { FRONTIER_MAX_NODES } from "../src/dag.js";
import { type DashboardSnapshot, loadDashboard } from "../src/dashboard-data.js";
import { type Db, openDb } from "../src/db.js";
import { markDelegate, registerDelegateCall } from "../src/delegates.js";
import { recordHumanNeeded } from "../src/human-needed.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { claimTask, closeTask, parkTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-dashboard-data-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  mux = installMux("tmux", [["list-panes", ""]]);
  ensureWorkstream(db, "ws");
});
afterEach(() => {
  mux.restore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const task = (id: string, extra: Partial<Parameters<typeof addTask>[1]> = {}, ws = "ws") =>
  addTask(db, {
    workstream: ws,
    localId: id,
    title: `title ${id}`,
    impact: 10,
    effortDays: 1,
    ...extra,
  });
const opCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
const keys = (s: DashboardSnapshot): string[] => s.tasks.map((t) => t.key);

describe("workstreams: every live one, scratch included", () => {
  it("lists live workstreams with the scratch flag and latest op seq; torn-down ones are absent", async () => {
    ensureWorkstream(db, "scratch");
    ensureWorkstream(db, "gone");
    db.prepare(
      "UPDATE workstreams SET torn_down_at = '2026-01-01T00:00:00Z' WHERE name = 'gone'",
    ).run();
    task("a");
    const snap = await loadDashboard(db, { caller: null });
    expect(snap.workstreams.map((w) => [w.name, w.scratch])).toEqual([
      ["scratch", true],
      ["ws", false],
    ]);
    const ws = snap.workstreams.find((w) => w.name === "ws");
    // Exact, per workstream: the newest visible op of that workstream, not the global max.
    const taskOps = (name: string): number =>
      (
        db
          .prepare("SELECT MAX(seq) AS n FROM ops WHERE entity = 'task' AND key LIKE ?")
          .get(`${name}/%`) as { n: number }
      ).n;
    expect(ws?.latest_seq).toBe(taskOps("ws"));
    const scratch = snap.workstreams.find((w) => w.name === "scratch");
    expect(scratch?.latest_seq).toBe(
      (
        db.prepare("SELECT MAX(seq) AS n FROM ops WHERE key LIKE 'scratch%'").get() as {
          n: number;
        }
      ).n,
    );
    expect(scratch?.latest_seq).toBeLessThan(ws?.latest_seq ?? 0);
  });

  it("the switcher is not narrowed by a workstream filter; an unknown filter is WorkstreamNotFoundError", async () => {
    ensureWorkstream(db, "other");
    const snap = await loadDashboard(db, { caller: null, workstream: "other" });
    expect(snap.workstreams.map((w) => w.name)).toEqual(["other", "ws"]);
    await expect(loadDashboard(db, { caller: null, workstream: "nope" })).rejects.toMatchObject({
      name: "WorkstreamNotFoundError",
    });
  });
});

describe("tasks: exhaustive, qualified, activity-ordered", () => {
  it("shows OPEN/parked/triage/IN_PROGRESS by default and hides CLOSED; the status filter brings CLOSED back uncapped", async () => {
    for (let i = 0; i < 7; i++) {
      task(`c${i}`);
      closeTask(db, `c${i}`, { workstream: "ws", author: "me", evidence: "e" });
    }
    task("open1");
    task("park1");
    parkTask(db, "park1", { workstream: "ws", why: "later", author: "me" });
    task("prog");
    await claimTask(db, "prog", { workstream: "ws", self: true, actor: "me" });
    const snap = await loadDashboard(db, { caller: null });
    expect(new Set(keys(snap))).toEqual(new Set(["ws/open1", "ws/park1", "ws/prog"]));
    expect(snap.tasks.find((t) => t.key === "ws/park1")).toMatchObject({
      workstream: "ws",
      id: "park1",
      status: "OPEN",
      substate: "parked",
      title: "title park1",
    });
    const closed = await loadDashboard(db, { caller: null, status: ["CLOSED"] });
    expect(closed.tasks).toHaveLength(7); // stateSnapshot's recent_closed caps at five
    const all = await loadDashboard(db, {
      caller: null,
      status: ["OPEN", "IN_PROGRESS", "CLOSED"],
    });
    expect(all.tasks).toHaveLength(10);
  });

  it("owner shows only while IN_PROGRESS", async () => {
    ensureWorkstream(db, "ws");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    task("a");
    task("b");
    await claimTask(db, "a", { agentName: "w1", workstream: "ws" });
    await claimTask(db, "b", { agentName: "w1", workstream: "ws" });
    closeTask(db, "b", { workstream: "ws", author: "me", evidence: "e" });
    const snap = await loadDashboard(db, { caller: null, status: ["IN_PROGRESS", "CLOSED"] });
    expect(snap.tasks.find((t) => t.key === "ws/a")?.owner).toBe("w1");
    expect(snap.tasks.find((t) => t.key === "ws/b")?.owner).toBeNull();
    expect(snap.tasks.find((t) => t.key === "ws/b")?.owner_id).toBeNull();
    expect(snap.tasks.find((t) => t.key === "ws/b")?.owner_workstream).toBeNull();
  });

  it("a task claimed by a same-named agent of ANOTHER workstream is attributed by registry id, with the owner's own workstream", async () => {
    ensureWorkstream(db, "beta");
    insertAgent(db, { name: "worker-1", workstream: "ws", paneId: "%1" });
    insertAgent(db, { name: "worker-1", workstream: "beta", paneId: "%2" });
    task("shared");
    await claimTask(db, "shared", {
      workstream: "ws",
      agentName: "worker-1",
      agentWorkstream: "beta",
    });
    const betaId = (
      db
        .prepare(
          "SELECT a.id FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE w.name = 'beta'",
        )
        .get() as { id: number }
    ).id;
    const snap = await loadDashboard(db, { caller: null });
    expect(snap.agents.map((a) => [a.key, a.tasks])).toEqual([
      ["beta/worker-1", ["ws/shared"]],
      ["ws/worker-1", []],
    ]);
    expect(snap.agents.find((a) => a.key === "ws/worker-1")?.task).toBeNull();
    expect(snap.tasks[0]).toMatchObject({
      key: "ws/shared",
      owner: "worker-1",
      owner_id: betaId,
      owner_workstream: "beta",
    });
    // A filtered read still attributes it: the owner's workstream is not the task's.
    const beta = await loadDashboard(db, { caller: null, workstream: "beta" });
    expect(beta.agents.map((a) => [a.key, a.tasks])).toEqual([["beta/worker-1", ["ws/shared"]]]);
    const ws = await loadDashboard(db, { caller: null, workstream: "ws" });
    expect(ws.agents.map((a) => [a.key, a.tasks])).toEqual([["ws/worker-1", []]]);
  });

  it("a raw db write (no mu verb) reorders by MAX(ops.seq): note and edge ops count too", async () => {
    ensureWorkstream(db, "ws2");
    task("a");
    task("b");
    task("c");
    task("same", {}, "ws2");
    let snap = await loadDashboard(db, { caller: null });
    expect(keys(snap).filter((k) => k.startsWith("ws/"))).toEqual(["ws/c", "ws/b", "ws/a"]);
    // A manual captured update on `a` (what `mu sql` / a db write does) puts it on top.
    db.prepare(
      "UPDATE tasks SET title = 'edited' WHERE local_id = 'a' AND workstream_id = (SELECT id FROM workstreams WHERE name = 'ws')",
    ).run();
    snap = await loadDashboard(db, { caller: null });
    expect(snap.tasks[0]?.key).toBe("ws/a");
    // A note on `b`, then an edge touching `c`.
    addNote(db, "b", "hello", { workstream: "ws", author: "me" });
    snap = await loadDashboard(db, { caller: null, workstream: "ws" });
    expect(keys(snap)).toEqual(["ws/b", "ws/a", "ws/c"]);
    addBlockEdge(db, "ws", "c", "a");
    snap = await loadDashboard(db, { caller: null, workstream: "ws" });
    // the edge bumps both ends; `a` and `c` now share the newest op, `b` is older
    expect(keys(snap).slice(0, 2).sort()).toEqual(["ws/a", "ws/c"]);
    expect(snap.tasks.at(-1)?.key).toBe("ws/b");
    const seqs = snap.tasks.map((t) => t.activity_seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x));
  });

  it("raw note and edge inserts (no SDK task touch) report the EXACT ops.seq on the right tasks", async () => {
    task("a");
    task("b");
    task("c");
    const id = (local: string) =>
      (db.prepare("SELECT id FROM tasks WHERE local_id = ?").get(local) as { id: number }).id;
    const maxSeq = (entity: string): number =>
      (db.prepare("SELECT MAX(seq) AS n FROM ops WHERE entity = ?").get(entity) as { n: number }).n;
    const act = async (): Promise<Record<string, number>> =>
      Object.fromEntries(
        (await loadDashboard(db, { caller: null })).tasks.map((t) => [t.id, t.activity_seq]),
      );
    const before = await act();
    db.prepare(
      "INSERT INTO task_notes (task_id, author, content, kind, created_at) VALUES (?, 'r', 'raw', 'note', ?)",
    ).run(id("a"), new Date().toISOString());
    const noteSeq = maxSeq("note");
    expect(noteSeq).toBeGreaterThan(Math.max(...Object.values(before)));
    expect(await act()).toEqual({ ...before, a: noteSeq });
    db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    ).run(id("b"), id("c"), new Date().toISOString());
    const edgeSeq = maxSeq("edge");
    expect(edgeSeq).toBeGreaterThan(noteSeq);
    expect(await act()).toEqual({ a: noteSeq, b: edgeSeq, c: edgeSeq });
  });

  it("same local id in two workstreams keeps distinct qualified keys; the workstream filter narrows", async () => {
    ensureWorkstream(db, "ws2");
    task("t");
    task("t", {}, "ws2");
    const both = await loadDashboard(db, { caller: null });
    expect(new Set(keys(both))).toEqual(new Set(["ws/t", "ws2/t"]));
    const one = await loadDashboard(db, { caller: null, workstream: "ws2" });
    expect(keys(one)).toEqual(["ws2/t"]);
  });

  it("the text filter matches id, title and owner case-insensitively and keeps the sort", async () => {
    insertAgent(db, { name: "Alice", workstream: "ws", paneId: "%1" });
    task("alpha", { title: "Fix the Parser" });
    task("beta", { title: "other" });
    task("gamma", { title: "also other" });
    await claimTask(db, "gamma", { agentName: "Alice", workstream: "ws" });
    expect(keys(await loadDashboard(db, { caller: null, text: "PARSER" }))).toEqual(["ws/alpha"]);
    expect(keys(await loadDashboard(db, { caller: null, text: "beta" }))).toEqual(["ws/beta"]);
    expect(keys(await loadDashboard(db, { caller: null, text: "alice" }))).toEqual(["ws/gamma"]);
  });
});

describe("edges: the open DAG frontier, not every root", () => {
  it("lists open tasks from the frontier with qualified parent keys; CLOSED tasks do not appear", async () => {
    task("root");
    task("mid");
    task("leaf");
    task("done");
    addBlockEdge(db, "ws", "mid", "root"); // root blocks mid
    addBlockEdge(db, "ws", "leaf", "mid");
    closeTask(db, "done", { workstream: "ws", author: "me", evidence: "e" });
    const snap = await loadDashboard(db, { caller: null });
    expect(snap.edges.map((e) => [e.key, e.parent, e.depth])).toEqual([
      ["ws/root", null, 0],
      ["ws/mid", "ws/root", 1],
      ["ws/leaf", "ws/mid", 2],
    ]);
    expect(snap.edges[0]).toMatchObject({
      workstream: "ws",
      id: "root",
      status: "OPEN",
      again: false,
    });
  });

  it("a parked task is in the frontier (the snapshot ready list omits it)", async () => {
    task("p");
    parkTask(db, "p", { workstream: "ws", why: "later", author: "me" });
    const snap = await loadDashboard(db, { caller: null });
    expect(snap.edges.map((e) => e.key)).toEqual(["ws/p"]);
    expect(snap.edges[0]?.substate).toBe("parked");
  });
});

describe("frontier: the cuts are passed through, never dropped", () => {
  it("reports one cut record per workstream; zero when nothing was cut", async () => {
    ensureWorkstream(db, "other");
    task("a");
    const snap = await loadDashboard(db, { caller: null });
    expect(snap.frontier).toEqual([
      { workstream: "other", roots_cut: 0, again_cut: 0 },
      { workstream: "ws", roots_cut: 0, again_cut: 0 },
    ]);
    const one = await loadDashboard(db, { caller: null, workstream: "ws" });
    expect(one.frontier.map((f) => f.workstream)).toEqual(["ws"]);
  });

  it("independent roots past the node cap show up as roots_cut, qualified by workstream", async () => {
    ensureWorkstream(db, "other");
    task("o1", {}, "other");
    db.transaction(() => {
      for (let i = 0; i < FRONTIER_MAX_NODES + 1; i++) task(`t${i}`);
    })();
    const snap = await loadDashboard(db, { caller: null });
    expect(snap.edges.filter((e) => e.workstream === "ws")).toHaveLength(FRONTIER_MAX_NODES);
    expect(snap.frontier).toEqual([
      { workstream: "other", roots_cut: 0, again_cut: 0 },
      { workstream: "ws", roots_cut: 1, again_cut: 0 },
    ]);
  });
});

describe("agents: registry fields, scratch included, unknown stays unknown", () => {
  it("lists agents of every live workstream with state, owned task and the reserved tool slot", async () => {
    ensureWorkstream(db, "scratch");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1", host: "dev", cwd: "/wt" });
    insertAgent(db, { name: "s1", workstream: "scratch", paneId: "%2" });
    task("a");
    await claimTask(db, "a", { agentName: "w1", workstream: "ws" });
    const snap = await loadDashboard(db, { caller: null });
    expect(snap.agents.map((a) => a.key)).toEqual(["scratch/s1", "ws/w1"]);
    const w1 = snap.agents.find((a) => a.key === "ws/w1");
    expect(w1).toMatchObject({
      name: "w1",
      workstream: "ws",
      host: "dev",
      cwd: "/wt",
      tasks: ["ws/a"],
      task: "ws/a",
    });
    expect(w1?.state).toBe("unknown"); // no pane state source: never guessed idle or busy
    expect(w1?.tool).toBeUndefined();
    expect(snap.agents.find((a) => a.key === "scratch/s1")?.task).toBeNull();
  });

  it("the workstream filter narrows agents; the text filter matches name and task", async () => {
    ensureWorkstream(db, "scratch");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    insertAgent(db, { name: "s1", workstream: "scratch", paneId: "%2" });
    expect(
      (await loadDashboard(db, { caller: null, workstream: "scratch" })).agents.map((a) => a.key),
    ).toEqual(["scratch/s1"]);
    expect(
      (await loadDashboard(db, { caller: null, text: "w1" })).agents.map((a) => a.key),
    ).toEqual(["ws/w1"]);
  });
});

describe("log: the canonical op tail, rendered by the one formatter", () => {
  it("returns the newest ops oldest-first with seq, key, rendered prose; limit bounds it", async () => {
    task("a");
    task("b");
    closeTask(db, "a", { workstream: "ws", author: "me", evidence: "e" });
    const snap = await loadDashboard(db, { caller: null, workstream: "ws", logLimit: 3 });
    expect(snap.log).toHaveLength(3);
    const seqs = snap.log.map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    const last = snap.log.at(-1);
    expect(last).toMatchObject({ intent: "task.close", actor: "me", scope: "ws" });
    expect(last?.rendered).toContain("task close");
    expect(last?.rendered).toContain("a");
  });

  it("a machine-wide read keeps ops of every workstream", async () => {
    ensureWorkstream(db, "other");
    task("a");
    task("b", {}, "other");
    const snap = await loadDashboard(db, { caller: null });
    expect(new Set(snap.log.map((l) => l.scope))).toEqual(new Set(["ws", "other"]));
  });
});

describe("next and tool: types reserved, honestly unavailable", () => {
  it("next is null with an explicit unavailable source (not 'no authorised work')", async () => {
    task("a");
    const snap = await loadDashboard(db, { caller: "pi:s1" });
    expect(snap.next).toBeNull();
    expect(snap.next_source).toBe("unavailable");
  });
});

describe("human needs and delegates are the CALLER's, never global", () => {
  it("a caller sees its own needs and unfinished calls; another caller's and a null caller's see none", async () => {
    ensureWorkstream(db, "other");
    task("f1");
    recordHumanNeeded(db, { workstream: "ws", caller: "pi:s1", reason: "pick a licence" });
    recordHumanNeeded(db, { workstream: "other", caller: "pi:s1", reason: "elsewhere" });
    recordHumanNeeded(db, { workstream: "ws", caller: "pi:s2", reason: "not yours" });
    registerDelegateCall(db, {
      callId: "pi:s1:c1",
      caller: "pi:s1",
      workstream: "ws",
      request: { text: "check", label: "c1" },
      state: "starting",
    });
    const mine = await loadDashboard(db, { caller: "pi:s1" });
    expect(mine.caller_scope).toBe("caller");
    expect(mine.human_needs.map((h) => [h.key, h.reason])).toEqual([
      [`ws/${mine.human_needs[0]?.id}`, "pick a licence"],
      [`other/${mine.human_needs[1]?.id}`, "elsewhere"],
    ]);
    expect(mine.delegates.map((d) => [d.workstream, d.call_id, d.state])).toEqual([
      ["ws", "pi:s1:c1", "starting"],
    ]);
    // Finished calls (done/failed/cancelled) are not "unfinished": each one is excluded.
    for (const state of ["done", "failed", "cancelled"]) {
      registerDelegateCall(db, {
        callId: `pi:s1:${state}`,
        caller: "pi:s1",
        workstream: "ws",
        request: { text: state, label: state },
      });
      db.prepare("UPDATE delegate_calls SET state = ? WHERE call_id = ?").run(
        state,
        `pi:s1:${state}`,
      );
    }
    registerDelegateCall(db, {
      callId: "pi:s1:running",
      caller: "pi:s1",
      workstream: "ws",
      request: { text: "r", label: "r" },
      state: "starting",
    });
    markDelegate(db, "pi:s1:running", "running");
    expect(
      (await loadDashboard(db, { caller: "pi:s1" })).delegates.map((d) => d.call_id).sort(),
    ).toEqual(["pi:s1:c1", "pi:s1:running"]);
    const narrowed = await loadDashboard(db, { caller: "pi:s1", workstream: "other" });
    expect(narrowed.human_needs.map((h) => h.workstream)).toEqual(["other"]);
    expect(narrowed.delegates).toEqual([]);
    const theirs = await loadDashboard(db, { caller: "pi:s2" });
    expect(theirs.human_needs.map((h) => h.reason)).toEqual(["not yours"]);
    expect(theirs.delegates).toEqual([]);
    const human = await loadDashboard(db, { caller: null });
    expect(human.caller).toBeNull();
    expect(human.caller_scope).toBe("none");
    expect(human.human_needs).toEqual([]);
    expect(human.delegates).toEqual([]);
  });
});

describe("read-only: nothing is written, reconciled or reaped", () => {
  it("runs whole on a readonly connection: ops unchanged, no pane listing, ghost agent kept", async () => {
    ensureWorkstream(db, "scratch");
    task("a");
    task("b");
    addBlockEdge(db, "ws", "b", "a");
    insertAgent(db, { name: "ghost", workstream: "ws", paneId: "%999" });
    insertAgent(db, { name: "s1", workstream: "scratch", paneId: "%2" });
    await claimTask(db, "a", { agentName: "ghost", workstream: "ws" });
    recordHumanNeeded(db, { workstream: "ws", caller: "pi:s1", reason: "decide" });
    const before = opCount();
    const agentsBefore = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
    const ro = openDb({ path: dbPath, readonly: true });
    const seen = mux.calls.length;
    try {
      expect(() => ro.prepare("UPDATE tasks SET title = 'x'").run()).toThrow(/readonly/i);
      const snap = await loadDashboard(ro, { caller: "pi:s1" });
      expect(snap.tasks).toHaveLength(3); // a, b and the human need
      expect(snap.agents.map((a) => a.name)).toEqual(["s1", "ghost"]);
      expect(snap.human_needs).toHaveLength(1);
      expect(snap.edges.length).toBeGreaterThan(0);
      expect(snap.log.length).toBeGreaterThan(0);
    } finally {
      ro.close();
    }
    expect(opCount()).toBe(before);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(
      agentsBefore,
    );
    expect(mux.calls.slice(seen).filter((c) => c[0] === "list-panes" && c.includes("-s"))).toEqual(
      [],
    );
  });
});
