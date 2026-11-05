// Spec D14: a worker whose shell command waits in muzzle's queue fires no
// hook events, so mu reads `muzzle status --json` and treats an agent whose
// pane holds a waiting muzzle as waiting, never stalled. muzzle, ps and tmux
// are all scripted.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, type StateAgentRef } from "../src/agent-state.js";
import { insertAgent, readLiveAgents } from "../src/agents.js";
import { readAgentStates } from "../src/channels/index.js";
import { formatAgentsTable } from "../src/cli/format.js";
import { loadDashboard } from "../src/dashboard-data.js";
import {
  type MuzzleWaiter,
  panesWithWaiters,
  parseMuzzleWaiters,
  queuedPanes,
  setMuzzleRunnerForTests,
  setProcessParentsForTests,
} from "../src/muzzle-queue.js";
import { claimTask } from "../src/tasks.js";
import { waitForEvents } from "../src/wait.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { mkTask, taskRef, useWaitDb } from "./_wait-fixtures.js";

/** `muzzle status --json` with one holder and these waiters. */
function status(waiting: readonly { pid: number; pane: string | null }[]): string {
  return JSON.stringify({
    version: "0.2.4",
    budget: 4,
    held: 4,
    free: 0,
    holders: [{ slots: 4, agent: "orch", rule: "gate", pid: 90, pgid: 90, pane: "%11" }],
    waiting: waiting.map((w, i) => ({
      position: i + 1,
      slots: 2,
      class: "normal",
      agent: null,
      rule: "cargo-test",
      age_s: 600,
      slow: true,
      ...w,
    })),
  });
}

// Process tree: pane %11 runs pid 100 (claude), whose shell 250 runs muzzle 300.
// Pane %12 runs pid 150. muzzle 400 runs under 500, in no agent's pane.
const PARENTS = new Map([
  [300, 250],
  [250, 100],
  [100, 1],
  [150, 1],
  [400, 500],
  [500, 1],
]);
const PANE_PIDS: Record<string, number> = { "%11": 100, "%12": 150 };

let mux: MuxHarness | undefined;
let runs = 0;

function scriptMuzzle(stdout: string | null): void {
  runs = 0;
  setMuzzleRunnerForTests(async () => {
    runs++;
    return stdout;
  });
}

/** tmux answers murmur's pane options (`state` with `since`) and each pane's pid. */
function scriptTmux(state: string, since: number): void {
  mux = installMux("tmux", async (args) => {
    const key = args.join(" ");
    if (key.startsWith("list-panes -a -F")) {
      const rows = Object.keys(PANE_PIDS).map((p) => `${p}\t${state}\t${since}`);
      return { stdout: rows.join("\n"), stderr: "", exitCode: 0 };
    }
    const m = /^display-message -t (\S+) -p/.exec(key);
    if (m?.[1] !== undefined && PANE_PIDS[m[1]] !== undefined) {
      return { stdout: `${m[1]}|${PANE_PIDS[m[1]]}`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `unrouted: ${key}`, exitCode: 1 };
  });
}

beforeEach(() => {
  setProcessParentsForTests(async () => PARENTS);
  resetAgentStateCacheForTests();
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  // test/_setup.ts's baseline: no real muzzle in the fast tier.
  setMuzzleRunnerForTests(async () => null);
  setProcessParentsForTests(null);
  resetAgentStateCacheForTests();
});

describe("muzzle status --json", () => {
  it("names each waiter's pid and pane; a waiter with no pid (older muzzle) is skipped", () => {
    const text = status([
      { pid: 300, pane: "%11" },
      { pid: 400, pane: null },
    ]);
    expect(parseMuzzleWaiters(text)).toEqual([
      { pid: 300, pane: "%11" },
      { pid: 400, pane: null },
    ]);
    expect(parseMuzzleWaiters(JSON.stringify({ waiting: [{ position: 1 }] }))).toEqual([]);
    expect(parseMuzzleWaiters("not json")).toEqual([]);
    expect(parseMuzzleWaiters("{}")).toEqual([]);
  });

  it("a waiter is placed by its process tree, not by the pane it recorded", () => {
    const panes = new Map(Object.entries(PANE_PIDS));
    const w = (pid: number, pane: string | null): MuzzleWaiter => ({ pid, pane });
    expect(panesWithWaiters([w(300, null)], panes, PARENTS)).toEqual(new Set(["%11"]));
    // Pane ids repeat across tmux servers: a recorded "%12" outside %12's tree is not %12's.
    expect(panesWithWaiters([w(400, "%12")], panes, PARENTS)).toEqual(new Set());
    // A holder runs, it doesn't wait: only `waiting` entries are read at all.
    expect(parseMuzzleWaiters(status([]))).toEqual([]);
  });
});

describe("queuedPanes", () => {
  it("reads no pane and no process table when nothing waits", async () => {
    scriptMuzzle(status([]));
    let parents = 0;
    setProcessParentsForTests(async () => {
      parents++;
      return PARENTS;
    });
    scriptTmux("working", Date.now());
    expect(await queuedPanes(["%11", "%12"])).toEqual(new Set());
    expect(parents).toBe(0);
    expect(mux?.calls).toEqual([]);
    scriptMuzzle(null);
    expect(await queuedPanes(["%11"])).toEqual(new Set());
  });

  it("caches muzzle's answer for a few seconds", async () => {
    scriptMuzzle(status([{ pid: 300, pane: "%11" }]));
    scriptTmux("working", Date.now());
    const now = 1_000_000;
    expect(await queuedPanes(["%11"], { now })).toEqual(new Set(["%11"]));
    expect(await queuedPanes(["%11"], { now: now + 1_000 })).toEqual(new Set(["%11"]));
    expect(runs).toBe(1);
    await queuedPanes(["%11"], { now: now + 10_000 });
    expect(runs).toBe(2);
  });
});

describe("readAgentStates", () => {
  const claude: StateAgentRef = {
    name: "c1",
    workstreamName: "w",
    paneId: "%11",
    cli: "claude",
    channel: "mux",
  };
  const other: StateAgentRef = { ...claude, name: "c2", paneId: "%12" };

  it("marks an agent off ctl whose pane holds a waiting muzzle as queued", async () => {
    scriptMuzzle(status([{ pid: 300, pane: "%11" }]));
    scriptTmux("working", Date.now());
    const r = await readAgentStates([claude, other]);
    expect(r.get("w/c1")).toMatchObject({ state: "busy", queued: true });
    expect(r.get("w/c2")?.queued).toBeUndefined();
  });

  it("never asks muzzle about a pi agent on ctl", async () => {
    scriptMuzzle(status([{ pid: 300, pane: "%11" }]));
    scriptTmux("working", Date.now());
    const pi: StateAgentRef = { ...claude, cli: "pi", channel: "ctl" };
    const r = await readAgentStates([pi]);
    expect(r.get("w/c1")?.queued).toBeUndefined();
    expect(runs).toBe(0);
  });
});

describe("a worker queued behind a held slot", () => {
  const env = useWaitDb();
  const base = { pollMs: 1, sync: false, callers: [], stuckAfterMs: 1_000 } as const;

  async function claudeOwns(task: string): Promise<void> {
    mkTask(env.db, task);
    insertAgent(env.db, { name: "c1", workstream: "w", paneId: "%11", cli: "claude" });
    await claimTask(env.db, task, { workstream: "w", agentName: "c1" });
  }

  it("is never reported stalled, through the real agent read", async () => {
    await claudeOwns("t1");
    // Its last hook event was ten minutes ago: without the queue, a stall.
    scriptTmux("idle", Date.now() - 600_000);
    scriptMuzzle(status([{ pid: 300, pane: "%11" }]));
    const queued = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      timeoutMs: 60,
      ...ctlAgentHooks(env.db),
    });
    expect(queued.timedOut).toBe(true);
    expect(queued.refs[0]?.stuck).not.toBe(true);
    expect(
      env.db.prepare("SELECT COUNT(*) AS n FROM ops WHERE intent = 'agent.stall'").get(),
    ).toEqual({ n: 0 });

    // Admitted (no longer waiting): the same silence is a stall again.
    scriptMuzzle(status([]));
    const admitted = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      timeoutMs: 1_000,
      ...ctlAgentHooks(env.db),
    });
    expect(admitted.event).toMatchObject({ kind: "stall", ref: { id: "t1" } });
    expect(admitted.exit).toBe(7);
  });

  it("raises no input or stalled item, and lists as queued in muzzle", async () => {
    await claudeOwns("t1");
    // needs_input for ten minutes, past the idle threshold, on an owner of work.
    scriptTmux("idle", Date.now() - 600_000);
    scriptMuzzle(status([{ pid: 300, pane: "%11" }]));
    const [agent] = await readLiveAgents(env.db, "w");
    expect(agent).toMatchObject({ name: "c1", state: "needs_input", idle: true, queued: true });
    expect(formatAgentsTable(agent === undefined ? [] : [agent])).toContain(
      "needs_input (queued in muzzle)",
    );
    const queued = await loadDashboard(env.db, { caller: null });
    expect(queued.attention.filter((a) => a.target === "w/c1")).toEqual([]);

    // Admitted: the same reading needs a human again.
    resetAgentStateCacheForTests();
    scriptMuzzle(status([]));
    const [admitted] = await readLiveAgents(env.db, "w");
    expect(admitted?.queued).toBeUndefined();
    expect(formatAgentsTable(admitted === undefined ? [] : [admitted])).not.toContain("queued");
    const snap = await loadDashboard(env.db, { caller: null });
    expect(snap.attention.map((a) => a.kind)).toContain("input");
  });
});
