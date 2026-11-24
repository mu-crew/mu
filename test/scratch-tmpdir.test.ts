// A fork killed by a timeout skips afterEach. Its scratch must be inside
// the same short root the run's watchdog owns.

import { tmpdir } from "node:os";
import { describe, expect, inject, it } from "vitest";
import { RUN_ROOT_KEY } from "./_run-root.js";

describe("scratch dir", () => {
  it("os.tmpdir() lies under the run's server root and stays short enough for a unix socket", () => {
    const root = inject(RUN_ROOT_KEY);
    expect(root).toMatch(/^\/tmp\/mus-[^/]+$/);
    expect(process.env.TMUX_TMPDIR).toBe(root);
    expect(tmpdir().startsWith(`${root}/`)).toBe(true);
    // macOS caps a unix socket path at 104 bytes: mkdtemp dir + a socket name must fit.
    expect(Buffer.byteLength(tmpdir())).toBeLessThan(40);
  });
});
