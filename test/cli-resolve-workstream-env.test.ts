// resolveWorkstream: -w > the injected $MU_WORKSTREAM (only with
// $MU_MANAGED_AGENT=1, i.e. inside a mu-spawned pane) > a one-line error.
// $MU_SESSION and the mux session name never route: the mux is not even
// asked on the success paths. The managed-agent gate keeps a stale
// $MU_WORKSTREAM exported in a user shell from routing anything.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkstreamName, injectedIdentity, resolveWorkstream } from "../src/cli.js";
import { installMux, type MuxHarness } from "./_mux.js";

const KEYS = ["MU_SESSION", "MU_WORKSTREAM", "MU_MANAGED_AGENT", "MU_AGENT_NAME", "TMUX"] as const;

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

  it("-w beats the injected workstream; $MU_SESSION is ignored by both", async () => {
    process.env.MU_MANAGED_AGENT = "1";
    process.env.MU_WORKSTREAM = "agentws";
    process.env.MU_SESSION = "sess";
    expect(await resolveWorkstream()).toBe("agentws");
    expect(await resolveWorkstream("explicit")).toBe("explicit");
    expect(mux.calls).toEqual([]);
  });

  it("$MU_SESSION alone does not route: one-line error, session only a suggestion", async () => {
    process.env.MU_SESSION = "sess";
    await expect(resolveWorkstream()).rejects.toThrow(
      /^no workstream: pass -w <name> \(tmux session mu-fromtmux: -w fromtmux\)$/,
    );
  });

  it("a stale $MU_WORKSTREAM without $MU_MANAGED_AGENT does not route", async () => {
    process.env.MU_WORKSTREAM = "stale";
    await expect(resolveWorkstream()).rejects.toThrow(/^no workstream: pass -w <name>/);
  });

  it("the tmux session never routes, and an unreachable mux still gives the same error", async () => {
    mux.restore();
    mux = installMux("tmux", [["display-message", { stdout: "", stderr: "boom", exitCode: 1 }]]);
    await expect(resolveWorkstream()).rejects.toThrow(/^no workstream: pass -w <name>$/);
  });

  it("rejects an empty, blank or padded -w instead of trimming it into another workstream", async () => {
    for (const bad of ["", " ", "\t", " auth", "auth ", " auth "]) {
      await expect(resolveWorkstream(bad), JSON.stringify(bad)).rejects.toThrow(/-w\/--workstream/);
      expect(() => checkWorkstreamName(bad)).toThrow();
    }
    expect(checkWorkstreamName("auth")).toBe("auth");
  });

  it("injectedIdentity needs the managed gate, a name and a workstream", () => {
    process.env.MU_AGENT_NAME = "w-1";
    process.env.MU_WORKSTREAM = "ws";
    expect(injectedIdentity()).toBeUndefined();
    process.env.MU_MANAGED_AGENT = "1";
    expect(injectedIdentity()).toEqual({ name: "w-1", workstream: "ws" });
    process.env.MU_AGENT_NAME = "";
    expect(injectedIdentity()).toBeUndefined();
  });
});
