// wait_action_receipts (v_wait_release): the machine-local exclusion and journal
// of stall actions. Real SQLite files, two connections where it matters.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { type Db, EXPECTED_TABLES, MACHINE_LOCAL_TABLES, openDb } from "../src/db.js";
import { rebuildInto } from "../src/rebuild.js";
import {
  type ActionKey,
  getActionReceipt,
  reserveActionReceipt,
  transitionActionReceipt,
} from "../src/wait-action-receipts.js";
import { rmFixtureDir } from "./_fs.js";
import { mkTask } from "./_wait-fixtures.js";

let dir: string;
let path: string;
let db: Db;
const open: Db[] = [];
const track = (d: Db): Db => {
  open.push(d);
  return d;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-war-"));
  path = join(dir, "mu.db");
  db = track(openDb({ path }));
});
afterEach(() => {
  for (const d of open.splice(0)) {
    try {
      d.close();
    } catch {}
  }
  rmFixtureDir(dir);
});

const key = (over: Partial<ActionKey> = {}): ActionKey => ({
  taskId: 1,
  ownerId: 7,
  incarnation: "inc-1",
  action: "steer",
  ...over,
});
const info = (caller = "pi:a") => ({
  caller,
  taskRef: "w/t1",
  ownerRef: "w/w1",
  paneId: "%1",
  previewRevision: 3,
});

describe("storage shape", () => {
  it("is a machine-local table that no capture trigger or portable list touches", () => {
    expect(EXPECTED_TABLES).toContain("wait_action_receipts");
    expect(MACHINE_LOCAL_TABLES).toContain("wait_action_receipts");
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
        .all("wait_action_receipts"),
    ).toEqual([]);
    const before = db.prepare("SELECT COUNT(*) AS n FROM ops").get();
    reserveActionReceipt(db, key(), info());
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops").get()).toEqual(before);
  });

  it("has no foreign key: deleting the task or the owner leaves the exclusion", () => {
    mkTask(db, "t1");
    const a = insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: number }).id;
    expect(db.prepare("PRAGMA foreign_key_list(wait_action_receipts)").all()).toEqual([]);
    const k = key({ taskId: tid, ownerId: a.incarnation });
    reserveActionReceipt(db, k, info());
    deleteAgent(db, "w1", "w");
    db.prepare("DELETE FROM tasks WHERE id = ?").run(tid);
    expect(getActionReceipt(db, k)?.state).toBe("reserved");
  });

  it("a v13 file that lacks the table gains it on open: same version, rows elsewhere intact", () => {
    db.close();
    const r = new Database(path);
    r.exec("DROP TABLE wait_action_receipts");
    const v = r.prepare("SELECT version FROM schema_version").get();
    r.close();
    const again = track(openDb({ path }));
    expect(again.prepare("SELECT version FROM schema_version").get()).toEqual(v);
    reserveActionReceipt(again, key(), info());
    expect(getActionReceipt(again, key())?.state).toBe("reserved");
  });

  it("rebuild reports the rows it cannot restore", () => {
    reserveActionReceipt(db, key(), info());
    const report = rebuildInto(db, { targetPath: join(dir, "rebuilt.db") });
    expect(report.machineLocalLost).toEqual([{ table: "wait_action_receipts", rows: 1 }]);
  });
});

describe("reserve: one exclusion per task, owner, incarnation and action", () => {
  it("the first reservation creates; the same key again returns the SAME row, created false", () => {
    const a = reserveActionReceipt(db, key(), info("pi:a"));
    expect(a.created).toBe(true);
    expect(a.receipt).toMatchObject({
      taskId: 1,
      ownerId: 7,
      incarnation: "inc-1",
      action: "steer",
      caller: "pi:a",
      taskRef: "w/t1",
      ownerRef: "w/w1",
      paneId: "%1",
      previewRevision: 3,
      state: "reserved",
    });
    // Another caller, another generation, a newer revision: still the same exclusion.
    const b = reserveActionReceipt(db, key(), { ...info("w/boss"), previewRevision: 99 });
    expect(b.created).toBe(false);
    expect(b.receipt).toEqual(a.receipt);
  });

  it("a different incarnation, owner, task or action is a different exclusion", () => {
    expect(reserveActionReceipt(db, key(), info()).created).toBe(true);
    for (const over of [
      { incarnation: "inc-2" },
      { ownerId: 8 },
      { taskId: 2 },
      { action: "release" as const },
    ]) {
      expect(reserveActionReceipt(db, key(over), info()).created).toBe(true);
    }
  });

  it("two connections racing: exactly one wins", () => {
    const other = track(openDb({ path }));
    const r = [
      reserveActionReceipt(db, key(), info("a")),
      reserveActionReceipt(other, key(), info("b")),
    ];
    expect(r.map((x) => x.created).sort()).toEqual([false, true]);
    expect(r[0]?.receipt.caller).toBe(r[1]?.receipt.caller);
  });

  it("survives a reopen with its state", () => {
    reserveActionReceipt(db, key(), info());
    transitionActionReceipt(db, key(), "reserved", "sending", { msgId: "m1" });
    db.close();
    const again = track(openDb({ path }));
    expect(getActionReceipt(again, key())).toMatchObject({ state: "sending", msgId: "m1" });
    expect(reserveActionReceipt(again, key(), info()).created).toBe(false);
  });

  it("an empty incarnation (ctl named none) is a key of its own", () => {
    expect(reserveActionReceipt(db, key({ incarnation: "" }), info()).created).toBe(true);
    expect(reserveActionReceipt(db, key({ incarnation: "" }), info()).created).toBe(false);
  });
});

describe("transition: compare-and-set along the legal edges only", () => {
  it("reserved -> sending has exactly one winner, across connections", () => {
    reserveActionReceipt(db, key(), info());
    const other = track(openDb({ path }));
    expect(transitionActionReceipt(db, key(), "reserved", "sending", { msgId: "m" })).toBe(true);
    expect(transitionActionReceipt(other, key(), "reserved", "sending", { msgId: "m" })).toBe(
      false,
    );
    expect(getActionReceipt(db, key())?.state).toBe("sending");
  });

  it("sending resolves to sent or unknown, an unknown may be confirmed sent, a terminal state is final", () => {
    reserveActionReceipt(db, key(), info());
    transitionActionReceipt(db, key(), "reserved", "sending");
    expect(transitionActionReceipt(db, key(), "sending", "unknown", { detail: "crash" })).toBe(
      true,
    );
    expect(transitionActionReceipt(db, key(), "unknown", "sent", { runs: 4 })).toBe(true);
    expect(getActionReceipt(db, key())).toMatchObject({ state: "sent", runs: 4, detail: "crash" });
    expect(() => transitionActionReceipt(db, key(), "sent", "refused")).toThrow(/illegal/);
  });

  it("an illegal edge throws instead of rewriting history (sending is never un-sent)", () => {
    reserveActionReceipt(db, key(), info());
    transitionActionReceipt(db, key(), "reserved", "sending");
    expect(() => transitionActionReceipt(db, key(), "sending", "reserved")).toThrow(/illegal/);
    expect(() => transitionActionReceipt(db, key(), "sending", "refused")).toThrow(/illegal/);
    expect(getActionReceipt(db, key())?.state).toBe("sending");
  });

  it("a missing row is false, not a throw", () => {
    expect(transitionActionReceipt(db, key(), "reserved", "sending")).toBe(false);
  });
});
