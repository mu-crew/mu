// Schema 13 (v_loop_storage): the loop's storage.
//
//   1. A real populated v12 DB (test/fixtures/v12-populated.db.gz) upgrades
//      in ONE transaction: columns, tables, capture triggers and both stamps
//      together; a failure or a newer stamp leaves the old file as it was.
//   2. tasks.kind / tasks.wave are portable: captured, folded per field,
//      applied in any arrival order, rebuilt, drift-checked; v1 lines cannot
//      carry them; an unknown kind never wedges ingest.
//   3. The four tables and agents.spawner/host/collected_head are machine-local.
//
// The fixture is a vacuumed copy of a DB written by the schema-12 build
// (ed5038a) through the real CLI: 2 workstreams, 4 tasks (one claimed and
// one closed-able), an edge, a note, an agent, a worktree row, a task_auto
// row, 11 ops, capture revision 2, 31 capture triggers.

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAgent, insertAgent } from "../src/agents.js";
import type { Op } from "../src/apply.js";
import { CAPTURE_TRIGGERS, CAPTURE_VERSION, captureTriggersCurrent } from "../src/capture.js";
import {
  CURRENT_SCHEMA_VERSION,
  type Db,
  DELEGATE_CALL_STATES,
  EXPECTED_TABLES,
  MACHINE_LOCAL_TABLES,
  openDb,
  PORTABLE_TABLES,
  SchemaTooNewError,
  SchemaTooOldError,
  TASK_KINDS,
  upgradeSchema,
} from "../src/db.js";
import { checkDrift } from "../src/drift.js";
import { foldTask, type LogOp } from "../src/fold.js";
import { formatHlc } from "../src/hlc.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { rebuildInto } from "../src/rebuild.js";
import {
  applyIncomingOp,
  decodeLine,
  encodeSegmentLine,
  SEGMENT_FORMAT_VERSION,
} from "../src/segments.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, listTasks } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const NEW_TABLES = [
  "agent_settles",
  "delegate_calls",
  "host_channels",
  "host_profiles",
  "spawn_receipts",
  "wait_cursors",
] as const;

let dir: string;
let n = 0;
let open: Db[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-loop-storage-"));
  writeFileSync(
    join(dir, "v12.db"),
    gunzipSync(readFileSync(join(__dirname, "fixtures", "v12-populated.db.gz"))),
  );
});
afterAll(() => rmFixtureDir(dir));
afterEach(() => {
  for (const d of open) {
    try {
      d.close();
    } catch {}
  }
  open = [];
});

/** A private copy of the populated v12 DB, not yet opened by mu. */
function v12Copy(): string {
  const p = join(dir, `copy-${++n}.db`);
  copyFileSync(join(dir, "v12.db"), p);
  return p;
}
const track = (d: Db): Db => {
  open.push(d);
  return d;
};
const fresh = (): Db => track(openDb({ path: join(dir, `fresh-${++n}.db`) }));

function raw<T>(path: string, fn: (db: Database.Database) => T): T {
  const r = new Database(path);
  try {
    return fn(r);
  } finally {
    r.close();
  }
}
const stamps = (path: string) =>
  raw(
    path,
    (r) =>
      r.prepare("SELECT version, capture_version AS capture FROM schema_version").get() as {
        version: number;
        capture: number;
      },
  );
const columns = (path: string, table: string): string[] =>
  raw(path, (r) =>
    (r.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
const triggers = (path: string): Record<string, string> =>
  raw(path, (r) =>
    Object.fromEntries(
      (
        r
          .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
          .all() as { name: string; sql: string }[]
      ).map((t) => [t.name, t.sql]),
    ),
  );
const tables = (path: string): string[] =>
  raw(path, (r) =>
    (
      r
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name),
  );

/** A Db whose `exec` throws for SQL matching `when`; everything else passes through. */
function failingOn(db: Database.Database, when: (sql: string) => boolean, err = "disk full"): Db {
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "exec") {
        return (sql: string) => {
          if (when(sql)) throw new Error(err);
          return target.exec(sql);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as Db;
}

// ─── 1. The upgrade ───────────────────────────────────────────────────

describe("a populated v12 DB upgrades to v13", () => {
  it("the fixture really is a v12 / capture-2 file with the data in it", () => {
    const p = v12Copy();
    expect(stamps(p)).toEqual({ version: 12, capture: 2 });
    expect(columns(p, "tasks")).not.toContain("kind");
    expect(columns(p, "agents")).not.toContain("spawner");
    expect(tables(p)).not.toContain("delegate_calls");
    expect(raw(p, (r) => r.prepare("SELECT COUNT(*) AS c FROM tasks").get())).toEqual({ c: 4 });
  });

  it("one open raises both stamps, adds columns and tables, swaps the triggers, keeps every row", () => {
    const p = v12Copy();
    const before = raw(p, (r) => ({
      ops: r.prepare("SELECT * FROM ops ORDER BY seq").all(),
      tasks: r.prepare("SELECT id, local_id, title, status, owner_id FROM tasks ORDER BY id").all(),
      notes: r.prepare("SELECT * FROM task_notes").all(),
      agents: r.prepare("SELECT name, pane_id FROM agents").all(),
      worktrees: r.prepare("SELECT * FROM worktrees").all(),
      auto: r.prepare("SELECT * FROM task_auto").all(),
      edges: r.prepare("SELECT * FROM task_edges").all(),
    }));
    const db = track(openDb({ path: p }));

    expect(stamps(p)).toEqual({ version: CURRENT_SCHEMA_VERSION, capture: CAPTURE_VERSION });
    expect(CURRENT_SCHEMA_VERSION).toBe(13);
    expect(columns(p, "tasks")).toEqual(expect.arrayContaining(["kind", "wave"]));
    expect(columns(p, "agents")).toEqual(
      expect.arrayContaining(["spawner", "host", "collected_head", "cwd", "base"]),
    );
    expect(tables(p)).toEqual([...EXPECTED_TABLES].sort());
    expect(captureTriggersCurrent(db)).toBe(true);
    for (const t of CAPTURE_TRIGGERS) expect(triggers(p)[t.name]).toBe(t.sql);

    // Nothing the user had was changed or lost, and the upgrade wrote no op.
    const after = raw(p, (r) => ({
      ops: r.prepare("SELECT * FROM ops ORDER BY seq").all(),
      tasks: r.prepare("SELECT id, local_id, title, status, owner_id FROM tasks ORDER BY id").all(),
      notes: r.prepare("SELECT * FROM task_notes").all(),
      agents: r.prepare("SELECT name, pane_id FROM agents").all(),
      worktrees: r.prepare("SELECT * FROM worktrees").all(),
      auto: r.prepare("SELECT * FROM task_auto").all(),
      edges: r.prepare("SELECT * FROM task_edges").all(),
    }));
    expect(after).toEqual(before);

    // Defaults: every old task is kind 'work', no wave; the old agent has no spawner.
    expect(listTasks(db).map((t) => [t.kind, t.wave])).toEqual(Array(4).fill(["work", null]));
    expect(getAgent(db, "w1", "alpha")).toMatchObject({
      spawner: null,
      host: null,
      collectedHead: null,
    });
    for (const t of NEW_TABLES) {
      expect(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()).toEqual({ c: 0 });
    }
    expect(checkDrift(db).clean).toBe(true);
  });

  it("an upgraded file enforces the same constraints as a fresh one (ALTERed kind keeps its CHECK and default)", () => {
    const p = v12Copy();
    const db = track(openDb({ path: p }));
    expect(() => db.prepare("UPDATE tasks SET kind = 'bogus'").run()).toThrow(/CHECK/i);
    const info = db.prepare("SELECT * FROM pragma_table_info('tasks') WHERE name = 'kind'").get();
    expect(info).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'work'" });
    for (const k of TASK_KINDS)
      expect(() => db.prepare("UPDATE tasks SET kind = ?").run(k)).not.toThrow();
  });

  it("the upgraded file captures kind and wave under the new triggers", () => {
    const p = v12Copy();
    const db = track(openDb({ path: p }));
    const before = (db.prepare("SELECT MAX(seq) AS s FROM ops").get() as { s: number }).s;
    db.prepare("UPDATE tasks SET kind = 'delegate', wave = 'r1' WHERE local_id = 't1'").run();
    const rows = db.prepare("SELECT entity, payload FROM ops WHERE seq > ?").all(before);
    expect(rows).toEqual([{ entity: "task", payload: '{"kind":"delegate","wave":"r1"}' }]);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("a second open does no DDL and takes no write lock", () => {
    const p = v12Copy();
    track(openDb({ path: p })).close();
    const cookie = raw(p, (r) => r.pragma("schema_version", { simple: true }));
    const holder = new Database(p);
    holder.exec("BEGIN IMMEDIATE"); // would make a writing open wait 5 s
    try {
      const started = Date.now();
      track(openDb({ path: p })).close();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(raw(p, (r) => r.pragma("schema_version", { simple: true }))).toBe(cookie);
  });

  it("an already-v13 file missing one addition gets exactly that column", () => {
    const p = v12Copy();
    // Everything of v13 except tasks.wave: as an earlier schema-13 build left it.
    raw(p, (r) => {
      r.exec(
        "ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','delegate','human'))",
      );
      r.exec("UPDATE schema_version SET version = 13");
    });
    const db = track(openDb({ path: p }));
    expect(columns(p, "tasks").filter((c) => c === "kind")).toHaveLength(1);
    expect(columns(p, "tasks")).toContain("wave");
    expect(stamps(p)).toEqual({ version: 13, capture: CAPTURE_VERSION });
    expect(captureTriggersCurrent(db)).toBe(true);
    expect(getTask(db, "t1", "alpha")).toMatchObject({ kind: "work", wave: null });
  });

  it("an already-v13 file without spawn_receipts gets the table, rows intact (no version bump)", () => {
    const p = v12Copy();
    const first = track(openDb({ path: p }));
    first.close();
    raw(p, (r) => r.exec("DROP TABLE spawn_receipts"));
    const db = track(openDb({ path: p }));
    expect(stamps(p)).toEqual({ version: 13, capture: CAPTURE_VERSION });
    expect(db.prepare("SELECT COUNT(*) AS c FROM spawn_receipts").get()).toEqual({ c: 0 });
    expect(getAgent(db, "w1", "alpha")).toBeDefined();
    expect(getTask(db, "t1", "alpha")).toBeDefined();
  });

  it("an already-v13 file without host_channels gets the table, host_profiles rows intact (no version bump)", () => {
    const p = v12Copy();
    track(openDb({ path: p })).close();
    raw(p, (r) => {
      r.exec(
        "INSERT INTO host_profiles (name, shell, exec, fetch, repo) VALUES ('h','s','e','f','r')",
      );
      r.exec("DROP TABLE host_channels");
    });
    const db = track(openDb({ path: p }));
    expect(stamps(p)).toEqual({ version: 13, capture: CAPTURE_VERSION });
    expect(db.prepare("SELECT COUNT(*) AS c FROM host_channels").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT name FROM host_profiles").all()).toEqual([{ name: "h" }]);
    expect(getAgent(db, "w1", "alpha")).toBeDefined();
  });

  it("an already-v13 file missing only agents.collected_head gets it back, rows intact", () => {
    const p = v12Copy();
    raw(p, (r) => {
      r.exec("ALTER TABLE agents ADD COLUMN spawner TEXT; ALTER TABLE agents ADD COLUMN host TEXT");
      r.exec("UPDATE agents SET spawner = 'alpha/orch'");
      r.exec("UPDATE schema_version SET version = 13");
    });
    const db = track(openDb({ path: p }));
    expect(columns(p, "agents")).toContain("collected_head");
    expect(getAgent(db, "w1", "alpha")).toMatchObject({
      spawner: "alpha/orch",
      collectedHead: null,
    });
    expect(stamps(p)).toEqual({ version: 13, capture: CAPTURE_VERSION });
  });

  it("still refuses v11 untouched, and a newer schema or capture stamp untouched", () => {
    const old = join(dir, `old-${++n}.db`);
    raw(old, (r) =>
      r.exec(
        "CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1, 11);",
      ),
    );
    const oldBytes = readFileSync(old);
    expect(() => openDb({ path: old })).toThrow(SchemaTooOldError);
    expect(readFileSync(old).equals(oldBytes)).toBe(true);

    for (const [col, value] of [
      ["version", CURRENT_SCHEMA_VERSION + 1],
      ["capture_version", CAPTURE_VERSION + 1],
    ] as const) {
      const p = v12Copy();
      raw(p, (r) => r.prepare(`UPDATE schema_version SET ${col} = ?`).run(value));
      const bytes = readFileSync(p);
      expect(() => openDb({ path: p })).toThrow(SchemaTooNewError);
      expect(readFileSync(p).equals(bytes)).toBe(true);
    }
  });

  it("a stamp raised by a newer mu between the unlocked read and the lock is respected: nothing changes", () => {
    for (const [col, value] of [
      ["version", CURRENT_SCHEMA_VERSION + 1],
      ["capture_version", CAPTURE_VERSION + 1],
    ] as const) {
      const p = v12Copy();
      const mine = new Database(p);
      mine.pragma("busy_timeout = 5000");
      const racing = new Proxy(mine, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target) as unknown;
          if (prop === "exec") {
            return (sql: string) => {
              // A newer mu stamps the file just before this build takes the lock.
              if (sql === "BEGIN IMMEDIATE")
                raw(p, (r) => r.prepare(`UPDATE schema_version SET ${col} = ?`).run(value));
              return target.exec(sql);
            };
          }
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as Db;
      expect(() => upgradeSchema(racing)).toThrow(SchemaTooNewError);
      expect(mine.inTransaction).toBe(false);
      mine.close();
      expect(columns(p, "tasks")).not.toContain("kind");
      expect(tables(p)).not.toContain("delegate_calls");
      expect(triggers(p)).toEqual(triggers(v12Fixture()));
    }
  });

  it("a failure while installing the triggers rolls back columns, tables, triggers and stamps together", () => {
    const p = v12Copy();
    const oldTriggers = triggers(p);
    const mine = new Database(p);
    mine.pragma("busy_timeout = 0");
    const db = failingOn(mine, (sql) => sql.startsWith("CREATE TRIGGER _cap_tasks_upd"));
    expect(() => upgradeSchema(db)).toThrow("disk full");
    expect(mine.inTransaction).toBe(false);
    mine.close();

    expect(stamps(p)).toEqual({ version: 12, capture: 2 }); // old stamps...
    expect(columns(p, "tasks")).not.toContain("kind"); // ...old columns...
    expect(columns(p, "agents")).not.toContain("spawner");
    expect(tables(p)).not.toContain("delegate_calls");
    expect(triggers(p)).toEqual(oldTriggers); // ...and the old triggers, together.
    // No lock is left behind, and the file still opens and upgrades afterwards.
    raw(p, (r) => {
      r.pragma("busy_timeout = 0");
      r.exec("UPDATE tasks SET title = 'still writable' WHERE local_id = 't1'");
    });
    track(openDb({ path: p }));
    expect(stamps(p)).toEqual({ version: 13, capture: CAPTURE_VERSION });
  });

  it("a failure while adding a column also leaves no trace of the earlier DDL", () => {
    const p = v12Copy();
    const mine = new Database(p);
    const db = failingOn(mine, (sql) => sql.startsWith("ALTER TABLE agents ADD COLUMN host"));
    expect(() => upgradeSchema(db)).toThrow("disk full");
    mine.close();
    expect(stamps(p)).toEqual({ version: 12, capture: 2 });
    expect(columns(p, "tasks")).not.toContain("kind");
    expect(columns(p, "agents")).not.toContain("spawner");
  });
});

let fixturePath: string | undefined;
/** The untouched fixture, for comparing trigger text against. */
function v12Fixture(): string {
  fixturePath ??= join(dir, "v12.db");
  return fixturePath;
}

// ─── 2. Portable: kind and wave ───────────────────────────────────────

const M = "9f1c8a2e-0000-4000-8000-0000000000aa";
const M2 = "9f1c8a2e-0000-4000-8000-0000000000bb";
const BASE = 2_000_000_000_000;
const h = (w: number, machine = M): string =>
  formatHlc({ wallMs: BASE + w, counter: 0, machineId: machine });
const lput = (w: number, payload: Record<string, unknown>): LogOp => ({
  hlc: h(w),
  op: "put",
  key: "k",
  payload: JSON.stringify(payload),
});
let seq = 0;
const peer = (
  w: number,
  entity: string,
  key: string,
  payload: Record<string, unknown>,
  machine = M,
): Op => ({
  hlc: h(w, machine),
  machineId: machine,
  groupId: `g-${++seq}`,
  actor: "peer",
  intent: null,
  entity,
  key,
  op: "put",
  payload: JSON.stringify(payload),
});

describe("foldTask: kind and wave", () => {
  it("default work / null; per-field LWW; a null wave clears it", () => {
    expect(foldTask([lput(1, { title: "a" })], null, "a")).toMatchObject({
      kind: "work",
      wave: null,
    });
    const t = foldTask(
      [
        lput(3, { kind: "human" }),
        lput(1, { kind: "delegate", wave: "r1" }),
        lput(2, { wave: "r2" }),
      ],
      null,
      "a",
    );
    expect(t).toMatchObject({ kind: "human", wave: "r2" });
    expect(
      foldTask([lput(1, { wave: "r1" }), lput(2, { wave: null })], null, "a")?.wave,
    ).toBeNull();
  });

  it("an unknown or mistyped kind is dropped: the last known one stands, else work", () => {
    expect(
      foldTask([lput(1, { kind: "delegate" }), lput(2, { kind: "telemetry" })], null, "a")?.kind,
    ).toBe("delegate");
    expect(foldTask([lput(1, { kind: "telemetry" })], null, "a")?.kind).toBe("work");
    expect(foldTask([lput(1, { kind: 7 }), lput(2, { wave: 7 })], null, "a")).toMatchObject({
      kind: "work",
      wave: null,
    });
  });

  it("a dead life's kind and wave do not leak into the next life", () => {
    const t = foldTask(
      [lput(1, { kind: "delegate", wave: "r1" }), lput(3, { title: "x" })],
      h(2),
      "a",
    );
    expect(t).toMatchObject({ kind: "work", wave: null });
  });
});

describe("apply: kind and wave from peers", () => {
  let db: Db;
  const taskOf = (d: Db) =>
    d.prepare("SELECT kind, wave FROM tasks WHERE local_id = 'a'").get() as {
      kind: string;
      wave: string | null;
    };
  beforeEach(() => {
    db = fresh();
  });

  const early = [
    peer(1000, "task", "d/a", { title: "a", kind: "delegate", wave: "r1" }),
    peer(1001, "task", "d/a", { wave: "r2" }, M2),
  ];
  const late = [peer(2000, "task", "d/a", { kind: "human", wave: null })];

  it("converges in either arrival order, and a later null clears the wave", () => {
    for (const order of [
      [...early, ...late],
      [...late, ...early],
      [early[1] as Op, ...late, early[0] as Op],
    ]) {
      const x = fresh();
      for (const o of order) applyIncomingOp(x, o);
      expect(taskOf(x)).toEqual({ kind: "human", wave: null });
    }
  });

  it("a v1-era op without kind or wave lands as work / null", () => {
    applyIncomingOp(db, peer(1, "task", "d/a", { title: "a" }));
    expect(taskOf(db)).toEqual({ kind: "work", wave: null });
  });

  it("an unknown kind from a newer peer neither throws nor wedges the row", () => {
    applyIncomingOp(db, peer(1, "task", "d/a", { title: "a", kind: "delegate" }));
    expect(() => applyIncomingOp(db, peer(2, "task", "d/a", { kind: "quantum" }))).not.toThrow();
    expect(taskOf(db).kind).toBe("delegate");
    expect(() => applyIncomingOp(db, peer(3, "task", "d/b", { kind: "quantum" }))).not.toThrow();
    expect(db.prepare("SELECT kind FROM tasks WHERE local_id = 'b'").get()).toEqual({
      kind: "work",
    });
  });

  it("owner stays a local projection: kind/wave ops never assign an owner", () => {
    applyIncomingOp(db, peer(1, "task", "d/a", { kind: "delegate", wave: "r", owner_id: 1 }));
    expect(db.prepare("SELECT owner_id FROM tasks").get()).toEqual({ owner_id: null });
  });
});

describe("local writes: kind and wave", () => {
  it("are captured on insert and as changed-only puts; the CHECK refuses a bad kind", () => {
    const db = fresh();
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    const puts = () =>
      (
        db.prepare("SELECT payload FROM ops WHERE entity = 'task' ORDER BY seq").all() as {
          payload: string;
        }[]
      ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    expect(puts()[0]).toMatchObject({ kind: "work", wave: null });
    db.prepare("DELETE FROM ops").run();
    db.prepare("UPDATE tasks SET wave = 'r1'").run();
    expect(puts()).toEqual([{ wave: "r1" }]);
    db.prepare("DELETE FROM ops").run();
    db.prepare("UPDATE tasks SET wave = NULL, kind = 'human'").run();
    expect(puts()).toEqual([{ kind: "human", wave: null }]);
    expect(() => db.prepare("UPDATE tasks SET kind = 'bogus'").run()).toThrow(/CHECK/i);
    expect(TASK_KINDS).toEqual(["work", "delegate", "human"]);
  });

  it("a rebuild reproduces them, and drift names an uncaptured change", () => {
    const db = fresh();
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    addTask(db, { workstream: "d", localId: "b", title: "b" });
    db.prepare("UPDATE tasks SET kind = 'delegate', wave = 'r1' WHERE local_id = 'a'").run();
    expect(checkDrift(db).clean).toBe(true);
    const target = join(dir, `rebuilt-${++n}.db`);
    rebuildInto(db, { targetPath: target });
    expect(
      raw(target, (r) =>
        r.prepare("SELECT local_id, kind, wave FROM tasks ORDER BY local_id").all(),
      ),
    ).toEqual([
      { local_id: "a", kind: "delegate", wave: "r1" },
      { local_id: "b", kind: "work", wave: null },
    ]);
    for (const [sql, field] of [
      ["UPDATE tasks SET kind = 'human' WHERE local_id = 'b'", "kind"],
      ["UPDATE tasks SET wave = 'zz' WHERE local_id = 'b'", "wave"],
    ] as const) {
      withCaptureSuppressed(db, () => db.prepare(sql).run());
      expect(checkDrift(db).records[0]).toMatchObject({ table: "tasks", key: "d/b", field });
      db.prepare("UPDATE tasks SET kind = 'work', wave = NULL WHERE local_id = 'b'").run();
      expect(checkDrift(db).clean).toBe(true);
    }
  });
});

describe("segments: kind and wave ride v2 lines only", () => {
  const line = (payload: Record<string, unknown>, v?: number) =>
    encodeSegmentLine(
      {
        hlc: h(1),
        machineId: M,
        groupId: "g",
        intent: null,
        actor: null,
        entity: "task",
        key: "d/a",
        op: "put",
        payload: JSON.stringify(payload),
      },
      v,
    );

  it.each(["kind", "wave"])("a v1 line carrying %s is refused; v2 round-trips it", (field) => {
    expect(() => line({ [field]: "x" }, 1)).toThrow(
      new RegExp(`v1 segment line carrying ${field}`),
    );
    const d = decodeLine(line({ [field]: "x" }, 2));
    expect(d.ok && JSON.parse(d.payloadText)).toEqual({ [field]: "x" });
    expect(() => line({ title: "plain" }, 1)).not.toThrow();
  });

  it("schema 13 is still segment format 2", () => {
    expect(SEGMENT_FORMAT_VERSION).toBe(2);
  });
});

// ─── 3. Machine-local ─────────────────────────────────────────────────

describe("machine-local state", () => {
  it("the six tables are classified machine-local, never portable, and listed as expected", () => {
    for (const t of NEW_TABLES) {
      expect(MACHINE_LOCAL_TABLES).toContain(t);
      expect(PORTABLE_TABLES as readonly string[]).not.toContain(t);
      expect(EXPECTED_TABLES).toContain(t);
    }
    expect(EXPECTED_TABLES).toHaveLength(21);
    expect(PORTABLE_TABLES).toEqual(["task_edges", "task_notes", "tasks", "workstreams"]);
  });

  it("writes to them and to agents.spawner/host/collected_head leave no ops", () => {
    const db = fresh();
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    insertAgent(db, { name: "w1", workstream: "d", paneId: "%1" });
    const ops = () => db.prepare("SELECT COUNT(*) AS c FROM ops").get();
    const before = ops();
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO delegate_calls (task_id, caller, call_id, state, updated_at) VALUES (?, 'ws/o', 'c1', 'queued', 'n')",
    ).run(tid);
    db.prepare("INSERT INTO wait_cursors (caller, ref) VALUES ('c', 'r')").run();
    db.prepare("INSERT INTO agent_settles (agent_id, incarnation, runs) VALUES (1, 'i', 1)").run();
    db.prepare(
      "INSERT INTO host_profiles (name, shell, exec, fetch, repo) VALUES ('h', 's', 'e', 'f', 'r')",
    ).run();
    db.prepare(
      `INSERT INTO spawn_receipts (task_id, attempt_key, name, workstream, request_sha, msg_id, state, created_at, updated_at)
       VALUES (?, 'manual:a', 'w1', 'd', 'sha', 'm', 'reserved', 'n', 'n')`,
    ).run(tid);
    db.prepare("UPDATE spawn_receipts SET state = 'sent'").run();
    db.prepare("UPDATE agents SET spawner = 'x/y', host = 'h', collected_head = 'abc'").run();
    expect(ops()).toEqual(before);
  });

  it("delegate_calls: cascades with its task; state, call_id and task are constrained", () => {
    const db = fresh();
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    addTask(db, { workstream: "d", localId: "b", title: "b" });
    const [a, b] = (db.prepare("SELECT id FROM tasks ORDER BY id").all() as { id: number }[]).map(
      (r) => r.id,
    );
    const ins = (task: number | undefined, callId: string, state = "queued") =>
      db
        .prepare(
          "INSERT INTO delegate_calls (task_id, caller, call_id, state, updated_at) VALUES (?, 'ws/o', ?, ?, 'n')",
        )
        .run(task, callId, state);
    for (const s of DELEGATE_CALL_STATES) {
      db.prepare("DELETE FROM delegate_calls").run();
      expect(() => ins(a, `c-${s}`, s)).not.toThrow();
    }
    expect(() => ins(a, "c-x", "bogus")).toThrow(/CHECK/i);
    expect(() => ins(a, "c-dup")).toThrow(/UNIQUE|PRIMARY/i); // one call per task
    expect(() => ins(b, "c-done", "done")).not.toThrow();
    expect(() => ins(a, "c-done")).toThrow(); // call_id unique
    expect(() => ins(999, "c-orphan")).toThrow(/FOREIGN KEY/i);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(a);
    expect(db.prepare("SELECT task_id FROM delegate_calls").all()).toEqual([{ task_id: b }]);
  });

  it("agent_settles outlive the agent and the task (replay evidence is not cascaded away)", () => {
    const db = fresh();
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    insertAgent(db, { name: "w1", workstream: "d", paneId: "%1" });
    const agent = (db.prepare("SELECT id FROM agents").get() as { id: number }).id;
    const task = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO agent_settles (agent_id, incarnation, runs, task_id) VALUES (?, 'i', 1, ?)",
    ).run(agent, task);
    expect(() =>
      db
        .prepare("INSERT INTO agent_settles (agent_id, incarnation, runs) VALUES (?, 'i', 1)")
        .run(agent),
    ).toThrow(/UNIQUE|PRIMARY/i);
    db.prepare("DELETE FROM agents").run();
    db.prepare("DELETE FROM tasks").run();
    db.prepare("DELETE FROM workstreams").run();
    expect(
      db.prepare("SELECT agent_id, incarnation, runs, task_id FROM agent_settles").all(),
    ).toEqual([{ agent_id: agent, incarnation: "i", runs: 1, task_id: task }]);
    // A new agent never reuses the id, so the old evidence cannot be mistaken for its own.
    ensureWorkstream(db, "d");
    insertAgent(db, { name: "w1", workstream: "d", paneId: "%2" });
    expect((db.prepare("SELECT id FROM agents").get() as { id: number }).id).toBeGreaterThan(agent);
  });

  it("spawn_receipts: keyed per (task, attempt), state is checked, rows cascade with the task but NOT with the agent", () => {
    const db = fresh();
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    const agent = insertAgent(db, { name: "w", workstream: "d", paneId: "%1" });
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    const ins = (key: string, state: string) =>
      db
        .prepare(
          `INSERT INTO spawn_receipts (task_id, attempt_key, name, workstream, request_sha, msg_id, agent_id, pane_id, state, created_at, updated_at)
           VALUES (?, ?, 'w', 'd', 'sha', 'm', ?, '%1', ?, 'n', 'n')`,
        )
        .run(tid, key, agent.incarnation, state);
    ins("manual:a", "sent");
    expect(() => ins("manual:a", "sent")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => ins("manual:b", "bogus")).toThrow(/CHECK/);
    // No FK to agents: the receipt outlives the agent it names.
    db.prepare("DELETE FROM agents").run();
    expect(db.prepare("SELECT agent_id FROM spawn_receipts").all()).toEqual([
      { agent_id: agent.incarnation },
    ]);
    db.prepare("DELETE FROM tasks").run();
    expect(db.prepare("SELECT COUNT(*) AS c FROM spawn_receipts").get()).toEqual({ c: 0 });
  });

  it("host_channels: one row per (host, holder); kind and its identity columns are checked", () => {
    const db = fresh();
    const ins = (sql: string) => db.prepare(`INSERT INTO host_channels ${sql}`).run();
    const cols = "(host, holder, kind, token, pid, agent_id, pane_id, opened_at)";
    ins(`${cols} VALUES ('h', 'a', 'transient', 't', 1, NULL, NULL, 'n')`);
    expect(() => ins(`${cols} VALUES ('h', 'a', 'transient', 't2', 1, NULL, NULL, 'n')`)).toThrow(
      /UNIQUE|PRIMARY/,
    );
    expect(() => ins(`${cols} VALUES ('h', 'b', 'bogus', 't', 1, NULL, NULL, 'n')`)).toThrow(
      /CHECK/,
    );
    expect(() => ins(`${cols} VALUES ('h', 'c', 'transient', 't', NULL, NULL, NULL, 'n')`)).toThrow(
      /CHECK/,
    );
    expect(() => ins(`${cols} VALUES ('h', 'd', 'attached', 't', NULL, 1, NULL, 'n')`)).toThrow(
      /CHECK/,
    );
    ins(`${cols} VALUES ('h', 'e', 'attached', 't', NULL, 1, '%1', 'n')`);
    // Local: no ops, no FK to the profile or the agent.
    expect(db.prepare("SELECT COUNT(*) AS c FROM ops").get()).toEqual({ c: 0 });
  });

  it("host_profiles.max_sessions must be positive (or null); wait_cursors is keyed per caller and ref", () => {
    const db = fresh();
    const prof = (max: number | null) =>
      db
        .prepare(
          "INSERT OR REPLACE INTO host_profiles (name, shell, exec, fetch, repo, max_sessions) VALUES ('h', 's', 'e', 'f', 'r', ?)",
        )
        .run(max);
    expect(() => prof(0)).toThrow(/CHECK/i);
    expect(() => prof(-1)).toThrow(/CHECK/i);
    expect(() => prof(null)).not.toThrow();
    expect(() => prof(2)).not.toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO host_profiles (name, shell, exec, fetch) VALUES ('x','s','e','f')")
        .run(),
    ).toThrow(/NOT NULL/i);
    const cur = db.prepare(
      "INSERT INTO wait_cursors (caller, ref, incarnation, runs) VALUES (?, ?, 'i', 1)",
    );
    cur.run("a", "r");
    cur.run("b", "r");
    cur.run("a", "s");
    expect(() => cur.run("a", "r")).toThrow(/UNIQUE|PRIMARY/i);
  });

  it("a rebuild reports the five tables' rows as lost, not silently dropped", () => {
    const db = fresh();
    ensureWorkstream(db, "d");
    addTask(db, { workstream: "d", localId: "a", title: "a" });
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO delegate_calls (task_id, caller, call_id, state, updated_at) VALUES (?, 'c', 'c1', 'done', 'n')",
    ).run(tid);
    db.prepare("INSERT INTO wait_cursors (caller, ref) VALUES ('c', 'r')").run();
    db.prepare("INSERT INTO wait_cursors (caller, ref) VALUES ('c', 's')").run();
    db.prepare("INSERT INTO agent_settles (agent_id, incarnation, runs) VALUES (1, 'i', 1)").run();
    db.prepare(
      "INSERT INTO host_profiles (name, shell, exec, fetch, repo) VALUES ('h','s','e','f','r')",
    ).run();
    db.prepare(
      `INSERT INTO spawn_receipts (task_id, attempt_key, name, workstream, request_sha, msg_id, state, created_at, updated_at)
       VALUES (?, 'manual:a', 'w', 'd', 'sha', 'm', 'sent', 'n', 'n')`,
    ).run(tid);
    db.prepare(
      "INSERT INTO host_channels (host, holder, kind, token, pid, opened_at) VALUES ('h', 'x', 'transient', 't', 1, 'n')",
    ).run();
    const report = rebuildInto(db, { targetPath: join(dir, `rb-${++n}.db`) });
    expect(report.machineLocalLost).toEqual(
      expect.arrayContaining([
        { table: "delegate_calls", rows: 1 },
        { table: "wait_cursors", rows: 2 },
        { table: "agent_settles", rows: 1 },
        { table: "host_profiles", rows: 1 },
        { table: "host_channels", rows: 1 },
        { table: "spawn_receipts", rows: 1 },
      ]),
    );
  });
});
