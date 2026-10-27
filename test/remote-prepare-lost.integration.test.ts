// rr_r3_remote_prepare_orphan: a remote prepare whose answer is lost (a
// timeout, an exec template that swallows stdout) after `git worktree add`
// succeeded used to leave an untracked tree that blocked the name for good.
// The tree now carries prepare's mark in its own git dir, and the next spawn
// of the name reclaims it while it is mu's own unused leftover. Real git and a
// real `sh` exec template; the "remote" HOME is a temp dir. No pane.

import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  addHost,
  getHost,
  type HostLease,
  releaseHostChannel,
  reserveHostChannel,
} from "../src/hosts.js";
import { prepareRemote, RemotePrepareError } from "../src/remote-agent.js";
import { rmFixtureDir } from "./_fs.js";
import { commitFileIn, gitIn, initGitRepo } from "./_git.js";

let dir: string;
let home: string;
let repo: string;
let db: Db;
let savedHome: string | undefined;
const leases: HostLease[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mrpl-")));
  home = join(dir, "home");
  repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  initGitRepo(repo);
  savedHome = process.env.HOME;
  process.env.HOME = home;
  db = openDb({ path: join(dir, "mu.db") });
  writeFileSync(join(dir, "mode"), "ok");
  addHost(db, {
    name: "dev",
    shell: "true {cmd}",
    // `lost` runs the command but throws its answer away (the reviewer's repro).
    exec: `sh -c 'if [ "$(cat ${join(dir, "mode")})" = lost ]; then sh -c "$1" >/dev/null; else sh -c "$1"; fi' _ {cmd}`,
    fetch: "true",
    repo,
    max_sessions: null,
  });
});

afterEach(() => {
  for (const l of leases.splice(0)) releaseHostChannel(db, l);
  db.close();
  rmFixtureDir(dir);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

const wt = () => join(home, ".local", "state", "mu-next", "remote-worktrees", "ws", "worker-1");
const prepare = async (reclaim = true) => {
  const lease = await reserveHostChannel(db, "dev", `t:${leases.length}`);
  leases.push(lease);
  return prepareRemote(db, lease, getHost(db, "dev"), {
    workstream: "ws",
    name: "worker-1",
    worktree: true,
    reclaim,
  });
};
const lose = () => writeFileSync(join(dir, "mode"), "lost");
const answer = () => writeFileSync(join(dir, "mode"), "ok");
const head = () => gitIn(repo, "rev-parse", "HEAD");

describe("a lost prepare answer", () => {
  it("leaves a tree the next spawn of the name reclaims (same path, same base)", async () => {
    lose();
    const err = await prepare().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemotePrepareError);
    expect((err as Error).message).toContain("spawning worker-1 again reclaims it");
    expect(existsSync(wt())).toBe(true);
    answer();
    const site = await prepare();
    expect(site).toEqual({ cwd: wt(), base: head() });
    expect(gitIn(repo, "worktree", "list")).toContain(wt());
  });

  it("a leftover with work in it is never reclaimed", async () => {
    lose();
    await prepare().catch(() => undefined);
    answer();
    writeFileSync(join(wt(), "u.txt"), "x");
    await expect(prepare()).rejects.toThrow(/uncommitted work/);
    commitFileIn(wt(), "u.txt", "own");
    await expect(prepare()).rejects.toThrow(/HEAD is not/);
    expect(existsSync(join(wt(), "u.txt"))).toBe(true);
  });

  it("a tree mu's prepare did not make refuses as before", async () => {
    mkdirSync(join(wt(), ".."), { recursive: true });
    gitIn(repo, "worktree", "add", "--detach", wt());
    await expect(prepare()).rejects.toThrow(/not made by mu/);
  });

  it("without reclaim (a recovery record names the path) the leftover refuses", async () => {
    lose();
    await prepare().catch(() => undefined);
    answer();
    await expect(prepare(false)).rejects.toThrow(/already exists/);
  });

  it("a process still inside the leftover refuses (nothing reclaimed under a writer)", async () => {
    if (!existsSync("/proc/self")) return; // the scan needs /proc or lsof
    lose();
    await prepare().catch(() => undefined);
    answer();
    const holder = spawnChild("sleep", ["30"], { cwd: wt(), stdio: "ignore" });
    try {
      await expect(prepare()).rejects.toThrow(/\(held \d+\)/);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});
