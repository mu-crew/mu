// `mu delegates prune` (src/delegate-prune.ts) and doctor's `delegates-old` row.
// Real SQLite in temp dirs; two DBs for the peer case.

import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdDelegatesPrune } from "../src/cli/delegates.js";
import { type Db, openDb } from "../src/db.js";
import { checkOldDelegates, planDelegatePrune, pruneDelegates } from "../src/delegate-prune.js";
import {
  delegateProcessDir,
  delegateSessionDir,
  finishDelegate,
  getDelegateCall,
  registerDelegateCall,
} from "../src/delegates.js";
import { checkDrift } from "../src/drift.js";
import { withCaptureSuppressed } from "../src/op-context.js";
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
    // `--off` keeps the row (enabled = 0): the check is just an old answer now.
    const off = planDelegatePrune(db);
    expect(off.kept.refuteTarget).toBe(0);
    expect(off.candidates.map((c) => c.callId)).toEqual(["refute:ws:judged:auto:1"]);
  });

  it("a plain call recording onto an auto task is not kept; only refute: checks are", () => {
    call("plain", 40, { record: true });
    authorizeTasks(db, ["judged"], { workstream: "ws", cli: "pi", worktree: false, maxRuns: 1 });
    const plan = planDelegatePrune(db);
    expect(plan.candidates.map((c) => c.callId)).toEqual(["plain"]);
    expect(plan.kept.refuteTarget).toBe(0);
  });

  it("never picks a closed task whose call is still live, or a work task", () => {
    const { call: live } = registerDelegateCall(db, {
      callId: "live",
      caller: "pi:s",
      workstream: "scratch",
      request: { text: "q", label: "live" },
      state: "starting",
    });
    // Raw state a crash mid-record leaves: the close guard is for verbs, not fixtures.
    withCaptureSuppressed(db, () => {
      db.prepare("UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = ?").run(
        live.task,
      );
      // A closed work task (not a delegate task).
      db.prepare(
        "UPDATE tasks SET status = 'CLOSED', substate = 'done' WHERE local_id = 'judged'",
      ).run();
    });
    // Give the work task a call row too, so only the kind filter excludes it.
    db.prepare(
      `INSERT INTO delegate_calls (task_id, caller, call_id, state, updated_at)
       SELECT id, 'pi:s', 'stray', 'done', '2020-01-01T00:00:00.000Z' FROM tasks WHERE local_id = 'judged'`,
    ).run();
    db.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z'").run();
    expect(planDelegatePrune(db).candidates).toEqual([]);
  });

  it("a peer's delegate task (no call row here) is never picked", () => {
    const b = openDb({ path: join(dir, "b.db") });
    try {
      const { call: c } = registerDelegateCall(b, {
        callId: "peer",
        caller: "pi:p",
        workstream: "scratch",
        request: { text: "peer", label: "peer" },
        state: "starting",
      });
      finishDelegate(b, "peer", { outcome: "done", text: "VERDICT: CONFIRMED", author: "d" });
      ingestFromDb(db, join(dir, "b.db"));
      db.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE local_id = ?").run(
        c.task,
      );
      expect(getTask(db, c.task, "scratch")?.status).toBe("CLOSED");
      expect(planDelegatePrune(db).candidates).toEqual([]);
    } finally {
      b.close();
    }
  });

  it("a huge age finds nothing instead of throwing", () => {
    call("old", 31);
    expect(planDelegatePrune(db, { days: 1e12 }).candidates).toEqual([]);
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
    const r = pruneDelegates(db, planDelegatePrune(db, { ownHistory: true }));
    expect(r.tasks).toBe(1);
    expect(getTask(db, task, "scratch")).toBeUndefined();
    expect(getDelegateCall(db, "old")).toBeUndefined();
    expect(putsOf(task)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM wait_cursors").get()).toEqual({ n: 0 });
    // The tombstones stay, task and notes, all in one fresh delegate.prune group.
    const tombs = db
      .prepare(
        "SELECT entity, intent, group_id FROM ops WHERE op = 'del' AND (key = ? OR key LIKE ? || '#%')",
      )
      .all(`scratch/${task}`, `scratch/${task}`) as {
      entity: string;
      intent: string;
      group_id: string;
    }[];
    expect(tombs.filter((t) => t.entity === "task")).toHaveLength(1);
    expect(tombs.filter((t) => t.entity === "note").length).toBeGreaterThan(0);
    expect(new Set(tombs.map((t) => t.intent))).toEqual(new Set(["delegate.prune"]));
    expect(new Set(tombs.map((t) => t.group_id)).size).toBe(1);
    const earlier = db
      .prepare("SELECT COUNT(*) AS n FROM ops WHERE group_id = ? AND op = 'put'")
      .get(tombs[0]?.group_id) as { n: number };
    expect(earlier.n).toBe(0);
    const verdicts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_notes n JOIN tasks t ON t.id = n.task_id WHERE t.local_id = 'judged' AND n.kind = 'verdict'",
      )
      .get() as { n: number };
    expect(verdicts.n).toBe(1);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("with sync on, keeps this machine's own puts (its segment is rebuilt from them), deletes peers'", () => {
    const task = call("old", 31);
    const me = (db.prepare("SELECT machine_id AS m FROM machine_identity").get() as { m: string })
      .m;
    // One note put that came from a peer.
    db.prepare(
      `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
       VALUES ('000000000000001.000000.peer', 'peer-m', 'g', NULL, NULL, 'note', ?, 'put', '{}', '2020-01-01')`,
    ).run(`scratch/${task}#999`);
    const own = putsOf(task) - 1;
    const plan = planDelegatePrune(db, { ownHistory: false });
    expect(plan.ownHistory).toBe(false);
    expect(plan.ops).toBe(1);
    expect(pruneDelegates(db, plan).ops).toBe(1);
    expect(getTask(db, task, "scratch")).toBeUndefined();
    const left = db
      .prepare(
        "SELECT COUNT(*) AS n FROM ops WHERE op = 'put' AND machine_id = ? AND (key = ? OR key LIKE ? || '#%')",
      )
      .get(me, `scratch/${task}`, `scratch/${task}`) as { n: number };
    expect(left.n).toBe(own);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("the default follows MU_SYNC_DIR", () => {
    call("old", 31);
    expect(planDelegatePrune(db).ownHistory).toBe(true);
    process.env.MU_SYNC_DIR = join(dir, "sync");
    try {
      expect(planDelegatePrune(db).ownHistory).toBe(false);
    } finally {
      const key = "MU_SYNC_DIR";
      delete process.env[key];
    }
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

  it("leaves a task that changed since the plan: touched, reopened, edged", () => {
    const touched = call("touched", 31);
    const reopened = call("reopened", 31);
    const edged = call("edged", 31);
    const plan = planDelegatePrune(db);
    expect(plan.candidates).toHaveLength(3);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE local_id = ?").run(
      new Date().toISOString(),
      touched,
    );
    // Reopened with its old timestamp kept (a peer's op can do that).
    db.prepare("UPDATE tasks SET status = 'OPEN', substate = 'todo' WHERE local_id = ?").run(
      reopened,
    );
    // An edge with the delegate task as the blocker does not touch it.
    addTask(db, { workstream: "scratch", localId: "after", title: "A", impact: 50, effortDays: 1 });
    addBlockEdge(db, "scratch", "after", edged);
    db.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE local_id = ?").run(
      edged,
    );
    expect(pruneDelegates(db, plan).tasks).toBe(0);
    for (const t of [touched, reopened, edged]) expect(getTask(db, t, "scratch")).toBeDefined();
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
      // --yes with nothing left: an apply result, no backup.
      out.mockClear();
      await cmdDelegatesPrune(db, { json: true, yes: true });
      const none = envelopeData(out.mock.calls.at(-1)?.[0]) as Record<string, unknown>;
      expect(none).toMatchObject({ dryRun: false, pruned: 0 });
      expect(none.backup).toBeUndefined();
    } finally {
      out.mockRestore();
    }
  });
});

describe("session files", () => {
  const sessionOf = (task: string): string => {
    const d = delegateSessionDir(db.name, "scratch", task);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s.jsonl"), "x".repeat(100));
    return d;
  };
  const processOf = (id: string): string => {
    const d = delegateProcessDir(db.name, id);
    mkdirSync(join(d, "session"), { recursive: true });
    writeFileSync(join(d, "receipt.json"), "{}");
    return d;
  };
  /** A first-layout file, `delegate-sessions/<ws>/<name>`, last written `ageDays` ago. */
  const loose = (name: string, ageDays: number): string => {
    ensureWorkstream(db, "scratch");
    const d = join(dir, "delegate-sessions", "scratch");
    mkdirSync(d, { recursive: true });
    const p = join(d, name);
    writeFileSync(p, "y".repeat(10));
    const t = (Date.now() - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
    return p;
  };

  it("a pruned call's pane session and process dir go; a kept call's stay, receipt included", () => {
    const oldTask = call("old", 31);
    const freshTask = call("fresh", 1);
    const oldSession = sessionOf(oldTask);
    const oldProcess = processOf("old");
    const freshSession = sessionOf(freshTask);
    const freshProcess = processOf("fresh");
    const plan = planDelegatePrune(db, { ownHistory: true });
    expect(plan.files.paths.sort()).toEqual([oldProcess, oldSession].sort());
    expect(plan.files.bytes).toBe(102);
    const r = pruneDelegates(db, plan);
    expect(r).toMatchObject({ tasks: 1, files: 2 });
    expect(existsSync(oldSession)).toBe(false);
    expect(existsSync(oldProcess)).toBe(false);
    expect(existsSync(freshSession)).toBe(true);
    expect(existsSync(join(freshProcess, "receipt.json"))).toBe(true);
  });

  it("a call whose row survived the delete (touched since the plan) keeps its files", () => {
    const task = call("old", 31);
    const session = sessionOf(task);
    const plan = planDelegatePrune(db, { ownHistory: true });
    db.prepare("UPDATE tasks SET updated_at = ? WHERE local_id = ?").run(
      new Date().toISOString(),
      task,
    );
    expect(pruneDelegates(db, plan)).toMatchObject({ tasks: 0, files: 0 });
    expect(existsSync(session)).toBe(true);
  });

  it("loose first-layout session files go by age; fresh ones and non-sessions stay", () => {
    const old = loose("2026-01-01_old.jsonl", 40);
    const fresh = loose("2026-10-01_new.jsonl", 2);
    const other = loose("notes.txt", 40);
    const plan = planDelegatePrune(db, { ownHistory: true });
    expect(plan.candidates).toEqual([]);
    expect(plan.files.paths).toEqual([old]);
    expect(pruneDelegates(db, plan)).toMatchObject({ tasks: 0, files: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("loose files: never younger than a day, never another DB's workstream", () => {
    const young = loose("young.jsonl", 0.5);
    const d = join(dir, "delegate-sessions", "elsewhere");
    mkdirSync(d, { recursive: true });
    const foreign = join(d, "f.jsonl");
    writeFileSync(foreign, "z");
    const t = (Date.now() - 40 * DAY) / 1000;
    utimesSync(foreign, t, t);
    const plan = planDelegatePrune(db, { days: 0.01, ownHistory: true });
    expect(plan.files.paths).toEqual([]);
    pruneDelegates(db, plan);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it("--yes with only loose files deletes them without a backup", async () => {
    const old = loose("a.jsonl", 40);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdDelegatesPrune(db, { json: true });
      const dry = envelopeData(out.mock.calls.at(-1)?.[0]) as { files: { paths: string[] } };
      expect(dry.files.paths).toEqual([old]);
      expect(existsSync(old)).toBe(true);
      out.mockClear();
      await cmdDelegatesPrune(db, { json: true, yes: true });
      const done = envelopeData(out.mock.calls.at(-1)?.[0]) as Record<string, unknown>;
      expect(done).toMatchObject({ dryRun: false, pruned: 0, deletedFiles: 1 });
      expect(done.backup).toBeUndefined();
      expect(existsSync(old)).toBe(false);
    } finally {
      out.mockRestore();
    }
  });
});

describe("cli text", () => {
  it("lists the candidates and says what is kept and what --yes does", async () => {
    call("old", 31);
    const linked = call("linked", 31);
    addTask(db, { workstream: "scratch", localId: "w", title: "W", impact: 50, effortDays: 1 });
    addBlockEdge(db, "scratch", "w", linked);
    db.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE local_id = ?").run(
      linked,
    );
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdDelegatesPrune(db, {});
      const text = out.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("scratch/delegate_old_");
      expect(text).toMatch(/1 closed delegate task\(s\) older than 30 days: \d+ ops/);
      expect(text).toContain("kept: 1 with edges");
      expect(text).toContain("Dry run");
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
