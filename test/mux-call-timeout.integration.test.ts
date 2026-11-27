// A wedged tmux or Rex server must not hang mu (or the strict lock it holds): every real
// backend call is bounded, and a timeout throws the backend's error. Fake binaries that
// never answer stand in for the wedged servers; no real tmux or Rex is touched.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RexError, rex } from "../src/mux/rex.js";
import { TmuxError, tmux } from "../src/mux/tmux.js";
import { setMuxCallTimeoutForTests } from "../src/mux/types.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-mux-timeout-"));
  for (const bin of ["tmux", "rex"]) {
    const p = join(dir, bin);
    writeFileSync(p, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(p, 0o755);
  }
  setMuxCallTimeoutForTests(200);
});

afterEach(() => {
  setMuxCallTimeoutForTests(undefined);
  try {
    rmFixtureDir(dir);
  } catch {}
});

describe("mux call bound", () => {
  it("a tmux that never answers throws TmuxError naming the timeout", async () => {
    await withEnv("PATH", `${dir}:${process.env.PATH ?? ""}`, async () => {
      const t0 = Date.now();
      const err = await tmux(["list-sessions"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TmuxError);
      expect(String((err as Error).message)).toMatch(/timed out after 200ms/);
      expect(Date.now() - t0).toBeLessThan(10_000);
    });
  });

  it("a rex that never answers throws RexError naming the timeout", async () => {
    await withEnv("REX_BIN_DIR", dir, async () => {
      const t0 = Date.now();
      const err = await rex(["version"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RexError);
      expect(String((err as Error).message)).toMatch(/timed out after 200ms/);
      expect(Date.now() - t0).toBeLessThan(10_000);
    });
  });
});
