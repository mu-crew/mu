// rebaseTo never moves the fork point backward
// (g_fix_vcs_git_parent_ancestor). When the old parent_ref already
// descends from the rebase target (a no-op refresh onto an older base,
// e.g. origin/main behind a workspace forked from local main), the old
// value is kept; otherwise the target becomes the fork point. `run` and
// `exec` are mocked; the real git path is in
// workspace-refresh.integration.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  /** Answer for every ancestry probe (git merge-base / sl & jj revsets). */
  descends: false,
  conflicts: "",
}));

vi.mock("../src/vcs/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs/helpers.js")>();
  return {
    ...actual,
    // git's dirty check and main-ref probe go through exec.
    exec: vi.fn(async () => ({ stdout: "", stderr: "" })),
    run: vi.fn(async (bin: string, args: readonly string[]) => {
      fake.calls.push([bin, ...args]);
      const a = args.join(" ");
      if (bin === "git") {
        if (a.startsWith("merge-base --is-ancestor")) {
          if (!fake.descends) throw new Error("exit 1");
          return "";
        }
        if (a.startsWith("rev-parse")) return "target";
        return "";
      }
      if (bin === "sl") {
        if (a.startsWith("log -r last(")) return "target";
        if (a.includes(":: & ::.")) return fake.descends ? "old" : "";
        return "";
      }
      // jj
      if (a.includes("conflict()")) return fake.conflicts;
      if (a.includes(":: & ::@")) return fake.descends ? "old\n" : "";
      if (a.startsWith("log -r main ")) return "target\n";
      return "";
    }),
  };
});

const { gitBackend, jjBackend, slBackend, WorkspaceConflictError } = await import("../src/vcs.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-rebase-parent-"));
  fake.calls = [];
  fake.descends = false;
  fake.conflicts = "";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ["git", gitBackend],
  ["sl", slBackend],
  ["jj", jjBackend],
] as const)("%s rebaseTo parentRef", (_name, backend) => {
  it("keeps the old fork point when it already descends from the target", async () => {
    fake.descends = true;
    const r = await backend.rebaseTo(dir, "main", "old");
    expect(r.parentRef).toBe("old");
  });

  it("advances to the target when the old fork point does not descend from it", async () => {
    const r = await backend.rebaseTo(dir, "main", "old");
    expect(r.parentRef).toBe("target");
  });

  it("uses the target when there is no previous fork point", async () => {
    fake.descends = true;
    const r = await backend.rebaseTo(dir, "main");
    expect(r.parentRef).toBe("target");
  });
});

describe("git rebaseTo ancestry probe", () => {
  it("checks old-descends-from-target and old-under-HEAD", async () => {
    fake.descends = true;
    await gitBackend.rebaseTo(dir, "main", "old");
    expect(fake.calls).toContainEqual(["git", "merge-base", "--is-ancestor", "target", "old"]);
    expect(fake.calls).toContainEqual(["git", "merge-base", "--is-ancestor", "old", "HEAD"]);
  });
});

describe("jj rebaseTo conflict", () => {
  it("throws without a fork point so the row keeps its base", async () => {
    fake.conflicts = "abc\n";
    const err = await jjBackend.rebaseTo(dir, "main", "old").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceConflictError);
    expect((err as InstanceType<typeof WorkspaceConflictError>).aborted).toBe(false);
    expect(err).not.toHaveProperty("parentRef");
  });
});
