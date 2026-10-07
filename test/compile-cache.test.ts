// The bin's compile cache must never stall or break the CLI when its
// directory cannot be created (f_no_compile_cache follow-up). Node's own
// recursive mkdir spun forever on /proc paths; the bounded helper fails.

import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableCompileCacheIn, ensureDirBounded } from "../src/compile-cache.js";

describe("enableCompileCacheIn", () => {
  let root: string;
  let calls: string[];
  const spy = (dir: string) => {
    calls.push(dir);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mu-cc-"));
    calls = [];
  });

  afterEach(() => {
    try {
      chmodSync(root, 0o755);
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it("creates nested missing dirs and enables the cache", () => {
    const dir = join(root, "a", "b", "compile-cache");
    expect(enableCompileCacheIn(dir, spy)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(calls).toEqual([dir]);
  });

  it("skips the cache when the parent is not writable", () => {
    chmodSync(root, 0o555);
    const dir = join(root, "state", "compile-cache");
    expect(enableCompileCacheIn(dir, spy)).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("skips the cache when a path component is a file", () => {
    expect(ensureDirBounded(join(__filename, "compile-cache"))).toBe(false);
  });

  it.runIf(existsSync("/proc/self"))("returns promptly for a dir under /proc", () => {
    const t0 = Date.now();
    expect(enableCompileCacheIn("/proc/mu-nope/compile-cache", spy)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(calls).toEqual([]);
  });

  it("is a no-op on Node without enableCompileCache", () => {
    expect(enableCompileCacheIn(join(root, "cc"), null)).toBe(false);
  });

  it("swallows a throwing enableCompileCache", () => {
    const boom = () => {
      throw new Error("boom");
    };
    expect(enableCompileCacheIn(join(root, "cc"), boom)).toBe(false);
  });
});
