// Placement spec §7: real DB, collect refs and worktrees, with a local mule stop shim
// and a fake mux. The migration itself uses the existing host/agent verbs.
import {
  chmodSync,
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
import { afterEach, beforeEach, expect, it } from "vitest";
import { reserveLeaseJob } from "../src/agents/lease-carrier.js";
import { closeAgent, deleteAgent, getAgent, previewClose } from "../src/agents.js";
import {
  bindCarrierJobAgent,
  fillCarrierJob,
  getCarrierJobByName,
  markCarrierLaunch,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import { CarrierStopFailedError } from "../src/carrier-stop.js";
import { type Db, openDb } from "../src/db.js";
import { hostExec } from "../src/host-exec.js";
import {
  addHost,
  getHost,
  hostMuleStarter,
  hostStarter,
  type NewHostProfile,
  removeHost,
} from "../src/hosts.js";
import { closePluginSessions } from "../src/plugins/registry.js";
import { collectRemoteAgent } from "../src/remote-collect.js";
import { getRemoteRecovery } from "../src/remote-recovery.js";
import { insertTestAgent } from "./_agent-pane.js";
import { rmFixtureDir } from "./_fs.js";
import { commitFileIn, copyGitFixture, gitIn } from "./_git.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { type FakePlugin, fakePlugin, linkSeam } from "./_plugin.js";
import { registerFixturePlugin } from "./_plugin-handshake.js";
import { runCli, runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let mule: FakePlugin;
let legacy: NewHostProfile;
let plugin: NewHostProfile;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "migrate-")));
  db = openDb({ path: join(dir, "mu.db") });
  state = freshMockState();
  const tmux = mockTmux(state).executor;
  mux = installMux("tmux", (args) =>
    args[0] === "-V"
      ? Promise.resolve({ stdout: "tmux 3.4", stderr: "", exitCode: 0 })
      : tmux(args),
  );
  mule = fakePlugin(dir, { caps: linkSeam({ fetch: false }) }, "mule");
  await registerFixturePlugin(db, mule);
  const stop = join(dir, "mule");
  writeFileSync(
    stop,
    `#!/bin/sh
[ "$1 $2 $3" = 'rm --host box' ] && [ "$#" = 4 ] || exit 1
[ ! -f '${dir}/stop-fails' ] || exit 1
printf '%s\\n' "$4" >> '${dir}/stopped'
`,
  );
  chmodSync(stop, 0o755);
  legacy = {
    name: "box",
    ...hostMuleStarter("box"),
    transport: "lease",
    exec: "sh -c {cmd}",
    stop: `${stop} rm --host box {job}`,
    fetch: "git fetch -q {cwd} HEAD",
    repo: join(dir, "repo"),
    max_sessions: 1,
  };
  addHost(db, legacy);
  plugin = { name: "box", plugin: "mule", fetch: legacy.fetch, repo: legacy.repo, max_sessions: 1 };
});

afterEach(async () => {
  await closePluginSessions();
  mux.restore();
  db.close();
  rmFixtureDir(dir);
});

const workstream = "crew";
const job = (name: string) => getCarrierJobByName(db, workstream, name);
const stopped = () => readFileSync(join(dir, "stopped"), "utf8").trim().split("\n");

function agent(name: string, paneId: string, tree?: { cwd: string; base: string }, lease = true) {
  const r = lease
    ? reserveCarrierJob(db, {
        workstream,
        name,
        host: "box",
        hostStop: legacy.stop ?? null,
      })
    : undefined;
  state.panes.set(paneId, { windowId: "@1", paneId, command: "mule" });
  const row = insertTestAgent(db, {
    name,
    workstream,
    paneId,
    host: "box",
    hostTransport: "lease",
    repo: legacy.repo,
    ...tree,
    ...(r === undefined ? {} : { reservation: r.token }),
  });
  if (r !== undefined) {
    markCarrierLaunch(db, r.token);
    bindCarrierJobAgent(db, r.token, row.incarnation, paneId);
    fillCarrierJob(db, r.token, `job-${name}`);
  }
  return row.incarnation;
}

function reap(name: string, paneId: string) {
  state.panes.delete(paneId);
  expect(deleteAgent(db, name, workstream)).toBe(true);
}

async function close(name: string, recoveryId?: number) {
  const opts = { workstream, ...(recoveryId === undefined ? {} : { recoveryId }) };
  const { revision } = await previewClose(db, name, opts);
  return closeAgent(db, name, { ...opts, ifRevision: revision });
}

it("doctor reports all switch blockers, without recommending SSH or other lease templates", async () => {
  addHost(db, { name: "ssh-box", ...hostStarter("ssh-box"), repo: null, max_sessions: 2 });
  addHost(db, {
    ...legacy,
    name: "other-carrier",
    shell: "carrier {job_file} {local_sock}:{remote_sock}",
    stop: "stop {job}",
  });
  addHost(db, { ...plugin, name: "plugin-box" });
  addHost(db, { ...legacy, ...hostMuleStarter("empty"), name: "empty" });
  agent("active", "%1");
  agent("reaped", "%2");
  reap("reaped", "%2");
  const recovery = agent("recover", "%3", { cwd: "/fixture/tree", base: "base" }, false);
  reap("recover", "%3");
  const human = await runCli(["doctor"], db.name);
  expect(human.exitCode).toBeNull();
  expect(human.stdout).toMatch(/box: .*mule lease template.*blocked/);
  expect(human.stdout).toContain("reaped job record crew/reaped");
  expect(human.stdout).toContain("mu host add box --plugin mule");
  const json = await runCliJson(["doctor", "--json"], db.name);
  expect(json.doc.ok).toBe(true);
  expect(json.data.housekeeping.muleProfileMigrations).toEqual([
    expect.objectContaining({
      host: "box",
      blocked: true,
      blockers: [
        expect.objectContaining({ kind: "active-job", workstream, name: "active" }),
        expect.objectContaining({ kind: "agent", workstream, name: "active" }),
        expect.objectContaining({ kind: "reaped-job", workstream, name: "reaped" }),
        expect.objectContaining({ kind: "recovery", workstream, name: "recover", id: recovery }),
      ],
    }),
    expect.objectContaining({ host: "empty", blocked: false, blockers: [] }),
  ]);
  expect(job("active")?.job).toBe("job-active");
  expect(job("reaped")?.job).toBe("job-reaped");
  expect(getRemoteRecovery(db, recovery)?.hostExec).toBe(legacy.exec);
  expect(mule.calls().map((c) => c.method)).toEqual(["initialize", "shutdown"]);
});

it("drains active and reaped jobs and collects recovery before installing the mule plugin", async () => {
  const repo = legacy.repo ?? "";
  const local = join(dir, "local");
  mkdirSync(repo);
  copyGitFixture(repo);
  gitIn(dir, "clone", "-q", repo, local);
  const base = gitIn(repo, "rev-parse", "HEAD");
  const tree = (name: string) => {
    const cwd = join(dir, name);
    gitIn(repo, "worktree", "add", "--detach", cwd, base);
    return { cwd, base };
  };
  const active = tree("active");
  const recover = tree("recover");
  const head = commitFileIn(active.cwd, "work.txt", "active work");
  const recovered = commitFileIn(recover.cwd, "work.txt", "recovered work");
  agent("active", "%1", active);
  agent("reaped", "%2");
  reap("reaped", "%2");
  const recoveryId = agent("recover", "%3", recover, false);
  reap("recover", "%3");

  // A premature rm is reversible; switching links isn't allowed.
  expect(removeHost(db, "box")).toBe(true);
  expect(() => addHost(db, plugin)).toThrow(
    /agent crew\/active.*job record crew\/reaped.*recovery record crew\/recover/,
  );
  expect(addHost(db, legacy)).toMatchObject(legacy);

  const collected = await collectRemoteAgent(db, { workstream, name: "active", repo: local });
  expect(collected.head).toBe(head);
  expect((await close("active")).worktree).toMatchObject({ action: "removed" });
  expect((await close("reaped")).carrierJobs).toEqual([
    { host: "box", job: "job-reaped", action: "stopped" },
  ]);
  expect(stopped()).toEqual(["job-active", "job-reaped"]);
  expect(removeHost(db, "box")).toBe(true);
  expect(() => addHost(db, plugin)).toThrow(/recovery record crew\/recover/);
  addHost(db, legacy);
  expect(
    (await collectRemoteAgent(db, { workstream, name: "recover", repo: local, recoveryId })).head,
  ).toBe(recovered);
  expect((await close("recover", recoveryId)).worktree).toMatchObject({ action: "removed" });

  expect(existsSync(active.cwd)).toBe(false);
  expect(existsSync(recover.cwd)).toBe(false);
  expect(gitIn(local, "rev-parse", "refs/mu/collect/crew/active")).toBe(head);
  expect(gitIn(local, "rev-parse", "refs/mu/collect/crew/recover")).toBe(recovered);
  expect(removeHost(db, "box")).toBe(true);
  expect(addHost(db, plugin)).toMatchObject({
    plugin: "mule",
    fetch: legacy.fetch,
    repo,
    max_sessions: 1,
  });
  expect(mule.calls().map((c) => c.method)).toEqual(["initialize", "shutdown"]);
});

it("aborting after a failed stop keeps the legacy profile and handle usable for retry", async () => {
  agent("worker", "%1");
  writeFileSync(join(dir, "stop-fails"), "");
  await expect(close("worker")).rejects.toBeInstanceOf(CarrierStopFailedError);
  expect(getHost(db, "box")).toMatchObject(legacy);
  expect(job("worker")?.job).toBe("job-worker");
  expect(getAgent(db, "worker", workstream)).toBeDefined();
  expect(() => addHost(db, plugin)).toThrow(/already exists/);
  // Retry uses the original stop even though the first close killed the view.
  unlinkSync(join(dir, "stop-fails"));
  await close("worker");
  expect(stopped()).toEqual(["job-worker"]);
});

it("premature removal cannot bypass a recovery created while its link was absent", async () => {
  const recoveryId = agent("late-reap", "%1", { cwd: "/fixture/tree", base: "base" }, false);
  expect(removeHost(db, "box")).toBe(true);
  reap("late-reap", "%1");
  expect(() => addHost(db, plugin)).toThrow(/recovery record crew\/late-reap/);
  addHost(db, legacy);
  await expect(close("late-reap", recoveryId)).rejects.toMatchObject({ reason: "profile" });
  expect(getRemoteRecovery(db, recoveryId)).toMatchObject({ hostIdentity: null, hostExec: null });
});

it("a skewed plugin cannot run a link call; the unused plugin profile can be rolled back", async () => {
  mule.set({ speaks: [2, 2] }); // installed plugin no longer speaks the registered protocol
  expect(removeHost(db, "box")).toBe(true);
  addHost(db, plugin); // host add checks the stored handshake, not the executable
  await expect(hostExec(db, "box", { script: "true" })).rejects.toThrow(/protocol/);
  expect(mule.calls().some((c) => c.method === "link.exec")).toBe(false);
  expect(removeHost(db, "box")).toBe(true);
  expect(addHost(db, legacy)).toMatchObject(legacy);
});

it("a legacy spawn reservation that wins the race blocks the switch before any pane starts", async () => {
  const pending = await reserveLeaseJob(db, workstream, "pending", getHost(db, "box"));
  expect(removeHost(db, "box")).toBe(true);
  expect(() => addHost(db, plugin)).toThrow(/job record crew\/pending/);
  expect(job("pending")).toEqual(pending);
  expect(addHost(db, legacy)).toMatchObject(legacy);
});

it("a legacy spawner that read the profile before the switch cannot reserve after it", async () => {
  const snapshot = getHost(db, "box");
  expect(removeHost(db, "box")).toBe(true);
  addHost(db, plugin);
  await expect(reserveLeaseJob(db, workstream, "late", snapshot)).rejects.toThrow(
    /transport changed/,
  );
  expect(job("late")).toBeUndefined();
});

it("host add --replace refuses before removing: a blocked switch keeps the old profile", () => {
  agent("active", "%1");
  expect(() => addHost(db, plugin, { replace: true })).toThrow(/cannot add a plugin profile/);
  expect(getHost(db, "box").plugin ?? null).toBeNull();
  expect(getHost(db, "box").exec).toBe(legacy.exec);
});

it("host add --replace swaps a profile with no blockers in one step", () => {
  const next = addHost(db, plugin, { replace: true });
  expect(next).toMatchObject({ name: "box", plugin: "mule", exec: null });
  expect(getHost(db, "box")).toMatchObject({ plugin: "mule" });
  expect(() => addHost(db, plugin)).toThrow(/already/i);
});
