// Integration coverage for `mu task wait --first --json` nextSteps
// against real git worktrees.
//
// The wait hint names the worker's worktree and lists its own commits
// (`git log HEAD --not <upstream refs>`); the orchestrator picks what to keep.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, claimTask, closeTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import type { WorktreeRow } from "../src/worktree.js";
import { runCli } from "./_runCli.js";
import { seedWorktree } from "./_worktree.js";

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

function commitFile(worktreePath: string, filename: string, body: string, subject: string): string {
  writeFileSync(join(worktreePath, filename), body);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: worktreePath,
  });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", subject],
    { cwd: worktreePath },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  }).trim();
}

gitDescribe("mu task wait nextSteps — git worktree commits", () => {
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
    // a real tmux server; git worktrees remain real on disk.
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

  /** Run the hinted `git log --oneline ...` and return the commit subjects. */
  function logOf(command: string | undefined): string[] {
    if (command === undefined) throw new Error("no hint");
    const out = execFileSync("sh", ["-c", `${command} --format=%s`], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.length > 0);
  }

  async function seedWorker(agent: string, paneId: string, task: string): Promise<WorktreeRow> {
    const worktree = await seedWorktree(db, {
      root: projectRoot,
      workstream: "test",
      agent,
      paneId,
    });
    addTask(db, {
      localId: task,
      workstream: "test",
      title: task,
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, task, { agentName: agent, workstream: "test" });
    return worktree;
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
      command: `git -C ${committer.path} log --oneline HEAD --not ${committer.base}`,
    });
    expect(logOf(payload.nextSteps[0]?.command)).toEqual(["worker commit"]);
  });

  it("lists only the worker's commits after a manual rebase onto advanced local main", async () => {
    const committer = await seedWorker("committer", "%1", "commit_task");
    await seedWorker("noncommitter", "%2", "other_task");
    commitFile(projectRoot, "main-only.txt", "m\n", "main-only advancement");
    execFileSync("git", ["-C", committer.path, "rebase", "main"], { stdio: "ignore" });
    commitFile(committer.path, "commit.txt", "committed\n", "worker commit");

    const payload = await closeAndWait("commit_task", "other_task");

    expect(logOf(payload.nextSteps[0]?.command)).toEqual(["worker commit"]);
  });

  it("lists nothing after fetch + rebase onto an advanced remote (root checkout untouched)", async () => {
    const bare = join(tempDir, "origin.git");
    const clone = join(tempDir, "clone");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: projectRoot });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: projectRoot });
    execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: projectRoot });
    const committer = await seedWorker("committer", "%1", "commit_task");
    await seedWorker("noncommitter", "%2", "other_task");
    execFileSync("git", ["clone", "-q", bare, clone], { stdio: "ignore" });
    commitFile(clone, "remote.txt", "r\n", "remote-main-only");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: clone });
    execFileSync("git", ["-C", committer.path, "fetch", "-q", "origin"]);
    execFileSync("git", ["-C", committer.path, "rebase", "-q", "origin/HEAD"]);

    const payload = await closeAndWait("commit_task", "other_task");
    expect(logOf(payload.nextSteps[0]?.command)).toEqual([]);

    commitFile(committer.path, "commit.txt", "committed\n", "worker commit");
    expect(logOf(payload.nextSteps[0]?.command)).toEqual(["worker commit"]);
  });

  it("offers no worktree hint when the owner has no worktree", async () => {
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
