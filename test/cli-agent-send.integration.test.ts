// CLI-level tests for `mu agent send` warning/refusing on stale workspaces.
//
// The staleness tests send to a non-pi agent, which only herdr can do
// (one atomic `agent prompt`), so they run against a mocked herdr.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { gitBackend } from "../src/vcs.js";
import { createWorkspace } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;
let calls: readonly (readonly string[])[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-send-stale-"));
  process.env.MU_STATE_DIR = join(tempDir, "state");
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  // A non-pi CLI: these tests are about staleness, and a pi agent would
  // need a control socket (see test/agent-transport.test.ts).
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "w1:p1", cli: "claude" });
  const seen: string[][] = [];
  calls = seen;
  setSleepForTests(async () => {});
  setTmuxExecutor(async (args) => {
    seen.push([...args]);
    return { stdout: "", stderr: "", exitCode: 0 };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    db.close();
  } catch {}
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

async function fakeWorkspaceBehind(behind: number): Promise<void> {
  const projectRoot = mkdtempSync(join(tempDir, "project-"));
  writeFileSync(join(projectRoot, "README"), "x\n");
  const row = await createWorkspace(db, {
    agent: "worker-1",
    workstream: "auth",
    projectRoot,
    backend: "none",
  });
  db.prepare("UPDATE vcs_workspaces SET backend = 'git', parent_ref = ? WHERE path = ?").run(
    "parent-worker-1",
    row.path,
  );
  vi.spyOn(gitBackend, "commitsBehind").mockImplementation(async () => behind);
}

describe("mu agent send workspace staleness", () => {
  let herdr: MuxHarness;
  beforeEach(() => {
    herdr = installMux("herdr", [["agent prompt", "{}"]]);
    calls = herdr.calls;
  });
  afterEach(() => herdr.restore());

  it("warns on a stale workspace, appends refresh nextStep, and still sends by default", async () => {
    await fakeWorkspaceBehind(12);
    const { exitCode, stdout, stderr, error } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toContain("WARN: worker-1 workspace is 12 commits behind main");
    expect(stdout).toContain("mu workspace refresh worker-1 -w auth");
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["agent prompt w1:p1"]);
  });

  it("includes staleness in JSON output", async () => {
    await fakeWorkspaceBehind(10);
    const { exitCode, stdout, stderr, error } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toContain("WARN: worker-1 workspace is 10 commits behind main");
    const out = JSON.parse(stdout) as {
      staleness: {
        agentName: string;
        workstreamName: string;
        commitsBehindMain: number | null;
        isStale: boolean;
      };
      nextSteps: { command: string }[];
    };
    expect(out.staleness).toEqual({
      agentName: "worker-1",
      workstreamName: "auth",
      commitsBehindMain: 10,
      isStale: true,
    });
    expect(out.nextSteps.some((s) => s.command === "mu workspace refresh worker-1 -w auth")).toBe(
      true,
    );
  });

  it("--strict-staleness refuses without sending", async () => {
    await fakeWorkspaceBehind(14);
    const { exitCode, stderr, error } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--strict-staleness", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr) as {
      error: string;
      message: string;
      nextSteps: { command: string }[];
    };
    expect(env.error).toBe("TaskClaimStaleWorkspaceError");
    expect(env.message).toContain("14 commits behind main");
    expect(env.nextSteps[0]?.command).toBe("mu workspace refresh worker-1 -w auth");
    expect(calls).toEqual([]);
  });

  it("skips agents without a workspace", async () => {
    const { exitCode, stdout, stderr, error } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    const out = JSON.parse(stdout) as { staleness: null; transport: string };
    expect(out.staleness).toBeNull();
    expect(out.transport).toBe("mux");
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["agent prompt w1:p1"]);
  });
});

describe("mu agent send to a pi agent", () => {
  beforeEach(() => {
    insertAgent(db, { name: "pi-1", workstream: "auth", paneId: "%2", cli: "pi" });
    // The pane is alive (paneExists echoes the id) but has no control
    // socket: the ctl-unreachable case, not a dead pane.
    setTmuxExecutor(async (args) => {
      (calls as string[][]).push([...args]);
      const live = args[0] === "display-message" && args.includes("#{pane_id}");
      return { stdout: live ? "%2\n" : "", stderr: "", exitCode: 0 };
    });
  });

  it("fails loud when the control socket is missing, without pasting", async () => {
    const { exitCode, stderr } = await runCli(
      ["agent", "send", "pi-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(1);
    const env = JSON.parse(stderr) as { error: string; nextSteps: { command: string }[] };
    expect(env.error).toBe("AgentCtlUnreachableError");
    expect(env.nextSteps.some((s) => s.command === "mu link pi")).toBe(true);
    expect(calls.filter((c) => c[0] === "paste-buffer")).toEqual([]);
  });

  it("a pi agent whose pane is gone reports a dead agent, not ctl unreachable", async () => {
    setTmuxExecutor(async (args) => {
      (calls as string[][]).push([...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const { exitCode, stderr } = await runCli(
      ["agent", "send", "pi-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(1);
    const env = JSON.parse(stderr) as { error: string; nextSteps: { command: string }[] };
    expect(env.error).toBe("AgentPaneDeadError");
    expect(env.nextSteps.some((s) => s.command === "mu link pi")).toBe(false);
    expect(calls.filter((c) => c[0] === "paste-buffer")).toEqual([]);
  });

  it("runs /new over the control socket: fails loud without one, never pastes", async () => {
    const { exitCode, stderr } = await runCli(
      ["agent", "send", "pi-1", "/new", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(1);
    expect((JSON.parse(stderr) as { error: string }).error).toBe("AgentCtlUnreachableError");
    expect(calls.map((c) => c[0])).not.toContain("paste-buffer");
  });
});
