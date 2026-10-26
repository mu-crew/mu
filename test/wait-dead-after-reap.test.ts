// df2_wait_dead_after_reap (dogfood-2 F1): a reaper flip is a durable fact. A wait or resume
// that starts AFTER a watched task's owner died (so no tick of it ever saw the owner) still
// reports `dead` (exit 6), from the ops log, never from a wait's memory. A release, a park or a
// deliberate close by the owner is a decision, not a death. Real SQLite; agents scripted.

import { describe, expect, it } from "vitest";
import { deleteAgent } from "../src/agents.js";
import { releaseTask } from "../src/tasks/claim.js";
import { claimTask, closeTask, parkTask } from "../src/tasks.js";
import { type AgentReading, waitForEvents } from "../src/wait.js";
import { opsHead, reapFlip } from "../src/wait-db.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { mkOwnedTask, scriptedAgents, taskRef, useWaitDb } from "./_wait-fixtures.js";

const env = useWaitDb();
const fast = { callers: [], pollMs: 1, sync: false, timeoutMs: 30 } as const;
/** Owners read as alive unless a test says otherwise: only the reaper flip can make it dead. */
const alive = () => scriptedAgents(new Map<string, AgentReading>());

describe("a reaper flip the wait never saw live", () => {
  it("(b) owner reaped BEFORE the wait starts, anchor before the death: dead, exit 6, on the first read", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const anchor = opsHead(env.db);
    deleteAgent(env.db, "w1", "w");
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...fast,
      sinceSeq: anchor,
      ...alive(),
    });
    expect(r.event).toMatchObject({ kind: "dead", ref: { kind: "task", id: "t1" } });
    expect(r.exit).toBe(6);
    expect(r.refs[0]).toMatchObject({ status: "OPEN", dead: true });
  });

  it("(c) a resume anchored at the earlier wait's start sees a death between the two waits", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const hb = await waitForEvents(env.db, [taskRef("t1")], { ...fast, ...alive() });
    expect(hb.event.kind).toBe("heartbeat");
    expect(hb.sinceSeq).toBeTypeOf("number");
    deleteAgent(env.db, "w1", "w");
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...fast,
      ...(hb.sinceSeq !== undefined ? { sinceSeq: hb.sinceSeq } : {}),
      ...alive(),
    });
    expect(r.event).toMatchObject({ kind: "dead", ref: { kind: "task", id: "t1" } });
    expect(r.exit).toBe(6);
  });

  it("(a) owner dies while the wait runs: dead, exit 6 (the live path still holds)", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    let polls = 0;
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...fast,
      timeoutMs: 1000,
      sleep: async () => {
        if (++polls === 1) deleteAgent(env.db, "w1", "w");
      },
      ...alive(),
    });
    expect(r.event).toMatchObject({ kind: "dead", ref: { kind: "task", id: "t1" } });
    expect(r.exit).toBe(6);
  });

  it("a caller-registered task owes a flip from before this wait: dead once, then consumed", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const caller = "pi:reap";
    registerOwnedWait(env.db, caller, [taskRef("t1")]);
    deleteAgent(env.db, "w1", "w");
    const opts = { ...fast, callers: [caller], ...alive() };
    const r = await waitForEvents(env.db, [], opts);
    expect(r.event).toMatchObject({ kind: "dead", ref: { kind: "task", id: "t1" } });
    expect(r.exit).toBe(6);
    const again = await waitForEvents(env.db, [], opts);
    expect(again.event.kind).not.toBe("dead");
  });

  it("reaped, reclaimed by another worker, reaped again: a registered caller hears BOTH deaths", async () => {
    // The dead token names the reaped owner row: one per death, so the second is news.
    await mkOwnedTask(env.db, "t1", "w1");
    const caller = "pi:reap2";
    registerOwnedWait(env.db, caller, [taskRef("t1")]);
    const opts = { ...fast, callers: [caller], ...alive() };
    deleteAgent(env.db, "w1", "w");
    const first = await waitForEvents(env.db, [], opts);
    expect(first.event).toMatchObject({ kind: "dead", ref: { kind: "task", id: "t1" } });
    await mkOwnedTask(env.db, "t2", "w2");
    await claimTask(env.db, "t1", { workstream: "w", agentName: "w2" });
    registerOwnedWait(env.db, caller, [taskRef("t1")]);
    deleteAgent(env.db, "w2", "w");
    const second = await waitForEvents(env.db, [], opts);
    expect(second.event).toMatchObject({ kind: "dead", ref: { kind: "task", id: "t1" } });
    expect(second.exit).toBe(6);
  });

  it("a flip from before an explicit wait's own anchor is history, not news", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    deleteAgent(env.db, "w1", "w");
    const r = await waitForEvents(env.db, [taskRef("t1")], { ...fast, ...alive() });
    expect(r.event.kind).toBe("heartbeat");
    expect(r.exit).toBe(0);
  });
});

describe("a decision is not a death", () => {
  it("a release (owner alive) after the anchor: no dead", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const anchor = opsHead(env.db);
    releaseTask(env.db, "t1", { workstream: "w" });
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...fast,
      sinceSeq: anchor,
      ...alive(),
    });
    expect(r.event.kind).toBe("heartbeat");
    expect(reapFlip(env.db, taskRef("t1"), anchor)).toBeUndefined();
  });

  it("df1: the task CLOSED by its worker, then the worker closed on purpose: no dead", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const anchor = opsHead(env.db);
    closeTask(env.db, "t1", { workstream: "w", evidence: "done" });
    deleteAgent(env.db, "w1", "w");
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...fast,
      sinceSeq: anchor,
      ...alive(),
    });
    expect(r.event).toMatchObject({ kind: "closed", ref: { id: "t1" } });
    expect(r.exit).toBe(0);
  });

  it("reaped, then claimed again by another worker: the latest change is the claim, no dead", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const anchor = opsHead(env.db);
    deleteAgent(env.db, "w1", "w");
    await mkOwnedTask(env.db, "t2", "w2");
    await claimTask(env.db, "t1", { workstream: "w", agentName: "w2" });
    expect(reapFlip(env.db, taskRef("t1"), anchor)).toBeUndefined();
  });

  it("reaped, then PARKED (a substate-only change): the park is the latest decision, no dead", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const anchor = opsHead(env.db);
    deleteAgent(env.db, "w1", "w");
    expect(reapFlip(env.db, taskRef("t1"), anchor)).toBeDefined();
    parkTask(env.db, "t1", { workstream: "w", why: "waiting on a decision" });
    expect(reapFlip(env.db, taskRef("t1"), anchor)).toBeUndefined();
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...fast,
      sinceSeq: anchor,
      ...alive(),
    });
    expect(r.event.kind).toBe("heartbeat");
  });

  it("reapFlip names the reaped owner row and the flip's seq", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const owner = (
      env.db.prepare("SELECT id FROM agents WHERE name = 'w1'").get() as { id: number }
    ).id;
    const anchor = opsHead(env.db);
    deleteAgent(env.db, "w1", "w");
    const flip = reapFlip(env.db, taskRef("t1"), anchor);
    expect(flip?.ownerId).toBe(owner);
    expect(flip?.seq).toBeGreaterThan(anchor);
    expect(reapFlip(env.db, taskRef("t1"), flip?.seq ?? 0)).toBeUndefined();
  });
});
