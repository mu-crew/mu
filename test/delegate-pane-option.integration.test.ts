// `@mu_pending` lands on a real tmux pane, addressed the way a pi inside tmux
// addresses its own: `-S <socket from $TMUX>` and `$TMUX_PANE`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimPendingPaneOption,
  clearPendingPaneOption,
  reportPendingPaneOption,
  setPaneOptionRunnerForTests,
} from "../extension/delegate-pane-option.js";
import { resetTmuxExecutor, tmux } from "../src/tmux.js";
import { tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;

describeIfTmux("@mu_pending on a real pane", () => {
  let session: string;
  let pane: string;

  beforeEach(async () => {
    resetTmuxExecutor();
    session = `mu-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pane = (
      await tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "sleep 60"])
    ).trim();
    const [socket, pid] = (
      await tmux(["display-message", "-p", "-t", pane, "#{socket_path}\t#{pid}"])
    )
      .trim()
      .split("\t");
    // $TMUX as tmux writes it: the real server pid, which the claim checks.
    process.env.TMUX = `${socket},${pid},0`;
    process.env.TMUX_PANE = pane;
    const k = "TERM_PROGRAM";
    delete process.env[k];
    setPaneOptionRunnerForTests(null);
  });

  afterEach(async () => {
    setPaneOptionRunnerForTests(async () => undefined);
    for (const k of ["TMUX", "TMUX_PANE"]) delete process.env[k];
    try {
      await tmux(["kill-session", "-t", `=${session}`]);
    } catch {}
  });

  const read = async () =>
    (await tmux(["display-message", "-p", "-t", pane, "[#{@mu_pending}]"])).trim();

  it("unsets a stale value at start, sets the count, follows a change, and unsets at 0 and on shutdown", async () => {
    await tmux(["set-option", "-p", "-t", pane, "@mu_pending", "5"]);
    expect(await read()).toBe("[5]");
    await claimPendingPaneOption(true);
    expect(await read()).toBe("[]");
    await reportPendingPaneOption(2);
    expect(await read()).toBe("[2]");
    await reportPendingPaneOption(1);
    expect(await read()).toBe("[1]");
    await reportPendingPaneOption(0);
    expect(await read()).toBe("[]");
    await reportPendingPaneOption(3);
    expect(await read()).toBe("[3]");
    await clearPendingPaneOption();
    expect(await read()).toBe("[]");
    const shown = await tmux(["show-options", "-p", "-t", pane]);
    expect(shown).not.toContain("@mu_pending");
  });
});

describeIfTmux("@mu_pending on a server that is not $TMUX's", () => {
  it("writes nothing when the pid in $TMUX is not the server's", async () => {
    resetTmuxExecutor();
    const session = `mu-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pane = (
      await tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "sleep 60"])
    ).trim();
    try {
      const socket = (await tmux(["display-message", "-p", "-t", pane, "#{socket_path}"])).trim();
      process.env.TMUX = `${socket},1,0`;
      process.env.TMUX_PANE = pane;
      setPaneOptionRunnerForTests(null);
      await claimPendingPaneOption(true);
      await reportPendingPaneOption(4);
      expect((await tmux(["display-message", "-p", "-t", pane, "[#{@mu_pending}]"])).trim()).toBe(
        "[]",
      );
    } finally {
      setPaneOptionRunnerForTests(async () => undefined);
      for (const k of ["TMUX", "TMUX_PANE"]) delete process.env[k];
      try {
        await tmux(["kill-session", "-t", `=${session}`]);
      } catch {}
    }
  });
});
