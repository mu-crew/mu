// `@mu_pending` lands on a real tmux pane, addressed the way a pi inside tmux
// addresses its own: `-S <socket from $TMUX>` and `$TMUX_PANE`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
    const socket = (await tmux(["display-message", "-p", "-t", pane, "#{socket_path}"])).trim();
    process.env.TMUX = `${socket},${process.pid},0`;
    process.env.TMUX_PANE = pane;
    setPaneOptionRunnerForTests(null);
  });

  afterEach(async () => {
    setPaneOptionRunnerForTests(async () => {});
    for (const k of ["TMUX", "TMUX_PANE"]) delete process.env[k];
    try {
      await tmux(["kill-session", "-t", `=${session}`]);
    } catch {}
  });

  const read = async () =>
    (await tmux(["display-message", "-p", "-t", pane, "[#{@mu_pending}]"])).trim();

  it("sets the count, follows a change, and unsets at 0 and on shutdown", async () => {
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
