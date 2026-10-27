// What a resume still owes comes from what the real engine delivered as COMPLETED, never from the
// event's ref or a snapshot's `fired` (rr_r2_resume_drops_work). Real SQLite, real waitForEvents.

import { describe, expect, it } from "vitest";
import { owedRefs } from "../src/cli/wait-output.js";
import { closeTask } from "../src/tasks.js";
import { type AgentReading, type WaitRef, waitForEvents } from "../src/wait.js";
import { agentRef, mkAgent, mkTask, taskRef, useWaitDb } from "./_wait-fixtures.js";

const env = useWaitDb();
const dialog = new Map<string, AgentReading>([
  ["w/a", { status: "needs_permission", blocked: { kind: "confirm", since: 1 } as never }],
]);
const opts = (mode: "first" | "all") => ({
  callers: ["pi:r2"],
  mode,
  sync: false,
  pollMs: 1,
  timeoutMs: 30,
  readAgents: async () => dialog,
});
const ids = (refs: WaitRef[]) => refs.map((r) => r.id).sort();

describe("owedRefs from a real wait", () => {
  it("--first ending on an agent's dialog still owes the agent (the run is unfinished)", async () => {
    mkAgent(env.db, "a");
    const refs = [agentRef("a")];
    const r = await waitForEvents(env.db, refs, opts("first"));
    expect(r.event.kind).toBe("input");
    expect(ids(owedRefs(r, refs))).toEqual(["a"]);
  });

  it("--all ended early by a dialog still owes the closed target it did not consume", async () => {
    mkTask(env.db, "t");
    closeTask(env.db, "t", { workstream: "w", evidence: "e" });
    mkAgent(env.db, "a");
    const refs = [taskRef("t"), agentRef("a")];
    const r = await waitForEvents(env.db, refs, opts("all"));
    expect(r.event.kind).toBe("input");
    expect(ids(owedRefs(r, refs))).toEqual(["a", "t"]);
  });

  it("a delivered completion is dropped (--first closed task; --all every completed target)", async () => {
    mkTask(env.db, "t");
    mkTask(env.db, "u");
    closeTask(env.db, "t", { workstream: "w", evidence: "e" });
    const first = await waitForEvents(env.db, [taskRef("t"), taskRef("u")], {
      ...opts("first"),
      callers: [],
    });
    expect(ids(owedRefs(first, [taskRef("t"), taskRef("u")]))).toEqual(["u"]);
    closeTask(env.db, "u", { workstream: "w", evidence: "e" });
    const all = await waitForEvents(env.db, [taskRef("t"), taskRef("u")], {
      ...opts("all"),
      callers: [],
    });
    expect(owedRefs(all, [taskRef("t"), taskRef("u")])).toEqual([]);
  });
});
