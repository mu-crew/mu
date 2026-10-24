// The sync contract (docs/mu-next/README.md § Sync contract), end to end.
//
//   1. Every verb ingests peer ops before and flushes its own after,
//      including `mu sql` and including when the verb throws.
//   2. A DB inside MU_SYNC_DIR is a hard refusal, before anything is
//      opened or written.
//   3. A task put older than its workstream's delete cannot resurrect the
//      parent (live apply and rebuild agree).
//
// Fast tier: in-process runCli, per-test temp DBs and sync dir.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../src/apply.js";
import { handle } from "../src/cli/handle.js";
import { openDb } from "../src/db.js";
import { checkDrift } from "../src/drift.js";
import { formatHlc } from "../src/hlc.js";
import { applyIncomingOp } from "../src/segments.js";
import { addTask } from "../src/tasks.js";
import { rmFixtureDir } from "./_fs.js";
import { readRows } from "./_ro.js";
import { runCli } from "./_runCli.js";

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
    const r = await runCli(["sql", "SELECT local_id FROM tasks", "--json"], dev);
    expect(r.exitCode, r.stderr).toBeNull();
    expect(JSON.parse(r.stdout)).toEqual([{ local_id: "t1" }]);
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
  ): Op => ({
    hlc: formatHlc({ wallMs: BASE + wall, counter: 0, machineId }),
    machineId,
    groupId: `g-${++seq}`,
    actor: "peer",
    intent: null,
    entity,
    key,
    op: kind,
    payload: kind === "put" ? JSON.stringify(putPayload(entity)) : "{}",
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
      // No drift assertion: the re-created parent's created_at is stamped
      // locally (it is in no op), so live and rebuild legitimately differ.
      expect(db.prepare("SELECT local_id FROM tasks").all()).toEqual([{ local_id: "a" }]);
      expect(db.prepare("SELECT name FROM workstreams").all()).toEqual([{ name: "w" }]);
    } finally {
      db.close();
    }
  });
});
