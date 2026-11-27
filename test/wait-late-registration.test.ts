// A caller with no registration when its wait starts can gain refs during the wait (its
// spawned worker discovered, a concurrent producer). Delivering such a ref must still drop it
// from the registration under a generation, not only mark it consumed
// (medium_mu_core_waitforevents_leaks_wait). Real SQLite, real waitForEvents.

import { describe, expect, it } from "vitest";
import { closeTask } from "../src/tasks.js";
import { type WaitResult, waitForEvents } from "../src/wait.js";
import { readWaitRegistration, registerOwnedWait } from "../src/wait-registration.js";
import { mkOwnedTask, mkTask, taskRef, useWaitDb } from "./_wait-fixtures.js";

const env = useWaitDb();

describe("a registration that appears during the wait", () => {
  it("a discovered worker's task, delivered, leaves the registration", async () => {
    await mkOwnedTask(env.db, "t1", "w1");
    env.db.prepare("UPDATE agents SET spawner = 'pi:orch' WHERE name = 'w1'").run();
    expect(readWaitRegistration(env.db, "pi:orch")).toBeUndefined();
    let n = 0;
    const r = await waitForEvents(env.db, [], {
      callers: ["pi:orch"],
      sync: false,
      pollMs: 1,
      timeoutMs: 1000,
      readAgents: async () => new Map([["w/w1", { status: "busy" }]]),
      sleep: async () => {
        if (++n === 2) closeTask(env.db, "t1", { workstream: "w", evidence: "e" });
      },
    });
    expect(r.event).toMatchObject({ kind: "closed", ref: { kind: "task", id: "t1" } });
    const reg = readWaitRegistration(env.db, "pi:orch");
    expect(reg?.refs.map((x) => `${x.kind}:${x.id}`)).not.toContain("task:t1");
    expect(reg?.generation).toBeGreaterThan(0);
  });
});

describe("an older wait that owed nothing never supersedes a newer one (both lanes)", () => {
  for (const lane of ["shell", "settle"] as const) {
    it(`${lane} lane: W1 (no registration) is older, a producer registers, W2 begins: W2 delivers`, async () => {
      mkTask(env.db, "t0");
      mkTask(env.db, "t1");
      const CALLER = "pi:orch";
      const common = {
        callers: [CALLER],
        sync: false,
        pollMs: 1,
        timeoutMs: 2000,
        ...(lane === "settle" ? { settleLane: true } : {}),
      } as const;
      expect(readWaitRegistration(env.db, CALLER)).toBeUndefined();
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let w2: Promise<WaitResult> | undefined;
      let n1 = 0;
      let n2 = 0;
      const w1 = await waitForEvents(env.db, [taskRef("t0")], {
        ...common,
        sleep: async () => {
          n1++;
          if (n1 === 1) {
            // A producer registers t1 for the caller, then a newer wait W2 begins.
            registerOwnedWait(env.db, CALLER, [{ kind: "task", workstream: "w", id: "t1" }]);
            w2 = waitForEvents(env.db, [], {
              ...common,
              sleep: async () => {
                if (++n2 === 1) await gate;
                else closeTask(env.db, "t1", { workstream: "w", evidence: "e" });
              },
            });
            await new Promise((r) => setTimeout(r, 5));
          } else if (n1 === 2) {
            // W1 has run a poll after W2 began: now let W2 finish, then close W1's own ref.
            release();
            await w2;
            closeTask(env.db, "t0", { workstream: "w", evidence: "e" });
          }
        },
      });
      expect(w1.event).toMatchObject({ kind: "closed", ref: { id: "t0" } });
      const r2 = await (w2 as Promise<WaitResult>);
      expect(r2.superseded).toBeUndefined();
      expect(r2.event).toMatchObject({ kind: "closed", ref: { id: "t1" } });
      expect(r2.delivered.map((d) => d.id)).toContain("t1");
      expect(readWaitRegistration(env.db, CALLER)?.refs ?? []).toEqual([]);
    });
  }

  it("the deadline right after a mid-wait registration still ends the claimed generation", async () => {
    mkTask(env.db, "t0");
    mkTask(env.db, "t1");
    const CALLER = "pi:orch";
    const r = await waitForEvents(env.db, [taskRef("t0")], {
      callers: [CALLER],
      sync: false,
      pollMs: 1,
      timeoutMs: 5,
      // Registered mid-wait, then the deadline passes before another poll.
      sleep: async () => {
        registerOwnedWait(env.db, CALLER, [{ kind: "task", workstream: "w", id: "t1" }]);
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    expect(r.event.kind).toBe("heartbeat");
    expect(r.superseded).toBeUndefined();
    const reg = readWaitRegistration(env.db, CALLER);
    // The generation was claimed and re-armed; the ref registered mid-wait stays owed.
    expect(reg).toMatchObject({ state: "armed", generation: 1 });
    expect(reg?.refs.map((x) => x.id)).toEqual(["t1"]);
  });
});
