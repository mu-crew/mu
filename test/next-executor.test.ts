// `executeNext` slice A (v_exec_dispatch): authorised dispatch with task-scoped
// attempt reservation. Real SQLite in a temp dir; spawnAgent and the send
// transport are the only fakes (the journal, claim and replay are real).

import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agents/spawn.js", async (importOriginal) =>
  (await import("./_next-fakes.js")).spawnFake(await importOriginal()),
);
vi.mock("../src/agents/transport.js", async (importOriginal) =>
  (await import("./_next-fakes.js")).transportFake(await importOriginal()),
);

import { getReceipt } from "../src/agents/receipts.js";
import { getAgent } from "../src/agents.js";
import { pendingAttempts, planAttempt, readAttempt, reserveAttempt } from "../src/auto-attempt.js";
import { type Db, openDb } from "../src/db.js";
import { openHumanNeeds, recordHumanNeeded } from "../src/human-needed.js";
import { executeNext, NextArgError, type NextResult } from "../src/next.js";
import { localMachineId } from "../src/segments.js";
import { authorisedReady, authorizeTasks } from "../src/task-auto.js";
import { taskIdFor } from "../src/tasks/core.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { hook, resetHook } from "./_next-fakes.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let muxCalls: number;

beforeEach(() => {
  resetHook();
  muxCalls = 0;
  dir = mkdtempSync(join(tmpdir(), "mu-next-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "d");
  mux = installMux("tmux", async () => {
    muxCalls++;
    return { stdout: "", stderr: "", exitCode: 0 };
  });
});
afterEach(() => {
  mux.restore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const noIngest = async () => {};
const tid = (id: string) => {
  const n = taskIdFor(db, id, "d");
  if (n === null) throw new Error(`no task ${id}`);
  return n;
};
/** A ready task with a brief, authorised for this machine. */
function task(id: string, o: { max?: number; brief?: boolean; auth?: boolean } = {}): void {
  addTask(db, { workstream: "d", localId: id, title: id });
  if (o.brief !== false) {
    addNote(db, id, `BRIEF for ${id}`, { workstream: "d", kind: "brief", author: "orch" });
  }
  if (o.auth !== false) {
    authorizeTasks(db, [id], {
      workstream: "d",
      cli: "pi",
      worktree: false,
      maxRuns: o.max ?? 1,
    });
  }
}
/** Every worker alive and busy: slice A's tests are about dispatch, not recovery. */
const alive: import("../src/next-recover.js").ObserveWorkers = async (agents) =>
  new Map(
    agents.map((a) => [
      `${a.workstreamName}/${a.name}`,
      { status: "busy" as const, ctl: "ok" as const },
    ]),
  );
const run = (o: Partial<Parameters<typeof executeNext>[1]> = {}, handle: Db = db) =>
  executeNext(handle, { workstream: "d", caller: "orch", ingest: noIngest, observe: alive, ...o });
const runsOf = (id: string) =>
  (db.prepare("SELECT runs FROM task_auto WHERE task_id = ?").get(tid(id)) as { runs: number })
    .runs;
const kinds = (r: NextResult) => r.moves.map((m) => `${m.kind}:${m.task}`);
const receiptOf = (id: string, key: string) => getReceipt(db, tid(id), key);

describe("dispatch of an authorised task", () => {
  it("spawns, claims, sends the brief once, charges one run; never touches auth config", async () => {
    task("a");
    task("plain", { auth: false });
    const before = db.prepare("SELECT * FROM task_auto ORDER BY task_id").all();
    const r = await run();
    expect(kinds(r)).toEqual(["spawn:a"]);
    expect(r.moves[0]).toMatchObject({ attempt: 1, key: "auto:1", state: "sent" });
    expect(hook.spawns).toHaveLength(1);
    expect(hook.sends).toHaveLength(1);
    expect(hook.sends[0]?.text.startsWith("BRIEF for a")).toBe(true);
    expect(runsOf("a")).toBe(1);
    expect(receiptOf("a", "auto:1")?.state).toBe("sent");
    expect(getTask(db, "a", "d")?.ownerId).toBe(
      getAgent(db, hook.spawns[0] ?? "", "d")?.incarnation,
    );
    expect(getTask(db, "plain", "d")?.status).toBe("OPEN");
    const after = db.prepare("SELECT * FROM task_auto ORDER BY task_id").all() as {
      runs: number;
      last_spawn: string;
    }[];
    expect(after.map((x) => ({ ...x, runs: 0, last_spawn: "" }))).toEqual(
      (before as typeof after).map((x) => ({ ...x, runs: 0, last_spawn: "" })),
    );
  });

  it("a second invocation neither spawns nor charges", async () => {
    task("a");
    await run();
    const r = await run();
    expect(r.moves).toEqual([]);
    expect(hook.spawns).toHaveLength(1);
    expect(runsOf("a")).toBe(1);
  });

  it("does not dispatch a task designated to another host", async () => {
    task("a");
    db.prepare("UPDATE tasks SET dispatch_host = ?").run("9f1c8a2e-0000-4000-8000-0000000000bb");
    expect((await run()).moves).toEqual([]);
    expect(hook.spawns).toEqual([]);
  });

  it("skips a task with no brief without reserving anything", async () => {
    task("nobrief", { brief: false });
    const r = await run();
    expect(r.moves).toEqual([expect.objectContaining({ kind: "skip", task: "nobrief" })]);
    expect(r.moves[0]?.reason).toMatch(/brief/);
    expect(runsOf("nobrief")).toBe(0);
    expect(readAttempt(db, tid("nobrief")).record).toBeUndefined();
  });

  it("an already delivered attempt on a ready task (reopened) is not re-dispatched here", async () => {
    task("a", { max: 3 });
    await run();
    db.prepare("UPDATE tasks SET status = 'OPEN', substate = 'todo', owner_id = NULL").run();
    expect(authorisedReady(db, "d").map((t) => t.name)).toEqual(["a"]);
    const r = await run();
    expect(r.moves).toEqual([expect.objectContaining({ kind: "skip", task: "a" })]);
    expect(r.moves[0]?.reason).toMatch(/delivered|recovery/);
    expect(hook.spawns).toHaveLength(1);
    expect(runsOf("a")).toBe(1);
  });
});

describe("attempt accounting", () => {
  const reserve = (id: string) => {
    const t = authorisedReady(db, "d").find((x) => x.name === id);
    if (t === undefined) throw new Error("not ready");
    const out = reserveAttempt(db, "d", id);
    if (!out.ok) throw new Error(out.reason);
    return out.plan;
  };

  it("reserve charges once, stores the pins, and a second reserve is refused as in flight", () => {
    task("a", { max: 3 });
    const plan = reserve("a");
    expect(plan.key).toBe("auto:1");
    expect(runsOf("a")).toBe(1);
    expect(receiptOf("a", "auto:1")?.state).toBe("reserved");
    const again = reserveAttempt(db, "d", "a");
    expect(again).toMatchObject({ ok: false, code: "in-flight" });
    expect(runsOf("a")).toBe(1);
  });

  it("a reservation planned before a change is refused (revision CAS), with no charge", () => {
    task("a", { max: 3 });
    const planned = planAttempt(db, "d", "a");
    expect(planned.ok).toBe(true);
    const stale = planned.ok ? planned.plan.revision : -1;
    addNote(db, "a", "a peer note", { workstream: "d" });
    expect(reserveAttempt(db, "d", "a", { revision: stale })).toMatchObject({
      ok: false,
      code: "changed",
    });
    expect(runsOf("a")).toBe(0);
    expect(receiptOf("a", "auto:1")).toBeUndefined();
  });

  it("FINAL run reserved, crash before the pane: not authorisedReady, yet next resumes the SAME key with no new charge", async () => {
    task("a", { max: 1 });
    reserve("a");
    expect(authorisedReady(db, "d")).toEqual([]);
    const r = await run();
    expect(kinds(r)).toEqual(["replay:a"]);
    expect(r.moves[0]).toMatchObject({ key: "auto:1", state: "sent" });
    expect(hook.spawns).toHaveLength(1);
    expect(runsOf("a")).toBe(1);
  });

  it("non-final reservation still looks ready: next replays auto:1, never allocates auto:2", async () => {
    task("a", { max: 3 });
    reserve("a");
    expect(authorisedReady(db, "d").map((t) => t.name)).toEqual(["a"]);
    const r = await run();
    expect(kinds(r)).toEqual(["replay:a"]);
    expect(runsOf("a")).toBe(1);
    expect(receiptOf("a", "auto:2")).toBeUndefined();
  });

  it("the replay sends the reserved text even after the report changed", async () => {
    task("a", { max: 2 });
    addNote(db, "a", "report ONE", { workstream: "d", kind: "report" });
    reserve("a");
    addNote(db, "a", "report TWO", { workstream: "d", kind: "report" });
    await run();
    expect(hook.sends[0]?.text).toContain("report ONE");
    expect(hook.sends[0]?.text).not.toContain("report TWO");
  });

  it("an unsent failure keeps its charge; the failed key is never reset; spawns never exceed max", async () => {
    task("a", { max: 2 });
    hook.spawnFails = () => new Error("tmux said no");
    const r1 = await run();
    expect(r1.moves[0]).toMatchObject({ kind: "failed", task: "a", key: "auto:1" });
    expect(r1.stopped).toBe("failed");
    expect(r1.used).toBe(1); // a failed move is an effect: it counts against the cap
    expect(runsOf("a")).toBe(1);
    expect(receiptOf("a", "auto:1")?.state).toBe("failed");
    const r2 = await run();
    expect(r2.moves[0]).toMatchObject({ kind: "failed", key: "auto:2" });
    expect(runsOf("a")).toBe(2);
    expect(receiptOf("a", "auto:1")?.state).toBe("failed");
    const r3 = await run();
    expect(r3.moves).toEqual([]);
    expect(hook.spawns).toHaveLength(2);
    hook.spawnFails = undefined;
    expect((await run()).moves).toEqual([]);
    expect(hook.spawns).toHaveLength(2);
  });

  it("permission revoked after the pane exists: nothing is sent, the attempt is rolled back (unsent), the charge stays", async () => {
    task("a", { max: 3 });
    hook.afterSpawn = () =>
      void authorizeTasks(db, ["a"], {
        workstream: "d",
        cli: "pi",
        worktree: false,
        maxRuns: 3,
        off: true,
      });
    const r = await run();
    expect(r.moves[0]).toMatchObject({ kind: "rolled_back", task: "a", key: "auto:1" });
    expect(r.moves[0]?.reason).toMatch(/no longer authorised/);
    expect(r.used).toBe(1);
    expect(hook.sends).toEqual([]);
    expect(receiptOf("a", "auto:1")?.state).toBe("failed");
    expect(getAgent(db, "a-1", "d")).toBeUndefined();
    expect(getTask(db, "a", "d")).toMatchObject({ ownerId: null, status: "OPEN" });
    expect(runsOf("a")).toBe(1);
  });

  it("UNKNOWN send: pane and claim kept, replay probes once and never resends, no charge", async () => {
    task("a", { max: 3 });
    hook.sendMode = "throws";
    const r1 = await run();
    expect(r1.moves[0]).toMatchObject({ kind: "spawn", state: "unknown" });
    expect(runsOf("a")).toBe(1);
    hook.sendMode = "ok";
    hook.checkState = "accepted";
    const r2 = await run();
    expect(r2.moves[0]).toMatchObject({ kind: "replay", state: "sent" });
    expect(hook.checks).toHaveLength(1);
    expect(hook.sends).toHaveLength(1);
    expect(runsOf("a")).toBe(1);
    expect((await run()).moves).toEqual([]);
  });

  it("UNKNOWN that the one probe cannot confirm becomes needs_human with a human need: never resent, never probed again", async () => {
    task("a", { max: 3 });
    task("b");
    hook.sendMode = "throws";
    await run({ cap: 1 });
    hook.sendMode = "ok";
    const r2 = await run();
    expect(r2.moves[0]).toMatchObject({ kind: "needs_human", task: "a", checked: "unreachable" });
    expect(r2.used).toBe(1); // the probe was an effect
    expect(hook.checks).toHaveLength(1);
    expect(openHumanNeeds(db, "orch")).toHaveLength(1);
    expect(r2.stopped).toBe("human");
    // Parked: no further probe, send or charge, however often it is invoked.
    for (let i = 0; i < 3; i++) await run();
    expect(hook.checks).toHaveLength(1);
    expect(hook.sends).toHaveLength(1);
    expect(runsOf("a")).toBe(1);
    expect(runsOf("b")).toBe(0);
    expect(planAttempt(db, "d", "a")).toMatchObject({ ok: false, code: "parked" });
  });

  it("two invocations at once (two connections): one spawn, one charge", async () => {
    task("a", { max: 5 });
    const other = openDb({ path: dbPath });
    try {
      const [x, y] = await Promise.all([run({}, db), run({}, other)]);
      expect(hook.spawns).toHaveLength(1);
      expect(hook.sends).toHaveLength(1);
      expect(runsOf("a")).toBe(1);
      const all = [...x.moves, ...y.moves];
      expect(all.filter((m) => m.kind === "spawn")).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});

describe("reconcile before allocate", () => {
  it("stored attempts replay first, even under a cap of 1; fresh work waits", async () => {
    task("a", { max: 1 });
    task("b", { max: 1 });
    expect(reserveAttempt(db, "d", "a").ok).toBe(true);
    const r = await run({ cap: 1 });
    expect(kinds(r)).toEqual(["replay:a"]);
    expect(r.stopped).toBe("cap");
    expect(runsOf("b")).toBe(0);
  });

  it("a revoked reservation is left alone, then resumed with no new charge once re-authorised", async () => {
    task("a", { max: 3 });
    expect(reserveAttempt(db, "d", "a").ok).toBe(true);
    authorizeTasks(db, ["a"], {
      workstream: "d",
      cli: "pi",
      worktree: false,
      maxRuns: 3,
      off: true,
    });
    expect((await run()).moves).toEqual([]);
    expect(hook.spawns).toEqual([]);
    authorizeTasks(db, ["a"], { workstream: "d", cli: "pi", worktree: false, maxRuns: 3 });
    const r = await run();
    expect(kinds(r)).toEqual(["replay:a"]);
    expect(runsOf("a")).toBe(1);
  });
});

describe("cap", () => {
  it("defaults to a finite 5", async () => {
    for (let i = 0; i < 7; i++) task(`t${i}`);
    const r = await run();
    expect(hook.spawns).toHaveLength(5);
    expect(r).toMatchObject({ cap: 5, used: 5, stopped: "cap" });
  });

  it("counts replays and failures, not only successful spawns", async () => {
    task("a");
    task("b");
    task("c");
    reserveAttempt(db, "d", "a");
    reserveAttempt(db, "d", "b");
    const r = await run({ cap: 2 });
    expect(kinds(r)).toEqual(["replay:a", "replay:b"]);
    expect(runsOf("c")).toBe(0);
  });

  it.each([0, -1, 1.5, 101, Number.NaN])("refuses cap %s before any effect", async (cap) => {
    task("a");
    await expect(run({ cap })).rejects.toBeInstanceOf(NextArgError);
    expect(hook.spawns).toEqual([]);
    expect(runsOf("a")).toBe(0);
  });
});

describe("stops and fences between effects", () => {
  it("this caller's open human need stops dispatch; another caller's does not", async () => {
    task("a");
    recordHumanNeeded(db, { workstream: "d", caller: "someone-else", reason: "theirs" });
    expect((await run()).moves).toHaveLength(1);
    task("b");
    recordHumanNeeded(db, { workstream: "d", caller: "orch", reason: "need a human" });
    const r = await run();
    expect(r.moves).toEqual([]);
    expect(r.stopped).toBe("human");
    expect(r.human_needed).toHaveLength(1);
    expect(runsOf("b")).toBe(0);
  });

  it("a need that appears mid-batch stops the rest", async () => {
    task("a");
    task("b");
    let calls = 0;
    const r = await run({
      ingest: async () => {
        if (++calls === 2)
          recordHumanNeeded(db, { workstream: "d", caller: "orch", reason: "stop" });
      },
    });
    expect(hook.spawns).toHaveLength(1);
    expect(r.stopped).toBe("human");
  });

  it("a peer designation change seen at ingest stops that task, nothing else", async () => {
    task("a");
    task("b");
    let calls = 0;
    const r = await run({
      ingest: async () => {
        if (++calls === 2) {
          db.prepare("UPDATE tasks SET dispatch_host = ? WHERE local_id = 'b'").run(
            "9f1c8a2e-0000-4000-8000-0000000000bb",
          );
        }
      },
    });
    expect(kinds(r)).toEqual(["spawn:a"]);
    expect(runsOf("b")).toBe(0);
    expect(localMachineId(db)).not.toBe("9f1c8a2e-0000-4000-8000-0000000000bb");
  });
});

describe("dry run", () => {
  it("never ingests", async () => {
    task("a");
    let ingests = 0;
    await run({
      dry: true,
      ingest: async () => {
        ingests++;
      },
    });
    expect(ingests).toBe(0);
  });

  it("writes nothing: readonly handle, identical tables, no mux, no locks, no spawn", async () => {
    task("a", { max: 3 });
    task("b");
    reserveAttempt(db, "d", "b");
    const tables = () =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      )
        .map((t) => t.name)
        .sort()
        .map((n) => [n, db.prepare(`SELECT * FROM "${n}"`).all()]);
    const snap = JSON.stringify(tables());
    mkdirSync(join(dir, "locks"), { recursive: true });
    const locksBefore = readdirSync(join(dir, "locks"));
    db.pragma("wal_checkpoint(TRUNCATE)");
    const ro = openDb({ path: dbPath, readonly: true });
    let r: NextResult;
    try {
      r = await executeNext(ro, { workstream: "d", caller: "orch", dry: true });
    } finally {
      ro.close();
    }
    expect(r.dry).toBe(true);
    expect(kinds(r)).toEqual(["replay:b", "spawn:a"]);
    expect(r.moves[1]).toMatchObject({ attempt: 1, key: "auto:1", cli: "pi" });
    expect(JSON.stringify(tables())).toBe(snap);
    expect(hook.spawns).toEqual([]);
    expect(hook.checks).toEqual([]);
    expect(muxCalls).toBe(0);
    expect(readdirSync(join(dir, "locks"))).toEqual(locksBefore);
  });

  it("applies the cap to its plan and reports a human stop instead of a plan", async () => {
    task("a");
    task("b");
    expect(kinds(await run({ dry: true, cap: 1 }))).toEqual(["spawn:a"]);
    recordHumanNeeded(db, { workstream: "d", caller: "orch", reason: "x" });
    const r = await run({ dry: true });
    expect(r.moves).toEqual([]);
    expect(r.stopped).toBe("human");
  });
});

describe("every stored attempt reaches a terminal state", () => {
  /** An UNKNOWN attempt on `id` (the send threw), pane and claim kept. */
  async function unknownAttempt(_id: string): Promise<void> {
    hook.sendMode = "throws";
    await run({ cap: 1 });
    hook.sendMode = "ok";
  }
  const deleteAgents = () => void db.prepare("DELETE FROM agents").run();

  it("a CLOSED task's unknown attempt is abandoned once, free, and never starves fresh work at cap 1", async () => {
    task("a", { max: 3 });
    await unknownAttempt("a");
    closeTask(db, "a", { workstream: "d", evidence: "done elsewhere" });
    deleteAgents();
    task("b");
    const r = await run({ cap: 1 });
    expect(r.moves.map((m) => `${m.kind}:${m.task}`)).toEqual(["abandoned:a", "spawn:b"]);
    expect(r.used).toBe(1); // only b's spawn
    expect(runsOf("a")).toBe(1);
    expect(hook.checks).toEqual([]);
    expect(pendingAttempts(db, "d")).toEqual([]);
    expect(readAttempt(db, tid("a")).record?.end).toMatchObject({ state: "abandoned" });
    expect((await run()).moves).toEqual([]); // never reported again
  });

  it("an open task whose agent is gone (sent, unconfirmable) is needs_human on the first sight, free", async () => {
    task("a", { max: 3 });
    await unknownAttempt("a");
    deleteAgents();
    const r = await run({ cap: 1 });
    expect(r.moves).toEqual([expect.objectContaining({ kind: "needs_human", task: "a" })]);
    expect(r.used).toBe(0);
    expect(hook.checks).toEqual([]);
    expect(hook.sends).toHaveLength(1);
    expect(openHumanNeeds(db, "orch")).toHaveLength(1);
    expect(pendingAttempts(db, "d")).toEqual([]);
  });

  it("five unresolvable attempts never eat the default cap; fresh work is dispatched", async () => {
    for (let i = 0; i < 5; i++) task(`s${i}`, { max: 3 });
    hook.sendMode = "throws";
    expect((await run()).moves).toHaveLength(5); // five UNKNOWN sends
    hook.sendMode = "ok";
    for (let i = 0; i < 5; i++) closeTask(db, `s${i}`, { workstream: "d", evidence: "x" });
    deleteAgents();
    task("fresh");
    const r = await run();
    expect(r.moves.filter((m) => m.kind === "abandoned")).toHaveLength(5);
    expect(r.moves.at(-1)).toMatchObject({ kind: "spawn", task: "fresh" });
    expect(r.used).toBe(1);
    expect(r.stopped).toBeUndefined();
  });

  it("a reserved attempt whose task was closed is abandoned (its receipt failed), not replayed", async () => {
    task("a", { max: 3 });
    expect(reserveAttempt(db, "d", "a").ok).toBe(true);
    closeTask(db, "a", { workstream: "d", evidence: "x" });
    const r = await run();
    expect(r.moves).toEqual([expect.objectContaining({ kind: "abandoned", task: "a" })]);
    expect(receiptOf("a", "auto:1")?.state).toBe("failed");
    expect(hook.spawns).toEqual([]);
    expect(pendingAttempts(db, "d")).toEqual([]);
  });

  it("dry run reports the same terminal outcome without writing it", async () => {
    task("a", { max: 3 });
    expect(reserveAttempt(db, "d", "a").ok).toBe(true);
    closeTask(db, "a", { workstream: "d", evidence: "x" });
    const r = await run({ dry: true });
    expect(kinds(r)).toEqual(["abandoned:a"]);
    expect(readAttempt(db, tid("a")).record?.end).toBeUndefined();
  });
});

describe("a replay sends the stored request", () => {
  it("note deletion and a newer brief between reserve and replay change nothing sent", async () => {
    task("a", { max: 2 });
    task("b");
    addNote(db, "a", "report ONE", { workstream: "d", kind: "report" });
    const plan = reserveAttempt(db, "d", "a");
    if (!plan.ok) throw new Error(plan.reason);
    db.prepare("DELETE FROM task_notes WHERE task_id = ?").run(tid("a"));
    addNote(db, "a", "a plain note", { workstream: "d" });
    const r = await run();
    expect(kinds(r)).toEqual(["replay:a", "spawn:b"]);
    expect(hook.sends[0]?.text).toBe(plan.plan.text);
  });

  it("a receipt that disagrees with the stored request ends the attempt once; the executor moves on", async () => {
    task("a", { max: 3 });
    task("b");
    expect(reserveAttempt(db, "d", "a").ok).toBe(true);
    db.prepare("UPDATE spawn_receipts SET request_sha = 'x' WHERE task_id = ?").run(tid("a"));
    const r1 = await run();
    expect(r1.moves[0]).toMatchObject({ kind: "failed", task: "a", key: "auto:1" });
    expect(readAttempt(db, tid("a")).record?.end).toMatchObject({ state: "abandoned" });
    expect(pendingAttempts(db, "d")).toEqual([]);
    expect(hook.sends).toEqual([]);
    // Not replayed again: the next attempt is a NEW key and a new charge, under the ceiling.
    const r2 = await run();
    expect(kinds(r2)).toEqual(["spawn:a", "spawn:b"]);
    expect(r2.moves[0]).toMatchObject({ key: "auto:2" });
    expect(runsOf("a")).toBe(2);
  });
});

describe("the cap counts every external effect", () => {
  it("a spawn rolled back by the send guard is an effect: cap 1 spawns exactly one pane", async () => {
    task("a", { max: 3 });
    task("b", { max: 3 });
    task("c", { max: 3 });
    hook.afterSpawn = () =>
      void db
        .prepare("UPDATE task_auto SET enabled = 0 WHERE task_id IN (?, ?, ?)")
        .run(tid("a"), tid("b"), tid("c"));
    const r = await run({ cap: 1 });
    expect(hook.spawns).toHaveLength(1);
    expect(r.used).toBe(1);
    expect(r.moves[0]).toMatchObject({ kind: "rolled_back" });
  });

  it("a guard refusal before the pane stays a free skip", async () => {
    task("a", { max: 3 });
    expect(reserveAttempt(db, "d", "a").ok).toBe(true);
    db.prepare("UPDATE tasks SET substate = 'parked' WHERE local_id = 'a'").run();
    const r = await run();
    expect(r.used).toBe(0);
    expect(hook.spawns).toEqual([]);
  });
});

describe("this caller's human need before each effect", () => {
  it("a need recorded while the pane starts stops the send: 0 sends, rolled back, stopped human", async () => {
    task("a", { max: 3 });
    task("b");
    hook.afterSpawn = () =>
      void recordHumanNeeded(db, { workstream: "d", caller: "orch", reason: "during spawn" });
    const r = await run();
    expect(hook.sends).toEqual([]);
    expect(r.moves[0]).toMatchObject({ kind: "rolled_back", task: "a" });
    expect(r.stopped).toBe("human");
    expect(r.human_needed).toHaveLength(1);
    expect(receiptOf("a", "auto:1")?.state).toBe("failed");
    expect(getTask(db, "a", "d")).toMatchObject({ ownerId: null });
    expect(hook.spawns).toHaveLength(1); // b was never started
  });
});

describe("spawnAutoAttempt, called directly", () => {
  let textOf = "PROMPT";
  const req = (key: string, guard: (p: "spawn" | "send") => void = () => {}) => ({
    task: "a",
    text: textOf,
    key,
    guard,
    spawn: { name: "a-1", workstream: "d", cli: "pi", nextFree: true },
  });

  it("a failed auto key is never reset or reused: SpawnAttemptFailedError, no spawn", async () => {
    task("a", { max: 3 });
    hook.spawnFails = () => new Error("tmux said no");
    await run();
    expect(receiptOf("a", "auto:1")?.state).toBe("failed");
    hook.spawnFails = undefined;
    hook.spawns = [];
    const { spawnAutoAttempt } = await import("../src/agents/task-spawn.js");
    const { SpawnAttemptFailedError } = await import("../src/agents/errors.js");
    await expect(spawnAutoAttempt(db, req("auto:1"))).rejects.toBeInstanceOf(
      SpawnAttemptFailedError,
    );
    expect(hook.spawns).toEqual([]);
    expect(receiptOf("a", "auto:1")?.state).toBe("failed");
  });

  it("a revoke between reserve and pane stops before any spawn (guard asked at 'spawn')", async () => {
    task("a", { max: 3 });
    const plan = reserveAttempt(db, "d", "a");
    if (!plan.ok) throw new Error(plan.reason);
    textOf = plan.plan.text;
    const phases: string[] = [];
    const { spawnAutoAttempt } = await import("../src/agents/task-spawn.js");
    const { SpawnAttemptGuardError } = await import("../src/agents/errors.js");
    await expect(
      spawnAutoAttempt(
        db,
        req("auto:1", (p) => {
          phases.push(p);
          throw new SpawnAttemptGuardError("a", "auto:1", "revoked");
        }),
      ),
    ).rejects.toBeInstanceOf(SpawnAttemptGuardError);
    expect(phases).toEqual(["spawn"]);
    expect(hook.spawns).toEqual([]);
    expect(receiptOf("a", "auto:1")?.state).toBe("reserved");
  });

  it("an unreserved key is refused", async () => {
    task("a", { max: 3 });
    const { spawnAutoAttempt } = await import("../src/agents/task-spawn.js");
    const { SpawnAttemptFailedError } = await import("../src/agents/errors.js");
    await expect(spawnAutoAttempt(db, req("auto:9"))).rejects.toBeInstanceOf(
      SpawnAttemptFailedError,
    );
    expect(hook.spawns).toEqual([]);
  });
});

describe("reserveAttempt at the ceiling", () => {
  it("refuses an exhausted task even after its attempt failed, and charges nothing", () => {
    task("a", { max: 1 });
    expect(reserveAttempt(db, "d", "a").ok).toBe(true);
    db.prepare("UPDATE spawn_receipts SET state = 'failed' WHERE task_id = ?").run(tid("a"));
    expect(reserveAttempt(db, "d", "a")).toMatchObject({ ok: false, code: "ceiling" });
    expect(runsOf("a")).toBe(1);
    expect(receiptOf("a", "auto:2")).toBeUndefined();
  });
});
