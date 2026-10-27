// `agent collect` and the remote half of `agent close` against REAL git
// (v_remote_collect), with no real host: the "remote" is a repo in a temp dir,
// the profile's `exec` is `sh -c`, and `fetch` is a local `git fetch` of the
// remote worktree's path into a local clone. The mux is the fake tmux (a pane
// is just a row in a map), so the lease and kill order are the real code.
// Pins what the fast tier cannot: the pinned ref is a real ref, a no-op or
// stale fetch is refused, FETCH_HEAD is never shared, the removal is a real
// `git worktree remove` that refuses real dirt and a real moved HEAD.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentReplacedError } from "../src/agents/errors.js";
import { closeAgent, getAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, admitHostChannel, bindHostChannel, listHostChannels } from "../src/hosts.js";
import {
  asideOf,
  closeRemoteWorktree,
  RemoteCloseRefusedError,
  removeRemoteWorktree,
} from "../src/remote-agent.js";
import { collectRef, collectRemoteAgent, RemoteCollectError } from "../src/remote-collect.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { commitFileIn, gitIn, gitSupportsReftable, initGitRepo } from "./_git.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let remote: string;
let local: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let base: string;

const wtPath = (name: string): string => join(dir, "wts", name);
const ref = (name: string): string => collectRef("auth", name);
const localRef = (name: string): string | undefined => {
  try {
    return gitIn(local, "rev-parse", "--verify", "-q", ref(name));
  } catch {
    return undefined;
  }
};
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A remote worktree at `wtPath(name)` (as `spawn --worktree` makes it) and its agent row, with or without a live pane holding the channel. */
async function remoteAgent(name: string, o: { host?: string; pane?: boolean } = {}) {
  const host = o.host ?? "wide";
  gitIn(remote, "worktree", "add", "--detach", wtPath(name), base);
  const pane = `%${state.nextPaneId++}`;
  if (o.pane !== false) state.panes.set(pane, { windowId: "@1", paneId: pane, command: "ssh" });
  const row = insertAgent(db, {
    name,
    workstream: "auth",
    paneId: pane,
    cwd: wtPath(name),
    base,
    host,
  });
  if (o.pane !== false) {
    const { lease } = await admitHostChannel(db, host, `spawn:auth/${name}`);
    bindHostChannel(db, lease, { agentId: row.incarnation, paneId: pane });
  }
  return row;
}
const collect = (name: string) => collectRemoteAgent(db, { workstream: "auth", name, repo: local });
const close = (name: string, over: { keepBranch?: boolean; discard?: boolean } = {}) =>
  closeAgent(db, name, { workstream: "auth", ...over });
const commitIn = (name: string, file: string): string => commitFileIn(wtPath(name), file, file);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mrci-")));
  remote = join(dir, "remote");
  local = join(dir, "local");
  mkdirSync(remote);
  initGitRepo(remote);
  base = gitIn(remote, "rev-parse", "HEAD");
  gitIn(dir, "clone", "-q", remote, local);
  mkdirSync(join(dir, "wts"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "auth");
  const exec = join(dir, "exec.sh");
  // `hook` (if present) runs once, right before a `worktree remove`: a HEAD moving between the check and the removal.
  writeFileSync(
    exec,
    `#!/bin/sh
case "$1" in *'worktree remove'*) [ -f '${dir}/hook' ] && { sh '${dir}/hook'; rm -f '${dir}/hook'; } ;; esac
exec sh -c "$1"
`,
  );
  chmodSync(exec, 0o755);
  for (const [name, cap] of [
    ["wide", null],
    ["dev", 1],
  ] as const) {
    addHost(db, {
      name,
      shell: "true",
      exec: `/bin/sh ${exec} {cmd}`,
      // The "remote" path is local: a plain fetch of it. `gate` (if present) holds the fetch open.
      fetch: `if [ -f '${dir}/gate' ]; then touch '${dir}/started-'$$; while [ -f '${dir}/gate' ]; do sleep 0.02; done; fi; if [ -f '${dir}/nofetch' ]; then exit 0; fi; if [ -f '${dir}/failfetch' ]; then echo 'ssh: no route' >&2; exit 128; fi; git fetch -q {cwd} HEAD`,
      repo: remote,
      max_sessions: cap,
    });
  }
  state = freshMockState();
  mux = installMux("tmux", mockTmux(state).executor);
});

afterEach(() => {
  mux.restore();
  db.close();
  rmFixtureDir(dir);
});

describe("collect", () => {
  it("fetches the worktree's HEAD, pins it under refs/mu/collect/<ws>/<agent>, records it, prints the exact sha", async () => {
    await remoteAgent("worker-1");
    const head = commitIn("worker-1", "a.txt");
    const r = await collect("worker-1");
    expect(r).toMatchObject({
      head,
      ref: ref("worker-1"),
      changed: true,
      merge: `git merge ${head}`,
    });
    expect(localRef("worker-1")).toBe(head);
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBe(head);
    // The pin survives a gc of an otherwise unreferenced commit.
    gitIn(local, "gc", "-q", "--prune=now");
    expect(gitIn(local, "cat-file", "-t", head)).toBe("commit");
  });

  it("is idempotent for an unchanged HEAD and advances for a new one", async () => {
    await remoteAgent("worker-1");
    const first = commitIn("worker-1", "a.txt");
    await collect("worker-1");
    expect(await collect("worker-1")).toMatchObject({ head: first, changed: false });
    const second = commitIn("worker-1", "b.txt");
    expect(await collect("worker-1")).toMatchObject({ head: second, changed: true });
    expect(localRef("worker-1")).toBe(second);
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBe(second);
  });

  it("a worktree still at its base collects as unchanged", async () => {
    await remoteAgent("worker-1");
    expect(await collect("worker-1")).toMatchObject({ head: base, changed: false });
  });

  it("a failing fetch records nothing and pins nothing", async () => {
    await remoteAgent("worker-1");
    commitIn("worker-1", "a.txt");
    writeFileSync(join(dir, "failfetch"), "");
    const err = await collect("worker-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCollectError);
    expect((err as Error).message).toContain("no route");
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBeNull();
    expect(localRef("worker-1")).toBeUndefined();
    expect(listHostChannels(db, "wide")).toHaveLength(1); // only the pane's own
  });

  it("a template that succeeds without fetching is refused, even with a stale FETCH_HEAD", async () => {
    await remoteAgent("worker-1");
    commitIn("worker-1", "a.txt");
    await collect("worker-1"); // leaves FETCH_HEAD in the local repo
    commitIn("worker-1", "b.txt");
    writeFileSync(join(dir, "nofetch"), "");
    const err = await collect("worker-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCollectError);
    expect((err as Error).message).toMatch(/no commit/);
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).not.toBeNull();
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBe(localRef("worker-1"));
  });

  it("the fetch runs in the LOCAL repo, not the caller's directory", async () => {
    await remoteAgent("worker-1");
    const head = commitIn("worker-1", "a.txt");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    const prev = process.cwd();
    process.chdir(elsewhere);
    try {
      await collect("worker-1");
    } finally {
      process.chdir(prev);
    }
    expect(localRef("worker-1")).toBe(head);
  });

  it("two agents collected at once each get their own commit (FETCH_HEAD is not shared)", async () => {
    await remoteAgent("worker-1");
    await remoteAgent("worker-2");
    const h1 = commitIn("worker-1", "one.txt");
    const h2 = commitIn("worker-2", "two.txt");
    const [r1, r2] = await Promise.all([collect("worker-1"), collect("worker-2")]);
    expect(r1.head).toBe(h1);
    expect(r2.head).toBe(h2);
    expect(localRef("worker-1")).toBe(h1);
    expect(localRef("worker-2")).toBe(h2);
  });

  it("a name replaced while the fetch runs is not recorded onto the replacement, and its pin is dropped", async () => {
    const old = await remoteAgent("worker-1");
    commitIn("worker-1", "a.txt");
    writeFileSync(join(dir, "gate"), "");
    const pending = collect("worker-1").catch((e: unknown) => e);
    await until(() => readdirSync(dir).some((f) => f.startsWith("started-")), "the fetch to start");
    db.prepare("DELETE FROM agents WHERE id = ?").run(old.incarnation);
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%99",
      host: "wide",
      cwd: wtPath("worker-1"),
      base,
    });
    rmSync(join(dir, "gate"));
    expect(await pending).toBeInstanceOf(AgentReplacedError);
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBeNull();
    expect(localRef("worker-1")).toBeUndefined();
  });

  it("at --max-sessions 1 a live pane blocks it; once the pane is gone it works", async () => {
    await remoteAgent("worker-1", { host: "dev" });
    const head = commitIn("worker-1", "a.txt");
    await expect(collect("worker-1")).rejects.toThrow(/at --max-sessions 1/);
    state.panes.clear(); // the pane died: admission reclaims its channel
    expect((await collect("worker-1")).head).toBe(head);
    expect(listHostChannels(db, "dev")).toEqual([]);
  });
});

describe("close", () => {
  it("removes a clean worktree at its base with a real, non-forced `git worktree remove`", async () => {
    await remoteAgent("worker-1", { host: "dev" });
    const r = await close("worker-1");
    expect(r.worktree).toMatchObject({ action: "removed" });
    expect(existsSync(wtPath("worker-1"))).toBe(false);
    expect(gitIn(remote, "worktree", "list")).not.toContain("worker-1");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(listHostChannels(db, "dev")).toEqual([]);
  });

  it("removes a worktree whose HEAD was collected", async () => {
    await remoteAgent("worker-1");
    commitIn("worker-1", "a.txt");
    await collect("worker-1");
    expect((await close("worker-1")).worktree).toMatchObject({ action: "removed" });
    expect(existsSync(wtPath("worker-1"))).toBe(false);
  });

  it("a commit made after the collect refuses; the worktree and row stay; --discard does not override", async () => {
    await remoteAgent("worker-1");
    commitIn("worker-1", "a.txt");
    await collect("worker-1");
    const later = commitIn("worker-1", "b.txt");
    for (const over of [{}, { discard: true }]) {
      const err = await close("worker-1", over).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteCloseRefusedError);
      expect((err as Error).message).toContain(later.slice(0, 12));
    }
    expect(existsSync(wtPath("worker-1"))).toBe(true);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("uncommitted files refuse, with --keep-branch and --discard too", async () => {
    await remoteAgent("worker-1");
    writeFileSync(join(wtPath("worker-1"), "wip.txt"), "x");
    for (const over of [{}, { keepBranch: true }, { discard: true }]) {
      await expect(close("worker-1", over)).rejects.toMatchObject({ reason: "dirty" });
    }
    expect(existsSync(join(wtPath("worker-1"), "wip.txt"))).toBe(true);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("--keep-branch makes mu/<ws>/<agent>-<sha12> at the observed HEAD in the remote repo, then removes the worktree", async () => {
    await remoteAgent("worker-1");
    const head = commitIn("worker-1", "a.txt");
    const r = await close("worker-1", { keepBranch: true });
    const branch = `mu/auth/worker-1-${head.slice(0, 12)}`;
    expect(r.worktree).toMatchObject({ action: "kept-branch", branch });
    expect(gitIn(remote, "rev-parse", `refs/heads/${branch}`)).toBe(head);
    expect(existsSync(wtPath("worker-1"))).toBe(false);
  });

  it("a branch of that name at another commit refuses and leaves the worktree", async () => {
    await remoteAgent("worker-1");
    const head = commitIn("worker-1", "a.txt");
    gitIn(remote, "branch", `mu/auth/worker-1-${head.slice(0, 12)}`, base);
    await expect(close("worker-1", { keepBranch: true })).rejects.toMatchObject({
      reason: "branch",
    });
    expect(existsSync(wtPath("worker-1"))).toBe(true);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("a HEAD that moves between the check and the removal refuses, even with --keep-branch", async () => {
    await remoteAgent("worker-1");
    writeFileSync(
      join(dir, "hook"),
      `cd '${wtPath("worker-1")}' && echo m > moved.txt && git add . && git -c user.email=t@t -c user.name=t commit -q -m moved\n`,
    );
    await expect(close("worker-1")).rejects.toMatchObject({ reason: "moved" });
    expect(existsSync(wtPath("worker-1"))).toBe(true);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("a path that is not a worktree of the profile's repo is never removed", async () => {
    await remoteAgent("worker-1");
    // Same commit as the base, so only the ownership check can refuse it.
    const foreign = join(dir, "foreign");
    gitIn(dir, "clone", "-q", remote, foreign);
    db.prepare("UPDATE agents SET cwd = ? WHERE name = 'worker-1'").run(foreign);
    await expect(close("worker-1")).rejects.toThrow(/not a worktree of/);
    expect(existsSync(join(foreign, "README"))).toBe(true);
  });

  it("an already-removed worktree closes as gone", async () => {
    await remoteAgent("worker-1");
    gitIn(remote, "worktree", "remove", wtPath("worker-1"));
    expect((await close("worker-1")).worktree).toMatchObject({ action: "gone" });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });
});

describe("rollback's remote removal (rr_fix_r3_close_v2 P1 c)", () => {
  it("a git status that fails (exit 128, empty stdout) is unknown: the tree and its files stay", async () => {
    gitIn(remote, "worktree", "add", "--detach", wtPath("worker-1"), base);
    writeFileSync(join(wtPath("worker-1"), "keep.txt"), "user's\n");
    gitIn(wtPath("worker-1"), "add", "keep.txt");
    // A corrupt index: HEAD still resolves to the base, `git status` exits 128.
    writeFileSync(gitIn(wtPath("worker-1"), "rev-parse", "--git-path", "index"), "junk");
    const gone = await removeRemoteWorktree(db, "wide", "rollback:auth/worker-1", {
      path: wtPath("worker-1"),
      base,
      root: remote,
    });
    expect(gone).toBe(false);
    expect(readFileSync(join(wtPath("worker-1"), "keep.txt"), "utf8")).toBe("user's\n");
  });

  it("a git status that fails while everything else works: still unknown, still kept", async () => {
    gitIn(remote, "worktree", "add", "--detach", wtPath("worker-1"), base);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in *' status '*) exit 128 ;; esac\nexec /usr/bin/git "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    db.prepare("UPDATE host_profiles SET exec = ? WHERE name = 'wide'").run(
      `PATH=${bin}:$PATH /bin/sh ${join(dir, "exec.sh")} {cmd}`,
    );
    const gone = await removeRemoteWorktree(db, "wide", "rollback:auth/worker-1", {
      path: wtPath("worker-1"),
      base,
      root: remote,
    });
    expect(gone).toBe(false);
    expect(existsSync(wtPath("worker-1"))).toBe(true);
  });

  it("a clean tree at its base is removed", async () => {
    gitIn(remote, "worktree", "add", "--detach", wtPath("worker-1"), base);
    const gone = await removeRemoteWorktree(db, "wide", "rollback:auth/worker-1", {
      path: wtPath("worker-1"),
      base,
      root: remote,
    });
    expect(gone).toBe(true);
    expect(existsSync(wtPath("worker-1"))).toBe(false);
  });
});

describe("round-2 fences", () => {
  it("an unchanged collect still fences the incarnation, and leaves the earlier pin alone", async () => {
    const old = await remoteAgent("worker-1");
    const head = commitIn("worker-1", "a.txt");
    await collect("worker-1");
    writeFileSync(join(dir, "gate"), "");
    const pending = collect("worker-1").catch((e: unknown) => e);
    await until(() => readdirSync(dir).some((f) => f.startsWith("started-")), "the fetch to start");
    db.prepare("DELETE FROM agents WHERE id = ?").run(old.incarnation);
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%99",
      host: "wide",
      cwd: wtPath("worker-1"),
      base,
    });
    rmSync(join(dir, "gate"));
    expect(await pending).toBeInstanceOf(AgentReplacedError);
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBeNull();
    expect(localRef("worker-1")).toBe(head);
  });

  it("a failed collect restores the previous pin instead of dropping it", async () => {
    const old = await remoteAgent("worker-1");
    const first = commitIn("worker-1", "a.txt");
    await collect("worker-1");
    commitIn("worker-1", "b.txt");
    writeFileSync(join(dir, "gate"), "");
    const pending = collect("worker-1").catch((e: unknown) => e);
    await until(() => readdirSync(dir).some((f) => f.startsWith("started-")), "the fetch to start");
    db.prepare("UPDATE agents SET cwd = ? WHERE id = ?").run(wtPath("worker-2"), old.incarnation);
    rmSync(join(dir, "gate"));
    expect(await pending).toBeInstanceOf(AgentReplacedError);
    expect(localRef("worker-1")).toBe(first);
    expect(getAgent(db, "worker-1", "auth")?.collectedHead).toBe(first);
  });

  it("a replacement that lands after the observation is caught before anything is removed", async () => {
    const old = await remoteAgent("worker-1");
    writeFileSync(join(dir, "gate-remove"), "");
    writeFileSync(
      join(dir, "exec.sh"),
      `#!/bin/sh\ncase "$1" in *MU_STATE*) sh -c "$1"; touch '${dir}/observed'; while [ -f '${dir}/gate-remove' ]; do sleep 0.02; done; exit 0 ;; esac\nexec sh -c "$1"\n`,
    );
    const pending = close("worker-1").catch((e: unknown) => e);
    await until(() => existsSync(join(dir, "observed")), "the observation");
    db.prepare("DELETE FROM agents WHERE id = ?").run(old.incarnation);
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%99",
      host: "wide",
      cwd: wtPath("worker-1"),
      base,
    });
    rmSync(join(dir, "gate-remove"));
    expect(await pending).toBeInstanceOf(AgentReplacedError);
    expect(existsSync(wtPath("worker-1"))).toBe(true);
  });

  it("--keep-branch never moves an existing branch, and the removal leaves no aside tree", async () => {
    await remoteAgent("worker-1");
    const head = commitIn("worker-1", "a.txt");
    const out = await close("worker-1", { keepBranch: true });
    expect(out.worktree?.action).toBe("kept-branch");
    expect(gitIn(remote, "rev-parse", `refs/heads/${out.worktree?.branch}`)).toBe(head);
    expect(readdirSync(join(dir, "wts"))).toEqual([]);
  });
});

// Close proves QUIESCENCE, not a lock (reftable ignores HEAD.lock): the tree is
// renamed aside, no process may have its cwd or an open file under it, then
// HEAD and cleanliness are re-checked with plain git. Both ref backends.
const REFTABLE = gitSupportsReftable();
describe.each([
  ["files", true],
  ["reftable", REFTABLE],
] as const)("close quiescence, %s refs", (format, supported) => {
  const holders: ChildProcess[] = [];
  const wt = (): string => wtPath("worker-1");
  const aside = (id: number): string => asideOf(wt(), id);
  const gitShim = (body: string): void => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\nexec /usr/bin/git "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    db.prepare("UPDATE host_profiles SET exec = ? WHERE name = 'wide'").run(
      `PATH=${bin}:$PATH /bin/sh ${join(dir, "exec.sh")} {cmd}`,
    );
  };
  /** A process whose cwd (or an open fd, with `fd`) is inside the tree. */
  async function holder(how: "cwd" | "fd"): Promise<number> {
    const script =
      how === "cwd"
        ? `cd '${wt()}' && exec sleep 60`
        : `exec 3< '${wt()}/README'; cd /; exec sleep 60`;
    const child = spawn("sh", ["-c", script], { stdio: "ignore" });
    holders.push(child);
    const pid = child.pid ?? 0;
    await until(() => {
      try {
        return (
          readdirSync(`/proc/${pid}/fd`).length > 0 &&
          readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("sleep")
        );
      } catch {
        return false;
      }
    }, "the holder to start");
    return pid;
  }

  beforeEach(() => {
    if (!supported) return;
    for (const d of [remote, local]) rmSync(d, { recursive: true, force: true });
    mkdirSync(remote);
    initGitRepo(remote, { refFormat: format });
    base = gitIn(remote, "rev-parse", "HEAD");
    gitIn(dir, "clone", "-q", remote, local);
  });
  afterEach(() => {
    for (const h of holders.splice(0)) h.kill("SIGKILL");
  });

  const it_ = supported ? it : it.skip;
  it_(`the repo really uses ${format} refs`, () => {
    expect(existsSync(join(remote, ".git", "reftable"))).toBe(format === "reftable");
  });

  it_("a clean tree at its base is removed, leaving no aside", async () => {
    await remoteAgent("worker-1");
    expect((await close("worker-1")).worktree).toMatchObject({ action: "removed" });
    expect(readdirSync(join(dir, "wts"))).toEqual([]);
  });

  it_(
    "a commit landing before the removal refuses as moved, also with --keep-branch; nothing is lost",
    async () => {
      await remoteAgent("worker-1");
      writeFileSync(
        join(dir, "hook"),
        `cd '${wt()}' && echo m > moved.txt && git add . && git -c user.email=t@t -c user.name=t commit -q -m moved\n`,
      );
      await expect(close("worker-1", { keepBranch: true })).rejects.toMatchObject({
        reason: "moved",
      });
      expect(existsSync(wt())).toBe(true);
      expect(readdirSync(join(dir, "wts"))).toEqual(["worker-1"]);
      expect(gitIn(wt(), "rev-parse", "HEAD")).not.toBe(base);
      expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    },
  );

  it_("a file written after the observation refuses as dirty, with --keep-branch too", async () => {
    await remoteAgent("worker-1");
    writeFileSync(join(dir, "hook"), `echo x > '${wt()}/late.txt'\n`);
    await expect(close("worker-1", { keepBranch: true })).rejects.toMatchObject({
      reason: "dirty",
    });
    expect(existsSync(join(wt(), "late.txt"))).toBe(true);
    expect(readdirSync(join(dir, "wts"))).toEqual(["worker-1"]);
  });

  it_.each(["cwd", "fd"] as const)(
    "a process with its %s inside the tree is refused, never removed, naming the pid",
    async (how) => {
      await remoteAgent("worker-1");
      const pid = await holder(how);
      const err = await close("worker-1", { keepBranch: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteCloseRefusedError);
      expect((err as RemoteCloseRefusedError).reason).toBe("held");
      expect((err as Error).message).toContain(`process ${pid}`);
      expect((err as Error).message).not.toContain("\n");
      expect(readdirSync(join(dir, "wts"))).toEqual(["worker-1"]);
      expect(gitIn(remote, "worktree", "list")).toContain(wt());
      expect(getAgent(db, "worker-1", "auth")).toBeDefined();
      // Once the holder is gone the same close finishes.
      holders.pop()?.kill("SIGKILL");
      await until(() => {
        try {
          readdirSync(`/proc/${pid}/fd`);
          return false;
        } catch {
          return true;
        }
      }, "the holder to die");
      expect((await close("worker-1")).worktree).toMatchObject({ action: "removed" });
    },
  );

  it_(
    "a close killed right after the move is resumed by the retry, never reported gone",
    async () => {
      const row = await remoteAgent("worker-1");
      const head = commitIn("worker-1", "a.txt");
      gitShim(
        `case " $* " in *' worktree move '*mu-removing*) if [ ! -f '${dir}/crashed' ]; then /usr/bin/git "$@"; touch '${dir}/crashed'; kill -9 $PPID; exit 0; fi ;; esac`,
      );
      const first = await close("worker-1", { keepBranch: true }).catch((e: unknown) => e);
      expect(first).toBeInstanceOf(RemoteCloseRefusedError);
      expect(existsSync(aside(row.incarnation))).toBe(true);
      expect(existsSync(wt())).toBe(false);
      expect(getAgent(db, "worker-1", "auth")).toBeDefined();
      const second = await close("worker-1", { keepBranch: true });
      expect(second.worktree).toMatchObject({
        action: "kept-branch",
        branch: `mu/auth/worker-1-${head.slice(0, 12)}`,
      });
      expect(gitIn(remote, "rev-parse", `refs/heads/${second.worktree?.branch}`)).toBe(head);
      expect(readdirSync(join(dir, "wts"))).toEqual([]);
      expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    },
  );

  it_(
    "after a crash, work added meanwhile makes the retry refuse with the tree back in place",
    async () => {
      const row = await remoteAgent("worker-1");
      gitShim(
        `case " $* " in *' worktree move '*mu-removing*) if [ ! -f '${dir}/crashed' ]; then /usr/bin/git "$@"; touch '${dir}/crashed'; kill -9 $PPID; exit 0; fi ;; esac`,
      );
      await expect(close("worker-1")).rejects.toBeInstanceOf(RemoteCloseRefusedError);
      writeFileSync(join(aside(row.incarnation), "wip.txt"), "x");
      await expect(close("worker-1")).rejects.toMatchObject({ reason: "dirty" });
      expect(existsSync(join(wt(), "wip.txt"))).toBe(true);
      expect(existsSync(aside(row.incarnation))).toBe(false);
      expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    },
  );

  it_("an aside beside a live path is never guessed at: refuse, remove nothing", async () => {
    const row = await remoteAgent("worker-1");
    mkdirSync(aside(row.incarnation));
    await expect(close("worker-1")).rejects.toBeInstanceOf(RemoteCloseRefusedError);
    expect(existsSync(wt())).toBe(true);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it_("a host that can neither read /proc nor run lsof refuses; the tree is put back", async () => {
    const row = await remoteAgent("worker-1", { pane: false });
    const agent = getAgent(db, "worker-1", "auth");
    if (agent === undefined) throw new Error("no row");
    const err = await closeRemoteWorktree(db, agent, {
      probe: { proc: "/nonexistent-proc", lsof: "/nonexistent-lsof" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCloseRefusedError);
    expect((err as Error).message).toMatch(/neither \/proc nor lsof/);
    expect(existsSync(wt())).toBe(true);
    expect(existsSync(aside(row.incarnation))).toBe(false);
  });

  const lsofHere = spawnLsof();
  // Registered for the files format only (not skipped for reftable: a permanent
  // skip hides real ones in the count).
  if (format === "files")
    (supported && lsofHere ? it : it.skip)("with no /proc, lsof finds the holder", async () => {
      await remoteAgent("worker-1", { pane: false });
      await holder("cwd");
      const agent = getAgent(db, "worker-1", "auth");
      if (agent === undefined) throw new Error("no row");
      const err = await closeRemoteWorktree(db, agent, {
        probe: { proc: "/nonexistent-proc", lsof: "lsof" },
      }).catch((e: unknown) => e);
      expect((err as RemoteCloseRefusedError).reason).toBe("held");
      expect(existsSync(wt())).toBe(true);
    });
});

function spawnLsof(): boolean {
  try {
    execFileSync("lsof", ["-v"], { stdio: "ignore" });
    return true;
  } catch (e) {
    return (
      (e as { status?: number }).status !== undefined && (e as { code?: string }).code !== "ENOENT"
    );
  }
}

describe("the CLI", () => {
  it("agent collect fetches into the current directory's repo; outside a repo it is a usage error (exit 2)", async () => {
    await remoteAgent("worker-1");
    const head = commitIn("worker-1", "a.txt");
    const dbPath = join(dir, "mu.db");
    const prev = process.cwd();
    try {
      process.chdir(local);
      const r = await runCliJson(["agent", "collect", "worker-1", "-w", "auth", "--json"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.data).toMatchObject({ head, changed: true, merge: `git merge ${head}` });
      expect(localRef("worker-1")).toBe(head);
      process.chdir(tmpdir());
      const out = await runCliJson(
        ["agent", "collect", "worker-1", "-w", "auth", "--json"],
        dbPath,
      );
      expect(out.exitCode).toBe(2);
    } finally {
      process.chdir(prev);
    }
  });
});
