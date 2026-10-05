// rebaseTo reports nothing replayed when the rebase is a no-op
// (f_vcs_replayed_noop). It used to list every commit above the fork
// point, so `mu workspace refresh` on an up-to-date workspace printed
// "Refreshed ... (1 commit replayed)". `run` and `exec` are mocked:
// the head id changes only when `fake.moves` is set; the real git path
// is in workspace-refresh.integration.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ moves: false, head: "h0" }));

vi.mock("../src/vcs/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs/helpers.js")>();
  return {
    ...actual,
    exec: vi.fn(async () => ({ stdout: "", stderr: "" })),
    run: vi.fn(async (bin: string, args: readonly string[]) => {
      const a = args.join(" ");
      const rebase =
        bin === "git" ? a.startsWith("-c") && args.includes("rebase") : a.includes("rebase -d");
      if (rebase) {
        if (fake.moves) fake.head = "h1";
        return "";
      }
      if (bin === "git") {
        if (a === "rev-parse HEAD") return fake.head;
        if (a.startsWith("rev-parse")) return "target";
        if (a.startsWith("merge-base")) throw new Error("exit 1");
        if (a.startsWith("log")) return "work";
        return "";
      }
      if (bin === "sl") {
        if (a === "log -r . --template {node}") return fake.head;
        if (a.startsWith("log -r last(")) return "target";
        if (a.includes("{desc|firstline}")) return "work\n";
        return "";
      }
      // jj
      if (a.includes("-r @ ") && a.includes("commit_id")) return fake.head;
      if (a.includes("conflict()")) return "";
      if (a.includes("description.first_line()")) return "work\n";
      if (a.startsWith("log -r main ")) return "target\n";
      return "";
    }),
  };
});

const { gitBackend, jjBackend, slBackend } = await import("../src/vcs.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-rebase-replayed-"));
  fake.moves = false;
  fake.head = "h0";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ["git", gitBackend],
  ["sl", slBackend],
  ["jj", jjBackend],
] as const)("%s rebaseTo replayed", (_name, backend) => {
  it("is empty when the rebase leaves the head unchanged", async () => {
    const r = await backend.rebaseTo(dir, "main");
    expect(r.replayed).toEqual([]);
  });

  it("lists the commits above the fork point when the rebase moved them", async () => {
    fake.moves = true;
    const r = await backend.rebaseTo(dir, "main");
    expect(r.replayed).toEqual(["work"]);
  });
});
