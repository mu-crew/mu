// A send armed for an agent while a wait is delivering an EARLIER run of it stays owed
// (rr_r2_rearm_lost): endWait dropped the ref by key alone, so the newer run was never watched.
// Real SQLite and the real engine; the agent is scripted.

import { describe, expect, it } from "vitest";
import { type AgentReading, waitForEvents } from "../src/wait.js";
import {
  beginWait,
  endWait,
  readWaitRegistration,
  registerOwnedWait,
} from "../src/wait-registration.js";
import {
  agentRef,
  controllableWatch,
  mkAgent,
  scriptedAgents,
  useWaitDb,
} from "./_wait-fixtures.js";

const env = useWaitDb();
const CALLER = "pi:r2";
const ref = (b: { afterRuns: number }, agentId: number) => ({
  ...agentRef("a"),
  baseline: { ...b, incarnation: "i", agentId },
});

describe("a newer send is not erased by finishing the wait that delivered an older run", () => {
  it("the engine: onPicture re-arms the same agent at run 1 while run 1 is delivered", async () => {
    const id = mkAgent(env.db, "a");
    registerOwnedWait(env.db, CALLER, [ref({ afterRuns: 0 }, id)]);
    const idle: AgentReading = {
      status: "needs_input",
      incarnation: "i",
      runs: 1,
      agentId: id,
      settled: true,
      lastText: "ok",
    };
    let armed = false;
    await waitForEvents(env.db, [], {
      pollMs: 1,
      sync: false,
      timeoutMs: 500,
      callers: [CALLER],
      ...scriptedAgents(new Map([["w/a", idle]])),
      watchAgent: async () => {
        const w = controllableWatch({ status: "busy" });
        w.settle(idle);
        return { ...w.handle, afterRuns: 0 };
      },
      onPicture: () => {
        if (armed) return;
        armed = true;
        registerOwnedWait(env.db, CALLER, [ref({ afterRuns: 1 }, id)]);
      },
    });
    const reg = readWaitRegistration(env.db, CALLER);
    expect(reg?.refs).toHaveLength(1);
    // Run 1 is delivered: what is still owed counts from it.
    expect(Object.values(reg?.baselines ?? {})).toEqual([
      { afterRuns: 1, incarnation: "i", agentId: id },
    ]);
  });

  it("endWait: a delivered run above every armed fence drops the ref; one at or below the latest keeps it", () => {
    const id = mkAgent(env.db, "a");
    registerOwnedWait(env.db, CALLER, [ref({ afterRuns: 0 }, id)]);
    registerOwnedWait(env.db, CALLER, [ref({ afterRuns: 2 }, id)]);
    // Delivered run 2 covers fences 0 and... not the send armed at 2 (it starts run 3).
    let w = beginWait(env.db, CALLER);
    endWait(env.db, CALLER, w?.generation ?? -1, [{ ...agentRef("a"), runs: 2, incarnation: "i" }]);
    expect(readWaitRegistration(env.db, CALLER)?.refs).toHaveLength(1);
    w = beginWait(env.db, CALLER);
    endWait(env.db, CALLER, w?.generation ?? -1, [{ ...agentRef("a"), runs: 3, incarnation: "i" }]);
    expect(readWaitRegistration(env.db, CALLER)?.refs).toHaveLength(0);
  });

  it("endWait: a delivered run past the latest fence covers every send: the ref goes", () => {
    const id = mkAgent(env.db, "a");
    registerOwnedWait(env.db, CALLER, [ref({ afterRuns: 0 }, id)]);
    registerOwnedWait(env.db, CALLER, [ref({ afterRuns: 2 }, id)]);
    const w = beginWait(env.db, CALLER);
    endWait(env.db, CALLER, w?.generation ?? -1, [{ ...agentRef("a"), runs: 3, incarnation: "i" }]);
    expect(readWaitRegistration(env.db, CALLER)?.refs).toHaveLength(0);
  });
});
