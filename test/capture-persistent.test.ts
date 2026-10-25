// Persistent capture (k_persist_capture): the triggers live in the DB
// file, the op context is the one-row main table `op_ctx`, and the
// context wrappers own the transaction around it.
//
// Two real connections on one WAL file stand in for two mu processes.
// `b` runs with busy_timeout 0 so "blocked by a's write lock" shows up
// as SQLITE_BUSY at once instead of after 5 s.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_TRIGGERS,
  CAPTURE_VERSION,
  CaptureTooNewError,
  captureDoctorCheck,
  captureTriggerChecksums,
  captureTriggersCurrent,
  GENERATED_TRIGGER_CHECKSUM,
  installCapture,
  sqliteTooOld,
} from "../src/capture.js";
import { classifyError } from "../src/cli/handle.js";
import { type Db, openDb, SchemaTooNewError, SqliteTooOldError } from "../src/db.js";
import {
  CtxTransactionEndedError,
  currentOpContext,
  withCaptureSuppressed,
  withOpContext,
} from "../src/op-context.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const PINNED_CHECKSUM = "0fa2a6ee2668584f1bdf66e3d65e8f792eeba3bd46eeeb808c58bf0050ace3d9";

let dir: string;
let path: string;
let a: Db;
let b: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-capture-persistent-"));
  path = join(dir, "mu.db");
  a = openDb({ path });
  ensureWorkstream(a, "demo");
  b = openDb({ path });
  b.pragma("busy_timeout = 0");
});

afterEach(() => {
  for (const db of [a, b]) {
    try {
      db.close();
    } catch {}
  }
  rmFixtureDir(dir);
});

interface OpRow {
  intent: string | null;
  actor: string | null;
  group_id: string;
  entity: string;
  key: string;
  op: string;
  payload: string;
}

const opsOf = (db: Db, entity?: string): OpRow[] =>
  (
    db
      .prepare(
        "SELECT intent, actor, group_id, entity, key, op, payload FROM ops WHERE entity IN ('workstream','task','note','edge') ORDER BY seq",
      )
      .all() as OpRow[]
  ).filter((r) => entity === undefined || r.entity === entity);

const clearOps = (db: Db): void => {
  db.prepare("DELETE FROM ops").run();
};

const insertTask = (db: Db | InstanceType<typeof Database>, localId: string): void => {
  db.prepare(
    `INSERT INTO tasks (workstream_id, local_id, title, status, substate, impact, effort_days, created_at, updated_at)
     SELECT id, ?, 't', 'OPEN', 'todo', 50, 1, 'x', 'x' FROM workstreams WHERE name = 'demo'`,
  ).run(localId);
};

const busy = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return String((e as { code?: unknown }).code);
  }
  return "no error";
};

describe("a connection that never ran mu setup", () => {
  it("is captured by the stored triggers (safety net)", () => {
    a.close();
    b.close();
    const raw = new Database(path);
    try {
      raw.pragma("foreign_keys = ON");
      raw.prepare("DELETE FROM ops").run();
      insertTask(raw, "plain");
      raw
        .prepare(
          "UPDATE tasks SET status = 'IN_PROGRESS', substate = 'active' WHERE local_id = 'plain'",
        )
        .run();
    } finally {
      raw.close();
    }
    a = openDb({ path });
    b = openDb({ path });
    const rows = opsOf(a, "task");
    expect(rows.map((r) => [r.key, r.op, r.intent])).toEqual([
      ["demo/plain", "put", null],
      ["demo/plain", "put", null],
    ]);
    expect(Object.keys(JSON.parse(rows[1]?.payload ?? "{}") as object).sort()).toEqual(
      ["status", "substate", "updated_at"].filter((k) => k !== "updated_at"),
    );
  });

  it("captures a cascading delete with resolved keys and leaves op_dying empty", () => {
    insertTask(a, "t1");
    clearOps(a);
    a.close();
    b.close();
    const raw = new Database(path);
    try {
      raw.pragma("foreign_keys = ON");
      raw.prepare("DELETE FROM workstreams WHERE name = 'demo'").run();
    } finally {
      raw.close();
    }
    a = openDb({ path });
    b = openDb({ path });
    expect(
      opsOf(a)
        .map((r) => `${r.entity}:${r.op}:${r.key}`)
        .sort(),
    ).toEqual(["task:del:demo/t1", "workstream:del:demo"]);
    expect(a.prepare("SELECT COUNT(*) AS n FROM op_dying").get()).toEqual({ n: 0 });
  });
});

describe("the context wrappers own the transaction (sp_ctx_txn_boundary)", () => {
  it("never stamps another connection's write with this connection's context", () => {
    insertTask(a, "t1");
    clearOps(a);
    let inside = "";
    withOpContext(a, { intent: "x", actor: "alice", group: "new" }, () => {
      // b cannot write while a's transaction holds the lock...
      inside = busy(() => insertTask(b, "from-b"));
      // ...and b's snapshot of op_ctx is the committed one: defaults.
      expect(b.prepare("SELECT intent, applying FROM op_ctx").get()).toEqual({
        intent: null,
        applying: 0,
      });
      a.prepare("UPDATE tasks SET impact = 7 WHERE local_id = 't1'").run();
    });
    expect(inside).toMatch(/SQLITE_BUSY/);
    // After a's scope ends, b's plain write goes through with NO intent.
    insertTask(b, "from-b");
    const byKey = new Map(opsOf(a, "task").map((r) => [r.key, r]));
    expect(byKey.get("demo/from-b")?.intent).toBeNull();
    expect(byKey.get("demo/from-b")?.actor).toBeNull();
    expect(byKey.get("demo/t1")?.intent).toBe("x");
  });

  it("opens and closes the transaction itself", () => {
    expect(a.inTransaction).toBe(false);
    let during = false;
    withOpContext(a, { intent: "x" }, () => {
      during = a.inTransaction;
    });
    expect(during).toBe(true);
    expect(a.inTransaction).toBe(false);
    withCaptureSuppressed(a, () => {
      during = a.inTransaction;
    });
    expect(during).toBe(true);
    expect(a.inTransaction).toBe(false);
  });

  it("a throw rolls back the write and the context: op_ctx is back to defaults", () => {
    clearOps(a);
    expect(() =>
      withOpContext(a, { intent: "x", actor: "alice" }, () => {
        insertTask(a, "doomed");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(a.inTransaction).toBe(false);
    expect(currentOpContext(b)).toEqual({
      groupId: null,
      actor: null,
      intent: null,
      applying: false,
    });
    expect(a.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(opsOf(a)).toEqual([]);
    // b is not blocked: the lock went away with the rollback.
    expect(busy(() => insertTask(b, "after"))).toBe("no error");
  });

  it("a crash mid-scope leaves applying = 0 for the next connection", () => {
    clearOps(a);
    const crashing = new Database(path);
    crashing.exec("BEGIN IMMEDIATE");
    crashing.prepare("UPDATE op_ctx SET applying = 1, intent = 'ghost'").run();
    crashing.close(); // dies without COMMIT
    const fresh = openDb({ path });
    try {
      expect(currentOpContext(fresh).applying).toBe(false);
      expect(currentOpContext(fresh).intent).toBeNull();
      insertTask(fresh, "after-crash");
      expect(opsOf(fresh, "task").map((r) => r.intent)).toEqual([null]);
    } finally {
      fresh.close();
    }
  });

  it("withCaptureSuppressed blocks other writers, then capture is back on", () => {
    clearOps(a);
    let inside = "";
    withCaptureSuppressed(a, () => {
      inside = busy(() => insertTask(b, "blocked"));
      insertTask(a, "ingested");
    });
    expect(inside).toMatch(/SQLITE_BUSY/);
    expect(opsOf(a)).toEqual([]); // the suppressed write minted nothing
    insertTask(b, "plain");
    expect(opsOf(a, "task").map((r) => r.key)).toEqual(["demo/plain"]);
    expect(currentOpContext(b).applying).toBe(false);
  });

  it("refuses to leave a context behind when fn ends the transaction itself", () => {
    expect(() =>
      withOpContext(a, { intent: "leak" }, () => {
        a.exec("COMMIT");
      }),
    ).toThrow(CtxTransactionEndedError);
    expect(currentOpContext(b).intent).toBeNull();
    expect(a.inTransaction).toBe(false);
  });

  it("a readonly connection just runs fn: no transaction, no ctx write", () => {
    const ro = openDb({ path, readonly: true });
    try {
      let seen: unknown;
      expect(withOpContext(ro, { intent: "x" }, () => (seen = ro.inTransaction))).toBe(false);
      expect(seen).toBe(false);
      expect(withCaptureSuppressed(ro, () => 7)).toBe(7);
      expect(currentOpContext(ro).intent).toBeNull();
    } finally {
      ro.close();
    }
  });

  it("nested scopes run in the outer transaction and restore the outer context", () => {
    withOpContext(a, { intent: "outer", actor: "o", group: "g1" }, () => {
      withOpContext(a, { intent: "inner" }, () => {
        expect(currentOpContext(a)).toMatchObject({ intent: "inner", actor: "o", groupId: "g1" });
      });
      expect(currentOpContext(a)).toMatchObject({ intent: "outer", groupId: "g1" });
      withCaptureSuppressed(a, () => {
        expect(currentOpContext(a).applying).toBe(true);
      });
      expect(currentOpContext(a).applying).toBe(false);
    });
    expect(currentOpContext(a)).toEqual({
      groupId: null,
      actor: null,
      intent: null,
      applying: false,
    });
  });

  it("db.transaction inside the wrapper becomes a savepoint and keeps working", () => {
    withOpContext(a, { intent: "x" }, () => {
      expect(() =>
        a.transaction(() => {
          insertTask(a, "in-savepoint");
          throw new Error("inner");
        })(),
      ).toThrow("inner");
      a.transaction(() => insertTask(a, "kept")).immediate();
    });
    const keys = (a.prepare("SELECT local_id FROM tasks").all() as { local_id: string }[]).map(
      (r) => r.local_id,
    );
    expect(keys).toEqual(["kept"]);
  });
});

describe("an implicit rollback never leaves op_ctx to another writer (rv6_ctx_rollback_leak)", () => {
  const probe = (db: Db): void => {
    db.exec(
      "CREATE TEMP TABLE rollback_probe(x TEXT NOT NULL); INSERT OR ROLLBACK INTO rollback_probe VALUES (NULL)",
    );
  };
  // PRAGMA data_version moves when ANOTHER connection commits; read first so b has a snapshot.
  const dataVersion = (db: Db): number => {
    db.prepare("SELECT 1 FROM op_ctx").get();
    return db.pragma("data_version", { simple: true }) as number;
  };
  const committedCtx = (db: Db): unknown =>
    db.prepare("SELECT group_id, actor, intent, applying FROM op_ctx").get();
  const DEFAULTS = { group_id: null, actor: null, intent: null, applying: 0 };

  it("nested differing ctx: caught rollback writes nothing, b sees defaults and is captured", () => {
    insertTask(a, "t1");
    clearOps(a);
    const v0 = dataVersion(b);
    let seen: unknown;
    let captured = 0;
    let versionAtCatch = -1;
    expect(() =>
      withCaptureSuppressed(a, () => {
        try {
          withOpContext(a, { intent: "inner" }, () => probe(a));
        } catch {
          expect(a.inTransaction).toBe(false);
          versionAtCatch = dataVersion(b);
          seen = committedCtx(b);
          // The lock is gone with the rollback; b's plain write must be captured.
          b.prepare("UPDATE tasks SET title = 'independent'").run();
          captured = opsOf(b, "task").length;
        }
      }),
    ).toThrow(CtxTransactionEndedError);
    expect(seen).toEqual(DEFAULTS);
    expect(captured).toBe(1);
    // a committed nothing between the rollback and the catch (no autocommit ctx write).
    expect(versionAtCatch).toBe(v0);
    expect(committedCtx(b)).toEqual(DEFAULTS);
  });

  it("nested same ctx (fast path): caught rollback leaves defaults", () => {
    let seen: unknown;
    expect(() =>
      withCaptureSuppressed(a, () => {
        try {
          withCaptureSuppressed(a, () => probe(a));
        } catch {
          seen = committedCtx(b);
        }
      }),
    ).toThrow(CtxTransactionEndedError);
    expect(seen).toEqual(DEFAULTS);
  });

  it("outermost scope: a fn that rolled back itself triggers no autocommit write", () => {
    const v0 = dataVersion(b);
    expect(() => withOpContext(a, { intent: "x" }, () => probe(a))).toThrow();
    expect(a.inTransaction).toBe(false);
    expect(committedCtx(b)).toEqual(DEFAULTS);
    expect(dataVersion(b)).toBe(v0);
    // and a caught one that returns normally still fails loudly
    expect(() =>
      withOpContext(a, { intent: "x" }, () => {
        try {
          probe(a);
        } catch {}
      }),
    ).toThrow(CtxTransactionEndedError);
    expect(dataVersion(b)).toBe(v0);
    expect(committedCtx(b)).toEqual(DEFAULTS);
  });

  it("after a rollback the scope writes nothing: another writer's lock cannot mask the error", () => {
    a.pragma("busy_timeout = 0");
    expect(() =>
      withOpContext(a, { intent: "x" }, () => {
        try {
          probe(a);
        } catch {}
        b.exec("BEGIN IMMEDIATE"); // b now holds the write lock; a must not need it
      }),
    ).toThrow(CtxTransactionEndedError);
    b.exec("ROLLBACK");
  });

  it("a crash right after the caught rollback leaves applying = 0", () => {
    let atCrash: unknown;
    expect(() =>
      withCaptureSuppressed(a, () => {
        try {
          withOpContext(a, { intent: "inner" }, () => probe(a));
        } catch {
          // What a fresh process would find if a died right here.
          const fresh = new Database(path);
          try {
            atCrash = fresh.prepare("SELECT group_id, actor, intent, applying FROM op_ctx").get();
          } finally {
            fresh.close();
          }
        }
      }),
    ).toThrow(CtxTransactionEndedError);
    expect(atCrash).toEqual(DEFAULTS);
  });

  it("nested fn that COMMITs the transaction does not leave its ctx committed", () => {
    let seen: unknown;
    expect(() =>
      withCaptureSuppressed(a, () => {
        try {
          withOpContext(a, { intent: "inner" }, () => {
            a.exec("COMMIT");
          });
        } finally {
          seen = committedCtx(b);
        }
      }),
    ).toThrow(CtxTransactionEndedError);
    expect(seen).toEqual(DEFAULTS);
    expect(committedCtx(b)).toEqual(DEFAULTS);
  });

  it("a healthy nested scope still restores the outer context in the transaction", () => {
    withOpContext(a, { intent: "outer" }, () => {
      withOpContext(a, { intent: "inner" }, () => {});
      expect(currentOpContext(a).intent).toBe("outer");
      expect(committedCtx(b)).toEqual(DEFAULTS);
    });
  });
});

describe("the op_ctx row", () => {
  it("cannot be deleted through SQL", () => {
    expect(() => a.prepare("DELETE FROM op_ctx").run()).toThrow(/op_ctx is the op context row/);
  });

  it("a missing row fails the write loudly instead of silently dropping capture; a wrapper heals it", () => {
    a.exec("DROP TRIGGER _cap_op_ctx_nodelete");
    a.prepare("DELETE FROM op_ctx").run();
    clearOps(a);
    // Fail loud, never silently uncaptured: the HLC tick needs the row.
    expect(() => insertTask(a, "x")).toThrow(/NOT NULL|last_wall/);
    expect(a.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    // The wrapper upserts the row, so one scope restores the invariant.
    withOpContext(a, { intent: "heal" }, () => {});
    expect(a.prepare("SELECT COUNT(*) AS n FROM op_ctx").get()).toEqual({ n: 1 });
    expect(busy(() => insertTask(a, "after"))).toBe("no error");
    expect(opsOf(a, "task").some((r) => r.key === "demo/after")).toBe(true);
  });
});

describe("explicit non-positive ids are refused", () => {
  const ws = "INSERT INTO workstreams (id, name, created_at) VALUES (?, 'neg', 'x')";
  const task = (id: number) =>
    `INSERT INTO tasks (id, workstream_id, local_id, title, status, substate, impact, effort_days, created_at, updated_at)
     SELECT ${id}, id, 'neg', 't', 'OPEN', 'todo', 50, 1, 'x', 'x' FROM workstreams WHERE name = 'demo'`;
  const note = (id: number) =>
    `INSERT INTO task_notes (id, task_id, author, content, created_at)
     SELECT ${id}, id, 'n', 'neg', 'x' FROM tasks WHERE local_id = 't1'`;
  const edge = (id: number) =>
    `INSERT INTO task_edges (rowid, from_task_id, to_task_id, created_at)
     SELECT ${id}, (SELECT id FROM tasks WHERE local_id = 't1'), (SELECT id FROM tasks WHERE local_id = 't2'), 'x'`;

  it.each([-1, 0])("id %i is refused on all four tables and writes nothing", (id) => {
    insertTask(a, "t1");
    insertTask(a, "t2");
    clearOps(a);
    const count = (): unknown[] =>
      ["workstreams", "tasks", "task_notes", "task_edges"].map(
        (t) => (a.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    const before = count();
    for (const sql of [
      () => a.prepare(ws).run(id),
      () => a.prepare(task(id)).run(),
      () => a.prepare(note(id)).run(),
      () => a.prepare(edge(id)).run(),
    ]) {
      expect(sql).toThrow(/non-positive ids are refused/);
    }
    expect(count()).toEqual(before);
    expect(opsOf(a)).toEqual([]);
  });

  // An explicit id near INT64_MAX moves the AUTOINCREMENT counter there, and the
  // next omitted-id insert then fails "database or disk is full" for good.
  it.each([9007199254740992n, 9223372036854775807n])(
    "id %s (above 2^53-1) is refused on all four tables, and inserts keep working",
    (id) => {
      insertTask(a, "t1");
      insertTask(a, "t2");
      clearOps(a);
      for (const sql of [
        () => a.prepare(ws).run(id),
        () => a.prepare(task(id as unknown as number)).run(),
        () => a.prepare(note(id as unknown as number)).run(),
        () => a.prepare(edge(id as unknown as number)).run(),
      ]) {
        expect(sql).toThrow(/ids above 2\^53-1 are refused/);
      }
      expect(opsOf(a)).toEqual([]);
      expect(() => insertTask(a, "after")).not.toThrow();
      expect(() =>
        a.prepare("INSERT INTO workstreams (name, created_at) VALUES ('ok', 'x')").run(),
      ).not.toThrow();
    },
  );

  it("the largest safe id (2^53-1) is still accepted", () => {
    expect(() => a.prepare(ws).run(9007199254740991n)).not.toThrow();
  });

  it("an omitted-id insert still works after a refused -1 attempt", () => {
    expect(() => a.prepare(ws).run(-1)).toThrow(/non-positive/);
    expect(() =>
      a.prepare("INSERT INTO workstreams (name, created_at) VALUES ('ok', 'x')").run(),
    ).not.toThrow();
    expect(() =>
      a.prepare("INSERT INTO workstreams (name, created_at) VALUES ('ok2', 'x')").run(),
    ).not.toThrow();
  });

  it("an explicit positive id is accepted, and ingest (applying) is never refused", () => {
    expect(() => a.prepare(ws).run(500)).not.toThrow();
    withCaptureSuppressed(a, () => {
      expect(() =>
        a
          .prepare("INSERT INTO workstreams (id, name, created_at) VALUES (0, 'ingested', 'x')")
          .run(),
      ).not.toThrow();
    });
  });
});

// ─── the stored trigger set is versioned ──────────────────────────────

describe("capture version stamp", () => {
  const rawStamp = (): number =>
    (() => {
      const raw = new Database(path, { readonly: true });
      try {
        return raw.prepare("SELECT capture_version AS v FROM schema_version").get() as {
          v: number;
        };
      } finally {
        raw.close();
      }
    })().v;

  const triggerSql = (): Map<string, string> => {
    const raw = new Database(path, { readonly: true });
    try {
      const rows = raw
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_cap\\_%' ESCAPE '\\'",
        )
        .all() as { name: string; sql: string }[];
      return new Map(rows.map((r) => [r.name, r.sql]));
    } finally {
      raw.close();
    }
  };

  const reopen = (): void => {
    a.close();
    b.close();
    a = openDb({ path });
    b = openDb({ path });
  };

  it("a fresh DB is stamped with CAPTURE_VERSION and holds exactly the generated triggers", () => {
    expect(rawStamp()).toBe(CAPTURE_VERSION);
    expect(captureTriggersCurrent(a)).toBe(true);
    expect([...triggerSql().keys()].sort()).toEqual(CAPTURE_TRIGGERS.map((t) => t.name).sort());
    for (const t of CAPTURE_TRIGGERS) expect(triggerSql().get(t.name)).toBe(t.sql);
    // Nothing temp-scoped is left: a second connection sees no _op_ctx.
    expect(() => a.prepare("SELECT * FROM _op_ctx").get()).toThrow(/no such table/);
  });

  it("pins the generated DDL: changing a generator requires a CAPTURE_VERSION bump", () => {
    // If this fails you changed trigger SQL. Bump CAPTURE_VERSION in
    // src/capture.ts, then update the pin below.
    expect(CAPTURE_VERSION).toBe(4);
    expect(GENERATED_TRIGGER_CHECKSUM).toBe(PINNED_CHECKSUM);
  });

  it("a NEWER stamp is refused with SchemaTooNewError and the file is left untouched", () => {
    a.close();
    b.close();
    const raw = new Database(path);
    raw.prepare("UPDATE schema_version SET capture_version = ?").run(CAPTURE_VERSION + 1);
    raw.exec("DROP TRIGGER _cap_tasks_ins");
    raw.close();
    expect(() => openDb({ path })).toThrow(SchemaTooNewError);
    expect(rawStamp()).toBe(CAPTURE_VERSION + 1);
    expect(triggerSql().has("_cap_tasks_ins")).toBe(false); // not "repaired"
    // Refused BEFORE the schema DDL, not only before the trigger step: a
    // table the DDL would recreate is still missing.
    const probe = new Database(path);
    probe.exec("DROP TABLE op_dying");
    probe.close();
    expect(() => openDb({ path })).toThrow(SchemaTooNewError);
    const after = new Database(path, { readonly: true });
    try {
      expect(
        after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'op_dying'").get(),
      ).toBeUndefined();
    } finally {
      after.close();
    }
    a = openDb({ path: join(dir, "other.db") }); // keep afterEach happy
    b = openDb({ path: join(dir, "other.db") });
  });

  it("an OLDER stamp replaces every trigger and the stamp together", () => {
    a.close();
    b.close();
    const raw = new Database(path);
    raw.prepare("UPDATE schema_version SET capture_version = 0").run();
    raw.exec("DROP TRIGGER _cap_tasks_upd");
    raw.exec("DROP TRIGGER _cap_tasks_ins");
    raw.exec(
      "CREATE TRIGGER _cap_stale_old AFTER INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'stale'); END",
    );
    raw.exec(
      "CREATE TRIGGER _cap_tasks_ins AFTER INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'stale'); END",
    );
    raw.close();
    reopen();
    expect(rawStamp()).toBe(CAPTURE_VERSION);
    const stored = triggerSql();
    expect(stored.has("_cap_stale_old")).toBe(false);
    for (const t of CAPTURE_TRIGGERS) expect(stored.get(t.name)).toBe(t.sql);
    expect(captureTriggersCurrent(a)).toBe(true);
    expect(busy(() => insertTask(a, "works-again"))).toBe("no error");
  });

  it("a DB with no capture_version column (older v12 file) gets it, with its triggers", () => {
    a.close();
    b.close();
    const raw = new Database(path);
    raw.exec("DROP TRIGGER _cap_tasks_ins");
    raw.pragma("legacy_alter_table = ON"); // DROP COLUMN otherwise re-parses every trigger (~2s)
    raw.exec("ALTER TABLE schema_version DROP COLUMN capture_version");
    raw.close();
    reopen();
    expect(rawStamp()).toBe(CAPTURE_VERSION);
    expect(captureTriggersCurrent(a)).toBe(true);
  });

  it("a hand-edited trigger under an equal stamp is reported by captureTriggersCurrent", () => {
    a.close();
    b.close();
    const raw = new Database(path);
    raw.exec("DROP TRIGGER _cap_tasks_ins");
    raw.exec("CREATE TRIGGER _cap_tasks_ins AFTER INSERT ON tasks BEGIN SELECT 1; END");
    raw.close();
    reopen();
    expect(captureTriggersCurrent(a)).toBe(false);
    const sums = captureTriggerChecksums(a);
    expect(sums.stored).not.toBe(sums.generated);
  });

  it("installCapture refuses a newer stamp directly, before any lock", () => {
    b.prepare("UPDATE schema_version SET capture_version = ?").run(CAPTURE_VERSION + 1);
    // Another process holds the write lock: a newer stamp must be refused
    // from the unlocked read, not by queueing for the lock first.
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    try {
      a.pragma("busy_timeout = 0");
      expect(() => installCapture(a)).toThrow(CaptureTooNewError);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(a.inTransaction).toBe(false);
    expect(triggerSql().size).toBe(CAPTURE_TRIGGERS.length); // untouched
  });

  it("installCapture re-reads the stamp under the lock: a newer opener that won the race is respected", () => {
    b.prepare("UPDATE schema_version SET capture_version = 0").run();
    // Between a's unlocked read (0) and a's BEGIN IMMEDIATE, a newer mu stamps the file.
    const racing = {
      get inTransaction() {
        return a.inTransaction;
      },
      prepare: (sql: string) => a.prepare(sql),
      exec: (sql: string) => {
        if (sql === "BEGIN IMMEDIATE") {
          b.prepare("UPDATE schema_version SET capture_version = ?").run(CAPTURE_VERSION + 1);
        }
        return a.exec(sql);
      },
    };
    expect(() => installCapture(racing)).toThrow(CaptureTooNewError);
    expect(a.inTransaction).toBe(false);
    expect(rawStamp()).toBe(CAPTURE_VERSION + 1);
    expect(triggerSql().size).toBe(CAPTURE_TRIGGERS.length); // the old set, not half a new one
  });

  it("a failure mid-upgrade rolls back: old triggers and old stamp stay together, no lock held", () => {
    b.prepare("UPDATE schema_version SET capture_version = 0").run();
    const before = triggerSql();
    const failing = {
      get inTransaction() {
        return a.inTransaction;
      },
      prepare: (sql: string) => a.prepare(sql),
      exec: (sql: string) => {
        if (sql.startsWith("CREATE TRIGGER _cap_tasks_upd")) throw new Error("disk full");
        return a.exec(sql);
      },
    };
    expect(() => installCapture(failing)).toThrow("disk full");
    expect(a.inTransaction).toBe(false);
    expect(rawStamp()).toBe(0);
    expect(triggerSql()).toEqual(before);
    expect(busy(() => insertTask(b, "not-locked-out"))).toBe("no error");
  });

  it("an upgrade re-seeds a missing op_ctx row", () => {
    a.exec("DROP TRIGGER _cap_op_ctx_nodelete");
    a.prepare("DELETE FROM op_ctx").run();
    b.prepare("UPDATE schema_version SET capture_version = 0").run();
    installCapture(a);
    expect(a.prepare("SELECT COUNT(*) AS n FROM op_ctx").get()).toEqual({ n: 1 });
  });

  it("an equal stamp opens with no DDL and no write lock", () => {
    const cookie = (): unknown => {
      const raw = new Database(path, { readonly: true });
      try {
        return raw.pragma("schema_version", { simple: true });
      } finally {
        raw.close();
      }
    };
    const before = cookie();
    a.exec("BEGIN IMMEDIATE"); // a holds the write lock
    try {
      const started = Date.now();
      const c = openDb({ path });
      c.close();
      expect(Date.now() - started).toBeLessThan(2000); // would wait 5 s for the lock
    } finally {
      a.exec("ROLLBACK");
    }
    expect(cookie()).toBe(before);
  });

  it("concurrent openers upgrading an older stamp end with one coherent set", () => {
    a.close();
    b.close();
    const raw = new Database(path);
    raw.prepare("UPDATE schema_version SET capture_version = 0").run();
    raw.close();
    const x = openDb({ path });
    const y = openDb({ path });
    try {
      expect(rawStamp()).toBe(CAPTURE_VERSION);
      expect(captureTriggersCurrent(y)).toBe(true);
    } finally {
      x.close();
      y.close();
    }
    a = openDb({ path });
    b = openDb({ path });
  });
});

// ─── SQLite floor ─────────────────────────────────────────────────────

describe("minimum SQLite 3.42", () => {
  it("sqliteTooOld compares each part numerically", () => {
    expect(sqliteTooOld("3.41.2")).toBe(true);
    expect(sqliteTooOld("3.9.0")).toBe(true); // "3.9" > "3.42" as text
    expect(sqliteTooOld("3.42.0")).toBe(false);
    expect(sqliteTooOld("3.50.1")).toBe(false);
    expect(sqliteTooOld("4.0.0")).toBe(false);
    expect(sqliteTooOld("2.99.9")).toBe(true);
  });

  const withVersion = (db: Db, version: string): void => {
    db.function("sqlite_version", () => version);
  };

  it.each(["3.41.2", "3.9.9", "2.50.0"])(
    "every emitting trigger aborts the write under SQLite %s",
    (version) => {
      insertTask(a, "t1");
      withVersion(a, version);
      const msg = /SQLite >= 3.42 required \(unixepoch subsec\)/;
      const attempts: Array<[string, () => void]> = [
        [
          "workstream insert",
          () => a.prepare("INSERT INTO workstreams (name, created_at) VALUES ('w2', 'x')").run(),
        ],
        ["workstream update", () => a.prepare("UPDATE workstreams SET torn_down_at = 'x'").run()],
        ["workstream delete", () => a.prepare("DELETE FROM workstreams").run()],
        ["task insert", () => insertTask(a, "t2")],
        ["task update", () => a.prepare("UPDATE tasks SET impact = 9").run()],
        ["task delete", () => a.prepare("DELETE FROM tasks").run()],
        [
          "note insert",
          () =>
            a
              .prepare(
                "INSERT INTO task_notes (task_id, author, content, created_at) SELECT id, 'a', 'c', 'x' FROM tasks",
              )
              .run(),
        ],
      ];
      for (const [label, run] of attempts) {
        expect(run, label).toThrow(msg);
      }
      expect(a.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    },
  );

  it("does not abort at exactly 3.42.0", () => {
    withVersion(a, "3.42.0");
    expect(() => insertTask(a, "ok")).not.toThrow();
  });

  it("openDb throws SqliteTooOldError (exit 4) below 3.42 and touches nothing", () => {
    const fresh = join(dir, "old-sqlite.db");
    const realPrepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, "prepare");
    spy.mockImplementation(function (this: InstanceType<typeof Database>, sql: string) {
      if (/sqlite_version\(\)/.test(sql)) return realPrepare.call(this, "SELECT '3.41.2' AS v");
      return realPrepare.call(this, sql);
    } as typeof Database.prototype.prepare);
    try {
      let thrown: unknown;
      try {
        openDb({ path: fresh });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SqliteTooOldError);
      expect(classifyError(thrown as Error).exitCode).toBe(4);
    } finally {
      spy.mockRestore();
    }
    // The refusal came before any DDL: the file has no tables.
    const raw = new Database(fresh, { readonly: true });
    try {
      expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
    } finally {
      raw.close();
    }
  });
});

// ─── doctor ───────────────────────────────────────────────────────────

describe("doctor reports the capture state", () => {
  it("is ok on a healthy DB and names sqlite, capture version and checksum", () => {
    const c = captureDoctorCheck(a);
    expect(c.status).toBe("ok");
    expect(c.detail).toContain(`capture ${CAPTURE_VERSION}`);
    expect(c.detail).toContain("sqlite ");
    expect(c.detail).toContain(GENERATED_TRIGGER_CHECKSUM.slice(0, 12));
  });

  it("fails on a trigger edited behind mu's back", () => {
    a.exec("DROP TRIGGER _cap_tasks_upd");
    const c = captureDoctorCheck(a);
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/differ|checksum/);
  });

  it("fails when the SQLite in use is too old", () => {
    const c = captureDoctorCheck(a, "3.41.2");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("3.41.2");
  });
});
