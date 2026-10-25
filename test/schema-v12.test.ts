// Schema v12 (k_schema_v12): the new columns, task_auto, the blockers view,
// the ready order, the note-kind guard, capture/apply of the new fields, the
// torn-down filter, and the rule that new fields only ride v2 segment lines.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, insertAgent } from "../src/agents.js";
import type { Op } from "../src/apply.js";
import {
  CURRENT_SCHEMA_VERSION,
  type Db,
  EXPECTED_TABLES,
  MACHINE_LOCAL_TABLES,
  NOTE_KINDS,
  openDb,
  resolveWorkstreamId,
  SchemaTooOldError,
  tryResolveWorkstreamId,
  WorkstreamNotFoundError,
  WorkstreamTornDownError,
} from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import {
  applyIncomingOp,
  decodeLine,
  discoverPeers,
  encodeSegmentLine,
  flushSegment,
  ingestSegment,
  localMachineId,
  segmentPath,
} from "../src/segments.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, updateTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { byRoiDesc } from "../src/tasks/sort.js";
import { getTask, listBlocked, listGoals, listReady, listTasks } from "../src/tasks.js";
import { ensureWorkstream, listWorkstreams } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-schema-v12-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmFixtureDir(tempDir);
});

const cols = (table: string): Map<string, { type: string; notnull: number; dflt: string | null }> =>
  new Map(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).map((c) => [c.name, { type: c.type, notnull: c.notnull, dflt: c.dflt_value }]),
  );

const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";
let seq = 0;
const peerOp = (
  wallMs: number,
  entity: string,
  key: string,
  payload: Record<string, unknown>,
  op: "put" | "del" = "put",
): Op => ({
  hlc: formatHlc({ wallMs: 2_000_000_000_000 + wallMs, counter: 0, machineId: PEER }),
  machineId: PEER,
  groupId: `g-${++seq}`,
  actor: "peer",
  intent: null,
  entity,
  key,
  op,
  payload: JSON.stringify(payload),
});
const taskRow = (ws: string, id: string) =>
  db
    .prepare(
      `SELECT t.* FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = ? AND t.local_id = ?`,
    )
    .get(ws, id) as Record<string, unknown> | undefined;

describe("v12 shape", () => {
  it("stamps v13 (v12 upgrades in place; see loop-storage.test.ts) and refuses a v11 DB untouched", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(13);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 13 });
    const p = join(tempDir, "v11.db");
    const raw = new Database(p);
    raw.exec(
      `CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
       INSERT INTO schema_version VALUES (1, 11);`,
    );
    raw.close();
    expect(() => openDb({ path: p })).toThrow(SchemaTooOldError);
  });

  // An existing v12 DB (written before agents.command existed) must upgrade
  // in place: CREATE TABLE IF NOT EXISTS leaves its agents table alone, so
  // openDb adds the columns (and the agent verbs' SELECT would otherwise throw).
  describe("a v12 DB that predates agents.command / command_source", () => {
    // DROP COLUMN re-parses every trigger and view (~2s each under the full
    // capture schema), so strip once per file and copy the file per test.
    // legacy_alter_table skips that re-parse and leaves the same stored SQL.
    let template: string | undefined;
    let templateDir: string | undefined;
    afterAll(() => {
      if (templateDir) rmFixtureDir(templateDir);
    });
    const stripped = (): string => {
      if (template) return template;
      const dir = mkdtempSync(join(tmpdir(), "mu-schema-v12-tpl-"));
      templateDir = dir;
      template = join(dir, "mu.db");
      const seed = openDb({ path: template });
      ensureWorkstream(seed, "w");
      insertAgent(seed, { name: "a1", workstream: "w", paneId: "%1", cli: "pi" });
      seed.close();
      const raw = new Database(template);
      raw.pragma("legacy_alter_table = ON");
      raw.exec(
        "ALTER TABLE agents DROP COLUMN command; ALTER TABLE agents DROP COLUMN command_source;",
      );
      raw.close();
      return template;
    };
    const strip = (): void => {
      db.close();
      for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
      copyFileSync(stripped(), dbPath);
    };

    it("reopening adds the columns; agent reads work; rows and the stamp survive", () => {
      strip();
      const raw = new Database(dbPath);
      expect(
        (raw.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name),
      ).not.toContain("command");
      raw.close();
      db = openDb({ path: dbPath });
      expect(cols("agents").get("command")).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(cols("agents").get("command_source")).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 13 });
      const a = getAgent(db, "a1", "w");
      expect(a).toMatchObject({ name: "a1", paneId: "%1", command: null, commandSource: null });
    });

    it("a second reopen changes nothing (idempotent, no write lock needed)", () => {
      strip();
      db = openDb({ path: dbPath });
      const cookie = (db.pragma("schema_version", { simple: true }) as number) ?? 0;
      db.close();
      db = openDb({ path: dbPath });
      expect(db.pragma("schema_version", { simple: true })).toBe(cookie);
    });

    it("only one of the two missing: the other is left alone and the missing one is added", () => {
      strip();
      // Only command is back: command_source is the one missing column.
      const raw = new Database(dbPath);
      raw.exec("ALTER TABLE agents ADD COLUMN command TEXT");
      raw.close();
      db = openDb({ path: dbPath });
      expect(cols("agents").get("command_source")).toBeDefined();
      expect(cols("agents").get("command")).toBeDefined();
    });
  });

  it("adds the new columns with their defaults and constraints", () => {
    expect(cols("workstreams").get("torn_down_at")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(cols("agents").get("cwd")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(cols("agents").get("base")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(cols("agents").get("command")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(cols("agents").get("command_source")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(cols("tasks").get("scored")).toMatchObject({ notnull: 1, dflt: "0" });
    expect(cols("tasks").get("dispatch_host")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(cols("task_notes").get("kind")).toMatchObject({ notnull: 1, dflt: "'note'" });
    // impact / effort_days stay NOT NULL, now with SQL defaults 50 / 1.
    expect(cols("tasks").get("impact")).toMatchObject({ notnull: 1, dflt: "50" });
    expect(cols("tasks").get("effort_days")).toMatchObject({ notnull: 1, dflt: "1" });
    expect(NOTE_KINDS).toEqual(["brief", "report", "verdict", "close", "note"]);
  });

  it("CHECK constraints reject bad scored / kind values", () => {
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "t", title: "t", impact: 5, effortDays: 1 });
    expect(() => db.prepare("UPDATE tasks SET scored = 2").run()).toThrow(/CHECK/i);
    const id = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    expect(() =>
      db
        .prepare(
          "INSERT INTO task_notes (task_id, content, created_at, kind) VALUES (?, 'x', 'now', 'bogus')",
        )
        .run(id),
    ).toThrow(/CHECK/i);
  });

  it("task_auto is a machine-local table with its defaults", () => {
    expect(EXPECTED_TABLES).toContain("task_auto");
    expect(EXPECTED_TABLES).toHaveLength(24);
    expect(MACHINE_LOCAL_TABLES).toContain("task_auto");
    const c = cols("task_auto");
    expect([...c.keys()]).toEqual([
      "task_id",
      "cli",
      "worktree",
      "max_runs",
      "runs",
      "last_spawn",
      "created_at",
      "enabled",
    ]);
    expect(c.get("enabled")).toMatchObject({ notnull: 1, dflt: "1" });
    expect(c.get("worktree")).toMatchObject({ notnull: 1, dflt: "0" });
    expect(c.get("max_runs")).toMatchObject({ notnull: 1, dflt: "1" });
    expect(c.get("runs")).toMatchObject({ notnull: 1, dflt: "0" });
  });

  it("task_auto rows cascade with their task; max_runs must be positive", () => {
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "t", title: "t", impact: 5, effortDays: 1 });
    const id = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    expect(() =>
      db
        .prepare(
          "INSERT INTO task_auto (task_id, cli, max_runs, created_at) VALUES (?, 'pi', 0, 'n')",
        )
        .run(id),
    ).toThrow(/CHECK/i);
    db.prepare("INSERT INTO task_auto (task_id, cli, created_at) VALUES (?, 'pi', 'n')").run(id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_auto").get()).toEqual({ n: 0 });
  });

  it("creates the blockers view beside ready/blocked/goals", () => {
    const views = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(views).toEqual(["blockers", "blocked", "goals", "ready"].sort());
  });
});

describe("blockers view", () => {
  it("lists each task's direct OPEN blockers only", () => {
    ensureWorkstream(db, "d");
    for (const id of ["a", "b", "c"]) {
      addTask(db, { workstream: "d", localId: id, title: id, impact: 5, effortDays: 1 });
    }
    addBlockEdge(db, "d", "c", "a");
    addBlockEdge(db, "d", "c", "b");
    closeTask(db, "b", { workstream: "d", evidence: "test" });
    const rows = db
      .prepare(
        `SELECT t.local_id AS task, v.blocker_local_id AS blocker, v.blocker_status AS st
           FROM blockers v JOIN tasks t ON t.id = v.task_id ORDER BY 1, 2`,
      )
      .all();
    expect(rows).toEqual([{ task: "c", blocker: "a", st: "OPEN" }]);
    const cols2 = Object.keys(
      db
        .prepare("SELECT * FROM blockers LIMIT 1")
        .columns()
        .map((c) => c.name),
    );
    expect(cols2.length).toBe(4);
  });
});

describe("ready order", () => {
  const add = (id: string, o: { i?: number; e?: number; created: string }) => {
    ensureWorkstream(db, "d");
    addTask(db, {
      workstream: "d",
      localId: id,
      title: id,
      ...(o.i === undefined ? {} : { impact: o.i }),
      ...(o.e === undefined ? {} : { effortDays: o.e }),
    });
    db.prepare("UPDATE tasks SET created_at = ? WHERE local_id = ?").run(o.created, id);
  };

  it("scored by impact/effort desc, then unscored oldest first, then id", () => {
    add("u_new", { created: "2026-03-01T00:00:00.000Z" });
    add("lo", { i: 10, e: 2, created: "2026-01-01T00:00:00.000Z" });
    add("u_old", { created: "2026-01-01T00:00:00.000Z" });
    add("hi", { i: 90, e: 1, created: "2026-02-01T00:00:00.000Z" });
    add("u_old2", { created: "2026-01-01T00:00:00.000Z" });
    const order = listReady(db, "d").map((t) => t.name);
    expect(order).toEqual(["hi", "lo", "u_old", "u_old2", "u_new"]);
    // The reader contract: byRoiDesc (used by `task next`, `my next`, state)
    // yields the same order from any starting order.
    const shuffled = [...listReady(db, "d")].reverse().sort(byRoiDesc);
    expect(shuffled.map((t) => t.name)).toEqual(order);
  });

  it("equal ROI: smaller effort first, then local_id (listReady and byRoiDesc)", () => {
    const t = "2026-01-01T00:00:00.000Z";
    add("z_small", { i: 10, e: 1, created: t });
    add("b_big", { i: 40, e: 4, created: t });
    add("a_big", { i: 40, e: 4, created: t });
    add("m_mid", { i: 20, e: 2, created: t });
    const expected = ["z_small", "m_mid", "a_big", "b_big"];
    expect(listReady(db, "d").map((x) => x.name)).toEqual(expected);
    expect(
      [...listReady(db, "d")]
        .reverse()
        .sort(byRoiDesc)
        .map((x) => x.name),
    ).toEqual(expected);
  });

  it("an unscored task never outranks a scored one, however high its defaults", () => {
    add("scored_low", { i: 1, e: 5, created: "2026-05-01T00:00:00.000Z" });
    add("unscored", { created: "2026-01-01T00:00:00.000Z" });
    expect(listReady(db, "d").map((t) => t.name)).toEqual(["scored_low", "unscored"]);
  });
});

describe("scored on add / update", () => {
  const scored = (id: string) => (taskRow("d", id) as { scored: number }).scored;
  beforeEach(() => ensureWorkstream(db, "d"));

  it("add: neither -i nor -e -> scored 0 with defaults 50 / 1", () => {
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    expect(taskRow("d", "a")).toMatchObject({ scored: 0, impact: 50, effort_days: 1 });
  });

  it("add: either one given -> scored 1, the other defaults", () => {
    addTask(db, { workstream: "d", localId: "a", title: "a", impact: 80 });
    addTask(db, { workstream: "d", localId: "b", title: "b", effortDays: 3 });
    expect(taskRow("d", "a")).toMatchObject({ scored: 1, impact: 80, effort_days: 1 });
    expect(taskRow("d", "b")).toMatchObject({ scored: 1, impact: 50, effort_days: 3 });
  });

  it("update: --impact or --effort-days scores the task, even to the same value", () => {
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    const r = updateTask(db, "a", { impact: 50 }, { workstream: "d" });
    expect(r.updated).toBe(true);
    expect(scored("a")).toBe(1);
    addTask(db, { workstream: "d", localId: "b", title: "b" });
    updateTask(db, "b", { effortDays: 1 }, { workstream: "d" });
    expect(scored("b")).toBe(1);
    // already scored + same value stays a no-op
    expect(updateTask(db, "a", { impact: 50 }, { workstream: "d" }).updated).toBe(false);
    // title only does not score
    addTask(db, { workstream: "d", localId: "c", title: "c" });
    updateTask(db, "c", { title: "cc" }, { workstream: "d" });
    expect(scored("c")).toBe(0);
  });

  it("TaskRow carries scored and dispatchHost", () => {
    addTask(db, { workstream: "d", localId: "a", title: "a", impact: 7 });
    db.prepare("UPDATE tasks SET dispatch_host = 'box1'").run();
    expect(getTask(db, "a", "d")).toMatchObject({ scored: true, dispatchHost: "box1" });
    expect(listTasks(db, "d")[0]).toMatchObject({ scored: true, dispatchHost: "box1" });
  });
});

describe("capture of the new fields", () => {
  const ops = (entity: string) =>
    (
      db.prepare("SELECT payload FROM ops WHERE entity = ? ORDER BY seq").all(entity) as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

  it("task insert carries scored + dispatch_host; update carries only what changed", () => {
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    expect(ops("task")[0]).toMatchObject({ scored: 0, dispatch_host: null });
    db.prepare("DELETE FROM ops").run();
    db.prepare("UPDATE tasks SET dispatch_host = 'box1' WHERE local_id = 'a'").run();
    expect(ops("task")).toEqual([{ dispatch_host: "box1" }]);
    db.prepare("DELETE FROM ops").run();
    updateTask(db, "a", { impact: 70 }, { workstream: "d" });
    const p = ops("task")[0] ?? {};
    expect(p).toMatchObject({ impact: 70, scored: 1 });
  });

  it("workstream torn_down_at is captured as a one-field put", () => {
    ensureWorkstream(db, "d");
    expect(ops("workstream")[0]).toMatchObject({ torn_down_at: null });
    db.prepare("DELETE FROM ops").run();
    db.prepare("UPDATE workstreams SET torn_down_at = '2026-01-01T00:00:00.000Z'").run();
    expect(ops("workstream")).toEqual([{ torn_down_at: "2026-01-01T00:00:00.000Z" }]);
  });

  it("a note insert carries kind; agents.cwd/base and task_auto leave no ops", () => {
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    addNote(db, "a", "hello", { workstream: "d" });
    expect(ops("note")[0]).toMatchObject({ content: "hello", kind: "note" });
    const before = db.prepare("SELECT COUNT(*) AS n FROM ops").get();
    const id = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    db.prepare("INSERT INTO task_auto (task_id, cli, created_at) VALUES (?, 'pi', 'n')").run(id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops").get()).toEqual(before);
  });
});

describe("note kind is set once at INSERT", () => {
  const seedNote = (kind?: string) => {
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    const id = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO task_notes (task_id, content, created_at, kind) VALUES (?, 'x', 'now', ?)",
    ).run(id, kind ?? "note");
  };

  it("a local write changing kind raises; same-kind and other columns pass", () => {
    seedNote("brief");
    expect(() => db.prepare("UPDATE task_notes SET kind = 'report'").run()).toThrow(/kind/);
    expect(() => db.prepare("UPDATE task_notes SET kind = 'brief'").run()).not.toThrow();
    expect(() => db.prepare("UPDATE task_notes SET content = 'y'").run()).not.toThrow();
    expect(db.prepare("SELECT kind FROM task_notes").get()).toEqual({ kind: "brief" });
  });

  it("does not raise while applying (ingest must never roll back)", () => {
    seedNote("brief");
    expect(() =>
      withCaptureSuppressed(db, () => db.prepare("UPDATE task_notes SET kind = 'report'").run()),
    ).not.toThrow();
  });
});

describe("apply of the new fields", () => {
  it("note kind comes from the payload; absent (a 3.x v1 op) is 'note'", () => {
    for (const op of [
      peerOp(1, "task", "d/a", { title: "a" }),
      peerOp(2, "note", "d/a#1", {
        author: "p",
        content: "with",
        created_at: "t1",
        kind: "verdict",
      }),
      peerOp(3, "note", "d/a#2", { author: "p", content: "without", created_at: "t2" }),
    ]) {
      applyIncomingOp(db, op);
    }
    expect(db.prepare("SELECT content, kind FROM task_notes ORDER BY id").all()).toEqual([
      { content: "with", kind: "verdict" },
      { content: "without", kind: "note" },
    ]);
  });

  it("an unknown kind from a newer peer lands as 'note' (never a CHECK failure)", () => {
    applyIncomingOp(db, peerOp(1, "task", "d/a", { title: "a" }));
    expect(() =>
      applyIncomingOp(
        db,
        peerOp(2, "note", "d/a#1", { content: "c", created_at: "t", kind: "telemetry" }),
      ),
    ).not.toThrow();
    expect(db.prepare("SELECT kind FROM task_notes").get()).toEqual({ kind: "note" });
  });

  it("scored, dispatch_host and torn_down_at merge by per-field LWW, in either order", () => {
    const early = [
      peerOp(1000, "task", "d/a", { title: "a", scored: 0, dispatch_host: "old" }),
      peerOp(1001, "workstream", "d", { torn_down_at: "2026-01-01T00:00:00.000Z" }),
    ];
    const late = [
      peerOp(2000, "task", "d/a", { scored: 1, dispatch_host: null }),
      peerOp(2001, "workstream", "d", { torn_down_at: null }),
    ];
    for (const order of [
      [...early, ...late],
      [...late, ...early],
    ]) {
      const p = join(tempDir, `ord-${seq++}.db`);
      const x = openDb({ path: p });
      for (const op of order) {
        applyIncomingOp(x, op);
      }
      expect(
        x.prepare("SELECT scored, dispatch_host FROM tasks WHERE local_id = 'a'").get(),
      ).toEqual({ scored: 1, dispatch_host: null });
      expect(x.prepare("SELECT torn_down_at FROM workstreams WHERE name = 'd'").get()).toEqual({
        torn_down_at: null,
      });
      x.close();
    }
  });

  it("a scored outside {0,1} is dropped instead of failing the CHECK", () => {
    expect(() =>
      applyIncomingOp(db, peerOp(1, "task", "d/a", { title: "a", scored: 7 })),
    ).not.toThrow();
    expect(taskRow("d", "a")).toMatchObject({ scored: 0 });
  });

  it("the placeholder insert for a partial task op uses the schema defaults", () => {
    applyIncomingOp(db, peerOp(1, "task", "d/a", { title: "a" }));
    expect(taskRow("d", "a")).toMatchObject({ impact: 50, effort_days: 1, scored: 0 });
  });

  it("ingest still finds a torn-down workstream (UNIQUE(name) must not break it)", () => {
    ensureWorkstream(db, "d");
    db.prepare("UPDATE workstreams SET torn_down_at = '2026-01-01T00:00:00.000Z'").run();
    expect(() => {
      applyIncomingOp(db, peerOp(1, "workstream", "d", { created_at: "2025-01-01T00:00:00.000Z" }));
      applyIncomingOp(db, peerOp(2, "task", "d/new", { title: "n" }));
      applyIncomingOp(db, peerOp(3, "note", "d/new#1", { content: "c", created_at: "t" }));
    }).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name = 'd'").get()).toEqual({
      n: 1,
    });
    expect(taskRow("d", "new")).toBeDefined();
  });
});

describe("torn-down workstreams are invisible to user-facing reads", () => {
  beforeEach(() => {
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a", impact: 5, effortDays: 1 });
    addTask(db, { workstream: "d", localId: "b", title: "b", impact: 5, effortDays: 1 });
    addBlockEdge(db, "d", "b", "a");
    ensureWorkstream(db, "live");
    addTask(db, { workstream: "live", localId: "z", title: "z", impact: 5, effortDays: 1 });
  });
  const tearDown = () =>
    db.prepare("UPDATE workstreams SET torn_down_at = 'x' WHERE name = 'd'").run();

  it("views drop their rows", () => {
    for (const v of ["ready", "blocked", "goals"]) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${v}`).get() as { n: number }).n,
      ).toBeGreaterThan(0);
    }
    const n = (v: string) =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${v} x JOIN workstreams w ON w.id = x.workstream_id WHERE w.name = 'd'`,
          )
          .get() as { n: number }
      ).n;
    expect([n("ready"), n("blocked"), n("goals")]).toEqual([1, 1, 1]);
    tearDown();
    expect([n("ready"), n("blocked"), n("goals")]).toEqual([0, 0, 0]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM blockers").get()).toEqual({ n: 0 });
  });

  it("resolve helpers and readers treat the name as absent", async () => {
    tearDown();
    expect(tryResolveWorkstreamId(db, "d")).toBeNull();
    expect(() => resolveWorkstreamId(db, "d")).toThrow(WorkstreamNotFoundError);
    expect(() => resolveWorkstreamId(db, "d")).toThrow(/is torn down/);
    // User-facing task reads say why instead of returning "no tasks".
    for (const read of [
      () => listReady(db, "d"),
      () => listBlocked(db, "d"),
      () => listGoals(db, "d"),
      () => listTasks(db, "d"),
      () => getTask(db, "a", "d"),
    ])
      expect(read).toThrow(WorkstreamTornDownError);
    expect((await listWorkstreams(db)).map((w) => w.name)).toEqual(["live"]);
  });
});

describe("new fields only ride v2 segment lines", () => {
  const sample = (payload: Record<string, unknown>) => ({
    hlc: formatHlc({ wallMs: 1, counter: 0, machineId: PEER }),
    machineId: PEER,
    groupId: "g",
    intent: null,
    actor: null,
    entity: "task",
    key: "d/a",
    op: "put" as const,
    payload: JSON.stringify(payload),
  });

  it.each(["scored", "dispatch_host", "kind", "torn_down_at"])(
    "encoding %s at v1 is refused; v2 and fieldless v1 are fine",
    (field) => {
      expect(() => encodeSegmentLine(sample({ [field]: 1 }), 1)).toThrow(/v1/);
      expect(decodeLine(encodeSegmentLine(sample({ [field]: 1 }), 2)).ok).toBe(true);
      expect(decodeLine(encodeSegmentLine(sample({ impact: 3 }), 1)).ok).toBe(true);
    },
  );

  it("flush writes the new fields on v2 lines and a peer ingests them", async () => {
    const dir = join(tempDir, "sync");
    mkdirSync(dir, { recursive: true });
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a", impact: 9 });
    addNote(db, "a", "n", { workstream: "d" });
    const taskId = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO task_notes (task_id, content, created_at, kind) VALUES (?, 'rep', 'now', 'report')",
    ).run(taskId);
    db.prepare("UPDATE tasks SET dispatch_host = 'host-a'").run();
    db.prepare("UPDATE workstreams SET torn_down_at = '2026-01-01T00:00:00.000Z'").run();
    await flushSegment(db, dir);
    const lines = readFileSync(segmentPath(dir, localMachineId(db)), "utf8")
      .split("\n")
      .filter(Boolean);
    const decoded = lines.map((l) => decodeLine(l));
    expect(decoded.every((d) => d.ok && d.line.v === 2)).toBe(true);
    const text = lines.join("\n");
    for (const f of ["scored", "dispatch_host", "kind", "torn_down_at"])
      expect(text).toContain(`"${f}"`);

    const other = openDb({ path: join(tempDir, "peer.db") });
    try {
      const peer = discoverPeers(dir, localMachineId(other))[0];
      if (peer === undefined) throw new Error("expected a peer");
      expect(ingestSegment(other, peer).defects).toEqual([]);
      expect(
        other.prepare("SELECT scored, dispatch_host FROM tasks WHERE local_id = 'a'").get(),
      ).toEqual({ scored: 1, dispatch_host: "host-a" });
      expect(other.prepare("SELECT torn_down_at FROM workstreams").get()).toEqual({
        torn_down_at: "2026-01-01T00:00:00.000Z",
      });
      // A default note stays 'note'; a non-default kind survives the round trip.
      expect(other.prepare("SELECT content, kind FROM task_notes ORDER BY id").all()).toEqual([
        { content: "n", kind: "note" },
        { content: "rep", kind: "report" },
      ]);

      // Second exchange: B clears every nullable/flag field and adds a verdict
      // note; A must converge on the cleared values.
      other.prepare("UPDATE tasks SET dispatch_host = NULL, scored = 0").run();
      other.prepare("UPDATE workstreams SET torn_down_at = NULL").run();
      const otherTaskId = (other.prepare("SELECT id FROM tasks").get() as { id: number }).id;
      other
        .prepare(
          "INSERT INTO task_notes (task_id, content, created_at, kind) VALUES (?, 'ver', 'now', 'verdict')",
        )
        .run(otherTaskId);
      await flushSegment(other, dir);
      const back = discoverPeers(dir, localMachineId(db)).find(
        (p) => p.machineId === localMachineId(other),
      );
      if (back === undefined) throw new Error("expected B's segment");
      expect(ingestSegment(db, back).defects).toEqual([]);
      expect(
        db.prepare("SELECT scored, dispatch_host FROM tasks WHERE local_id = 'a'").get(),
      ).toEqual({ scored: 0, dispatch_host: null });
      expect(db.prepare("SELECT torn_down_at FROM workstreams").get()).toEqual({
        torn_down_at: null,
      });
      expect(db.prepare("SELECT kind FROM task_notes WHERE content = 'ver'").get()).toEqual({
        kind: "verdict",
      });
    } finally {
      other.close();
    }
  });
});
