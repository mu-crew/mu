// resolveWorkstream: -w > $MU_SESSION > $MU_WORKSTREAM (only with
// $MU_MANAGED_AGENT=1, i.e. inside a mu-spawned pane) > tmux session.
// The managed-agent gate keeps a stale $MU_WORKSTREAM exported in a
// user shell from overriding the tmux session (perf mux2).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkstream } from "../src/cli.js";
import { installMux, type MuxHarness } from "./_mux.js";

const KEYS = ["MU_SESSION", "MU_WORKSTREAM", "MU_MANAGED_AGENT", "TMUX"] as const;

describe("resolveWorkstream env ladder", () => {
  let mux: MuxHarness;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.TMUX = "/tmp/fake,1,0";
    mux = installMux("tmux", [["display-message", "mu-fromtmux\n"]]);
  });

  afterEach(() => {
    mux.restore();
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses $MU_WORKSTREAM in a managed agent pane without asking tmux", async () => {
    process.env.MU_MANAGED_AGENT = "1";
    process.env.MU_WORKSTREAM = "agentws";
    expect(await resolveWorkstream()).toBe("agentws");
    expect(mux.calls).toEqual([]);
  });

  it("$MU_SESSION beats $MU_WORKSTREAM, and -w beats both", async () => {
    process.env.MU_MANAGED_AGENT = "1";
    process.env.MU_WORKSTREAM = "agentws";
    process.env.MU_SESSION = "sess";
    expect(await resolveWorkstream()).toBe("sess");
    expect(await resolveWorkstream("explicit")).toBe("explicit");
  });

  it("ignores a stale $MU_WORKSTREAM without $MU_MANAGED_AGENT", async () => {
    process.env.MU_WORKSTREAM = "stale";
    expect(await resolveWorkstream()).toBe("fromtmux");
    expect(mux.calls.length).toBe(1);
  });
});
