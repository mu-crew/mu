// The template link (spec 2026-11-09-mu-plugins.md, D7, unit P2): today's exec
// and fetch templates behind `HostLink`, with the admitted-profile guard, `fits`,
// and the exec count and channel of each remote worktree operation unchanged.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { EXEC_ARG_MAX_BYTES, hostView } from "../src/host-link.js";
import {
  addHost,
  getHost,
  HostHandbackError,
  listHostChannels,
  releaseHostChannel,
  reserveHostChannel,
} from "../src/hosts.js";
import {
  closeRemoteWorktree,
  prepareRemote,
  removeRemoteWorktree,
} from "../src/remote-worktree.js";
import { rmFixtureDir } from "./_fs.js";

const BASE = "b".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/ws/worker-1";

let dir: string;
let db: Db;

/**
 * Every admission and every template start, from the channel table itself: a row
 * inserted is an admission, a pgid set is one template started under that token.
 */
function watchChannels(): void {
  db.exec(`
    CREATE TABLE t_channel_log (what TEXT NOT NULL, token TEXT NOT NULL);
    CREATE TRIGGER t_admit AFTER INSERT ON host_channels
      BEGIN INSERT INTO t_channel_log VALUES ('admit', NEW.token); END;
    CREATE TRIGGER t_run AFTER UPDATE OF pgid ON host_channels WHEN NEW.pgid IS NOT NULL
      BEGIN INSERT INTO t_channel_log VALUES ('run', NEW.token); END;
  `);
}
const channelLog = (): Array<{ what: string; token: string }> =>
  db.prepare("SELECT what, token FROM t_channel_log ORDER BY rowid").all() as Array<{
    what: string;
    token: string;
  }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhl-"));
  db = openDb({ path: join(dir, "mu.db") });
  const hexRoot = Buffer.from("/srv/repo").toString("hex");
  // Answers each of mu's scripts by the tag it prints; exit 3 when asked to hand back.
  const fake = join(dir, "fake-exec.sh");
  writeFileSync(
    fake,
    `#!/bin/sh
[ -f '${dir}/handback' ] && { echo "touch your key" >&2; exit 3; }
case "$1" in
  *MU_STATE*) echo "MU_STATE clean ${BASE}" ;;
  *MU_RM*) echo "MU_RM removed" ;;
  *MU_WT*) printf 'MU_REPO ${hexRoot}\\nMU_WT ${BASE} ${WT}\\n' ;;
  *MU_CWD*) echo "MU_CWD /srv/repo" ;;
  *) printf '%s' "$1" ;;
esac
`,
  );
  chmodSync(fake, 0o755);
  addHost(db, {
    name: "dev",
    shell: "true",
    exec: `/bin/sh ${fake} {cmd}`,
    fetch: `touch '${dir}/fetched'`,
    repo: "/srv/repo",
    max_sessions: 1,
  });
  watchChannels();
});

afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

describe("the template link", () => {
  it("declares today's capabilities and pins the exec bytes", () => {
    const h = hostView(db, "dev");
    expect(h.link.name).toBe("template");
    expect(h.link.caps).toEqual({
      fetch: true,
      slots: "mu",
      remoteOnTimeout: "unknown",
      quiescence: "provable",
    });
    expect(h.link.fingerprint(h)).toBe(getHost(db, "dev").exec);
  });

  it("runs a script as the exec template's {cmd} under one transient channel", async () => {
    const h = hostView(db, "dev");
    const r = await h.link.exec(
      h,
      { script: "echo hi", cwd: ".", timeoutMs: 5000 },
      { holder: "t" },
    );
    expect(r).toEqual({ exitCode: 0, stdout: "echo hi", stderr: "", partial: false });
    const log = channelLog();
    expect(log.map((l) => l.what)).toEqual(["admit", "run"]);
    expect(listHostChannels(db, "dev")).toEqual([]);
  });

  it("a throwing `admitted` runs nothing and frees the channel; it sees the admitted profile", async () => {
    const h = hostView(db, "dev");
    // The profile changes after the view was read: admission re-reads it.
    db.prepare("UPDATE host_profiles SET repo = '/elsewhere' WHERE name = 'dev'").run();
    let seen: string | null = null;
    const refused = h.link.exec(
      h,
      { script: "x", cwd: ".", timeoutMs: 5000 },
      { holder: "t" },
      (a) => {
        seen = a.profile.repo;
        throw new Error("pinned profile changed");
      },
    );
    await expect(refused).rejects.toThrow(/pinned profile changed/);
    expect(seen).toBe("/elsewhere");
    expect(channelLog().map((l) => l.what)).toEqual(["admit"]);
    expect(listHostChannels(db, "dev")).toEqual([]);
  });

  it("a throwing `admitted` on fetch runs no fetch and leaves FETCH_HEAD alone", async () => {
    const repo = join(dir, "local");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "FETCH_HEAD"), `${BASE}\n`);
    const h = hostView(db, "dev");
    const fetch = h.link.fetch;
    expect(fetch).toBeDefined();
    await expect(
      fetch?.(h, { remoteCwd: WT, localRepo: repo, timeoutMs: 5000 }, { holder: "c" }, () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow(/refused/);
    expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(true);
    expect(existsSync(join(dir, "fetched"))).toBe(false);
  });

  it("exit 3 is a hand-back", async () => {
    writeFileSync(join(dir, "handback"), "");
    const h = hostView(db, "dev");
    await expect(
      h.link.exec(h, { script: "x", cwd: ".", timeoutMs: 5000 }, { holder: "t" }),
    ).rejects.toBeInstanceOf(HostHandbackError);
  });

  it("fits measures the expanded exec template against the one-argument cap", () => {
    const h = hostView(db, "dev");
    const small = h.link.fits(h, "true", "/srv/repo");
    expect(small.ok).toBe(true);
    expect(small.limit).toBe(EXEC_ARG_MAX_BYTES);
    // The template adds its own bytes: a script just under the cap no longer fits.
    const big = h.link.fits(h, "x".repeat(EXEC_ARG_MAX_BYTES - 4), "/srv/repo");
    expect(big.ok).toBe(false);
    expect(big.bytes).toBeGreaterThan(EXEC_ARG_MAX_BYTES);
  });
});

describe("the remote worktree's exec boundaries", () => {
  it("prepare is one exec under the caller's held channel (cwd and worktree)", async () => {
    const lease = await reserveHostChannel(db, "dev", "spawn:ws/worker-1");
    try {
      const site = await prepareRemote(db, lease, getHost(db, "dev"), {
        workstream: "ws",
        name: "worker-1",
        worktree: false,
        root: "/srv/repo",
      });
      expect(site).toEqual({ cwd: "/srv/repo", base: null, repo: null });
      const tree = await prepareRemote(db, lease, getHost(db, "dev"), {
        workstream: "ws",
        name: "worker-1",
        worktree: true,
        reclaim: true,
        root: "/srv/repo",
      });
      expect(tree).toEqual({ cwd: WT, base: BASE, repo: "/srv/repo" });
    } finally {
      releaseHostChannel(db, lease);
    }
    const log = channelLog();
    expect(log.map((l) => l.what)).toEqual(["admit", "run", "run"]);
    expect(new Set(log.map((l) => l.token)).size).toBe(1);
  });

  it("rollback is one exec under its own channel", async () => {
    expect(
      await removeRemoteWorktree(db, "dev", "rollback:ws/worker-1", {
        path: WT,
        base: BASE,
        root: "/srv/repo",
      }),
    ).toBe(true);
    expect(channelLog().map((l) => l.what)).toEqual(["admit", "run"]);
    expect(listHostChannels(db, "dev")).toEqual([]);
  });

  const agent = {
    name: "worker-1",
    workstreamName: "ws",
    host: "dev",
    cwd: WT,
    base: BASE,
    collectedHead: null,
    incarnation: 7,
    repo: "/srv/repo",
  };

  it("close is two execs under ONE channel", async () => {
    expect(await closeRemoteWorktree(db, agent)).toEqual({ path: WT, action: "removed" });
    const log = channelLog();
    expect(log.map((l) => l.what)).toEqual(["admit", "run", "run"]);
    expect(new Set(log.map((l) => l.token)).size).toBe(1);
    expect(listHostChannels(db, "dev")).toEqual([]);
  });

  it("close's profile guard runs on the admitted profile before any exec", async () => {
    await expect(
      closeRemoteWorktree(db, agent, {
        checkProfile: () => {
          throw new Error("not the profile the recovery was made for");
        },
      }),
    ).rejects.toThrow(/recovery was made for/);
    expect(channelLog().map((l) => l.what)).toEqual(["admit"]);
  });
});
