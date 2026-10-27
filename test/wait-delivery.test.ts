// Durable, exactly-once, fair delivery of waitForEvents (v_wait_engine, round 2).
// Rule: an event is consumed only when it is the one returned, its token lives
// in the DB (never in a wait's memory), an event returned once never outranks a
// never-returned one, and an unchanged observation is news once per state change.
// Real SQLite; agents scripted (no ctl, no mux).

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteAgent } from "../src/agents.js";
import { recordHumanNeeded } from "../src/human-needed.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { closeTask } from "../src/tasks.js";
import {
  type AgentReading,
  type WaitOptions,
  type WaitResult,
  waitForEvents,
} from "../src/wait.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { withEnv } from "./_env.js";
import {
  agentRef,
  answer,
  mkAgent,
  mkDelegate,
  mkOwnedTask,
  mkTask,
  taskRef,
  useWaitDb,
} from "./_wait-fixtures.js";

const env = useWaitDb();
const base = { pollMs: 1, sync: false } as const;
const close = (id: string) => closeTask(env.db, id, { workstream: "w", evidence: "e" });
const label = (r: WaitResult): string =>
  r.event.ref === null
    ? r.event.kind
    : `${r.event.kind}:${r.event.ref.id}${r.event.kind === "settled" && r.event.runs !== undefined ? `#${r.event.runs}` : ""}`;

/** A small seeded PRNG (mulberry32): the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("blockersOf: a sibling that `first` did not return stays owed (durable, not per-wait memory)", () => {
  it("three blockers, two close in one tick: both are delivered, one per wait", async () => {
    for (const id of ["goal", "b1", "b2", "b3"]) mkTask(env.db, id);
    for (const b of ["b1", "b2", "b3"]) addBlockEdge(env.db, "w", "goal", b);
    const opts = {
      ...base,
      callers: ["c"],
      timeoutMs: 40,
      blockersOf: { workstream: "w", id: "goal" },
    } as const;
    // The first wait sees all three open (and records that), then two close.
    let n = 0;
    const first = await waitForEvents(env.db, [], {
      ...opts,
      sleep: async () => {
        if (n++ === 0) {
          close("b1");
          close("b2");
        }
      },
    });
    expect(label(first)).toBe("closed:b1");
    const second = await waitForEvents(env.db, [], opts);
    expect(label(second)).toBe("closed:b2");
    expect(label(await waitForEvents(env.db, [], opts))).toBe("heartbeat"); // b3 still open
  });

  it("two blockers closing together: each is delivered before the umbrella's synthetic close", async () => {
    for (const id of ["goal", "b1", "b2"]) mkTask(env.db, id);
    for (const b of ["b1", "b2"]) addBlockEdge(env.db, "w", "goal", b);
    const opts = {
      ...base,
      callers: ["c"],
      timeoutMs: 40,
      blockersOf: { workstream: "w", id: "goal" },
    } as const;
    let n = 0;
    const seen: string[] = [];
    seen.push(
      label(
        await waitForEvents(env.db, [], {
          ...opts,
          sleep: async () => {
            if (n++ === 0) {
              close("b1");
              close("b2");
            }
          },
        }),
      ),
    );
    seen.push(label(await waitForEvents(env.db, [], opts)));
    expect(seen).toEqual(["closed:b1", "closed:b2"]);
  });
});

describe("the fence applies to every agent ref, explicit or owned", () => {
  const settled = (runs: number): AgentReading => ({
    status: "needs_input",
    settled: true,
    incarnation: "i",
    runs,
    lastText: "done",
  });

  it("an explicit ref with no afterRuns takes the registered fence's baseline, not 'now'", async () => {
    mkAgent(env.db, "w1");
    const agentId = (
      env.db.prepare("SELECT id FROM agents WHERE name = 'w1'").get() as { id: number }
    ).id;
    registerOwnedWait(env.db, "pi:x", [
      { ...agentRef("w1"), baseline: { afterRuns: 4, incarnation: "i", agentId } },
    ]);
    const seen: { owed: boolean; baseline?: number }[] = [];
    const r = await waitForEvents(env.db, [agentRef("w1")], {
      ...base,
      callers: ["pi:x"],
      timeoutMs: 1000,
      readAgents: async () => new Map(),
      watchAgent: async (_ref, _s, ctx) => {
        seen.push({
          owed: ctx.owed,
          ...(ctx.baseline ? { baseline: ctx.baseline.afterRuns } : {}),
        });
        return {
          initial: { status: "busy" },
          afterRuns: ctx.baseline?.afterRuns ?? 5,
          settled: Promise.resolve(settled(5)),
        };
      },
    });
    expect(seen).toEqual([{ owed: true, baseline: 4 }]);
    expect(r.event).toMatchObject({ kind: "settled", runs: 5 });
  });
});

describe("fairness: an unchanged urgent observation is delivered once per state change", () => {
  it("12 answered delegates are all delivered while one of four workers sits on a dialog", async () => {
    for (const w of ["w1", "w2", "w3", "w4"]) mkAgent(env.db, w);
    registerOwnedWait(
      env.db,
      "pi:s",
      ["w1", "w2", "w3", "w4"].map((w) => agentRef(w)),
    );
    const dialog = { kind: "confirm", title: "ok?", since: 1 } as never;
    const table = new Map<string, AgentReading>([
      ["w/w1", { status: "needs_permission", blocked: dialog, incarnation: "i", runs: 0 }],
      ["w/w2", { status: "busy" }],
      ["w/w3", { status: "busy" }],
      ["w/w4", { status: "busy" }],
    ]);
    const calls = Array.from({ length: 12 }, () => mkDelegate(env.db, "pi:s"));
    for (const c of calls) answer(env.db, c);
    const opts = {
      ...base,
      callers: ["pi:s"],
      timeoutMs: 30,
      readAgents: async () => table,
    } as const;
    const got: string[] = [];
    for (let i = 0; i < 16; i++) got.push(label(await waitForEvents(env.db, [], opts)));
    expect(got.filter((g) => g.startsWith("delegate:")).sort()).toEqual(
      calls.map((c) => `delegate:${c}`).sort(),
    );
    expect(got.filter((g) => g === "input:w1")).toHaveLength(1);
    // A new dialog (a state change) is news again.
    table.set("w/w1", {
      status: "needs_permission",
      blocked: { kind: "confirm", title: "again?", since: 2 } as never,
      incarnation: "i",
      runs: 0,
    });
    expect(label(await waitForEvents(env.db, [], opts))).toBe("input:w1");
    expect(label(await waitForEvents(env.db, [], opts))).toBe("heartbeat");
  });

  it("an owned task whose owner stalled: stall once, then the delegate (never the stall again)", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    registerOwnedWait(env.db, "pi:s", [taskRef("t1")]);
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    const opts = {
      ...base,
      callers: ["pi:s"],
      timeoutMs: 30,
      stuckAfterMs: 1000,
      readAgents: async () =>
        new Map<string, AgentReading>([
          ["w/w1", { status: "needs_input", since: 1_000, source: "poll" } as never],
        ]),
    } as const;
    const got: string[] = [];
    for (let i = 0; i < 3; i++) got.push(label(await waitForEvents(env.db, [], opts)));
    expect(got).toEqual(["stall:t1", `delegate:${call}`, "heartbeat"]);
  });

  it("an owned task whose owner died: dead once, then the delegate (never the death again)", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    registerOwnedWait(env.db, "pi:s", [taskRef("t1")]);
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    const opts = {
      ...base,
      callers: ["pi:s"],
      timeoutMs: 30,
      readAgents: async () => new Map<string, AgentReading>([["w/w1", { status: null }]]),
    } as const;
    const got: string[] = [];
    for (let i = 0; i < 3; i++) got.push(label(await waitForEvents(env.db, [], opts)));
    expect(got).toEqual(["dead:t1", `delegate:${call}`, "heartbeat"]);
  });

  // dead_double_event: `claim --for` registers the task AND its owner. One death is one event that
  // names both refs, never dead:t1 then dead:w1 (exit 6 twice for one fact).
  const oneDeath = async (
    kill: () => void,
    table: Map<string, AgentReading>,
    mode: "first" | "all" = "first",
  ) => {
    await mkOwnedTask(env.db, "t1", "w1");
    registerOwnedWait(env.db, "pi:s", [taskRef("t1"), agentRef("w1")]);
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    kill();
    const opts = {
      ...base,
      callers: ["pi:s"],
      mode,
      timeoutMs: 30,
      readAgents: async () => table,
    } as const;
    const first = await waitForEvents(env.db, [], opts);
    const got = [label(first)];
    for (let i = 0; i < 2; i++) got.push(label(await waitForEvents(env.db, [], opts)));
    expect(got).toEqual(["dead:t1", `delegate:${call}`, "heartbeat"]);
    expect(first.exit).toBe(6);
    expect(first.refs.filter((r) => r.dead).map((r) => r.ref.id)).toEqual(["t1", "w1"]);
  };

  it("one owner death (pane gone, row still there) is ONE event naming the task and the agent", async () => {
    await oneDeath(() => {}, new Map([["w/w1", { status: null }]]));
  });

  it("one owner death after the reaper ran (row gone, task flipped OPEN) is ONE event", async () => {
    await oneDeath(() => deleteAgent(env.db, "w1", "w"), new Map());
  });

  it("--all: one owner death is ONE urgent event too", async () => {
    await oneDeath(() => {}, new Map([["w/w1", { status: null }]]), "all");
  });

  it("two deaths stay two events: an unrelated agent, or a respawn under the dead owner's name", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    mkAgent(env.db, "w2");
    registerOwnedWait(env.db, "pi:s", [taskRef("t1"), agentRef("w1"), agentRef("w2")]);
    deleteAgent(env.db, "w1", "w");
    // w1 respawned as a NEW registry row: its death is not the old owner's.
    mkAgent(env.db, "w1");
    const dead = new Map<string, AgentReading>([
      ["w/w1", { status: null }],
      ["w/w2", { status: null }],
    ]);
    const opts = { ...base, callers: ["pi:s"], timeoutMs: 30, readAgents: async () => dead };
    const got: string[] = [];
    for (let i = 0; i < 4; i++) got.push(label(await waitForEvents(env.db, [], opts)));
    expect(got).toEqual(["dead:t1", "dead:w1", "dead:w2", "heartbeat"]);
  });

  it("an explicit ref on a dialog never starves an owned delegate report", async () => {
    mkAgent(env.db, "w1");
    const call = mkDelegate(env.db, "pi:s");
    answer(env.db, call);
    const opts = {
      ...base,
      callers: ["pi:s"],
      timeoutMs: 30,
      readAgents: async () =>
        new Map<string, AgentReading>([
          ["w/w1", { status: "needs_permission", blocked: { kind: "confirm", since: 1 } as never }],
        ]),
    } as const;
    // The first wait returns the never-returned input; the delegate follows; the dialog is
    // still reported (explicitly asked) but never ahead of a report.
    expect(label(await waitForEvents(env.db, [agentRef("w1")], opts))).toBe("input:w1");
    expect(label(await waitForEvents(env.db, [agentRef("w1")], opts))).toBe(`delegate:${call}`);
    expect(label(await waitForEvents(env.db, [agentRef("w1")], opts))).toBe("input:w1");
  });
});

describe("property: N waits over a random mix of events deliver each exactly once and lose none", () => {
  for (const seed of [1, 2, 3, 7, 42, 1234]) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      const caller = "pi:prop";
      const tasks = Array.from({ length: 6 }, (_, i) => `t${i}`);
      const blockers = Array.from({ length: 4 }, (_, i) => `k${i}`);
      for (const id of [...tasks, ...blockers, "goal", "keep"]) mkTask(env.db, id);
      for (const b of [...blockers, "keep"]) addBlockEdge(env.db, "w", "goal", b); // `keep` never closes
      registerOwnedWait(
        env.db,
        caller,
        tasks.map((t) => taskRef(t)),
      );
      mkAgent(env.db, "dlg");
      registerOwnedWait(env.db, caller, [agentRef("dlg")]);
      mkAgent(env.db, "run");
      const calls = Array.from({ length: 5 }, () => mkDelegate(env.db, caller));

      // The dialog agent is urgent for the whole test (polled); the run agent is watched like
      // the ctl does it: it settles once its run count passes the fence or the consumed cursor.
      let dialogSince = 1;
      let runsDone = 0;
      const readAgents = async (): Promise<Map<string, AgentReading>> =>
        new Map<string, AgentReading>([
          [
            "w/dlg",
            {
              status: "needs_permission",
              blocked: { kind: "confirm", title: "?", since: dialogSince } as never,
              incarnation: "i",
              runs: 0,
            },
          ],
        ]);
      const watchAgent: NonNullable<WaitOptions["watchAgent"]> = async (ref, _signal, ctx) => {
        if (ref.id !== "run") return undefined;
        const cursor = ctx.cursor?.incarnation === "i" ? ctx.cursor.runs : 0;
        const after = Math.max(ctx.baseline?.afterRuns ?? 0, cursor);
        const reading: AgentReading = {
          status: "needs_input",
          settled: true,
          incarnation: "i",
          runs: runsDone,
          lastText: "x",
        };
        return {
          initial: { status: "busy" },
          afterRuns: after,
          settled: runsDone > after ? Promise.resolve(reading) : new Promise(() => {}),
        };
      };

      const pending = new Set<string>([
        ...tasks.map((t) => `closed:${t}`),
        ...calls.map((c) => `delegate:${c}`),
        ...blockers.map((k) => `closed:${k}`),
      ]);
      const expected = new Set(pending);
      const delivered: string[] = [];
      const mutate = (): void => {
        const k = Math.floor(rand() * 4);
        for (let i = 0; i < k; i++) {
          const roll = rand();
          const t = tasks[Math.floor(rand() * tasks.length)] as string;
          const b = blockers[Math.floor(rand() * blockers.length)] as string;
          const c = calls[Math.floor(rand() * calls.length)] as string;
          if (roll < 0.3) {
            if (
              env.db.prepare("SELECT 1 FROM tasks WHERE local_id = ? AND status <> 'CLOSED'").get(t)
            )
              close(t);
          } else if (roll < 0.5) {
            if (
              env.db.prepare("SELECT 1 FROM tasks WHERE local_id = ? AND status <> 'CLOSED'").get(b)
            )
              close(b);
          } else if (roll < 0.75) {
            if (
              env.db
                .prepare(
                  "SELECT 1 FROM delegate_calls WHERE call_id = ? AND state NOT IN ('done','failed','cancelled','timed_out')",
                )
                .get(c)
            )
              answer(env.db, c);
          } else if (roll < 0.9) {
            // a new run of the run agent: registered with its baseline, like a producer's send
            if (!pending.has(`settled:run#${runsDone}`)) {
              registerOwnedWait(env.db, caller, [
                { ...agentRef("run"), baseline: { afterRuns: runsDone, incarnation: "i" } },
              ]);
              runsDone++;
              expected.add(`settled:run#${runsDone}`);
              pending.add(`settled:run#${runsDone}`);
            }
          } else if (delivered.includes("input:dlg")) {
            dialogSince++; // a state change: the dialog is news again
          }
        }
      };

      const inputs: string[] = [];
      // Prime: one wait sees every blocker open (a blocker never seen open is history, not news).
      const prime = label(
        await waitForEvents(env.db, [], {
          ...base,
          callers: [caller],
          timeoutMs: 8,
          readAgents,
          watchAgent,
          blockersOf: { workstream: "w", id: "goal" },
        }),
      );
      if (prime.startsWith("input:")) {
        inputs.push(`${prime}@${dialogSince}`);
        delivered.push(prime);
      }
      for (let i = 0; i < 160 && (pending.size > 0 || i < 12); i++) {
        mutate();
        const r = await waitForEvents(env.db, [], {
          ...base,
          callers: [caller],
          timeoutMs: 8,
          readAgents,
          watchAgent,
          blockersOf: { workstream: "w", id: "goal" },
        });
        const l = label(r);
        if (l === "heartbeat") continue;
        if (l.startsWith("input:")) {
          inputs.push(`${l}@${dialogSince}`);
          delivered.push(l);
          continue;
        }
        delivered.push(l);
        expect(pending.delete(l), `${l} was delivered twice or was never due`).toBe(true);
      }
      // Drain: nothing owed may be left behind.
      for (let i = 0; i < 40 && pending.size > 0; i++) {
        const r = await waitForEvents(env.db, [], {
          ...base,
          callers: [caller],
          timeoutMs: 8,
          readAgents,
          watchAgent,
          blockersOf: { workstream: "w", id: "goal" },
        });
        const l = label(r);
        if (l.startsWith("input:") || l === "heartbeat") continue;
        delivered.push(l);
        expect(pending.delete(l), `${l} was delivered twice or was never due`).toBe(true);
      }
      // Only events whose cause happened can be pending: close what is left, then it must come out.
      for (const t of tasks) if (pending.has(`closed:${t}`)) close(t);
      for (const b of blockers) if (pending.has(`closed:${b}`)) close(b);
      for (const c of calls) if (pending.has(`delegate:${c}`)) answer(env.db, c);
      for (let i = 0; i < 80 && pending.size > 0; i++) {
        const l = label(
          await waitForEvents(env.db, [], {
            ...base,
            callers: [caller],
            timeoutMs: 8,
            readAgents,
            watchAgent,
            blockersOf: { workstream: "w", id: "goal" },
          }),
        );
        if (l.startsWith("input:") || l === "heartbeat") continue;
        delivered.push(l);
        expect(pending.delete(l), `${l} was delivered twice or was never due`).toBe(true);
      }
      expect([...pending]).toEqual([]);
      const real = delivered.filter((l) => !l.startsWith("input:"));
      expect(new Set(real).size).toBe(real.length); // exactly once
      expect(new Set(real)).toEqual(new Set([...expected].filter((e) => !e.startsWith("input:"))));
      // The dialog: once per distinct state, never per poll.
      expect(inputs.length).toBeLessThanOrEqual(dialogSince);
      expect(new Set(inputs).size).toBe(inputs.length);
    });
  }
});

describe("engine seams the earlier suites left unpinned", () => {
  it("flushes the sync segment before returning (and writes nothing when sync is off)", async () => {
    const dir = join(env.dir, "sync");
    mkdirSync(dir, { recursive: true });
    mkTask(env.db, "a");
    close("a");
    await withEnv("MU_SYNC_DIR", dir, async () => {
      await waitForEvents(env.db, [taskRef("a")], { callers: [], pollMs: 1, sync: false });
      expect(readdirSync(dir)).toEqual([]);
      const r = await waitForEvents(env.db, [taskRef("a")], { callers: [], pollMs: 1 });
      expect(r.event.kind).toBe("closed");
      expect(readdirSync(dir).length).toBeGreaterThan(0);
    });
  });

  it("human needs are the union over the callers: one under each name is returned", async () => {
    recordHumanNeeded(env.db, { workstream: "w", caller: "w/orch", reason: "first caller" });
    recordHumanNeeded(env.db, { workstream: "w", caller: "pi:s", reason: "second caller" });
    recordHumanNeeded(env.db, { workstream: "w", caller: "pi:other", reason: "not mine" });
    mkTask(env.db, "a");
    close("a");
    const r = await waitForEvents(env.db, [taskRef("a")], { ...base, callers: ["w/orch", "pi:s"] });
    expect(r.humanNeeds.map((h) => h.reason).sort()).toEqual(["first caller", "second caller"]);
  });

  it("an abort while sleeping returns at once, not at the deadline", async () => {
    mkTask(env.db, "a");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const t0 = Date.now();
    const r = await waitForEvents(env.db, [taskRef("a")], {
      callers: [],
      sync: false,
      pollMs: 10_000,
      signal: ac.signal,
      timeoutMs: 5000,
    });
    expect(r.interrupted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
