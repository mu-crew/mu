// bug_spawn_worktree_abort_cleanup: a `mu agent spawn --worktree` killed
// while `git worktree add` runs (a delegate abort, a SIGTERM) must roll back
// like a thrown error: no placeholder row, no partial worktree, no live git
// child, and the name spawnable again. A SIGKILL leftover is listed by
// `mu doctor` and reclaimed by the next spawn of that name.
//
// Real subprocess + real git (a post-checkout hook holds the create open).
// Needs `npm run build` (dist/cli.js). No tmux: the kill lands before the pane.

import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo } from "./_git.js";

const execFileP = promisify(execFile);
const CLI = join(process.cwd(), "dist", "cli.js");
const describeIfBuilt = existsSync(CLI) ? describe : describe.skip;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const poll = async (fn: () => boolean, tries = 100): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
};

describeIfBuilt("spawn --worktree killed mid-create", () => {
  let dir: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let wt: string;
  let hookPid: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-abort-"));
    repo = join(dir, "repo");
    execFileSync("mkdir", ["-p", repo]);
    initGitRepo(repo);
    hookPid = join(dir, "hook.pid");
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\necho $$ > ${hookPid}\nexec sleep 20\n`);
    chmodSync(hook, 0o755);
    env = {
      ...process.env,
      MU_DB_PATH: join(dir, "mu.db"),
      MU_SYNC_DIR: "",
      XDG_STATE_HOME: join(dir, "state"),
      MU_SPAWN_LIVENESS_MS: "0",
    };
    wt = join(dir, "state", "mu-next", "worktrees", "ab", "a1");
  });

  afterEach(() => {
    try {
      const pid = Number(readFileSync(hookPid, "utf8"));
      if (alive(pid)) process.kill(pid, "SIGKILL");
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  const startSpawn = () =>
    spawn(
      process.execPath,
      [CLI, "agent", "spawn", "a1", "-w", "ab", "--worktree", "--command", "sh", "--json"],
      { cwd: repo, env, stdio: "ignore" },
    );
  const rows = () => {
    const db = new Database(join(dir, "mu.db"), { readonly: true });
    try {
      const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      return {
        agents: n("SELECT count(*) n FROM agents"),
        worktrees: n("SELECT count(*) n FROM worktrees"),
      };
    } finally {
      db.close();
    }
  };
  const gitWorktrees = () =>
    execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith("worktree "));

  it("SIGTERM during git worktree add rolls back: no row, no dir, no git child; the name spawns again", async () => {
    const child = startSpawn();
    expect(await poll(() => existsSync(hookPid))).toBe(true);
    const hook = Number(readFileSync(hookPid, "utf8"));
    const exit = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    child.kill("SIGTERM");
    expect(await exit).toBe(143);
    expect(alive(hook)).toBe(false); // git's hook (its child) was killed with it
    expect(rows()).toEqual({ agents: 0, worktrees: 0 });
    expect(existsSync(wt)).toBe(false);
    expect(gitWorktrees()).toHaveLength(1);
  }, 20_000);

  it("a SIGKILL leftover is listed by doctor and reclaimed by the next spawn of the name", async () => {
    const child = startSpawn();
    expect(await poll(() => existsSync(hookPid))).toBe(true);
    const exit = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exit;
    process.kill(Number(readFileSync(hookPid, "utf8")), "SIGKILL");
    expect(rows().agents).toBe(1);
    // Age the placeholder past the staging window, as a dead spawn would be.
    const db = new Database(join(dir, "mu.db"));
    db.prepare("UPDATE agents SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    db.close();
    // ...and its agent lock (the dead holder's), which goes stale after 30 s.
    const lock = join(dir, "locks", "agent-ab.a1.lock");
    if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));
    const doc = await execFileP(process.execPath, [CLI, "doctor", "--json"], {
      cwd: repo,
      env,
    }).catch((e: { stdout: string }) => e);
    const staging = (
      JSON.parse(doc.stdout) as {
        data: { disk: { name: string; severity: string; remediation: string[] }[] };
      }
    ).data.disk.find((h) => h.name === "ws-staging");
    expect(staging?.severity).toBe("warn");
    expect(staging?.remediation.join("\n")).toContain(`ab/a1  ${wt}`);
    // The next spawn in the workstream reclaims it before anything else; an
    // unresolvable --cli then stops it before any worktree or pane.
    const r = await execFileP(
      process.execPath,
      [CLI, "agent", "spawn", "a1", "-w", "ab", "--worktree", "--cli", "no-such-cli-mu", "--json"],
      { cwd: repo, env },
    ).catch((e: { stdout: string }) => e);
    expect(r.stdout).toContain("AgentSpawnCliNotFoundError");
    expect(rows()).toEqual({ agents: 0, worktrees: 0 });
    expect(existsSync(wt)).toBe(false);
    expect(gitWorktrees()).toHaveLength(1);
  }, 20_000);
});
