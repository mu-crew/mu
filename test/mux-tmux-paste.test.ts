// tmux's paste and keys (the `hooks` channel's delivery, spec D4): the exact
// tmux calls, in order, against a recording executor.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmuxBackend } from "../src/mux.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { fakePane } from "./_mux.js";
import { withServerIdentity } from "./_verbs-mock.js";

let calls: string[][];
let fail: string | undefined;

beforeEach(() => {
  calls = [];
  fail = undefined;
  setSleepForTests(async () => {});
  setTmuxExecutor(
    withServerIdentity(async (args) => {
      calls.push([...args]);
      return args[0] === fail
        ? { stdout: "", stderr: "boom", exitCode: 1 }
        : { stdout: "", stderr: "", exitCode: 0 };
    }),
  );
});
afterEach(() => {
  resetTmuxExecutor();
  resetSleep();
});

const paste = (text: string, clearKey?: string | null) => {
  if (!tmuxBackend.pasteToPane) throw new Error("tmux has no pasteToPane");
  return tmuxBackend.pasteToPane(fakePane("%7"), text, clearKey === undefined ? {} : { clearKey });
};

describe("tmux pasteToPane", () => {
  it("clears the input line, pastes one bracketed buffer that the paste deletes, then submits", async () => {
    await paste("two\nlines", "C-u");
    const buffer = calls[1]?.[2] ?? "";
    expect(buffer).toMatch(/^mu-paste-/);
    expect(calls).toEqual([
      ["send-keys", "-t", "%7", "C-u"],
      ["set-buffer", "-b", buffer, "--", "two\nlines"],
      ["paste-buffer", "-p", "-d", "-b", buffer, "-t", "%7"],
      ["send-keys", "-t", "%7", "Enter"],
    ]);
  });

  it("no clear key, no clear; an empty text is just the Enter", async () => {
    await paste("", null);
    expect(calls).toEqual([["send-keys", "-t", "%7", "Enter"]]);
  });

  it("a long text is appended in chunks, never splitting a character", async () => {
    const text = "é😀".repeat(3000);
    await paste(text);
    const sets = calls.filter((c) => c[0] === "set-buffer");
    expect(sets.length).toBeGreaterThan(2);
    expect(sets[0]).not.toContain("-a");
    expect(sets.slice(1).every((c) => c[1] === "-a")).toBe(true);
    expect(sets.map((c) => c.at(-1)).join("")).toBe(text);
    // Each command stays well inside tmux's 16 KiB message.
    expect(Math.max(...sets.map((c) => Buffer.byteLength(c.at(-1) ?? "")))).toBeLessThanOrEqual(
      8192,
    );
  });

  it("a failed paste deletes its buffer and throws, and never submits", async () => {
    fail = "paste-buffer";
    await expect(paste("hello", "C-u")).rejects.toThrow(/boom/);
    const buffer = calls.find((c) => c[0] === "set-buffer")?.[2];
    expect(calls.at(-1)).toEqual(["delete-buffer", "-b", buffer]);
    expect(calls.some((c) => c.includes("Enter"))).toBe(false);
  });

  it("refuses a pane id that is not tmux's", async () => {
    await expect(
      tmuxBackend.pasteToPane?.({ kind: "native", paneId: "w1:p1" }, "x"),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("tmux sendKeys", () => {
  it("named keys as keys, text as literal, both after --", async () => {
    await tmuxBackend.sendKeys?.(fakePane("%7"), ["Escape"]);
    await tmuxBackend.sendKeys?.(fakePane("%7"), ["-1"], { literal: true });
    expect(calls).toEqual([
      ["send-keys", "-t", "%7", "--", "Escape"],
      ["send-keys", "-t", "%7", "-l", "--", "-1"],
    ]);
  });
});
