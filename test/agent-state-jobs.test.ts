// The round-2 review's witnesses (plugins P1): an agent's mux reading on a
// backend that classifies its own panes (herdr, Rex) and on tmux decides the
// pane's presence through a job read (src/jobs/view.ts), never a mux probe of
// its own, and the readings are the ones those reads always gave.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetAgentStateCacheForTests,
  type StateAgentRef,
  UNKNOWN_REASON,
} from "../src/agent-state.js";
import { readAgentStates } from "../src/channels/index.js";
import * as view from "../src/jobs/view.js";
import { type MuxBackend, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";

vi.mock("../src/jobs/view.js", async (orig) => {
  const real = await orig<typeof import("../src/jobs/view.js")>();
  return {
    ...real,
    viewStatus: vi.fn(real.viewStatus),
    readTmuxViews: vi.fn(real.readTmuxViews),
  };
});

const agent: StateAgentRef = { name: "worker-1", workstreamName: "demo", paneId: "w1:p1" };
const key = "demo/worker-1";
const probes: string[] = [];

/** A classifying backend: every pane read is counted, so a probe outside src/jobs shows up as calls without job reads. */
function classifying(
  name: "herdr" | "rex",
  status: Awaited<ReturnType<NonNullable<MuxBackend["paneStatus"]>>>,
  alive: boolean,
): void {
  setMuxForTests({
    ...tmuxBackend,
    name,
    paneStatus: async () => {
      probes.push("paneStatus");
      return status;
    },
    paneAlive: async () => {
      probes.push("paneAlive");
      return alive;
    },
  });
}

beforeEach(() => {
  probes.length = 0;
  vi.mocked(view.viewStatus).mockClear();
  vi.mocked(view.readTmuxViews).mockClear();
  resetAgentStateCacheForTests();
});

afterEach(() => {
  resetTmuxExecutor();
  resetAgentStateCacheForTests();
  setMuxForTests(undefined);
});

describe("an agent's mux reading decides presence through a job read", () => {
  for (const name of ["herdr", "rex"] as const) {
    it(`${name}: a reported state is a present pane, read through viewStatus`, async () => {
      classifying(name, "busy", false);
      const r = (await readAgentStates([agent])).get(key);
      expect(r).toEqual({ state: "busy", source: name, since: null, alive: true });
      expect(view.viewStatus).toHaveBeenCalledTimes(1);
      expect(view.viewStatus).toHaveBeenCalledWith(agent.paneId, expect.anything());
      expect(probes).toEqual(["paneStatus"]);
    });

    it(`${name}: no reported state, then view presence decides, through viewStatus`, async () => {
      classifying(name, undefined, false);
      expect((await readAgentStates([agent])).get(key)).toEqual({
        state: "unknown",
        source: "none",
        since: null,
        alive: false,
        reason: UNKNOWN_REASON.paneGone,
      });
      classifying(name, undefined, true);
      expect((await readAgentStates([agent])).get(key)).toMatchObject({
        state: "unknown",
        source: name,
        alive: true,
        reason: `${name} reports no state`,
      });
      expect(view.viewStatus).toHaveBeenCalledTimes(2);
      expect(probes).toEqual(["paneStatus", "paneAlive", "paneStatus", "paneAlive"]);
    });
  }

  it("tmux: a pane missing from the one list-panes read is gone, through readTmuxViews", async () => {
    setMuxForTests(tmuxBackend);
    setTmuxExecutor(async () => ({ stdout: "%9\t\t\n", stderr: "", exitCode: 0 }));
    const r = (await readAgentStates([{ ...agent, paneId: "%1" }])).get(key);
    expect(r).toMatchObject({ state: "unknown", alive: false, reason: UNKNOWN_REASON.paneGone });
    expect(view.readTmuxViews).toHaveBeenCalledTimes(1);
  });
});
