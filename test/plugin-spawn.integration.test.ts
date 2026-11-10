// The plugin spawn path on a provider host with a worktree, and the live
// agent's close (plugins spec D7 G3, D8, D10), over the fake plugin (its link
// runs scripts with a local sh under `home`, its push fetches into the remote
// repo) and real git. The multiplexer is a stub: views never run.
//   spawn --worktree: the caller's HEAD is pushed and the remote tree made from
//   it before job.start; the job record holds the tree and owes its final collect.
//   close: the view, then job.stop, then the final collect from collect_repo
//   (the agent's commit reaches the local repo), then the tree; the record goes,
//   and the host can be released.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { getAgent } from "../src/agents.js";
import { getCarrierJobByAgent, listCarrierJobs } from "../src/carrier-jobs.js";
import { drainHost, releaseHost } from "../src/host-lifecycle.js";
import { getHostRecord } from "../src/host-records.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

let local: string;
let remote: string;
let home: string | undefined;
let cwd: string;

beforeEach(() => {
  home = process.env.HOME;
  cwd = process.cwd();
  process.env.HOME = h.dir;
  local = join(h.dir, "local");
  remote = join(h.dir, "remote");
  mkdirSync(local);
  local = realpathSync(local);
  git(local, "init", "-q");
  git(local, "commit", "-q", "--allow-empty", "-m", "one");
  process.chdir(local);
});

afterEach(() => {
  process.chdir(cwd);
  process.env.HOME = home;
});

describe("a --worktree agent on a provider host, spawned and closed", () => {
  it("pushes the caller's HEAD, starts the job in the tree, and closes with the final collect", async () => {
    await h.setup({}, {}, { push: true });
    const sha = git(local, "rev-parse", "HEAD");
    const a = await h.spawn({ worktree: true, root: remote });
    const job = getCarrierJobByAgent(h.db, a.incarnation);
    expect(a.cwd).toBe(job?.treePath);
    expect(job).toMatchObject({ treeBase: sha, collectRepo: local, finalOwed: true });
    expect(h.calls("link.push")[0]?.params).toMatchObject({ rev: sha, remoteRepo: remote });
    expect((h.calls("job.start")[0]?.params.spec as { cwd?: string } | undefined)?.cwd).toBe(a.cwd);
    // The agent works: a commit in its tree.
    const tree = a.cwd ?? "";
    git(tree, "commit", "-q", "--allow-empty", "-m", "work");
    const work = git(tree, "rev-parse", "HEAD");
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(h.stopsAtKill).toEqual([0]); // bound: the view first, then the stop
    expect(h.f.backend().stops).toBe(1);
    expect(git(local, "cat-file", "-t", work)).toBe("commit");
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(listCarrierJobs(h.db)).toHaveLength(0);
    expect(existsSync(tree)).toBe(false);
    await drainHost(h.db, "box");
    await releaseHost(h.db, "box");
    expect(getHostRecord(h.db, "box")).toBeUndefined();
  });
});
