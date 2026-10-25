// Close and collect of a REMOVED agent's remote worktree (`remote_recovery`,
// v_remote_recovery_close) against REAL git, no real host: the "remote" is a
// repo in a temp dir, the profile's exec is `sh -c`, fetch a local `git fetch`.
// The mux is the fake tmux. Pins what the fast tier cannot: a recovery close
// really removes (or branches) a real tree through the ORIGINAL aside, a
// crash after the move and the reap is resumed, a dirty tree survives every
// flag, collect on a record pins a real ref and never overwrites a pin another
// record relies on. Both ref backends (reftable skipped when git is older).

import { execFileSync } from "node:child_process";
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
import { closeAgent, deleteAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { asideOf, RemoteCloseRefusedError } from "../src/remote-agent.js";
import { collectRef, collectRemoteAgent } from "../src/remote-collect.js";
import { listRemoteRecoveries, RemoteRecoveryRefusedError } from "../src/remote-recovery.js";
import { agentRevision } from "../src/revision.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { commitFileIn, gitIn, gitSupportsReftable, initGitRepo } from "./_git.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

const REFTABLE = gitSupportsReftable();
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

describe.each([
  ["files", true],
  ["reftable", REFTABLE],
] as const)("recovery close and collect, %s refs", (format, supported) => {
  let dir: string;
  let remote: string;
  let local: string;
  let db: Db;
  let mux: MuxHarness;
  let base: string;
  let n = 0;

  const wt = (name: string): string => join(dir, "wts", name);
  const localRef = (name: string): string | undefined => {
    try {
      return gitIn(local, "rev-parse", "--verify", "-q", collectRef("auth", name));
    } catch {
      return undefined;
    }
  };
  /** A real remote worktree and a finalized row for it; then the row is REAPED. Returns the original incarnation. */
  function orphan(name: string, over: { collectedHead?: string } = {}): number {
    gitIn(remote, "worktree", "add", "--detach", wt(name), base);
    const row = insertAgent(db, {
      name,
      workstream: "auth",
      paneId: `%${900 + n++}`,
      cwd: wt(name),
      base,
      host: "wide",
      ...(over.collectedHead === undefined ? {} : { collectedHead: over.collectedHead }),
    });
    expect(deleteAgent(db, name, "auth")).toBe(true);
    return row.incarnation;
  }
  const close = (name: string, over: Partial<Parameters<typeof closeAgent>[2]> = {}) =>
    closeAgent(db, name, { workstream: "auth", ...over });
  const collect = (name: string, recoveryId?: number) =>
    collectRemoteAgent(db, {
      workstream: "auth",
      name,
      repo: local,
      ...(recoveryId === undefined ? {} : { recoveryId }),
    });
  const gitShim = (body: string): void => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\nexec ${GIT} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
  };

  beforeEach(() => {
    if (!supported) return;
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mrrci-")));
    remote = join(dir, "remote");
    local = join(dir, "local");
    mkdirSync(remote);
    initGitRepo(remote, { refFormat: format });
    base = gitIn(remote, "rev-parse", "HEAD");
    gitIn(dir, "clone", "-q", remote, local);
    mkdirSync(join(dir, "wts"));
    db = openDb({ path: join(dir, "mu.db") });
    ensureWorkstream(db, "auth");
    const exec = join(dir, "exec.sh");
    writeFileSync(
      `${exec}`,
      `#!/bin/sh\nPATH='${join(dir, "bin")}':$PATH\nexport PATH\nexec sh -c "$1"\n`,
    );
    chmodSync(exec, 0o755);
    addHost(db, {
      name: "wide",
      shell: "true",
      exec: `/bin/sh ${exec} {cmd}`,
      fetch: "git fetch -q {cwd} HEAD",
      repo: remote,
      max_sessions: null,
    });
    mux = installMux("tmux", mockTmux(freshMockState()).executor);
  });
  afterEach(() => {
    if (!supported) return;
    mux.restore();
    db.close();
    rmFixtureDir(dir);
  });

  const it_ = supported ? it : it.skip;

  it_(
    "a clean tree at its base is removed through a real worktree remove; only its record goes",
    async () => {
      const id = orphan("w1");
      const other = orphan("w2");
      const r = await close("w1", { ifRevision: agentRevision(db, "auth", "w1") });
      expect(r.worktree).toMatchObject({ action: "removed" });
      expect(existsSync(wt("w1"))).toBe(false);
      expect(existsSync(asideOf(wt("w1"), id))).toBe(false);
      expect(existsSync(wt("w2"))).toBe(true);
      expect(listRemoteRecoveries(db).map((x) => x.agentId)).toEqual([other]);
      // Retried: nothing there, a no-op.
      expect(await close("w1")).toMatchObject({ worktree: null });
    },
  );

  it_("a worktree already deleted by hand is reported gone and the record goes", async () => {
    orphan("w1");
    gitIn(remote, "worktree", "remove", "--force", wt("w1"));
    expect((await close("w1")).worktree).toMatchObject({ action: "gone" });
    expect(listRemoteRecoveries(db)).toEqual([]);
  });

  it_(
    "a commit past base refuses until --keep-branch, which makes the branch at that HEAD",
    async () => {
      orphan("w1");
      const head = commitFileIn(wt("w1"), "a.txt", "a");
      await expect(close("w1")).rejects.toMatchObject({
        name: "RemoteCloseRefusedError",
        reason: "uncollected",
      });
      expect(existsSync(wt("w1"))).toBe(true);
      expect(listRemoteRecoveries(db)).toHaveLength(1);
      const r = await close("w1", { keepBranch: true });
      expect(r.worktree).toMatchObject({
        action: "kept-branch",
        branch: `mu/auth/w1-${head.slice(0, 12)}`,
      });
      expect(gitIn(remote, "rev-parse", `refs/heads/${r.worktree?.branch}`)).toBe(head);
      expect(listRemoteRecoveries(db)).toEqual([]);
    },
  );

  it_(
    "a branch name taken at another commit refuses and keeps the record and the tree",
    async () => {
      orphan("w1");
      const head = commitFileIn(wt("w1"), "a.txt", "a");
      gitIn(remote, "branch", `mu/auth/w1-${head.slice(0, 12)}`, base);
      await expect(close("w1", { keepBranch: true })).rejects.toMatchObject({ reason: "branch" });
      expect(existsSync(wt("w1"))).toBe(true);
      expect(listRemoteRecoveries(db)).toHaveLength(1);
    },
  );

  it_.each([{}, { keepBranch: true }, { discard: true }])("real dirt survives %j", async (over) => {
    orphan("w1");
    writeFileSync(join(wt("w1"), "wip.txt"), "x");
    await expect(close("w1", over)).rejects.toMatchObject({ reason: "dirty" });
    expect(existsSync(join(wt("w1"), "wip.txt"))).toBe(true);
    expect(listRemoteRecoveries(db)).toHaveLength(1);
  });

  it_(
    "a crash right after the move AND the reap: the retry finds the ORIGINAL aside and finishes",
    async () => {
      // The first close parks the tree at the aside and is killed. Then the row
      // that started it is gone (it already was: this IS the recovery close). A
      // newer recovery of a reused name must not steal the aside.
      const id = orphan("w1");
      gitShim(
        `case " $* " in *' worktree move '*mu-removing*) if [ ! -f '${dir}/crashed' ]; then ${GIT} "$@"; touch '${dir}/crashed'; kill -9 $PPID; exit 0; fi ;; esac`,
      );
      const first = await close("w1").catch((e: unknown) => e);
      expect(first).toBeInstanceOf(RemoteCloseRefusedError);
      expect(existsSync(asideOf(wt("w1"), id))).toBe(true);
      expect(existsSync(wt("w1"))).toBe(false);
      expect(listRemoteRecoveries(db)).toHaveLength(1);
      // Retry resumes from the recorded aside.
      expect((await close("w1")).worktree).toMatchObject({ action: "removed" });
      expect(readdirSync(join(dir, "wts"))).toEqual([]);
      expect(listRemoteRecoveries(db)).toEqual([]);
    },
  );

  it_(
    "a LIVE close killed after the move, then the row reaped: the recovery close resumes from the original aside",
    async () => {
      gitIn(remote, "worktree", "add", "--detach", wt("w1"), base);
      const row = insertAgent(db, {
        name: "w1",
        workstream: "auth",
        paneId: "%700",
        cwd: wt("w1"),
        base,
        host: "wide",
      });
      gitShim(
        `case " $* " in *' worktree move '*mu-removing*) if [ ! -f '${dir}/crashed' ]; then ${GIT} "$@"; touch '${dir}/crashed'; kill -9 $PPID; exit 0; fi ;; esac`,
      );
      await expect(close("w1")).rejects.toBeInstanceOf(RemoteCloseRefusedError);
      expect(existsSync(asideOf(wt("w1"), row.incarnation))).toBe(true);
      // The reaper (or reconcile) removes the row; the record names the exact aside.
      expect(deleteAgent(db, "w1", "auth")).toBe(true);
      expect(listRemoteRecoveries(db)).toEqual([
        expect.objectContaining({
          agentId: row.incarnation,
          aside: asideOf(wt("w1"), row.incarnation),
        }),
      ]);
      // A new agent reuses the name and path elsewhere: it must not steal the old aside.
      expect((await close("w1")).worktree).toMatchObject({ action: "removed" });
      expect(existsSync(asideOf(wt("w1"), row.incarnation))).toBe(false);
      expect(readdirSync(join(dir, "wts"))).toEqual([]);
      expect(listRemoteRecoveries(db)).toEqual([]);
    },
  );

  it_("a path reused by a new tree beside a parked aside is refused, nothing removed", async () => {
    const id = orphan("w1");
    mkdirSync(asideOf(wt("w1"), id));
    await expect(close("w1")).rejects.toBeInstanceOf(RemoteCloseRefusedError);
    expect(existsSync(wt("w1"))).toBe(true);
    expect(listRemoteRecoveries(db)).toHaveLength(1);
  });

  it_(
    "a tree that is not a worktree of the profile's repo is refused (common git dir)",
    async () => {
      orphan("w1");
      gitIn(remote, "worktree", "remove", "--force", wt("w1"));
      const stranger = join(dir, "stranger");
      mkdirSync(stranger);
      initGitRepo(stranger);
      rmSync(wt("w1"), { recursive: true, force: true });
      execFileSync("mv", [stranger, wt("w1")]);
      await expect(close("w1")).rejects.toMatchObject({
        name: "RemoteCloseRefusedError",
        reason: "unreadable",
      });
      expect(existsSync(wt("w1"))).toBe(true);
      expect(listRemoteRecoveries(db)).toHaveLength(1);
    },
  );

  it_("collect on a record fetches, pins the real ref and updates only that record", async () => {
    const id = orphan("w1");
    const keep = orphan("w2");
    const head = commitFileIn(wt("w1"), "a.txt", "a");
    const r = await collect("w1");
    expect(r).toMatchObject({ head, changed: true, recoveryId: id, ref: collectRef("auth", "w1") });
    expect(localRef("w1")).toBe(head);
    const recs = listRemoteRecoveries(db);
    expect(recs.find((x) => x.agentId === id)?.collectedHead).toBe(head);
    expect(recs.find((x) => x.agentId === keep)?.collectedHead).toBeNull();
    gitIn(local, "gc", "-q", "--prune=now");
    expect(gitIn(local, "cat-file", "-t", head)).toBe("commit");
    // The collected HEAD is now a known HEAD: the close needs no flag.
    expect((await close("w1")).worktree).toMatchObject({ action: "removed" });
    // Unchanged on a second collect of an untouched tree.
    expect(await collect("w2")).toMatchObject({ head: base, changed: false });
  });

  it_("the CLI collects a record by qualified ref (no -w) and prints the recovery id", async () => {
    const id = orphan("w1");
    const head = commitFileIn(wt("w1"), "a.txt", "a");
    const prev = process.cwd();
    try {
      process.chdir(local);
      const r = await runCliJson(["agent", "collect", "auth/w1", "--json"], join(dir, "mu.db"));
      expect(r.error).toBeUndefined();
      expect(r.data).toMatchObject({ head, changed: true, recoveryId: id });
      const bad = await runCliJson(
        ["agent", "collect", "auth/w1", "--recovery", String(id + 99), "--json"],
        join(dir, "mu.db"),
      );
      expect(bad.exitCode).toBe(4);
    } finally {
      process.chdir(prev);
    }
  });

  it_(
    "a collect that would overwrite another record's pin refuses; the pin and both records stay",
    async () => {
      const first = orphan("w1");
      const head1 = commitFileIn(wt("w1"), "a.txt", "a");
      await collect("w1");
      expect(localRef("w1")).toBe(head1);
      // The name is reused and reaped again: a second incarnation, a second record.
      const second = orphan("w1b");
      db.prepare("UPDATE remote_recovery SET name = 'w1', cwd = ? WHERE agent_id = ?").run(
        wt("w1b"),
        second,
      );
      db.prepare("UPDATE remote_recovery SET aside = ? WHERE agent_id = ?").run(
        asideOf(wt("w1b"), second),
        second,
      );
      commitFileIn(wt("w1b"), "b.txt", "b");
      const err = await collect("w1", second).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteRecoveryRefusedError);
      expect(err).toMatchObject({ reason: "pin", candidates: [first] });
      expect(localRef("w1")).toBe(head1);
      const recs = listRemoteRecoveries(db);
      expect(recs.find((x) => x.agentId === second)?.collectedHead).toBeNull();
      expect(recs.find((x) => x.agentId === first)?.collectedHead).toBe(head1);
    },
  );

  it_("a failed fetch records nothing and pins nothing", async () => {
    orphan("w1");
    commitFileIn(wt("w1"), "a.txt", "a");
    db.prepare("UPDATE host_profiles SET fetch = 'echo ssh: no route >&2; exit 128'").run();
    await expect(collect("w1")).rejects.toMatchObject({ name: "RemoteCollectError" });
    expect(localRef("w1")).toBeUndefined();
    expect(listRemoteRecoveries(db)[0]?.collectedHead).toBeNull();
  });

  it_(
    "a replaced profile (another repo) refuses a collect and a close before any fetch or exec",
    async () => {
      const id = orphan("w1");
      db.prepare("UPDATE host_profiles SET repo = ?").run(local);
      await expect(collect("w1", id)).rejects.toMatchObject({ reason: "profile" });
      await expect(close("w1")).rejects.toMatchObject({ reason: "profile" });
      expect(existsSync(wt("w1"))).toBe(true);
      expect(listRemoteRecoveries(db)).toHaveLength(1);
    },
  );

  it_(
    "an agent that takes the name during the fetch stops the collect before any ref moves",
    async () => {
      const id = orphan("w1");
      commitFileIn(wt("w1"), "a.txt", "a");
      const gate = join(dir, "gate");
      writeFileSync(gate, "");
      db.prepare("UPDATE host_profiles SET fetch = ?").run(
        `while [ -f '${gate}' ]; do sleep 0.02; done; git fetch -q {cwd} HEAD`,
      );
      const pending = collect("w1", id).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 150));
      insertAgent(db, {
        name: "w1",
        workstream: "auth",
        paneId: "%990",
        cwd: join(dir, "elsewhere"),
      });
      rmSync(gate);
      expect(await pending).toMatchObject({
        name: "RemoteRecoveryRefusedError",
        reason: "live-agent",
      });
      expect(localRef("w1")).toBeUndefined();
      expect(listRemoteRecoveries(db)[0]?.collectedHead).toBeNull();
    },
  );

  it_("a record deleted during the fetch moves no ref and records nothing", async () => {
    const id = orphan("w1");
    commitFileIn(wt("w1"), "a.txt", "a");
    const gate = join(dir, "gate");
    writeFileSync(gate, "");
    db.prepare("UPDATE host_profiles SET fetch = ?").run(
      `while [ -f '${gate}' ]; do sleep 0.02; done; git fetch -q {cwd} HEAD`,
    );
    const pending = collect("w1", id).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 150));
    db.prepare("DELETE FROM remote_recovery").run();
    rmSync(gate);
    expect(await pending).toMatchObject({ name: "RemoteRecoveryRefusedError", reason: "changed" });
    expect(localRef("w1")).toBeUndefined();
  });
});
