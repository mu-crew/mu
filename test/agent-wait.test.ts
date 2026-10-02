// Fast-tier unit tests for waitForAgents — the task-less "block until
// agents finish" primitive (busy → any other state). The readStatus
// hook is the seam: tests script a status sequence per agent without
// any real tmux/pi. See src/agents/wait.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentStatusSnapshot,
  type AgentWaitRef,
  setAgentWaitSleepForTests,
  waitForAgents,
} from "../src/agents/wait.js";
import { spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

describe("waitForAgents", () => {
  let dir: string;
  let db: Db;
  let mock: MockState;
  const ws = "scratch";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mu-agentwait-"));
    db = openDb({ path: join(dir, "mu.db") });
    mock = freshMockState();
    setTmuxExecutor(mockTmux(mock).executor);
    setSleepForTests(async () => {});
    setAgentWaitSleepForTests(async () => {});
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    // Two real agent rows so the pre-flight existence check passes.
    await spawnAgent(db, { name: "worker-1", workstream: ws, cli: "sh" });
    await spawnAgent(db, { name: "worker-2", workstream: ws, cli: "sh" });
  });

  afterEach(() => {
    const key = "MU_SPAWN_LIVENESS_MS";
    delete process.env[key];
    setAgentWaitSleepForTests(undefined);
    resetSleep();
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a legacy per-ref hook from a scripted state queue. */
  function scripted(
    scripts: Record<string, (string | null)[]>,
  ): (ref: AgentWaitRef) => Promise<AgentStatusSnapshot> {
    const queues: Record<string, (string | null)[]> = {};
    for (const [k, v] of Object.entries(scripts)) queues[k] = [...v];
    return async (ref) => {
      const q = queues[ref.name] ?? [null];
      const next = q.length > 1 ? q.shift() : q[0];
      return { status: (next ?? null) as AgentStatusSnapshot["status"] };
    };
  }

  /** Build the preferred batch hook; one call represents one tick. */
  function scriptedBatch(
    scripts: Record<string, (string | null)[]>,
  ): (refs: readonly AgentWaitRef[]) => Promise<Map<string, AgentStatusSnapshot>> {
    const queues: Record<string, (string | null)[]> = {};
    for (const [k, v] of Object.entries(scripts)) queues[k] = [...v];
    return async (refs) => {
      const snapshots = new Map<string, AgentStatusSnapshot>();
      for (const ref of refs) {
        const q = queues[ref.name] ?? [null];
        const next = q.length > 1 ? q.shift() : q[0];
        snapshots.set(`${ref.workstreamName}/${ref.name}`, {
          status: (next ?? null) as AgentStatusSnapshot["status"],
          ...(next === "unknown" ? { unknownReason: "murmur has no row" } : {}),
        });
      }
      return snapshots;
    };
  }

  it("fires on busy → idle (the canonical finish)", async () => {
    const res = await waitForAgents(db, [{ workstreamName: ws, name: "worker-1" }], {
      pollMs: 1,
      readStatus: scripted({ "worker-1": ["busy", "busy", "needs_input"] }),
    });
    expect(res.timedOut).toBe(false);
    expect(res.agents[0]?.fired).toBe(true);
    expect(res.agents[0]?.wasBusy).toBe(true);
  });

  it("does NOT fire for an already-idle agent (must be busy first)", async () => {
    const res = await waitForAgents(db, [{ workstreamName: ws, name: "worker-1" }], {
      pollMs: 1,
      timeoutMs: 10,
      readStatus: scripted({ "worker-1": ["needs_input"] }),
    });
    expect(res.timedOut).toBe(true);
    expect(res.agents[0]?.fired).toBe(false);
    expect(res.agents[0]?.wasBusy).toBe(false);
  });

  it("preserves busy across unknown and fires on the next known idle state", async () => {
    const res = await waitForAgents(db, [{ workstreamName: ws, name: "worker-1" }], {
      pollMs: 1,
      readStatuses: scriptedBatch({ "worker-1": ["busy", "unknown", "needs_input"] }),
    });
    expect(res.timedOut).toBe(false);
    expect(res.agents[0]?.fired).toBe(true);
    expect(res.agents[0]?.wasBusy).toBe(true);
  });

  it("keeps unknown pending and surfaces its reason", async () => {
    const res = await waitForAgents(db, [{ workstreamName: ws, name: "worker-1" }], {
      pollMs: 1,
      timeoutMs: 10,
      readStatuses: scriptedBatch({ "worker-1": ["unknown"] }),
    });
    expect(res.timedOut).toBe(true);
    expect(res.agents[0]?.fired).toBe(false);
    expect(res.agents[0]?.unknownReason).toBe("murmur has no row");
  });

  it("fires on busy → needs_permission (any known non-busy state)", async () => {
    const res = await waitForAgents(db, [{ workstreamName: ws, name: "worker-1" }], {
      pollMs: 1,
      readStatus: scripted({ "worker-1": ["busy", "needs_permission"] }),
    });
    expect(res.agents[0]?.fired).toBe(true);
  });

  it("reports all-initially-unknown once and keeps waiting", async () => {
    const reports: string[][] = [];
    const res = await waitForAgents(db, [{ workstreamName: ws, name: "worker-1" }], {
      pollMs: 1,
      timeoutMs: 10,
      readStatuses: scriptedBatch({ "worker-1": ["unknown"] }),
      onInitialUnknown: (agents) => reports.push(agents.map((agent) => agent.name)),
    });
    expect(res.timedOut).toBe(true);
    expect(reports).toEqual([["worker-1"]]);
  });

  it("calls the batch reader once per tick for all pending agents", async () => {
    const readStatuses = scriptedBatch({
      "worker-1": ["busy", "needs_input"],
      "worker-2": ["busy", "needs_input"],
    });
    let calls = 0;
    const res = await waitForAgents(
      db,
      [
        { workstreamName: ws, name: "worker-1" },
        { workstreamName: ws, name: "worker-2" },
      ],
      {
        pollMs: 1,
        readStatuses: async (refs) => {
          calls += 1;
          return readStatuses(refs);
        },
      },
    );
    expect(res.timedOut).toBe(false);
    expect(calls).toBe(2);
  });

  it("--all waits for every agent to fire", async () => {
    const res = await waitForAgents(
      db,
      [
        { workstreamName: ws, name: "worker-1" },
        { workstreamName: ws, name: "worker-2" },
      ],
      {
        any: false,
        pollMs: 1,
        readStatus: scripted({
          "worker-1": ["busy", "needs_input"],
          "worker-2": ["busy", "busy", "busy", "needs_input"],
        }),
      },
    );
    expect(res.timedOut).toBe(false);
    expect(res.agents.every((a) => a.fired)).toBe(true);
  });

  it("--any fires as soon as one agent finishes", async () => {
    const res = await waitForAgents(
      db,
      [
        { workstreamName: ws, name: "worker-1" },
        { workstreamName: ws, name: "worker-2" },
      ],
      {
        any: true,
        pollMs: 1,
        readStatus: scripted({
          "worker-1": ["busy", "needs_input"], // finishes first
          "worker-2": ["busy"], // stays busy forever
        }),
      },
    );
    expect(res.timedOut).toBe(false);
    expect(res.agents.filter((a) => a.fired).length).toBeGreaterThanOrEqual(1);
  });

  it("marks a vanished pane (status null) as dead, not fired", async () => {
    const res = await waitForAgents(db, [{ workstreamName: ws, name: "worker-1" }], {
      any: true,
      pollMs: 1,
      readStatus: scripted({ "worker-1": ["busy", null] }),
    });
    expect(res.agents[0]?.dead).toBe(true);
    expect(res.agents[0]?.fired).toBe(false);
  });

  it("times out when an agent never leaves busy", async () => {
    const res = await waitForAgents(db, [{ workstreamName: ws, name: "worker-1" }], {
      pollMs: 1,
      timeoutMs: 5,
      readStatus: scripted({ "worker-1": ["busy"] }),
    });
    expect(res.timedOut).toBe(true);
    expect(res.agents[0]?.fired).toBe(false);
  });

  it("throws AgentNotFoundError for an unknown agent (loud pre-flight)", async () => {
    await expect(
      waitForAgents(db, [{ workstreamName: ws, name: "ghost" }], {
        readStatus: async () => ({ status: "needs_input" }),
      }),
    ).rejects.toThrow(/ghost/);
  });

  describe("watch (event-driven, e.g. the control socket)", () => {
    const ref = { workstreamName: ws, name: "worker-1" };

    it("fires on the watch's settle without calling the poll reader", async () => {
      let polls = 0;
      let settle: (s: AgentStatusSnapshot) => void = () => {};
      const settled = new Promise<AgentStatusSnapshot>((r) => {
        settle = r;
      });
      const pending = waitForAgents(db, [ref], {
        timeoutMs: 5_000,
        readStatuses: async () => {
          polls += 1;
          return new Map();
        },
        watch: async () => ({ initial: { status: "busy" }, settled }),
      });
      settle({ status: "needs_input" });
      const res = await pending;
      expect(res.timedOut).toBe(false);
      expect(res.agents[0]).toMatchObject({ fired: true, status: "needs_input" });
      expect(polls).toBe(0);
    });

    it("marks the agent dead when the watch reports null", async () => {
      const res = await waitForAgents(db, [ref], {
        timeoutMs: 5_000,
        readStatuses: async () => new Map(),
        watch: async () => ({
          initial: { status: "busy" },
          settled: Promise.resolve({ status: null }),
        }),
      });
      expect(res.agents[0]?.dead).toBe(true);
    });

    it("hands back to polling when the watch ends unknown", async () => {
      const res = await waitForAgents(db, [ref], {
        pollMs: 1,
        timeoutMs: 5_000,
        readStatuses: scriptedBatch({ "worker-1": ["busy", "needs_input"] }),
        watch: async () => ({
          initial: { status: "busy" },
          settled: Promise.resolve({ status: "unknown" }),
        }),
      });
      expect(res.agents[0]?.fired).toBe(true);
    });

    it("times out and aborts the watch signal", async () => {
      let signal: AbortSignal | undefined;
      const res = await waitForAgents(db, [ref], {
        timeoutMs: 20,
        readStatuses: async () => new Map(),
        watch: async (_r, s) => {
          signal = s;
          return { initial: { status: "busy" }, settled: new Promise(() => {}) };
        },
      });
      expect(res.timedOut).toBe(true);
      expect(signal?.aborted).toBe(true);
    });
  });
});
