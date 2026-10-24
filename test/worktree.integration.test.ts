// Per-agent git worktrees (src/worktree.ts): create, the close rule (dirty
// refuses, merged removes, unmerged keeps a branch, --discard overrides),
// name reuse, spawn rollback, teardown, and the registry that outlives the
// agent. Real git; the multiplexer is the mock tmux, so no pane is real.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAgent,
  deleteAgent,
  getAgent,
  insertAgent,
  listLiveAgents,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, migrateLegacyWorkspaces, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import {
  createWorktree,
  getWorktreeAt,
  listWorktrees,
  reclaimWorktreePath,
  WorktreeDirtyError,
  WorktreePathNotEmptyError,
  WorktreeVcsRequiredError,
  worktreePath,
  worktreeState,
} from "../src/worktree.js";
import { commitFileIn, gitIn, initGitRepo } from "./_git.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { softTeardown } from "./_teardown.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";
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

let tmp: string;
let stateDir: string;
let root: string;
let db: Db;
let mux: MuxHarness;
let tmuxState: MockState;
const envKeys = ["MU_STATE_DIR", "MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS"] as const;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "mu-wt-")));
  stateDir = join(tmp, "state");
  root = join(tmp, "repo");
  execFileSync("mkdir", ["-p", root]);
  initGitRepo(root);
  process.env.MU_STATE_DIR = stateDir;
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

const branches = () =>
  gitIn(root, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n")
    .filter((b) => b.length > 0);

/** Pane ids the mock tmux has not been told to kill. */
const livePanes = () => [...tmuxState.panes.keys()];

gitDescribe("createWorktree / worktreeState", () => {
  it("adds a detached worktree at HEAD and returns its base", async () => {
    const path = worktreePath("auth", "worker-1");
    const { base } = await createWorktree({ root, path });
    expect(base).toBe(gitIn(root, "rev-parse", "HEAD"));
    expect(gitIn(path, "rev-parse", "HEAD")).toBe(base);
    // detached: a named branch would break name reuse
    expect(() => gitIn(path, "symbolic-ref", "-q", "HEAD")).toThrow();
    expect(branches()).toEqual(["main"]);
  });

  it("--from starts the worktree at that ref", async () => {
    const first = gitIn(root, "rev-parse", "HEAD");
    commitFileIn(root, "later.txt", "later");
    const { base } = await createWorktree({
      root,
      path: worktreePath("auth", "worker-1"),
      from: first,
    });
    expect(base).toBe(first);
  });

  it("reports missing / dirty / clean-merged / clean-unmerged", async () => {
    const path = worktreePath("auth", "worker-1");
    const { base } = await createWorktree({ root, path });
    expect(await worktreeState(path, base, root)).toBe("clean-merged");
    writeFileSync(join(path, "u.txt"), "x");
    expect(await worktreeState(path, base, root)).toBe("dirty");
    rmSync(join(path, "u.txt"));
    commitFileIn(path, "w.txt", "own work");
    expect(await worktreeState(path, base, root)).toBe("clean-unmerged");
    // main picks the commit up: merged now
    gitIn(root, "merge", "--ff-only", gitIn(path, "rev-parse", "HEAD"));
    expect(await worktreeState(path, base, root)).toBe("clean-merged");
    expect(await worktreeState(join(tmp, "nope"), base, root)).toBe("missing");
  });
});

gitDescribe("agent close: the worktree rule", () => {
  it("removes a clean worktree at its base, drops the agent and the registry row", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree).toMatchObject({ action: "removed", path: wt.path });
    expect(r.worktree?.branch).toBeUndefined();
    expect(existsSync(wt.path)).toBe(false);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(listWorktrees(db)).toEqual([]);
    expect(branches()).toEqual(["main"]);
    expect(gitIn(root, "worktree", "list", "--porcelain")).not.toContain(wt.path);
  });

  it("refuses a dirty worktree before killing the pane, and lists at most 10 files", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    for (let i = 0; i < 12; i++) writeFileSync(join(wt.path, `f${i}.txt`), "x");
    let caught: unknown;
    await closeAgent(db, "worker-1", { workstream: "auth" }).catch((e) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(WorktreeDirtyError);
    const msg = (caught as Error).message;
    expect(msg.match(/f\d+\.txt/g)).toHaveLength(10);
    expect(msg).toContain("+2 more");
    // nothing was touched: row, registry row, dir, and no kill-pane at all
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(getWorktreeAt(db, wt.path)).toBeDefined();
    expect(existsSync(wt.path)).toBe(true);
    expect(mux.calls.some((c) => c[0] === "kill-pane")).toBe(false);
  });

  it("refuses modified tracked files too", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    writeFileSync(join(wt.path, "README"), "changed\n");
    await expect(closeAgent(db, "worker-1", { workstream: "auth" })).rejects.toBeInstanceOf(
      WorktreeDirtyError,
    );
  });

  it("--discard removes a dirty worktree without making a branch", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    commitFileIn(wt.path, "w.txt", "own work");
    writeFileSync(join(wt.path, "u.txt"), "x");
    const r = await closeAgent(db, "worker-1", { workstream: "auth", discard: true });
    expect(r.worktree?.action).toBe("discarded");
    expect(existsSync(wt.path)).toBe(false);
    expect(branches()).toEqual(["main"]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(listWorktrees(db)).toEqual([]);
  });

  it("removes a clean worktree whose commits are already merged, with no branch", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const head = commitFileIn(wt.path, "w.txt", "own work");
    gitIn(root, "merge", "--ff-only", head);
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("removed");
    expect(branches()).toEqual(["main"]);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("keeps unmerged commits on mu/<ws>/<agent>-<sha12> in the root repo, then removes it", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const head = commitFileIn(wt.path, "w.txt", "own work");
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    const branch = `mu/auth/worker-1-${head.slice(0, 12)}`;
    expect(r.worktree).toMatchObject({ action: "kept-branch", branch });
    expect(branches()).toContain(branch);
    expect(gitIn(root, "rev-parse", branch)).toBe(head);
    expect(existsSync(wt.path)).toBe(false);
    expect(listWorktrees(db)).toEqual([]);
  });

  it("with no agent row, the same rule finishes an orphaned worktree", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    const head = commitFileIn(wt.path, "w.txt", "own work");
    deleteAgent(db, "worker-1", "auth"); // what the reaper does
    expect(getWorktreeAt(db, wt.path)).toBeDefined(); // the registry outlives the agent
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.deletedRow).toBe(false);
    expect(r.worktree?.branch).toBe(`mu/auth/worker-1-${head.slice(0, 12)}`);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("a registered worktree whose dir is gone is forgotten and closes", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    rmSync(wt.path, { recursive: true, force: true });
    const r = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(r.worktree?.action).toBe("gone");
    expect(listWorktrees(db)).toEqual([]);
    expect(gitIn(root, "worktree", "list", "--porcelain")).not.toContain(wt.path);
  });

  it("an agent without a worktree closes as before", async () => {
    await spawnAgent(db, { name: "plain-1", workstream: "auth", cwd: root });
    const r = await closeAgent(db, "plain-1", { workstream: "auth" });
    expect(r).toMatchObject({ killedPane: true, deletedRow: true, worktree: null });
  });
});

gitDescribe("spawn --worktree", () => {
  const spawn = (name = "worker-1", extra: Record<string, unknown> = {}) =>
    spawnAgent(db, { name, workstream: "auth", worktree: true, root, ...extra });

  it("records the spawner on the placeholder row and keeps it through finalize (staged UPDATE branch)", async () => {
    const saved = [
      process.env.MU_MANAGED_AGENT,
      process.env.MU_WORKSTREAM,
      process.env.MU_AGENT_NAME,
    ];
    process.env.MU_MANAGED_AGENT = "1";
    process.env.MU_WORKSTREAM = "orch-ws";
    process.env.MU_AGENT_NAME = "orch";
    try {
      const agent = await spawn();
      expect(agent.spawner).toBe("orch-ws/orch");
      expect(getAgent(db, "worker-1", "auth")?.spawner).toBe("orch-ws/orch");
    } finally {
      const keys = ["MU_MANAGED_AGENT", "MU_WORKSTREAM", "MU_AGENT_NAME"];
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });

  it("records cwd and base, registers the worktree, and starts the pane in it", async () => {
    const agent = await spawn();
    const path = worktreePath("auth", "worker-1");
    const head = gitIn(root, "rev-parse", "HEAD");
    expect(agent.cwd).toBe(path);
    expect(agent.base).toBe(head);
    expect(getAgent(db, "worker-1", "auth")).toMatchObject({ cwd: path, base: head });
    expect(getWorktreeAt(db, path)).toMatchObject({ agent: "worker-1", root, base: head });
    const call = mux.calls.find((c) => c[0] === "new-session");
    expect(call?.[call.indexOf("-c") + 1]).toBe(path);
  });

  it("records the command and its source on the worktree path too (the finalize UPDATE)", async () => {
    const agent = await spawn("worker-1", { cli: "helper", command: "pi-meta --x" });
    const row = db
      .prepare("SELECT command, command_source AS src FROM agents WHERE name = 'worker-1'")
      .get();
    expect(row).toEqual({ command: "pi-meta --x", src: "explicit" });
    expect(agent).toMatchObject({ command: "pi-meta --x", commandSource: "explicit" });
    const plain = await spawn("worker-2");
    expect(plain).toMatchObject({ command: "pi", commandSource: "cli-key" });
    expect(
      db.prepare("SELECT command, command_source AS src FROM agents WHERE name = 'worker-2'").get(),
    ).toEqual({ command: "pi", src: "cli-key" });
  });

  it("--from starts at that ref", async () => {
    const first = gitIn(root, "rev-parse", "HEAD");
    commitFileIn(root, "later.txt", "later");
    const agent = await spawn("worker-1", { from: first });
    expect(agent.base).toBe(first);
  });

  it("defaults the root to the git toplevel of the caller's cwd", async () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth", worktree: true });
      expect(getWorktreeAt(db, agent.cwd ?? "")?.root).toBe(root);
    } finally {
      process.chdir(cwd);
    }
  });

  describe("from a linked checkout", () => {
    let linked: string;
    let linkedHead: string;
    beforeEach(() => {
      linked = join(tmp, "caller-checkout");
      gitIn(root, "worktree", "add", "--detach", linked);
      linkedHead = commitFileIn(linked, "caller-only.txt", "caller only");
      commitFileIn(root, "main-only.txt", "main moved");
    });

    it("bases on the caller's HEAD by default, and still registers the owning checkout", async () => {
      const cwd = process.cwd();
      process.chdir(linked);
      try {
        const agent = await spawnAgent(db, {
          name: "nested-1",
          workstream: "auth",
          worktree: true,
        });
        expect(agent.base).toBe(linkedHead);
        expect(existsSync(join(agent.cwd ?? "", "caller-only.txt"))).toBe(true);
        expect(existsSync(join(agent.cwd ?? "", "main-only.txt"))).toBe(false);
        expect(getWorktreeAt(db, agent.cwd ?? "")?.root).toBe(root);
      } finally {
        process.chdir(cwd);
      }
    });

    it("an explicit --root that is a linked checkout bases on its HEAD, with or without --from HEAD", async () => {
      const a = await spawn("nested-2", { root: linked });
      expect(a.base).toBe(linkedHead);
      const b = await spawn("nested-3", { root: linked, from: "HEAD" });
      expect(b.base).toBe(linkedHead);
      expect(getWorktreeAt(db, b.cwd ?? "")?.root).toBe(root);
    });
  });

  it("a root outside a git repo throws WorktreeVcsRequiredError and leaves nothing", async () => {
    const plain = join(tmp, "plain");
    execFileSync("mkdir", ["-p", plain]);
    await expect(spawn("worker-1", { root: plain })).rejects.toBeInstanceOf(
      WorktreeVcsRequiredError,
    );
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(livePanes()).toEqual([]);
    expect(existsSync(worktreePath("auth", "worker-1"))).toBe(false);
  });

  it("without --worktree the pane starts in --cwd (default: the caller's) and the row records it", async () => {
    const a = await spawnAgent(db, { name: "plain-1", workstream: "auth", cwd: root });
    expect(a.cwd).toBe(root);
    expect(a.base).toBeNull();
    const b = await spawnAgent(db, { name: "plain-2", workstream: "auth" });
    expect(b.cwd).toBe(process.cwd());
  });

  describe("rollback", () => {
    const failOn = (verb: string) => {
      mux.restore();
      const inner = mockTmux(tmuxState).executor;
      mux = installMux("tmux", async (args) =>
        args[0] === verb
          ? { stdout: "", stderr: `mock: ${verb} refused`, exitCode: 1 }
          : inner(args),
      );
    };

    it("removes the worktree, its registry row and the agent when pane creation throws", async () => {
      failOn("new-session");
      await expect(spawn()).rejects.toThrow();
      expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
      expect(listWorktrees(db)).toEqual([]);
      expect(existsSync(worktreePath("auth", "worker-1"))).toBe(false);
      expect(gitIn(root, "worktree", "list", "--porcelain")).not.toContain("worker-1");
    });

    it("also when finalize fails after the pane exists", async () => {
      db.exec(
        "CREATE TRIGGER fail_finalize BEFORE UPDATE ON agents BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      await expect(spawn()).rejects.toThrow();
      expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
      expect(listWorktrees(db)).toEqual([]);
      expect(existsSync(worktreePath("auth", "worker-1"))).toBe(false);
    });

    it("a failed removal keeps the registry row; `agent close --discard` then finishes it", async () => {
      // pane creation fails AND the worktree is locked, so the rollback's removal fails too
      mux.restore();
      const inner = mockTmux(tmuxState).executor;
      mux = installMux("tmux", async (args) => {
        if (args[0] !== "new-session") return inner(args);
        gitIn(root, "worktree", "lock", worktreePath("auth", "worker-1"));
        return { stdout: "", stderr: "mock: new-session refused", exitCode: 1 };
      });
      const err = await spawn().catch((e) => e);
      const cmds = (err.errorNextSteps() as { command: string }[]).map((s) => s.command).join("\n");
      expect(cmds).toContain("mu agent close worker-1 -w auth --discard");
      expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
      expect(listWorktrees(db)).toHaveLength(1); // still registered
      gitIn(root, "worktree", "unlock", worktreePath("auth", "worker-1"));
      const r = await closeAgent(db, "worker-1", { workstream: "auth", discard: true });
      expect(r.worktree?.action).toBe("discarded");
      expect(listWorktrees(db)).toEqual([]);
      expect(existsSync(worktreePath("auth", "worker-1"))).toBe(false);
    });
  });

  describe("name reuse", () => {
    it("reuses its own clean leftover (HEAD == base) after the agent row is gone", async () => {
      const first = await spawn();
      deleteAgent(db, "worker-1", "auth"); // reaped
      const again = await spawn();
      expect(again.cwd).toBe(first.cwd);
      expect(branches()).toEqual(["main"]); // reuse never makes a branch
      expect(listWorktrees(db)).toHaveLength(1);
    });

    it("refuses a dirty leftover with one line and keeps it", async () => {
      const first = await spawn();
      deleteAgent(db, "worker-1", "auth");
      writeFileSync(join(first.cwd ?? "", "u.txt"), "x");
      const err = await spawn().catch((e) => e);
      expect(err).toBeInstanceOf(WorktreePathNotEmptyError);
      expect((err as Error).message.split("\n")).toHaveLength(1);
      expect(existsSync(join(first.cwd ?? "", "u.txt"))).toBe(true);
      expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    });

    it("refuses a leftover with commits of its own (HEAD not in {base, last collected head})", async () => {
      const first = await spawn();
      deleteAgent(db, "worker-1", "auth");
      commitFileIn(first.cwd ?? "", "w.txt", "own work");
      await expect(spawn()).rejects.toBeInstanceOf(WorktreePathNotEmptyError);
      expect(existsSync(first.cwd ?? "")).toBe(true);
      expect(branches()).toEqual(["main"]);
    });

    it("accepts a leftover at the last collected head", async () => {
      const first = await spawn();
      deleteAgent(db, "worker-1", "auth");
      const head = commitFileIn(first.cwd ?? "", "w.txt", "collected work");
      db.prepare("UPDATE worktrees SET last_collected_head = ? WHERE path = ?").run(
        head,
        first.cwd,
      );
      const again = await spawn();
      expect(again.cwd).toBe(first.cwd);
    });

    it("refuses a dir mu did not register", async () => {
      const path = worktreePath("auth", "worker-1");
      await createWorktree({ root, path });
      await expect(spawn()).rejects.toBeInstanceOf(WorktreePathNotEmptyError);
      expect(existsSync(path)).toBe(true);
    });

    it("a registry row whose dir was removed by hand does not block the name", async () => {
      const first = await spawn();
      deleteAgent(db, "worker-1", "auth");
      rmSync(first.cwd ?? "", { recursive: true, force: true });
      const again = await spawn();
      expect(again.cwd).toBe(first.cwd);
      expect(listWorktrees(db)).toHaveLength(1);
    });

    it("reclaiming a path whose dir is gone forgets the stale registry row itself", async () => {
      const first = await spawn();
      deleteAgent(db, "worker-1", "auth");
      rmSync(first.cwd ?? "", { recursive: true, force: true });
      await reclaimWorktreePath(db, {
        agent: "worker-1",
        workstream: "auth",
        path: first.cwd ?? "",
      });
      expect(listWorktrees(db)).toEqual([]);
    });

    it("the reaper (reconcile) never touches the worktree or its registry row", async () => {
      const first = await spawn();
      tmuxState.panes.clear(); // the pane died: reconcile prunes the ghost row
      const view = await listLiveAgents(db, { workstream: "auth" });
      expect(view.report.prunedGhosts).toBe(1);
      expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
      expect(existsSync(first.cwd ?? "")).toBe(true);
      expect(getWorktreeAt(db, first.cwd ?? "")).toBeDefined();
    });
  });
});

gitDescribe("workstream teardown", () => {
  it("never removes a worktree: clean, unmerged and dirty all stay on disk and registered", async () => {
    const clean = await seedWorktree(db, {
      root,
      workstream: "auth",
      agent: "clean-1",
      paneId: "%1",
    });
    const unmerged = await seedWorktree(db, {
      root,
      workstream: "auth",
      agent: "own-1",
      paneId: "%2",
    });
    const dirty = await seedWorktree(db, {
      root,
      workstream: "auth",
      agent: "dirty-1",
      paneId: "%3",
    });
    commitFileIn(unmerged.path, "w.txt", "own work");
    writeFileSync(join(dirty.path, "u.txt"), "precious");

    const r = await softTeardown(db, "auth");

    expect(r.keptWorktrees.map((w) => w.agent).sort()).toEqual(["clean-1", "dirty-1", "own-1"]);
    for (const wt of [clean, unmerged, dirty]) expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(dirty.path, "u.txt"))).toBe(true);
    expect(
      listWorktrees(db)
        .map((w) => w.agent)
        .sort(),
    ).toEqual(["clean-1", "dirty-1", "own-1"]);
    // no branch was made for the unmerged commits either
    expect(gitIn(root, "branch", "--list", "mu/*").trim()).toBe("");
  });

  it("a registered worktree whose dir is already gone stays registered too", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    rmSync(wt.path, { recursive: true, force: true });
    const r = await softTeardown(db, "auth");
    expect(r.keptWorktrees).toEqual([{ agent: "worker-1", path: wt.path }]);
    expect(listWorktrees(db).map((w) => w.agent)).toEqual(["worker-1"]);
  });
});

const LEGACY_DDL = `
CREATE TABLE vcs_workspaces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  backend       TEXT NOT NULL CHECK (backend IN ('jj', 'sl', 'git', 'none')),
  path          TEXT NOT NULL UNIQUE,
  parent_ref    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_vcs_workspaces_workstream ON vcs_workspaces (workstream_id);`;

const tableNames = (d: Db) =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (t) => t.name,
  );

gitDescribe("schema: vcs_workspaces is migrated into worktrees", () => {
  /** What the pre-worktree build wrote: a live agent, a git workspace row, agents.cwd/base unset. */
  async function legacyDb(): Promise<{ path: string; ws: string; base: string }> {
    const path = join(tmp, "old.db");
    const ws = join(stateDir, "workspaces", "smoke", "legacy-1");
    const base = gitIn(root, "rev-parse", "HEAD");
    execFileSync("mkdir", ["-p", join(stateDir, "workspaces", "smoke")]);
    gitIn(root, "worktree", "add", "--detach", ws);
    const first = openDb({ path });
    first.exec(LEGACY_DDL);
    ensureWorkstreamRow(first, "smoke");
    insertAgentRow(first, "smoke", "legacy-1");
    const wsId = (
      first.prepare("SELECT id FROM workstreams WHERE name='smoke'").get() as { id: number }
    ).id;
    const agentId = (
      first.prepare("SELECT id FROM agents WHERE name='legacy-1'").get() as { id: number }
    ).id;
    first
      .prepare(
        "INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at) VALUES (?, ?, 'git', ?, ?, '2026-10-01T00:00:00.000Z')",
      )
      .run(agentId, wsId, ws, base);
    first.close();
    return { path, ws, base };
  }

  it("a dirty legacy workspace is registered, and close still refuses it before killing the pane", async () => {
    const { path, ws, base } = await legacyDb();
    writeFileSync(join(ws, "precious.txt"), "do not lose");
    const migrated = openDb({ path });
    try {
      expect(tableNames(migrated)).not.toContain("vcs_workspaces");
      expect(getWorktreeAt(migrated, ws)).toMatchObject({
        agent: "legacy-1",
        workstream: "smoke",
        base,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      expect(getAgent(migrated, "legacy-1", "smoke")).toMatchObject({ cwd: ws, base });
      await expect(
        closeAgent(migrated, "legacy-1", { workstream: "smoke" }),
      ).rejects.toBeInstanceOf(WorktreeDirtyError);
      expect(getAgent(migrated, "legacy-1", "smoke")).toBeDefined();
      expect(mux.calls.some((c) => c[0] === "kill-pane")).toBe(false);
      expect(existsSync(join(ws, "precious.txt"))).toBe(true);
      // the registry outlives the agent
      deleteAgent(migrated, "legacy-1", "smoke");
      expect(getWorktreeAt(migrated, ws)).toBeDefined();
    } finally {
      migrated.close();
    }
  });

  it("a clean legacy workspace closes and is removed; a second open writes nothing", async () => {
    const { path, ws } = await legacyDb();
    const first = openDb({ path });
    const cookie = first.pragma("schema_version", { simple: true });
    first.close();
    const second = openDb({ path });
    try {
      expect(second.pragma("schema_version", { simple: true })).toBe(cookie);
      expect(listWorktrees(second)).toHaveLength(1);
      const r = await closeAgent(second, "legacy-1", { workstream: "smoke" });
      expect(r.worktree).toMatchObject({ action: "removed", path: ws });
      expect(existsSync(ws)).toBe(false);
    } finally {
      second.close();
    }
  });

  it("v11 source (attached, no agents.cwd/base): rows are carried and a dirty orphan close refuses", async () => {
    const ws = join(stateDir, "workspaces", "smoke", "legacy-1");
    execFileSync("mkdir", ["-p", join(stateDir, "workspaces", "smoke")]);
    gitIn(root, "worktree", "add", "--detach", ws);
    const base = gitIn(root, "rev-parse", "HEAD");
    writeFileSync(join(ws, "precious.txt"), "do not lose");
    const v11 = join(tmp, "v11.db");
    const src = new Database(v11);
    src.exec(`
      CREATE TABLE workstreams (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE agents (id INTEGER PRIMARY KEY, workstream_id INTEGER, name TEXT);
      ${LEGACY_DDL}
      INSERT INTO workstreams VALUES (1, 'smoke');
      INSERT INTO agents VALUES (1, 1, 'legacy-1');
      INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
        VALUES (1, 1, 'git', '${ws}', '${base}', '2026-10-01T00:00:00.000Z');
      INSERT INTO agents VALUES (2, 1, 'jj-1');
      INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
        VALUES (2, 1, 'jj', '/nope/jj-1', 'abc', '2026-10-01T00:00:00.000Z');`);
    src.close();
    db.exec(`ATTACH '${v11}' AS old`);
    migrateLegacyWorkspaces(db, "old");
    db.exec("DETACH old");
    expect(listWorktrees(db).map((w) => [w.agent, w.workstream, w.path, w.base])).toEqual([
      ["legacy-1", "smoke", ws, base],
    ]);
    await expect(closeAgent(db, "legacy-1", { workstream: "smoke" })).rejects.toBeInstanceOf(
      WorktreeDirtyError,
    );
    expect(existsSync(join(ws, "precious.txt"))).toBe(true);
  });

  it("a DB with an empty old table just loses it, then opens without a write", () => {
    const path = join(tmp, "empty.db");
    const first = openDb({ path });
    first.exec(LEGACY_DDL);
    first.close();
    const second = openDb({ path });
    expect(tableNames(second)).not.toContain("vcs_workspaces");
    const cookie = second.pragma("schema_version", { simple: true });
    second.close();
    const third = openDb({ path });
    expect(third.pragma("schema_version", { simple: true })).toBe(cookie);
    third.close();
  });
});

function ensureWorkstreamRow(d: Db, name: string): void {
  ensureWorkstream(d, name);
}
function insertAgentRow(d: Db, workstream: string, name: string): void {
  insertAgent(d, { name, workstream, paneId: "%1" });
}
