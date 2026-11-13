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
  readFileSync,
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
  previewClose,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import {
  awaitHelpers,
  getWorktreeAt,
  listWorktrees,
  processTree,
  reclaimWorktreePath,
  releaseWorktree,
  WorktreeHeldError,
  WorktreePathNotEmptyError,
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
  // A mock pane's processes (paneRunning below): its group and what it started.
  const procs: number[] = [];
  afterEach(() => {
    holder?.kill("SIGKILL");
    holder = undefined;
    for (const pid of procs.splice(0)) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {}
      }
    }
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

  it.runIf(procOk)(
    "the preview names a process inside the tree, but not the agent's own pane processes",
    async () => {
      const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
      hold(wt.path);
      tmuxState.panes.set("%1", { windowId: "@1", paneId: "%1", command: "pi" });
      const p = await previewClose(db, "worker-1", { workstream: "auth" });
      expect(p.worktree?.holders?.map((h) => h.pid)).toEqual([holder?.pid]);
      expect(p.worktree?.holders?.[0]).toMatchObject({ command: "sleep", writer: false });
      // The same process as the pane's own (its pi, or a tool under it): the kill ends it, not news.
      tmuxState.panes.set("%1", {
        windowId: "@1",
        paneId: "%1",
        command: "pi",
        pid: holder?.pid ?? 0,
      });
      const own = await previewClose(db, "worker-1", { workstream: "auth" });
      expect(own.worktree?.holders).toEqual([]);
      expect(existsSync(wt.path)).toBe(true);
    },
  );

  it("the close waits for the killed pane's own process to exit, then removes the tree with no warning", async () => {
    resetSleep(); // a real clock: the holder exits 1.5 s after the kill (past the holder scan)
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    hold(wt.path); // the pane's pi, inside its tree
    const pid = holder?.pid ?? 0;
    tmuxState.panes.set("%1", { windowId: "@1", paneId: "%1", command: "pi", pid });
    const inner = mockTmux(tmuxState).executor;
    mux.restore();
    mux = installMux("tmux", async (args) => {
      // pi saves its session after the hangup: it outlives the pane by a moment.
      if (args.includes("kill-pane")) setTimeout(() => holder?.kill("SIGKILL"), 1500);
      return inner(args);
    });
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("removed");
    // Only the pane's own processes: a host may also hide some of yours (a runner's helpers).
    expect(ours(r.worktree?.warnings)).toEqual([]);
    expect(existsSync(wt.path)).toBe(false);
  });

  /** [pid, ppid, pgid] of every process. */
  const psRows = (): number[][] =>
    execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((l) => l.trim().split(/\s+/).map(Number));
  const descendants = (root: number): number[][] => {
    const rows = psRows();
    const out: number[][] = [];
    for (let todo = [root], p = todo.pop(); p !== undefined; p = todo.pop()) {
      for (const r of rows) {
        if (r[1] !== p || r[0] === undefined) continue;
        out.push(r);
        todo.push(r[0]);
      }
    }
    return out;
  };
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 60 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(ok()).toBe(true);
  };
  /**
   * The mock pane's pid runs `script`; `onKill(pane)` is what the kill-pane
   * does to it (the hangup). `tty`: the pane has a terminal, as a real pane
   * does (macOS tells the pane's session only by it; script(1) makes one).
   */
  const paneRunning = async (
    script: string,
    onKill: (pane: number) => void,
    tty = false,
  ): Promise<number> => {
    const viaScript = tty && process.platform === "darwin";
    const sh = viaScript
      ? spawnChild("script", ["-q", "/dev/null", "sh", "-c", script], {
          cwd: tmp,
          stdio: "ignore",
          detached: true,
        })
      : spawnChild("sh", ["-c", script], { cwd: tmp, stdio: "ignore", detached: true });
    procs.push(sh.pid ?? 0);
    let pid = sh.pid ?? 0;
    if (viaScript) {
      await until(() => descendants(sh.pid ?? 0).length > 0);
      pid = descendants(sh.pid ?? 0)[0]?.[0] ?? 0;
      procs.push(pid);
    }
    tmuxState.panes.set("%1", { windowId: "@1", paneId: "%1", command: "pi", pid });
    const inner = mockTmux(tmuxState).executor;
    mux.restore();
    mux = installMux("tmux", async (args) => {
      if (args.includes("kill-pane")) onKill(pid);
      return inner(args);
    });
    return pid;
  };
  // Only the processes a test started: git's own telemetry helpers (route,
  // scm_telem_log on some hosts) may sit in a tree mu just ran git in.
  const ours = (warnings: string[] | undefined): string[] =>
    (warnings ?? []).filter((w) => /\((sh|sleep|perl)\)/.test(w));
  const kill = (target: number): void => {
    try {
      process.kill(target, "SIGKILL");
    } catch {}
  };

  it("the close waits for a grandchild of the pane (a tool of its pi) inside the tree: no warning", async () => {
    resetSleep(); // a real clock: the processes exit 1.5 s after the kill
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    // pane sh (cwd outside the tree) -> subshell -> sleep with its cwd in the tree.
    const pane = await paneRunning(`(cd "${wt.path}" && sleep 30; true) & wait`, (p) => {
      setTimeout(() => kill(-p), 1500);
    });
    await until(() => descendants(pane).length >= 2);
    const p = await previewClose(db, "worker-1", { workstream: "auth" });
    expect(p.worktree?.holders ?? []).toEqual([]); // the pane's own: the kill ends it
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("removed");
    expect(ours(r.worktree?.warnings)).toEqual([]);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("the close waits for a setsid'd helper of the pane (and its child) inside the tree: no warning", async () => {
    resetSleep();
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    // As a detached drain of pi's: setsid, cwd in the tree, a child of its own.
    let helper = 0;
    const pane = await paneRunning(
      `cd "${wt.path}" && perl -MPOSIX -e 'POSIX::setsid(); exec "sh", "-c", "sleep 30 & wait"' & sleep 30`,
      (p) => {
        kill(-p); // the pane goes at once; the helper is reparented and lives on
        setTimeout(() => kill(-helper), 1500);
      },
    );
    await until(() => descendants(pane).some((r) => r[0] === r[2] && r[0] !== pane));
    helper = descendants(pane).find((r) => r[0] === r[2])?.[0] ?? 0; // its group's leader
    procs.push(helper);
    await until(() => descendants(helper).length > 0);
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("removed");
    expect(ours(r.worktree?.warnings)).toEqual([]);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("the close waits for a pane helper in its own group in the pane's session, reparented before the close: no warning", async () => {
    resetSleep();
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    // As pi's guardrails plugin: a hook forks it into its own group (no hangup
    // reaches it) and exits, so it is reparented away from pi.
    const pidFile = join(tmp, "plugin.pid");
    const pane = await paneRunning(
      `cd "${wt.path}" && (perl -e 'setpgrp(0,0); open(F, ">", "${pidFile}"); print F $$; close F; exec "sleep", "30"' &); sleep 30`,
      (p) => kill(-p),
      true,
    );
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
    const plugin = Number(readFileSync(pidFile, "utf8"));
    procs.push(plugin);
    await until(() => descendants(pane).every((r) => r[0] !== plugin)); // not the pane's child
    setTimeout(() => kill(plugin), 1500);
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("removed");
    expect(ours(r.worktree?.warnings)).toEqual([]);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("a setsid'd helper that never exits: the close gives up within the 5 s bound and names it", async () => {
    resetSleep();
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const pane = await paneRunning(
      `cd "${wt.path}" && perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "60"' & sleep 30`,
      (p) => kill(-p),
    );
    await until(() => descendants(pane).some((r) => r[0] === r[2] && r[0] !== pane));
    const helper = descendants(pane).find((r) => r[0] === r[2])?.[0] ?? 0;
    procs.push(helper);
    const t0 = Date.now();
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    const took = Date.now() - t0;
    kill(helper);
    expect(r.worktree?.action).toBe("removed");
    expect(r.worktree?.warnings?.join("\n")).toContain(`process ${helper} (sleep)`);
    // 5 s of waiting from the kill, then the park, the holder scan and the removal.
    // The ceiling only proves the close gives up rather than outwaiting the
    // 60 s helper; under load the close took up to 10.7 s. The 5 s bound itself
    // is pinned tightly by the awaitHelpers test below.
    expect(took).toBeGreaterThanOrEqual(4900);
    expect(took).toBeLessThan(20_000);
  }, 30_000);

  it("awaitHelpers counts its own holder scan against its bound", async () => {
    resetSleep();
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    hold(wt.path); // detached: its own group, never exits
    const pid = holder?.pid ?? 0;
    const t0 = Date.now();
    const left = await awaitHelpers(wt.path, { tree: new Set(), groups: new Set([pid]) }, 1500);
    const took = Date.now() - t0;
    expect(left).toEqual([pid]);
    expect(took).toBeGreaterThanOrEqual(1450);
    expect(took).toBeLessThan(1800); // the bound, plus at most one poll
  });

  it("a foreign holder is still named once the pane's own are gone", async () => {
    resetSleep();
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    hold(wt.path); // detached: another session, never the pane's
    await paneRunning(`cd "${wt.path}" && sleep 30`, (p) => kill(-p), true);
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("removed");
    expect(r.worktree?.warnings?.join("\n")).toContain(`process ${holder?.pid} (sleep)`);
  });

  it("two previews give the same --if revision while the processes in the tree churn", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    // The pane's tools come and go, and so do a foreign process's.
    await paneRunning(`cd "${wt.path}" && while :; do sleep 0.05; done`, () => {});
    holder = spawnChild("sh", ["-c", "while :; do sleep 0.05; done"], {
      cwd: wt.path,
      stdio: "ignore",
      detached: true,
    });
    const pids = (p: { worktree?: { holders?: { pid: number }[] } | null }): number[] =>
      (p.worktree?.holders ?? []).map((h) => h.pid).sort();
    const a = await previewClose(db, "worker-1", { workstream: "auth" });
    expect(a.revision).not.toBe(0);
    // Re-preview (bounded) until lsof catches a different holder list; whether
    // it does is luck, so only the revision is asserted, on every preview.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const b = await previewClose(db, "worker-1", { workstream: "auth" });
      expect(b.revision).toBe(a.revision);
      if (pids(b).join() !== pids(a).join()) break;
    }
    // And the apply takes it.
    holder.kill("SIGKILL");
    const r = await closeAgent(db, "worker-1", { workstream: "auth", ifRevision: a.revision });
    expect(r.worktree?.action).toBe("removed");
  });

  it("processTree holds a pane's grandchildren (its pi's tools), never the caller, never a setsid one", async () => {
    // sh (its own session) -> sleep (same session) + a setsid sleep (a new session; perl, as macOS has no setsid(1)).
    const sh = spawnChild(
      "sh",
      ["-c", "sleep 30 & perl -MPOSIX -e 'POSIX::setsid(); exec qw(sleep 31)' & wait"],
      {
        stdio: "ignore",
        detached: true,
      },
    );
    // macOS's ps has no sid; a setsid also leaves its process group (sh's, with no terminal).
    const col = process.platform === "darwin" ? "pgid" : "sid";
    const rows = (): number[][] =>
      execFileSync("ps", ["-A", "-o", `pid=,ppid=,${col}=`], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .map((l) => l.trim().split(/\s+/).map(Number));
    let kids: number[][] = [];
    try {
      for (let i = 0; i < 40 && kids.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 50));
        kids = rows().filter((r) => r[1] === sh.pid);
      }
      const same = kids.filter((r) => r[2] === sh.pid).map((r) => r[0]);
      const fled = kids.filter((r) => r[2] !== sh.pid).map((r) => r[0]);
      expect(same).toHaveLength(1);
      expect(fled).toHaveLength(1);
      const tree = await processTree(sh.pid ?? 0);
      expect(tree.has(sh.pid ?? 0)).toBe(true);
      expect(tree.has(same[0] ?? -1)).toBe(true);
      expect(tree.has(fled[0] ?? -1)).toBe(false);
      expect(tree.has(process.pid)).toBe(false);
    } finally {
      for (const pid of [sh.pid ?? 0, ...kids.map((r) => r[0] ?? 0)]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  });

  it.runIf(procOk)(
    "the preview names a setsid writer under the pane (it survives the kill)",
    async () => {
      const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
      writeFileSync(join(root, ".git", "info", "exclude"), "log.txt\n");
      // The pane's process, and a writer it started in a new session.
      const pane = spawnChild(
        "sh",
        ["-c", `setsid sh -c 'exec 3>>"${wt.path}/log.txt"; exec sleep 30' & wait`],
        {
          cwd: tmp,
          stdio: "ignore",
          detached: true,
        },
      );
      let writer: number | undefined;
      try {
        for (let i = 0; i < 40 && writer === undefined; i++) {
          await new Promise((r) => setTimeout(r, 50));
          const p = (await previewClose(db, "worker-1", { workstream: "auth" })).worktree;
          writer = p?.holders?.find((h) => h.writer)?.pid;
        }
        tmuxState.panes.set("%1", {
          windowId: "@1",
          paneId: "%1",
          command: "pi",
          pid: pane.pid ?? 0,
        });
        const p = await previewClose(db, "worker-1", { workstream: "auth" });
        expect(writer).toBeDefined();
        expect(p.worktree?.holders?.map((h) => h.pid)).toContain(writer);
      } finally {
        for (const pid of [pane.pid ?? 0, writer ?? 0]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
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
      const probe = { proc, lsof: join(tmp, "no-lsof") };
      // The preview says it too, before anything is removed.
      const p = await previewClose(db, "worker-1", { workstream: "auth", probe });
      expect(p.worktree?.hidden).toEqual([4242]);
      const r = await releaseWorktree(db, wt, { probe });
      expect(r.action).toBe("removed");
      expect(r.warnings?.join("\n")).toMatch(/could not inspect.*4242/);
    } finally {
      chmodSync(join(proc, "4242"), 0o755);
    }
  });

  it.runIf(procOk)(
    "name reuse scans the leftover too: a writer refuses naming the --force close, a cwd holder is logged",
    async () => {
      const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
      deleteAgent(db, "worker-1", "auth"); // mu's own clean leftover, registered
      writeFileSync(join(root, ".git", "info", "exclude"), "log.txt\n");
      hold(tmp, join(wt.path, "log.txt"));
      const err = await reclaimWorktreePath(db, {
        agent: "worker-1",
        workstream: "auth",
        path: wt.path,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreePathNotEmptyError);
      expect((err as Error).message).toContain(`process ${holder?.pid}`);
      expect((err as Error).message).toContain("mu agent close worker-1 -w auth --force");
      expect(existsSync(wt.path)).toBe(true);
      expect(getWorktreeAt(db, wt.path)).toBeDefined();
      holder?.kill("SIGKILL");
      await new Promise((r) => holder?.once("exit", r));
      hold(wt.path);
      const warnings = await reclaimWorktreePath(db, {
        agent: "worker-1",
        workstream: "auth",
        path: wt.path,
      });
      expect(warnings.join("\n")).toContain(`process ${holder?.pid}`);
      expect(existsSync(wt.path)).toBe(false);
    },
  );

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
