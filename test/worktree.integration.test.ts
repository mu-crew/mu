// Per-agent git worktrees (src/worktree.ts): create, the close rule (dirty
// refuses, merged removes, unmerged keeps a branch, --discard overrides),
// name reuse, spawn rollback, teardown, and the registry that outlives the
// agent. Real git; the multiplexer is the mock tmux, so no pane is real.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSpawnLock } from "../src/agents/spawn-lock.js";
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
import { ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import {
  createWorktree,
  getWorktreeAt,
  listWorktrees,
  reclaimWorktreePath,
  registerWorktree,
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

gitDescribe("a staged spawn parked on the session lock", () => {
  it.each(["%77", "%pending-worker-1"])(
    "does not unlink the socket of a replacement that took the name (placeholder closed meanwhile; replacement on %s)",
    async (replacementPane) => {
      const sock = ctlSocketPath("auth", "worker-1", dirname(join(tmp, "mu.db")));
      let spawned: Promise<unknown> = Promise.resolve();
      await withSpawnLock("mu-auth", async () => {
        spawned = spawnAgent(db, {
          name: "worker-1",
          workstream: "auth",
          worktree: true,
          root,
        }).catch((e) => e);
        for (let i = 0; i < 200 && getAgent(db, "worker-1", "auth") === undefined; i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
        const placeholder = getAgent(db, "worker-1", "auth");
        expect(placeholder?.paneId).toMatch(/^%pending-/);
        // Staging is done and its agent lock released; the close frees the name.
        deleteAgent(db, "worker-1", "auth");
        insertAgent(db, { name: "worker-1", workstream: "auth", paneId: replacementPane });
        mkdirSync(dirname(sock), { recursive: true });
        writeFileSync(sock, "");
      });
      await spawned;
      expect(existsSync(sock)).toBe(true);
      expect(getAgent(db, "worker-1", "auth")?.paneId).toBe(replacementPane);
    },
  );
});

gitDescribe("agent close preview: the worktree", () => {
  const preview = async (name: string, ...extra: string[]) => {
    const { runCliJson } = await import("./_runCli.js");
    return runCliJson(
      ["agent", "close", name, "-w", "auth", ...extra, "--json"],
      join(tmp, "mu.db"),
    );
  };

  it("a dirty worktree is reported, kills nothing, and offers no apply (--discard is never suggested)", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    writeFileSync(join(wt.path, "u.txt"), "x");
    const r = await preview("worker-1");
    expect(r.data).toMatchObject({
      kind: "agent",
      refusesDirty: true,
      worktree: { path: wt.path, state: "dirty" },
    });
    expect(r.data.nextSteps).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(existsSync(wt.path)).toBe(true);
  });

  it("--discard previews the lossy close and its apply carries --discard and --if", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    writeFileSync(join(wt.path, "u.txt"), "x");
    const r = await preview("worker-1", "--discard");
    expect(r.data.refusesDirty).toBe(false);
    expect(r.data.nextSteps[0].command).toBe(
      `mu agent close worker-1 -w auth --discard --if ${r.data.revision}`,
    );
    expect(existsSync(wt.path)).toBe(true); // still a preview
  });

  it("an orphan worktree (no agent row) previews with its own revision; a stale --if keeps it", async () => {
    const wt = await seedWorktree(db, { root, workstream: "auth", agent: "worker-1" });
    deleteAgent(db, "worker-1", "auth");
    const r = await preview("worker-1");
    expect(r.data.kind).toBe("orphan-worktree");
    expect(r.data.revision).toBeGreaterThan(0);
    const stale = await preview("worker-1", "--if", String(r.data.revision + 1));
    expect(stale.doc).toMatchObject({ ok: false, exit: 4 });
    expect(existsSync(wt.path)).toBe(true);
    const applied = await preview("worker-1", "--if", String(r.data.revision));
    expect(applied.doc.ok).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
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

    it("never deletes a replacement registered under the name while the spawn was failing", async () => {
      // pane creation fails; meanwhile the placeholder was replaced by another agent
      mux.restore();
      mux = installMux("tmux", async (args) => {
        if (args[0] !== "new-session") return mockTmux(tmuxState).executor(args);
        deleteAgent(db, "worker-1", "auth");
        insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%77" });
        return { stdout: "", stderr: "mock: new-session refused", exitCode: 1 };
      });
      await expect(spawn()).rejects.toThrow();
      expect(getAgent(db, "worker-1", "auth")?.paneId).toBe("%77");
      // and the worktree path now belongs to the replacement's staging: kept registered
      expect(listWorktrees(db)).toHaveLength(1);
    });

    it("a worktree creation that fails after the placeholder was replaced never deletes the replacement", async () => {
      // A stale registry row at the path is forgotten during staging: the trigger stands in
      // for the other process replacing the placeholder at that moment. Creation then fails
      // (the worktrees dir is a file), and the placeholder rollback must leave the new row.
      const path = worktreePath("auth", "worker-1");
      execFileSync("mkdir", ["-p", stateDir]);
      writeFileSync(join(stateDir, "worktrees"), "not a dir");
      registerWorktree(db, {
        path,
        agent: "worker-1",
        workstream: "auth",
        root,
        base: "a",
        createdAt: "t",
      });
      ensureWorkstream(db, "auth");
      const wsId = (
        db.prepare("SELECT id FROM workstreams WHERE name = 'auth'").get() as { id: number }
      ).id;
      db.exec(`CREATE TEMP TRIGGER swap AFTER DELETE ON worktrees BEGIN
        DELETE FROM agents WHERE name = 'worker-1';
        INSERT INTO agents (name, workstream_id, pane_id, status, created_at, updated_at)
          VALUES ('worker-1', ${wsId}, '%77', 'spawning', 't', 't');
      END`);
      await expect(spawn()).rejects.toThrow();
      expect(getAgent(db, "worker-1", "auth")?.paneId).toBe("%77");
    });

    it("finalize does not patch a replacement that is itself a pending placeholder", async () => {
      const inner = mockTmux(tmuxState).executor;
      mux.restore();
      mux = installMux("tmux", async (args) => {
        const r = await inner(args);
        if (args[0] === "new-session" || args[0] === "new-window") {
          deleteAgent(db, "worker-1", "auth");
          insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%pending-worker-1" });
        }
        return r;
      });
      await expect(spawn()).rejects.toThrow(/vanished/);
      const kept = getAgent(db, "worker-1", "auth");
      expect(kept?.paneId).toBe("%pending-worker-1");
      expect(kept?.cwd).toBeNull();
    });

    it("finalize patches only the placeholder it inserted: a replaced row is not repointed", async () => {
      const inner = mockTmux(tmuxState).executor;
      mux.restore();
      mux = installMux("tmux", async (args) => {
        const r = await inner(args);
        if (args[0] === "new-session" || args[0] === "new-window") {
          deleteAgent(db, "worker-1", "auth");
          insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%77" });
        }
        return r;
      });
      await expect(spawn()).rejects.toThrow(/vanished/);
      const kept = getAgent(db, "worker-1", "auth");
      expect(kept?.paneId).toBe("%77");
      expect(kept?.cwd).toBeNull(); // not patched with this spawn's worktree
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
