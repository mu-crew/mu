// runShow caps `show` output at SHOW_COMMIT_MAX_CHARS
// (f_vcs_showcommit_maxbuffer). Output past the exec buffer (2x the
// cap) used to surface as an error with empty text; it must clip.

import { describe, expect, it } from "vitest";
import { runShow } from "../src/vcs/helpers.js";
import { SHOW_COMMIT_MAX_CHARS } from "../src/vcs.js";

function printChars(n: number): string[] {
  return ["-e", `process.stdout.write("x".repeat(${n}))`];
}

describe("runShow", () => {
  it("returns small output unclipped", async () => {
    const r = await runShow(process.execPath, printChars(10));
    expect(r).toEqual({ text: "xxxxxxxxxx", truncated: false });
  });

  it("clips output between the cap and the exec buffer", async () => {
    const r = await runShow(process.execPath, printChars(SHOW_COMMIT_MAX_CHARS + 10));
    expect(r.error).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("x".repeat(SHOW_COMMIT_MAX_CHARS))).toBe(true);
    expect(r.text).toContain(`truncated at ${SHOW_COMMIT_MAX_CHARS} chars`);
  });

  it("clips output larger than the exec buffer instead of erroring", async () => {
    const r = await runShow(process.execPath, printChars(SHOW_COMMIT_MAX_CHARS * 5));
    expect(r.error).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("x".repeat(SHOW_COMMIT_MAX_CHARS))).toBe(true);
    expect(r.text).toContain(`truncated at ${SHOW_COMMIT_MAX_CHARS} chars`);
  });

  it("reports a failing command as an error", async () => {
    const r = await runShow(process.execPath, ["-e", "process.exit(3)"]);
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
    expect(r.error).toBeDefined();
  });
});
