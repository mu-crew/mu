// Tests for src/workstream.ts. Real SQLite + mocked tmux executor.
//
// Covers the destroy verb's idempotency, isolation between workstreams,
// FK cascade reporting, and the order-of-operations guarantee that the
// tmux session is torn down before DB rows so a tmux failure leaves the
// registry intact.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent, listAgents } from "../src/agents.js";
import { type Db, openDb, WorkstreamTornDownError } from "../src/db.js";
import { addNote, addTask, getTask, listTasks } from "../src/tasks.js";
import {
  resetTmuxExecutor,
  setTmuxExecutor,
  type TmuxExecResult,
  type TmuxExecutor,
} from "../src/tmux.js";
import {
  ensureWorkstream,
  isValidWorkstreamName,
  listWorkstreams,
  summarizeWorkstream,
  WorkstreamNameInvalidError,
} from "../src/workstream.js";
import { softTeardown } from "./_teardown.js";

// ─── Mock tmux harness ─────────────────────────────────────────────────

function ok(stdout = ""): TmuxExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr = ""): TmuxExecResult {
  return { exitCode: 1, stdout: "", stderr };
}

interface MockState {
  sessions: Set<string>;
  killed: string[];
}

function mockTmux(state: MockState): { calls: string[][]; executor: TmuxExecutor } {
  const calls: string[][] = [];
  const executor: TmuxExecutor = async (args) => {
    calls.push([...args]);
    const verb = args[0];

    if (verb === "has-session") {
      const target = args[2]?.replace(/^=(.*):$/, "$1");
      return state.sessions.has(target ?? "") ? ok() : fail(`can't find session: ${target}`);
    }
    if (verb === "kill-session") {
      const target = args[2]?.replace(/^=(.*):$/, "$1");
      if (!target || !state.sessions.has(target)) {
        return fail(`can't find session: ${target}`);
      }
      state.sessions.delete(target);
      state.killed.push(target);
      return ok();
    }
    if (verb === "list-panes") {
      const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=(.*):$/, "$1");
      return state.sessions.has(target)
        ? ok("@1\t%1\t_mu\n")
        : fail(`can't find session: ${target}`);
    }
    // A registered pane outside the session is asked about by id: none lives here.
    if (verb === "display-message") return fail("can't find pane");
    if (verb === "list-sessions") {
      if (state.sessions.size === 0) return fail("no server running");
      return ok([...state.sessions].join("\n"));
    }
    return fail(`unmocked tmux call: ${args.join(" ")}`);
  };
  return { calls, executor };
}

// ─── Fixture setup ─────────────────────────────────────────────────────

let tmpDir: string;
let db: Db;
let state: MockState;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mu-workstream-test-"));
  db = openDb({ path: join(tmpDir, "mu.db") });
  state = { sessions: new Set(), killed: [] };
});

afterEach(() => {
  resetTmuxExecutor();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed: 2 agents, 3 tasks (with one edge), 2 notes — all in `auth`. */
function seedAuth(): void {
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
  insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%2" });
  addTask(db, {
    localId: "design",
    workstream: "auth",
    title: "Design",
    impact: 80,
    effortDays: 2,
  });
  addTask(db, {
    localId: "build",
    workstream: "auth",
    title: "Build",
    impact: 80,
    effortDays: 5,
    blockedBy: ["design"],
  });
  addTask(db, {
    localId: "ship",
    workstream: "auth",
    title: "Ship",
    impact: 90,
    effortDays: 1,
    blockedBy: ["build"],
  });
  addNote(db, "design", "DECISION: JWT", { workstream: "auth" });
  addNote(db, "design", "FILES: src/auth.rs", { workstream: "auth" });
}

// ─── summarizeWorkstream ───────────────────────────────────────────────

// ─── ensureWorkstream + FK behaviour ───────────────────────────────────

describe("ensureWorkstream", () => {
  it("inserts the row on first call and is idempotent thereafter", () => {
    expect(ensureWorkstream(db, "auth")).toBe(true);
    expect(ensureWorkstream(db, "auth")).toBe(false);
    const rows = db.prepare("SELECT name FROM workstreams").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["auth"]);
  });

  it("is auto-called by insertAgent (so spawn-without-init still works)", () => {
    insertAgent(db, { name: "worker-1", workstream: "fresh", paneId: "%1" });
    const rows = db.prepare("SELECT name FROM workstreams").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["fresh"]);
  });

  it("is auto-called by addTask (so add-task-without-init still works)", () => {
    addTask(db, {
      localId: "foo",
      workstream: "fresh",
      title: "F",
      impact: 50,
      effortDays: 1,
    });
    const rows = db.prepare("SELECT name FROM workstreams").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["fresh"]);
  });
});

describe("FK CASCADE: deleting a workstream wipes its agents and tasks", () => {
  it("DELETE FROM workstreams cascades to agents and to tasks (then on to task_edges + task_notes)", () => {
    seedAuth();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n,
    ).toBeGreaterThan(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n,
    ).toBeGreaterThan(0);

    db.prepare("DELETE FROM workstreams WHERE name = 'auth'").run();

    for (const t of ["agents", "tasks", "task_edges", "task_notes"]) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(n).toBe(0);
    }
  });
});

describe("FK SET NULL: closing an agent clears tasks.owner automatically", () => {
  it("deleteAgent clears owner on tasks they owned (historical attribution lives in notes)", () => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
    // v5: tasks.owner_id is the INTEGER FK; resolve worker-1 to its id.
    db.prepare(
      `UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'worker-1')
        WHERE local_id = 'design'`,
    ).run();
    expect(
      (
        db
          .prepare(
            `SELECT a.name AS owner FROM tasks t LEFT JOIN agents a ON a.id = t.owner_id WHERE t.local_id = 'design'`,
          )
          .get() as { owner: string }
      ).owner,
    ).toBe("worker-1");

    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();

    expect(
      (
        db
          .prepare(
            `SELECT a.name AS owner FROM tasks t LEFT JOIN agents a ON a.id = t.owner_id WHERE t.local_id = 'design'`,
          )
          .get() as { owner: string | null }
      ).owner,
    ).toBeNull();
  });

  it("INSERT INTO tasks ... owner_id=<bogus> is rejected by the FK", () => {
    ensureWorkstream(db, "auth");
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'auth'").get() as { id: number }
    ).id;
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (workstream_id, local_id, title, status, substate, impact, effort_days, owner_id, created_at, updated_at)
           VALUES (?, 'x', 'X', 'OPEN', 'todo', 50, 1, 999999, datetime('now'), datetime('now'))`,
        )
        .run(wsId),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("summarizeWorkstream", () => {
  it("counts agents, tasks, edges, notes; reports tmux liveness", async () => {
    state.sessions.add("mu-auth");
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();

    const summary = await summarizeWorkstream(db, { workstream: "auth" });
    expect(summary).toEqual({
      name: "auth",
      muxSession: "mu-auth",
      muxAlive: true,
      agentCount: 2,
      taskCount: 3,
      edgeCount: 2,
      noteCount: 2,
      worktreeCount: 0,
      registered: true,
    });
  });

  it("returns all-zero counts and muxAlive=false for an unknown workstream", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    const summary = await summarizeWorkstream(db, { workstream: "nope" });
    expect(summary.agentCount).toBe(0);
    expect(summary.taskCount).toBe(0);
    expect(summary.edgeCount).toBe(0);
    expect(summary.noteCount).toBe(0);
    expect(summary.muxAlive).toBe(false);
  });

  it("honours muxSession override", async () => {
    state.sessions.add("custom");
    setTmuxExecutor(mockTmux(state).executor);
    const summary = await summarizeWorkstream(db, {
      workstream: "auth",
      muxSession: "custom",
    });
    expect(summary.muxSession).toBe("custom");
    expect(summary.muxAlive).toBe(true);
  });
});

// ─── listWorkstreams ─────────────────────────────────────────────────────

describe("listWorkstreams", () => {
  it("returns empty when no DB rows and no mu-* tmux sessions", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    const list = await listWorkstreams(db);
    expect(list).toEqual([]);
  });

  it("lists DB workstreams (agents + tasks) with tmux liveness; unregistered mu-* sessions are not discovered", async () => {
    state.sessions.add("mu-auth"); // both DB rows AND tmux session
    state.sessions.add("mu-empty"); // tmux only, no DB rows: not discovered
    state.sessions.add("unrelated"); // not an mu session, ignored
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    insertAgent(db, {
      name: "billing-1",
      workstream: "billing", // DB only, no tmux session
      paneId: "%9",
    });

    const list = await listWorkstreams(db);
    expect(list.map((w) => w.name)).toEqual(["auth", "billing"]);

    const auth = list.find((w) => w.name === "auth");
    expect(auth?.muxAlive).toBe(true);
    expect(auth?.agentCount).toBe(2);
    expect(auth?.taskCount).toBe(3);

    const billing = list.find((w) => w.name === "billing");
    expect(billing?.muxAlive).toBe(false);
    expect(billing?.agentCount).toBe(1);
    expect(billing?.taskCount).toBe(0);
  });

  it("sorts by workstream name", async () => {
    for (const ws of ["zeta", "alpha", "mike"]) ensureWorkstream(db, ws);
    setTmuxExecutor(mockTmux(state).executor);
    const list = await listWorkstreams(db);
    expect(list.map((w) => w.name)).toEqual(["alpha", "mike", "zeta"]);
  });
});

// ─── teardownWorkstream ─────────────────────────────────────────────────

describe("teardownWorkstream (soft)", () => {
  it("kills the tmux session, deletes agent rows, marks torn down; tasks, edges and notes stay", async () => {
    state.sessions.add("mu-auth");
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();

    const result = await softTeardown(db, "auth");
    expect(result).toEqual({
      killedMux: true,
      deletedAgents: 2,
      tasks: 3,
      notes: 2,
      edges: 2,
      keptWorktrees: [],
      orphanedAgents: [],
    });

    expect(state.killed).toEqual(["mu-auth"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(0);
    // Soft: the rows are still there ...
    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect([count("tasks"), count("task_notes"), count("task_edges")]).toEqual([3, 2, 2]);
    // ... and hidden from every user-facing read.
    expect(() => listTasks(db, "auth")).toThrow(WorkstreamTornDownError);
    expect(() => getTask(db, "design", "auth")).toThrow(WorkstreamTornDownError);
    expect(listAgents(db, { workstream: "auth" })).toEqual([]);
  });

  it("leaves other workstreams completely untouched", async () => {
    state.sessions.add("mu-auth");
    state.sessions.add("mu-billing");
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    insertAgent(db, { name: "billing-1", workstream: "billing", paneId: "%9" });
    addTask(db, {
      localId: "invoice",
      workstream: "billing",
      title: "Invoice",
      impact: 50,
      effortDays: 1,
    });
    addNote(db, "invoice", "FILES: src/billing.rs", { workstream: "billing" });

    await softTeardown(db, "auth");

    // Billing intact.
    expect(state.sessions.has("mu-billing")).toBe(true);
    expect(listAgents(db, { workstream: "billing" }).map((a) => a.name)).toEqual(["billing-1"]);
    expect(listTasks(db, "billing").map((t) => t.name)).toEqual(["invoice"]);
    const billingNotes = db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_notes n
           JOIN tasks t ON t.id = n.task_id
          WHERE t.local_id = 'invoice'`,
      )
      .get() as { n: number };
    expect(billingNotes.n).toBe(1);
  });

  it("is idempotent: destroying an unknown workstream is a no-op", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    const result = await softTeardown(db, "nope");
    expect(result).toEqual({
      killedMux: false,
      deletedAgents: 0,
      tasks: 0,
      notes: 0,
      edges: 0,
      keptWorktrees: [],
      orphanedAgents: [],
    });
  });

  it("succeeds when DB has rows but tmux session is already gone", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth(); // no tmux session for it

    const result = await softTeardown(db, "auth");
    expect(result.killedMux).toBe(false);
    expect(result.deletedAgents).toBe(2);
    expect(result.tasks).toBe(3);
    expect(state.killed).toEqual([]);
  });

  it("succeeds when tmux session exists but DB has no rows", async () => {
    state.sessions.add("mu-empty");
    setTmuxExecutor(mockTmux(state).executor);

    const result = await softTeardown(db, "empty");
    expect(result).toEqual({
      killedMux: true,
      deletedAgents: 0,
      tasks: 0,
      notes: 0,
      edges: 0,
      keptWorktrees: [],
      orphanedAgents: [],
    });
    expect(state.killed).toEqual(["mu-empty"]);
  });

  it("repeated destroy is a clean no-op the second time", async () => {
    state.sessions.add("mu-auth");
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();

    await softTeardown(db, "auth");
    const second = await softTeardown(db, "auth");
    expect(second).toEqual({
      killedMux: false,
      deletedAgents: 0,
      tasks: 3,
      notes: 2,
      edges: 2,
      keptWorktrees: [],
      orphanedAgents: [],
    });
  });

  it("tears down a bare-registry workstream (workstreams row but no agents/tasks)", async () => {
    // Regression for the temp_confirm_a/temp_confirm_b live bug: an empty
    // registered workstream was unreachable because the cli's nothingToDo
    // short-circuit ignored the workstreams row itself. Soft teardown marks
    // the bare row (the row stays; torn_down_at is set).
    setTmuxExecutor(mockTmux(state).executor);
    ensureWorkstream(db, "orphan");

    await softTeardown(db, "orphan");
    expect(
      db.prepare("SELECT torn_down_at AS t FROM workstreams WHERE name='orphan'").get(),
    ).toEqual({ t: expect.any(String) });
  });

  it("summarize reports `registered: true` for an empty registered workstream", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    ensureWorkstream(db, "orphan");
    const summary = await summarizeWorkstream(db, { workstream: "orphan" });
    expect(summary.registered).toBe(true);
    expect(summary.muxAlive).toBe(false);
    expect(summary.agentCount).toBe(0);
    expect(summary.taskCount).toBe(0);
    expect(summary.worktreeCount).toBe(0);
  });

  it("summarize reports `registered: false` for a tmux-only workstream mu never observed", async () => {
    state.sessions.add("mu-tmuxonly");
    setTmuxExecutor(mockTmux(state).executor);
    const summary = await summarizeWorkstream(db, { workstream: "tmuxonly" });
    expect(summary.registered).toBe(false);
    expect(summary.muxAlive).toBe(true);
  });
});

// ─── Workstream name validation ────────────────────────────────────────

describe("isValidWorkstreamName", () => {
  it("accepts the documented shape (lowercase alpha first; alnum/_/- after; ≤32)", () => {
    for (const ok of ["auth", "auth-refactor", "infer_rs", "x", "a1b2", "a".repeat(32)]) {
      expect(isValidWorkstreamName(ok)).toBe(true);
    }
  });

  it("rejects names tmux silently mangles ('.', ':', '/') — the bug-report regression", () => {
    // The motivating case: `mu workstream init roadmap-v0.2` succeeded
    // but tmux stored the session as `mu-roadmap-v0_2` (dot → underscore),
    // breaking every downstream verb that looked up `mu-roadmap-v0.2`.
    for (const bad of ["roadmap-v0.2", "auth:refactor", "auth/refactor"]) {
      expect(isValidWorkstreamName(bad)).toBe(false);
    }
  });

  it("rejects empty, leading-digit, leading-hyphen, uppercase, and over-long names", () => {
    for (const bad of ["", "1auth", "-auth", "_auth", "Auth", "AUTH", "a".repeat(33)]) {
      expect(isValidWorkstreamName(bad)).toBe(false);
    }
  });

  it("rejects names starting with the reserved 'mu-' prefix (would double-prefix tmux session)", () => {
    // mu auto-prepends 'mu-' to derive the tmux session name. A workstream
    // named 'mu-foo' would create session 'mu-mu-foo' — almost never
    // intended. Fail loud rather than silently double-prefix.
    for (const bad of ["mu-", "mu-foo", "mu-auth-refactor"]) {
      expect(isValidWorkstreamName(bad)).toBe(false);
    }
    // 'mufoo' (no hyphen after 'mu') is fine — only the literal 'mu-'
    // prefix is reserved.
    expect(isValidWorkstreamName("mufoo")).toBe(true);
  });

  it("the mu- error message explains the double-prefix gotcha specifically", () => {
    let caught: WorkstreamNameInvalidError | undefined;
    try {
      ensureWorkstream(db, "mu-auth");
    } catch (err) {
      if (err instanceof WorkstreamNameInvalidError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/mu-mu-auth/);
    expect(caught?.message).toMatch(/double-prefixed/);
  });
});

describe("ensureWorkstream — name validation", () => {
  it("throws WorkstreamNameInvalidError on a tmux-mangled name", () => {
    expect(() => ensureWorkstream(db, "roadmap-v0.2")).toThrow(WorkstreamNameInvalidError);
  });

  it("the thrown error names the offending input and explains why", () => {
    let caught: WorkstreamNameInvalidError | undefined;
    try {
      ensureWorkstream(db, "auth:refactor");
    } catch (err) {
      if (err instanceof WorkstreamNameInvalidError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.attempted).toBe("auth:refactor");
    expect(caught?.message).toMatch(/tmux/);
    expect(caught?.message).toMatch(/auth:refactor/);
  });

  it("accepts valid names without changing existing behaviour", () => {
    expect(ensureWorkstream(db, "auth-refactor")).toBe(true);
    expect(ensureWorkstream(db, "auth-refactor")).toBe(false); // idempotent
  });
});
