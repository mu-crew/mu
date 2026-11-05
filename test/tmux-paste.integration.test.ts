// tmux's paste against a real pane on the private test server (spec D4):
// the clear key erases what sat in the input line, and a multi-line text
// arrives whole and is submitted.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmuxBackend } from "../src/mux.js";
import { resetSleep, resetTmuxExecutor, tmux } from "../src/tmux.js";
import { pollUntil } from "./_env.js";
import { tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;

describeIfTmux("tmux pasteToPane on a real pane", () => {
  let session: string;
  let pane: string;

  beforeEach(async () => {
    resetTmuxExecutor();
    resetSleep();
    session = `mu-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // `cat` in a canonical tty: the line discipline's kill character (C-u)
    // erases the pending line, and each submitted line is echoed back.
    pane = (
      await tmux(["new-session", "-d", "-s", session, "-P", "-F", "#{pane_id}", "cat"])
    ).trim();
  });

  afterEach(async () => {
    try {
      await tmux(["kill-session", "-t", `=${session}`]);
    } catch {}
  });

  it("clears the pending input, then the whole text arrives and is submitted", async () => {
    await tmux(["send-keys", "-t", pane, "-l", "--", "stale words"]);
    await tmuxBackend.pasteToPane?.(pane, "first line\nsecond line", { clearKey: "C-u" });
    let screen = "";
    await pollUntil(
      async () => {
        screen = await tmux(["capture-pane", "-p", "-t", pane]);
        // Echoed by the tty, then printed by cat: twice each once submitted.
        return screen.split("second line").length - 1 >= 2;
      },
      { description: "the pasted lines to be echoed back by cat" },
    );
    expect(screen).toContain("first line");
    expect(screen).not.toContain("stale words");
    expect(await tmux(["list-buffers", "-F", "#{buffer_name}"])).not.toContain("mu-paste-");
  });

  it("a text ending in ; or \\; arrives as written: tmux does not split on it", async () => {
    for (const text of ["fix the bug;", "a\\;", ";"]) {
      await tmuxBackend.pasteToPane?.(pane, text, { clearKey: "C-u" });
      await tmuxBackend.sendKeys?.(pane, [`k${text}`], { literal: true });
      await tmuxBackend.sendKeys?.(pane, ["Enter"]);
    }
    let lines: string[] = [];
    await pollUntil(
      async () => {
        lines = (await tmux(["capture-pane", "-p", "-t", pane])).split("\n");
        // Each line is echoed by the tty, then printed by cat.
        return lines.filter((l) => l === "k;").length >= 2;
      },
      { description: "every line to be echoed back by cat" },
    );
    for (const text of ["fix the bug;", "a\\;", ";"]) {
      expect(lines.filter((l) => l === text).length).toBeGreaterThanOrEqual(2);
      expect(lines.filter((l) => l === `k${text}`).length).toBeGreaterThanOrEqual(2);
    }
  });
});
