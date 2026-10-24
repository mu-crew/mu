// The sync contract (docs/mu-next/README.md § Sync contract), end to end.
//
//   1. Every verb ingests peer ops before and flushes its own after,
//      including `mu sql` and including when the verb throws.
//   2. A DB inside MU_SYNC_DIR is a hard refusal, before anything is
//      opened or written.
//   3. A task put older than its workstream's delete cannot resurrect the
//      parent (live apply and rebuild agree).
//   4. Apply is order-independent: every arrival order of one op set gives
//      the same rows as an HLC-order rebuild.
//   5. A busy segment lock is reported, never silent; `mu doctor` counts
//      the unpublished ops.
//   6. The DB-inside-MU_SYNC_DIR refusal sees through symlinks and covers
//      `mu pi migrate`.
//
// Fast tier: in-process runCli, per-test temp DBs and sync dir.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Statement } from "better-sqlite3";
import { Command } from "commander";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../src/apply.js";
import { handle } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import { checkDrift } from "../src/drift.js";
import { checkUnpublishedOps } from "../src/fleet-hazards.js";
import { formatHlc } from "../src/hlc.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { applyIncomingOp, flushSegment, localMachineId } from "../src/segments.js";
import { ambientFlush } from "../src/sync.js";
import { addTask } from "../src/tasks.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { readRows } from "./_ro.js";
import { runCli, runCliJson } from "./_runCli.js";

const SYNC_KEY = "MU_SYNC_DIR";
const DB_KEY = "MU_DB_PATH";

let tempDir: string;
let syncDir: string;
let lap: string;
let dev: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-sync-contract-"));
  syncDir = join(tempDir, "shared");
  mkdirSync(syncDir, { recursive: true });
  lap = join(tempDir, "lap.db");
  dev = join(tempDir, "dev.db");
  process.env[SYNC_KEY] = syncDir;
});

afterEach(() => {
  delete process.env[SYNC_KEY];
  delete process.env[DB_KEY];
  vi.restoreAllMocks();
  rmFixtureDir(tempDir);
});

const segments = (): string[] => readdirSync(syncDir).filter((f) => f.endsWith(".jsonl"));
const allSegmentText = (): string =>
  segments()
    .map((f) => readFileSync(join(syncDir, f), "utf8"))
    .join("\n");

const seed = async (db: string): Promise<void> => {
  await runCli(["workstream", "init", "demo"], db);
  await runCli(["task", "add", "t1", "-t", "T1", "-i", "50", "-e", "1", "-w", "demo"], db);
};

describe("mu sql follows the ambient contract", () => {
  it("a write flushes its op into this machine's segment", async () => {
    await seed(lap);
    expect(allSegmentText()).not.toContain("SQL-WRITTEN");

    const r = await runCli(
      ["sql", "UPDATE tasks SET title = 'SQL-WRITTEN' WHERE local_id = 't1'"],
      lap,
    );
    expect(r.exitCode, r.stderr).toBeNull();
    expect(allSegmentText()).toContain("SQL-WRITTEN");
  });

  it("a read ingests peer ops BEFORE the query", async () => {
    await seed(lap);
    // dev has never heard of lap's task; one `mu sql` read must see it.
    const r = await runCliJson(["sql", "SELECT local_id FROM tasks", "--json"], dev);
    expect(r.exitCode, r.stderr).toBeNull();
    expect(r.data).toEqual([{ local_id: "t1" }]);
  });

  it("a script that throws rolls back whole and leaves no op in the segment", async () => {
    await seed(lap);
    // Two statements in one script: the first is captured, the second
    // fails. The script is one transaction, so nothing may leak out (and
    // the flush on the error path must not invent anything either).
    const r = await runCli(
      ["sql", "UPDATE tasks SET title = 'HALF'; SELECT * FROM no_such_table"],
      lap,
    );
    expect(r.exitCode).not.toBeNull();
    expect(allSegmentText()).not.toContain("HALF");
    expect(readRows<{ title: string }>(lap, "SELECT title FROM tasks")[0]?.title).toBe("T1");
  });
});

describe("handle() flushes on the error path", () => {
  it("ops committed by a verb that then throws reach the segment", async () => {
    process.env[DB_KEY] = lap;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await handle(async (db) => {
      addTask(db, {
        localId: "wrote-then-threw",
        workstream: "demo",
        title: "W",
        impact: 50,
        effortDays: 1,
      });
      throw new Error("boom after commit");
    }, new Command())();
    expect(exit).toHaveBeenCalledWith(1);
    expect(allSegmentText()).toContain("wrote-then-threw");
  });
});

describe("a DB inside MU_SYNC_DIR is refused before anything is written", () => {
  const verbs: string[][] = [
    ["task", "list", "-w", "demo"],
    ["sql", "SELECT 1"],
    ["sync"],
    ["doctor"],
  ];
  for (const argv of verbs) {
    it(`mu ${argv[0]}: exit 4, no DB file, no segment`, async () => {
      const inside = join(syncDir, "nested", "mu.db");
      const r = await runCli(argv, inside);
      expect(r.exitCode, r.stderr).toBe(4);
      expect(r.stderr).toContain(`DB ${inside} is inside MU_SYNC_DIR ${syncDir}`);
      expect(r.stderr).toContain("move it out (WAL files do not sync safely)");
      expect(existsSync(inside)).toBe(false);
      expect(existsSync(join(syncDir, "nested"))).toBe(false);
      expect(segments()).toEqual([]);
    });
  }

  it("blank or unset MU_SYNC_DIR means no check", async () => {
    process.env[SYNC_KEY] = "  ";
    const r = await runCli(["sql", "SELECT 1"], join(syncDir, "mu.db"));
    expect(r.exitCode, r.stderr).toBeNull();
  });
});

describe("a task put older than its workstream delete does not resurrect the parent", () => {
  const A = "9f1c8a2e-0000-4000-8000-0000000000aa";
  const B = "9f1c8a2e-0000-4000-8000-0000000000bb";
  const BASE = 2_000_000_000_000;
  let seq = 0;
  // Real puts carry their timestamps; without them live and rebuild would
  // each stamp their own now() and drift for an unrelated reason.
  const STAMP = "2033-05-18T03:33:20.000Z";
  const putPayload = (entity: "workstream" | "task") =>
    entity === "workstream"
      ? { created_at: STAMP }
      : { title: "T", created_at: STAMP, updated_at: STAMP };
  const op = (
    wall: number,
    entity: "workstream" | "task",
    kind: "put" | "del",
    key: string,
    machineId = A,
    payload?: Record<string, unknown>,
  ): Op => ({
    hlc: formatHlc({ wallMs: BASE + wall, counter: 0, machineId }),
    machineId,
    groupId: `g-${++seq}`,
    actor: "peer",
    intent: null,
    entity,
    key,
    op: kind,
    payload: kind === "put" ? JSON.stringify(payload ?? putPayload(entity)) : "{}",
  });

  const apply = (ops: Op[]) => {
    const db = openDb({ path: join(tempDir, `apply-${++seq}.db`) });
    for (const o of ops) applyIncomingOp(db, o);
    return db;
  };

  it("[ws del h3, task put h2, task del h4] leaves live == rebuild", () => {
    const wsPut = op(1, "workstream", "put", "w");
    const taskPut = op(2, "task", "put", "w/a", B);
    const wsDel = op(3, "workstream", "del", "w");
    const taskDel = op(4, "task", "del", "w/a", B);
    const db = apply([wsPut, wsDel, taskPut, taskDel]);
    try {
      expect(db.prepare("SELECT name FROM workstreams").all()).toEqual([]);
      expect(checkDrift(db).clean).toBe(true);
    } finally {
      db.close();
    }
  });

  it("[ws put, ws del, ws put (undo), task put older than the del] leaves no task", () => {
    const db = apply([
      op(1, "workstream", "put", "w"),
      op(3, "workstream", "del", "w"),
      op(5, "workstream", "put", "w"),
      op(2, "task", "put", "w/a", B),
    ]);
    try {
      expect(db.prepare("SELECT local_id FROM tasks").all()).toEqual([]);
      expect(checkDrift(db).clean).toBe(true);
    } finally {
      db.close();
    }
  });

  it("a task put NEWER than the workstream delete still resurrects it", () => {
    const db = apply([
      op(1, "workstream", "put", "w"),
      op(3, "workstream", "del", "w"),
      op(4, "task", "put", "w/a", B),
    ]);
    try {
      // The re-created parent's created_at comes from the log, not the local
      // clock, so live and rebuild agree.
      expect(checkDrift(db).clean).toBe(true);
      expect(db.prepare("SELECT local_id FROM tasks").all()).toEqual([{ local_id: "a" }]);
      expect(db.prepare("SELECT name FROM workstreams").all()).toEqual([{ name: "w" }]);
    } finally {
      db.close();
    }
  });
});

// ─── (1) order-independent apply ──────────────────────────────────────

describe("apply is order-independent: live == rebuild for EVERY arrival order", () => {
  const A = "9f1c8a2e-0000-4000-8000-0000000000aa";
  const B = "9f1c8a2e-0000-4000-8000-0000000000bb";
  const BASE = 2_000_000_000_000;
  const STAMP = "2033-05-18T03:33:20.000Z";
  let seq = 0;
  const op = (
    wall: number,
    entity: "workstream" | "task",
    kind: "put" | "del",
    key: string,
    machineId: string,
    payload: Record<string, unknown> = { created_at: STAMP, updated_at: STAMP, title: "T" },
  ): Op => ({
    hlc: formatHlc({ wallMs: BASE + wall, counter: 0, machineId }),
    machineId,
    groupId: `g-${++seq}`,
    actor: "peer",
    intent: null,
    entity,
    key,
    op: kind,
    payload: kind === "put" ? JSON.stringify(payload) : "{}",
  });

  const permutations = <T>(xs: readonly T[]): T[][] =>
    xs.length <= 1
      ? [[...xs]]
      : xs.flatMap((x, i) =>
          permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
        );

  // One DB for the whole file, emptied between arrival orders: a fresh openDb
  // per order cost ~45ms x ~700 orders. Capture is suppressed for the wipe, as
  // in test/apply-fold.test.ts, so the log holds only the order under test.
  let permDb: Db | undefined;
  let permDir: string | undefined;
  let permWipe: Statement[] | undefined;
  afterAll(() => {
    permDb?.close();
    if (permDir) rmFixtureDir(permDir);
  });
  const stateOf = (ops: Op[]) => {
    if (!permDb) {
      permDir = mkdtempSync(join(tmpdir(), "mu-sync-contract-perm-"));
      permDb = openDb({ path: join(permDir, "perm.db") });
    }
    const db = permDb;
    // better-sqlite3 caches nothing: db.prepare recompiles the cascade (~3ms).
    permWipe ??= [db.prepare("DELETE FROM workstreams"), db.prepare("DELETE FROM ops")];
    const wipe = permWipe;
    withCaptureSuppressed(db, () => {
      for (const st of wipe) st.run();
    });
    for (const o of ops) applyIncomingOp(db, o);
    const drift = checkDrift(db);
    return {
      clean: drift.clean,
      drift: drift.records,
      workstreams: db.prepare("SELECT name, created_at FROM workstreams ORDER BY name").all(),
      tasks: db
        .prepare(
          `SELECT w.name AS ws, t.local_id, t.title, t.impact FROM tasks t
             JOIN workstreams w ON w.id = t.workstream_id ORDER BY 1, 2`,
        )
        .all(),
    };
  };

  const sets: Record<string, { ops: Op[]; tasks: unknown[]; workstreams: number }> = {
    "restore: ws put, task put, ws del, ws put (the refuter's four ops)": {
      ops: [
        op(1, "workstream", "put", "w", A, { created_at: STAMP }),
        op(2, "task", "put", "w/a", B),
        op(3, "workstream", "del", "w", A),
        op(5, "workstream", "put", "w", B, { created_at: STAMP }),
      ],
      tasks: [],
      workstreams: 1,
    },
    "fold-in: ws put, task put, ws del, task del": {
      ops: [
        op(1, "workstream", "put", "w", A, { created_at: STAMP }),
        op(2, "task", "put", "w/a", B),
        op(3, "workstream", "del", "w", A),
        op(4, "task", "del", "w/a", B),
      ],
      tasks: [],
      workstreams: 0,
    },
    "task del between two puts: only the newer put's fields survive": {
      ops: [
        op(1, "workstream", "put", "w", A, { created_at: STAMP }),
        op(2, "task", "put", "w/a", B, {
          title: "X",
          impact: 70,
          created_at: STAMP,
          updated_at: STAMP,
        }),
        op(3, "task", "del", "w/a", A),
        op(4, "task", "put", "w/a", B, { impact: 80, created_at: STAMP, updated_at: STAMP }),
      ],
      tasks: [{ ws: "w", local_id: "a", title: "a", impact: 80 }],
      workstreams: 1,
    },
    "older task put from the first life does not leak into the restored workstream": {
      ops: [
        op(1, "workstream", "put", "w", A, { created_at: STAMP }),
        op(2, "task", "put", "w/a", B, {
          title: "old",
          impact: 70,
          created_at: STAMP,
          updated_at: STAMP,
        }),
        op(3, "workstream", "del", "w", A),
        op(4, "workstream", "put", "w", A, { created_at: STAMP }),
        op(5, "task", "put", "w/a", B, { impact: 80, created_at: STAMP, updated_at: STAMP }),
      ],
      tasks: [{ ws: "w", local_id: "a", title: "a", impact: 80 }],
      workstreams: 1,
    },
  };

  for (const [name, set] of Object.entries(sets)) {
    it(`${name}: every order agrees with rebuild and with each other`, () => {
      const orders = permutations(set.ops);
      expect(orders).toHaveLength(set.ops.length === 4 ? 24 : 120);
      const bad: string[] = [];
      let first: unknown;
      for (const order of orders) {
        const label = order
          .map((o) => `${o.entity[0]}${o.op[0]}${Number(o.hlc.slice(0, 13)) - BASE}`)
          .join(" ");
        const s = stateOf(order);
        if (!s.clean) bad.push(`${label}: drift ${JSON.stringify(s.drift)}`);
        const view = { workstreams: s.workstreams, tasks: s.tasks };
        first ??= view;
        if (JSON.stringify(view) !== JSON.stringify(first)) {
          bad.push(`${label}: ${JSON.stringify(view)} != ${JSON.stringify(first)}`);
        }
      }
      expect(bad).toEqual([]);
      const view = first as { workstreams: unknown[]; tasks: unknown[] };
      expect(view.tasks).toEqual(set.tasks);
      expect(view.workstreams).toHaveLength(set.workstreams);
    });
  }
});

// ─── (2) a busy segment lock is reported ──────────────────────────────

describe("a busy segment lock is never silent", () => {
  const holdSegmentLock = (stateDir: string, db: ReturnType<typeof openDb>): void => {
    const lockName = createHash("sha256")
      .update(`${syncDir}\u001f${localMachineId(db)}`)
      .digest("hex")
      .slice(0, 16);
    const lockPath = join(stateDir, "locks", `segment-${lockName}.lock`);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "meta.json"),
      JSON.stringify({ pid: process.pid + 1, label: "other", acquiredAt: "" }),
    );
  };

  it("ambientFlush says the ops publish on the next flush, and still returns lockBusy", async () => {
    const db = openDb({ path: lap });
    try {
      addTask(db, { localId: "p", workstream: "demo", title: "P", impact: 50, effortDays: 1 });
      const stateDir = join(tempDir, "state");
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        holdSegmentLock(stateDir, db);
        const r = await ambientFlush(db, { lockWaitMs: 0 });
        expect(r?.lockBusy).toBe(true);
      });
      const written = err.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain(
        "sync: segment locked by another mu; this op publishes on the next flush",
      );
    } finally {
      db.close();
    }
  });

  it("quiet callers (the TUI tick) stay quiet", async () => {
    const db = openDb({ path: lap });
    try {
      addTask(db, { localId: "p", workstream: "demo", title: "P", impact: 50, effortDays: 1 });
      const stateDir = join(tempDir, "state");
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        holdSegmentLock(stateDir, db);
        await ambientFlush(db, { lockWaitMs: 0, quiet: true });
      });
      expect(err).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("mu doctor's unpublished-ops check counts ops missing from the own segment", async () => {
    const db = openDb({ path: lap });
    try {
      addTask(db, { localId: "p", workstream: "demo", title: "P", impact: 50, effortDays: 1 });
      expect(checkUnpublishedOps(db, undefined).severity).toBe("ok");
      const pending = checkUnpublishedOps(db, syncDir);
      expect(pending.severity).toBe("warn");
      expect(pending.name).toBe("unpublished-ops");
      expect(pending.detail).toMatch(/\d+ own op/);
      await flushSegment(db, syncDir);
      expect(checkUnpublishedOps(db, syncDir).severity).toBe("ok");
    } finally {
      db.close();
    }
  });
});

// ─── (3) the refusal sees through symlinks ────────────────────────────

describe("the DB-inside-MU_SYNC_DIR refusal canonicalises both sides", () => {
  const refused = async (db: string): Promise<void> => {
    const r = await runCli(["sql", "SELECT 1"], db);
    expect(r.exitCode, r.stderr).toBe(4);
    expect(r.stderr).toContain("is inside MU_SYNC_DIR");
    expect(existsSync(join(syncDir, "mu.db"))).toBe(false);
    expect(segments()).toEqual([]);
  };

  it("a symlinked DB directory that points into the sync dir", async () => {
    symlinkSync(syncDir, join(tempDir, "outside"));
    await refused(join(tempDir, "outside", "mu.db"));
  });

  it("a symlinked MU_SYNC_DIR (the DB path is the real one)", async () => {
    const link = join(tempDir, "link");
    symlinkSync(syncDir, link);
    process.env[SYNC_KEY] = link;
    await refused(join(syncDir, "mu.db"));
  });

  it("a not-yet-existing subdirectory below a symlinked parent", async () => {
    symlinkSync(syncDir, join(tempDir, "outside"));
    await refused(join(tempDir, "outside", "fresh", "mu.db"));
    expect(existsSync(join(syncDir, "fresh"))).toBe(false);
  });

  it("an existing DB file that is itself a symlink into the sync dir", async () => {
    mkdirSync(join(tempDir, "local"));
    const target = join(syncDir, "mu.db");
    writeFileSync(target, "");
    symlinkSync(target, join(tempDir, "local", "mu.db"));
    const r = await runCli(["sql", "SELECT 1"], join(tempDir, "local", "mu.db"));
    expect(r.exitCode, r.stderr).toBe(4);
    expect(lstatSync(target).size).toBe(0);
  });

  it("a dangling symlink whose target would be created inside the sync dir", async () => {
    mkdirSync(join(tempDir, "local"));
    symlinkSync(join(syncDir, "mu.db"), join(tempDir, "local", "mu.db"));
    const r = await runCli(["sql", "SELECT 1"], join(tempDir, "local", "mu.db"));
    expect(r.exitCode, r.stderr).toBe(4);
    expect(existsSync(join(syncDir, "mu.db"))).toBe(false);
  });

  it("a symlinked directory that points elsewhere is not refused", async () => {
    const elsewhere = join(tempDir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(tempDir, "alias"));
    const r = await runCli(["sql", "SELECT 1"], join(tempDir, "alias", "mu.db"));
    expect(r.exitCode, r.stderr).toBeNull();
  });
});

// ─── (4) mu pi migrate sits behind the same refusal ───────────────────

describe("mu pi migrate refuses a DB inside MU_SYNC_DIR", () => {
  const shim = () => join(tempDir, "pihome", ".pi", "agent", "extensions", "mu.ts");
  function seedShim(): void {
    mkdirSync(join(tempDir, "pihome", ".pi", "agent", "extensions"), { recursive: true });
    // The real template a released `mu link pi` wrote.
    writeFileSync(shim(), readFileSync(join(import.meta.dirname, "fixtures", "link-shim-v3.txt")));
  }

  it("exit 4, and nothing is moved", async () => {
    seedShim();
    await withEnv("MU_PI_HOME", join(tempDir, "pihome"), async () => {
      const r = await runCli(["pi", "migrate", "--apply"], join(syncDir, "mu.db"));
      expect(r.exitCode, r.stderr).toBe(4);
      expect(r.stderr).toContain("is inside MU_SYNC_DIR");
      expect(existsSync(shim())).toBe(true);
    });
  });

  it("still migrates when the DB is outside, and opens no DB", async () => {
    seedShim();
    await withEnv("MU_PI_HOME", join(tempDir, "pihome"), async () => {
      const r = await runCli(["pi", "migrate", "--apply"], lap);
      expect(r.exitCode, r.stderr).toBeNull();
      expect(existsSync(shim())).toBe(false);
      expect(existsSync(lap)).toBe(false);
    });
  });
});
