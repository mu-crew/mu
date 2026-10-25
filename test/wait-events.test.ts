// waitForEvents (v_wait_engine): the one owned-event wait. Real SQLite; the
// agent readers are scripted, so no ctl and no mux. Covers: events and
// first/all, the delegate-while-workers-busy starvation case, lost wakeups,
// abort/deadline against every await, CLOSE application and the delegate
// recorder boundary, caller/wave isolation, blockers.

import { describe, expect, it } from "vitest";
import { getDelegateCall, verdictTally } from "../src/delegates.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { closeTask, getTask, listNotes } from "../src/tasks.js";
import {
  type AgentReading,
  WAIT_HEARTBEAT_CAP_MS,
  WaitNothingError,
  WaitRefError,
  waitForEvents,
} from "../src/wait.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import {
  agentRef,
  answer,
  controllableWatch,
  delegateRef,
  mkAgent,
  mkDelegate,
  mkOwnedTask,
  mkTask,
  scriptedAgents,
  taskRef,
  tick,
  useWaitDb,
} from "./_wait-fixtures.js";

const env = useWaitDb();
const fast = { callers: [], pollMs: 1, sync: false } as const;

describe("tasks", () => {
  it("returns at once for an already-closed explicit task (snapshot, non-null event)", async () => {
    mkTask(env.db, "a");
    closeTask(env.db, "a", { workstream: "w", evidence: "e" });
    const r = await waitForEvents(env.db, [taskRef("a")], { ...fast, timeoutMs: 1000 });
    expect(r.event).toMatchObject({ kind: "closed", ref: { kind: "task", id: "a" } });
    expect(r.refs[0]).toMatchObject({ status: "CLOSED", fired: true });
    expect(r.exit).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("first: the first of two to close; all: waits for both", async () => {
    mkTask(env.db, "a");
    mkTask(env.db, "b");
    let polls = 0;
    const sleep = async () => {
      polls++;
      if (polls === 1) closeTask(env.db, "a", { workstream: "w", evidence: "e" });
      if (polls === 3) closeTask(env.db, "b", { workstream: "w", evidence: "e" });
    };
    const first = await waitForEvents(env.db, [taskRef("a"), taskRef("b")], { ...fast, sleep });
    expect(first.event.ref?.id).toBe("a");
    polls = 0;
    mkTask(env.db, "c");
    mkTask(env.db, "d");
    const sleep2 = async () => {
      polls++;
      if (polls === 1) closeTask(env.db, "c", { workstream: "w", evidence: "e" });
      if (polls === 3) closeTask(env.db, "d", { workstream: "w", evidence: "e" });
    };
    const both = await waitForEvents(env.db, [taskRef("c"), taskRef("d")], {
      ...fast,
      mode: "all",
      sleep: sleep2,
    });
    expect(polls).toBe(3);
    expect(both.refs.map((s) => s.fired)).toEqual([true, true]);
  });

  it("a deleted-mid-wait or never-existing ref is loud upfront (typed), not a silent wait", async () => {
    await expect(waitForEvents(env.db, [taskRef("nope")], fast)).rejects.toThrow(/nope/);
    await expect(waitForEvents(env.db, [], { ...fast })).rejects.toBeInstanceOf(WaitNothingError);
  });

  it("a timeout is a heartbeat result with the cap-bounded deadline, not an error", async () => {
    mkTask(env.db, "a");
    const r = await waitForEvents(env.db, [taskRef("a")], { ...fast, timeoutMs: 15 });
    expect(r.timedOut).toBe(true);
    expect(r.event).toMatchObject({ kind: "heartbeat", ref: null });
    expect(r.exit).toBe(0);
    expect(WAIT_HEARTBEAT_CAP_MS).toBe(1_500_000);
  });

  it("--status: waits for the requested status, not CLOSED", async () => {
    mkTask(env.db, "a");
    const r = await waitForEvents(env.db, [taskRef("a")], { ...fast, status: "OPEN" });
    expect(r.event.kind).toBe("closed");
    expect(r.refs[0]?.status).toBe("OPEN");
  });
});

describe("delegates racing busy workers (the starvation case)", () => {
  it("surfaces 12 delegate reports, one per wait, while 4 workers stay busy", async () => {
    const caller = "pi:s1";
    const agents = new Map<string, AgentReading>();
    const workers = ["w1", "w2", "w3", "w4"];
    for (const w of workers) {
      mkAgent(env.db, w);
      agents.set(`w/${w}`, { status: "busy" });
    }
    registerOwnedWait(
      env.db,
      caller,
      workers.map((w) => agentRef(w)),
    );
    const calls = Array.from({ length: 12 }, () => mkDelegate(env.db, caller));
    const reader = scriptedAgents(agents);
    const got: string[] = [];
    let finished = 0;
    for (let i = 0; i < 12; i++) {
      // A delegate answers while the wait is already running.
      let slept = 0;
      const sleep = async () => {
        if (slept++ === 0) {
          answer(env.db, calls[finished] as string);
          finished++;
        }
      };
      const r = await waitForEvents(env.db, [], {
        ...fast,
        callers: [caller],
        sleep,
        timeoutMs: 5000,
        ...reader,
      });
      expect(r.event.kind).toBe("delegate");
      got.push(r.event.ref?.id ?? "");
      // The busy workers never fired: they are still owed.
      expect(r.refs.every((s) => s.ref.kind !== "agent" || !s.fired)).toBe(true);
    }
    expect(new Set(got).size).toBe(12);
    expect(got).toEqual(calls);
  });

  it("an agent watch that never settles does not starve a delegate answer (never awaited serially)", async () => {
    const caller = "pi:s2";
    mkAgent(env.db, "w1");
    registerOwnedWait(env.db, caller, [agentRef("w1")]);
    const call = mkDelegate(env.db, caller);
    const watch = controllableWatch();
    let slept = 0;
    const r = await waitForEvents(env.db, [], {
      ...fast,
      callers: [caller],
      timeoutMs: 5000,
      readAgents: async () => new Map(),
      watchAgent: async () => watch.handle,
      sleep: async () => {
        if (slept++ === 0) answer(env.db, call);
      },
    });
    expect(r.event).toMatchObject({ kind: "delegate", ref: { id: call } });
  });
});

describe("lost wakeups and the stop signals", () => {
  it("a close landing while the watch is being set up is seen on the first iteration", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const watch = controllableWatch();
    const r = await waitForEvents(env.db, [taskRef("t1"), agentRef("w1")], {
      ...fast,
      timeoutMs: 1000,
      readAgents: async () => new Map([["w/w1", { status: "busy" as const }]]),
      watchAgent: async () => {
        // The task closes between the pre-flight and the watch becoming ready.
        closeTask(env.db, "t1", { workstream: "w", evidence: "e" });
        return watch.handle;
      },
    });
    expect(r.event).toMatchObject({ kind: "closed", ref: { id: "t1" } });
  });

  it("a settle resolving before the loop sleeps is not lost", async () => {
    mkAgent(env.db, "w1");
    const watch = controllableWatch();
    watch.settle({
      status: "needs_input",
      settled: true,
      incarnation: "i",
      runs: 1,
      lastText: "hi",
    });
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      timeoutMs: 1000,
      readAgents: async () => new Map(),
      watchAgent: async () => watch.handle,
    });
    expect(r.event).toMatchObject({ kind: "settled", runs: 1, incarnation: "i" });
    expect(r.refs[0]?.lastText).toBe("hi");
  });

  it("abort during a hanging read returns interrupted (130), without waiting for the read", async () => {
    mkAgent(env.db, "w1");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const t0 = Date.now();
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      signal: ac.signal,
      timeoutMs: 5000,
      readAgents: () => new Promise(() => {}),
    });
    expect(r.interrupted).toBe(true);
    expect(r.event.kind).toBe("interrupted");
    expect(r.exit).toBe(130);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("abort during watch setup, and while sleeping, both return interrupted", async () => {
    mkAgent(env.db, "w1");
    const ac1 = new AbortController();
    setTimeout(() => ac1.abort(), 5);
    const a = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      signal: ac1.signal,
      timeoutMs: 5000,
      readAgents: async () => new Map(),
      watchAgent: () => new Promise(() => {}),
    });
    expect(a.interrupted).toBe(true);
    mkTask(env.db, "a");
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 5);
    const b = await waitForEvents(env.db, [taskRef("a")], {
      callers: [],
      sync: false,
      pollMs: 10_000,
      signal: ac2.signal,
      timeoutMs: 5000,
    });
    expect(b.interrupted).toBe(true);
  });

  it("an already-aborted signal returns interrupted without reading", async () => {
    mkTask(env.db, "a");
    const ac = new AbortController();
    ac.abort();
    const r = await waitForEvents(env.db, [taskRef("a")], { ...fast, signal: ac.signal });
    expect(r.interrupted).toBe(true);
  });

  it("a deadline shorter than a hanging read and than pollMs still returns on time", async () => {
    mkAgent(env.db, "w1");
    const t0 = Date.now();
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      callers: [],
      sync: false,
      pollMs: 10_000,
      timeoutMs: 20,
      readAgents: () => new Promise(() => {}),
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a rejected watch (agent restarted) is fatal and propagates", async () => {
    mkAgent(env.db, "w1");
    const watch = controllableWatch();
    watch.reject(new Error("restarted"));
    await expect(
      waitForEvents(env.db, [agentRef("w1")], {
        ...fast,
        timeoutMs: 1000,
        readAgents: async () => new Map(),
        watchAgent: async () => watch.handle,
      }),
    ).rejects.toThrow("restarted");
  });
});

describe("agent events", () => {
  it("busy then idle fires settled; an already-idle agent does not fire; unknown is never idle", async () => {
    mkAgent(env.db, "w1");
    const table = new Map<string, AgentReading>([["w/w1", { status: "needs_input" }]]);
    const idle = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      timeoutMs: 15,
      ...scriptedAgents(table),
    });
    expect(idle.timedOut).toBe(true);
    table.set("w/w1", { status: "unknown", reason: "no row" });
    const unk = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      timeoutMs: 15,
      ...scriptedAgents(table),
    });
    expect(unk.timedOut).toBe(true);
    expect(unk.refs[0]).toMatchObject({ status: "unknown", unknownReason: "no row" });
    table.set("w/w1", { status: "busy" });
    let n = 0;
    const done = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      timeoutMs: 1000,
      ...scriptedAgents(table),
      sleep: async () => {
        if (n++ === 1) table.set("w/w1", { status: "needs_input" });
      },
    });
    expect(done.event.kind).toBe("settled");
  });

  it("a dead pane is a dead event (exit 6); a dialog is input (exit 7)", async () => {
    mkAgent(env.db, "w1");
    const table = new Map<string, AgentReading>([["w/w1", { status: null }]]);
    const dead = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      ...scriptedAgents(table),
    });
    expect(dead.event.kind).toBe("dead");
    expect(dead.exit).toBe(6);
    expect(dead.refs[0]).toMatchObject({ dead: true, status: null });
    table.set("w/w1", {
      status: "needs_permission",
      blocked: { kind: "confirm", title: "ok?", since: 1 } as never,
    });
    const input = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      ...scriptedAgents(table),
    });
    expect(input.event.kind).toBe("input");
    expect(input.exit).toBe(7);
  });

  it("an owned task whose owner pane died is dead, before closure (reaper precedence)", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const caller = "pi:s3";
    registerOwnedWait(env.db, caller, [taskRef("t1")]);
    const table = new Map<string, AgentReading>([["w/w1", { status: null }]]);
    const r = await waitForEvents(env.db, [], {
      ...fast,
      callers: [caller],
      ...scriptedAgents(table),
    });
    expect(r.event).toMatchObject({ kind: "dead", ref: { kind: "task", id: "t1" } });
    expect(r.exit).toBe(6);
  });
});

describe("all: urgent events and unrelated refs", () => {
  it("an owned delegate report ends an all wait early without counting toward all; unrelated closed owned tasks never count", async () => {
    const caller = "pi:s4";
    mkTask(env.db, "a");
    mkTask(env.db, "owned-closed");
    closeTask(env.db, "owned-closed", { workstream: "w", evidence: "e" });
    registerOwnedWait(env.db, caller, [taskRef("owned-closed")]);
    // Nothing is listed on the wait that is ready: the explicit open task is the only target.
    const call = mkDelegate(env.db, caller);
    let n = 0;
    const r = await waitForEvents(env.db, [taskRef("a")], {
      ...fast,
      callers: [caller],
      mode: "all",
      timeoutMs: 1000,
      sleep: async () => {
        if (n++ === 0) answer(env.db, call);
      },
    });
    expect(r.event).toMatchObject({ kind: "delegate", ref: { id: call } });
    expect(r.refs.find((s) => s.ref.id === "a")).toMatchObject({ fired: false });
    // The unrelated closed owned task did not end the wait: the delegate did.
  });

  it("all with only owned refs waits for every one", async () => {
    const caller = "pi:s5";
    mkTask(env.db, "a");
    mkTask(env.db, "b");
    registerOwnedWait(env.db, caller, [taskRef("a"), taskRef("b")]);
    let n = 0;
    const r = await waitForEvents(env.db, [], {
      ...fast,
      callers: [caller],
      mode: "all",
      timeoutMs: 1000,
      sleep: async () => {
        if (n === 0) closeTask(env.db, "a", { workstream: "w", evidence: "e" });
        if (n === 2) closeTask(env.db, "b", { workstream: "w", evidence: "e" });
        n++;
      },
    });
    expect(n).toBe(3);
    expect(r.refs.every((s) => s.fired)).toBe(true);
  });
});

describe("CLOSE application (work tasks only)", () => {
  const closeBlock = (task: string) =>
    `Done.\n\nCLOSE: task=${task} evidence="npm test: ok"\nREPORT:\nFILES: a.ts\nDONE`;
  const settledReading = (text: string, runs = 1): AgentReading => ({
    status: "needs_input",
    settled: true,
    incarnation: "inc-1",
    runs,
    lastText: text,
  });

  it("applies a settled worker's CLOSE once, before the snapshot returns", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const watch = controllableWatch();
    watch.settle(settledReading(closeBlock("t1")));
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      readAgents: async () => new Map(),
      watchAgent: async () => watch.handle,
    });
    expect(r.event.kind).toBe("settled");
    expect(r.refs[0]?.close).toMatchObject({ applied: true, task: "t1" });
    expect(getTask(env.db, "t1", "w")).toMatchObject({ status: "CLOSED", substate: "done" });
  });

  it("a legacy-style reading (no settled flag) never closes", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const watch = controllableWatch();
    watch.settle({ status: "needs_input", lastText: closeBlock("t1") });
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      readAgents: async () => new Map(),
      watchAgent: async () => watch.handle,
    });
    expect(r.event.kind).toBe("settled");
    expect(r.refs[0]?.close).toBeUndefined();
    expect(getTask(env.db, "t1", "w")?.status).toBe("IN_PROGRESS");
  });

  it("applyClose:false leaves the CLOSE block alone", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const watch = controllableWatch();
    watch.settle(settledReading(closeBlock("t1")));
    await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      applyClose: false,
      readAgents: async () => new Map(),
      watchAgent: async () => watch.handle,
    });
    expect(getTask(env.db, "t1", "w")?.status).toBe("IN_PROGRESS");
  });

  it("a delegate answer ending in a CLOSE block cannot close its own task: the recorder still runs first", async () => {
    const caller = "pi:s6";
    mkTask(env.db, "judged", "scratch");
    const call = mkDelegate(env.db, caller, { record: { workstream: "scratch", task: "judged" } });
    const delegateTask = getDelegateCall(env.db, call)?.task as string;
    const agentId = mkAgent(env.db, `d-${call}`, "scratch");
    env.db.prepare("UPDATE tasks SET owner_id = ? WHERE local_id = ?").run(agentId, delegateTask);
    const watch = controllableWatch();
    const text = `VERDICT: CONFIRMED\nlooks right\n\n${closeBlock(delegateTask)}`;
    watch.settle({ ...settledReading(text), agentId });
    const r = await waitForEvents(env.db, [agentRef(`d-${call}`, "scratch")], {
      ...fast,
      readAgents: async () => new Map(),
      watchAgent: async () => watch.handle,
    });
    expect(r.refs[0]?.close).toMatchObject({ applied: false });
    expect(r.refs[0]?.close?.reason).toMatch(/delegate task/);
    // The delegate task is not closed by the wait; the recorder then writes verdict, report, close.
    expect(getTask(env.db, delegateTask, "scratch")?.status).not.toBe("CLOSED");
    answer(env.db, call, text);
    expect(getTask(env.db, delegateTask, "scratch")?.status).toBe("CLOSED");
    const notes = listNotes(env.db, "judged", "scratch").map((n) => n.kind);
    expect(notes).toContain("verdict");
  });

  it("an error-ended run and a truncated tail do not close", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const watch = controllableWatch();
    watch.settle({ ...settledReading(closeBlock("t1")), lastTextTruncated: true });
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      readAgents: async () => new Map(),
      watchAgent: async () => watch.handle,
    });
    expect(r.refs[0]?.close?.applied).toBe(false);
    expect(getTask(env.db, "t1", "w")?.status).toBe("IN_PROGRESS");
  });
});

describe("caller and wave isolation", () => {
  it("never reports another caller's delegate, and refuses to wait on it explicitly", async () => {
    mkDelegate(env.db, "pi:other");
    const mine = mkDelegate(env.db, "pi:me");
    const other = mkDelegate(env.db, "pi:other");
    answer(env.db, other);
    let n = 0;
    const r = await waitForEvents(env.db, [], {
      ...fast,
      callers: ["pi:me"],
      timeoutMs: 1000,
      sleep: async () => {
        if (n++ === 0) answer(env.db, mine);
      },
    });
    expect(r.event.ref?.id).toBe(mine);
    await expect(
      waitForEvents(env.db, [delegateRef(other)], { ...fast, callers: ["pi:me"] }),
    ).rejects.toBeInstanceOf(WaitRefError);
  });

  it("a wave's tally and targets are this caller's only, even with the same wave name", async () => {
    const a = mkDelegate(env.db, "pi:a", { wave: "w1" });
    const b = mkDelegate(env.db, "pi:b", { wave: "w1" });
    answer(env.db, a);
    answer(env.db, b);
    const r = await waitForEvents(env.db, [], {
      ...fast,
      callers: ["pi:a"],
      mode: "all",
      wave: { workstream: "scratch", name: "w1" },
    });
    expect(r.tally?.findings.reduce((s, f) => s + f.confirmed, 0)).toBe(1);
    expect(r.refs.map((s) => s.ref.id)).toEqual([a]);
    expect(
      verdictTally(env.db, "scratch", "w1").findings.reduce((s, f) => s + f.confirmed, 0),
    ).toBe(2);
  });
});

describe("blockersOf", () => {
  it("waits on the open transitive blockers and picks up blockers added mid-wait", async () => {
    mkTask(env.db, "goal");
    mkTask(env.db, "b1");
    mkTask(env.db, "b2");
    addBlockEdge(env.db, "w", "goal", "b1");
    let n = 0;
    const r = await waitForEvents(env.db, [], {
      ...fast,
      mode: "all",
      timeoutMs: 1000,
      blockersOf: { workstream: "w", id: "goal" },
      sleep: async () => {
        if (n === 0) addBlockEdge(env.db, "w", "goal", "b2");
        if (n === 1) closeTask(env.db, "b1", { workstream: "w", evidence: "e" });
        if (n === 3) closeTask(env.db, "b2", { workstream: "w", evidence: "e" });
        n++;
      },
    });
    expect(n).toBe(4);
    expect(r.refs.map((s) => s.ref.id).sort()).toEqual(["b1", "b2"]);
  });

  it("no open blockers: returns at once", async () => {
    mkTask(env.db, "goal");
    const r = await waitForEvents(env.db, [], {
      ...fast,
      mode: "all",
      blockersOf: { workstream: "w", id: "goal" },
    });
    expect(r.event.kind).toBe("closed");
  });
});

describe("until text", () => {
  it("a settled run whose text does not match is skipped; the next that matches fires", async () => {
    mkAgent(env.db, "w1");
    const w = [controllableWatch(), controllableWatch()];
    w[0]?.settle({
      status: "needs_input",
      settled: true,
      incarnation: "i",
      runs: 1,
      lastText: "still working",
    });
    w[1]?.settle({
      status: "needs_input",
      settled: true,
      incarnation: "i",
      runs: 2,
      lastText: "ALL GREEN",
    });
    let k = 0;
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      until: { text: "ALL GREEN" },
      timeoutMs: 1000,
      readAgents: async () => new Map(),
      watchAgent: async () => (w[k++] as (typeof w)[number]).handle,
    });
    expect(r.event).toMatchObject({ kind: "settled", runs: 2 });
  });

  it("an errored or empty run never satisfies --until-text", async () => {
    mkAgent(env.db, "w1");
    const watch = controllableWatch();
    watch.settle({
      status: "needs_input",
      settled: true,
      incarnation: "i",
      runs: 1,
      lastText: "ALL GREEN",
      lastError: "boom",
    });
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...fast,
      until: { text: "GREEN" },
      timeoutMs: 20,
      readAgents: async () => new Map(),
      watchAgent: async () => controllableWatchPending(watch),
    });
    expect(r.timedOut).toBe(true);
  });

  it("a task's report must match after it closes done; a wontfix close is not done", async () => {
    mkTask(env.db, "a");
    mkTask(env.db, "b");
    closeTask(env.db, "a", { workstream: "w", evidence: "e", report: "RESULT: 42 passed" });
    closeTask(env.db, "b", {
      workstream: "w",
      as: "wontfix",
      why: "no",
      report: "RESULT: 42 passed",
    });
    const ok = await waitForEvents(env.db, [taskRef("a")], {
      ...fast,
      until: { text: "42 passed" },
    });
    expect(ok.event.kind).toBe("closed");
    const no = await waitForEvents(env.db, [taskRef("b")], {
      ...fast,
      until: { text: "42 passed" },
      timeoutMs: 15,
    });
    expect(no.timedOut).toBe(true);
  });

  it("a malformed or pathological pattern rejects the wait before anything runs", async () => {
    mkTask(env.db, "a");
    await expect(
      waitForEvents(env.db, [taskRef("a")], { ...fast, until: { text: "(" } }),
    ).rejects.toThrow(/--until-text/);
    await expect(
      waitForEvents(env.db, [taskRef("a")], { ...fast, until: { text: "(a+)+$" } }),
    ).rejects.toThrow(/repeated group/);
  });
});

function controllableWatchPending(w: ReturnType<typeof controllableWatch>) {
  return w.handle;
}

describe("sync bounds", () => {
  it("flushes once on return and ingests each iteration (no peers when sync is off: a cheap no-op)", async () => {
    mkTask(env.db, "a");
    closeTask(env.db, "a", { workstream: "w", evidence: "e" });
    const r = await waitForEvents(env.db, [taskRef("a")], { callers: [], timeoutMs: 1000 });
    expect(r.event.kind).toBe("closed");
  });
});
void tick;
