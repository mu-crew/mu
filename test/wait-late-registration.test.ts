// A caller with no registration when its wait starts can gain refs during the wait (its
// spawned worker discovered, a concurrent producer). Delivering such a ref must still drop it
// from the registration under a generation, not only mark it consumed
// (medium_mu_core_waitforevents_leaks_wait). Real SQLite, real waitForEvents.

import { describe, expect, it } from "vitest";
import { closeTask } from "../src/tasks.js";
import { waitForEvents } from "../src/wait.js";
import { readWaitRegistration } from "../src/wait-registration.js";
import { mkOwnedTask, useWaitDb } from "./_wait-fixtures.js";

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
