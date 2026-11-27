// Landing metadata on agent.close (fsj U2): a local worktree close records
// repo_root, target_ref, base_sha, head_sha and preserved_ref in its op, read
// before the registry row and the dir go, so a reader can verify landing
// after cleanup. Real git; the multiplexer is the mock tmux.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAgent,
  getAgent,
  listLiveAgents,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { renderOpLine } from "../src/log-render.js";
import { listLogs } from "../src/logs.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { getWorktreeAt, type Landing, readCloseLanding, worktreePath } from "../src/worktree.js";
import { commitFileIn, copyGitFixture, gitIn } from "./_git.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const gitDescribe = GIT ? describe : describe.skip;

let tmp: string;
let root: string;
let db: Db;
let mux: MuxHarness;
let tmuxState: MockState;
const envKeys = ["MU_STATE_DIR", "MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS"] as const;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "mu-landing-")));
  root = join(tmp, "repo");
  mkdirSync(root);
  copyGitFixture(root);
  process.env.MU_STATE_DIR = join(tmp, "state");
  process.env.MU_SPAWN_CTL_MS = "0";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  db = openDb({ path: join(tmp, "mu.db") });
  tmuxState = freshMockState();
  mux = installMux("tmux", mockTmux(tmuxState).executor);
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
});

afterEach(() => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of envKeys) delete process.env[k];
});

const spawn = (name: string) => spawnAgent(db, { name, workstream: "auth", worktree: true, root });

/** The newest agent.close op and the landing it carries. */
function lastClose(): { landing: Landing | null; line: string } {
  const rows = listLogs(db, { workstream: "auth", intent: "agent.close" });
  const row = rows.at(-1);
  if (row === undefined) throw new Error("no agent.close op");
  return { landing: readCloseLanding(row), line: renderOpLine(row) };
}

gitDescribe("agent.close records the landing", () => {
  it("merged: root, target ref, base and head; no preserved ref", async () => {
    await spawn("worker-1");
    const path = worktreePath("auth", "worker-1");
    const base = gitIn(root, "rev-parse", "HEAD");
    expect(getWorktreeAt(db, path)?.targetRef).toBe("refs/heads/main");
    const head = commitFileIn(path, "w.txt", "own work");
    gitIn(root, "merge", "--ff-only", head);
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("removed");
    const close = lastClose();
    expect(close.landing).toEqual({
      repoRoot: root,
      targetRef: "refs/heads/main",
      baseSha: base,
      headSha: head,
      preservedRef: null,
    });
    // `mu log` still prints the prose, never the JSON.
    expect(close.line).toContain("worktree removed");
    expect(close.line).not.toContain("{");
  });

  it("unmerged: the preserved ref is the kept branch at head", async () => {
    await spawn("worker-1");
    const path = worktreePath("auth", "worker-1");
    const base = gitIn(root, "rev-parse", "HEAD");
    const head = commitFileIn(path, "w.txt", "own work");
    await closeAgent(db, "worker-1", { workstream: "auth" });
    const branch = `mu/auth/worker-1-${head.slice(0, 12)}`;
    expect(lastClose().landing).toEqual({
      repoRoot: root,
      targetRef: "refs/heads/main",
      baseSha: base,
      headSha: head,
      preservedRef: branch,
    });
    expect(gitIn(root, "rev-parse", branch)).toBe(head);
  });

  it("a detached root: target_ref is null, never the pseudo-ref HEAD", async () => {
    const base = gitIn(root, "rev-parse", "HEAD");
    gitIn(root, "checkout", "--detach", base);
    await spawn("worker-1");
    const path = worktreePath("auth", "worker-1");
    expect(getWorktreeAt(db, path)?.targetRef).toBeNull();
    await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(lastClose().landing).toEqual({
      repoRoot: root,
      targetRef: null,
      baseSha: base,
      headSha: base,
      preservedRef: null,
    });
  });

  it("--from a sha: target_ref is null", async () => {
    const base = gitIn(root, "rev-parse", "HEAD");
    await spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      worktree: true,
      root,
      from: base,
    });
    expect(getWorktreeAt(db, worktreePath("auth", "worker-1"))?.targetRef).toBeNull();
  });

  it("--from a branch: target_ref is that branch", async () => {
    const base = gitIn(root, "rev-parse", "HEAD");
    gitIn(root, "branch", "feature", base);
    await spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      worktree: true,
      root,
      from: "feature",
    });
    expect(getWorktreeAt(db, worktreePath("auth", "worker-1"))?.targetRef).toBe(
      "refs/heads/feature",
    );
    await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(lastClose().landing).toMatchObject({
      repoRoot: root,
      targetRef: "refs/heads/feature",
      baseSha: base,
      headSha: base,
    });
  });

  it("--discard: action discarded, the landing keeps head and no preserved ref", async () => {
    await spawn("worker-1");
    const path = worktreePath("auth", "worker-1");
    const base = gitIn(root, "rev-parse", "HEAD");
    const head = commitFileIn(path, "w.txt", "own work");
    const r = await closeAgent(db, "worker-1", { workstream: "auth", discard: true });
    expect(r.worktree?.action).toBe("discarded");
    expect(lastClose().landing).toEqual({
      repoRoot: root,
      targetRef: "refs/heads/main",
      baseSha: base,
      headSha: head,
      preservedRef: null,
    });
  });

  it("a worktree dir deleted beforehand: action gone, head sha null", async () => {
    await spawn("worker-1");
    const path = worktreePath("auth", "worker-1");
    const base = gitIn(root, "rev-parse", "HEAD");
    rmSync(path, { recursive: true, force: true });
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("gone");
    expect(lastClose().landing).toEqual({
      repoRoot: root,
      targetRef: "refs/heads/main",
      baseSha: base,
      headSha: null,
      preservedRef: null,
    });
  });

  it("readCloseLanding: a JSON array or a non-object landing reads as none", () => {
    const row = (payload: string) => ({ intent: "agent.close", payload });
    expect(readCloseLanding(row("[1,2]"))).toBeNull();
    expect(readCloseLanding(row('{"landing":["x"]}'))).toBeNull();
    expect(readCloseLanding(row('{"landing":"x"}'))).toBeNull();
    expect(readCloseLanding(row("agent close w (pane=%1)"))).toBeNull();
  });

  it("an agent without a worktree records a null landing", async () => {
    await spawnAgent(db, { name: "plain-1", workstream: "auth", cwd: root });
    await closeAgent(db, "plain-1", { workstream: "auth" });
    const close = lastClose();
    expect(close.landing).toBeNull();
    expect(close.line).toContain("plain-1");
  });

  it("a reaped ghost row: the orphan's close still records the landing, with no pane", async () => {
    const agent = await spawn("worker-1");
    const path = worktreePath("auth", "worker-1");
    const base = gitIn(root, "rev-parse", "HEAD");
    const head = commitFileIn(path, "w.txt", "own work");
    // The pane dies outside mu; the next read reaps the row as a ghost.
    tmuxState.panes.delete(agent.paneId);
    await listLiveAgents(db, { workstream: "auth" });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.deletedRow).toBe(false);
    expect(lastClose().landing).toEqual({
      repoRoot: root,
      targetRef: "refs/heads/main",
      baseSha: base,
      headSha: head,
      preservedRef: `mu/auth/worker-1-${head.slice(0, 12)}`,
    });
  });
});
