import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./_runCli.js";

describe("removed CLI surface stays removed", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-removed-surface-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("mu state --help omits --mission and -n/--lines", async () => {
    const { stdout, exitCode } = await runCli(["state", "--help"], dbPath);

    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toContain("--events <n>");
    expect(stdout).not.toContain("--mission");
    expect(stdout).not.toContain("--lines");
    expect(stdout).not.toContain("-n,");
  });

  it("mu agent list --help omits --all", async () => {
    const { stdout, exitCode } = await runCli(["agent", "list", "--help"], dbPath);

    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toContain("Usage: mu agent list");
    expect(stdout).not.toContain("--all");
  });

  it("the `mu workspace` namespace is gone: every old verb is an unknown command", async () => {
    for (const verb of [
      "list",
      "path",
      "free",
      "create",
      "recreate",
      "refresh",
      "commits",
      "orphans",
    ]) {
      const r = await runCli(["workspace", verb, "worker-1"], dbPath);
      expect(r.exitCode, `mu workspace ${verb} should not exist`).toBe(2);
      // No such top-level command: commander reports the stray words.
      expect(r.stderr.toLowerCase()).toMatch(/unknown command|too many arguments/);
      expect(r.stderr).toContain("workspace");
    }
    const { stdout } = await runCli(["--help"], dbPath);
    expect(stdout).not.toMatch(/^ {2}workspace\b/m);
  });

  it("the old workspace flags are unknown options; their replacements are listed", async () => {
    for (const argv of [
      ["agent", "spawn", "x", "--workspace"],
      ["agent", "spawn", "x", "--workspace-from", "main"],
      ["agent", "spawn", "x", "--workspace-project-root", "/tmp"],
      ["agent", "close", "x", "--discard-workspace"],
    ]) {
      const r = await runCli(argv, dbPath);
      expect(r.exitCode, argv.join(" ")).toBe(2);
      expect(r.stderr.toLowerCase()).toContain("unknown option");
    }
    const spawn = await runCli(["agent", "spawn", "--help"], dbPath);
    for (const flag of ["--worktree", "--from", "--root"]) expect(spawn.stdout).toContain(flag);
    const close = await runCli(["agent", "close", "--help"], dbPath);
    expect(close.stdout).toContain("--discard");
  });

  it("removed staleness and backend flags fail as unknown options", async () => {
    for (const argv of [
      ["task", "claim", "x", "--strict-staleness"],
      ["agent", "send", "x", "hi", "--strict-staleness"],
      ["agent", "spawn", "x", "--workspace-backend", "git"],
    ]) {
      const r = await runCli(argv, dbPath);
      expect(r.exitCode, argv.join(" ")).toBe(2);
      expect(r.stderr.toLowerCase()).toContain("unknown option");
    }
  });

  it("removed flags fail as unknown options", async () => {
    const mission = await runCli(["state", "--mission"], dbPath);
    expect(mission.exitCode).toBe(2);
    expect(mission.stderr.toLowerCase()).toContain("unknown option");
    expect(mission.stderr).toContain("--mission");

    const lines = await runCli(["state", "--lines", "5"], dbPath);
    expect(lines.exitCode).toBe(2);
    expect(lines.stderr.toLowerCase()).toContain("unknown option");
    expect(lines.stderr).toContain("--lines");

    const agentAll = await runCli(["agent", "list", "--all"], dbPath);
    expect(agentAll.exitCode).toBe(2);
    expect(agentAll.stderr.toLowerCase()).toContain("unknown option");
    expect(agentAll.stderr).toContain("--all");
  });
});
