// Guarded stall release (v_wait_release): releaseStall as a handleStall, through
// the real engine. Every guard is checked in the same immediate transaction as
// the write; a refused release changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const releaseSpy = vi.hoisted(() => ({
  calls: [] as unknown[][],
  /** When set, replaces the release result (the real one is NOT run). */
  override: undefined as { changed: false } | undefined,
}));
vi.mock("../src/tasks/claim.js", async (orig) => {
  const real = await orig<typeof import("../src/tasks/claim.js")>();
  return {
    ...real,
    releaseTask: (...a: Parameters<typeof real.releaseTask>) => {
      releaseSpy.calls.push(a);
      if (releaseSpy.override !== undefined) {
        return {
          previousOwnerName: null,
          previousStatus: "IN_PROGRESS",
          status: "IN_PROGRESS",
          ...releaseSpy.override,
        };
      }
      return real.releaseTask(...a);
    },
  };
});

import {
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { openDb } from "../src/db.js";
import { recordHumanNeeded } from "../src/human-needed.js";
import { taskRevision } from "../src/revision.js";
import { authorizeTasks } from "../src/task-auto.js";
import { claimTask } from "../src/tasks/claim.js";
import { taskIdFor } from "../src/tasks/core.js";
import { addNote } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { getTask } from "../src/tasks/queries.js";
import { type AgentReading, type WaitStallContext, waitForEvents } from "../src/wait.js";
import { releaseStall, releaseStallHandler } from "../src/wait-actions.js";
import { beginWait, registerOwnedWait } from "../src/wait-registration.js";
import { mkTask, scriptedAgents, taskRef, useWaitDb } from "./_wait-fixtures.js";

const env = useWaitDb();
const CALLER = "pi:s";
const base = { pollMs: 1, sync: false, timeoutMs: 1000 } as const;

beforeEach(() => {
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
});
afterEach(() => {
  resetCommandResolverForTests();
  releaseSpy.override = undefined;
});

const stalled = (over: Partial<AgentReading> = {}): AgentReading => ({
  status: "needs_input",
  source: "ctl",
  ctl: "ok",
  since: Date.now() - 600_000,
  incarnation: "inc",
  runs: 2,
  ...over,
});

/** A task owned by an agent that CALLER spawned, authorised for this machine. */
async function setup(
  over: { spawner?: string | null; auth?: boolean; id?: string; agent?: string } = {},
) {
  const id = over.id ?? "t1";
  const agent = over.agent ?? "w1";
  mkTask(env.db, id);
  const a = insertAgent(env.db, {
    name: agent,
    workstream: "w",
    paneId: `%${agent}`,
    cli: "pi",
    spawner: over.spawner === undefined ? CALLER : over.spawner,
  });
  await claimTask(env.db, id, { workstream: "w", agentName: agent });
  if (over.auth !== false) {
    authorizeTasks(env.db, [id], { workstream: "w", cli: "pi", worktree: false, maxRuns: 1 });
  }
  return { agentId: a.incarnation, taskId: taskIdFor(env.db, id, "w") as number };
}

/** The context the engine would hand over, rebuilt from the DB. */
function ctxOf(
  s: { agentId: number; taskId: number },
  over: Partial<WaitStallContext> = {},
  id = "t1",
  agent = "w1",
): WaitStallContext {
  const t = getTask(env.db, id, "w");
  return {
    caller: CALLER,
    generation: null,
    ref: taskRef(id),
    taskId: s.taskId,
    revision: revisionOf(id),
    owner: {
      workstream: "w",
      name: agent,
      agentId: s.agentId,
      paneId: `%${agent}`,
      status: "needs_input",
      source: "ctl",
      since: Date.now() - 600_000,
      settled: false,
      ctl: "ok",
      incarnation: "inc",
      runs: 2,
    },
    stallToken: `tok-${t?.name}`,
    deadlineMs: 10_000,
    signal: new AbortController().signal,
    ...over,
  };
}
const revisionOf = (id: string) => taskRevision(env.db, "w", id);

const state = (id = "t1") => {
  const t = getTask(env.db, id, "w");
  return { status: t?.status, owner: t?.ownerName ?? null };
};
const receipts = () => env.db.prepare("SELECT * FROM wait_action_receipts").all();
const release = (ctx: WaitStallContext, callers: string[] = [CALLER]) =>
  releaseStall(env.db, ctx, { callers });

describe("releaseStall: the happy path", () => {
  it("releases an authorised IN_PROGRESS work task its caller's agent owns; reopens never; one receipt", async () => {
    const s = await setup();
    const ctx = ctxOf(s);
    const r = await release(ctx);
    expect(r).toMatchObject({ disposition: "return", action: "release", state: "released" });
    expect(state()).toEqual({ status: "OPEN", owner: null });
    expect(receipts()).toEqual([
      expect.objectContaining({
        task_id: s.taskId,
        owner_id: s.agentId,
        incarnation: "inc",
        action: "release",
        caller: CALLER,
        task_ref: "w/t1",
        owner_ref: "w/w1",
        pane_id: "%w1",
        preview_revision: ctx.revision,
        state: "released",
      }),
    ]);
  });

  it("calls releaseTask fenced on the owner id and the revision, never reopening", async () => {
    const s = await setup();
    const ctx = ctxOf(s);
    releaseSpy.calls.length = 0;
    await release(ctx);
    expect(releaseSpy.calls).toHaveLength(1);
    expect(releaseSpy.calls[0]?.[2]).toMatchObject({
      workstream: "w",
      expectedOwnerId: s.agentId,
      ifRevision: ctx.revision,
    });
    expect(releaseSpy.calls[0]?.[2]).not.toHaveProperty("reopen", true);
  });

  it("closes, spawns and kills nothing: the owner agent row and task_auto survive", async () => {
    const s = await setup();
    await release(ctxOf(s));
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual({ n: 1 });
    expect(env.db.prepare("SELECT runs, enabled FROM task_auto").get()).toEqual({
      runs: 0,
      enabled: 1,
    });
    expect(getTask(env.db, "t1", "w")?.status).not.toBe("CLOSED");
  });

  it("the release op is attributed to the caller and leaves an evidence note", async () => {
    const s = await setup();
    await release(ctxOf(s));
    const note = env.db
      .prepare("SELECT author, content FROM task_notes WHERE content LIKE 'RELEASE:%'")
      .get() as { author: string; content: string };
    expect(note.author).toBe(CALLER);
    expect(note.content).toMatch(/stall/i);
  });

  it("works for a managed ws/name caller as well (the set, not one string)", async () => {
    const s = await setup({ spawner: "w/boss" });
    const r = await release(ctxOf(s, { caller: "w/boss" }), ["w/boss", "pi:other"]);
    expect(r.state).toBe("released");
  });
});

/** Every refusal: nothing written, no receipt, an honest reason. */
async function refused(
  s: { agentId: number; taskId: number },
  ctx: WaitStallContext,
  callers: string[] = [CALLER],
  reason?: RegExp,
) {
  const before = {
    task: state(),
    ops: env.db.prepare("SELECT COUNT(*) AS n FROM ops").get(),
    notes: env.db.prepare("SELECT COUNT(*) AS n FROM task_notes").get(),
  };
  const r = await release(ctx, callers);
  expect(r).toMatchObject({ disposition: "return", action: "release", state: "refused" });
  if (reason !== undefined) expect(r.reason).toMatch(reason);
  expect(receipts()).toEqual([]);
  expect({
    task: state(),
    ops: env.db.prepare("SELECT COUNT(*) AS n FROM ops").get(),
    notes: env.db.prepare("SELECT COUNT(*) AS n FROM task_notes").get(),
  }).toEqual(before);
  void s;
}

describe("releaseStall: every guard refuses with no effect", () => {
  it("a non-auto task (no task_auto, or disabled)", async () => {
    const s = await setup({ auth: false });
    await refused(s, ctxOf(s), [CALLER], /permit|auto/i);
    authorizeTasks(env.db, ["t1"], { workstream: "w", cli: "pi", worktree: false, maxRuns: 1 });
    authorizeTasks(env.db, ["t1"], {
      workstream: "w",
      cli: "pi",
      worktree: false,
      maxRuns: 1,
      off: true,
    });
    await refused(s, ctxOf(s), [CALLER], /permit|auto/i);
  });

  it("a task designated to another host", async () => {
    const s = await setup();
    env.db.prepare("UPDATE tasks SET dispatch_host = 'elsewhere' WHERE id = ?").run(s.taskId);
    await refused(s, ctxOf(s), [CALLER], /permit|auto/i);
  });

  it("a caller that is not in the callers set, or whose set is empty", async () => {
    const s = await setup();
    await refused(s, ctxOf(s, { caller: "pi:stranger" }), [CALLER], /caller/i);
    await refused(s, ctxOf(s), [], /caller/i);
  });

  it("a worker another caller spawned (explicit refs are not authority over foreign workers)", async () => {
    const s = await setup({ spawner: "pi:foreign" });
    await refused(s, ctxOf(s), [CALLER], /spawn|own/i);
  });

  it("a worker with no recorded spawner", async () => {
    const s = await setup({ spawner: null });
    await refused(s, ctxOf(s), [CALLER], /spawn|own/i);
  });

  it("an owner replaced since the stall (same name, new registry id)", async () => {
    const s = await setup();
    const ctx = ctxOf(s);
    await releaseTaskOwnerSwap();
    await refused(s, ctx, [CALLER], /owner/i);
  });

  it("a task re-owned by another agent", async () => {
    const s = await setup();
    const ctx = ctxOf(s);
    env.db.prepare("UPDATE tasks SET owner_id = NULL WHERE id = ?").run(s.taskId);
    insertAgent(env.db, { name: "w2", workstream: "w", paneId: "%w2", cli: "pi", spawner: CALLER });
    await claimTask(env.db, "t1", { workstream: "w", agentName: "w2" });
    await refused(s, ctx, [CALLER], /owner/i);
  });

  it("a pane that changed", async () => {
    const s = await setup();
    const ctx = ctxOf(s);
    env.db.prepare("UPDATE agents SET pane_id = '%moved' WHERE id = ?").run(s.agentId);
    await refused(s, ctx, [CALLER], /pane/i);
  });

  it("an unowned task, a closed task, an OPEN task", async () => {
    const s = await setup();
    const ctx = ctxOf(s);
    env.db.prepare("UPDATE tasks SET owner_id = NULL WHERE id = ?").run(s.taskId);
    await refused(s, ctx, [CALLER], /owner/i);
    env.db.prepare("UPDATE tasks SET owner_id = ? WHERE id = ?").run(s.agentId, s.taskId);
    closeTask(env.db, "t1", { workstream: "w", evidence: "done" });
    await refused(s, ctxOf(s), [CALLER], /IN_PROGRESS|closed|status/i);
    env.db
      .prepare("UPDATE tasks SET status = 'OPEN', substate = 'todo' WHERE id = ?")
      .run(s.taskId);
    await refused(s, ctxOf(s), [CALLER], /IN_PROGRESS|status/i);
  });

  it("a delegate or human task", async () => {
    for (const kind of ["delegate", "human"] as const) {
      const s = await setup({ id: `k-${kind}`, agent: `a-${kind}` });
      env.db.prepare("UPDATE tasks SET kind = ? WHERE id = ?").run(kind, s.taskId);
      await refused(s, ctxOf(s, {}, `k-${kind}`, `a-${kind}`), [CALLER], /never released/);
    }
  });

  it("a ref that does not name the task PK", async () => {
    const s = await setup();
    await refused(s, ctxOf(s, { ref: taskRef("elsewhere") }), [CALLER], /ref|task/i);
  });

  it("a stale revision: any change since the stall was seen", async () => {
    const s = await setup();
    const ctx = ctxOf(s);
    addNote(env.db, "t1", "the owner reported something", { workstream: "w", author: "w1" });
    await refused(s, ctx, [CALLER], /revision/i);
  });

  // One DB per stopper (one `it` each): in a shared DB the first stopper's need stays open
  // and would mask a guard that only looked at ctx.caller.
  for (const stopper of [CALLER, "w/boss"]) {
    it(`an open human stop of ${stopper} alone (any caller in the set blocks, both producers)`, async () => {
      const s = await setup();
      recordHumanNeeded(env.db, { workstream: "w", caller: stopper, reason: "need the owner" });
      await refused(s, ctxOf(s), [CALLER, "w/boss"], /human/i);
    });
  }

  it("another caller's human stop does not block", async () => {
    const s = await setup();
    recordHumanNeeded(env.db, { workstream: "w", caller: "pi:someone-else", reason: "x" });
    expect((await release(ctxOf(s))).state).toBe("released");
  });

  it("an owner at a permission dialog, a dead pane, or a runtime we cannot read", async () => {
    const s = await setup();
    for (const status of ["needs_permission", null, "unknown", "busy"] as const) {
      const ctx = ctxOf(s);
      await refused(
        s,
        { ...ctx, owner: { ...ctx.owner, status } },
        [CALLER],
        /owner|runtime|state/i,
      );
    }
  });

  it("a broken control socket on a live pane is a stall too (released), a dead pane is not", async () => {
    const s = await setup();
    const ctx = ctxOf(s);
    const broken = { ...ctx.owner, status: "unknown" as const, ctl: "refused" as const };
    await refused(
      s,
      { ...ctx, owner: { ...broken, status: null } },
      [CALLER],
      /owner|runtime|state/i,
    );
    expect((await release({ ...ctx, owner: broken })).state).toBe("released");
  });

  it("a wait that no longer is the registered generation", async () => {
    const s = await setup();
    registerOwnedWait(env.db, CALLER, [{ kind: "task", workstream: "w", id: "t1" }]);
    const first = beginWait(env.db, CALLER);
    beginWait(env.db, CALLER); // a newer wait of the same caller
    await refused(
      s,
      ctxOf(s, { generation: first?.generation ?? 0 }),
      [CALLER],
      /generation|superseded/i,
    );
    const now = beginWait(env.db, CALLER);
    expect((await release(ctxOf(s, { generation: now?.generation ?? 0 }))).state).toBe("released");
  });

  it("an aborted wait", async () => {
    const s = await setup();
    const ac = new AbortController();
    ac.abort();
    await refused(s, ctxOf(s, { signal: ac.signal }), [CALLER], /abort/i);
  });
});

async function releaseTaskOwnerSwap() {
  // delete + recreate the owner: same name and pane, new registry id.
  env.db
    .prepare("UPDATE tasks SET owner_id = NULL, status = 'IN_PROGRESS' WHERE local_id = 't1'")
    .run();
  env.db.prepare("DELETE FROM agents WHERE name = 'w1'").run();
  const a = insertAgent(env.db, {
    name: "w1",
    workstream: "w",
    paneId: "%w1",
    cli: "pi",
    spawner: CALLER,
  });
  env.db.prepare("UPDATE tasks SET owner_id = ? WHERE local_id = 't1'").run(a.incarnation);
}

describe("releaseStall: exactly once", () => {
  it("the receipt exhausts a second release of the same owner incarnation, whoever asks", async () => {
    const s = await setup();
    expect((await release(ctxOf(s))).state).toBe("released");
    // The same worker re-claims the task and stalls again in the same incarnation.
    await claimTask(env.db, "t1", { workstream: "w", agentName: "w1" });
    const r = await release(ctxOf(s));
    expect(r).toMatchObject({ disposition: "return", state: "budget-exhausted" });
    expect(state()).toMatchObject({ status: "IN_PROGRESS", owner: "w1" });
    expect(receipts()).toHaveLength(1);
  });

  it("a new ctl incarnation is a fresh budget", async () => {
    const s = await setup();
    await release(ctxOf(s));
    await claimTask(env.db, "t1", { workstream: "w", agentName: "w1" });
    const ctx = ctxOf(s);
    const r = await release({ ...ctx, owner: { ...ctx.owner, incarnation: "inc-2" } });
    expect(r.state).toBe("released");
    expect(receipts()).toHaveLength(2);
  });

  it("two connections releasing the same stall: one writes, one finds nothing to do", async () => {
    const s = await setup();
    const other = openDb({ path: env.db.name });
    try {
      const ctx = ctxOf(s);
      const [a, b] = [await release(ctx), await releaseStall(other, ctx, { callers: [CALLER] })];
      expect([a.state, b.state].sort()).toEqual(["refused", "released"]);
      expect(receipts()).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});

describe("releaseStall: no transaction spans an await, failures are honest", () => {
  it("leaves no open transaction after it returns, refused or released", async () => {
    const s = await setup();
    await release(ctxOf(s, { caller: "pi:stranger" }));
    expect(env.db.inTransaction).toBe(false);
    await release(ctxOf(s));
    expect(env.db.inTransaction).toBe(false);
  });

  it("every guard read runs inside the transaction that does the release", async () => {
    const s = await setup();
    const seen: boolean[] = [];
    const real = env.db.prepare.bind(env.db);
    vi.spyOn(env.db, "prepare").mockImplementation(((sql: string) => {
      const st = real(sql);
      if (/task_auto/.test(sql) && /enabled/.test(sql)) {
        const get = st.get.bind(st);
        st.get = ((...a: unknown[]) => {
          seen.push(env.db.inTransaction);
          return get(...a);
        }) as typeof st.get;
      }
      return st;
    }) as typeof env.db.prepare);
    expect((await release(ctxOf(s))).state).toBe("released");
    expect(seen).toEqual([true]);
  });

  it("another connection cannot change a guarded fact between the check and the write", async () => {
    const s = await setup();
    const other = openDb({ path: env.db.name });
    other.pragma("busy_timeout = 1");
    let blocked: unknown;
    const real = env.db.prepare.bind(env.db);
    vi.spyOn(env.db, "prepare").mockImplementation(((sql: string) => {
      const st = real(sql);
      if (/task_auto/.test(sql) && /enabled/.test(sql)) {
        const get = st.get.bind(st);
        st.get = ((...a: unknown[]) => {
          // mid-guard: the permission is revoked by someone else
          try {
            other.exec("UPDATE task_auto SET enabled = 0");
          } catch (e) {
            blocked = e;
          }
          return get(...a);
        }) as typeof st.get;
      }
      return st;
    }) as typeof env.db.prepare);
    try {
      expect((await release(ctxOf(s))).state).toBe("released");
      expect(String(blocked)).toMatch(/locked|busy/i);
    } finally {
      other.close();
    }
  });

  it("a receipt insert that fails AFTER the release rolls the release back", async () => {
    const s = await setup();
    env.db.exec(
      `CREATE TRIGGER no_receipt BEFORE INSERT ON wait_action_receipts
         BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    const calls = releaseSpy.calls.length;
    const r = await release(ctxOf(s));
    expect(r).toMatchObject({ state: "refused", reason: expect.stringMatching(/disk full/) });
    expect(releaseSpy.calls).toHaveLength(calls + 1); // it did get as far as releasing
    expect(state()).toEqual({ status: "IN_PROGRESS", owner: "w1" });
    expect(receipts()).toEqual([]);
    expect(env.db.inTransaction).toBe(false);
  });

  it("a release that changes nothing is refused and leaves no receipt (the defence stays pinned)", async () => {
    const s = await setup();
    releaseSpy.override = { changed: false };
    await refused(s, ctxOf(s), [CALLER], /changed nothing/);
  });

  it("a storage failure rolls everything back and reports refused, never a half release", async () => {
    const s = await setup();
    env.db.exec("DROP TABLE wait_action_receipts");
    const r = await release(ctxOf(s));
    expect(r).toMatchObject({ state: "refused" });
    expect(state()).toMatchObject({ status: "IN_PROGRESS", owner: "w1" });
    expect(env.db.inTransaction).toBe(false);
  });
});

describe("as a handleStall through the engine", () => {
  const stalledTable = () => new Map([["w/w1", stalled()]]);

  it("onStall 'release' releases the task and returns the stall with the action", async () => {
    await setup();
    registerOwnedWait(env.db, CALLER, [{ kind: "task", workstream: "w", id: "t1" }]);
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: [CALLER],
      stuckAfterMs: 1000,
      onStall: "release",
      handleStall: releaseStallHandler(env.db, { callers: [CALLER] }),
      ...scriptedAgents(stalledTable()),
    });
    expect(r.event.kind).toBe("stall");
    expect(r.exit).toBe(7);
    expect(r.action).toMatchObject({ action: "release", state: "released", disposition: "return" });
    expect(state()).toEqual({ status: "OPEN", owner: null });
    expect(receipts()).toHaveLength(1);
  });

  it("a refused release still returns the stall (actionable), the task untouched", async () => {
    await setup({ auth: false });
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: [CALLER],
      stuckAfterMs: 1000,
      onStall: "release",
      handleStall: releaseStallHandler(env.db, { callers: [CALLER] }),
      ...scriptedAgents(stalledTable()),
    });
    expect(r.event.kind).toBe("stall");
    expect(r.action).toMatchObject({ action: "release", state: "refused" });
    expect(state()).toMatchObject({ status: "IN_PROGRESS", owner: "w1" });
  });

  it("the default onStall ('exit') never releases", async () => {
    await setup();
    const spy = vi.fn(releaseStallHandler(env.db, { callers: [CALLER] }));
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: [CALLER],
      stuckAfterMs: 1000,
      handleStall: spy,
      ...scriptedAgents(stalledTable()),
    });
    expect(r.event.kind).toBe("stall");
    expect(spy).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ status: "IN_PROGRESS", owner: "w1" });
  });
});
