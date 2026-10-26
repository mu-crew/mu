import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCacheDir, defaultStateDir } from "../src/state-dir.js";
import { withEnv } from "./_env.js";

// bug_tests_write_real_cache: fixture answers landed in the real
// ~/.cache/mu/delegate-answers because test/_setup.ts left XDG_* alone.

describe("test XDG isolation", () => {
  it("resolves the cache and state dirs under a temp root", async () => {
    const tmp = tmpdir();
    await withEnv("MU_STATE_DIR", undefined, async () => {
      expect(defaultCacheDir().startsWith(tmp)).toBe(true);
      expect(defaultStateDir().startsWith(tmp)).toBe(true);
    });
    expect(process.env.XDG_CONFIG_HOME?.startsWith(tmp)).toBe(true);
  });

  // The probe paths sit under a parent that does not exist, so a guard that
  // is missing fails these with ENOENT and still never creates a real file.
  const probe = (...parts: string[]) =>
    join(homedir(), ...parts, `no-such-dir-${process.pid}`, "x");

  it.each([
    [".cache", "mu"],
    [".local", "state", "mu-next"],
    [".local", "state", "mu"],
  ])("refuses sync and async writes under the real ~/%s", async (...parts) => {
    const p = probe(...parts);
    expect(() => writeFileSync(p, "x")).toThrow(/real mu dir/);
    await expect(writeFile(p, "x")).rejects.toThrow(/real mu dir/);
    await expect(mkdir(p, { recursive: true })).rejects.toThrow(/real mu dir/);
  });
});
