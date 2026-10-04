// `mu state -w scratch` nudges about idle scratch helpers. The nudge must
// follow the live `idle` flag (computeAgentIdle), not the agent row's
// `updated_at`, which is only written at spawn: a busy helper spawned
// long ago is not idle.

import { describe, expect, it } from "vitest";
import type { LiveAgent } from "../src/agents.js";
import { scratchIdleNudge } from "../src/cli/state.js";

const longAgo = new Date(Date.now() - 3_600_000).toISOString();

function agent(name: string, state: LiveAgent["state"], idle: boolean): LiveAgent {
  return {
    name,
    workstreamName: "scratch",
    cli: "pi",
    paneId: "%1",
    role: "worker",
    tab: null,
    createdAt: longAgo,
    updatedAt: longAgo,
    state,
    source: "ctl",
    since: longAgo,
    ...(idle ? { idle: true } : {}),
  };
}

describe("scratchIdleNudge", () => {
  it("does not nudge a busy scratch agent spawned past the threshold", () => {
    expect(scratchIdleNudge("scratch", [agent("busy-1", "busy", false)])).toBeNull();
  });

  it("nudges an idle scratch agent past the threshold", () => {
    const nudge = scratchIdleNudge("scratch", [
      agent("busy-1", "busy", false),
      agent("idle-1", "needs_input", true),
    ]);
    expect(nudge).toContain("1 idle scratch agent(s): idle-1.");
    expect(nudge).toContain("mu agent close idle-1 -w scratch");
  });

  it("never nudges outside the scratch workstream", () => {
    expect(scratchIdleNudge("ws", [agent("idle-1", "needs_input", true)])).toBeNull();
  });
});
