// `executeNext --refute` (v_exec_refute): the opt-in durable checker. Real SQLite in a temp
// dir; spawnAgent, the send transport and the checker reader are the only fakes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  spawns: [] as string[],
  sends: [] as { agent: string; text: string }[],
  checks: [] as string[],
  panes: 0,
  spawnFails: undefined as undefined | (() => Error),
  afterSpawn: undefined as undefined | (() => void),
  sendMode: "ok" as "ok" | "throws",
  checkState: "unreachable" as "accepted" | "not-accepted" | "unreachable",
}));
vi.mock("../src/agents/spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/spawn.js")>();
  return {
    ...actual,
    spawnAgent: async (
      db: import("../src/db.js").Db,
      opts: { name: string; workstream: string; onIdentity?: (a: unknown) => void },
    ) => {
      // Import HERE, not in the factory body: agents.js imports spawn.js, which is being
      // mocked, so awaiting it while the factory runs deadlocks collection (0% CPU, and
      // no test timeout can fire because no test has started).
      const { insertAgent } = await import("../src/agents.js");
      hook.spawns.push(opts.name);
      if (hook.spawnFails !== undefined) throw hook.spawnFails();
      const row = insertAgent(db, {
        name: opts.name,
        workstream: opts.workstream,
        paneId: `%${++hook.panes}`,
      });
      opts.onIdentity?.(row);
      hook.afterSpawn?.();
      return { ...row, ctl: "ok", ctlSocket: "/fake.sock" };
    },
  };
});
vi.mock("../src/agents/transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/transport.js")>();
  return {
    ...actual,
    sendViaTransport: async (a: { name: string }, text: string, o: { msgId?: string }) => {
      hook.sends.push({ agent: a.name, text });
      if (hook.sendMode === "throws") throw new Error("socket vanished mid-write");
      return { transport: "ctl", runs: 0, msgId: o.msgId, incarnation: "pi-inc" };
    },
    checkMessage: async (_s: string, msgId: string) => {
      hook.checks.push(msgId);
      return hook.checkState === "accepted"
        ? { state: "accepted", incarnation: "pi-inc", runs: 1 }
        : hook.checkState === "not-accepted"
          ? { state: "not-accepted" }
          : { state: "unreachable", reason: "no socket" };
    },
  };
});

// Loaded before anything else needs the mocked spawn (the next-executor suite imports it too).
import "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { getDelegateCall, registerDelegateCall, verdictTally } from "../src/delegates.js";
import { executeNext, NextArgError, type NextResult } from "../src/next.js";
import type { CheckerReading } from "../src/next-refute.js";
import { authorizeTasks } from "../src/task-auto.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { getTask, selectTaskNotes } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";

let dir: string;
let db: Db;
let mux: MuxHarness;
let reading: CheckerReading;
let reads: number;

beforeEach(() => {
  hook.spawns = [];
  hook.sends = [];
  hook.checks = [];
  hook.panes = 0;
  hook.spawnFails = undefined;
  hook.afterSpawn = undefined;
  hook.sendMode = "ok";
  hook.checkState = "unreachable";
  reading = { kind: "running" };
  reads = 0;
  dir = mkdtempSync(join(tmpdir(), "mu-refute-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "d");
  mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
});
afterEach(() => {
  mux.restore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const alive: import("../src/next-recover.js").ObserveWorkers = async (agents) =>
  new Map(
    agents.map((a) => [
      `${a.workstreamName}/${a.name}`,
      { status: "busy" as const, ctl: "ok" as const },
    ]),
  );
const run = (o: Partial<Parameters<typeof executeNext>[1]> = {}) =>
  executeNext(db, {
    workstream: "d",
    caller: "pi:s1",
    ingest: async () => {},
    observe: alive,
    readChecker: async () => {
      reads++;
      return reading;
    },
    refute: true,
    ...o,
  });
const notes = (id: string, ws = "d") => selectTaskNotes(db, id, { workstream: ws }).notes;
const kinds = (r: NextResult) => r.moves.map((m) => `${m.kind}:${m.task}`);
const callId = "refute:d:a:auto:1";

/** A worker delivered `id` (one attempt), reported and closed it as `as`. */
async function closed(id: string, as: "done" | "wontfix" = "done"): Promise<void> {
  addTask(db, { workstream: "d", localId: id, title: id });
  addNote(db, id, `BRIEF for ${id}`, { workstream: "d", kind: "brief", author: "orch" });
  authorizeTasks(db, [id], { workstream: "d", cli: "pi", worktree: false, maxRuns: 2 });
  await run({ refute: false });
  closeTask(
    db,
    id,
    as === "done"
      ? { workstream: "d", as, evidence: "npm test: green", report: `REPORT of ${id}` }
      : { workstream: "d", as, why: "not needed", report: `REPORT of ${id}` },
  );
}
const refutes = () => hook.spawns.filter((n) => n.startsWith("delegate-"));
const verdictNotes = (id: string) => notes(id).filter((n) => n.kind === "verdict");

describe("--refute: one durable checker per CLOSED attempt", () => {
  it("launches in scratch with the pinned brief and the actual report; the call is registered first and running after", async () => {
    await closed("a");
    const r = await run();
    expect(kinds(r)).toEqual(["refute:a"]);
    expect(r.moves[0]).toMatchObject({ key: callId, state: "running", cli: "pi" });
    expect(refutes()).toEqual(["delegate-refute-a"]);
    const call = getDelegateCall(db, callId);
    expect(call).toMatchObject({
      state: "running",
      caller: "pi:s1",
      workstream: "scratch",
      wave: "refute-d",
      record: { workstream: "d", task: "a" },
    });
    const sent = hook.sends.at(-1)?.text ?? "";
    expect(sent).toMatch(/Pinned brief \(note #1\):\nBRIEF for a/);
    expect(sent).toMatch(/report \(note #\d+\):\nREPORT of a/);
    expect(r.used).toBe(1);
  });

  it("is opt-in: without --refute nothing is registered; a non-done close has no claim to check", async () => {
    await closed("a");
    await closed("w", "wontfix");
    await run({ refute: false });
    expect(getDelegateCall(db, callId)).toBeUndefined();
    const r = await run();
    expect(kinds(r)).toEqual(["refute:a"]);
    expect(getDelegateCall(db, "refute:d:w:auto:1")).toBeUndefined();
  });

  it("records the verdict on the judged task BEFORE the call closes; the judged work is untouched", async () => {
    await closed("a");
    await run();
    const before = db.prepare("SELECT * FROM task_auto").all();
    reading = {
      kind: "answer",
      outcome: "done",
      text: "VERDICT: REFUTED\nEVIDENCE: ran npm test, 2 failed",
    };
    const r = await run();
    expect(r.moves[0]).toMatchObject({ kind: "refute", state: "done", verdict: "REFUTED" });
    expect(verdictNotes("a")).toHaveLength(1);
    expect(verdictNotes("a")[0]?.content).toContain("ran npm test, 2 failed");
    expect(getTask(db, "a", "d")).toMatchObject({ status: "CLOSED", substate: "done" });
    expect(db.prepare("SELECT * FROM task_auto").all()).toEqual(before);
    // finishDelegate writes the verdict note, then the call task's report and close, in one group.
    const callTask = getDelegateCall(db, callId)?.task ?? "";
    expect(getTask(db, callTask, "scratch")?.status).toBe("CLOSED");
    expect(notes(callTask, "scratch").some((n) => n.kind === "report")).toBe(true);
    expect(verdictTally(db, "scratch", "refute-d", ["pi:s1"]).findings).toEqual([
      { id: "d/a", confirmed: 0, refuted: 1, unverified: 0, pending: 0 },
    ]);
  });

  it("a duplicate or later invocation launches, reads and records nothing more", async () => {
    await closed("a");
    await run();
    reading = { kind: "answer", outcome: "done", text: "VERDICT: CONFIRMED\nEVIDENCE: ok" };
    await run();
    const spawns = hook.spawns.length;
    const r = await run();
    expect(r.moves).toEqual([]);
    expect(hook.spawns).toHaveLength(spawns);
    expect(verdictNotes("a")).toHaveLength(1);
  });

  it("a checker still running is read once per invocation and is not an extra effect on a second pass", async () => {
    await closed("a");
    await run();
    const r = await run();
    expect(r.moves[0]).toMatchObject({ kind: "refute", state: "running" });
    expect(reads).toBe(1);
    expect(verdictNotes("a")).toEqual([]);
  });

  it("a dead checker is recorded `died`: no verdict, an UNVERIFIED call, never retried", async () => {
    await closed("a");
    await run();
    reading = { kind: "died" };
    const r = await run();
    expect(r.moves[0]).toMatchObject({ state: "failed" });
    expect(verdictNotes("a")[0]?.content).toMatch(/no verdict \(died\)/);
    expect(verdictTally(db, "scratch", "refute-d", ["pi:s1"]).findings[0]?.unverified).toBe(1);
    expect((await run()).moves).toEqual([]);
  });

  it("a checker past its timeout is recorded `timeout`", async () => {
    await closed("a");
    await run();
    db.prepare("UPDATE delegate_calls SET updated_at = '2020-01-01T00:00:00.000Z'").run();
    const r = await run();
    expect(r.moves[0]).toMatchObject({ state: "failed" });
    expect(verdictNotes("a")[0]?.content).toMatch(/no verdict \(timeout\)/);
  });
});

describe("--refute: crash, failure and unknown delivery", () => {
  it("a crash after the registration resumes the SAME call; no second one is registered", async () => {
    await closed("a");
    registerDelegateCall(db, {
      callId,
      caller: "pi:s1",
      workstream: "scratch",
      wave: "refute-d",
      record: { workstream: "d", task: "a" },
      state: "starting",
      request: { text: "stale text", label: "refute-a", cli: "pi", timeoutS: 1800 },
    });
    const r = await run();
    expect(kinds(r)).toEqual(["refute:a"]);
    expect(getDelegateCall(db, callId)?.state).toBe("running");
    expect(db.prepare("SELECT COUNT(*) AS n FROM delegate_calls").get()).toEqual({ n: 1 });
  });

  it("an unsent spawn failure records the call failed (never reissued), stops the pass, and a later run does not retry", async () => {
    await closed("a");
    await closed("b");
    hook.spawnFails = () => new Error("tmux said no");
    const r = await run();
    expect(r.moves[0]).toMatchObject({ kind: "failed", task: "a" });
    expect(r.stopped).toBe("failed");
    expect(getDelegateCall(db, callId)?.state).toBe("failed");
    expect(verdictNotes("a")[0]?.content).toMatch(/no verdict/);
    hook.spawnFails = undefined;
    const r2 = await run();
    expect(kinds(r2)).toEqual(["refute:b"]); // a's check is over; b gets its own
    expect(getDelegateCall(db, "refute:d:b:auto:1")?.state).toBe("running");
  });

  it("an unknown first send is probed ONCE by the next invocation, never resent, then ends failed", async () => {
    await closed("a");
    hook.sendMode = "throws";
    const r1 = await run();
    expect(r1.moves[0]).toMatchObject({ kind: "refute", state: "starting" });
    const sends = hook.sends.length;
    hook.sendMode = "ok";
    const r2 = await run();
    expect(r2.moves[0]).toMatchObject({ kind: "refute", state: "failed" });
    expect(hook.checks).toHaveLength(1);
    expect(hook.sends).toHaveLength(sends);
    expect(refutes()).toHaveLength(1);
    expect((await run()).moves).toEqual([]);
  });

  it("a probe that confirms the send marks the call running", async () => {
    await closed("a");
    hook.sendMode = "throws";
    await run();
    hook.sendMode = "ok";
    hook.checkState = "accepted";
    const r = await run();
    expect(r.moves[0]).toMatchObject({ state: "running" });
    expect(hook.sends.filter((s) => s.agent.startsWith("delegate-"))).toHaveLength(1);
  });
});

describe("--refute: fences", () => {
  it("another caller's check under the same key is not touched or finished", async () => {
    await closed("a");
    registerDelegateCall(db, {
      callId,
      caller: "pi:other",
      workstream: "scratch",
      wave: "refute-d",
      record: { workstream: "d", task: "a" },
      state: "starting",
      request: { text: "theirs", label: "refute-a", cli: "pi" },
    });
    const r = await run();
    expect(r.moves).toEqual([]);
    expect(getDelegateCall(db, callId)).toMatchObject({ caller: "pi:other", state: "starting" });
    expect(refutes()).toEqual([]);
  });

  it("a revoked authorisation stops the checker for that task; a checker never grants permission", async () => {
    await closed("a");
    authorizeTasks(db, ["a"], {
      workstream: "d",
      cli: "pi",
      worktree: false,
      maxRuns: 2,
      off: true,
    });
    expect((await run()).moves).toEqual([]);
  });

  it("the cap counts launches and reads; the rest waits for the next invocation", async () => {
    await closed("a");
    await closed("b");
    const r = await run({ cap: 1 });
    expect(r).toMatchObject({ used: 1, stopped: "cap" });
    expect(kinds(r)).toEqual(["refute:a"]);
    expect(getDelegateCall(db, "refute:d:b:auto:1")).toBeUndefined();
  });

  it("--dry names the check and writes nothing", async () => {
    await closed("a");
    const before = db.prepare("SELECT COUNT(*) AS n FROM tasks").get();
    const r = await run({ dry: true });
    expect(r.moves[0]).toMatchObject({ kind: "refute", key: callId, state: "new" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual(before);
    expect(getDelegateCall(db, callId)).toBeUndefined();
    expect(refutes()).toEqual([]);
  });

  it("refuses with no caller identity, and a cli that cannot answer over ctl", async () => {
    await closed("a");
    await expect(run({ caller: "" })).rejects.toBeInstanceOf(NextArgError);
    const r = await run({ refuteCli: "plainsh" });
    expect(r.moves[0]).toMatchObject({ kind: "skip", cli: "plainsh" });
    expect(r.moves[0]?.reason).toMatch(/--refute-cli/);
    expect(getDelegateCall(db, callId)).toBeUndefined();
  });
});

describe("--refute with --hold", () => {
  it("a checker that settles is the executor's own event: it is read and recorded, then the wait goes on", async () => {
    await closed("a");
    await run();
    const seen: string[][] = [];
    let n = 0;
    const r = await run({
      hold: true,
      wait: async (_db, refs) => {
        seen.push(refs.map((x) => `${x.kind}:${x.id}`));
        reading = { kind: "answer", outcome: "done", text: "VERDICT: CONFIRMED\nEVIDENCE: ok" };
        const first = refs[0];
        const event =
          n++ === 0
            ? { kind: "settled" as const, ref: first ?? null }
            : { kind: "heartbeat" as const, ref: null };
        return { event, refs: [], exit: 0, timedOut: event.kind === "heartbeat" } as never;
      },
    });
    expect(seen[0]).toEqual(["agent:delegate-refute-a"]);
    expect(getDelegateCall(db, callId)).toMatchObject({ state: "done", verdict: "CONFIRMED" });
    expect(r.moves.map((m) => m.state)).toEqual(["running", "done"]);
  });
});
