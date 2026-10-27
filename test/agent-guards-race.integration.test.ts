// Agent guards, round 3, with real git (v_agent_guards): the close pre-kill
// identity re-check and the staged-spawn rollback's worktree ownership. The
// multiplexer is the mock tmux; no pane is real.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({ inGit: undefined as undefined | (() => void) }));
vi.mock("../src/vcs/git.js", async (orig) => {
  const real = await orig<typeof import("../src/vcs/git.js")>();
  return {
    ...real,
    dirtyFiles: async (d: string) => {
      const f = hook.inGit;
      hook.inGit = undefined;
      f?.();
      return real.dirtyFiles(d);
    },
  };
});

import { withSpawnLock } from "../src/agents/spawn-lock.js";
import {
  AgentReplacedError,
  closeAgent,
  deleteAgent,
  getAgent,
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import {
  createWorktree,
  forgetWorktree,
  getWorktreeAt,
  registerWorktree,
  worktreePath,
} from "../src/worktree.js";
import { rmFixtureDir } from "./_fs.js";
import { gitIn, initGitRepo } from "./_git.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let tmp: string;
let root: string;
let db: Db;
let mux: MuxHarness;
const envKeys = ["MU_STATE_DIR", "MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS"];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "mu-guards-race-")));
  root = join(tmp, "repo");
  execFileSync("mkdir", ["-p", root]);
  initGitRepo(root);
  process.env.MU_STATE_DIR = join(tmp, "state");
  process.env.MU_SPAWN_CTL_MS = "0";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  db = openDb({ path: join(tmp, "mu.db") });
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
});

afterEach(() => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  hook.inGit = undefined;
  db.close();
  for (const k of envKeys) delete process.env[k];
  rmFixtureDir(tmp);
});

it("close re-checks identity before the kill: a same-pane replacement landing during the git check is not killed", async () => {
  const path = worktreePath("auth", "w1");
  const { base } = await createWorktree({ root, path });
  insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", cwd: path });
  registerWorktree(db, { path, agent: "w1", workstream: "auth", root, base, createdAt: "t" });
  const kills: string[] = [];
  mux = installMux("tmux", async (args) => {
    if (args[0] === "kill-pane") {
      kills.push(args[2] ?? "");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "can't find pane", exitCode: 1 };
  });
  // close is parked in assertReleasable (git): replace w1 on the same pane id.
  hook.inGit = () => {
    deleteAgent(db, "w1", "auth");
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", cwd: path });
  };
  await expect(closeAgent(db, "w1", { workstream: "auth" })).rejects.toBeInstanceOf(
    AgentReplacedError,
  );
  expect(kills).toEqual([]);
  expect(getAgent(db, "w1", "auth")?.paneId).toBe("%1");
});

it("a staged spawn's rollback leaves a newer orphan worktree at its path alone", async () => {
  mux = installMux("tmux", mockTmux(freshMockState()).executor);
  const path = worktreePath("auth", "worker-1");
  let spawned: Promise<unknown> = Promise.resolve();
  await withSpawnLock("mu-auth", async () => {
    spawned = spawnAgent(db, { name: "worker-1", workstream: "auth", worktree: true, root }).catch(
      (e) => e,
    );
    // Poll the worktree, not the row: prestageLocked inserts the placeholder
    // row BEFORE `git worktree add` runs, so the row alone races the add.
    for (let i = 0; i < 400 && getWorktreeAt(db, path) === undefined; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(getAgent(db, "worker-1", "auth")?.paneId).toMatch(/^%pending-/);
    // The placeholder is closed (row + clean worktree released)...
    deleteAgent(db, "worker-1", "auth");
    gitIn(root, "worktree", "remove", "--force", path);
    forgetWorktree(db, path);
    // ...then another incarnation worked there and its row was pruned: an
    // orphan registered worktree with uncommitted work at the same path.
    const { base } = await createWorktree({ root, path });
    registerWorktree(db, {
      path,
      agent: "worker-1",
      workstream: "auth",
      root,
      base,
      createdAt: "later",
    });
    writeFileSync(join(path, "precious.txt"), "uncommitted work\n");
  });
  expect(await spawned).toBeInstanceOf(AgentReplacedError);
  expect(existsSync(join(path, "precious.txt"))).toBe(true);
  expect(getWorktreeAt(db, path)?.createdAt).toBe("later");
});
