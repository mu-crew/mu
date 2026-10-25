// `agent collect` and the remote half of `agent close` against REAL git
// (v_remote_collect), with no real host: the "remote" is a repo in a temp dir,
// the profile's `exec` is `sh -c`, and `fetch` is a local `git fetch` of the
// remote worktree's path into a local clone. The mux is the fake tmux (a pane
// is just a row in a map), so the lease and kill order are the real code.
// Pins what the fast tier cannot: the pinned ref is a real ref, a no-op or
// stale fetch is refused, FETCH_HEAD is never shared, the removal is a real
// `git worktree remove` that refuses real dirt and a real moved HEAD.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { RemoteCloseRefusedError } from "../src/remote-agent.js";
import { collectRef, collectRemoteAgent, RemoteCollectError } from "../src/remote-collect.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { commitFileIn, gitIn, initGitRepo } from "./_git.js";
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
