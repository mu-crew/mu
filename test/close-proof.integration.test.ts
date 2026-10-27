// Pre-release review R3 (rr_fix_r3_close): a destructive step of close or
// rollback (row delete, worktree remove, name release) runs only on proof
// (pane gone, no writer in the tree); a doubt refuses and keeps everything.
// Real git; the multiplexer is the mock tmux, so no pane is real.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAgent,
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { getWorktreeAt, releaseWorktree } from "../src/worktree.js";
import { commitFileIn, gitIn, initGitRepo } from "./_git.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";
import { seedWorktree } from "./_worktree.js";

let tmp: string;
let root: string;
let db: Db;
let mux: MuxHarness;
let tmuxState: MockState;
const envKeys = ["MU_STATE_DIR", "MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS"] as const;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "mu-cp-")));
  root = join(tmp, "repo");
  execFileSync("mkdir", ["-p", root]);
  initGitRepo(root);
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

describe("rr_r3_branch_retry_collision: a retried unmerged close reuses its own branch", () => {
  it("a removal that failed after the branch was made succeeds on retry", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const head = commitFileIn(wt.path, "w.txt", "own work");
    const branch = `mu/auth/worker-1-${head.slice(0, 12)}`;
    gitIn(root, "worktree", "lock", wt.path);
    await expect(releaseWorktree(db, wt)).rejects.toThrow();
    expect(gitIn(root, "rev-parse", branch)).toBe(head); // the first attempt made it
    gitIn(root, "worktree", "unlock", wt.path);
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree).toMatchObject({ action: "kept-branch", branch });
    expect(existsSync(wt.path)).toBe(false);
    expect(getWorktreeAt(db, wt.path)).toBeUndefined();
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("a branch of that name at ANOTHER commit refuses and is never moved", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const head = commitFileIn(wt.path, "w.txt", "own work");
    const branch = `mu/auth/worker-1-${head.slice(0, 12)}`;
    const main = gitIn(root, "rev-parse", "HEAD");
    gitIn(root, "branch", branch, main);
    await expect(releaseWorktree(db, wt)).rejects.toThrow(/already exists at another commit/);
    expect(gitIn(root, "rev-parse", branch)).toBe(main);
    expect(existsSync(wt.path)).toBe(true);
    expect(getWorktreeAt(db, wt.path)).toBeDefined();
  });
});
