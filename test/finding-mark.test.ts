// tasks.finding: the origin mark `task add --triage` sets. It is a captured,
// folded column, so a peer that gets the ops in any order, and a rebuild,
// reach the same mark and the same --if-ready answer.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Op } from "../src/apply.js";
import { type Db, openDb } from "../src/db.js";
import { rebuildInto } from "../src/rebuild.js";
import { applyIncomingOp } from "../src/segments.js";
import { acceptTask, addTask, closeTask, TaskRejectedBlockersError } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("finding mark", () => {
  let dir: string;
  let a: Db;
  const open = (n: string) => openDb({ path: join(dir, n) });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-finding-"));
    a = open("a.db");
  });
  afterEach(() => {
    a.close();
    rmFixtureDir(dir);
  });

  const mark = (db: Db) =>
    db.prepare("SELECT local_id AS id, finding FROM tasks ORDER BY local_id").all();
  const ifReady = (db: Db) => closeTask(db, "u", { workstream: "w", ifReady: true, evidence: "e" });

  // Same answer on every copy: a new umbrella over the rejected findings
  // closes, one over the rejected work task refuses.
  function peerVerdict(db: Db) {
    addTask(db, { localId: "v", workstream: "w", title: "v", blockedBy: ["f", "g"] });
    expect(closeTask(db, "v", { workstream: "w", ifReady: true, evidence: "e" })).toMatchObject({
      changed: true,
    });
    addTask(db, { localId: "x", workstream: "w", title: "x", blockedBy: ["k"] });
    closeTask(db, "k", { workstream: "w", as: "rejected", why: "no" });
    expect(() => closeTask(db, "x", { workstream: "w", ifReady: true, evidence: "e" })).toThrow(
      TaskRejectedBlockersError,
    );
  }

  function seed(db: Db) {
    ensureWorkstream(db, "w");
    addTask(db, { localId: "f", workstream: "w", title: "f", triage: true });
    addTask(db, { localId: "g", workstream: "w", title: "g", triage: true });
    addTask(db, { localId: "k", workstream: "w", title: "k" });
    addTask(db, { localId: "u", workstream: "w", title: "u", blockedBy: ["f", "g"] });
    acceptTask(db, "g", { workstream: "w" });
    closeTask(db, "f", { workstream: "w", as: "rejected", why: "false" });
    closeTask(db, "g", { workstream: "w", as: "rejected", why: "bad fix" });
  }

  it("--triage sets the mark; accept keeps it; plain add leaves 0", () => {
    seed(a);
    expect(mark(a)).toEqual([
      { id: "f", finding: 1 },
      { id: "g", finding: 1 },
      { id: "k", finding: 0 },
      { id: "u", finding: 0 },
    ]);
  });

  it("rejected findings (even accepted first) are decided; a rejected work blocker refuses", () => {
    seed(a);
    expect(ifReady(a)).toMatchObject({ changed: true });
    const w = open("w.db");
    ensureWorkstream(w, "w");
    addTask(w, { localId: "k", workstream: "w", title: "k" });
    addTask(w, { localId: "u", workstream: "w", title: "u", blockedBy: ["k"] });
    closeTask(w, "k", { workstream: "w", as: "rejected", why: "no" });
    expect(() => ifReady(w)).toThrow(TaskRejectedBlockersError);
    w.close();
  });

  it("a peer applying the ops in reverse, and a rebuild, agree with the origin", () => {
    seed(a);
    const ops = (
      a
        .prepare(
          `SELECT hlc, machine_id AS machineId, group_id AS groupId, actor, intent,
                  entity, key, op, payload FROM ops ORDER BY seq`,
        )
        .all() as Op[]
    ).reverse();
    const b = open("b.db");
    for (const o of ops) applyIncomingOp(b, o);
    expect(mark(b)).toEqual(mark(a));
    const target = join(dir, "rebuilt.db");
    rebuildInto(b, { targetPath: target });
    const r = openDb({ path: target });
    expect(mark(r)).toEqual(mark(a));
    peerVerdict(r);
    peerVerdict(b);
    r.close();
    b.close();
  });
});
