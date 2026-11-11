// An at-start plugin kind's first turn under `--task` (plugins spec D8 G1, G1a,
// G1b), over the fake plugin as a provider whose job kind starts its job with
// the first prompt. The multiplexer is a stub: views never run. What holds:
//   - the placeholder row comes first, claims the task and journals `sending`;
//     job.start is the write, carrying the receipt's msgId; no channel.send;
//   - a definite start failure is unsent: the claim goes back, nothing is kept;
//   - an unknown start keeps placeholder, claim, record and receipt (`unknown`);
//     the replay resolves it by job.lookup: found opens the view and sends the
//     receipt, a proven none fails the attempt and rolls everything back;
//   - `mu agent check` on the first prompt's msgId answers from the job record.

import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpawnAttemptFailedError } from "../src/agents/errors.js";
import { getReceipt } from "../src/agents/receipts.js";
import { resolveFirstTurn } from "../src/agents/spawn-plugin.js";
import { spawnForTask } from "../src/agents/task-spawn.js";
import { getAgent, isPendingPaneId } from "../src/agents.js";
import { getCarrierJobByName, listCarrierJobs } from "../src/carrier-jobs.js";
import { cmdAgentCheck } from "../src/cli/agents.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, taskIdFor } from "../src/tasks.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const BRIEF = "do the t1 work";

const spawnT1 = () =>
  spawnForTask(h.db, {
    spawn: { name: "w1", workstream: "ws", host: "box", cli: "claude" },
    task: "t1",
    text: BRIEF,
  });
const receipt = () => getReceipt(h.db, taskIdFor(h.db, "t1", "ws") ?? -1, "manual:t1");
const owner = () => getTask(h.db, "t1", "ws")?.ownerId ?? null;
const job = () => getCarrierJobByName(h.db, "ws", "w1");
/** The effect rows' writer is gone (a crashed spawn): a gated `none` then counts (D4). */
const writerGone = () => {
  const dead = spawnSync("true").pid;
  h.db
    .prepare("UPDATE effects SET creator_pid = ?, creator_start = NULL, plugin_pgid = ?")
    .run(dead, dead);
};

let log: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await h.setup({ firstTurn: "at-start" });
  addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => log.mockRestore());

describe("an at-start --task spawn folds its first prompt into job.start (G1)", () => {
  it("claims on the placeholder, journals sending, then starts with the receipt's msgId", async () => {
    const out = await spawnT1();
    expect(out.state).toBe("sent");
    const rec = receipt();
    expect(rec).toMatchObject({ state: "sent", runs: 0, incarnation: "inc-1", transport: "cloud" });
    const spec = h.calls("job.start")[0]?.params.spec as { firstPrompt?: unknown };
    expect(spec.firstPrompt).toEqual({ text: BRIEF, msgId: rec?.msgId });
    expect(h.calls("channel.send")).toHaveLength(0);
    expect(h.f.backend().starts).toBe(1);
    const a = getAgent(h.db, "w1", "ws");
    expect(a?.paneId).toBe("%1");
    expect(rec).toMatchObject({ agentId: a?.incarnation, paneId: "%1" });
    expect(owner()).toBe(a?.incarnation);
    expect(job()).toMatchObject({ firstMsgId: rec?.msgId, firstInc: "inc-1", job: "job-1" });
  });

  it("a start that provably did nothing is unsent: claim released, nothing kept", async () => {
    h.f.set({ faults: { "job.start": ["permanent"] } });
    await expect(spawnT1()).rejects.toThrow(/permanent/);
    expect(receipt()?.state).toBe("failed");
    expect(owner()).toBeNull();
    expect(getTask(h.db, "t1", "ws")?.status).toBe("OPEN");
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(listCarrierJobs(h.db)).toHaveLength(0);
  });

  it("a start that died mid-call keeps placeholder, claim and record: unknown, never resent", async () => {
    h.f.set({ faults: { "job.start": ["exit"] } });
    const out = await spawnT1();
    expect(out.state).toBe("unknown");
    expect(out.reason).toMatch(/mu agent check w1/);
    const a = getAgent(h.db, "w1", "ws");
    expect(a !== undefined && isPendingPaneId(a.paneId)).toBe(true);
    expect(owner()).toBe(a?.incarnation); // the claim came before the start
    expect(receipt()?.state).toBe("unknown");
    expect(job()).toMatchObject({ launch: "intent", job: null, firstMsgId: receipt()?.msgId });
  });
});

describe("replay resolves an unknown start by lookup (G1a)", () => {
  it("found: the view opens from the start's reply, the receipt goes to sent; one start", async () => {
    h.f.set({ faults: { "job.start": ["effectThenExit"] } });
    expect((await spawnT1()).state).toBe("unknown");
    const out = await spawnT1();
    expect(out).toMatchObject({ state: "sent", replay: true, checked: "accepted" });
    const a = getAgent(h.db, "w1", "ws");
    expect(a?.paneId).toBe("%1");
    expect(a?.channel).toBe("cloud");
    expect(receipt()).toMatchObject({ state: "sent", runs: 0, incarnation: "inc-1", paneId: "%1" });
    expect(job()).toMatchObject({ job: "job-1", firstInc: "inc-1", agentId: a?.incarnation });
    expect(h.f.backend().starts).toBe(1);
    expect(h.calls("job.start")).toHaveLength(1);
  });

  it("none (gated): the attempt failed, claim, placeholder and record gone", async () => {
    h.f.set({ faults: { "job.start": ["unknown-outcome"] } });
    expect((await spawnT1()).state).toBe("unknown");
    writerGone();
    await expect(spawnT1()).rejects.toBeInstanceOf(SpawnAttemptFailedError);
    expect(receipt()?.state).toBe("failed");
    expect(owner()).toBeNull();
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(listCarrierJobs(h.db)).toHaveLength(0);
  });
});

describe("mu agent check on the first prompt's msgId (G1b)", () => {
  it("an unresolved start is unreachable (exit 1), naming its key; another msgId is no first prompt", async () => {
    h.f.set({ faults: { "job.start": ["unknown-outcome"] } });
    await spawnT1();
    const a = getAgent(h.db, "w1", "ws");
    const msgId = receipt()?.msgId ?? "";
    if (a === undefined) throw new Error("no placeholder");
    // The writer (this process) lives: a none is not proof yet.
    const pending = await resolveFirstTurn(h.db, a, msgId);
    expect(pending).toMatchObject({ state: "unreachable" });
    expect(pending?.state === "unreachable" && pending.reason).toContain(job()?.token ?? "?");
    await expect(cmdAgentCheck(h.db, "w1", msgId, { workstream: "ws" })).rejects.toMatchObject({
      exitCode: 1,
    });
    await expect(resolveFirstTurn(h.db, a, "another-id")).resolves.toBeUndefined();
  });

  it("answers accepted runs=0 from the job record, not the channel's receipt", async () => {
    await spawnT1();
    const msgId = receipt()?.msgId ?? "";
    await cmdAgentCheck(h.db, "w1", msgId, { workstream: "ws" });
    expect(log.mock.calls.flat().join("\n")).toMatch(/^accepted runs=0/m);
    expect(h.calls("channel.receipt")).toHaveLength(0);
  });
});

describe("review of P6e2: first-turn receipts are monotone per attempt (ruling 1)", () => {
  it("mu agent check's recovery repoints the receipt: the task replay then reports sent", async () => {
    h.f.set({ faults: { "job.start": ["effectThenExit"] } });
    expect((await spawnT1()).state).toBe("unknown");
    await cmdAgentCheck(h.db, "w1", receipt()?.msgId ?? "", { workstream: "ws" });
    expect(receipt()?.paneId).toBe("%1");
    const out = await spawnT1();
    expect(out).toMatchObject({ state: "sent", replay: true });
    expect(out.stale).toBeUndefined();
    expect(h.f.backend().starts).toBe(1);
  });

  it("a view failure after the start is sent-then-stopped, never failed; the same attempt starts nothing", async () => {
    h.stubMux({
      spawnAgent: async () => {
        throw new Error("view failed");
      },
    });
    await expect(spawnT1()).rejects.toThrow("view failed");
    expect(receipt()).toMatchObject({ state: "sent", runs: 0 });
    expect(receipt()?.detail).toMatch(/stopped.*view failed/);
    expect(h.f.backend()).toMatchObject({ starts: 1, stops: 1 });
    h.stubMux();
    await expect(spawnT1()).rejects.toMatchObject({ name: "SpawnAttemptEndedError" });
    expect(h.f.backend().starts).toBe(1);
    expect(h.calls("channel.send")).toHaveLength(0);
  });
});

describe("review 2 of P6e2: named cases", () => {
  const failingView = () =>
    h.stubMux({
      spawnAgent: async (o) => {
        h.panes.set("%bad", { command: o.command });
        o.onPaneCreated?.("%bad");
        await new Promise((r) => setTimeout(r, 30));
        throw new Error("view completion failed");
      },
    });

  it("a lookup recovery whose view fails leaves row and receipt; the next replay opens a live view", async () => {
    h.f.set({ faults: { "job.start": ["effectThenExit"] } });
    expect((await spawnT1()).state).toBe("unknown");
    const before = receipt();
    failingView();
    expect((await spawnT1()).state).toBe("unknown");
    expect(receipt()).toMatchObject({ state: before?.state, paneId: before?.paneId });
    expect(isPendingPaneId(getAgent(h.db, "w1", "ws")?.paneId ?? "")).toBe(true);
    h.stubMux();
    const out = await spawnT1();
    expect(out.state).toBe("sent");
    expect(h.panes.has(out.agent?.paneId ?? "")).toBe(true);
    expect(receipt()?.paneId).toBe(out.agent?.paneId);
    expect(h.f.backend().starts).toBe(1);
  });

  it("mu agent check: a failed view is no accepted; the next check opens a live view", async () => {
    h.f.set({ faults: { "job.start": ["effectThenExit"] } });
    await spawnT1();
    const msgId = receipt()?.msgId ?? "";
    failingView();
    await expect(cmdAgentCheck(h.db, "w1", msgId, { workstream: "ws" })).rejects.toMatchObject({
      exitCode: 1,
    });
    h.stubMux();
    await cmdAgentCheck(h.db, "w1", msgId, { workstream: "ws" });
    expect(h.panes.has(getAgent(h.db, "w1", "ws")?.paneId ?? "")).toBe(true);
  });
});
