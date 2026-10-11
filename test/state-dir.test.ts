import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCacheDir } from "../src/state-dir.js";
import { withEnv } from "./_env.js";

describe("defaultCacheDir", () => {
  it("is $XDG_CACHE_HOME/mu when it is absolute", async () => {
    await withEnv("XDG_CACHE_HOME", "/x/cache", async () => {
      expect(defaultCacheDir()).toBe("/x/cache/mu");
    });
  });

  it("is ~/.cache/mu when XDG_CACHE_HOME is unset or relative", async () => {
    await withEnv("XDG_CACHE_HOME", undefined, async () => {
      expect(defaultCacheDir()).toBe(join(homedir(), ".cache", "mu"));
    });
    await withEnv("XDG_CACHE_HOME", "rel/cache", async () => {
      expect(defaultCacheDir()).toBe(join(homedir(), ".cache", "mu"));
    });
  });
});
