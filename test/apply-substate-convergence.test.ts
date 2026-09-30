// Substate handling on the replay paths: apply (peer ops, rebuild) and
// undo. The contract under test is spec D8/D11: legacy statuses map onto
// pairs, status-only and unknown-substate ops fall back to the default,
// the deferred FK never fails the commit, and the SAME ops converge on
// the SAME row whatever order they arrive in.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Op } from "../src/apply.js";
import { type Db, openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { withOpContext } from "../src/op-context.js";
import { applyIncomingOp } from "../src/segments.js";
import { addTask } from "../src/tasks/edit.js";
import { setTaskStatus } from "../src/tasks/lifecycle.js";
import { listRecentGroups, undoGroup } from "../src/undo.js";
import { ensureWorkstream, teardownWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";
const PEER_B = "9f1c8a2e-0000-4000-8000-0000000000bb";
/** Ahead of the real clock, so peer ops beat locally-captured seeds. */
const FUTURE_BASE = 2_000_000_000_000;

let opSeq = 0;
function put(wall: number, payload: Record<string, unknown>, machineId = PEER): Op {
  return {
    hlc: formatHlc({ wallMs: FUTURE_BASE + wall, counter: 0, machineId }),
    machineId,
    groupId: `grp-${++opSeq}`,
    actor: "peer",
    intent: null,
    entity: "task",
    key: "demo/t",
    op: "put",
    payload: JSON.stringify(payload),
  };
}

describe("apply: substates", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-substate-apply-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(tempDir);
  });

  const pair = (d: Db = db) =>
    d.prepare("SELECT status, substate FROM tasks WHERE local_id = 't'").get() as
      | { status: string; substate: string }
      | undefined;

  const storedPayload = (op: Op): string =>
    (
      db
        .prepare("SELECT payload FROM ops WHERE machine_id = ? AND hlc = ?")
        .get(op.machineId, op.hlc) as { payload: string }
    ).payload;

  it("maps a legacy DEFERRED put onto OPEN/parked and records the payload unchanged", () => {
    const op = put(1000, { title: "T", status: "DEFERRED" });
    applyIncomingOp(db, op);
    expect(pair()).toEqual({ status: "OPEN", substate: "parked" });
    expect(storedPayload(op)).toContain('"DEFERRED"');
  });

  it("maps a legacy REJECTED put onto CLOSED/rejected", () => {
    applyIncomingOp(db, put(1000, { title: "T", status: "REJECTED" }));
    expect(pair()).toEqual({ status: "CLOSED", substate: "rejected" });
  });

  it("repairs a newer status-only put from a v10 peer to the default substate", () => {
    applyIncomingOp(db, put(1000, { title: "T", status: "CLOSED", substate: "wontfix" }));
    expect(() => applyIncomingOp(db, put(2000, { status: "OPEN" }))).not.toThrow();
    expect(pair()).toEqual({ status: "OPEN", substate: "todo" });
  });

  it("falls back to the default for a substate this build does not know", () => {
    const op = put(1000, { title: "T", status: "CLOSED", substate: "triage" });
    applyIncomingOp(db, op);
    expect(pair()).toEqual({ status: "CLOSED", substate: "done" });
    expect(storedPayload(op)).toContain('"triage"');
  });

  it("drops an unknown non-legacy status but applies the rest of the op", () => {
    applyIncomingOp(db, put(1000, { title: "T", status: "OPEN", substate: "parked" }));
    applyIncomingOp(db, put(2000, { title: "Renamed", status: "LIMBO" }));
    expect(pair()).toEqual({ status: "OPEN", substate: "parked" });
    const title = db.prepare("SELECT title FROM tasks WHERE local_id = 't'").get() as {
      title: string;
    };
    expect(title.title).toBe("Renamed");
  });

  it("converges on the same pair for every arrival order", () => {
    const ops = [
      put(1000, { title: "T", status: "OPEN", substate: "todo", impact: 50, effort_days: 1 }),
      put(2000, { status: "CLOSED", substate: "wontfix" }),
      put(3000, { status: "OPEN" }), // v10 peer, status-only
      put(4000, { status: "DEFERRED" }, PEER_B), // v9 peer, legacy
      put(4500, { status: "CLOSED", substate: "duplicate" }),
    ];
    const orders = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
      [3, 4, 0, 2, 1],
      [1, 3, 0, 4, 2],
    ];
    const results = orders.map((order, i) => {
      const peer = openDb({ path: join(tempDir, `order-${i}.db`) });
      try {
        for (const idx of order) {
          const op = ops[idx];
          if (!op) throw new Error("bad index");
          applyIncomingOp(peer, op);
        }
        return pair(peer);
      } finally {
        peer.close();
      }
    });
    for (const r of results) expect(r).toEqual({ status: "CLOSED", substate: "duplicate" });

    // A cross-field conflict: the newest status and the newest substate
    // come from different ops, and the substate is illegal for the status.
    const conflict = [
      put(1000, { title: "T", status: "OPEN", substate: "parked" }),
      put(2000, { status: "CLOSED" }, PEER_B),
      put(3000, { substate: "parked" }),
      put(4000, { status: "OPEN" }, PEER_B),
    ];
    const conflictOrders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [0, 2, 1, 3],
      [0, 3, 1, 2],
    ];
    const conflictResults = conflictOrders.map((order, i) => {
      const peer = openDb({ path: join(tempDir, `conflict-${i}.db`) });
      try {
        for (const idx of order) {
          const op = conflict[idx];
          if (!op) throw new Error("bad index");
          applyIncomingOp(peer, op);
        }
        return pair(peer);
      } finally {
        peer.close();
      }
    });
    // Status OPEN (4000) and substate todo (the default written by the
    // status-only op at 4000, which is newer than parked at 3000).
    for (const r of conflictResults) expect(r).toEqual({ status: "OPEN", substate: "todo" });
  });
});

describe("undo: substates", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-substate-undo-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(tempDir);
  });

  const pair = (localId: string) =>
    db.prepare("SELECT status, substate FROM tasks WHERE local_id = ?").get(localId) as
      | { status: string; substate: string }
      | undefined;

  const groupFor = (intent: string): string => {
    const group = listRecentGroups(db, 50).find((g) => g.intents.includes(intent));
    if (group === undefined) throw new Error(`no group with intent ${intent}`);
    return group.groupId;
  };

  const setSubstate = (localId: string, substate: string, intent: string): void => {
    withOpContext(db, { intent, group: "new" }, () => {
      db.prepare("UPDATE tasks SET substate = ? WHERE local_id = ?").run(substate, localId);
    });
  };

  it("restores non-default pairs when a teardown is undone, and undoes a park", async () => {
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: "a", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { workstream: "demo", localId: "b", title: "B", impact: 50, effortDays: 1 });
    setSubstate("a", "parked", "test.park");
    setTaskStatus(db, "b", "CLOSED", { workstream: "demo" });
    setSubstate("b", "wontfix", "test.wontfix");

    await teardownWorkstream(db, { workstream: "demo", muxSession: "mu-absent-for-test" });
    expect(pair("a")).toBeUndefined();
    undoGroup(db, groupFor("workstream.teardown"));
    expect(pair("a")).toEqual({ status: "OPEN", substate: "parked" });
    expect(pair("b")).toEqual({ status: "CLOSED", substate: "wontfix" });

    undoGroup(db, groupFor("test.park"), { force: true });
    expect(pair("a")).toEqual({ status: "OPEN", substate: "todo" });
  });

  it("restores a tombstoned legacy DEFERRED task as OPEN/parked", async () => {
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: "a", title: "A", impact: 50, effortDays: 1 });
    // History written by a v9 build: the create op carries DEFERRED and
    // predates substates entirely.
    db.prepare(
      `UPDATE ops SET payload = json_remove(json_set(payload, '$.status', 'DEFERRED'), '$.substate')
        WHERE entity = 'task' AND op = 'put'`,
    ).run();
    await teardownWorkstream(db, { workstream: "demo", muxSession: "mu-absent-for-test" });

    undoGroup(db, groupFor("workstream.teardown"));
    expect(pair("a")).toEqual({ status: "OPEN", substate: "parked" });
  });
});
