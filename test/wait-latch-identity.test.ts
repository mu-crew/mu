// fix_latch_identity. (P1) A settled latch is valid only for the exact (agentId, incarnation, runs)
// it captured: an owner respawned under the same name (new registry row), or its pi restarted (new
// incarnation), supersedes it and is watched from its own run 0. (P2a) A delivery re-reads the cursor
// in its transaction: an event another process consumed meanwhile is skipped, not returned twice.
// (P2b) An unchanged stall is logged once per (agentId, incarnation, runs), not once per wait.
// Real SQLite (two connections for P2a); agents scripted (no ctl, no mux).

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { claimTask } from "../src/tasks/claim.js";
import { getTask } from "../src/tasks.js";
import { type AgentReading, waitForEvents } from "../src/wait.js";
import {
  answer,
  controllableWatch,
  mkDelegate,
  mkOwnedTask,
  scriptedAgents,
  taskRef,
  useWaitDb,
} from "./_wait-fixtures.js";

const env = useWaitDb();
const base = { pollMs: 1, sync: false } as const;
const MALFORMED = 'CLOSE: task=t1 evidence="e"\nREPORT:\n';
const VALID = 'CLOSE: task=t1 evidence="npm test: 3 passed"\nREPORT:\ndone';
const rowOf = (name: string): number =>
  (env.db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as { id: number }).id;
const settles = (): { agent_id: number; incarnation: string; runs: number }[] =>
  env.db
    .prepare("SELECT agent_id, incarnation, runs FROM agent_settles ORDER BY rowid")
    .all() as never;

describe("a settled latch holds only the identity it captured (fix_latch_identity P1)", () => {
  /**
   * a1 owns t1; its run 1 settles with a malformed CLOSE (latched under --all --on-stall warn).
   * Then `swap` happens (a respawn or a pi restart): the new identity's run 1 settles with a valid
   * CLOSE. The same wait must apply it and close t1.
   */
  async function scenario(swap: "respawn" | "restart" | "respawn-same-inc") {
    await mkOwnedTask(env.db, "t1", "a1");
    env.db.prepare("UPDATE agents SET spawner = 'w/boss' WHERE name = 'a1'").run();
    const since = Date.now() - 60_000;
    const idle = { status: "needs_input", since, source: "ctl", ctl: "ok" } as const;
    const first = { agentId: rowOf("a1"), incarnation: "inc1" };
    let now = { ...first };
    const table = new Map<string, AgentReading>([["w/a1", { ...idle, ...now, runs: 1 }]]);
    const watched: { agentId: number; after: number }[] = [];
    const watchAgent = async (ref: { afterRuns?: number }) => {
      const after = ref.afterRuns ?? 0;
      watched.push({ agentId: now.agentId, after });
      const w = controllableWatch({ status: "busy" });
      if (after < 1) {
        w.settle({
          ...idle,
          ...now,
          settled: true,
          runs: 1,
          lastText: now.agentId === first.agentId && now.incarnation === "inc1" ? MALFORMED : VALID,
        });
      }
      return { ...w.handle, afterRuns: after };
    };
    let n = 0;
    let claimErr: unknown;
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      timeoutMs: 1500,
      mode: "all",
      status: "CLOSED",
      callers: ["w/boss"],
      stuckAfterMs: 1000,
      onStall: "warn",
      readAgents: scriptedAgents(table).readAgents,
      watchAgent,
      sleep: async () => {
        if (++n === 3) {
          // Everything in one synchronous step: no tick sees t1 reaped and unowned.
          if (swap === "restart") now = { ...now, incarnation: "inc2" };
          else {
            deleteAgent(env.db, "a1", "w");
            const row = insertAgent(env.db, {
              name: "a1",
              workstream: "w",
              paneId: "%a1b",
              cli: "pi",
              spawner: "w/boss",
            });
            claimTask(env.db, "t1", { workstream: "w", agentName: "a1" }).catch((e: unknown) => {
              claimErr = e;
            });
            now = {
              agentId: row.incarnation,
              incarnation: swap === "respawn" ? "inc2" : "inc1",
            };
          }
          table.set("w/a1", { ...idle, ...now, runs: 1 });
        }
        await new Promise((res) => setTimeout(res, 2));
      },
    });
    expect(claimErr).toBeUndefined();
    return { r, first, now, watched };
  }

  for (const swap of ["respawn", "restart", "respawn-same-inc"] as const) {
    it(`${swap}: the new identity's run 1 CLOSE closes t1 in the same wait`, async () => {
      const { r, first, now, watched } = await scenario(swap);
      expect(r.event).toMatchObject({ kind: "closed", ref: { kind: "task", id: "t1" } });
      expect(r.timedOut).toBe(false);
      expect(r.exit).toBe(0);
      expect(getTask(env.db, "t1", "w")?.status).toBe("CLOSED");
      expect(settles()).toEqual([
        { agent_id: first.agentId, incarnation: first.incarnation, runs: 1 },
        { agent_id: now.agentId, incarnation: now.incarnation, runs: 1 },
      ]);
      // The new identity is watched from its own run 0, not the old latch's run.
      expect(watched.at(-1)).toEqual({ agentId: now.agentId, after: 0 });
    });
  }

  it("the same identity at the same run keeps the latch (no rewatch, no second settle)", async () => {
    await mkOwnedTask(env.db, "t1", "a1");
    env.db.prepare("UPDATE agents SET spawner = 'w/boss' WHERE name = 'a1'").run();
    const idle = {
      status: "needs_input",
      since: Date.now() - 60_000,
      source: "ctl",
      ctl: "ok",
      agentId: rowOf("a1"),
      incarnation: "inc1",
      runs: 1,
    } as const;
    const watched: number[] = [];
    const r = await waitForEvents(env.db, [taskRef("t1")], {
      ...base,
      timeoutMs: 120,
      mode: "all",
      status: "CLOSED",
      callers: ["w/boss"],
      stuckAfterMs: 1000,
      onStall: "warn",
      ...scriptedAgents(new Map([["w/a1", idle]])),
      watchAgent: async (ref: { afterRuns?: number }) => {
        watched.push(ref.afterRuns ?? 0);
        const w = controllableWatch({ status: "busy" });
        w.settle({ ...idle, settled: true, lastText: MALFORMED });
        return { ...w.handle, afterRuns: ref.afterRuns ?? 0 };
      },
    });
    expect(r.timedOut).toBe(true);
    expect(watched).toEqual([0]);
    expect(settles()).toHaveLength(1);
  });
});

describe("delivery re-reads the cursor in its transaction (fix_latch_identity P2a)", () => {
  it("an event another process consumed after this wait's snapshot is skipped: the next is returned", async () => {
    const d1 = mkDelegate(env.db, "pi:s");
    const d2 = mkDelegate(env.db, "pi:s");
    answer(env.db, d1);
    answer(env.db, d2);
    const other: Db = openDb({ path: join(env.dir, "mu.db") });
    let theirs: string | undefined;
    try {
      let once = false;
      const mine = await waitForEvents(env.db, [], {
        ...base,
        callers: ["pi:s"],
        timeoutMs: 500,
        // Process B runs between A's cursor snapshot and A's selection.
        beforePoll: async () => {
          if (once) return;
          once = true;
          const b = await waitForEvents(other, [], { ...base, callers: ["pi:s"], timeoutMs: 200 });
          theirs = b.event.ref?.id;
        },
      });
      expect(theirs).toBe(d1);
      expect(mine.event).toMatchObject({ kind: "delegate", ref: { id: d2 } });
      expect(mine.superseded).toBeUndefined();
    } finally {
      other.close();
    }
  });
});

describe("a stall is logged once per (agentId, incarnation, runs) (fix_latch_identity P2b)", () => {
  const stallLogs = (): number =>
    (
      env.db.prepare("SELECT COUNT(*) AS n FROM ops WHERE intent = 'agent.stall'").get() as {
        n: number;
      }
    ).n;

  it("fresh waits on an unchanged stall log nothing new; a later run logs once more", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    const reading = {
      status: "needs_input",
      since: Date.now() - 600_000,
      source: "ctl",
      ctl: "ok",
      incarnation: "inc",
      agentId: rowOf("w1"),
      runs: 2,
    } as const;
    const table = new Map<string, AgentReading>([["w/w1", reading]]);
    const opts = { ...base, callers: [], stuckAfterMs: 1000, ...scriptedAgents(table) };
    for (let i = 0; i < 2; i++) {
      const r = await waitForEvents(env.db, [taskRef("t1")], opts);
      expect(r.event.kind).toBe("stall");
    }
    expect(stallLogs()).toBe(1);
    table.set("w/w1", { ...reading, runs: 3, since: Date.now() - 300_000 });
    for (let i = 0; i < 2; i++) await waitForEvents(env.db, [taskRef("t1")], opts);
    expect(stallLogs()).toBe(2);
  });
});
