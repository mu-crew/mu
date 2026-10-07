// Tests for src/vcs.ts backend implementations: detectBackend's
// fallback to none (precedence is jj > sl > git > none; the
// jj-over-git case is in vcs-detect.integration.test.ts), the
// noneBackend (cp -a), and the
// real-VCS backends (git always; jj/sl skipped when not on PATH),
// plus each backend's commitsBehind() reporter.
//
// `none` is exercised on every platform (just `cp -a`).
// `git` is exercised when git is on PATH (effectively always for CI).
// `jj` and `sl` get their own conditional describe blocks.
//
// Split out of test/workspace.test.ts under
// testreview_test_files_past_800loc — the registry layer + close
// integration + decorateWithStaleness now live in
// test/workspace-sdk.integration.test.ts and test/workspace-staleness-mem.integration.test.ts.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { detectBackend, gitBackend, jjBackend, noneBackend, slBackend } from "../src/vcs.js";
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

// ─── detectBackend ────────────────────────────────────────────────────

describe("detectBackend fallback", () => {
  it("falls back to none when no VCS owns the directory", async () => {
    const backend = await detectBackend(projectRoot);
    expect(backend.name).toBe("none");
  });
});

// ─── none backend ─────────────────────────────────────────────────────

describe("noneBackend", () => {
  it("createWorkspace cp -a's the project root to the workspace path", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await noneBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const cp = execFileSync("cat", [join(wsPath, "README")], { encoding: "utf8" });
    expect(cp).toBe("hello\n");
  });

  it("createWorkspace fails if the workspace path already exists", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    mkdirSync(wsPath, { recursive: true });
    await expect(
      noneBackend.createWorkspace({ projectRoot, workspacePath: wsPath }),
    ).rejects.toThrow(/already exists/);
  });

  it("freeWorkspace removes the directory; reports removed=true", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await noneBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await noneBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(true);
  });

  it("freeWorkspace is idempotent on a missing dir (removed=false)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "ghost");
    const r = await noneBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(false);
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

// ─── jj backend (skipped when jj is not on PATH) ────────────────

const JJ = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const jjDescribe = JJ ? describe : describe.skip;

// ─── sl backend (skipped when sl is not on PATH) ────────────────

const SL = (() => {
  try {
    execFileSync("sl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const slDescribe = SL ? describe : describe.skip;

slDescribe("slBackend", () => {
  beforeEach(() => {
    execFileSync("sl", ["init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("sl", ["--config", "ui.username=t <t@t>", "commit", "-A", "-m", "init"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  });

  it("createWorkspace clones to the workspace path + returns commit_id", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("cat", [join(wsPath, "README")], { encoding: "utf8" })).toBe("hello\n");
  });

  it("freeWorkspace removes the directory", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await slBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(true);
  });

  it("freeWorkspace --commit captures pending changes", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    writeFileSync(join(wsPath, "new.txt"), "x");
    const r = await slBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("freeWorkspace --commit on a clean tree reports no commit", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await slBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toBeUndefined();
  });
});

jjDescribe("jjBackend", () => {
  beforeEach(() => {
    execFileSync("jj", ["git", "init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("jj", ["commit", "-m", "init"], { cwd: projectRoot, stdio: "ignore" });
  });

  it("createWorkspace creates a jj workspace + returns commit_id", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("freeWorkspace forgets the workspace and removes the directory", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await jjBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(true);
    // jj workspace list (from project root) shouldn't include worker-1.
    const list = execFileSync("jj", ["workspace", "list"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(list).not.toContain("worker-1:");
  });

  it("same-named agents in two workstreams get distinct jj workspaces", async () => {
    await jjBackend.createWorkspace({
      projectRoot,
      workspacePath: join(stateRoot, "workspaces", "auth", "worker-1"),
    });
    const r = await jjBackend.createWorkspace({
      projectRoot,
      workspacePath: join(stateRoot, "workspaces", "billing", "worker-1"),
    });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("recreating a workspace whose dir was removed out from under jj succeeds", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    rmSync(wsPath, { recursive: true, force: true });
    const freed = await jjBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(freed.removed).toBe(false);
    const r = await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("freeWorkspace --commit captures the current commit_id", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    writeFileSync(join(wsPath, "new.txt"), "x");
    const r = await jjBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toMatch(/^[0-9a-f]{40}$/);
  });
});

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
});

// ─── commitsBehind / decorateWithStaleness ────────────────────────
//
// Surfaced by bug_workspace_stale_parent_silent_drift: long-lived
// workspaces silently drift from main with no signal to the operator.
// Each backend's commitsBehind() reports how many commits the
// parent_ref is behind the local refs cache's notion of "main".
// Pure observation: NO automatic fetch.

describe("noneBackend.commitsBehind always returns null", () => {
  it("none has no notion of main", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await noneBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(await noneBackend.commitsBehind(wsPath, "any-ref")).toBeNull();
  });
});

gitDescribe("gitBackend.commitsBehind", () => {
  // The git tests construct a fake "origin" remote so the workspace
  // has a real refs/remotes/origin/HEAD to resolve. We use a bare
  // clone as the "remote" and add it as origin in the workspace.
  let originDir: string;
  let consumerProject: string;

  beforeEach(() => {
    // origin = a bare repo we can advance without affecting `projectRoot`.
    originDir = mkdtempSync(join(tmpdir(), "mu-origin-"));
    execFileSync("git", ["init", "-q", "-b", "main", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "a.txt"), "a\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: projectRoot,
    });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c1"], {
      cwd: projectRoot,
    });
    // Make a bare "origin" out of projectRoot's history.
    execFileSync("git", ["clone", "--bare", projectRoot, originDir], { stdio: "ignore" });
    // Now make a fresh consumer that has origin set to the bare. The
    // workspace will be a worktree of THIS consumer (not projectRoot)
    // so origin/HEAD resolves correctly.
    consumerProject = mkdtempSync(join(tmpdir(), "mu-consumer-"));
    rmSync(consumerProject, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", originDir, consumerProject], { stdio: "ignore" });
  });

  afterEach(() => {
    for (const dir of [originDir, consumerProject]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("returns 0 when parent_ref equals current main", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({
      projectRoot: consumerProject,
      workspacePath: wsPath,
    });
    expect(r.parentRef).toBeTruthy();
    const behind = await gitBackend.commitsBehind(wsPath, r.parentRef ?? "");
    expect(behind).toBe(0);
  });

  it("returns N>0 after origin/main advances by N commits", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({
      projectRoot: consumerProject,
      workspacePath: wsPath,
    });
    // Advance origin by 3 commits, then have the consumer fetch so the
    // local origin/main moves while parent_ref stays put.
    const advancer = mkdtempSync(join(tmpdir(), "mu-advance-"));
    execFileSync("git", ["clone", "-q", originDir, advancer], { stdio: "ignore" });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(advancer, `f${i}.txt`), `${i}\n`);
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
        cwd: advancer,
      });
      execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `c${i + 2}`],
        { cwd: advancer },
      );
    }
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: advancer });
    rmSync(advancer, { recursive: true, force: true });
    // Now have the workspace fetch (the human side of the bug — we
    // EXPLICITLY simulate the operator running `git fetch`; mu itself
    // does NOT fetch). Without fetch, refs/remotes/origin/main would
    // still point at the original commit and behind=0.
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: wsPath });
    const behind = await gitBackend.commitsBehind(wsPath, r.parentRef ?? "");
    expect(behind).toBe(3);
  });

  it("returns null when no main can be resolved (no remote)", async () => {
    // Use the original projectRoot which has NO origin remote.
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-2");
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const behind = await gitBackend.commitsBehind(wsPath, r.parentRef ?? "");
    expect(behind).toBeNull();
  });

  it("returns null on a missing workspace dir", async () => {
    const behind = await gitBackend.commitsBehind(join(stateRoot, "nope"), "deadbeef");
    expect(behind).toBeNull();
  });
});

jjDescribe("jjBackend.commitsBehind returns a number or null", () => {
  beforeEach(() => {
    execFileSync("jj", ["git", "init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("jj", ["commit", "-m", "init"], { cwd: projectRoot, stdio: "ignore" });
  });

  it("returns either a non-negative number or null (smoke)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const behind = await jjBackend.commitsBehind(wsPath, r.parentRef ?? "");
    // jj's trunk() is heuristic; on a fresh repo with no remote it
    // may resolve to @ (giving 0) or fail (giving null). Either is
    // a sane answer; we just want to confirm we get one of them, not
    // a thrown error or NaN.
    expect(behind === null || (typeof behind === "number" && behind >= 0)).toBe(true);
  });
});

jjDescribe("jjBackend.commitsBehind in a colocated repo", () => {
  // `jj log --ignore-working-copy` skips the colocated Git import, so a
  // plain `git fetch` must still be seen (the probe imports first) while
  // a clean re-probe or a dirty working copy writes no jj operation.
  const env = { ...process.env, JJ_USER: "t", JJ_EMAIL: "t@t" };
  const sh = (bin: string, args: string[], cwd: string): string =>
    execFileSync(bin, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const gitCommit = (cwd: string, msg: string): void => {
    sh(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", msg],
      cwd,
    );
  };
  const opHead = (cwd: string): string =>
    sh("jj", ["op", "log", "--ignore-working-copy", "-n1", "--no-graph", "-T", "id"], cwd);

  it("sees a git fetch without snapshotting the working copy", async () => {
    const origin = join(projectRoot, "origin.git");
    const seed = join(projectRoot, "seed");
    const repo = join(projectRoot, "repo");
    sh("git", ["init", "-q", "--bare", origin], projectRoot);
    sh("git", ["clone", "-q", origin, seed], projectRoot);
    gitCommit(seed, "a");
    sh("git", ["push", "-q", "origin", "HEAD:main"], seed);
    sh("git", ["clone", "-q", origin, repo], projectRoot);
    sh("jj", ["git", "init", "--colocate"], repo);
    sh("jj", ["bookmark", "track", "main", "--remote=origin"], repo);
    const parent = sh("jj", ["log", "-r", "trunk()", "--no-graph", "-T", "commit_id"], repo);
    expect(await jjBackend.commitsBehind(repo, parent)).toBe(0);

    gitCommit(seed, "b");
    sh("git", ["push", "-q", "origin", "HEAD:main"], seed);
    sh("git", ["fetch", "-q"], repo);
    expect(await jjBackend.commitsBehind(repo, parent)).toBe(1);

    const op = opHead(repo);
    writeFileSync(join(repo, "dirty.txt"), "x");
    expect(await jjBackend.commitsBehind(repo, parent)).toBe(1);
    expect(opHead(repo)).toBe(op);
  });
});

slDescribe("slBackend.commitsBehind returns a number or null", () => {
  beforeEach(() => {
    execFileSync("sl", ["init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("sl", ["--config", "ui.username=t <t@t>", "commit", "-A", "-m", "init"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  });

  it("returns either a non-negative number or null (smoke)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const behind = await slBackend.commitsBehind(wsPath, r.parentRef ?? "");
    expect(behind === null || (typeof behind === "number" && behind >= 0)).toBe(true);
  });
});
