import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSurface, SURFACES_DIR, surfaceDir } from "../../tools/eval/surface.ts";

describe("surface names", () => {
  const bad = [
    "..",
    ".",
    "../x",
    "a/b",
    "a/../b",
    "/abs",
    "",
    "x..y",
    ".hidden",
    "a\\b",
    "a\0b",
    "V3",
    "a b",
  ];
  it.each(bad)("surfaceDir refuses %j", (name) => {
    expect(() => surfaceDir(name)).toThrow(/invalid surface name/);
  });

  it("surfaceDir never returns the cache root itself", () => {
    for (const n of [".", "", "./", "x/.."]) expect(() => surfaceDir(n)).toThrow();
  });

  it("surfaceDir accepts plain names inside the cache", () => {
    for (const n of ["3x", "v3.13.3", "next_build-1"]) {
      expect(surfaceDir(n)).toBe(join(SURFACES_DIR, n));
    }
  });

  it("prepareSurface refuses a traversal name before deleting anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "mu-eval-surface-"));
    try {
      const victim = join(root, "victim");
      mkdirSync(victim);
      writeFileSync(join(victim, "keep.txt"), "x");
      const name = relative(SURFACES_DIR, victim);
      expect(name).toContain("..");
      await expect(prepareSurface(name, "HEAD", process.cwd())).rejects.toThrow(
        /invalid surface name/,
      );
      await expect(prepareSurface(".", "HEAD", process.cwd())).rejects.toThrow(
        /invalid surface name/,
      );
      expect(existsSync(join(victim, "keep.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
