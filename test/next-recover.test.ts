// `executeNext` slice B (v_exec_recover): dead versus live-error recovery, bounded
// `--hold`, signals, one honest result. Real SQLite in a temp dir; the pane spawn,
// the ctl send and the worker reader are the only fakes (journal, claim, reaper
// and the retry reservation are real).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  spawns: [] as string[],
  sends: [] as { agent: string; text: string; msgId?: string; expect?: string }[],
  panes: 0,
  sendMode: "ok" as "ok" | "throws" | "unsent",
  sendRuns: 0,
  afterSpawn: undefined as undefined | (() => void),
}));
vi.mock("../src/agents/spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/spawn.js")>();
  return {
    ...actual,
    spawnAgent: async (
      db: import("../src/db.js").Db,
      opts: { name: string; workstream: string; onIdentity?: (a: unknown) => void },
    ) => {
      const { insertAgent } = await import("../src/agents.js");
      hook.spawns.push(opts.name);
      const row = insertAgent(db, {
        name: opts.name,
        workstream: opts.workstream,
        paneId: `%${++hook.panes}`,
      });
      opts.onIdentity?.(row);
      hook.afterSpawn?.();
      return { ...row, ctl: "ok", ctlSocket: "/fake.sock", ctlIncarnation: "pi-inc" };
    },
  };
});
vi.mock("../src/agents/transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/transport.js")>();
  return {
    ...actual,
    sendViaTransport: async (
      a: { name: string },
      text: string,
      o: { msgId?: string; expectIncarnation?: string },
    ) => {
      hook.sends.push({
        agent: a.name,
        text,
        ...(o.msgId !== undefined ? { msgId: o.msgId } : {}),
        ...(o.expectIncarnation !== undefined ? { expect: o.expectIncarnation } : {}),
      });
      if (hook.sendMode === "throws") throw new Error("socket vanished mid-write");
      if (hook.sendMode === "unsent") {
        const { AgentCtlUnreachableError } = await import("../src/agents/errors.js");
        throw new AgentCtlUnreachableError(a.name, "d", "/fake.sock", "missing", null);
      }
      return { transport: "ctl", runs: hook.sendRuns, msgId: o.msgId, incarnation: "pi-inc" };
    },
    checkMessage: async (_s: string, msgId: string) => ({
      state: "unreachable",
      id: msgId,
      reason: "no socket",
    }),
  };
});

import { getReceipt, updateReceipt } from "../src/agents/receipts.js";
import { deleteAgent, getAgent, insertAgent } from "../src/agents.js";
import { readAttempt, reserveAttempt, reserveRetry } from "../src/auto-attempt.js";
import { type Db, openDb } from "../src/db.js";
import { openHumanNeeds, recordHumanNeeded } from "../src/human-needed.js";
import { executeNext, type NextResult } from "../src/next.js";
import { liveWorkers, type ObserveWorkers, type WorkerFacts } from "../src/next-recover.js";
import { authorizeTasks } from "../src/task-auto.js";
import { taskIdFor } from "../src/tasks/core.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { getTask } from "../src/tasks.js";
import type { WaitOptions, WaitRef, WaitResult } from "../src/wait-types.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";

let dir: string;
let db: Db;
let mux: MuxHarness;
let muxCalls: number;
/** What every worker reads as, by agent name; absent = busy. */
let facts: Record<string, WorkerFacts | undefined>;
let observed: string[][];

beforeEach(() => {
  hook.spawns = [];
  hook.sends = [];
  hook.panes = 0;
  hook.sendMode = "ok";
  hook.sendRuns = 0;
  hook.afterSpawn = undefined;
  muxCalls = 0;
  facts = {};
  observed = [];
  dir = mkdtempSync(join(tmpdir(), "mu-next-rec-"));
  db = openDb({ path: join(dir, "mu.db") });
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

const observe: ObserveWorkers = async (agents) => {
  observed.push(agents.map((a) => a.name));
  return new Map(
    agents.map((a) => [
      `${a.workstreamName}/${a.name}`,
      facts[a.name] ?? { status: "busy" as const, ctl: "ok" as const },
    ]),
  );
};
const noIngest = async () => {};
const run = (o: Partial<Parameters<typeof executeNext>[1]> = {}) =>
  executeNext(db, { workstream: "d", caller: "orch", ingest: noIngest, observe, ...o });
const tid = (id: string) => {
  const n = taskIdFor(db, id, "d");
  if (n === null) throw new Error(`no task ${id}`);
  return n;
};
function task(id: string, max = 3): void {
  addTask(db, { workstream: "d", localId: id, title: id });
  addNote(db, id, `BRIEF for ${id}`, { workstream: "d", kind: "brief", author: "orch" });
  authorizeTasks(db, [id], { workstream: "d", cli: "pi", worktree: false, maxRuns: max });
}
const runsOf = (id: string) =>
  (db.prepare("SELECT runs FROM task_auto WHERE task_id = ?").get(tid(id)) as { runs: number })
    .runs;
const receiptOf = (id: string, key: string) => getReceipt(db, tid(id), key);
const kinds = (r: NextResult) => r.moves.map((m) => `${m.kind}:${m.task}`);
const ERRORED: WorkerFacts = {
  status: "needs_input",
  ctl: "ok",
  incarnation: "pi-inc",
  runs: 1,
  lastError: "529 overloaded",
};
/** A dispatched worker `a` (agent a-1, run 1 delivered, send reported 0 runs before it). */
async function dispatched(id = "a", max = 3): Promise<void> {
  task(id, max);
  await run();
  expect(hook.spawns).toEqual([`${id}-1`]);
}

describe("dead worker: reaped through the id + pane CAS, then retried as a new attempt", () => {
  it("reaps the dead local worker, reopens the task and retries it: one charge, 'previous attempt died'", async () => {
    await dispatched();
    facts["a-1"] = { status: null };
    const r = await run();
    expect(kinds(r)).toEqual(["reap:a", "spawn:a"]);
    expect(r.moves[0]).toMatchObject({ agent: "a-1", reason: "its pane is gone" });
    expect(r.moves[1]).toMatchObject({ attempt: 2, key: "auto:2", state: "sent" });
    expect(hook.spawns).toEqual(["a-1", "a-2"]);
    expect(hook.sends[1]?.text).toContain("previous attempt died");
    expect(hook.sends[1]?.text.startsWith("BRIEF for a")).toBe(true);
    expect(runsOf("a")).toBe(2);
    expect(getAgent(db, "a-1", "d")).toBeUndefined();
    expect(getTask(db, "a", "d")?.ownerId).toBe(getAgent(db, "a-2", "d")?.incarnation);
    expect(r.used).toBe(2);
  });

  it("a worker already reaped by reconcile (task open with the reaper note) is retried the same way", async () => {
    await dispatched();
    deleteAgent(db, "a-1", "d");
    expect(getTask(db, "a", "d")?.status).toBe("OPEN");
    const r = await run();
    expect(kinds(r)).toEqual(["spawn:a"]);
    expect(hook.sends[1]?.text).toContain("previous attempt died");
    expect(runsOf("a")).toBe(2);
  });

  it("a task a HUMAN reopened (no reaper note) is not re-dispatched: that is a decision", async () => {
    await dispatched();
    db.prepare(
      "UPDATE tasks SET status = 'OPEN', substate = 'todo', owner_id = NULL WHERE local_id = 'a'",
    ).run();
    const r = await run();
    expect(kinds(r)).toEqual(["skip:a"]);
    expect(hook.spawns).toEqual(["a-1"]);
    expect(runsOf("a")).toBe(1);
  });

  it("at the run ceiling the dead worker is reaped, then ATTENTION says why nothing was retried", async () => {
    await dispatched("a", 1);
    facts["a-1"] = { status: null };
    const r = await run();
    expect(kinds(r)).toEqual(["reap:a", "attention:a"]);
    expect(r.moves[1]?.reason).toMatch(/used its 1 run/);
    expect(runsOf("a")).toBe(1);
    expect(hook.spawns).toEqual(["a-1"]);
    // Said once per invocation, and again (it is still true) on the next: never an action.
    const again = await run();
    expect(kinds(again)).toEqual(["attention:a"]);
    expect(runsOf("a")).toBe(1);
  });

  it("the reap is a compare-and-swap: a worker replaced between the read and the reap is kept", async () => {
    await dispatched();
    facts["a-1"] = { status: null };
    const replacing: ObserveWorkers = async (agents) => {
      const m = await observe(agents, { ms: 1 });
      deleteAgent(db, "a-1", "d"); // the name is taken again by another pane
      insertAgent(db, { name: "a-1", workstream: "d", paneId: "%999" });
      return m;
    };
    const r = await run({ observe: replacing });
    expect(r.moves[0]).toMatchObject({ kind: "skip", task: "a" });
    expect(r.moves[0]?.reason).toMatch(/replaced|gone/);
    expect(getAgent(db, "a-1", "d")?.paneId).toBe("%999");
  });

  it("a worker that became remote between the scan and the effect is not reaped", async () => {
    await dispatched();
    facts["a-1"] = { status: null };
    const moving: ObserveWorkers = async (agents, o) => {
      const m = await observe(agents, o);
      db.prepare("UPDATE agents SET host = 'box' WHERE name = 'a-1'").run();
      return m;
    };
    const r = await run({ observe: moving });
    expect(r.moves[0]).toMatchObject({ kind: "skip", task: "a" });
    expect(r.moves[0]?.reason).toMatch(/remote/);
    expect(getAgent(db, "a-1", "d")).toBeDefined();
  });

  it("a remote worker with no pane is NEVER reaped: its tree is kept and the move is attention", async () => {
    await dispatched();
    db.prepare("UPDATE agents SET host = 'box' WHERE name = 'a-1'").run();
    facts["a-1"] = { status: null };
    const r = await run();
    expect(kinds(r)).toEqual(["attention:a"]);
    expect(r.moves[0]?.reason).toMatch(/remote worker a-1 on box/);
    expect(getAgent(db, "a-1", "d")).toBeDefined();
    expect(getTask(db, "a", "d")).toMatchObject({ status: "IN_PROGRESS" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM remote_recovery").get()).toEqual({ n: 0 });
  });
});

describe("live API-errored worker: retried in place, never reaped or duplicated", () => {
  it("sends the brief again to the SAME pane under a reserved msgId bound to pi's incarnation; one charge", async () => {
    await dispatched();
    hook.sendRuns = 1; // pi reports the run count before the send: the errored run
    facts["a-1"] = ERRORED;
    const r = await run();
    expect(kinds(r)).toEqual(["retry:a"]);
    expect(r.moves[0]).toMatchObject({ attempt: 2, key: "auto:2", agent: "a-1", state: "sent" });
    expect(r.moves[0]?.reason).toMatch(/API error: 529/);
    expect(hook.spawns).toEqual(["a-1"]); // no second pane
    expect(hook.sends).toHaveLength(2);
    expect(hook.sends[1]).toMatchObject({ agent: "a-1", expect: "pi-inc" });
    expect(hook.sends[1]?.msgId).toBe(getReceipt(db, tid("a"), "auto:2")?.msgId);
    expect(hook.sends[1]?.text).toContain("API error");
    expect(hook.sends[1]?.text.startsWith("BRIEF for a")).toBe(true);
    expect(hook.sends[1]?.text).not.toContain("previous attempt died");
    expect(runsOf("a")).toBe(2);
    expect(getAgent(db, "a-1", "d")).toBeDefined();
    expect(getTask(db, "a", "d")).toMatchObject({ status: "IN_PROGRESS" });
    expect(r.used).toBe(1);
  });

  it("the same error is answered once: the next invocation neither sends nor charges", async () => {
    await dispatched();
    hook.sendRuns = 1;
    facts["a-1"] = ERRORED;
    await run();
    const again = await run();
    expect(again.moves).toEqual([]);
    expect(hook.sends).toHaveLength(2);
    expect(runsOf("a")).toBe(2);
    // A NEW error (the retry's own run errored too) is a new, charged retry.
    facts["a-1"] = { ...ERRORED, runs: 2 };
    hook.sendRuns = 2;
    const third = await run();
    expect(kinds(third)).toEqual(["retry:a"]);
    expect(third.moves[0]).toMatchObject({ key: "auto:3" });
    expect(runsOf("a")).toBe(3);
  });

  it("a second reader of the same error is refused by the reservation itself: one charge, no send", async () => {
    await dispatched("a", 3);
    hook.sendRuns = 1;
    facts["a-1"] = ERRORED;
    await run(); // answers the error at run 1: auto:2 sent with runs 1
    const agent = getAgent(db, "a-1", "d");
    if (agent === undefined) throw new Error("no agent");
    const target = {
      agent: { incarnation: agent.incarnation, paneId: agent.paneId, name: "a-1" },
      pi: "pi-inc",
      errorRuns: 1,
    };
    expect(reserveRetry(db, "d", "a", target)).toMatchObject({
      ok: false,
      code: "changed",
      reason: expect.stringMatching(/already answered/),
    });
    expect(runsOf("a")).toBe(2);
    expect(receiptOf("a", "auto:3")).toBeUndefined();
  });

  it("the reservation itself refuses at the run ceiling, whatever the scan said", async () => {
    await dispatched("a", 1);
    const agent = getAgent(db, "a-1", "d");
    if (agent === undefined) throw new Error("no agent");
    const out = reserveRetry(db, "d", "a", {
      agent: { incarnation: agent.incarnation, paneId: agent.paneId, name: "a-1" },
      pi: "pi-inc",
      errorRuns: 1,
    });
    expect(out).toMatchObject({ ok: false, code: "ceiling" });
    expect(runsOf("a")).toBe(1);
  });

  it("the reservation refuses a worker that is not the one the attempt delivered to", async () => {
    await dispatched();
    const agent = getAgent(db, "a-1", "d");
    if (agent === undefined) throw new Error("no agent");
    const out = reserveRetry(db, "d", "a", {
      agent: { incarnation: agent.incarnation, paneId: "%other", name: "a-1" },
      pi: "pi-inc",
      errorRuns: 1,
    });
    expect(out).toMatchObject({ ok: false, code: "changed" });
    expect(runsOf("a")).toBe(1);
  });

  it("at the run ceiling an errored worker is left alone: attention, no send, no charge", async () => {
    await dispatched("a", 1);
    facts["a-1"] = ERRORED;
    const r = await run();
    expect(kinds(r)).toEqual(["attention:a"]);
    expect(r.moves[0]?.reason).toMatch(/used its 1 run/);
    expect(hook.sends).toHaveLength(1);
    expect(getAgent(db, "a-1", "d")).toBeDefined();
  });

  it("an unsent retry fails the receipt and keeps the worker, its claim and the charge; never deletes it", async () => {
    await dispatched();
    hook.sendRuns = 1;
    hook.sendMode = "unsent";
    facts["a-1"] = ERRORED;
    const r = await run();
    expect(r.moves[0]).toMatchObject({ kind: "failed", key: "auto:2" });
    expect(r.stopped).toBe("failed");
    expect(getReceipt(db, tid("a"), "auto:2")?.state).toBe("failed");
    expect(runsOf("a")).toBe(2);
    expect(getAgent(db, "a-1", "d")).toBeDefined();
    expect(getTask(db, "a", "d")).toMatchObject({
      status: "IN_PROGRESS",
      ownerId: getAgent(db, "a-1", "d")?.incarnation,
    });
    // The failed key is never reset: the next try is a NEW attempt and a new charge, until the ceiling.
    hook.sendMode = "ok";
    const next = await run();
    expect(next.moves[0]).toMatchObject({ kind: "retry", key: "auto:3", state: "sent" });
    expect(runsOf("a")).toBe(3);
    const last = await run();
    expect(last.moves.filter((m) => m.kind === "retry")).toEqual([]);
    expect(runsOf("a")).toBe(3);
  });

  it("a send that may have landed (unknown) keeps pane and claim and is never resent", async () => {
    await dispatched();
    hook.sendRuns = 1;
    hook.sendMode = "throws";
    facts["a-1"] = ERRORED;
    const r = await run();
    expect(r.moves[0]).toMatchObject({ kind: "retry", state: "unknown" });
    expect(getReceipt(db, tid("a"), "auto:2")?.state).toBe("unknown");
    expect(getAgent(db, "a-1", "d")).toBeDefined();
    hook.sendMode = "ok";
    const again = await run();
    expect(hook.sends).toHaveLength(2); // the probe could not confirm: parked, not resent
    expect(again.moves[0]).toMatchObject({ kind: "needs_human", task: "a" });
    expect(openHumanNeeds(db, "orch")).toHaveLength(1);
    expect(runsOf("a")).toBe(2);
  });

  it.each([
    ["busy", { ...ERRORED, status: "busy" as const }],
    ["a dialog", { ...ERRORED, blocked: { kind: "confirm" as const, since: 1 } }],
    ["pending messages", { ...ERRORED, pending: true }],
    ["an unreadable socket", { status: "unknown" as const, ctl: "missing" as const }],
    ["no error read", { ...ERRORED, lastError: undefined }],
  ])("%s: nothing is done to the worker", async (_name, f) => {
    await dispatched();
    hook.sendRuns = 1;
    facts["a-1"] = f as WorkerFacts;
    const r = await run();
    expect(r.moves).toEqual([]);
    expect(hook.sends).toHaveLength(1);
    expect(getAgent(db, "a-1", "d")).toBeDefined();
    expect(runsOf("a")).toBe(1);
  });

  it("permission revoked between the scan and the effect: nothing sent, nothing charged", async () => {
    await dispatched();
    hook.sendRuns = 1;
    facts["a-1"] = ERRORED;
    const revoking: ObserveWorkers = async (agents, o) => {
      const m = await observe(agents, o);
      authorizeTasks(db, ["a"], {
        workstream: "d",
        cli: "pi",
        worktree: false,
        maxRuns: 3,
        off: true,
      });
      return m;
    };
    const r = await run({ observe: revoking });
    expect(r.moves).toEqual([expect.objectContaining({ kind: "skip", task: "a" })]);
    expect(hook.sends).toHaveLength(1);
    expect(runsOf("a")).toBe(1);
  });

  it("this caller's human need stops the recovery before its effect", async () => {
    await dispatched();
    hook.sendRuns = 1;
    facts["a-1"] = ERRORED;
    recordHumanNeeded(db, { workstream: "d", caller: "orch", reason: "decide" });
    const r = await run();
    expect(r.stopped).toBe("human");
    expect(r.moves).toEqual([]);
    expect(hook.sends).toHaveLength(1);
    expect(runsOf("a")).toBe(1);
  });
});

describe("dry, cap and signal", () => {
  it("--dry reads no pane or socket and writes nothing", async () => {
    await dispatched();
    facts["a-1"] = { status: null };
    const before = db.prepare("SELECT COUNT(*) AS n FROM ops").get();
    const calls = muxCalls;
    const r = await run({ dry: true });
    expect(observed).toEqual([]);
    expect(muxCalls).toBe(calls);
    expect(r.inFlight).toEqual(["a"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops").get()).toEqual(before);
    expect(getAgent(db, "a-1", "d")).toBeDefined();
    expect(runsOf("a")).toBe(1);
  });

  it("the cap counts recovery effects: a reap and its retry stop at cap 1 with work left", async () => {
    await dispatched();
    facts["a-1"] = { status: null };
    const r = await run({ cap: 1 });
    expect(kinds(r)).toEqual(["reap:a"]);
    expect(r.stopped).toBe("cap");
    expect(runsOf("a")).toBe(1);
    const next = await run({ cap: 1 });
    expect(kinds(next)).toEqual(["spawn:a"]);
  });

  it("a signal before the first effect does nothing and says interrupted", async () => {
    task("a");
    const ac = new AbortController();
    ac.abort();
    const r = await run({ signal: ac.signal });
    expect(r).toMatchObject({ stopped: "interrupted", moves: [], used: 0 });
    expect(hook.spawns).toEqual([]);
    expect(runsOf("a")).toBe(0);
  });

  it("a signal during an effect lets it finish (it is journaled) and stops before the next", async () => {
    task("a");
    task("b");
    const ac = new AbortController();
    hook.afterSpawn = () => ac.abort();
    const r = await run({ signal: ac.signal });
    expect(kinds(r)).toEqual(["spawn:a"]);
    expect(r.moves[0]).toMatchObject({ state: "sent" });
    expect(r.stopped).toBe("interrupted");
    expect(runsOf("b")).toBe(0);
  });
});

describe("--hold: bounded wait over the in-flight workers", () => {
  const ev = (
    kind: WaitResult["event"]["kind"],
    id: string | null,
    extra: Partial<WaitResult> = {},
  ): WaitResult => ({
    event: { kind, ref: id === null ? null : { kind: "agent", workstream: "d", id } },
    refs: [],
    timedOut: kind === "heartbeat",
    interrupted: kind === "interrupted",
    exit:
      kind === "dead"
        ? 6
        : kind === "stall" || kind === "input"
          ? 7
          : kind === "interrupted"
            ? 130
            : 0,
    cursor: {},
    humanNeeds: [],
    ...extra,
  });
  const waiting =
    (results: WaitResult[], seen: { refs: WaitRef[][]; opts: WaitOptions[] }) =>
    async (_db: Db, refs: readonly WaitRef[], o: WaitOptions): Promise<WaitResult> => {
      seen.refs.push([...refs]);
      seen.opts.push(o);
      const next = results.shift();
      if (next === undefined) throw new Error("no more waits");
      return next;
    };

  it("waits on the task and its worker (receipt-bound), then returns an event that is the orchestrator's", async () => {
    await dispatched();
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    const r = await run({
      hold: true,
      wait: waiting([ev("closed", "a")], seen),
    });
    expect(seen.refs[0]).toEqual([
      { kind: "task", workstream: "d", id: "a" },
      { kind: "agent", workstream: "d", id: "a-1", afterRuns: 0, incarnation: "pi-inc" },
    ]);
    expect(seen.opts[0]).toMatchObject({ mode: "first", eventScope: "refs", onStall: "exit" });
    expect(r.held).toMatchObject({ waits: 1, event: "closed", exit: 0, timedOut: false });
    expect(observed).toHaveLength(1); // one scan: an event that is not ours starts no second pass
  });

  it("a death during the hold is recovered (reap + retry) and the hold goes on to the next event", async () => {
    await dispatched();
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    let wait = 0;
    const w = async (d: Db, refs: readonly WaitRef[], o: WaitOptions) => {
      wait++;
      if (wait === 1) facts["a-1"] = { status: null };
      return waiting(wait === 1 ? [ev("dead", "a-1", { exit: 6 })] : [ev("closed", "a")], seen)(
        d,
        refs,
        o,
      );
    };
    const r = await run({ hold: true, wait: w });
    expect(kinds(r)).toEqual(["reap:a", "spawn:a"]);
    expect(r.held).toMatchObject({ waits: 2, event: "closed" });
    expect(hook.spawns).toEqual(["a-1", "a-2"]);
    expect(seen.refs[1]?.[1]).toMatchObject({ id: "a-2" });
    expect(runsOf("a")).toBe(2);
  });

  it("an API-errored settle during the hold is retried in place and the hold goes on", async () => {
    await dispatched();
    hook.sendRuns = 1;
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    let wait = 0;
    const w = async (d: Db, refs: readonly WaitRef[], o: WaitOptions) => {
      wait++;
      if (wait === 1) facts["a-1"] = ERRORED;
      return waiting(
        wait === 1
          ? [
              ev("settled", "a-1", {
                refs: [
                  {
                    ref: { kind: "agent", workstream: "d", id: "a-1" },
                    status: "needs_input",
                    lastError: "529",
                    fired: true,
                    dead: false,
                  },
                ],
              }),
            ]
          : [ev("heartbeat", null)],
        seen,
      )(d, refs, o);
    };
    const r = await run({ hold: true, wait: w });
    expect(kinds(r)).toEqual(["retry:a"]);
    expect(r.held).toMatchObject({ waits: 2, event: "heartbeat", timedOut: true });
    expect(hook.spawns).toEqual(["a-1"]);
    expect(seen.refs[1]?.[1]).toMatchObject({ id: "a-1", afterRuns: 1 });
  });

  it("a settle WITHOUT an error is the worker finishing: returned, never retried", async () => {
    await dispatched();
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    const r = await run({
      hold: true,
      wait: waiting(
        [
          ev("settled", "a-1", {
            refs: [
              {
                ref: { kind: "agent", workstream: "d", id: "a-1" },
                status: "needs_input",
                fired: true,
                dead: false,
              },
            ],
          }),
        ],
        seen,
      ),
    });
    expect(r.held).toMatchObject({ waits: 1, event: "settled" });
    expect(r.moves).toEqual([]);
    expect(hook.sends).toHaveLength(1);
  });

  it("a stall or a dialog returns with exit 7; --on-stall reaches the wait", async () => {
    await dispatched();
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    const r = await run({
      hold: true,
      onStall: "steer",
      wait: waiting([ev("stall", "a", { exit: 7 })], seen),
    });
    expect(seen.opts[0]?.onStall).toBe("steer");
    expect(r.held).toMatchObject({ event: "stall", exit: 7 });
  });

  it("a dead event that recovers nothing (remote) ends the hold: no spin", async () => {
    await dispatched();
    db.prepare("UPDATE agents SET host = 'box' WHERE name = 'a-1'").run();
    facts["a-1"] = { status: null };
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    const r = await run({
      hold: true,
      wait: waiting([ev("dead", "a-1", { exit: 6 }), ev("dead", "a-1", { exit: 6 })], seen),
    });
    expect(r.held).toMatchObject({ waits: 1, event: "dead", exit: 6 });
    expect(kinds(r)).toEqual(["attention:a"]);
  });

  it("nothing in flight: the hold returns at once, nothing waited", async () => {
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    const r = await run({ hold: true, wait: waiting([], seen) });
    expect(r.held).toMatchObject({ waits: 0, event: "none" });
    expect(seen.refs).toEqual([]);
  });

  it("the deadline bounds the whole invocation: a spent timeout never starts a wait", async () => {
    await dispatched();
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    const slow: ObserveWorkers = async (agents, o) => {
      await new Promise((x) => setTimeout(x, 15)); // the pass spends the 1 ms deadline
      return observe(agents, o);
    };
    const r = await run({ hold: true, timeoutMs: 1, observe: slow, wait: waiting([], seen) });
    expect(r.held).toMatchObject({ waits: 0, event: "heartbeat", timedOut: true });
    expect(seen.refs).toEqual([]);
    const r2 = await run({
      hold: true,
      timeoutMs: 1_000_000,
      wait: waiting([ev("heartbeat", null)], seen),
    });
    expect(r2.held).toMatchObject({ event: "heartbeat", timedOut: true, exit: 0 });
    expect(seen.opts[0]?.timeoutMs).toBeLessThanOrEqual(1_000_000);
  });

  it("a signal ends the hold with the one interrupted result", async () => {
    await dispatched();
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    const r = await run({ hold: true, wait: waiting([ev("interrupted", null)], seen) });
    expect(r.stopped).toBe("interrupted");
    expect(r.held).toMatchObject({ event: "interrupted", exit: 130 });
  });

  it("this caller's human need opened mid-wait ends it (beforePoll throws, one stop)", async () => {
    await dispatched();
    const w = async (_d: Db, _refs: readonly WaitRef[], o: WaitOptions): Promise<WaitResult> => {
      recordHumanNeeded(db, { workstream: "d", caller: "orch", reason: "decide" });
      await o.beforePoll?.();
      throw new Error("not reached");
    };
    const r = await run({ hold: true, wait: w });
    expect(r.stopped).toBe("human");
    expect(r.human_needed).toHaveLength(1);
  });

  it("--hold never runs under --dry", async () => {
    await dispatched();
    const seen = { refs: [] as WaitRef[][], opts: [] as WaitOptions[] };
    const r = await run({ hold: true, dry: true, wait: waiting([], seen) });
    expect(r.held).toBeUndefined();
    expect(seen.refs).toEqual([]);
  });
});

describe("worker ceiling (--workers): the slot is what is working, not what still has a pane", () => {
  const closeIdle = (id: string) => closeTask(db, id, { workstream: "d", evidence: "done" });

  it("no new pane while the ceiling is reached; nothing reserved or charged; stopped = workers", async () => {
    task("a");
    task("b");
    task("c");
    const r = await run({ workers: 2 });
    expect(kinds(r)).toEqual(["spawn:a", "spawn:b", "attention:c"]);
    expect(r.stopped).toBe("workers");
    expect(r.moves[2]?.reason).toMatch(/worker ceiling 2 reached \(2 working\)/);
    expect(hook.spawns).toEqual(["a-1", "b-1"]);
    expect(runsOf("c")).toBe(0);
    expect(receiptOf("c", "auto:1")).toBeUndefined();
    expect(r.used).toBe(2); // the refusal is free
  });

  it("an idle worker whose task is CLOSED does not count: the slot is free (df1)", async () => {
    task("a");
    task("b");
    task("c");
    await run({ workers: 2, cap: 2 });
    closeIdle("a"); // a-1's pane still exists, its close was just applied
    expect(getAgent(db, "a-1", "d")).toBeDefined();
    const r = await run({ workers: 2 });
    expect(kinds(r)).toEqual(["spawn:c"]);
    expect(hook.spawns).toEqual(["a-1", "b-1", "c-1"]);
    expect(runsOf("c")).toBe(1);
  });

  it("an attempt that has its pane but no claim yet (a crash) holds a slot until its task closes", async () => {
    task("a");
    expect(reserveAttempt(db, "d", "a").ok).toBe(true);
    const agent = insertAgent(db, { name: "a-1", workstream: "d", paneId: "%77" });
    updateReceipt(db, tid("a"), "auto:1", {
      state: "pane",
      agentId: agent.incarnation,
      paneId: "%77",
    });
    expect(liveWorkers(db, "d")).toBe(1);
    closeIdle("a");
    expect(liveWorkers(db, "d")).toBe(0);
  });

  it("another process taking the last slot between the check and the pane stops at the guard: nothing spawned, resumable", async () => {
    task("a");
    addTask(db, { workstream: "d", localId: "other", title: "other" });
    // A peer's idle worker (no task: a free slot) takes a task as THIS attempt is reserved:
    // after the loop's check, before the pane.
    const peer = insertAgent(db, { name: "peer", workstream: "d", paneId: "%peer" });
    expect(liveWorkers(db, "d")).toBe(0);
    db.exec(`CREATE TRIGGER peer AFTER INSERT ON spawn_receipts WHEN NEW.task_id != ${tid("other")} BEGIN
      INSERT INTO spawn_receipts (task_id, attempt_key, name, workstream, request_sha, msg_id, agent_id, pane_id, state, created_at, updated_at)
      VALUES (${tid("other")}, 'auto:9', 'peer', 'd', 'x', 'm', ${peer.incarnation}, '%peer', 'pane', 'x', 'x'); END`);
    const r = await run({ workers: 1, cap: 1 });
    db.exec("DROP TRIGGER peer");
    expect(r.moves[0]).toMatchObject({ kind: "skip", task: "a" });
    expect(r.moves[0]?.reason).toMatch(/worker ceiling 1 is reached/);
    expect(hook.spawns).toEqual([]);
    expect(receiptOf("a", "auto:1")?.state).toBe("reserved");
  });

  it("without --workers there is no ceiling", async () => {
    for (const t of ["a", "b", "c"]) task(t);
    const r = await run();
    expect(kinds(r)).toEqual(["spawn:a", "spawn:b", "spawn:c"]);
  });

  it("a ceiling reached between reservation and pane stops at the guard: rolled back unsent, resumable", async () => {
    task("a");
    task("b");
    await run({ workers: 1, cap: 1 });
    // b is not ready for a pane while a works; a reservation made earlier is resumed only when a slot is free.
    const r = await run({ workers: 1 });
    expect(r.stopped).toBe("workers");
    expect(hook.spawns).toEqual(["a-1"]);
    expect(runsOf("b")).toBe(0);
  });

  it("a stored attempt that needs a pane waits for a slot; one that has its pane is replayed regardless", async () => {
    task("a");
    task("b");
    await run({ workers: 1, cap: 1 });
    reserveAttempt(db, "d", "b"); // reserved: no pane yet (a crash before spawn)
    const held = await run({ workers: 1 });
    expect(held.stopped).toBe("workers");
    expect(hook.spawns).toEqual(["a-1"]);
    closeIdle("a");
    const freed = await run({ workers: 1 });
    expect(kinds(freed)).toEqual(["replay:b"]);
    expect(runsOf("b")).toBe(1);
  });

  it("an API-errored worker is retried in place even at the ceiling (no new pane)", async () => {
    await dispatched();
    hook.sendRuns = 1;
    facts["a-1"] = ERRORED;
    const r = await run({ workers: 1 });
    expect(kinds(r)).toEqual(["retry:a"]);
    expect(hook.spawns).toEqual(["a-1"]);
  });

  it("--dry shows the ceiling stop without writing", async () => {
    task("a");
    task("b");
    await run({ workers: 1, cap: 1 });
    const r = await run({ workers: 1, dry: true });
    expect(r.stopped).toBe("workers");
    expect(r.moves[0]).toMatchObject({ kind: "attention", task: "b" });
    expect(runsOf("b")).toBe(0);
  });

  it("--hold at the ceiling waits; a closed task frees the slot and the pass dispatches", async () => {
    task("a");
    task("b");
    let waits = 0;
    const w = async (): Promise<WaitResult> => {
      waits++;
      if (waits === 1) closeIdle("a");
      return {
        event:
          waits === 1
            ? { kind: "closed", ref: { kind: "task", workstream: "d", id: "a" } }
            : { kind: "heartbeat", ref: null },
        refs: [],
        timedOut: false,
        interrupted: false,
        exit: 0,
        cursor: {},
        humanNeeds: [],
      };
    };
    const r = await run({ workers: 1, hold: true, wait: w });
    expect(waits).toBe(2); // the second is the freed slot's new worker
    expect(kinds(r)).toEqual(["spawn:a", "attention:b", "spawn:b"]);
    expect(r.stopped).toBeUndefined();
    expect(hook.spawns).toEqual(["a-1", "b-1"]);
  });

  it("--workers must be a whole number from 1 to 100", async () => {
    await expect(run({ workers: 0 })).rejects.toThrow(/--workers/);
    await expect(run({ workers: 1.5 })).rejects.toThrow(/--workers/);
  });
});

describe("a recovery leaves what it must not touch", () => {
  it("never calls authorizeTasks or changes config: task_auto is unchanged but runs/last_spawn", async () => {
    await dispatched();
    const before = db.prepare("SELECT cli, worktree, max_runs, enabled FROM task_auto").all();
    facts["a-1"] = { status: null };
    await run();
    expect(db.prepare("SELECT cli, worktree, max_runs, enabled FROM task_auto").all()).toEqual(
      before,
    );
    expect(readAttempt(db, tid("a")).record?.retry).toBe(true);
  });
});
