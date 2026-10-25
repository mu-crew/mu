// applySettledClose: a settled pi run's CLOSE block, applied once, owned
// task only, report + close in one op group. Real SQLite, no mux.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import {
  applySettledClose,
  CLOSE_MALFORMED,
  CLOSE_TRUNCATED,
  type SettledCloseInput,
} from "../src/close-block.js";
import { type Db, openDb } from "../src/db.js";
import { claimTask } from "../src/tasks/claim.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { closeTask, getTask, listNotes, openTask, TaskHasOpenBlockersError } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

const block = (task: string, ev = "npm test: 3 passed", report = "FILES: a.ts\nDONE") =>
  `Finished.\n\nCLOSE: task=${task} evidence="${ev}"\nREPORT:\n${report}`;

const agentId = (name: string, ws = "w"): number =>
  (
    db
      .prepare(
        "SELECT a.id FROM agents a JOIN workstreams s ON s.id = a.workstream_id WHERE a.name = ? AND s.name = ?",
      )
      .get(name, ws) as { id: number }
  ).id;

function input(over: Partial<SettledCloseInput> & { lastText: string }): SettledCloseInput {
  return {
    workstream: "w",
    agent: "w1",
    agentId: agentId("w1"),
    incarnation: "inc-1",
    runs: 1,
    settled: true,
    ...over,
  };
}

const kinds = (id: string, ws = "w") =>
  listNotes(db, id, ws).map((n) => ({ kind: n.kind, content: n.content }));
const settles = () =>
  db.prepare("SELECT agent_id, incarnation, runs, task_id FROM agent_settles").all();
const opCount = () => (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mu-close-apply-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "w");
  ensureWorkstream(db, "other");
  addTask(db, { workstream: "w", localId: "t1", title: "t1" });
  addTask(db, { workstream: "w", localId: "t2", title: "t2" });
  insertAgent(db, { name: "w1", workstream: "w", paneId: "%1" });
  insertAgent(db, { name: "w2", workstream: "w", paneId: "%2" });
  await claimTask(db, "t1", { workstream: "w", agentName: "w1" });
  await claimTask(db, "t2", { workstream: "w", agentName: "w2" });
});
afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

describe("applySettledClose: the close", () => {
  it("closes the owned task: report, close note, status in ONE op group, notes first", () => {
    const r = applySettledClose(db, input({ lastText: block("t1") }));
    expect(r).toEqual({ applied: true, task: "t1", reason: "closed" });
    expect(getTask(db, "t1", "w")).toMatchObject({ status: "CLOSED", substate: "done" });
    expect(kinds("t1")).toEqual([
      { kind: "report", content: "FILES: a.ts\nDONE" },
      { kind: "close", content: "CLOSE: npm test: 3 passed" },
    ]);
    const rows = db
      .prepare(
        "SELECT entity, group_id, actor, intent FROM ops WHERE intent = 'close.apply' ORDER BY seq",
      )
      .all() as { entity: string; group_id: string; actor: string }[];
    expect(rows.map((x) => x.entity)).toEqual(["note", "note", "task"]);
    expect(new Set(rows.map((x) => x.group_id)).size).toBe(1);
    expect(rows[0]?.actor).toBe("w1");
    expect(settles()).toEqual([
      { agent_id: agentId("w1"), incarnation: "inc-1", runs: 1, task_id: expect.any(Number) },
    ]);
  });

  it("a second apply of the same (agent, incarnation, runs) is a no-op, even after a reopen", () => {
    applySettledClose(db, input({ lastText: block("t1") }));
    openTask(db, "t1", { workstream: "w" });
    const before = opCount();
    expect(applySettledClose(db, input({ lastText: block("t1") }))).toMatchObject({
      applied: false,
      reason: "already applied",
    });
    expect(opCount()).toBe(before);
    expect(getTask(db, "t1", "w")?.status).toBe("OPEN");
  });

  it("a later run (or new incarnation) after a reopen closes again", () => {
    applySettledClose(db, input({ lastText: block("t1", "first") }));
    openTask(db, "t1", { workstream: "w" });
    expect(
      applySettledClose(db, input({ runs: 2, lastText: block("t1", "second") })),
    ).toMatchObject({
      applied: true,
    });
    openTask(db, "t1", { workstream: "w" });
    expect(
      applySettledClose(
        db,
        input({ incarnation: "inc-2", runs: 1, lastText: block("t1", "third") }),
      ),
    ).toMatchObject({ applied: true });
    expect(settles()).toHaveLength(3);
  });

  it("an already CLOSED task is ignored: no notes, replay recorded", () => {
    applySettledClose(db, input({ lastText: block("t1") }));
    const before = kinds("t1");
    expect(applySettledClose(db, input({ runs: 2, lastText: block("t1", "again") }))).toMatchObject(
      {
        applied: false,
        task: "t1",
        reason: "task already closed",
      },
    );
    expect(kinds("t1")).toEqual(before);
    expect(settles()).toHaveLength(2);
  });
});

describe("applySettledClose: ownership", () => {
  it("refuses a task owned by another agent, writes nothing to it", () => {
    const r = applySettledClose(db, input({ lastText: block("t2") }));
    expect(r).toMatchObject({
      applied: false,
      task: "t2",
      reason: "task is not owned by this agent",
    });
    expect(getTask(db, "t2", "w")?.status).toBe("IN_PROGRESS");
    expect(kinds("t2")).toEqual([]);
  });

  it("refuses an unowned task and a task that does not exist", () => {
    addTask(db, { workstream: "w", localId: "t3", title: "t3" });
    expect(applySettledClose(db, input({ lastText: block("t3") }))).toMatchObject({
      applied: false,
    });
    expect(applySettledClose(db, input({ runs: 2, lastText: block("nope") }))).toMatchObject({
      applied: false,
      reason: "task is not owned by this agent",
    });
    expect(getTask(db, "t3", "w")?.status).toBe("OPEN");
  });

  it("a same-named agent in another workstream does not own w's task", async () => {
    insertAgent(db, { name: "w1", workstream: "other", paneId: "%9" });
    const impostor = agentId("w1", "other");
    const r = applySettledClose(
      db,
      input({ workstream: "other", agent: "w1", agentId: impostor, lastText: block("t1") }),
    );
    expect(r).toMatchObject({ applied: false });
    expect(getTask(db, "t1", "w")?.status).toBe("IN_PROGRESS");
    // And the real agent id under the wrong workstream/name pair is unknown.
    expect(
      applySettledClose(db, input({ workstream: "other", lastText: block("t1") })),
    ).toMatchObject({ applied: false, reason: "unknown agent" });
  });

  it("a deleted and recreated agent has a new id: the old id owns nothing and cannot apply", () => {
    const oldId = agentId("w1");
    deleteAgent(db, "w1", "w");
    insertAgent(db, { name: "w1", workstream: "w", paneId: "%5" });
    expect(agentId("w1")).not.toBe(oldId);
    expect(applySettledClose(db, input({ agentId: oldId, lastText: block("t1") }))).toMatchObject({
      applied: false,
      reason: "unknown agent",
    });
  });

  it("an agent that owns the task from another workstream is matched by id, not name", async () => {
    insertAgent(db, { name: "x1", workstream: "other", paneId: "%8" });
    addTask(db, { workstream: "w", localId: "t4", title: "t4" });
    await claimTask(db, "t4", { workstream: "w", agentName: "x1", agentWorkstream: "other" });
    const r = applySettledClose(
      db,
      input({
        workstream: "other",
        agent: "x1",
        agentId: agentId("x1", "other"),
        lastText: block("t4"),
      }),
    );
    // Task lookup is in the agent's workstream: t4 lives in w, so no close.
    expect(r).toMatchObject({ applied: false });
    expect(getTask(db, "t4", "w")?.status).toBe("IN_PROGRESS");
  });

  it("a non-pi agent is never closed from text", () => {
    db.prepare("UPDATE agents SET cli = 'claude' WHERE name = 'w1'").run();
    expect(applySettledClose(db, input({ lastText: block("t1") }))).toMatchObject({
      applied: false,
      reason: "not a pi agent",
    });
    expect(settles()).toEqual([]);
  });
});

describe("applySettledClose: no inferred close", () => {
  it("unsettled (blocked/unknown) and errored runs write nothing, not even a replay row", () => {
    const before = opCount();
    expect(applySettledClose(db, input({ settled: false, lastText: block("t1") }))).toMatchObject({
      applied: false,
    });
    expect(
      applySettledClose(db, input({ lastError: "529 overloaded", lastText: block("t1") })),
    ).toMatchObject({ applied: false });
    expect(opCount()).toBe(before);
    expect(settles()).toEqual([]);
    expect(getTask(db, "t1", "w")?.status).toBe("IN_PROGRESS");
  });

  it("prose with no block writes nothing and may be retried", () => {
    const before = opCount();
    expect(applySettledClose(db, input({ lastText: "all done" }))).toMatchObject({
      applied: false,
      reason: "no CLOSE block",
    });
    expect(opCount()).toBe(before);
    expect(settles()).toEqual([]);
  });

  it("a malformed final block writes 'no close (malformed)' ONCE, closes nothing", () => {
    const text = 'CLOSE: task=t1 evidence="a "quoted" word"\nREPORT:\nr';
    expect(applySettledClose(db, input({ lastText: text }))).toMatchObject({
      applied: false,
      task: "t1",
      reason: CLOSE_MALFORMED,
    });
    expect(applySettledClose(db, input({ lastText: text }))).toMatchObject({
      reason: "already applied",
    });
    expect(kinds("t1")).toEqual([{ kind: "note", content: CLOSE_MALFORMED }]);
    expect(getTask(db, "t1", "w")?.status).toBe("IN_PROGRESS");
  });

  it("a malformed block with no single open owned task records the replay row but no note", async () => {
    addTask(db, { workstream: "w", localId: "t5", title: "t5" });
    // w1 now owns two open tasks: the target of the diagnostic is ambiguous.
    await claimTask(db, "t5", { workstream: "w", agentName: "w1" });
    expect(
      applySettledClose(db, input({ lastText: "CLOSE: task=t1 evidence=x\nREPORT:\nr" })),
    ).toMatchObject({
      applied: false,
      task: null,
      reason: CLOSE_MALFORMED,
    });
    expect(kinds("t1")).toEqual([]);
    expect(kinds("t5")).toEqual([]);
    expect(settles()).toHaveLength(1);
  });

  it("a truncated final message is refused with one line, even when the tail parses", () => {
    const r = applySettledClose(
      db,
      input({ lastTextTruncated: true, lastText: `[truncated, see pane]\n${block("t1")}` }),
    );
    expect(r).toMatchObject({ applied: false, reason: CLOSE_TRUNCATED });
    expect(getTask(db, "t1", "w")?.status).toBe("IN_PROGRESS");
    expect(kinds("t1")).toEqual([{ kind: "note", content: CLOSE_TRUNCATED }]);
  });

  it("an earlier block for an owned task does not close when the FINAL block names another task", () => {
    const text = `${block("t1")}\n\nActually I reviewed t2:\n${block("t2")}`;
    expect(applySettledClose(db, input({ lastText: text }))).toMatchObject({
      applied: false,
      task: "t2",
    });
    expect(getTask(db, "t1", "w")?.status).toBe("IN_PROGRESS");
  });

  it("a report may contain CLOSE text without executing it", () => {
    const text = block("t1", "ok", 'Contract was:\nCLOSE: task=t2 evidence="x"\nso I did not.');
    expect(applySettledClose(db, input({ lastText: text }))).toMatchObject({
      applied: true,
      task: "t1",
    });
    expect(getTask(db, "t2", "w")?.status).toBe("IN_PROGRESS");
    expect(kinds("t1")[0]?.content).toContain('CLOSE: task=t2 evidence="x"');
  });
});

describe("applySettledClose: atomic replay", () => {
  it("open blockers propagate and roll back notes AND the replay row; a retry after the blocker closes succeeds", () => {
    addTask(db, { workstream: "w", localId: "b1", title: "b1" });
    addBlockEdge(db, "w", "t1", "b1");
    const before = opCount();
    expect(() => applySettledClose(db, input({ lastText: block("t1") }))).toThrow(
      TaskHasOpenBlockersError,
    );
    expect(opCount()).toBe(before);
    expect(settles()).toEqual([]);
    expect(kinds("t1")).toEqual([]);
    closeTask(db, "b1", { workstream: "w", evidence: "done" });
    expect(applySettledClose(db, input({ lastText: block("t1") }))).toMatchObject({
      applied: true,
    });
  });

  it("a failure inside the close leaves no replay row (the insert is last)", () => {
    db.prepare(
      "CREATE TRIGGER boom BEFORE UPDATE OF status ON tasks WHEN NEW.status = 'CLOSED' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    ).run();
    expect(() => applySettledClose(db, input({ lastText: block("t1") }))).toThrow(/boom/);
    expect(settles()).toEqual([]);
    expect(kinds("t1")).toEqual([]);
    db.prepare("DROP TRIGGER boom").run();
    expect(applySettledClose(db, input({ lastText: block("t1") }))).toMatchObject({
      applied: true,
    });
  });
});
