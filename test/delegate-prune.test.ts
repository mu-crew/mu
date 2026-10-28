// `mu delegates prune` (src/delegate-prune.ts) and doctor's `delegates-old` row.
// Real SQLite in temp dirs; two DBs for the peer case.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdDelegatesPrune } from "../src/cli/delegates.js";
import { type Db, openDb } from "../src/db.js";
import { checkOldDelegates, planDelegatePrune, pruneDelegates } from "../src/delegate-prune.js";
import { finishDelegate, getDelegateCall, registerDelegateCall } from "../src/delegates.js";
import { checkDrift } from "../src/drift.js";
import { ingestFromDb } from "../src/sync.js";
import { authorizeTasks } from "../src/task-auto.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask } from "../src/tasks/queries.js";
import { ensureWorkstream } from "../src/workstream.js";
import { envelopeData } from "./_envelope.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
const DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-prune-"));
  db = openDb({ path: join(dir, "a.db") });
  ensureWorkstream(db, "ws");
  addTask(db, { workstream: "ws", localId: "judged", title: "J", impact: 50, effortDays: 1 });
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

/** A finished call whose task closed `ageDays` ago; returns its task id. */
function call(id: string, ageDays: number, opts: { record?: boolean; text?: string } = {}) {
  const { call: c } = registerDelegateCall(db, {
    callId: id,
    caller: "pi:s",
    workstream: "scratch",
    request: { text: `brief ${id}`, label: id },
    ...(opts.record ? { record: { workstream: "ws", task: "judged" } } : {}),
    state: "starting",
  });
  finishDelegate(db, id, {
    outcome: "done",
    text: opts.text ?? "VERDICT: CONFIRMED\nEVIDENCE: x",
    author: "d",
  });
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  db.prepare(
    "UPDATE tasks SET updated_at = ? WHERE local_id = ? AND workstream_id = (SELECT id FROM workstreams WHERE name = 'scratch')",
  ).run(at, c.task);
  return c.task;
}

const putsOf = (task: string): number =>
  (
    db
      .prepare("SELECT COUNT(*) AS n FROM ops WHERE op = 'put' AND (key = ? OR key LIKE ? || '#%')")
      .get(`scratch/${task}`, `scratch/${task}`) as { n: number }
  ).n;

describe("plan", () => {
  it("picks closed delegate tasks past the age, never fresh, open or work tasks", () => {
    const old = call("old", 31);
    call("fresh", 5);
    registerDelegateCall(db, {
      callId: "open",
      caller: "pi:s",
      workstream: "scratch",
      request: { text: "q", label: "open" },
    });
    db.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z'").run();
    // Every task is now old by timestamp: only closed delegate tasks qualify.
    const plan = planDelegatePrune(db);
    expect(plan.candidates.map((c) => c.task).sort()).toEqual(
      [old, getDelegateCall(db, "fresh")?.task].sort(),
    );
    expect(plan.days).toBe(30);
    expect(plan.ops).toBeGreaterThan(0);
    expect(planDelegatePrune(db, { days: 400_000 }).candidates).toEqual([]);
  });

  it("keeps a task with an edge, and a refute check of a task still under mu task auto", () => {
    const linked = call("linked", 40);
    addTask(db, { workstream: "scratch", localId: "watch", title: "W", impact: 50, effortDays: 1 });
    addBlockEdge(db, "scratch", "watch", linked);
    registerDelegateCall(db, {
      callId: "refute:ws:judged:auto:1",
      caller: "pi:s",
      workstream: "scratch",
      request: { text: "check", label: "refute-judged" },
      record: { workstream: "ws", task: "judged" },
      state: "starting",
    });
    finishDelegate(db, "refute:ws:judged:auto:1", {
      outcome: "done",
      text: "VERDICT: CONFIRMED",
      author: "d",
    });
    db.prepare(
      "UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'delegate'",
    ).run();
    authorizeTasks(db, ["judged"], { workstream: "ws", cli: "pi", worktree: false, maxRuns: 1 });
    const plan = planDelegatePrune(db);
    expect(plan.candidates).toEqual([]);
    expect(plan.kept).toEqual({ edges: 1, refuteTarget: 1 });
    // Without auto permission the refute check is just an old answer.
    authorizeTasks(db, ["judged"], {
      workstream: "ws",
      cli: "pi",
      worktree: false,
      maxRuns: 1,
      off: true,
    });
    db.prepare("DELETE FROM task_auto").run();
    expect(planDelegatePrune(db).kept.refuteTarget).toBe(0);
  });

  it("skips torn-down workstreams and narrows to one workstream", () => {
    call("old", 31);
    expect(planDelegatePrune(db, { workstream: "ws" }).candidates).toEqual([]);
    db.prepare("UPDATE workstreams SET torn_down_at = ? WHERE name = 'scratch'").run(
      new Date().toISOString(),
    );
    expect(planDelegatePrune(db).candidates).toEqual([]);
  });
});

describe("prune", () => {
  it("deletes the task, notes, call row, cursor and puts; keeps the verdict on the judged task; drift clean", () => {
    const task = call("old", 31, { record: true });
    db.prepare(
      "INSERT INTO wait_cursors (caller, ref, incarnation, runs) VALUES ('pi:s', ?, 'delegate', 1)",
    ).run("delegate:scratch/old");
    expect(putsOf(task)).toBeGreaterThan(0);
    const r = pruneDelegates(db, planDelegatePrune(db));
    expect(r.tasks).toBe(1);
    expect(getTask(db, task, "scratch")).toBeUndefined();
    expect(getDelegateCall(db, "old")).toBeUndefined();
    expect(putsOf(task)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM wait_cursors").get()).toEqual({ n: 0 });
    // The tombstone stays, in one delegate.prune group.
    const tombs = db
      .prepare("SELECT intent, group_id FROM ops WHERE op = 'del' AND key = ?")
      .all(`scratch/${task}`) as { intent: string }[];
    expect(tombs.map((t) => t.intent)).toEqual(["delegate.prune"]);
    const verdicts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_notes n JOIN tasks t ON t.id = n.task_id WHERE t.local_id = 'judged' AND n.kind = 'verdict'",
      )
      .get() as { n: number };
    expect(verdicts.n).toBe(1);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("a peer drops the same rows through the tombstones", () => {
    const task = call("old", 31);
    const b = openDb({ path: join(dir, "b.db") });
    try {
      ingestFromDb(b, join(dir, "a.db"));
      expect(getTask(b, task, "scratch")).toBeDefined();
      pruneDelegates(db, planDelegatePrune(db));
      ingestFromDb(b, join(dir, "a.db"));
      expect(getTask(b, task, "scratch")).toBeUndefined();
      expect(checkDrift(b).clean).toBe(true);
    } finally {
      b.close();
    }
  });

  it("leaves a task that changed since the plan", () => {
    const task = call("old", 31);
    const plan = planDelegatePrune(db);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE local_id = ?").run(
      new Date().toISOString(),
      task,
    );
    expect(pruneDelegates(db, plan).tasks).toBe(0);
    expect(getTask(db, task, "scratch")).toBeDefined();
  });
});

describe("cli", () => {
  it("is a dry run without --yes; --yes backs up and prunes", async () => {
    const task = call("old", 31);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdDelegatesPrune(db, { json: true });
      const dry = envelopeData(out.mock.calls.at(-1)?.[0]) as {
        dryRun: boolean;
        candidates: unknown[];
      };
      expect(dry.dryRun).toBe(true);
      expect(dry.candidates).toHaveLength(1);
      expect(getTask(db, task, "scratch")).toBeDefined();
      out.mockClear();
      await cmdDelegatesPrune(db, { json: true, yes: true, olderThan: 30 });
      const done = envelopeData(out.mock.calls.at(-1)?.[0]) as { pruned: number; backup: string };
      expect(done.pruned).toBe(1);
      expect(done.backup).toMatch(/a\.db\.pre-prune-/);
      expect(getTask(db, task, "scratch")).toBeUndefined();
    } finally {
      out.mockRestore();
    }
  });
});

describe("doctor: delegates-old", () => {
  it("is ok and quiet with nothing old; ok with the count and the remedy otherwise", () => {
    call("fresh", 5);
    const quiet = checkOldDelegates(db);
    expect(quiet).toMatchObject({ name: "delegates-old", severity: "ok" });
    expect(quiet.remediation).toBeUndefined();
    call("old", 31);
    const note = checkOldDelegates(db);
    expect(note.severity).toBe("ok");
    expect(note.detail).toMatch(/^1 closed delegate task\(s\) older than 30 days/);
    expect(note.remediation?.join("\n")).toContain("mu delegates prune --yes");
  });
});
