// Pre-release review R3 (rr_fix_r3_close): a destructive step of close or
// rollback (row delete, worktree remove, name release) runs only on proof
// (pane gone, no writer in the tree); a doubt refuses and keeps everything.
// Real git; the multiplexer is the mock tmux, so no pane is real.

import { type ChildProcess, execFileSync, spawn as spawnChild } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAgent,
  deleteAgent,
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import {
  getWorktreeAt,
  listWorktrees,
  releaseWorktree,
  WorktreeHeldError,
  worktreePath,
} from "../src/worktree.js";
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
    gitIn(root, "branch", branch, head); // what the first attempt left before its removal failed
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

describe("rr_r3_local_rollback_live_pane: rollback keeps a local worktree and row whose pane survives", () => {
  const spawnFailingAfterPane = () =>
    spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      worktree: true,
      root,
      onIdentity: () => {
        throw new Error("injected after finalize");
      },
    });

  it("a kill that fails (pane still alive): the tree, its registry row and the agent row stay", async () => {
    const inner = mockTmux(tmuxState).executor;
    mux.restore();
    mux = installMux("tmux", async (args) =>
      args[0] === "kill-pane"
        ? { stdout: "", stderr: "permission denied", exitCode: 1 }
        : inner(args),
    );
    await expect(spawnFailingAfterPane()).rejects.toThrow(/injected/);
    const path = worktreePath("auth", "worker-1");
    expect(tmuxState.panes.size).toBe(1); // the pane lives
    expect(existsSync(path)).toBe(true);
    expect(listWorktrees(db).map((w) => w.path)).toEqual([path]);
    expect(getAgent(db, "worker-1", "auth")?.cwd).toBe(path);
    expect(
      listLogs(db, { workstream: "auth" }).some((l) => l.payload.includes("not proven gone")),
    ).toBe(true);
  });

  it("a pane the kill removed: the rollback still removes everything", async () => {
    await expect(spawnFailingAfterPane()).rejects.toThrow(/injected/);
    expect(tmuxState.panes.size).toBe(0);
    expect(existsSync(worktreePath("auth", "worker-1"))).toBe(false);
    expect(listWorktrees(db)).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });
});

describe("rr_fix_r3_close_v2 P1 b: rollback never removes a tree with work in it", () => {
  const spawnFailing = (work: (path: string) => void) =>
    spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      worktree: true,
      root,
      onIdentity: (row) => {
        if (row.cwd !== null) work(row.cwd); // the worker got going before the spawn failed
        throw new Error("injected after finalize");
      },
    });
  const logged = (re: RegExp): boolean =>
    listLogs(db, { workstream: "auth" }).some((l) => re.test(l.payload));

  it("committed work is kept on a branch before the tree goes; the rollback names it", async () => {
    let head = "";
    await expect(
      spawnFailing((p) => {
        head = commitFileIn(p, "w.txt", "own work");
      }),
    ).rejects.toThrow(/injected/);
    const branch = `mu/auth/worker-1-${head.slice(0, 12)}`;
    expect(gitIn(root, "rev-parse", "--verify", branch)).toBe(head);
    expect(existsSync(worktreePath("auth", "worker-1"))).toBe(false);
    expect(logged(new RegExp(branch))).toBe(true);
  });

  it("uncommitted files: the tree and its registry row stay, the record says how to finish", async () => {
    const path = worktreePath("auth", "worker-1");
    await expect(spawnFailing((p) => writeFileSync(join(p, "wip.txt"), "x"))).rejects.toThrow(
      /injected/,
    );
    expect(existsSync(join(path, "wip.txt"))).toBe(true);
    expect(listWorktrees(db).map((w) => w.path)).toEqual([path]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined(); // the pane is gone
    expect(logged(/mu agent close worker-1 -w auth/)).toBe(true);
  });
});

describe("rr_r3_local_close_no_quiescence: a local close removes no tree a process still uses", () => {
  let holder: ChildProcess | undefined;
  afterEach(() => {
    holder?.kill("SIGKILL");
    holder = undefined;
  });
  const hold = (cwd: string, file?: string): void => {
    // Detached, as a survivor of the pane kill would be (setsid/nohup).
    const fd = file === undefined ? "ignore" : openSync(file, "a");
    holder = spawnChild("sleep", ["30"], { cwd, detached: true, stdio: ["ignore", fd, "ignore"] });
    if (typeof fd === "number") closeSync(fd); // only the child holds it
  };
  const procOk = existsSync("/proc/self");

  it.runIf(procOk)(
    "a process with its cwd in a clean merged tree: a warning naming it, and the close goes on",
    async () => {
      const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
      hold(wt.path);
      const r = await closeAgent(db, "worker-1", { workstream: "auth" });
      expect(r.worktree?.action).toBe("removed");
      expect(r.worktree?.warnings?.join("\n")).toContain(`process ${holder?.pid} (sleep)`);
      expect(existsSync(wt.path)).toBe(false);
      expect(getWorktreeAt(db, wt.path)).toBeUndefined();
      expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    },
  );

  it.runIf(procOk)("a read-only open file: a warning, not a refusal", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const fd = openSync(join(wt.path, "README"), "r");
    holder = spawnChild("sleep", ["30"], {
      cwd: tmp,
      detached: true,
      stdio: [fd, "ignore", "ignore"],
    });
    closeSync(fd);
    const r = await releaseWorktree(db, wt);
    expect(r.action).toBe("removed");
    expect(r.warnings?.join("\n")).toContain(String(holder.pid));
  });

  it.runIf(procOk)(
    "a cwd holder in an unmerged tree: the branch is kept, the tree removed, the holder warned of",
    async () => {
      const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
      const head = commitFileIn(wt.path, "w.txt", "own work");
      hold(wt.path);
      const r = await releaseWorktree(db, wt);
      expect(r).toMatchObject({
        action: "kept-branch",
        branch: `mu/auth/worker-1-${head.slice(0, 12)}`,
      });
      expect(r.warnings?.join("\n")).toContain(String(holder?.pid));
      expect(existsSync(wt.path)).toBe(false);
    },
  );

  it.runIf(procOk)(
    "a file open for writing (cwd elsewhere), on the orphan path too: refused naming --force, which closes it",
    async () => {
      const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
      const head = commitFileIn(wt.path, "w.txt", "own work");
      writeFileSync(join(root, ".git", "info", "exclude"), "log.txt\n");
      hold(tmp, join(wt.path, "log.txt"));
      deleteAgent(db, "worker-1", "auth"); // the orphan: only the registry row is left
      const err = await closeAgent(db, "worker-1", { workstream: "auth" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeHeldError);
      expect((err as Error).message).toContain(String(holder?.pid));
      expect((err as Error).message).toContain("--force");
      expect(existsSync(wt.path)).toBe(true);
      expect(existsSync(`${wt.path}.mu-removing`)).toBe(false); // moved back
      expect(gitIn(wt.path, "rev-parse", "--show-toplevel")).toBe(wt.path);
      expect(getWorktreeAt(db, wt.path)).toBeDefined();
      // No branch was pinned before the proof.
      const branch = `mu/auth/worker-1-${head.slice(0, 12)}`;
      expect(() => gitIn(root, "rev-parse", "--verify", branch)).toThrow();
      const r = await closeAgent(db, "worker-1", { workstream: "auth", force: true });
      expect(r.worktree).toMatchObject({ action: "kept-branch", branch });
      expect(r.worktree?.warnings?.join("\n")).toContain(String(holder?.pid));
    },
  );

  const lsofOk = (() => {
    try {
      execFileSync("lsof", ["-v"], { stdio: "ignore" });
      return true;
    } catch (e) {
      return (e as { code?: string }).code !== "ENOENT";
    }
  })();
  it.runIf(lsofOk)(
    "with no /proc, lsof tells a cwd holder (warned) from a writer (refused)",
    async () => {
      const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
      const probe = { proc: join(tmp, "no-proc"), lsof: "lsof" };
      writeFileSync(join(root, ".git", "info", "exclude"), "log.txt\n");
      hold(tmp, join(wt.path, "log.txt"));
      const err = await releaseWorktree(db, wt, { probe }).catch((e: unknown) => e);
      expect((err as WorktreeHeldError).pid).toBe(holder?.pid);
      holder?.kill("SIGKILL");
      await new Promise((r) => holder?.once("exit", r));
      hold(wt.path);
      const r = await releaseWorktree(db, wt, { probe });
      expect(r.action).toBe("removed");
      expect(r.warnings?.join("\n")).toContain(String(holder?.pid));
    },
  );

  it("a process of yours /proc will not show (EACCES) is unknown: a warning, never silently skipped", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const proc = join(tmp, "proc");
    execFileSync("mkdir", [
      "-p",
      join(proc, "self"),
      join(proc, String(process.pid)),
      join(proc, "4242"),
    ]);
    symlinkSync(tmp, join(proc, String(process.pid), "cwd"));
    symlinkSync(wt.path, join(proc, "4242", "cwd"));
    writeFileSync(join(proc, "4242", "comm"), "secretive\n");
    chmodSync(join(proc, "4242"), 0o000); // as PR_SET_DUMPABLE=0 leaves it
    try {
      const r = await releaseWorktree(db, wt, { probe: { proc, lsof: join(tmp, "no-lsof") } });
      expect(r.action).toBe("removed");
      expect(r.warnings?.join("\n")).toMatch(/could not inspect.*4242/);
    } finally {
      chmodSync(join(proc, "4242"), 0o755);
    }
  });

  it("no /proc and no lsof: unproven refuses and keeps the tree; force closes it", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const probe = { proc: join(tmp, "no-proc"), lsof: join(tmp, "no-lsof") };
    const err = await releaseWorktree(db, wt, { probe }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreeHeldError);
    expect((err as WorktreeHeldError).pid).toBeUndefined();
    expect((err as Error).message).toContain("--force");
    expect(existsSync(wt.path)).toBe(true);
    expect(getWorktreeAt(db, wt.path)).toBeDefined();
    const r = await releaseWorktree(db, wt, { probe, force: true });
    expect(r.action).toBe("removed");
  });

  it("a crash after the park is resumed: the parked tree is moved back and closed", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    gitIn(root, "worktree", "move", wt.path, `${wt.path}.mu-removing`);
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("removed");
    expect(existsSync(`${wt.path}.mu-removing`)).toBe(false);
    expect(gitIn(root, "worktree", "list")).not.toContain("mu-removing");
  });
});
