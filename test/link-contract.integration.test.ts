// The link contract's fetch (plugins spec D7, D16), with real git: on
// success, the local repo's FETCH_HEAD names the remote HEAD; a stale
// FETCH_HEAD never passes for the answer. Run against the template link, the
// fake plugin's own fetch, and a plugin link that declares `fetch: false`
// (whose `--plugin` profile's fetch template runs instead).

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { resolveHost } from "../src/host-provider.js";
import { addHost } from "../src/hosts.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { gitIn, initGitRepo } from "./_git.js";
import { fakePlugin, linkSeam, sshExample } from "./_plugin.js";

const FETCH = "git fetch --quiet {cwd} HEAD";

const IMPLS: Array<[string, (db: Db, dir: string) => Promise<void>]> = [
  [
    "template",
    async (db) => {
      addHost(db, {
        name: "dev",
        shell: "true",
        exec: "/bin/sh -c {cmd}",
        fetch: FETCH,
        repo: null,
        max_sessions: null,
      });
    },
  ],
  [
    "plugin",
    async (db, dir) => {
      await addPlugin(db, "fake", fakePlugin(dir).argv);
      addHost(db, { name: "dev", plugin: "fake", fetch: "false", repo: null, max_sessions: null });
    },
  ],
  [
    "plugin without fetch (the profile's template)",
    async (db, dir) => {
      await addPlugin(db, "fake", fakePlugin(dir, { seams: linkSeam({ fetch: false }) }).argv);
      addHost(db, { name: "dev", plugin: "fake", fetch: FETCH, repo: null, max_sessions: null });
    },
  ],
  [
    "the ssh example plugin",
    async (db, dir) => {
      await addPlugin(db, "ssh", sshExample(dir, dir));
      addHost(db, { name: "dev", plugin: "ssh", fetch: "true", repo: null, max_sessions: null });
    },
  ],
];

describe.each(IMPLS)("the link contract's fetch: %s", (_name, setup) => {
  let dir: string;
  let db: Db;
  let remote: string;
  let local: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mlcf-"));
    remote = join(dir, "remote");
    local = join(dir, "local");
    mkdirSync(remote);
    mkdirSync(local);
    initGitRepo(remote);
    initGitRepo(local);
    db = openDb({ path: join(dir, "mu.db") });
    await setup(db, dir);
  });

  afterEach(async () => {
    await closePluginSessions();
    db.close();
    rmFixtureDir(dir);
  });

  it("brings the remote HEAD home as FETCH_HEAD", async () => {
    const h = resolveHost(db, "dev");
    expect(h.link.caps.fetch).toBe(true);
    // A stale FETCH_HEAD from an earlier fetch of the local repo itself.
    gitIn(local, "fetch", "--quiet", local, "HEAD");
    const r = await h.link.fetch?.(
      h,
      { remoteCwd: remote, localRepo: local, timeoutMs: 10_000 },
      { holder: "c" },
    );
    expect(r?.exitCode).toBe(0);
    expect(gitIn(local, "rev-parse", "FETCH_HEAD^{commit}")).toBe(
      gitIn(remote, "rev-parse", "HEAD"),
    );
  });

  it("a failed fetch leaves no FETCH_HEAD", async () => {
    const h = resolveHost(db, "dev");
    gitIn(local, "fetch", "--quiet", local, "HEAD");
    const r = await h.link.fetch?.(
      h,
      { remoteCwd: join(dir, "nowhere"), localRepo: local, timeoutMs: 10_000 },
      { holder: "c" },
    );
    expect(r?.exitCode).not.toBe(0);
    expect(() => gitIn(local, "rev-parse", "--verify", "-q", "FETCH_HEAD")).toThrow();
  });
});
