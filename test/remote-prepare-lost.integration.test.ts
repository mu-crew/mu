// rr_r3_remote_prepare_orphan: a remote prepare whose answer is lost (a
// timeout, an exec template that swallows stdout) after `git worktree add`
// succeeded used to leave an untracked tree that blocked the name for good.
// The tree now carries prepare's mark in its own git dir, and the next spawn
// of the name reclaims it while it is mu's own unused leftover. Real git and a
// real `sh` exec template; the "remote" HOME is a temp dir. No pane.

import { spawn as spawnChild } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../src/cli/handle.js";
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
import { commitFileIn, copyGitFixture, gitIn } from "./_git.js";

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
  copyGitFixture(repo);
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
const prepare = async (reclaim = true, ownerDb = db) => {
  const lease = await reserveHostChannel(ownerDb, "dev", `t:${leases.length}`);
  try {
    return await prepareRemote(ownerDb, { lease }, getHost(ownerDb, "dev"), {
      workstream: "ws",
      name: "worker-1",
      worktree: true,
      reclaim,
      root: repo,
    });
  } finally {
    releaseHostChannel(ownerDb, lease);
  }
};
const marker = () => join(gitIn(wt(), "rev-parse", "--absolute-git-dir"), "mu-prepared");
const machineId = (ownerDb: Db) =>
  (ownerDb.prepare("SELECT machine_id FROM machine_identity").get() as { machine_id: string })
    .machine_id;
function addPeer(exec = "sh -c {cmd}"): Db {
  const peer = openDb({ path: join(dir, "peer.db") });
  addHost(peer, {
    name: "dev",
    shell: "true {cmd}",
    exec,
    fetch: "true",
    repo,
    max_sessions: null,
  });
  return peer;
}
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
    expect(site).toEqual({ cwd: wt(), base: head(), repo });
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
      // `held <pid> [<etime> <args>]`: ps adds the holder's age and command when it can.
      await expect(prepare()).rejects.toThrow(/\(held \d+( [^)]*)?\)/);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

describe("a failed worktree add", () => {
  it("releases its empty claim so prepare can retry", async () => {
    // Git cannot create its worktree metadata when `worktrees` is a file.
    const metadata = join(repo, ".git", "worktrees");
    writeFileSync(metadata, "block worktree registration");
    await expect(prepare()).rejects.toThrow(/exit 7/);
    unlinkSync(metadata);
    await expect(prepare()).resolves.toEqual({ cwd: wt(), base: head(), repo });
  });

  it.each(["non-empty claim", "empty replacement"])("leaves a %s alone", async (kind) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const data = join(wt(), ".keep");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = add ]; then
  ${kind === "non-empty claim" ? `printf 'keep' > "$6/.keep"` : `mv "$6" "$6.original" && mkdir "$6"`} || exit 8
  exit 1
fi
PATH=\${PATH#*:} exec git "$@"
`,
      { mode: 0o755 },
    );
    const peer = addPeer(`PATH='${bin}':"$PATH" sh -c {cmd}`);
    try {
      await expect(prepare(true, peer)).rejects.toThrow(/exit 7/);
      expect(existsSync(wt())).toBe(true);
      if (kind === "non-empty claim") expect(readFileSync(data, "utf8")).toBe("keep");
      else expect(existsSync(`${wt()}.original`)).toBe(true);
      await expect(prepare()).rejects.toThrow(/owner unknown/);
    } finally {
      peer.close();
    }
  });
});

describe("remote worktree ownership across DBs", () => {
  it("refuses another DB's tree, with or without reclaim", async () => {
    const peer = addPeer();
    try {
      await prepare();
      const owner = machineId(db);
      expect(machineId(peer)).not.toBe(owner);
      for (const reclaim of [true, false]) {
        const err = await prepare(reclaim, peer).catch((e: unknown) => e);
        expect(classifyError(err).exitCode).toBe(4);
        expect(String(err)).toContain(wt());
        expect(String(err)).toContain(owner);
        expect(String(err)).toMatch(/close.*owning DB.*remove.*by hand/);
      }
      expect(readFileSync(marker(), "utf8").trim()).toBe(owner);
      expect(gitIn(wt(), "rev-parse", "HEAD")).toBe(head());
    } finally {
      peer.close();
    }
  });

  it("names the owning DB by its sync peer prefix only after an exact match", async () => {
    const peer = addPeer();
    try {
      await prepare();
      const owner = machineId(db);
      const prefix = owner.slice(0, 8);
      const seed = peer.prepare("INSERT INTO sync_peers (machine_id) VALUES (?)");
      seed.run(`${owner}-different`);
      await expect(prepare(true, peer)).rejects.toThrow("close it from the owning DB, or");

      seed.run(owner);
      await expect(prepare(true, peer)).rejects.toThrow(
        `close it from the owning DB (sync peer ${prefix}), or`,
      );
      expect(readFileSync(marker(), "utf8").trim()).toBe(owner);
    } finally {
      peer.close();
    }
  });

  it.each(["empty", "missing"])("refuses a marker that is %s as an unknown owner", async (kind) => {
    mkdirSync(join(wt(), ".."), { recursive: true });
    gitIn(repo, "worktree", "add", "--detach", wt());
    if (kind === "empty") writeFileSync(marker(), "");
    const err = await prepare().catch((e: unknown) => e);
    expect(classifyError(err).exitCode).toBe(4);
    expect(String(err)).toContain("owner unknown");
    expect(gitIn(wt(), "rev-parse", "HEAD")).toBe(head());
  });

  it("the racing DB that saw an absent path cannot remove the winner's tree", async () => {
    const bin = join(dir, "bin");
    const entered = join(dir, "entered");
    const resume = join(dir, "resume");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "mkdir"),
      `#!/bin/sh
if [ "$1" = -p ]; then
  touch '${entered}'; while [ ! -e '${resume}' ]; do sleep 0.02; done
fi
exec /bin/mkdir "$@"
`,
      { mode: 0o755 },
    );
    const peer = addPeer(`PATH='${bin}':"$PATH" sh -c {cmd}`);
    const racing = prepare(true, peer).catch((e: unknown) => e);
    try {
      await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
      expect(await prepare()).toEqual({ cwd: wt(), base: head(), repo });
    } finally {
      writeFileSync(resume, "");
      await racing;
      peer.close();
    }
    const loser = await racing;
    expect(classifyError(loser).exitCode).toBe(4);
    expect(String(loser)).toContain(machineId(db));
    expect(gitIn(wt(), "rev-parse", "HEAD")).toBe(head());
    expect(gitIn(repo, "worktree", "list")).toContain(wt());
  });
});

describe("the repo the host reports (agents.repo)", () => {
  const prepareIn = async (root: string) => {
    const lease = await reserveHostChannel(db, "dev", `r:${leases.length}`);
    leases.push(lease);
    return prepareRemote(db, { lease }, getHost(db, "dev"), {
      workstream: "ws",
      name: "worker-1",
      worktree: true,
      root,
    });
  };

  it("a bare repo: the worktree is made and the bare repo's own path is recorded", async () => {
    const bare = join(dir, "bare.git");
    gitIn(dir, "clone", "-q", "--bare", repo, bare);
    const site = await prepareIn(bare);
    expect(site).toEqual({ cwd: wt(), base: head(), repo: bare });
    expect(gitIn(bare, "worktree", "list")).toContain(wt());
  });

  it("a path with a trailing space and a newline comes back byte for byte", async () => {
    const odd = join(dir, "odd repo \nx");
    gitIn(dir, "clone", "-q", repo, odd);
    const site = await prepareIn(odd);
    expect(site.repo).toBe(odd);
  });
});
