// The @mu_* crew tags murmur reads (driver, workstream, role) must land on a
// real pane. The unit tests mock the executor, so they never saw tmux reject
// the guarded, ;-chained set-option that set them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSleep, resetTmuxExecutor, spawnAgent, tmux } from "../src/tmux.js";
import { tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;

describeIfTmux("spawnAgent tags a real pane", () => {
  let session: string;

  beforeEach(() => {
    resetTmuxExecutor();
    resetSleep();
    session = `mu-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    try {
      await tmux(["kill-session", "-t", `=${session}`]);
    } catch {}
  });

  it("sets @mu_agent, @mu_workstream and @mu_role", async () => {
    const pane = await spawnAgent({
      session,
      window: "w1",
      name: "w1",
      cli: "pi",
      command: "sleep 60",
      commandSource: "cli-key",
      env: {},
      paneOptions: { "@mu_agent": "w1", "@mu_workstream": "ws", "@mu_role": "worker" },
    });
    const tags = await tmux([
      "display-message",
      "-p",
      "-t",
      pane,
      "#{@mu_agent}|#{@mu_workstream}|#{@mu_role}",
    ]);
    expect(tags.trim()).toBe("w1|ws|worker");
  });
});
