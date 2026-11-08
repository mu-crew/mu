// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installHooks, mergeMs } from "../../tools/eval/scenarios/fanout_gates.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// fanout_gates orders "f<n> merged" before the umbrella close from its post-commit/post-merge hook
// log. The hook stamped lines with `date +%s%3N`, which BSD date (macOS) prints as "<s>3N": no line
// parsed, every merge "never happened", and the golden failed on a mac.
describe("fanout_gates hook log", () => {
  it("stamps a commit on main with epoch ms that mergeMs reads, on GNU and BSD date alike", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-fanout-hooks-"));
    dirs.push(dir);
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir);
    const git = (...a: string[]): string =>
      execFileSync("git", ["-C", repoDir, ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    installHooks({ dir, repoDir });
    writeFileSync(join(repoDir, "a.txt"), "a\n");
    git("add", "a.txt");
    const before = Date.now();
    git("commit", "-q", "-m", "f1");
    const at = mergeMs({ dir }, "f1");
    expect(at).not.toBeNull();
    expect(at as number).toBeGreaterThanOrEqual(before - 1000);
    expect(at as number).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
