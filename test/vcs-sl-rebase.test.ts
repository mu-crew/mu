// slBackend.rebaseTo with a mocked `sl` (f_vcs_sl_rebase_swallow).
// A failed rebase with no unresolved files used to be swallowed and
// reported as success; it must be rethrown, as the git backend does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  calls: [] as string[][],
  rebaseError: null as Error | null,
  unresolved: "",
}));

vi.mock("../src/vcs/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs/helpers.js")>();
  return {
    ...actual,
    run: vi.fn(async (_bin: string, args: readonly string[]) => {
      fake.calls.push([...args]);
      if (args[0] === "status") return "";
      if (args.includes("rebase") && args.includes("-d")) {
        if (fake.rebaseError) throw fake.rebaseError;
        return "";
      }
      if (args[0] === "resolve") return fake.unresolved;
      if (args[0] === "log" && args[2] === "last(main)") return "a".repeat(40);
      if (args[0] === "log") return "work\n";
      return "";
    }),
  };
});

const { slBackend, WorkspaceConflictError } = await import("../src/vcs.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-sl-rebase-"));
  fake.calls = [];
  fake.rebaseError = null;
  fake.unresolved = "";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("slBackend.rebaseTo", () => {
  it("rethrows a non-conflict rebase failure", async () => {
    fake.rebaseError = new Error("vcs sl rebase failed: unknown revision 'nope'");
    await expect(slBackend.rebaseTo(dir, "main")).rejects.toThrow(/unknown revision/);
  });

  it("aborts and throws WorkspaceConflictError on unresolved files", async () => {
    fake.rebaseError = new Error("vcs sl rebase failed: exit 1");
    fake.unresolved = "U a.txt\nR b.txt";
    const err = await slBackend.rebaseTo(dir, "main").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceConflictError);
    expect((err as InstanceType<typeof WorkspaceConflictError>).conflicts).toEqual(["a.txt"]);
    expect((err as InstanceType<typeof WorkspaceConflictError>).aborted).toBe(true);
    expect(fake.calls).toContainEqual(["rebase", "--abort"]);
  });

  it("returns the replayed subjects and the new fork point on success", async () => {
    const r = await slBackend.rebaseTo(dir, "main");
    expect(r).toEqual({
      fromRef: "main",
      parentRef: "a".repeat(40),
      replayed: ["work"],
      conflicts: [],
    });
  });
});
