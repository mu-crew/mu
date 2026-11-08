import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSurface, SURFACES_DIR, stripRig, surfaceDir } from "../../tools/eval/surface.ts";

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

describe("stripRig", () => {
  it("deletes the rig (tools, test, eval docs and specs) from a surface and keeps the product", () => {
    const dir = mkdtempSync(join(tmpdir(), "surface-strip-"));
    try {
      const keep = ["dist/cli.js", "skills/mu/SKILL.md", "docs/guide/README.md", "src/cli.ts"];
      const gone = [
        "tools/eval/scenarios/wrong_id.ts",
        "test/eval/check.test.ts",
        "docs/eval/hill-r2/baseline.md",
        "docs/specs/2026-11-07-hill-r2-tournament.md",
        "docs/history/x.md",
      ];
      for (const f of [...keep, ...gone]) {
        mkdirSync(join(dir, f, ".."), { recursive: true });
        writeFileSync(join(dir, f), "x");
      }
      stripRig(dir);
      expect(keep.filter((f) => !existsSync(join(dir, f)))).toEqual([]);
      expect(gone.filter((f) => existsSync(join(dir, f)))).toEqual([]);
      expect(existsSync(join(dir, "tools"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
