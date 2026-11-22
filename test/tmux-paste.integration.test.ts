// tmux's paste against a real pane on the private test server (spec D4):
// the clear key erases what sat in the input line, and a multi-line text
// arrives whole and is submitted.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmuxBackend } from "../src/mux.js";
import { shellWord } from "../src/shell-quote.js";
import { pasteToPane, resetSleep, resetTmuxExecutor, sendKeys, tmux } from "../src/tmux.js";
import { pollUntil } from "./_env.js";
import { privatePane, tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;
const MULTILINE = "if x:\n\treturn 'é😀';\n\n  # \"café\" #{pane_id}\n    done \\\n\t$HOME ~\n";

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
    await tmuxBackend.pasteToPane?.(await privatePane(pane), "first line\nsecond line", {
      clearKey: "C-u",
    });
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

  it.each([
    { method: "paste", text: MULTILINE },
    { method: "long paste", text: MULTILINE.repeat(400) },
    { method: "literal keys", text: MULTILINE },
    {
      method: "literal keys (long shell snippet)",
      text: Array.from(
        { length: 210 },
        (_, i) => `\tprintf '%s\\n' 'row ${i}: the file is café.ts'; # row ${i}\n`,
      ).join(""),
    },
    // Both fit in a raw send-keys request but exceed tmux 3.6b's 16 KiB
    // limit once quoted for if-shell. The second also exercises astral Unicode.
    { method: "literal keys (long Unicode)", text: "'🧪';\t\n".repeat(1500) },
  ])("$method preserves the original bytes on a guarded send", async ({ method, text }) => {
    const dir = mkdtempSync(join(tmpdir(), "mu-tmux-bytes-"));
    try {
      const output = join(dir, "input");
      await tmux([
        "respawn-pane",
        "-k",
        "-t",
        pane,
        `stty raw -echo && exec cat > ${shellWord(output)}`,
      ]);
      await pollUntil(() => existsSync(output), { description: "raw input reader ready" });
      const ref = await privatePane(pane);
      const literal = method.startsWith("literal keys");
      const end = Buffer.from("[end of send]");
      const receive = async (offset: number): Promise<Buffer> => {
        await tmux(["send-keys", "-t", pane, "-l", "--", end.toString()]);
        let received = Buffer.alloc(0);
        await pollUntil(
          () => {
            received = readFileSync(output).subarray(offset);
            return received.subarray(-end.length).equals(end);
          },
          { description: "end marker received" },
        );
        return received.subarray(0, -end.length);
      };
      let offset = 0;
      const expected = Buffer.from(literal ? text : `${text.replaceAll("\n", "\r")}\r`);
      if (literal) {
        // Main sent literal keys directly in argv, with no newline translation
        // or submission. Exercise that path as the baseline on this binary.
        await tmux(["send-keys", "-t", pane, "-l", "--", text]);
        const baseline = await receive(0);
        expect(baseline.equals(expected)).toBe(true);
        offset = baseline.length + end.length;
        await sendKeys(ref, [text], { literal: true });
      } else {
        await pasteToPane(ref, text);
      }
      const received = await receive(offset);
      expect(received.length).toBe(expected.length);
      expect(received.equals(expected)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a text ending in ; or \\; arrives as written: tmux does not split on it", async () => {
    for (const text of ["fix the bug;", "a\\;", ";"]) {
      await tmuxBackend.pasteToPane?.(await privatePane(pane), text, { clearKey: "C-u" });
      await tmuxBackend.sendKeys?.(await privatePane(pane), [`k${text}`], { literal: true });
      await tmuxBackend.sendKeys?.(await privatePane(pane), ["Enter"]);
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
