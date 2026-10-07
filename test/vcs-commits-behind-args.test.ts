// The staleness probe behind `mu state` and the TUI slow tick
// (f_vcs_staleness_snapshot): jj must read with --ignore-working-copy
// (no working-copy snapshot, no new jj operation), and git must resolve
// its main ref once per repo per decorate call, not once per workspace.
// `run` and `exec` are mocked; real-VCS counts are covered in
// workspace-backends.integration.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ runs: [] as string[][], execs: [] as string[][] }));

vi.mock("../src/vcs/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vcs/helpers.js")>();
  return {
    ...actual,
    exec: vi.fn(async (bin: string, args: readonly string[]) => {
      fake.execs.push([bin, ...args]);
      return { stdout: "", stderr: "" };
    }),
    run: vi.fn(async (bin: string, args: readonly string[]) => {
      fake.runs.push([bin, ...args]);
      if (bin === "git") return "3";
      return "x\nx";
    }),
  };
});

const { jjBackend } = await import("../src/vcs.js");
const { decorateWithStaleness } = await import("../src/workspace/decorate.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-behind-args-"));
  fake.runs = [];
  fake.execs = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(path: string, backend: "git" | "jj", parentRef: string) {
  return {
    agentName: path,
    workstreamName: "w",
    backend,
    path,
    parentRef,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("jj commitsBehind", () => {
  it("reads with --ignore-working-copy and counts one line per commit", async () => {
    expect(await jjBackend.commitsBehind(dir, "abc")).toBe(2);
    expect(fake.runs).toEqual([
      [
        "jj",
        "log",
        "--ignore-working-copy",
        "-r",
        "abc..trunk()",
        "--no-graph",
        "--no-pager",
        "--color",
        "never",
        "--template",
        '"x\\n"',
      ],
    ]);
  });
});

describe("git commitsBehind main-ref resolution", () => {
  it("probes origin/HEAD once for worktrees of one repo", async () => {
    const main = join(dir, "main");
    mkdirSync(join(main, ".git", "worktrees", "a"), { recursive: true });
    mkdirSync(join(main, ".git", "worktrees", "b"), { recursive: true });
    const rows = ["a", "b"].map((n) => {
      const ws = join(dir, n);
      const gitDir = join(main, ".git", "worktrees", n);
      mkdirSync(ws);
      writeFileSync(join(ws, ".git"), `gitdir: ${gitDir}\n`);
      writeFileSync(join(gitDir, "commondir"), "../..\n");
      return row(ws, "git", `ref-${n}`);
    });
    rows.push(row(main, "git", "ref-main"));
    const out = await decorateWithStaleness(rows);
    expect(out.map((r) => r.commitsBehindMain)).toEqual([3, 3, 3]);
    expect(fake.execs).toEqual([
      ["git", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"],
    ]);
    expect(fake.runs.map((c) => c.slice(0, 3))).toEqual([
      ["git", "rev-list", "--count"],
      ["git", "rev-list", "--count"],
      ["git", "rev-list", "--count"],
    ]);
  });

  it("probes once per repo when rows span two repos", async () => {
    const rows = ["r1", "r2"].map((n) => {
      const ws = join(dir, n);
      mkdirSync(join(ws, ".git"), { recursive: true });
      return row(ws, "git", `ref-${n}`);
    });
    await decorateWithStaleness(rows);
    expect(fake.execs).toHaveLength(2);
  });
});
