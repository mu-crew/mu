// The frozen waitForEvents contract (v_wait_engine, ENGINE CONTRACT FROZEN):
// the callers SET, eventScope, humanNeeds, engine-owned stall detection with
// handleStall, WaitResult shape, and the producer fence (unconsumed baselines).
// Real SQLite; agents scripted, so no ctl and no mux.

import { describe, expect, it } from "vitest";
import { recordHumanNeeded } from "../src/human-needed.js";
import { closeTask } from "../src/tasks.js";
import {
  type AgentReading,
  type StallActionResult,
  WaitRefError,
  type WaitStallContext,
  waitForEvents,
} from "../src/wait.js";
import { currentCallers } from "../src/wait-callers.js";
import { cursorKey } from "../src/wait-cursor.js";
import {
  beginWait,
  endWait,
  readWaitRegistration,
  registerOwnedWait,
} from "../src/wait-registration.js";
import {
  agentRef,
  answer,
  mkAgent,
  mkDelegate,
  mkOwnedTask,
  mkTask,
  scriptedAgents,
  taskRef,
  useWaitDb,
} from "./_wait-fixtures.js";

const env = useWaitDb();
const base = { pollMs: 1, sync: false, timeoutMs: 1000 } as const;

describe("callers: a set", () => {
  it("currentCallers: managed ws/name and pi:<session>, either or both, never a guess", () => {
    expect(currentCallers({})).toEqual([]);
    expect(currentCallers({ USER: "x", TMUX_PANE: "%1" })).toEqual([]);
    expect(currentCallers({ PI_SESSION_ID: "s" })).toEqual(["pi:s"]);
    expect(
      currentCallers({ MU_MANAGED_AGENT: "1", MU_WORKSTREAM: "w", MU_AGENT_NAME: "o" }),
    ).toEqual(["w/o"]);
    expect(
      currentCallers({
        MU_MANAGED_AGENT: "1",
        MU_WORKSTREAM: "w",
        MU_AGENT_NAME: "o",
        PI_SESSION_ID: "s",
      }),
    ).toEqual(["w/o", "pi:s"]);
    expect(currentCallers({ MU_WORKSTREAM: "w", MU_AGENT_NAME: "o" })).toEqual([]);
  });

  it("owned refs (under ws/name) and delegates (under pi:session) are BOTH seen", async () => {
    mkTask(env.db, "a");
    closeTask(env.db, "a", { workstream: "w", evidence: "e" });
    registerOwnedWait(env.db, "w/orch", [taskRef("a")]);
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    const callers = ["w/orch", "pi:s"];
    const one = await waitForEvents(env.db, [], { ...base, callers });
    const two = await waitForEvents(env.db, [], { ...base, callers });
    expect(new Set([one.event.ref?.id, two.event.ref?.id])).toEqual(new Set(["a", call]));
    // Each was consumed by the caller that owned it.
    expect(readWaitRegistration(env.db, "w/orch")?.refs).toEqual([]);
    const cursors = env.db.prepare("SELECT caller, ref FROM wait_cursors ORDER BY ref").all();
    expect(cursors).toEqual([
      { caller: "pi:s", ref: cursorKey("delegate", "scratch", call) },
      { caller: "w/orch", ref: cursorKey("task", "w", "a") },
    ]);
  });

  it("a single name sees only its own: ws/name alone misses the pi:session delegate", async () => {
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    mkTask(env.db, "a");
    registerOwnedWait(env.db, "w/orch", [taskRef("a")]);
    const r = await waitForEvents(env.db, [], { ...base, callers: ["w/orch"], timeoutMs: 15 });
    expect(r.timedOut).toBe(true);
  });

  it("human needs and the tally are the callers' union and nobody else's", async () => {
    recordHumanNeeded(env.db, { workstream: "w", caller: "w/orch", reason: "pick a licence" });
    recordHumanNeeded(env.db, { workstream: "w", caller: "w/other", reason: "not mine" });
    const a = mkDelegate(env.db, "pi:s", { wave: "v" });
    const b = mkDelegate(env.db, "pi:other", { wave: "v" });
    answer(env.db, a);
    answer(env.db, b);
    const r = await waitForEvents(env.db, [], {
      ...base,
      callers: ["w/orch", "pi:s"],
      mode: "all",
      wave: { workstream: "scratch", name: "v" },
    });
    expect(r.humanNeeds.map((h) => h.reason)).toEqual(["pick a licence"]);
    expect(r.tally?.findings.reduce((n, f) => n + f.confirmed, 0)).toBe(1);
  });

  it("callers:[] is an explicit-refs wait: no registration, no cursors, no owned refs; a wave is refused (no all-caller fallback)", async () => {
    mkTask(env.db, "a");
    closeTask(env.db, "a", { workstream: "w", evidence: "e" });
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    const r = await waitForEvents(env.db, [taskRef("a")], { ...base, callers: [] });
    expect(r.event.ref?.id).toBe("a");
    expect(r.cursor).toEqual({});
    expect(r.humanNeeds).toEqual([]);
    await expect(
      waitForEvents(env.db, [], {
        ...base,
        callers: [],
        wave: { workstream: "scratch", name: "v" },
      }),
    ).rejects.toBeInstanceOf(WaitRefError);
  });

  it("a bad caller is refused before anything runs", async () => {
    mkTask(env.db, "a");
    await expect(
      waitForEvents(env.db, [taskRef("a")], { ...base, callers: [" "] }),
    ).rejects.toThrow(/caller/);
  });
});

describe("eventScope", () => {
  it("'refs': only the listed refs complete the wait; owned events are neither seen nor consumed", async () => {
    mkTask(env.db, "a");
    mkTask(env.db, "listed");
    closeTask(env.db, "a", { workstream: "w", evidence: "e" });
    registerOwnedWait(env.db, "pi:s", [taskRef("a")]);
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    let n = 0;
    const r = await waitForEvents(env.db, [taskRef("listed")], {
      ...base,
      callers: ["pi:s"],
      eventScope: "refs",
      sleep: async () => {
        if (n++ === 1) closeTask(env.db, "listed", { workstream: "w", evidence: "e" });
      },
    });
    expect(r.event.ref?.id).toBe("listed");
    expect(readWaitRegistration(env.db, "pi:s")?.refs.map((x) => x.id)).toEqual(["a"]);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM wait_cursors").get()).toEqual({ n: 0 });
  });

  it("'owned' (default): the owned delegate ends a wait on an unrelated open task", async () => {
    mkTask(env.db, "listed");
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    const r = await waitForEvents(env.db, [taskRef("listed")], { ...base, callers: ["pi:s"] });
    expect(r.event).toMatchObject({ kind: "delegate", ref: { id: call } });
  });
});

describe("result shape", () => {
  it("a closed task: non-null event, snapshots, exit 0, humanNeeds [], cursor {} for callers:[]", async () => {
    mkTask(env.db, "a");
    closeTask(env.db, "a", { workstream: "w", evidence: "e" });
    const r = await waitForEvents(env.db, [taskRef("a")], { ...base, callers: [] });
    expect(r).toMatchObject({
      event: { kind: "closed", ref: { id: "a" } },
      timedOut: false,
      interrupted: false,
      exit: 0,
      humanNeeds: [],
      cursor: {},
    });
  });

  it("agent snapshots keep the observation facts: agentId, paneId, settled, truncation", async () => {
    const id = mkAgent(env.db, "w1");
    const table = new Map<string, AgentReading>([["w/w1", { status: "busy" }]]);
    let n = 0;
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...base,
      callers: [],
      readAgents: async (refs) => {
        n++;
        return new Map(
          refs.map((x) => [
            `${x.workstream}/${x.id}`,
            n < 2
              ? (table.get("w/w1") as AgentReading)
              : {
                  status: "needs_input" as const,
                  settled: true,
                  incarnation: "i",
                  runs: 4,
                  lastText: "tail",
                  lastTextTruncated: true,
                  agentId: id,
                  paneId: "%w1",
                },
          ]),
        );
      },
    });
    expect(r.refs[0]).toMatchObject({
      agentId: id,
      paneId: "%w1",
      settled: true,
      lastTextTruncated: true,
      runs: 4,
    });
  });
});

describe("stall detection and handleStall", () => {
  const stalled = (since = Date.now() - 600_000): AgentReading => ({
    status: "needs_input",
    source: "ctl",
    ctl: "ok",
    since,
    incarnation: "inc",
    runs: 2,
  });

  it("a work task whose owner has been needs_input long enough is a stall (exit 7), logged once", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const table = new Map([["w/w1", stalled()]]);
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: [],
      stuckAfterMs: 1000,
      ...scriptedAgents(table),
    });
    expect(r.event).toMatchObject({ kind: "stall", ref: { id: "t1" } });
    expect(r.exit).toBe(7);
    expect(r.refs[0]).toMatchObject({ stuck: true, status: "IN_PROGRESS", owner: "w1" });
    // Logged once per wait (one `agent.stall` op), not once per poll.
    expect(
      env.db.prepare("SELECT COUNT(*) AS n FROM ops WHERE intent = 'agent.stall'").get(),
    ).toEqual({
      n: 1,
    });
  });

  it("a non-pi owner read from murmur (no ctl, no runs) stalls on needs_input age alone (3.x rule)", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const since = Date.now() - 20_000;
    const table = new Map<string, AgentReading>([
      ["w/w1", { status: "needs_input", source: "murmur", since }],
    ]);
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: [],
      stuckAfterMs: 15_000,
      ...scriptedAgents(table),
    });
    expect(r.exit).toBe(7);
    expect(r.refs[0]).toMatchObject({ stuck: true, stuckWhy: "needs_input" });
  });

  it("stuckAfterMs 0 disables it; a fresh needs_input is not a stall; a closed task is not", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const table = new Map([["w/w1", stalled()]]);
    const off = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: [],
      stuckAfterMs: 0,
      timeoutMs: 15,
      ...scriptedAgents(table),
    });
    expect(off.timedOut).toBe(true);
    const fresh = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: [],
      stuckAfterMs: 60_000,
      timeoutMs: 15,
      ...scriptedAgents(new Map([["w/w1", stalled(Date.now())]])),
    });
    expect(fresh.timedOut).toBe(true);
  });

  it("onStall 'steer' hands the stall to handleStall; 'continue' keeps waiting without consuming; the task then closes", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const table = new Map([["w/w1", stalled()]]);
    const seen: WaitStallContext[] = [];
    let n = 0;
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: ["pi:s"],
      eventScope: "refs",
      stuckAfterMs: 1000,
      onStall: "steer",
      ...scriptedAgents(table),
      handleStall: async (ctx) => {
        seen.push(ctx);
        return {
          disposition: "continue",
          action: "steer",
          state: "sent",
          msgId: "m1",
          afterRuns: 2,
        };
      },
      sleep: async () => {
        if (n++ === 2) closeTask(env.db, "t1", { workstream: "w", evidence: "e" });
      },
    });
    expect(seen).toHaveLength(1); // once per stallToken, not once per poll
    const ctx = seen[0] as WaitStallContext;
    expect(ctx).toMatchObject({
      caller: "pi:s",
      ref: { kind: "task", id: "t1" },
      owner: { name: "w1", workstream: "w", incarnation: "inc", runs: 2, status: "needs_input" },
    });
    expect(ctx.taskId).toBeGreaterThan(0);
    expect(ctx.revision).toBeGreaterThan(0);
    expect(ctx.owner.agentId).toBeGreaterThan(0);
    expect(ctx.stallToken).toContain("inc");
    expect(r.event.kind).toBe("closed");
    expect(ctx.signal.aborted).toBe(true); // aborted when the wait returned
  });

  it("disposition 'return' ends the wait with the stall and the action on the result", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const result: StallActionResult = {
      disposition: "return",
      action: "release",
      state: "released",
      reason: "freed",
    };
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: ["pi:s"],
      eventScope: "refs",
      stuckAfterMs: 1000,
      onStall: "release",
      ...scriptedAgents(new Map([["w/w1", stalled()]])),
      handleStall: async () => result,
    });
    expect(r.event.kind).toBe("stall");
    expect(r.exit).toBe(7);
    expect(r.action).toEqual(result);
  });

  it("a slow handler never starves an urgent owned delegate report (raced, not awaited)", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const call = mkDelegate(env.db, "pi:s");
    let release: () => void = () => {};
    const hung = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: ["pi:s"],
      stuckAfterMs: 1000,
      onStall: "steer",
      ...scriptedAgents(new Map([["w/w1", stalled()]])),
      handleStall: async () => {
        await hung;
        return { disposition: "continue", action: "steer", state: "sent" };
      },
      sleep: async () => {
        if (n++ === 1) answer(env.db, call);
      },
    });
    release();
    expect(r.event).toMatchObject({ kind: "delegate", ref: { id: call } });
  });

  it("the signal passed to handleStall aborts when the wait returns", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    let sig: AbortSignal | undefined;
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: ["pi:s"],
      eventScope: "refs",
      stuckAfterMs: 1000,
      onStall: "steer",
      timeoutMs: 30,
      ...scriptedAgents(new Map([["w/w1", stalled()]])),
      handleStall: (ctx) => {
        sig = ctx.signal;
        return new Promise(() => {});
      },
    });
    expect(r.timedOut).toBe(true);
    expect(sig?.aborted).toBe(true);
  });

  it("a throwing handler is an honest unknown 'return', not a crash", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: ["pi:s"],
      eventScope: "refs",
      stuckAfterMs: 1000,
      onStall: "steer",
      ...scriptedAgents(new Map([["w/w1", stalled()]])),
      handleStall: async () => {
        throw new Error("socket gone");
      },
    });
    expect(r.event.kind).toBe("stall");
    expect(r.action).toMatchObject({
      state: "unknown",
      disposition: "return",
      reason: "socket gone",
    });
  });

  it("the default onStall ('exit') never calls handleStall; steer with no handler is the same as exit", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const table = new Map([["w/w1", stalled()]]);
    let calls = 0;
    const handleStall = async (): Promise<StallActionResult> => {
      calls++;
      return { disposition: "continue", action: "steer", state: "sent" };
    };
    const dflt = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: ["pi:s"],
      stuckAfterMs: 1000,
      handleStall,
      ...scriptedAgents(table),
    });
    expect(dflt.event.kind).toBe("stall");
    const bare = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: ["pi:s"],
      stuckAfterMs: 1000,
      onStall: "steer",
      ...scriptedAgents(table),
    });
    expect(bare.event.kind).toBe("stall");
    expect(bare.action).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("a delegate or human task is never a stall", async () => {
    const call = mkDelegate(env.db, "pi:s");
    const task = env.db
      .prepare(
        "SELECT t.local_id AS id FROM delegate_calls d JOIN tasks t ON t.id = d.task_id WHERE d.call_id = ?",
      )
      .get(call) as { id: string };
    const agentId = mkAgent(env.db, "dw", "scratch");
    env.db
      .prepare(
        "UPDATE tasks SET owner_id = ?, status = 'IN_PROGRESS', substate = 'active' WHERE local_id = ?",
      )
      .run(agentId, task.id);
    const r = await waitForEvents(env.db, [{ kind: "task", workstream: "scratch", id: task.id }], {
      ...base,
      callers: [],
      stuckAfterMs: 1000,
      timeoutMs: 15,
      ...scriptedAgents(new Map([["scratch/dw", stalled()]])),
    });
    expect(r.timedOut).toBe(true);
  });
});

describe("producer fence: unconsumed baselines", () => {
  it("registerOwnedWait stores a baseline per agent ref, keeping the earliest of one incarnation", () => {
    const id = mkAgent(env.db, "w1");
    const ref = (afterRuns: number, incarnation = "i") => ({
      ...agentRef("w1"),
      baseline: { afterRuns, incarnation, agentId: id },
    });
    registerOwnedWait(env.db, "c", [ref(5)]);
    registerOwnedWait(env.db, "c", [ref(7)]);
    expect(readWaitRegistration(env.db, "c")?.baselines["agent:w/w1"]).toEqual({
      afterRuns: 5,
      incarnation: "i",
      agentId: id,
    });
    registerOwnedWait(env.db, "c", [ref(2, "other")]);
    expect(readWaitRegistration(env.db, "c")?.baselines["agent:w/w1"]?.incarnation).toBe("other");
  });

  it("endWait drops the delivered ref's baseline and keeps an undelivered sibling's", () => {
    const a = mkAgent(env.db, "w1");
    const b = mkAgent(env.db, "w2");
    registerOwnedWait(env.db, "c", [
      { ...agentRef("w1"), baseline: { afterRuns: 1, incarnation: "i", agentId: a } },
      { ...agentRef("w2"), baseline: { afterRuns: 2, incarnation: "i", agentId: b } },
    ]);
    const w = beginWait(env.db, "c");
    expect(Object.keys(w?.baselines ?? {}).sort()).toEqual(["agent:w/w1", "agent:w/w2"]);
    endWait(env.db, "c", w?.generation ?? 0, [agentRef("w1")]);
    expect(Object.keys(readWaitRegistration(env.db, "c")?.baselines ?? {})).toEqual(["agent:w/w2"]);
    const raw = () =>
      (
        env.db
          .prepare("SELECT baselines_json AS j FROM wait_registrations WHERE caller = 'c'")
          .get() as { j: string }
      ).j;
    expect(raw()).not.toContain("w1"); // pruned in the row itself, not only hidden on read
    // A delivered baseline must not come back when the same agent is registered again later.
    registerOwnedWait(env.db, "c", [agentRef("w1")]);
    expect(readWaitRegistration(env.db, "c")?.baselines["agent:w/w1"]).toBeUndefined();
    expect(
      (
        env.db
          .prepare("SELECT baselines_json AS j FROM wait_registrations WHERE caller = 'c'")
          .get() as { j: string }
      ).j,
    ).not.toContain("w1");
  });

  it("refuses a baseline on a non-agent ref and a bad run count; stores nothing", () => {
    mkTask(env.db, "t");
    mkAgent(env.db, "w1");
    expect(() =>
      registerOwnedWait(env.db, "c", [{ ...taskRef("t"), baseline: { afterRuns: 1 } }]),
    ).toThrow(/only an agent ref/);
    expect(() =>
      registerOwnedWait(env.db, "c", [{ ...agentRef("w1"), baseline: { afterRuns: -1 } }]),
    ).toThrow(/non-negative/);
    expect(readWaitRegistration(env.db, "c")).toBeUndefined();
  });

  it("the watch receives the baseline; delivery drops it with the ref", async () => {
    const id = mkAgent(env.db, "w1");
    registerOwnedWait(env.db, "c", [
      { ...agentRef("w1"), baseline: { afterRuns: 3, incarnation: "i", agentId: id } },
    ]);
    const seen: unknown[] = [];
    const r = await waitForEvents(env.db, [], {
      ...base,
      callers: ["c"],
      applyClose: false,
      readAgents: async () => new Map(),
      watchAgent: async (_ref, _sig, ctx) => {
        seen.push(ctx.baseline);
        return {
          initial: { status: "busy" },
          settled: Promise.resolve({
            status: "needs_input" as const,
            settled: true,
            incarnation: "i",
            runs: 4,
          }),
        };
      },
    });
    expect(seen).toEqual([{ afterRuns: 3, incarnation: "i", agentId: id }]);
    expect(r.event.kind).toBe("settled");
    expect(readWaitRegistration(env.db, "c")?.baselines).toEqual({});
  });
});
