// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NextCase } from "../../tools/eval/nextstep.ts";
import { buildVariant, judgesHash } from "../../tools/eval/tournament-build.ts";
import { packGroup } from "../../tools/eval/tournament-design.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-tourn-int-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

const write = (root: string, files: Record<string, string>): void => {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), t);
  }
};
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();
const repo = (files: Record<string, string>): string => {
  const r = join(dir, "repo");
  mkdirSync(r);
  git(r, "init", "-q", "-b", "main");
  write(r, files);
  git(r, "add", "-A");
  git(r, "commit", "-q", "-m", "base");
  return r;
};

describe("judgesHash", () => {
  it("covers tools/eval and test/eval/fixtures in the working tree, not candidates or src", () => {
    const r = repo({
      "tools/eval/a.ts": "1",
      "test/eval/fixtures/f.json": "{}",
      "src/x.ts": "x",
      ".gitignore": "tools/eval/candidates/\n",
    });
    const h = judgesHash(r);
    expect(h.files.sort()).toEqual(["test/eval/fixtures/f.json", "tools/eval/a.ts"]);
    write(r, { "tools/eval/candidates/c1_wait/v.patch": "p", "src/x.ts": "y" });
    expect(judgesHash(r).hash).toBe(h.hash);
    write(r, { "tools/eval/a.ts": "2" });
    const h2 = judgesHash(r).hash;
    expect(h2).not.toBe(h.hash);
    write(r, { "test/eval/fixtures/f.json": "[]" });
    expect(judgesHash(r).hash).not.toBe(h2);
  });
});

const NO_CASES: NextCase[] = [];

describe("pack", () => {
  const files = {
    "src/a.ts": "export const a = 1;\n",
    "skills/mu/SKILL.md": "# mu\n",
    "tools/eval/main.ts": "x",
    "test/eval/x.test.ts": "x",
    "docs/eval/r.md": "x",
    "docs/history/h.md": "x",
    "docs/specs/2026-11-07-hill-r2-tournament.md": "x",
    "CHANGELOG.md": "x",
    "docs/VISION.md": "pillars\nThe eval harness (tools/eval/) holds the\nmore\n",
    "package.json": JSON.stringify({ scripts: { eval: "node tools/eval/main.ts", build: "tsup" } }),
  };

  it("exports base as a fresh repo without the eval rig, scrubbed, with BRIEF.md and node_modules", () => {
    const r = repo(files);
    const nm = join(dir, "surface");
    write(nm, { "node_modules/dep/index.js": "x" });
    const { dir: pack } = packGroup({
      repo: r,
      baseSha: git(r, "rev-parse", "HEAD"),
      group: "c1_wait",
      briefSrc: "Most waits were filtered, 304 of 430.",
      cases: NO_CASES,
      nodeModulesFrom: nm,
      packsDir: join(dir, "packs"),
    });
    for (const d of [
      "tools/eval",
      "test/eval",
      "docs/eval",
      "docs/history",
      "CHANGELOG.md",
      "docs/specs/2026-11-07-hill-r2-tournament.md",
    ])
      expect(existsSync(join(pack, d))).toBe(false);
    expect(readFileSync(join(pack, "docs/VISION.md"), "utf8")).toBe("pillars\nmore\n");
    expect(JSON.parse(readFileSync(join(pack, "package.json"), "utf8")).scripts).toEqual({
      build: "tsup",
    });
    expect(readFileSync(join(pack, "BRIEF.md"), "utf8")).toContain("304 of 430");
    expect(git(pack, "rev-list", "--count", "HEAD")).toBe("1");
    expect(existsSync(join(pack, "node_modules/dep/index.js"))).toBe(true);
    expect(git(pack, "status", "--porcelain")).toBe("");
  });

  it("refuses a bad BRIEF.md and a pack that still carries denied text", () => {
    const r = repo({ ...files, "src/b.ts": 'const p = "tools/eval";\n' });
    const o = {
      repo: r,
      baseSha: git(r, "rev-parse", "HEAD"),
      group: "c1_wait" as const,
      cases: NO_CASES,
      nodeModulesFrom: dir,
      packsDir: join(dir, "packs"),
    };
    expect(() => packGroup({ ...o, briefSrc: "```\nmu wait\n```" })).toThrow(/fenced code block/);
    expect(() => packGroup({ ...o, briefSrc: "ok" })).toThrow(/src\/b\.ts/);
  });
});

describe("buildVariant", () => {
  it("applies the patch to a copy, builds, stamps base+patch, and reports a patch that does not apply", () => {
    const base = join(dir, "base");
    write(base, {
      "package.json": JSON.stringify({ scripts: { build: "node -e 0" } }),
      "dist/cli.js": "process.exit(0)\n",
      "src/a.ts": "export const a = 'one';\n",
    });
    const patch = join(dir, "v.patch");
    writeFileSync(
      patch,
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 'one';\n+export const a = 'two';\n",
    );
    const out = join(dir, "hill2-v");
    const b = buildVariant(base, "abc", "v", patch, out);
    expect(b.built).toEqual({ ok: true });
    expect(b.helpExit).toBe(0);
    expect(readFileSync(join(out, "src/a.ts"), "utf8")).toContain("two");
    expect(readFileSync(join(base, "src/a.ts"), "utf8")).toContain("one");
    expect(readFileSync(join(out, ".ref"), "utf8").trim()).toMatch(/^abc\+[0-9a-f]{12}$/);
    writeFileSync(patch, readFileSync(patch, "utf8").replace("'one'", "'zero'"));
    const bad = buildVariant(base, "abc", "v", patch, out);
    expect(bad.built.ok).toBe(false);
    expect(bad.built.why).toMatch(/git apply --check/);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
