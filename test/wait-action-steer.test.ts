// Crash-safe stall steer (v_wait_steer): at most one ctl write per task, owner
// and pi incarnation, whatever crashes, races or restarts. The fake extension
// remembers msgIds but does NOT dedupe sends (like the real one), so every
// `ext.sends` entry is a real delivery: SQLite, not the msgId, must prevent a
// second one.

import type { Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { openDb } from "../src/db.js";
import { recordHumanNeeded } from "../src/human-needed.js";
import { taskRevision } from "../src/revision.js";
import { authorizeTasks } from "../src/task-auto.js";
import { claimTask, releaseTask } from "../src/tasks/claim.js";
import { taskIdFor } from "../src/tasks/core.js";
import { addNote } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { type AgentReading, type WaitStallContext, waitForEvents } from "../src/wait.js";
import {
  type ActionKey,
  getActionReceipt,
  reserveActionReceipt,
  transitionActionReceipt,
} from "../src/wait-action-receipts.js";
import { steerStall, steerStallHandler, steerText, waitWithActions } from "../src/wait-actions.js";
import { registerOwnedWait } from "../src/wait-registration.js";
import { INC } from "./_ctl-ext.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { type FakeExt, newExt, serveFake } from "./_steer-ext.js";
import {
  answer,
  mkDelegate,
  mkTask,
  scriptedAgents,
  taskRef,
  useWaitDb,
} from "./_wait-fixtures.js";

const env = useWaitDb();
const CALLER = "pi:s";
let servers: Server[];
let ext: FakeExt;
let mux: MuxHarness;

beforeEach(async () => {
  servers = [];
  ext = newExt();
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  mux = installMux("tmux", async () => ({ stdout: "%w1\n", stderr: "", exitCode: 0 }));
});
afterEach(async () => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function setup(over: { serve?: boolean } = {}) {
  mkTask(env.db, "t1");
  const a = insertAgent(env.db, {
    name: "w1",
    workstream: "w",
    paneId: "%w1",
    cli: "pi",
    spawner: CALLER,
  });
  await claimTask(env.db, "t1", { workstream: "w", agentName: "w1" });
  authorizeTasks(env.db, ["t1"], { workstream: "w", cli: "pi", worktree: false, maxRuns: 1 });
  if (over.serve !== false) await serveFake(ctlSocketPath("w", "w1", env.dir), ext, servers);
  return { agentId: a.incarnation, taskId: taskIdFor(env.db, "t1", "w") as number };
}
type S = Awaited<ReturnType<typeof setup>>;

const ctxOf = (s: S, over: Partial<WaitStallContext> = {}): WaitStallContext => ({
  caller: CALLER,
  generation: null,
  ref: taskRef("t1"),
  taskId: s.taskId,
  revision: taskRevision(env.db, "w", "t1"),
  owner: {
    workstream: "w",
    name: "w1",
    agentId: s.agentId,
    paneId: "%w1",
    status: "needs_input",
    source: "ctl",
    since: Date.now() - 600_000,
    settled: false,
    ctl: "ok",
    incarnation: INC,
    runs: 2,
  },
  stallToken: "tok",
  deadlineMs: 5000,
  signal: new AbortController().signal,
  ...over,
});
const keyOf = (s: S, action: ActionKey["action"] = "steer"): ActionKey => ({
  taskId: s.taskId,
  ownerId: s.agentId,
  incarnation: INC,
  action,
});
const steer = (ctx: WaitStallContext) => steerStall(env.db, ctx, { callers: [CALLER] });
const row = (s: S) => getActionReceipt(env.db, keyOf(s));
const taskState = () =>
  env.db.prepare("SELECT status, owner_id FROM tasks WHERE local_id = 't1'").get();
/** Plant a receipt as a crashed earlier process would have left it. */
function plant(s: S, state: "reserved" | "sending" | "unknown", msgId: string | null = "m-old") {
  reserveActionReceipt(env.db, keyOf(s), {
    caller: CALLER,
    taskRef: "w/t1",
    ownerRef: "w/w1",
    paneId: "%w1",
    previewRevision: 0,
    ...(msgId !== null ? { msgId } : {}),
  });
  if (state !== "reserved") transitionActionReceipt(env.db, keyOf(s), "reserved", "sending");
  if (state === "unknown") transitionActionReceipt(env.db, keyOf(s), "sending", "unknown");
}

describe("steer: the happy path", () => {
  it("sends one fixed steer bound to the saved incarnation with the reserved msgId, then continues from the real run baseline", async () => {
    const s = await setup();
    const r = await steer(ctxOf(s));
    expect(r).toMatchObject({
      disposition: "continue",
      action: "steer",
      state: "sent",
      incarnation: INC,
      afterRuns: 2,
    });
    expect(ext.sends).toEqual([
      {
        op: "send",
        text: steerText("w", "t1"),
        mode: "steer",
        msgId: r.msgId,
        expectIncarnation: INC,
      },
    ]);
    expect(row(s)).toMatchObject({
      state: "sent",
      msgId: r.msgId,
      runs: 2,
      caller: CALLER,
      taskRef: "w/t1",
      ownerRef: "w/w1",
      paneId: "%w1",
    });
    // never a release, a close, or a kill
    expect(taskState()).toMatchObject({ status: "IN_PROGRESS" });
    expect(mux.calls.filter((c) => c[0] === "kill-pane")).toEqual([]);
  });

  it("the text is plain, bounded and names no free text", () => {
    const t = steerText("w", "t1");
    expect(t.length).toBeLessThan(400);
    expect([...t].every((c) => c >= " ")).toBe(true); // one line, no control characters
  });

  it("is logged as an agent.send steer op attributed to the caller", async () => {
    const s = await setup();
    await steer(ctxOf(s));
    const op = env.db.prepare("SELECT actor, payload FROM ops WHERE intent = 'agent.send'").get() as
      | { actor: string; payload: string }
      | undefined;
    expect(op?.payload).toMatch(/mode=steer/);
    expect(op?.actor).toBe(CALLER);
  });
});

describe("steer: one per task, owner and incarnation", () => {
  it("a second steer is budget-exhausted and writes nothing, whoever asks and whatever the stall token or generation", async () => {
    const s = await setup();
    await steer(ctxOf(s));
    for (const over of [
      { stallToken: "tok-2" },
      { generation: null, caller: CALLER },
    ] as Partial<WaitStallContext>[]) {
      expect(await steer(ctxOf(s, over))).toMatchObject({ state: "budget-exhausted" });
    }
    // a new note/revision does not reset it
    addNote(env.db, "t1", "owner says hi", { workstream: "w", author: "w1" });
    expect(await steer(ctxOf(s))).toMatchObject({ state: "budget-exhausted" });
    expect(ext.sends).toHaveLength(1);
  });

  it("two connections racing: exactly one write (a non-deduping extension)", async () => {
    const s = await setup();
    const other = openDb({ path: env.db.name });
    try {
      const ctx = ctxOf(s);
      const rs = await Promise.all([
        steerStall(env.db, ctx, { callers: [CALLER] }),
        steerStall(other, ctx, { callers: [CALLER] }),
      ]);
      expect(ext.sends).toHaveLength(1);
      expect(rs.filter((r) => r.state === "sent")).toHaveLength(1);
      expect(row(s)?.state).toMatch(/sent|unknown/);
      // and nothing resends afterwards
      await steer(ctxOf(s));
      expect(ext.sends).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  it("a new ctl incarnation is a fresh budget", async () => {
    const s = await setup();
    await steer(ctxOf(s));
    ext.incarnation = "inc-2";
    const r = await steer(ctxOf(s, { owner: { ...ctxOf(s).owner, incarnation: "inc-2" } }));
    expect(r.state).toBe("sent");
    expect(ext.sends).toHaveLength(2);
  });
});

describe("steer: crash at each state", () => {
  it("crash after RESERVE (before the write): a resumer reuses the saved msgId and writes once", async () => {
    const s = await setup();
    plant(s, "reserved", "m-saved");
    const r = await steer(ctxOf(s));
    expect(r).toMatchObject({ state: "sent", msgId: "m-saved" });
    expect(ext.sends).toEqual([expect.objectContaining({ msgId: "m-saved" })]);
    expect(row(s)?.state).toBe("sent");
  });

  it("crash with SENDING, the pi did accept it: probed, confirmed, NEVER resent", async () => {
    const s = await setup();
    plant(s, "sending", "m-old");
    ext.accepted.set("m-old", 7);
    const r = await steer(ctxOf(s));
    expect(r).toMatchObject({
      state: "sent",
      msgId: "m-old",
      afterRuns: 7,
      disposition: "continue",
    });
    expect(ext.sends).toHaveLength(0);
    expect(row(s)).toMatchObject({ state: "sent", runs: 7 });
  });

  it("crash with SENDING, no receipt (evicted/never arrived): UNKNOWN, not unsent, never resent", async () => {
    const s = await setup();
    plant(s, "sending");
    for (let i = 0; i < 3; i++) {
      expect(await steer(ctxOf(s))).toMatchObject({ state: "unknown", disposition: "return" });
    }
    expect(ext.sends).toHaveLength(0);
    expect(row(s)?.state).toBe("unknown");
    expect(taskState()).toMatchObject({ status: "IN_PROGRESS" }); // no release as a fallback
  });

  it("UNKNOWN stays unknown across restarts until a probe confirms: then sent, still no resend", async () => {
    const s = await setup();
    plant(s, "unknown");
    expect((await steer(ctxOf(s))).state).toBe("unknown");
    ext.accepted.set("m-old", 4);
    expect((await steer(ctxOf(s))).state).toBe("sent");
    expect(ext.sends).toHaveLength(0);
    expect((await steer(ctxOf(s))).state).toBe("budget-exhausted");
  });

  it("a forgetful extension (no msg memory) leaves it UNKNOWN", async () => {
    const s = await setup();
    plant(s, "sending");
    ext.forgetful = true;
    ext.accepted.set("m-old", 1);
    expect((await steer(ctxOf(s))).state).toBe("unknown");
    expect(ext.sends).toHaveLength(0);
  });

  it("the receipt of ANOTHER pi incarnation does not confirm", async () => {
    const s = await setup();
    plant(s, "sending");
    ext.incarnation = "inc-other";
    ext.accepted.set("m-old", 1);
    expect((await steer(ctxOf(s))).state).toBe("unknown");
    expect(ext.sends).toHaveLength(0);
  });

  it("an unreachable socket leaves it UNKNOWN", async () => {
    const s = await setup({ serve: false });
    plant(s, "sending");
    expect((await steer(ctxOf(s))).state).toBe("unknown");
  });

  it("a replaced owner (same name, new registry row) is never probed or resent", async () => {
    const s = await setup();
    plant(s, "sending");
    ext.accepted.set("m-old", 1);
    env.db.exec("UPDATE agents SET pane_id = '%other' WHERE name = 'w1'");
    expect((await steer(ctxOf(s))).state).toBe("unknown");
    expect(ext.sends).toHaveLength(0);
  });

  it("SENDING with a lost msgId can only be unknown", async () => {
    const s = await setup();
    plant(s, "sending", null);
    expect(await steer(ctxOf(s))).toMatchObject({ state: "unknown" });
    expect(ext.sends).toHaveLength(0);
  });

  it("crash after the pi accepted but before 'sent' was stored: the next waiter probes, never resends", async () => {
    const s = await setup();
    env.db.exec(
      `CREATE TRIGGER no_sent BEFORE UPDATE ON wait_action_receipts WHEN NEW.state = 'sent'
         BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    const r = await steer(ctxOf(s));
    expect(r.state).toBe("sent"); // the fact stands even though it could not be stored
    expect(row(s)?.state).toBe("sending"); // the exclusion survived
    env.db.exec("DROP TRIGGER no_sent");
    expect((await steer(ctxOf(s))).state).toBe("sent"); // probe confirmed it
    expect(ext.sends).toHaveLength(1);
  });

  it("an unterminated reply (written, then silence) is confirmed by the receipt: sent", async () => {
    const s = await setup();
    ext.sendBehaviour = "swallow";
    const r = await steer(ctxOf(s));
    expect(r.state).toBe("sent");
    expect(row(s)?.detail).toBe("confirmed-after-timeout");
    expect(ext.sends).toHaveLength(1);
  });

  it("a send nobody confirms is UNKNOWN, and the next waiter does not resend", async () => {
    const s = await setup();
    ext.sendBehaviour = "silent";
    const ac = new AbortController();
    const p = steer(ctxOf(s, { signal: ac.signal }));
    for (let i = 0; i < 100 && ext.sends.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await p).toMatchObject({ state: "unknown", disposition: "return" });
    expect(row(s)?.state).toBe("unknown");
    ext.sendBehaviour = "ok";
    expect((await steer(ctxOf(s))).state).toBe("unknown");
    expect(ext.sends).toHaveLength(1);
  });
});

describe("steer: refusals before the write change no budget", () => {
  it("pi answering ok:false is a definite refusal: recorded, not retried", async () => {
    const s = await setup();
    ext.sendBehaviour = "refuse";
    expect(await steer(ctxOf(s))).toMatchObject({ state: "refused", disposition: "return" });
    expect(row(s)?.state).toBe("refused");
    ext.sendBehaviour = "ok";
    expect((await steer(ctxOf(s))).state).toBe("refused");
    expect(ext.sends).toHaveLength(1);
  });

  it("the pi at the socket is another incarnation: nothing written, the budget stays", async () => {
    const s = await setup();
    ext.incarnation = "inc-other";
    expect((await steer(ctxOf(s))).state).toBe("refused");
    expect(ext.sends).toHaveLength(0);
    expect(row(s)?.state).toBe("reserved");
    ext.incarnation = INC;
    expect((await steer(ctxOf(s))).state).toBe("sent");
    expect(ext.sends).toHaveLength(1);
  });

  const noEffect = async (_s: S, ctx: WaitStallContext, re: RegExp) => {
    const r = await steer(ctx);
    expect(r).toMatchObject({ state: "refused", disposition: "return" });
    expect(r.reason).toMatch(re);
    expect(ext.sends).toHaveLength(0);
    expect(env.db.inTransaction).toBe(false);
    return r;
  };

  it("the stall's own preconditions: not idle, ctl not healthy, no incarnation, no unreadable runtime", async () => {
    const s = await setup();
    const base = ctxOf(s);
    for (const owner of [
      { ...base.owner, status: "needs_permission" as const },
      { ...base.owner, status: "busy" as const },
      { ...base.owner, status: null },
      { ...base.owner, ctl: "refused" as const },
      { ...base.owner, incarnation: undefined },
    ]) {
      await noEffect(s, { ...base, owner }, /owner|incarnation/i);
    }
    expect(row(s)).toBeUndefined(); // refused before reserving: no row
  });

  it("a non-auto task, a foreign spawner, a stranger caller, an aborted wait", async () => {
    const s = await setup();
    await noEffect(s, ctxOf(s, { caller: "pi:stranger" }), /caller/);
    const ac = new AbortController();
    ac.abort();
    await noEffect(s, ctxOf(s, { signal: ac.signal }), /abort/);
    env.db.exec("UPDATE agents SET spawner = 'pi:other' WHERE name = 'w1'");
    await noEffect(s, ctxOf(s), /spawned/);
    env.db.exec("UPDATE agents SET spawner = 'pi:s' WHERE name = 'w1'");
    env.db.exec("UPDATE task_auto SET enabled = 0");
    await noEffect(s, ctxOf(s), /auto/);
  });

  it("an open human stop of any caller", async () => {
    const s = await setup();
    recordHumanNeeded(env.db, { workstream: "w", caller: "w/boss", reason: "x" });
    const r = await steerStall(env.db, ctxOf(s), { callers: [CALLER, "w/boss"] });
    expect(r.state).toBe("refused");
    expect(ext.sends).toHaveLength(0);
  });
});

describe("steer: the final fence after the handshake", () => {
  // Each mutation runs inside the hello (after the plan, before the write).
  const cases: [string, (s: S) => void, RegExp][] = [
    ["permission revoked", () => env.db.exec("UPDATE task_auto SET enabled = 0"), /auto/],
    [
      "task re-owned / released",
      () => releaseTask(env.db, "t1", { workstream: "w", author: "x" }),
      /IN_PROGRESS|owner/,
    ],
    [
      "task closed",
      () => closeTask(env.db, "t1", { workstream: "w", evidence: "x", author: "x" }),
      /CLOSED/,
    ],
    [
      "owner pane replaced",
      () => env.db.exec("UPDATE agents SET pane_id = '%new' WHERE name = 'w1'"),
      /pane/,
    ],
    [
      "owner row gone",
      () => {
        env.db.exec("PRAGMA foreign_keys = OFF");
        env.db.exec("DELETE FROM agents WHERE name = 'w1'");
      },
      /registered|owner/,
    ],
    [
      "revision moved (a note)",
      () => addNote(env.db, "t1", "changed", { workstream: "w", author: "w1" }),
      /revision/,
    ],
    [
      "a human stop appeared",
      () => recordHumanNeeded(env.db, { workstream: "w", caller: CALLER, reason: "stop" }),
      /human/,
    ],
    [
      "the wait was superseded (generation)",
      () => env.db.exec("UPDATE wait_registrations SET generation = generation + 1"),
      /superseded/,
    ],
  ];
  for (const [name, mutate, re] of cases) {
    it(`${name} after the hello: nothing is written, the row stays reserved`, async () => {
      const s = await setup();
      registerOwnedWait(env.db, CALLER, [{ kind: "task", workstream: "w", id: "t1" }]);
      const gen = (
        env.db.prepare("SELECT generation FROM wait_registrations").get() as { generation: number }
      ).generation;
      ext.onHello = () => {
        ext.onHello = undefined;
        mutate(s);
      };
      const r = await steer(ctxOf(s, { generation: gen }));
      expect(r).toMatchObject({ state: "refused", disposition: "return" });
      expect(r.reason).toMatch(re);
      expect(ext.sends).toHaveLength(0);
      expect(row(s)?.state).toBe("reserved");
      expect(env.db.inTransaction).toBe(false);
    });
  }

  it("the fence runs inside an immediate transaction with no await between it and the write", async () => {
    const s = await setup();
    // A competing connection holds the write lock: the fence's BEGIN IMMEDIATE cannot pass,
    // so it vetoes (nothing written) instead of racing.
    const other = openDb({ path: env.db.name });
    try {
      ext.onHello = () => {
        ext.onHello = undefined;
        other.exec("BEGIN IMMEDIATE");
      };
      env.db.pragma("busy_timeout = 1");
      const r = await steer(ctxOf(s));
      expect(r.state).toMatch(/refused/);
      expect(ext.sends).toHaveLength(0);
    } finally {
      try {
        other.exec("ROLLBACK");
      } catch {}
      other.close();
    }
    expect(row(s)?.state).toBe("reserved");
  });
});

describe("steer: abort and deadline", () => {
  it("an abort during the hello writes nothing and spends no budget", async () => {
    const s = await setup();
    ext.helloDelayMs = 300;
    const ac = new AbortController();
    const p = steer(ctxOf(s, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    expect((await p).state).toBe("refused");
    expect(Date.now() - t0).toBeLessThan(200); // the abort cut the hello short
    expect(ext.sends).toHaveLength(0);
    expect(row(s)?.state).toBe("reserved");
  });

  it("the deadline bounds the hello: a slow socket writes nothing", async () => {
    const s = await setup();
    ext.helloDelayMs = 400;
    const r = await steer(ctxOf(s, { deadlineMs: 40 }));
    expect(r.state).toBe("refused");
    expect(ext.sends).toHaveLength(0);
    expect(row(s)?.state).toBe("reserved");
  });
});

describe("steer: no lock across an await", () => {
  it("holds no transaction while the socket is awaited (another connection writes freely)", async () => {
    const s = await setup();
    const other = openDb({ path: env.db.name });
    let wrote = false;
    try {
      ext.onHello = () => {
        ext.onHello = undefined;
        other.exec("UPDATE workstreams SET name = name"); // would block on a held write lock
        wrote = true;
      };
      await steer(ctxOf(s));
      expect(wrote).toBe(true);
      expect(env.db.inTransaction).toBe(false);
    } finally {
      other.close();
    }
  });
});

describe("steer through the engine", () => {
  const stalledTable = (since = Date.now() - 600_000): Map<string, AgentReading> =>
    new Map([
      [
        "w/w1",
        {
          status: "needs_input",
          source: "ctl",
          ctl: "ok",
          since,
          incarnation: INC,
          runs: 2,
        },
      ],
    ]);
  const base = { pollMs: 1, sync: false, timeoutMs: 300, stuckAfterMs: 1000 } as const;

  it("a sent nudge continues the SAME wait (no stall return) and sends once", async () => {
    await setup();
    registerOwnedWait(env.db, CALLER, [{ kind: "task", workstream: "w", id: "t1" }]);
    const r = await waitWithActions(env.db, [taskRef("t1")], {
      ...base,
      callers: [CALLER],
      onStall: "steer",
      ...scriptedAgents(stalledTable()),
    });
    expect(r.timedOut).toBe(true);
    expect(r.event.kind).not.toBe("stall");
    expect(ext.sends).toHaveLength(1);
  });

  it("the default onStall exit never steers", async () => {
    await setup();
    const spy = vi.fn(steerStallHandler(env.db, { callers: [CALLER] }));
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      callers: [CALLER],
      handleStall: spy,
      ...scriptedAgents(stalledTable()),
    });
    expect(r.event.kind).toBe("stall");
    expect(spy).not.toHaveBeenCalled();
    expect(ext.sends).toHaveLength(0);
  });

  it("an exhausted budget returns an honest actionable stall, across a restart (new wait, new stall token)", async () => {
    await setup();
    const first = await waitWithActions(env.db, [taskRef("t1")], {
      ...base,
      callers: [CALLER],
      onStall: "steer",
      ...scriptedAgents(stalledTable()),
    });
    expect(first.timedOut).toBe(true);
    const second = await waitWithActions(env.db, [taskRef("t1")], {
      ...base,
      callers: [CALLER],
      onStall: "steer",
      ...scriptedAgents(stalledTable(Date.now() - 700_000)),
    });
    expect(second.event.kind).toBe("stall");
    expect(second.exit).toBe(7);
    expect(second.action).toMatchObject({ action: "steer", state: "budget-exhausted" });
    expect(ext.sends).toHaveLength(1);
  });

  it("a refused steer (non-auto) still returns the stall", async () => {
    const s = await setup();
    env.db.exec("UPDATE task_auto SET enabled = 0");
    const r = await waitWithActions(env.db, [taskRef("t1")], {
      ...base,
      callers: [CALLER],
      onStall: "steer",
      ...scriptedAgents(stalledTable()),
    });
    expect(r.event.kind).toBe("stall");
    expect(r.action).toMatchObject({ action: "steer", state: "refused" });
    expect(row(s)).toBeUndefined();
  });

  it("an urgent owned delegate result is not starved by a slow steer in flight", async () => {
    await setup();
    ext.helloDelayMs = 1500;
    const call = mkDelegate(env.db, CALLER);
    setTimeout(() => answer(env.db, call), 30);
    const t0 = Date.now();
    const r = await waitWithActions(env.db, [taskRef("t1")], {
      ...base,
      timeoutMs: 3000,
      callers: [CALLER],
      onStall: "steer",
      ...scriptedAgents(stalledTable()),
    });
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(r.event.kind).toBe("delegate");
    expect(ext.sends).toHaveLength(0);
  });
});
