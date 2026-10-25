// Verifies --json on every read verb emits parseable JSON of the
// expected shape. Drives the program directly via buildProgram() +
// parseAsync() with stdout captured, instead of shell-subprocessing
// the built CLI, so we exercise the same code path the user sees but
// without the build dependency.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addNote, addTask, claimTask, closeTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

describe("--json output on read verbs", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-json-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%42",
    });
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 80, effortDays: 2 });
    addTask(db, {
      localId: "b",
      workstream: "auth",
      title: "B",
      impact: 70,
      effortDays: 3,
      blockedBy: ["a"],
    });
    addTask(db, {
      localId: "c",
      workstream: "auth",
      title: "C",
      impact: 95,
      effortDays: 1,
      blockedBy: ["b"],
    });
    addNote(db, "a", "FILES: src/auth.ts", { workstream: "auth" });
    db.close();

    setTmuxExecutor(async (args) => {
      if (args[0] === "list-sessions") {
        return { stdout: "", stderr: "no server running on /tmp/tmux-test/default", exitCode: 1 };
      }
      if (args[0] === "has-session") {
        return { stdout: "", stderr: "can't find session", exitCode: 1 };
      }
      if (args[0] === "list-panes" && args[1] === "-s") {
        return { stdout: "@1\t%42\tworker-1\tpi", stderr: "", exitCode: 0 };
      }
      if (args[0] === "capture-pane") {
        return { stdout: "ready\n> ", stderr: "", exitCode: 0 };
      }
      if (args[0] === "select-pane" || args[0] === "set-option") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `unmocked tmux call: ${args.join(" ")}`, exitCode: 1 };
    });
  });

  afterEach(() => {
    resetTmuxExecutor();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("workstream list --json emits a collection envelope of summaries", async () => {
    const { data } = await runCliJson(["workstream", "list", "--json"], dbPath);
    const env = data as { items: Array<{ name: string }>; count: number };
    expect(Array.isArray(env.items)).toBe(true);
    expect(env.count).toBe(env.items.length);
    // listWorkstreams unions DB rows with live mu-* tmux sessions, so a
    // running tmux server may add unrelated entries. Just assert ours is
    // present.
    expect(env.items.some((r) => r.name === "auth")).toBe(true);
  });

  it("task list --json emits a collection envelope of SQL-keyed task items", async () => {
    const { data } = await runCliJson(["task", "list", "-w", "auth", "--json"], dbPath);
    const env = data as { items: Array<{ id: string }>; count: number; more: number };
    expect(env.items.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    expect(env.count).toBe(3);
    expect(env.more).toBe(0);
  });

  it("task next --json honors -n", async () => {
    const { data } = await runCliJson(["task", "next", "-w", "auth", "-n", "5", "--json"], dbPath);
    const env = data as { items: Array<{ id: string }>; count: number };
    // Only 'a' is ready (b is blocked by a, c by b). Even with -n 5.
    expect(env.items).toHaveLength(1);
    expect(env.items[0]?.id).toBe("a");
  });

  it("task next --json carries impact and effort_days (the inputs of the order), no computed roi", async () => {
    // The ROI is not a SQL column: output keys equal column names. A consumer
    // that wants the ratio computes it from impact / effort_days, and `next`
    // already returns the ready tasks in that order.
    const { data } = await runCliJson(["task", "next", "-w", "auth", "-n", "5", "--json"], dbPath);
    const env = data as { items: Array<Record<string, unknown>> };
    const a = env.items[0];
    expect(a).toMatchObject({ id: "a", impact: 80, effort_days: 2 });
    expect(a).not.toHaveProperty("roi");
    expect((a?.impact as number) / (a?.effort_days as number)).toBe(40);
  });

  it("task next -n 0 --json (the merged-in `task ready` shape) keeps the ready order", async () => {
    const { data } = await runCliJson(["task", "next", "-w", "auth", "-n", "0", "--json"], dbPath);
    const env = data as { items: Array<{ id: string; impact: number; effort_days: number }> };
    expect(env.items[0]).toMatchObject({ id: "a", impact: 80, effort_days: 2 });
  });

  it("task list --json items are the real SQL columns (impact, effort_days, workstream_id), no roi", async () => {
    const { data } = await runCliJson(["task", "list", "-w", "auth", "--json"], dbPath);
    const env = data as { items: Array<Record<string, unknown>> };
    const probe = openDb({ path: dbPath });
    const ws = probe.prepare("SELECT id FROM workstreams WHERE name = 'auth'").get() as {
      id: number;
    };
    probe.close();
    for (const t of env.items) {
      expect(typeof t.impact).toBe("number");
      expect(typeof t.effort_days).toBe("number");
      expect(t.workstream_id).toBe(ws.id);
      expect(t).not.toHaveProperty("roi");
    }
  });

  it("task show --json: the inner task has SQL keys and a revision, no roi", async () => {
    const { data } = await runCliJson(["task", "show", "a", "-w", "auth", "--json"], dbPath);
    const parsed = data as { task: Record<string, unknown> };
    expect(parsed.task).toMatchObject({ id: "a", impact: 80, effort_days: 2, workstream: "auth" });
    expect(typeof parsed.task.revision).toBe("number");
    expect(parsed.task).not.toHaveProperty("roi");
  });

  it("task next -n 0 --json on an empty result is an empty item list (not '(no ready tasks)')", async () => {
    // Close 'a' so 'b' becomes ready; close 'b' so 'c' becomes ready;
    // close 'c' so nothing is ready.
    const db2 = openDb({ path: dbPath });
    for (const id of ["a", "b", "c"]) closeTask(db2, id, { workstream: "auth", evidence: "test" });
    db2.close();
    const { data } = await runCliJson(["task", "next", "-w", "auth", "-n", "0", "--json"], dbPath);
    expect(data).toEqual({ items: [], count: 0, more: 0 });
  });

  it("task show --json emits a composite { task, blockers, dependents, notes } with status-bearing edges", async () => {
    // task_show_blocked_by_renders_closed: blockers/dependents are arrays of
    // {id, status, substate} items so scripts can split gating vs satisfied
    // without a second query.
    const { data } = await runCliJson(["task", "show", "a", "-w", "auth", "--json"], dbPath);
    const parsed = data as {
      task: { id: string };
      blockers: Array<{ id: string; status: string }>;
      dependents: Array<{ id: string; status: string }>;
      notes: Array<{ content: string }>;
    };
    expect(parsed.task.id).toBe("a");
    expect(parsed.blockers).toEqual([]);
    expect(parsed.dependents).toEqual([{ id: "b", status: "OPEN", substate: "todo" }]);
    expect(parsed.notes.map((n) => n.content)).toEqual(["FILES: src/auth.ts"]);
  });

  it("task list/next/show --json expose `id` (the local_id) and never name/localId", async () => {
    // Output aliases only: `id` is the task's local_id (never the integer PK),
    // `local_id` is the column name, and neither `name` nor `localId` leaks.
    const keysOf = (t: Record<string, unknown>) => {
      expect(typeof t.id).toBe("string");
      expect(t.id).toBe(t.local_id);
      for (const gone of ["name", "localId", "workstreamName", "ownerName", "effortDays"]) {
        expect(t).not.toHaveProperty(gone);
      }
    };
    {
      const { data } = await runCliJson(["task", "list", "-w", "auth", "--json"], dbPath);
      const items = (data as { items: Array<Record<string, unknown>> }).items;
      expect(items.length).toBeGreaterThan(0);
      for (const t of items) keysOf(t);
    }
    {
      const { data } = await runCliJson(["task", "next", "-w", "auth", "--json"], dbPath);
      const items = (data as { items: Array<Record<string, unknown>> }).items;
      expect(items.length).toBeGreaterThan(0);
      for (const t of items) keysOf(t);
      expect(items[0]?.id).toBe("a");
    }
    {
      const { data } = await runCliJson(["task", "show", "a", "-w", "auth", "--json"], dbPath);
      keysOf((data as { task: Record<string, unknown> }).task);
    }
  });

  it("task tree --json is a flat preorder of { id, depth, parent } entries (c -> b -> a)", async () => {
    const { data } = await runCliJson(["task", "tree", "c", "-w", "auth", "--json"], dbPath);
    const parsed = data as {
      direction: string;
      root: string;
      items: Array<{ id: string; depth: number; parent: string | null }>;
      more: number;
    };
    expect(parsed.direction).toBe("blockers");
    expect(parsed.root).toBe("c");
    expect(parsed.items.map((e) => [e.id, e.depth, e.parent])).toEqual([
      ["c", 0, null],
      ["b", 1, "c"],
      ["a", 2, "b"],
    ]);
    expect(parsed.more).toBe(0);
  });

  it("task tree --json marks diamond recurrences without expanding", async () => {
    // Build a diamond: a blocks both d and e, both block f.
    const db3 = openDb({ path: dbPath });
    for (const [id, blockedBy] of [
      ["d", ["a"]],
      ["e", ["a"]],
      ["f", ["d", "e"]],
    ] as const) {
      addTask(db3, {
        localId: id,
        workstream: "auth",
        title: id.toUpperCase(),
        impact: 50,
        effortDays: 1,
        blockedBy: [...blockedBy],
      });
    }
    db3.close();
    const { data } = await runCliJson(["task", "tree", "f", "-w", "auth", "--json"], dbPath);
    const parsed = data as {
      items: Array<{ id: string; depth: number; parent: string | null; again?: boolean }>;
    };
    // f -> d, e. d expands to a; e's child a is a recurrence.
    const at = (parent: string, id: string) =>
      parsed.items.find((e) => e.parent === parent && e.id === id);
    expect(at("d", "a")?.again).toBeUndefined();
    expect(at("e", "a")?.again).toBe(true);
    expect(parsed.items.filter((e) => e.id === "a")).toHaveLength(2);
  });

  it("state emits seeded content for each list of a workstream", async () => {
    // A regression that silently drops seeded rows from agents / ready /
    // in-progress / blocked / recent-closed should fail.
    const db2 = openDb({ path: dbPath });
    addTask(db2, {
      localId: "inflight",
      workstream: "auth",
      title: "In progress task",
      impact: 60,
      effortDays: 2,
    });
    addTask(db2, {
      localId: "blocked_leaf",
      workstream: "auth",
      title: "Blocked leaf",
      impact: 40,
      effortDays: 2,
      blockedBy: ["a"],
    });
    addTask(db2, {
      localId: "done",
      workstream: "auth",
      title: "Closed task",
      impact: 30,
      effortDays: 1,
    });
    await claimTask(db2, "inflight", { agentName: "worker-1", workstream: "auth" });
    closeTask(db2, "done", { workstream: "auth", evidence: "seed closed row" });
    db2.close();

    const { data } = await runCliJson(["state", "-w", "auth"], dbPath);
    const w = data.workstreams[0] as {
      workstream: string;
      agents: Array<{ name: string; workstream: string }>;
      orphans: unknown[];
      ready: Array<{ id: string; title: string; status: string }>;
      in_progress: Array<{ id: string; owner: string | null; status: string }>;
      blocked: Array<{ id: string; title: string; status: string }>;
      recent_closed: Array<{ id: string; title: string; status: string }>;
    };
    expect(w.workstream).toBe("auth");
    expect(w.agents).toEqual([expect.objectContaining({ name: "worker-1", workstream: "auth" })]);
    expect(w.orphans).toEqual([]);
    expect(w.ready).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "a",
          title: "A",
          status: "OPEN",
          impact: 80,
          effort_days: 2,
        }),
      ]),
    );
    expect(w.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "b", title: "B", status: "OPEN" }),
        expect.objectContaining({ id: "blocked_leaf", title: "Blocked leaf", status: "OPEN" }),
      ]),
    );
    expect(w.in_progress).toEqual([
      expect.objectContaining({ id: "inflight", owner: "worker-1", status: "IN_PROGRESS" }),
    ]);
    expect(w.recent_closed).toEqual([
      expect.objectContaining({ id: "done", title: "Closed task", status: "CLOSED" }),
    ]);
  });

  it("agent list --json emits live seeded agents, not only array shape", async () => {
    const { data } = await runCliJson(["agent", "list", "-w", "auth", "--json"], dbPath);
    const parsed = data as {
      workstreamName: string;
      agents: Array<{ name: string; pane_id: string; workstream: string; workstream_id: number }>;
      orphans: unknown[];
    };
    expect(parsed.workstreamName).toBe("auth");
    expect(parsed.agents).toEqual([
      expect.objectContaining({
        name: "worker-1",
        pane_id: "%42",
        workstream: "auth",
        workstream_id: expect.any(Number),
      }),
    ]);
    expect(parsed.orphans).toEqual([]);
  });

  it("agent verbs accept -w as a scope check; mismatch errors with AgentNotInWorkstreamError", async () => {
    // Same pattern as task verbs: agent names are globally unique
    // (PK on agents.name) so -w is purely a scope check that catches
    // typos before they silently act on the wrong agent.
    //
    // worker-1 was seeded in workstream 'auth' by beforeEach.
    const ok = await runCli(["agent", "show", "worker-1", "-w", "auth"], dbPath);
    // Reconcile may have pruned the fake pane; what matters is no
    // "unknown option" / no "conflict" prefix.
    expect(ok.stderr).not.toMatch(/unknown option/);
    expect(ok.stderr).not.toMatch(/conflict:/);

    const bad = await runCli(["agent", "show", "worker-1", "-w", "infra"], dbPath);
    expect(bad.stderr).toMatch(/conflict:/);
    expect(bad.stderr).toMatch(/auth/);
    expect(bad.stderr).toMatch(/infra/);
  });

  it("task verbs accept -w as a scope check; mismatch errors with TaskNotInWorkstreamError", async () => {
    // Real bug found in real use: `mu task note <id> -w <name> ...`
    // was rejected with "unknown option '-w'". The fix adds
    // WORKSTREAM_OPT to all task ID-targeted verbs and validates
    // that the named task is in the named workstream. Same task ID
    // in two workstreams could mask the wrong-workstream typo today
    // (IDs are globally unique), but the assertion catches it.
    //
    // Test plan: seed a second workstream + task; assert the same
    // verb works with the correct -w and errors with the wrong -w.
    const db2 = openDb({ path: dbPath });
    ensureWorkstream(db2, "infra");
    addTask(db2, {
      localId: "infra_task",
      workstream: "infra",
      title: "Infra task",
      impact: 50,
      effortDays: 1,
    });
    db2.close();

    // Correct workstream: succeeds.
    const ok = await runCli(["task", "note", "infra_task", "a note", "-w", "infra"], dbPath);
    expect(ok.stderr).toBe("");

    // Wrong workstream: typed conflict error.
    const bad = await runCli(["task", "note", "infra_task", "oops", "-w", "auth"], dbPath);
    expect(bad.stderr).toMatch(/conflict:/);
    expect(bad.stderr).toMatch(/infra/);
    expect(bad.stderr).toMatch(/auth/);

    // Same check on close: correct ok, wrong errors.
    const closeOk = await runCli(
      ["task", "close", "infra_task", "-w", "infra", "--evidence", "test"],
      dbPath,
    );
    expect(closeOk.stderr).toBe("");
    const closeBad = await runCli(["task", "open", "infra_task", "-w", "auth"], dbPath);
    expect(closeBad.stderr).toMatch(/conflict:/);
  });

  it("`mu me` emits the agent and its owned tasks for the injected identity", async () => {
    const db2 = openDb({ path: dbPath });
    await claimTask(db2, "a", { agentName: "worker-1", workstream: "auth" });
    db2.close();
    const keys = ["MU_MANAGED_AGENT", "MU_AGENT_NAME", "MU_WORKSTREAM"] as const;
    const saved = keys.map((k) => process.env[k]);
    process.env.MU_MANAGED_AGENT = "1";
    process.env.MU_AGENT_NAME = "worker-1";
    process.env.MU_WORKSTREAM = "auth";
    try {
      const { data } = await runCliJson(["me"], dbPath);
      const parsed = data as {
        me: { agent: { name: string }; owned_tasks: Array<{ id: string }> };
      };
      expect(parsed.me.agent.name).toBe("worker-1");
      expect(parsed.me.owned_tasks.map((t) => t.id)).toEqual(["a"]);
    } finally {
      keys.forEach((k, i) => {
        const v = saved[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });
});

// ─── Table-rendering ergonomics (non-JSON output path) ──────────

describe("record rendering", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-tbl-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 80, effortDays: 2 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 50, effortDays: 1 });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a long title is clipped inside the 400-character record, the id stays whole, the cut names its way back", async () => {
    db.prepare("UPDATE tasks SET title = ? WHERE local_id = 'a'").run(
      `Some long title ${"x".repeat(900)}`,
    );
    const { stdout } = await runCli(["task", "list", "-w", "auth"], dbPath);
    for (const line of stdout.trimEnd().split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(400);
    }
    const a = stdout.split("\n").find((l) => l.startsWith("task\ta\t")) ?? "";
    expect(a).toMatch(/Some long title x+…$/);
    // The cut is named once, in the footer, with the one way back: the same read, uncapped.
    expect(stdout.trimEnd().split("\n").at(-1)).toMatch(
      /^cut=\d+ next=mu task list -w auth --all$/,
    );
    const whole = await runCli(["task", "list", "-w", "auth", "--all"], dbPath);
    expect(whole.stdout).toContain(`Some long title ${"x".repeat(900)}`);
  });

  it("renders all task ids in full, one record per task", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth"], dbPath);
    expect(
      stdout
        .trimEnd()
        .split("\n")
        .map((l) => l.split("\t")[1]),
    ).toEqual(["a", "b", "c"]);
  });
});

// ─── mu task list --status filter (CLI integration) ─────────────

describe("task list --status", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-status-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 80, effortDays: 2 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 50, effortDays: 1 });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("filters to OPEN tasks (case-insensitive, lowercase form works)", async () => {
    // Mark 'a' as CLOSED and 'b' as IN_PROGRESS so all three statuses
    // are represented.
    const db2 = openDb({ path: dbPath });
    closeTask(db2, "a", { workstream: "auth", evidence: "test" });
    db2
      .prepare("UPDATE tasks SET status = 'IN_PROGRESS', substate = 'active' WHERE local_id='b'")
      .run();
    db2.close();

    const { data } = await runCliJson(
      ["task", "list", "-w", "auth", "--status", "open", "--json"],
      dbPath,
    );
    const env = data as { items: Array<{ id: string }>; count: number };
    expect(env.items.map((t) => t.id)).toEqual(["c"]);
  });

  it("rejects an invalid --status value with exit 2", async () => {
    const { stderr } = await runCli(["task", "list", "-w", "auth", "--status", "RESOLVED"], dbPath);
    expect(stderr).toMatch(/--status must be one of/);
  });
});

// ─── mu task list / next / ready --sort (CLI integration) ───────

describe("task list/next/ready --sort", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-sort-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    // Seed three tasks with distinct impact/effort so ROI ordering
    // is unambiguous: a (5), b (90), c (20). All ready (no edges).
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 10, effortDays: 2 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 90, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 40, effortDays: 2 });
    // Pin updated_at so 'recency' sort is deterministic. addTask
    // stamps NOW for both columns; we rewrite updated_at to a strict
    // chronological sequence (a oldest, c newest).
    db.prepare("UPDATE tasks SET updated_at='2026-05-01T00:00:00.000Z' WHERE local_id='a'").run();
    db.prepare("UPDATE tasks SET updated_at='2026-05-02T00:00:00.000Z' WHERE local_id='b'").run();
    db.prepare("UPDATE tasks SET updated_at='2026-05-03T00:00:00.000Z' WHERE local_id='c'").run();
    db.prepare("UPDATE tasks SET created_at='2026-01-01T00:00:00.000Z' WHERE local_id='a'").run();
    db.prepare("UPDATE tasks SET created_at='2026-02-01T00:00:00.000Z' WHERE local_id='b'").run();
    db.prepare("UPDATE tasks SET created_at='2026-03-01T00:00:00.000Z' WHERE local_id='c'").run();
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("--sort recency orders by updated_at DESC (most recent first)", async () => {
    const { data } = await runCliJson(
      ["task", "list", "-w", "auth", "--sort", "recency", "--json"],
      dbPath,
    );
    const env = data as { items: Array<{ id: string }>; count: number };
    expect(env.items.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("--sort age orders by created_at ASC (oldest first)", async () => {
    const { data } = await runCliJson(
      ["task", "list", "-w", "auth", "--sort", "age", "--json"],
      dbPath,
    );
    const env = data as { items: Array<{ id: string }>; count: number };
    expect(env.items.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("--sort roi (default for `next`) — highest ROI first", async () => {
    const { data } = await runCliJson(["task", "next", "-w", "auth", "-n", "5", "--json"], dbPath);
    const env = data as { items: Array<{ id: string }>; count: number };
    // b (90) > c (20) > a (5).
    expect(env.items.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("`mu task next -n 0 --sort recency` re-sorts (overrides ROI default)", async () => {
    const { data } = await runCliJson(
      ["task", "next", "-w", "auth", "-n", "0", "--sort", "recency", "--json"],
      dbPath,
    );
    const env = data as { items: Array<{ id: string }>; count: number };
    expect(env.items.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("renders an extra `updated` column under --sort recency (table mode)", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--sort", "recency"], dbPath);
    // Each record gains the timestamp the sort orders by; the other one stays out.
    expect(stdout).toMatch(/ updated=\d{4}-/);
    expect(stdout).not.toMatch(/\bcreated=/);
  });

  it("renders an extra `created` column under --sort age (table mode)", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth", "--sort", "age"], dbPath);
    expect(stdout).toMatch(/ created=\d{4}-/);
    expect(stdout).not.toMatch(/\bupdated=/);
  });

  it("does NOT render the time column under default sort (id) or roi", async () => {
    const { stdout: stdoutDefault } = await runCli(["task", "list", "-w", "auth"], dbPath);
    expect(stdoutDefault).not.toContain("updated=");
    expect(stdoutDefault).not.toContain("created=");
    const { stdout: stdoutRoi } = await runCli(
      ["task", "next", "-w", "auth", "-n", "0", "--sort", "roi"],
      dbPath,
    );
    expect(stdoutRoi).not.toContain("updated=");
    expect(stdoutRoi).not.toContain("created=");
  });

  it("rejects an unknown --sort key with exit 2 and a helpful message", async () => {
    const { stderr } = await runCli(["task", "list", "-w", "auth", "--sort", "priority"], dbPath);
    expect(stderr).toMatch(/--sort must be one of/);
  });

  it("JSON shape is unchanged (no extra fields when --sort is active)", async () => {
    const { data } = await runCliJson(
      ["task", "list", "-w", "auth", "--sort", "recency", "--json"],
      dbPath,
    );
    const env = data as {
      items: Array<Record<string, unknown>>;
      count: number;
    };
    // Same fields as without --sort: rows already include created_at /
    // updated_at; nothing computed gets added (consumers can sort).
    for (const row of env.items) {
      expect(row).toHaveProperty("created_at");
      expect(row).toHaveProperty("updated_at");
      expect(row).not.toHaveProperty("relTime");
      expect(row).not.toHaveProperty("ago");
    }
  });
});
