// Integration coverage for `mu task wait --first --json` nextSteps
// against real git-backed workspaces.
//
// The wait hint names the worker's worktree and its fork point, so the
// orchestrator inspects `git log <fork>..HEAD` and picks what to keep.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, claimTask, closeTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { createWorkspace, type WorkspaceRow } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

const GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gitDescribe = GIT ? describe : describe.skip;

interface WaitJsonPayload {
  nextSteps: Array<{ intent: string; command: string }>;
}

function initGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "base\n");
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: root,
  });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
    cwd: root,
  });
}

function commitFile(
  workspacePath: string,
  filename: string,
  body: string,
  subject: string,
): string {
  writeFileSync(join(workspacePath, filename), body);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: workspacePath,
  });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", subject],
    { cwd: workspacePath },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    encoding: "utf8",
  }).trim();
}

gitDescribe("mu task wait nextSteps — git workspace commits", () => {
  let tempDir: string;
  let stateRoot: string;
  let dbPath: string;
  let projectRoot: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-nextsteps-"));
    stateRoot = join(tempDir, "state");
    dbPath = join(tempDir, "mu.db");
    projectRoot = join(tempDir, "project");
    process.env.MU_STATE_DIR = stateRoot;
    initGitRepo(projectRoot);
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");

    // `mu task wait` reconciles before its immediate success snapshot.
    // Keep the fake agents alive through that reconcile without touching
    // a real tmux server; git workspaces remain real on disk.
    setTmuxExecutor(async (args) => {
      if (args[0] === "list-panes" && args[1] === "-s") {
        return {
          stdout: [
            "@1\t%1\tcommitter\tpi",
            "@1\t%2\tnoncommitter\tpi",
            "@1\t%3\tmulticommitter\tpi",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "capture-pane") {
        return { stdout: "ready\n> ", stderr: "", exitCode: 0 };
      }
      if (args[0] === "select-pane" || args[0] === "set-option") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `unmocked tmux call: ${args.join(" ")}`, exitCode: 1 };
    });
  });

  afterEach(() => {
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
    const key = "MU_STATE_DIR";
    delete process.env[key];
  });

  async function seedWorker(agent: string, paneId: string, task: string): Promise<WorkspaceRow> {
    insertAgent(db, { name: agent, workstream: "test", paneId });
    const workspace = await createWorkspace(db, {
      agent,
      workstream: "test",
      projectRoot,
      backend: "git",
    });
    addTask(db, {
      localId: task,
      workstream: "test",
      title: task,
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, task, { agentName: agent, workstream: "test" });
    return workspace;
  }

  async function closeAndWait(firingTask: string, otherTask: string): Promise<WaitJsonPayload> {
    closeTask(db, firingTask, { workstream: "test", evidence: "done" });
    closeTask(db, otherTask, { workstream: "test", evidence: "done" });
    const r = await runCli(
      ["task", "wait", firingTask, otherTask, "-w", "test", "--first", "--json"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    return JSON.parse(r.stdout) as WaitJsonPayload;
  }

  it("points at the worker's worktree log from its fork point", async () => {
    const committer = await seedWorker("committer", "%1", "commit_task");
    await seedWorker("noncommitter", "%2", "other_task");
    commitFile(committer.path, "commit.txt", "committed\n", "worker commit");

    const payload = await closeAndWait("commit_task", "other_task");

    expect(payload.nextSteps[0]).toEqual({
      intent: "Inspect committer's commits, then cherry-pick what you want",
      command: `git -C ${committer.path} log --oneline ${committer.parentRef}..HEAD`,
    });
  });

  it("offers no worktree hint when the owner has no workspace", async () => {
    insertAgent(db, { name: "bare", workstream: "test", paneId: "%4" });
    addTask(db, {
      localId: "bare_task",
      workstream: "test",
      title: "t",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "bare_task", { agentName: "bare", workstream: "test" });
    await seedWorker("other", "%5", "other_task");

    const payload = await closeAndWait("bare_task", "other_task");

    expect(payload.nextSteps.some((s) => s.command.includes("log --oneline"))).toBe(false);
  });
});
