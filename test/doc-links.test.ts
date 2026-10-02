// Every relative markdown link and #anchor in the docs must resolve.
// The checker lives in scripts/check-doc-links.mjs so it also runs bare
// (`node scripts/check-doc-links.mjs`); this test runs it on the repo and
// on a planted fixture, so the guard is proven able to fail.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-doc-links.mjs");

function runChecker(root: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("markdown links", () => {
  it("every relative link and anchor in the repo docs resolves", () => {
    const r = runChecker(ROOT);
    expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual([]);
    expect(r.status).toBe(0);
  });

  describe("the checker", () => {
    let dir = "";
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function fixture(files: Record<string, string>): string {
      dir = mkdtempSync(join(tmpdir(), "mu-doc-links-"));
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), body);
      }
      return dir;
    }

    it("names missing files and anchors, and ignores code and the excluded file", () => {
      const root = fixture({
        "README.md": [
          "# Top",
          "[ok](docs/A.md#mu-task-wait-exit-codes) [ok2](#top) [web](https://x.invalid/nope)",
          "[gone](docs/Missing.md) [bad](docs/A.md#nope)",
          "`[code](not/a/link.md)`",
          "```",
          "[fenced](not/a/link.md)",
          "```",
        ].join("\n"),
        "docs/A.md": "## `mu task wait`: exit codes\n## Dup\n## Dup\n[dup](#dup-1)\n",
        "docs/ORCHESTRATOR_TREES.md": "[ignored](nowhere.md)\n",
      });
      const r = runChecker(root);
      expect(r.status).toBe(1);
      expect(r.stdout.trim().split("\n")).toEqual([
        "README.md:3: docs/Missing.md (missing file)",
        "README.md:3: docs/A.md#nope (missing anchor)",
      ]);
    });
  });
});
