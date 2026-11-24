// A fork killed by a timeout skips afterEach, so a test's mkdtemp dir would stay
// in $TMPDIR. _setup.ts points TMPDIR into the run's server root, which
// globalSetup removes.

import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("scratch dir", () => {
  it("os.tmpdir() lies under the run's server root and stays short enough for a unix socket", () => {
    const root = process.env.TMUX_TMPDIR ?? "";
    expect(root).toMatch(/\/mus-/);
    expect(tmpdir().startsWith(`${root}/`)).toBe(true);
    // macOS caps a unix socket path at 104 bytes: mkdtemp dir + a socket name must fit.
    expect(Buffer.byteLength(tmpdir())).toBeLessThan(40);
  });
});
