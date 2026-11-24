// The routed test of spec_a_r2_tree_recovery (ladder placement spec R2, §10.4): a static plugin
// spawn's remote tree, prepared but never finalized, survives mu's death with a durable owner.
// The prepare stamps its placeholder row with the tree (host, path, base, repo) the moment it
// answers, so after a restart `mu agent close <name>` closes exactly that tree, and a deleted
// placeholder leaves a `remote_recovery` record the close by name closes. Static close policy:
// no final collect is owed.
//
// mu's death is the rollback never running: `rollbackSpawn` is a no-op here, so every effect a
// failed spawn made stays as a SIGKILL would leave it. The "restart" closes the plugin sessions
// and reopens the DB file. The fake plugin's link runs here under HOME (a temp dir).

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { getAgent, isPendingPaneId } from "../src/agents.js";
import { getCarrierJobByName, listCarrierJobs } from "../src/carrier-jobs.js";
import { openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { HONOURS_ALL } from "../src/jobs/types.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { listRemoteRecoveries } from "../src/remote-recovery.js";
import { copyGitFixture, gitIn as git } from "./_git.js";
import { fakePlugin, jobSeams } from "./_plugin.js";
import { pluginHostFixture } from "./_plugin-host.js";

vi.mock("../src/agents/spawn-rollback.js", async (orig) => ({
  ...(await orig<typeof import("../src/agents/spawn-rollback.js")>()),
  // mu died: nothing is rolled back.
  rollbackSpawn: vi.fn(async () => ({ gone: false })),
}));

const h = pluginHostFixture();

let home: string | undefined;
let cwd: string;
let remote: string;
let sha: string;

beforeEach(async () => {
  home = process.env.HOME;
  cwd = process.cwd();
  process.env.HOME = h.dir;
  remote = join(h.dir, "remote");
  mkdirSync(remote);
  remote = realpathSync(remote);
  copyGitFixture(remote);
  sha = git(remote, "rev-parse", "HEAD");
  process.chdir(remote);
  h.f = fakePlugin(h.dir, { seams: jobSeams({ honours: HONOURS_ALL }) });
  await addPlugin(h.db, "fake", h.f.argv);
  addHost(h.db, { name: "box", plugin: "fake", fetch: "true", repo: remote, max_sessions: null });
});

afterEach(() => {
  process.chdir(cwd);
  process.env.HOME = home;
});

/** The tree's physical path, as the host's `pwd -P` names it (macOS's /var is /private/var). */
const tree = () => join(realpathSync(h.dir), ".local/state/mu-next/remote-worktrees/ws/w1");

/** mu "restarts": its plugin sessions end and the DB file is opened afresh. */
async function restart(): Promise<void> {
  await closePluginSessions();
  const path = h.db.name;
  h.db.close();
  h.db = openDb({ path });
}

/** Spawn w1 --worktree on box until it fails, then nothing rolls back (mu died). */
async function crash(): Promise<void> {
  const err = await h.spawn({ cli: "pi", worktree: true }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  // The pre-finalization state: a placeholder that names its tree, the tree, the job record.
  const row = getAgent(h.db, "w1", "ws") ?? expect.fail("no placeholder");
  expect(isPendingPaneId(row.paneId)).toBe(true);
  expect(row).toMatchObject({ host: "box", cwd: tree(), base: sha, repo: remote });
  expect(existsSync(tree())).toBe(true);
  expect(getCarrierJobByName(h.db, "ws", "w1")).toMatchObject({
    treePath: tree(),
    treeBase: sha,
    treeAgentId: row.incarnation,
    finalOwed: false,
  });
}

/** Nothing of the spawn is left: tree, row, job record, recovery record. */
function allGone(): void {
  expect(existsSync(tree())).toBe(false);
  expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
  expect(listCarrierJobs(h.db)).toEqual([]);
  expect(listRemoteRecoveries(h.db)).toEqual([]);
}

describe("a prepared, never finalized static plugin tree after mu dies", () => {
  it("job.start refused, then death: after a restart, close by name closes exactly that tree", async () => {
    h.f.set({ faults: { "job.start": ["permanent"] } });
    await crash();
    expect(getCarrierJobByName(h.db, "ws", "w1")?.launch).toBe("none");
    await restart();
    await closeAgent(h.db, "w1", { workstream: "ws" });
    allGone();
    expect(h.f.backend().stops).toBe(0);
  });

  it("job started, the view never opened, then death: the close stops the job by its handle, then closes the tree", async () => {
    h.stubMux({
      spawnAgent: async () => {
        throw new Error("the view failed");
      },
    });
    await crash();
    const job = getCarrierJobByName(h.db, "ws", "w1");
    expect(job?.job).toBe("job-1");
    await restart();
    await closeAgent(h.db, "w1", { workstream: "ws" });
    allGone();
    expect(h.f.backend().stops).toBe(1);
    const stop = h.calls("job.stop")[0]?.params as { target: { job: { handle: string } } };
    expect(stop.target.job.handle).toBe("job-1");
  });

  it("the placeholder deleted behind mu's back: its recovery record names the tree, and close by name closes it", async () => {
    h.f.set({ faults: { "job.start": ["permanent"] } });
    await crash();
    await restart();
    h.db.prepare("DELETE FROM agents WHERE name = 'w1'").run();
    expect(listRemoteRecoveries(h.db)).toMatchObject([{ host: "box", cwd: tree(), base: sha }]);
    await closeAgent(h.db, "w1", { workstream: "ws" });
    allGone();
  });
});
