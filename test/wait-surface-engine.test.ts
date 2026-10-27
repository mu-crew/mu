// The engine additions the `mu wait` surface needs (v_wait_surface): provenance discovery of
// what a caller spawned, the `scope` narrowing, a plain-shell wait still seeing an owner die,
// `onStall: warn`, and a wave narrowed to the scope. Real SQLite; agents scripted (no ctl, no mux).

import { describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { reasonOf } from "../src/cli/wait.js";
import { closeTask, listNotes } from "../src/tasks.js";
import { type AgentReading, WAIT_HEARTBEAT_CAP_MS, waitForEvents } from "../src/wait.js";
import { readWaitRegistration } from "../src/wait-registration.js";
import {
  agentRef,
  answer,
  controllableWatch,
  mkAgent,
  mkDelegate,
  mkOwnedTask,
  mkTask,
  scriptedAgents,
  taskRef,
  useWaitDb,
} from "./_wait-fixtures.js";

const env = useWaitDb();
const base = { pollMs: 1, sync: false, timeoutMs: 60, callers: [] as string[] };
const spawnedBy = (agent: string, caller: string, ws = "w"): void => {
  env.db
    .prepare(
      "UPDATE agents SET spawner = ? WHERE name = ? AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)",
    )
    .run(caller, agent, ws);
};
const agentRowOf = (name: string): number =>
  (env.db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as { id: number }).id;
const reads = (status: "busy" | "needs_input" | null, over: Record<string, unknown> = {}) =>
  scriptedAgents(new Map([["w/a1", { status, ...over } as never]]));

describe("provenance: a wait with no refs owns what its caller spawned", () => {
  it("sees the task of an agent the caller spawned close, and no one else's", async () => {
    await mkOwnedTask(env.db, "mine", "a1");
    await mkOwnedTask(env.db, "theirs", "a2");
    spawnedBy("a1", "w/boss");
    spawnedBy("a2", "w/other");
    const hooks = scriptedAgents(
      new Map([
        ["w/a1", { status: "busy" }],
        ["w/a2", { status: "busy" }],
      ]),
    );
    let n = 0;
    const r = await waitForEvents(env.db, [], {
      ...base,
      ...hooks,
      callers: ["w/boss"],
      sleep: async () => {
        if (n++ === 0) {
          // The other caller's task closing is not this caller's event.
          closeTask(env.db, "theirs", { workstream: "w", evidence: "e" });
          closeTask(env.db, "mine", { workstream: "w", evidence: "e" });
        }
      },
    });
    expect(r.event).toMatchObject({ kind: "closed", ref: { kind: "task", id: "mine" } });
    // Registered durably, with a zero baseline: the next wait still owes it, and a reaped owner is seen.
    const reg = readWaitRegistration(env.db, "w/boss");
    expect(reg?.refs.map((x) => `${x.kind}:${x.id}`).sort()).toEqual(
      expect.arrayContaining(["agent:a1", "task:mine"]),
    );
    expect(reg?.refs.some((x) => x.id === "theirs" || x.id === "a2")).toBe(false);
  });

  it("an agent the caller did NOT spawn is never discovered, even when it owns an open task", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    spawnedBy("a1", "w/other");
    const r = await waitForEvents(env.db, [taskRef("nothing-here-yet-0")], { ...base }).catch(
      (e) => e,
    );
    expect(r).toBeInstanceOf(Error); // no such task: the explicit ref is checked upfront
    mkTask(env.db, "x");
    const none = await waitForEvents(env.db, [taskRef("x")], {
      ...base,
      ...reads("busy"),
      callers: ["w/boss"],
    });
    expect(readWaitRegistration(env.db, "w/boss")?.refs.some((x) => x.id === "a1")).toBeFalsy();
    expect(none.timedOut).toBe(true);
  });

  it("a spawned worker whose pane died (row reaped) is a dead event, not silence", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    spawnedBy("a1", "w/boss");
    const hooks = reads("busy");
    let n = 0;
    const r = await waitForEvents(env.db, [], {
      ...base,
      ...hooks,
      callers: ["w/boss"],
      sleep: async () => {
        // The reaper: the agent row goes (the task flips back to OPEN).
        if (n++ === 0) {
          env.db
            .prepare(
              "UPDATE tasks SET status = 'OPEN', substate = 'todo', owner_id = NULL WHERE local_id = 't1'",
            )
            .run();
          env.db.prepare("DELETE FROM agents WHERE name = 'a1'").run();
        }
      },
    });
    expect(r.event.kind).toBe("dead");
    expect(r.exit).toBe(6);
  });

  it("scope narrows what is owned, not what is named", async () => {
    await mkOwnedTask(env.db, "in-w", "a1", "w");
    await mkOwnedTask(env.db, "in-v", "b1", "v");
    spawnedBy("a1", "w/boss", "w");
    spawnedBy("b1", "w/boss", "v");
    const hooks = scriptedAgents(
      new Map([
        ["w/a1", { status: "busy" }],
        ["v/b1", { status: "busy" }],
      ]),
    );
    let n = 0;
    const r = await waitForEvents(env.db, [], {
      ...base,
      ...hooks,
      callers: ["w/boss"],
      scope: "w",
      sleep: async () => {
        if (n++ === 0) {
          closeTask(env.db, "in-v", { workstream: "v", evidence: "e" });
          closeTask(env.db, "in-w", { workstream: "w", evidence: "e" });
        }
      },
    });
    expect(r.event.ref).toMatchObject({ id: "in-w" });
    // A scoped wait neither saw nor registered `v`'s work: it is discovered by a wait that scopes it in.
    const reg = readWaitRegistration(env.db, "w/boss");
    expect(reg?.refs.some((x) => x.workstream === "v")).toBe(false);
  });
});

describe("a plain-shell wait (no callers) still sees an owner die", () => {
  it("an explicit task whose owner's row is reaped is dead (exit 6), not a timeout", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    let n = 0;
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      ...reads("busy"),
      callers: [],
      sleep: async () => {
        if (n++ === 0) {
          env.db
            .prepare(
              "UPDATE tasks SET status = 'OPEN', substate = 'todo', owner_id = NULL WHERE local_id = 't1'",
            )
            .run();
          env.db.prepare("DELETE FROM agents WHERE name = 'a1'").run();
        }
      },
    });
    expect(r.event).toMatchObject({ kind: "dead", ref: { kind: "task", id: "t1" } });
    expect(r.exit).toBe(6);
  });

  it("a manual release is not a death", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    let n = 0;
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      ...reads("busy"),
      callers: [],
      sleep: async () => {
        if (n++ === 0)
          env.db
            .prepare(
              "UPDATE tasks SET status = 'OPEN', substate = 'todo', owner_id = NULL WHERE local_id = 't1'",
            )
            .run();
      },
    });
    expect(r.timedOut).toBe(true);
  });
});

describe("onStall: warn flags the stall and keeps waiting", () => {
  it("exit returns a stall; warn marks the snapshot stuck and times out", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    const idle = {
      status: "needs_input",
      since: Date.now() - 60_000,
      source: "ctl",
      ctl: "ok",
    } as const;
    const exit = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      ...reads("needs_input", idle),
      callers: [],
      stuckAfterMs: 1000,
      onStall: "exit",
    });
    expect(exit.event.kind).toBe("stall");
    expect(exit.exit).toBe(7);
    const warn = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      ...reads("needs_input", idle),
      callers: [],
      stuckAfterMs: 1000,
      onStall: "warn",
    });
    expect(warn.timedOut).toBe(true);
    expect(warn.refs[0]).toMatchObject({ stuck: true, owner: "a1", stuckWhy: "needs_input" });
  });
});

describe("a stall never beats an unprocessed settle", () => {
  it("an owner idle with a run past its baseline is delivered its settle (the CLOSE), not reported stalled", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    spawnedBy("a1", "w/boss");
    const idle = {
      status: "needs_input",
      since: Date.now() - 60_000,
      source: "ctl",
      ctl: "ok",
      runs: 1,
      incarnation: "inc",
    } as const;
    const w = controllableWatch({ status: "busy" });
    const opts = {
      ...base,
      timeoutMs: 80,
      ...reads("needs_input", idle),
      watchAgent: async () => ({ ...w.handle, afterRuns: 0 }),
      callers: ["w/boss"],
      stuckAfterMs: 1000,
    };
    // The watch has not answered yet: the run is owed, so no stall, just the heartbeat.
    const pending = await waitForEvents(env.db, [], opts);
    expect(pending.event.kind).toBe("heartbeat");
    expect(pending.refs.some((x) => x.stuck === true)).toBe(false);
    // Its settle arrives: that is the event (and it is what applies the CLOSE).
    w.settle({
      status: "needs_input",
      settled: true,
      runs: 1,
      incarnation: "inc",
      lastText: "done",
    });
    const got = await waitForEvents(env.db, [], { ...opts, timeoutMs: 500 });
    expect(got.event).toMatchObject({ kind: "settled", ref: { kind: "agent", id: "a1" } });
  });

  it("once that settle was delivered, an owner still idle with the task open IS a stall", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    spawnedBy("a1", "w/boss");
    const idle = {
      status: "needs_input",
      since: Date.now() - 60_000,
      source: "ctl",
      ctl: "ok",
      runs: 1,
      incarnation: "inc",
    } as const;
    const w = controllableWatch({ status: "busy" });
    w.settle({
      status: "needs_input",
      settled: true,
      runs: 1,
      incarnation: "inc",
      lastText: "no close block",
    });
    const opts = {
      ...base,
      timeoutMs: 300,
      ...reads("needs_input", idle),
      watchAgent: async () => ({ ...w.handle, afterRuns: 0 }),
      callers: ["w/boss"],
      stuckAfterMs: 1000,
    };
    const first = await waitForEvents(env.db, [], opts);
    expect(first.event.kind).toBe("settled");
    const second = await waitForEvents(env.db, [], {
      ...opts,
      watchAgent: async () => undefined,
    });
    expect(second.event).toMatchObject({ kind: "stall", ref: { kind: "task", id: "t1" } });
  });
});

describe("a malformed CLOSE block surfaces on a task wait (close_block_malformed_visible)", () => {
  for (const mode of ["first", "all"] as const) {
    it(`--${mode} on the owned task: a settled owner left t1 open: the wait ends, not at the cap`, async () => {
      await mkOwnedTask(env.db, "t1", "a1");
      spawnedBy("a1", "w/boss");
      const idle = {
        status: "needs_input",
        since: Date.now() - 60_000,
        source: "ctl",
        ctl: "ok",
        runs: 1,
        incarnation: "inc",
        agentId: agentRowOf("a1"),
      } as const;
      const w = controllableWatch({ status: "busy" });
      w.settle({
        ...idle,
        settled: true,
        lastText: 'CLOSE: task=t1 evidence="e"\nREPORT:\n',
      });
      const r = await waitForEvents(env.db, [taskRef("t1")], {
        ...base,
        timeoutMs: 400,
        mode,
        ...reads("needs_input", idle),
        watchAgent: async () => ({ ...w.handle, afterRuns: 0 }),
        callers: ["w/boss"],
        stuckAfterMs: 1000,
      });
      if (mode === "all") {
        expect(r.event).toMatchObject({ kind: "stall", ref: { kind: "task", id: "t1" } });
        expect(r.exit).toBe(7);
        // The words name the owner, the refusal and the fix.
        const why = reasonOf(r, undefined, 1);
        expect(why).toContain("a1");
        expect(why).toContain("no close (malformed): the report is empty");
        expect(why).toContain("mu task close t1 -w w");
      } else {
        // --first: the owner's settle goes first and carries the refused close.
        expect(r.event).toMatchObject({ kind: "settled", ref: { kind: "agent", id: "a1" } });
        expect(r.refs.find((x) => x.ref.kind === "agent")?.close?.reason).toMatch(
          /^no close \(malformed\): /,
        );
      }
      expect(listNotes(env.db, "t1", "w").map((n) => n.content)).toEqual(
        expect.arrayContaining([expect.stringContaining("no close (malformed)")]),
      );
    });
  }
});

describe("--all --on-stall steer rearms on the steered owner's next run (fix_allstall_steer_rearm)", () => {
  it("run 1 settles mid-task and is steered; run 2's valid CLOSE closes t1 in the SAME wait, one send", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    spawnedBy("a1", "w/boss");
    const idle = {
      status: "needs_input",
      since: Date.now() - 60_000,
      source: "ctl",
      ctl: "ok",
      incarnation: "inc",
      agentId: agentRowOf("a1"),
    } as const;
    const runs: number[] = [];
    const watches = [
      { runs: 1, lastText: "paused mid-task" },
      { runs: 2, lastText: 'CLOSE: task=t1 evidence="e"\nREPORT:\ndone' },
    ];
    const sends: number[] = [];
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      timeoutMs: 1500,
      mode: "all",
      status: "CLOSED",
      ...reads("needs_input", { ...idle, runs: 1 }),
      watchAgent: async (ref) => {
        const next = watches[runs.length];
        if (next === undefined) return undefined;
        runs.push(ref.afterRuns ?? 0);
        const w = controllableWatch({ status: "busy" });
        w.settle({ ...idle, settled: true, ...next });
        return { ...w.handle, afterRuns: ref.afterRuns ?? 0 };
      },
      callers: ["w/boss"],
      stuckAfterMs: 1000,
      onStall: "steer",
      handleStall: async () => {
        sends.push(1);
        return { disposition: "continue", action: "steer", state: "sent", afterRuns: 1 };
      },
    });
    expect(r.event).toMatchObject({ kind: "closed", ref: { kind: "task", id: "t1" } });
    expect(r.exit).toBe(0);
    expect(sends).toHaveLength(1);
    expect(runs).toEqual([0, 1]); // the second watch counts past the steer baseline
  });
});

describe("reasonOf: a stall with a refused CLOSE still names the --on-stall action", () => {
  it("carries both the refusal and the action state", () => {
    const stall = {
      event: { kind: "stall", ref: { kind: "task", workstream: "w", id: "t1" } },
      refs: [
        {
          ref: { kind: "task", workstream: "w", id: "t1" },
          owner: "a1",
          close: {
            applied: false,
            task: "t1",
            reason: "no close (malformed): the report is empty",
          },
        },
      ],
      action: {
        action: "steer",
        state: "unknown",
        disposition: "return",
        reason: "budget-exhausted",
      },
    } as never;
    const why = reasonOf(stall, undefined, 1);
    expect(why).toContain("no close (malformed)");
    expect(why).toContain("--on-stall steer: unknown (budget-exhausted)");
  });
});

describe("one fact, one event: a settle whose CLOSE closed the task, and the task's close", () => {
  it("delivering the settle of the run that closed t1 consumes t1's close too: no second wait for the same news", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    spawnedBy("a1", "w/boss");
    const lastText = 'CLOSE: task=t1 evidence="e"\nREPORT:\nok';
    const w = controllableWatch({ status: "busy" });
    w.settle({
      status: "needs_input",
      settled: true,
      runs: 1,
      incarnation: "inc",
      lastText,
      agentId: agentRowOf("a1"),
    });
    const opts = {
      ...base,
      timeoutMs: 120,
      ...reads("needs_input", { runs: 1, incarnation: "inc" }),
      watchAgent: async () => ({ ...w.handle, afterRuns: 0 }),
      callers: ["w/boss"],
      stuckAfterMs: 0,
    };
    // No explicit refs: the run's settle applies the CLOSE, and either it or t1's close is the event.
    const first = await waitForEvents(env.db, [], opts);
    expect(["settled", "closed"]).toContain(first.event.kind);
    expect(first.refs.find((x) => x.ref.kind === "agent")?.close).toMatchObject({
      applied: true,
      task: "t1",
    });
    // Both are the same fact, consumed together: the next wait has nothing owed.
    // (The same watch again: an unconsumed settle would be handed out a second time.)
    const second = await waitForEvents(env.db, [], { ...opts, timeoutMs: 60 });
    expect(second.event.kind).toBe("heartbeat");
  });
});

describe("--until-text on a non-pi pane (no ctl text exists for it)", () => {
  it("matches the pane tail once, marks the text pane-sourced, and never closes a task", async () => {
    mkAgent(env.db, "gate", "w", "sh");
    const table = new Map<string, AgentReading>([
      ["w/gate", { status: "busy", lastText: "building...\n", textSource: "pane" }],
    ]);
    let n = 0;
    const r = await waitForEvents(env.db, [agentRef("gate")], {
      ...base,
      timeoutMs: 500,
      ...scriptedAgents(table),
      callers: [],
      until: { text: "GATE-READY-[0-9]+" },
      sleep: async () => {
        if (n++ === 1)
          table.set("w/gate", {
            status: "busy",
            lastText: "building...\nGATE-READY-42\n",
            textSource: "pane",
          });
      },
    });
    expect(r.event).toMatchObject({ kind: "pane-text", ref: { kind: "agent", id: "gate" } });
    expect(r.refs[0]).toMatchObject({ fired: true, textSource: "pane" });
    // No run finished: never `settled`, never a close.
    expect(r.refs[0]?.settled).toBeUndefined();
    expect(r.refs[0]?.close).toBeUndefined();
  });

  it("a ctl-less reading without textSource:pane is never matched by text", async () => {
    mkAgent(env.db, "gate", "w", "sh");
    const table = new Map<string, AgentReading>([
      ["w/gate", { status: "busy", lastText: "GATE-READY-1" }],
    ]);
    const r = await waitForEvents(env.db, [agentRef("gate")], {
      ...base,
      ...scriptedAgents(table),
      callers: [],
      until: { text: "GATE-READY" },
    });
    expect(r.timedOut).toBe(true);
  });
});

describe("a wave narrowed to the scope", () => {
  it("counts only this caller's calls of the wave, in the scope's workstream or recorded on it", async () => {
    mkTask(env.db, "j1", "w");
    mkTask(env.db, "j2", "v");
    const a = mkDelegate(env.db, "pi:s", {
      wave: "claims",
      record: { workstream: "w", task: "j1" },
    });
    const b = mkDelegate(env.db, "pi:s", {
      wave: "claims",
      record: { workstream: "v", task: "j2" },
    });
    mkDelegate(env.db, "pi:other", { wave: "claims", record: { workstream: "w", task: "j1" } });
    answer(env.db, a);
    const r = await waitForEvents(env.db, [], {
      ...base,
      callers: ["pi:s"],
      mode: "all",
      scope: "w",
      wave: { name: "claims" },
    });
    // Only the call recorded on w counts: one finding, confirmed; the other session and v's are not in it.
    expect(r.tally?.findings).toEqual([
      { id: "w/j1", confirmed: 1, refuted: 0, unverified: 0, pending: 0 },
    ]);
    expect(b).toBeDefined();
  });

  it("without a scope the wave is every workstream's (still only this caller's)", async () => {
    mkTask(env.db, "j1", "w");
    mkTask(env.db, "j2", "v");
    const a = mkDelegate(env.db, "pi:s", {
      wave: "claims",
      record: { workstream: "w", task: "j1" },
    });
    const b = mkDelegate(env.db, "pi:s", {
      wave: "claims",
      record: { workstream: "v", task: "j2" },
    });
    mkDelegate(env.db, "pi:other", { wave: "claims", record: { workstream: "w", task: "j1" } });
    answer(env.db, a);
    answer(env.db, b);
    const r = await waitForEvents(env.db, [], {
      ...base,
      callers: ["pi:s"],
      mode: "all",
      wave: { name: "claims" },
    });
    expect(r.tally?.findings.map((f) => f.id).sort()).toEqual(["v/j2", "w/j1"]);
    expect(r.tally?.findings.reduce((n, f) => n + f.confirmed, 0)).toBe(2);
    expect(WAIT_HEARTBEAT_CAP_MS).toBeGreaterThan(0);
  });
});

// unused helpers kept referenced for the fixture contract
void agentRef;
void mkAgent;
void insertAgent;
