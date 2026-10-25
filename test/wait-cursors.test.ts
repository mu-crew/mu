// Wait cursors and delivery (v_wait_engine): typed collision-free keys,
// durable completion tokens, deliver-once, first-sibling preservation,
// incarnation reset, one active wait per caller. Real SQLite, no ctl.

import { describe, expect, it } from "vitest";
import { closeTask, openTask } from "../src/tasks.js";
import { type AgentReading, waitForEvents } from "../src/wait.js";
import {
  closedToken,
  cursorKey,
  DELEGATE_TOKEN,
  isConsumed,
  readCursors,
  recordCursors,
} from "../src/wait-cursor.js";
import { readWaitRegistration, registerOwnedWait } from "../src/wait-registration.js";
import {
  agentRef,
  answer,
  controllableWatch,
  mkAgent,
  mkDelegate,
  mkTask,
  taskRef,
  useWaitDb,
} from "./_wait-fixtures.js";

const env = useWaitDb();
const fast = { pollMs: 1, sync: false, timeoutMs: 1000 } as const;
const close = (id: string, ws = "w") => closeTask(env.db, id, { workstream: ws, evidence: "e" });
const owed = (caller: string) => readWaitRegistration(env.db, caller)?.refs.map((r) => r.id) ?? [];

describe("cursor store", () => {
  it("keys are typed: a task, an agent and a delegate with one id never collide", () => {
    const keys = [
      cursorKey("task", "w", "x"),
      cursorKey("agent", "w", "x"),
      cursorKey("delegate", "w", "x"),
      cursorKey("task", "w2", "x"),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it("recordCursors is monotonic within an incarnation and replaces on a new one", () => {
    const k = cursorKey("agent", "w", "a1");
    recordCursors(env.db, "c", [{ key: k, token: { incarnation: "i1", runs: 5 } }]);
    recordCursors(env.db, "c", [{ key: k, token: { incarnation: "i1", runs: 3 } }]);
    expect(readCursors(env.db, "c").get(k)).toEqual({ incarnation: "i1", runs: 5 });
    recordCursors(env.db, "c", [{ key: k, token: { incarnation: "i2", runs: 1 } }]);
    expect(readCursors(env.db, "c").get(k)).toEqual({ incarnation: "i2", runs: 1 });
  });

  it("isConsumed: same incarnation and runs at or below the cursor only", () => {
    expect(isConsumed({ incarnation: "i", runs: 2 }, { incarnation: "i", runs: 2 })).toBe(true);
    expect(isConsumed({ incarnation: "i", runs: 2 }, { incarnation: "i", runs: 3 })).toBe(false);
    expect(isConsumed({ incarnation: "old", runs: 9 }, { incarnation: "new", runs: 1 })).toBe(
      false,
    );
    expect(isConsumed(undefined, DELEGATE_TOKEN)).toBe(false);
    expect(isConsumed(closedToken(4), closedToken(5))).toBe(false);
  });

  it("cursors are per caller", () => {
    const k = cursorKey("task", "w", "a");
    recordCursors(env.db, "c1", [{ key: k, token: closedToken(1) }]);
    expect(readCursors(env.db, "c2").size).toBe(0);
  });
});

describe("closed tasks: delivered once, not replayed forever", () => {
  it("an owned closed task is delivered, consumed and removed; a later wait does not see it again", async () => {
    mkTask(env.db, "a");
    mkTask(env.db, "b");
    close("a");
    registerOwnedWait(env.db, "c", [taskRef("a"), taskRef("b")]);
    const r1 = await waitForEvents(env.db, [], { ...fast, caller: "c" });
    expect(r1.event).toMatchObject({ kind: "closed", ref: { id: "a" } });
    expect(owed("c")).toEqual(["b"]);
    expect(Object.keys(r1.cursor)).toEqual([cursorKey("task", "w", "a")]);
    // Re-registering the history does not make it news again: the token holds.
    registerOwnedWait(env.db, "c", [taskRef("a")]);
    const r2 = await waitForEvents(env.db, [], { ...fast, caller: "c", timeoutMs: 15 });
    expect(r2.timedOut).toBe(true);
    expect(owed("c")).toEqual(["a", "b"]);
  });

  it("a reopened and re-closed task is news again (the token moves)", async () => {
    mkTask(env.db, "a");
    close("a");
    registerOwnedWait(env.db, "c", [taskRef("a")]);
    await waitForEvents(env.db, [], { ...fast, caller: "c" });
    openTask(env.db, "a", { workstream: "w" });
    closeTask(env.db, "a", { workstream: "w", evidence: "second" });
    registerOwnedWait(env.db, "c", [taskRef("a")]);
    const r = await waitForEvents(env.db, [], { ...fast, caller: "c" });
    expect(r.event).toMatchObject({ kind: "closed", ref: { id: "a" } });
  });

  it("an explicit ref ignores the cursor: asking about a consumed closed task answers at once", async () => {
    mkTask(env.db, "a");
    close("a");
    registerOwnedWait(env.db, "c", [taskRef("a")]);
    await waitForEvents(env.db, [], { ...fast, caller: "c" });
    const r = await waitForEvents(env.db, [taskRef("a")], { ...fast, caller: "c" });
    expect(r.event.kind).toBe("closed");
  });

  it("without a caller nothing is registered, read or written", async () => {
    mkTask(env.db, "a");
    close("a");
    await waitForEvents(env.db, [taskRef("a")], fast);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM wait_cursors").get()).toEqual({ n: 0 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM wait_registrations").get()).toEqual({ n: 0 });
  });
});

describe("first keeps the siblings it did not return", () => {
  it("two ready owned refs: one per wait, the other stays owed and unconsumed", async () => {
    mkTask(env.db, "a");
    mkTask(env.db, "b");
    close("a");
    close("b");
    registerOwnedWait(env.db, "c", [taskRef("a"), taskRef("b")]);
    const r1 = await waitForEvents(env.db, [], { ...fast, caller: "c" });
    expect(r1.event.ref?.id).toBe("a");
    expect(owed("c")).toEqual(["b"]);
    expect(Object.keys(readCursors(env.db, "c"))).not.toContain(cursorKey("task", "w", "b"));
    expect(readCursors(env.db, "c").has(cursorKey("task", "w", "b"))).toBe(false);
    const r2 = await waitForEvents(env.db, [], { ...fast, caller: "c" });
    expect(r2.event.ref?.id).toBe("b");
    expect(owed("c")).toEqual([]);
  });

  it("a delegate report is delivered once, even if it finished before any wait saw it", async () => {
    const d1 = mkDelegate(env.db, "c");
    const d2 = mkDelegate(env.db, "c");
    answer(env.db, d1);
    answer(env.db, d2);
    const a = await waitForEvents(env.db, [], { ...fast, caller: "c" });
    const b = await waitForEvents(env.db, [], { ...fast, caller: "c" });
    expect([a.event.ref?.id, b.event.ref?.id]).toEqual([d1, d2]);
    expect(readCursors(env.db, "c").size).toBe(2);
    // History is quiet now: nothing owed, nothing to wait for.
    await expect(waitForEvents(env.db, [], { ...fast, caller: "c" })).rejects.toThrow(
      /nothing to wait/,
    );
  });

  it("a timeout and an interrupt deliver nothing: everything stays owed", async () => {
    mkTask(env.db, "a");
    registerOwnedWait(env.db, "c", [taskRef("a")]);
    await waitForEvents(env.db, [], { ...fast, caller: "c", timeoutMs: 10 });
    const ac = new AbortController();
    ac.abort();
    await waitForEvents(env.db, [], { ...fast, caller: "c", signal: ac.signal });
    expect(owed("c")).toEqual(["a"]);
    expect(readCursors(env.db, "c").size).toBe(0);
    expect(readWaitRegistration(env.db, "c")?.state).toBe("armed");
  });

  it("registering during a wait is not lost when the wait ends", async () => {
    mkTask(env.db, "a");
    mkTask(env.db, "late");
    close("a");
    registerOwnedWait(env.db, "c", [taskRef("a")]);
    const r = await waitForEvents(env.db, [], {
      ...fast,
      caller: "c",
      beforePoll: async () => {
        registerOwnedWait(env.db, "c", [taskRef("late")]);
      },
    });
    expect(r.event.ref?.id).toBe("a");
    expect(owed("c")).toEqual(["late"]);
  });
});

describe("agents: incarnation and runs", () => {
  const settled = (inc: string, runs: number): AgentReading => ({
    status: "needs_input",
    settled: true,
    incarnation: inc,
    runs,
    lastText: "done",
  });
  const waitAgent = async (inc: string, runs: number, over: object = {}) => {
    const w = controllableWatch();
    w.settle(settled(inc, runs));
    return waitForEvents(env.db, [], {
      ...fast,
      caller: "c",
      applyClose: false,
      readAgents: async () => new Map(),
      watchAgent: async () => w.handle,
      ...over,
    });
  };

  it("a delivered settle moves the cursor; the same run is not delivered twice", async () => {
    mkAgent(env.db, "w1");
    registerOwnedWait(env.db, "c", [agentRef("w1")]);
    const r = await waitAgent("i1", 3);
    expect(r.event).toMatchObject({ kind: "settled", incarnation: "i1", runs: 3 });
    expect(readCursors(env.db, "c").get(cursorKey("agent", "w", "w1"))).toEqual({
      incarnation: "i1",
      runs: 3,
    });
    registerOwnedWait(env.db, "c", [agentRef("w1")]);
    const again = await waitAgent("i1", 3, { timeoutMs: 15 });
    expect(again.timedOut).toBe(true);
  });

  it("a stale high run count of an old incarnation never hides a new process's first run", async () => {
    mkAgent(env.db, "w1");
    registerOwnedWait(env.db, "c", [agentRef("w1")]);
    await waitAgent("old", 9);
    registerOwnedWait(env.db, "c", [agentRef("w1")]);
    const r = await waitAgent("new", 1);
    expect(r.event).toMatchObject({ kind: "settled", incarnation: "new", runs: 1 });
    expect(readCursors(env.db, "c").get(cursorKey("agent", "w", "w1"))).toEqual({
      incarnation: "new",
      runs: 1,
    });
  });

  it("the watch counts past the consumed runs of the same incarnation, from 0 otherwise", async () => {
    mkAgent(env.db, "w1");
    registerOwnedWait(env.db, "c", [agentRef("w1")]);
    recordCursors(env.db, "c", [
      { key: cursorKey("agent", "w", "w1"), token: { incarnation: "i1", runs: 4 } },
    ]);
    const seen: unknown[] = [];
    const w = controllableWatch();
    w.settle(settled("i1", 5));
    await waitForEvents(env.db, [], {
      ...fast,
      caller: "c",
      applyClose: false,
      readAgents: async () => new Map(),
      watchAgent: async (_ref, _sig, ctx) => {
        seen.push(ctx);
        return w.handle;
      },
    });
    expect(seen[0]).toEqual({ owed: true, cursor: { incarnation: "i1", runs: 4 } });
  });
});

describe("one active wait per caller", () => {
  it("an older wait finishing after a newer one began consumes nothing and says so", async () => {
    mkTask(env.db, "a");
    close("a");
    registerOwnedWait(env.db, "c", [taskRef("a")]);
    const r = await waitForEvents(env.db, [], {
      ...fast,
      caller: "c",
      beforePoll: async () => {
        // A newer wait of the same caller starts while this one is running.
        const { beginWait } = await import("../src/wait-registration.js");
        beginWait(env.db, "c");
      },
    });
    expect(r.event.ref?.id).toBe("a");
    expect(r.superseded).toBe(true);
    expect(owed("c")).toEqual(["a"]);
    expect(readCursors(env.db, "c").size).toBe(0);
  });

  it("two callers with the same refs consume independently", async () => {
    mkTask(env.db, "a");
    close("a");
    registerOwnedWait(env.db, "c1", [taskRef("a")]);
    registerOwnedWait(env.db, "c2", [taskRef("a")]);
    await waitForEvents(env.db, [], { ...fast, caller: "c1" });
    const r = await waitForEvents(env.db, [], { ...fast, caller: "c2" });
    expect(r.event.ref?.id).toBe("a");
  });
});
