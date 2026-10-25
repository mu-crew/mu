import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCacheDir, defaultStateDir } from "../src/state-dir.js";
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

describe("defaultStateDir", () => {
  it("is <state home>/mu-next, never 3.x's <state home>/mu", async () => {
    await withEnv("MU_STATE_DIR", undefined, async () => {
      await withEnv("XDG_STATE_HOME", "/x/state", async () => {
        expect(defaultStateDir()).toBe("/x/state/mu-next");
      });
      await withEnv("XDG_STATE_HOME", undefined, async () => {
        expect(defaultStateDir()).toBe(join(homedir(), ".local", "state", "mu-next"));
      });
    });
  });

  it("MU_STATE_DIR wins unchanged", async () => {
    await withEnv("MU_STATE_DIR", "/explicit/dir", async () => {
      expect(defaultStateDir()).toBe("/explicit/dir");
    });
  });
});
