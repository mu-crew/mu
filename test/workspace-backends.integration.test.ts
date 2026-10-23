// Tests for the git backend (src/vcs/git.ts): worktree create/free,
// the defensive prune, commitsSinceBase and the clean/dirty probes, plus
// detectBackend's refusal outside a git repo.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { detectBackend, gitBackend, WorkspaceVcsRequiredError } from "../src/vcs.js";
import { ensureWorkstream } from "../src/workstream.js";

let stateRoot: string;
let projectRoot: string;
let dbDir: string;
let db: Db;

function setStateDir(dir: string): void {
  process.env.MU_STATE_DIR = dir;
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "mu-ws-state-"));
  setStateDir(stateRoot);
  dbDir = mkdtempSync(join(tmpdir(), "mu-ws-db-"));
  db = openDb({ path: join(dbDir, "mu.db") });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });

  projectRoot = mkdtempSync(join(tmpdir(), "mu-ws-project-"));
  writeFileSync(join(projectRoot, "README"), "hello\n");
});

afterEach(() => {
  db.close();
  for (const dir of [stateRoot, dbDir, projectRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

describe("detectBackend outside a git repo", () => {
  it("throws WorkspaceVcsRequiredError", async () => {
    await expect(detectBackend(projectRoot)).rejects.toBeInstanceOf(WorkspaceVcsRequiredError);
  });
});

// ─── git backend ──────────────────────────────────────────────────────

const GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gitDescribe = GIT ? describe : describe.skip;

gitDescribe("gitBackend", () => {
  beforeEach(() => {
    execFileSync("git", ["init", "-q", "-b", "main", projectRoot], { stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: projectRoot,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: projectRoot },
    );
  });

  it("createWorkspace creates a git worktree at the requested path", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
    const branch = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: wsPath,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe(r.parentRef);
  });

  it("freeWorkspace tears down the worktree (no auto-commit, no pending changes)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await gitBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(true);
    expect(r.committedRef).toBeUndefined();
  });

  it("freeWorkspace --commit captures pending changes when present", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    writeFileSync(join(wsPath, "new.txt"), "x");
    const r = await gitBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toMatch(/^[0-9a-f]{40}$/);
    // The detached worktree is gone; a branch must keep the commit
    // reachable (f_vcs_git_free_commit_dangling).
    expect(r.branch).toBe(`mu/auth/worker-1-${r.committedRef?.slice(0, 12)}`);
    const tip = execFileSync("git", ["rev-parse", `refs/heads/${r.branch}`], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    expect(tip).toBe(r.committedRef);
  });

  it("freeWorkspace --commit on a clean tree reports no commit", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await gitBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toBeUndefined();
    // HEAD is main's tip, already on a branch: no extra branch.
    expect(r.branch).toBeUndefined();
  });

  // Regression for mufeedback workspace_free_cleanup_leaves_git: a
  // user who manually rm-rf'd a workspace dir leaves the git worktree
  // registry pointing at a missing path. Without the defensive prune
  // in createWorkspace, the next add at that path errors with
  // 'missing but already registered worktree'. With it, recovery is
  // automatic.
  it("createWorkspace recovers when a previous worktree dir was rm-rf'd (defensive prune)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    // Simulate the user's exact failure: manual rm -rf without
    // running freeWorkspace. The git registry still points at wsPath.
    rmSync(wsPath, { recursive: true, force: true });
    // Sanity: git knows about the (now missing) worktree.
    const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(wtList).toContain(wsPath);
    // Now retry: defensive prune in createWorkspace should clean the
    // stale registration and let the add succeed.
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("commitsSinceBase lists commits on top of the fork point, oldest first", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const { parentRef } = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    if (parentRef === null) throw new Error("no parentRef");
    expect(await gitBackend.commitsSinceBase(wsPath, parentRef)).toEqual([]);
    for (const n of ["one", "two"]) {
      writeFileSync(join(wsPath, `${n}.txt`), n);
      execFileSync("git", ["add", "."], { cwd: wsPath });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", n], {
        cwd: wsPath,
      });
    }
    const commits = await gitBackend.commitsSinceBase(wsPath, parentRef);
    expect(commits.map((c) => c.subject)).toEqual(["one", "two"]);
    expect(commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("isClean and listDirtyFiles see untracked files", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(await gitBackend.isClean(wsPath)).toBe(true);
    expect(await gitBackend.listDirtyFiles(wsPath)).toEqual([]);
    writeFileSync(join(wsPath, "new.txt"), "x");
    expect(await gitBackend.isClean(wsPath)).toBe(false);
    expect(await gitBackend.listDirtyFiles(wsPath)).toEqual(["new.txt"]);
  });
});
