// A plugin job kind with no channel of its own (ladder placement spec §A, §I): its agents use
// mu's built-in channels, as on a template host. pi is on `ctl` (the JobSpec hands the kind the
// socket pair and MU_CTL_SOCK; its view forwards the local socket), a hook harness on remote
// `hooks` read through the plugin's link, any other harness on `mux`; the view is interactive.
// A `--plugin` profile runs the remote spawn's own refusals, and its `--worktree` base resolves
// in the caller's checkout (§3.3). An own-channel kind keeps its shape (G2 regression).
//
// The plugin is the fake (test/_fake-plugin.mjs): its link runs scripts here with /bin/sh under
// HOME (a temp dir), so the "host" repo and its remote worktrees are local paths. The
// multiplexer is a stub (test/_plugin-host.ts); the "forward" is a fake pi extension bound at
// the derived local socket when the view opens. Nothing reaches a real host or sshd.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { getReceipt } from "../src/agents/receipts.js";
import { JobSpecUnsupportedError, RemoteBaseRefError } from "../src/agents/spawn-remote.js";
import { spawnForTask } from "../src/agents/task-spawn.js";
import { getAgent, sendToAgent } from "../src/agents.js";
import { getCarrierJobByName, listCarrierJobs } from "../src/carrier-jobs.js";
import {
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import { channelTarget } from "../src/channels/index.js";
import { cmdWait } from "../src/cli/wait.js";
import { ctlSocketPath, remoteCtlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { addHost, HOST_ENV_KEYS } from "../src/hosts.js";
import { HONOURS_ALL } from "../src/jobs/types.js";
import { addPlugin } from "../src/plugins/registry.js";
import { RemoteBaseMissingError } from "../src/remote-worktree.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, taskIdFor } from "../src/tasks.js";
import { INC, withHello } from "./_ctl-ext.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { type FakeRemoteNode, fakeRemoteNode } from "./_fake-remote-node.js";
import { fakePlugin, jobSeams, linkSeam } from "./_plugin.js";
import { CLOUD, pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

let home: string | undefined;
let cwd: string;
/** The host's repo (a local path: the fake link runs here). */
let remote: string;
let servers: Server[];
/** What the fake pi extensions were asked, in order (hello excluded). */
let ctlRequests: Array<Record<string, unknown>>;
let out: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = process.env.HOME;
  cwd = process.cwd();
  process.env.HOME = h.dir;
  remote = join(h.dir, "remote");
  mkdirSync(remote);
  remote = realpathSync(remote);
  git(remote, "init", "-q");
  git(remote, "commit", "-q", "--allow-empty", "-m", "one");
  // The caller's checkout IS the host's repo here: a --from resolves to a commit the host has.
  process.chdir(remote);
  servers = [];
  ctlRequests = [];
  // The handshake runs (the shared setup turns it off).
  process.env.MU_SPAWN_CTL_MS = "3000";
  out = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  out.mockRestore();
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  process.chdir(cwd);
  process.env.HOME = home;
  process.env.MU_SPAWN_CTL_MS = "0";
});

/** A fake pi extension at `path`: idle; a send starts and settles a run at once. */
async function serveExtension(path: string): Promise<void> {
  let runs = 0;
  const accepted = new Set<string>();
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as Record<string, unknown>;
        if (req.op !== "hello") ctlRequests.push(req);
        if (req.op === "send") {
          runs += 1;
          accepted.add(String(req.msgId));
        }
        const idle = { v: 1, ok: true, state: "idle", since: 1, runs, pending: false };
        const reply =
          req.op === "status" && typeof req.msgId === "string"
            ? { ...idle, msg: { id: req.msgId, accepted: accepted.has(req.msgId), runs, at: 1 } }
            : idle;
        sock.end(encode(withHello(req, reply)));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

/** The stub mux, with the view's "forward": a fake extension at the agent's local socket. */
function forwardOnView(over: Parameters<typeof h.stubMux>[0] = {}): void {
  let n = 0;
  h.stubMux({
    spawnAgent: async (o) => {
      const id = `%${++n}`;
      h.panes.set(id, { command: o.command });
      if (o.cli === "pi") await serveExtension(ctlSocketPath("ws", o.name, h.dir));
      o.onPaneCreated?.(id);
      return id;
    },
    ...over,
  });
}

/** Register the fake (a job seam with no channel, `job` patched) and a `--plugin` profile `box`. */
async function staticPlugin(
  job: Record<string, unknown> = {},
  link: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
): Promise<void> {
  const seams = { ...jobSeams({ honours: HONOURS_ALL, ...job }), ...linkSeam(link) };
  h.f = fakePlugin(h.dir, { seams, ...config });
  await addPlugin(h.db, "fake", h.f.argv);
  addHost(h.db, { name: "box", plugin: "fake", fetch: "true", repo: remote, max_sessions: null });
}

type Spec = {
  cmd: string;
  env: Record<string, string>;
  sockets?: { local: string; remote: string };
};
const startSpec = (): Spec =>
  (h.calls("job.start")[0]?.params as { spec: Spec } | undefined)?.spec ?? expect.fail("no start");
const viewCommand = (): string => [...h.panes.values()][0]?.command ?? expect.fail("no view");
/** The row's `channel_plugin`: a built-in channel records none. */
const channelPlugin = (): string | null =>
  (
    h.db.prepare("SELECT channel_plugin FROM agents WHERE name = 'w1'").get() as
      | { channel_plugin: string | null }
      | undefined
  )?.channel_plugin ?? null;
const treeOf = (name: string) => join(h.dir, ".local/state/mu-next/remote-worktrees/ws", name);

describe("pi on the built-in ctl (ladder placement §A, R5)", () => {
  it("the JobSpec carries the socket pair and MU_CTL_SOCK, only HOST_ENV_KEYS; the view is interactive; the handshake answers", async () => {
    await staticPlugin();
    forwardOnView();
    const a = await h.spawn({ cli: "pi", cwd: remote });
    expect(a).toMatchObject({ ctl: "ok", ctlIncarnation: INC });
    const local = ctlSocketPath("ws", "w1", h.dir);
    expect(a.ctlSocket).toBe(local);
    const spec = startSpec();
    const remoteSock = remoteCtlSocketPath("ws", "w1", process.getuid?.() ?? 0);
    expect(spec.sockets).toEqual({ local, remote: remoteSock });
    expect(spec.env).toMatchObject({ MU_CTL_SOCK: remoteSock, MU_REMOTE: "1" });
    for (const k of Object.keys(spec.env)) expect(HOST_ENV_KEYS).toContain(k);
    expect(spec.env.MU_REMOTE_KEY).toBeUndefined();
    // Interactive, and without the local-only mu variables a tmux pane inherits.
    expect(viewCommand()).not.toContain("</dev/null");
    expect(viewCommand()).toContain("-u MU_DB_PATH");
    expect(getAgent(h.db, "w1", "ws")).toMatchObject({
      channel: "ctl",
      host: "box",
      cwd: remote,
    });
    expect(channelPlugin()).toBeNull();
  });

  it("a kind that does not honour sockets refuses a pi before any job call or record", async () => {
    await staticPlugin({ honours: { ...HONOURS_ALL, sockets: false } });
    forwardOnView();
    const err = await h.spawn({ cli: "pi", cwd: remote }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobSpecUnsupportedError);
    expect((err as JobSpecUnsupportedError).field).toBe("sockets");
    expect(h.f.calls().filter((c) => c.method.startsWith("job."))).toEqual([]);
    expect(listCarrierJobs(h.db)).toEqual([]);
    expect(h.panes.size).toBe(0);
  });

  it("end to end: spawn --worktree --task, send, wait, close (view first, then job.stop, then the tree)", async () => {
    await staticPlugin();
    forwardOnView();
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    const sha = git(remote, "rev-parse", "HEAD");
    const spawned = await spawnForTask(h.db, {
      task: "t1",
      text: "build t1",
      spawn: { name: "w1", workstream: "ws", host: "box", cli: "pi", worktree: true },
    });
    expect(spawned).toMatchObject({ state: "sent", replay: false });
    const rec = getReceipt(h.db, taskIdFor(h.db, "t1", "ws") ?? 0, "manual:t1");
    expect(rec).toMatchObject({ state: "sent", transport: "ctl", incarnation: INC });
    expect(getTask(h.db, "t1", "ws")?.ownerName).toBe("w1");
    const row = getAgent(h.db, "w1", "ws") ?? expect.fail("no row");
    expect(row).toMatchObject({ channel: "ctl", base: sha, repo: remote });
    expect(existsSync(row.cwd ?? "")).toBe(true);
    // The job record names the tree too (§10.4); a static host owes no final collect.
    expect(getCarrierJobByName(h.db, "ws", "w1")).toMatchObject({
      treePath: row.cwd,
      treeBase: sha,
      treeAgentId: row.incarnation,
      finalOwed: false,
    });

    const sent = await sendToAgent(h.db, "w1", "second", { workstream: "ws" });
    expect(sent.transport).toBe("ctl");
    expect(ctlRequests.filter((r) => r.op === "send").map((r) => r.text)).toEqual([
      "build t1",
      "second",
    ]);
    out.mockClear();
    await cmdWait(
      h.db,
      ["agent:w1@1"],
      { workstream: "ws", timeout: 10 },
      { signal: new AbortController().signal, which: () => undefined, dispose: () => {} },
    );
    const line = out.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((l: string) => l.startsWith("{"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ ok: true });

    const closed = await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(closed).toMatchObject({ killedPane: true, deletedRow: true });
    // Bound: the view died before the stop; the stop ran once; tree, row, record and socket gone.
    expect(h.stopsAtKill).toEqual([0]);
    expect(h.f.backend().stops).toBe(1);
    expect(existsSync(row.cwd ?? "")).toBe(false);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(listCarrierJobs(h.db)).toEqual([]);
    expect(existsSync(ctlSocketPath("ws", "w1", h.dir))).toBe(false);
  });

  it("pane lifetime: a view that dies during the handshake rolls back, stopping the job", async () => {
    await staticPlugin();
    const saved = process.env.MU_SPAWN_LIVENESS_MS;
    process.env.MU_SPAWN_LIVENESS_MS = "1";
    try {
      // The view opens and exits at once: no forward ever binds.
      h.stubMux({
        spawnAgent: async (o) => {
          o.onPaneCreated?.("%9");
          return "%9";
        },
      });
      const err = await h.spawn({ cli: "pi", cwd: remote }).catch((e: unknown) => e);
      expect((err as Error).name).toBe("AgentDiedOnSpawnError");
      expect(h.f.backend().stops).toBe(1);
      expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
      expect(listCarrierJobs(h.db)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.MU_SPAWN_LIVENESS_MS;
      else process.env.MU_SPAWN_LIVENESS_MS = saved;
    }
  });
});

describe("a hook harness on remote hooks, read through the plugin's link (spec D11)", () => {
  let node: FakeRemoteNode;
  let fake: FakeHarness;

  beforeEach(() => {
    node = fakeRemoteNode(h.dir);
    fake = fakeHarness(h.dir, "%1", "sess-1");
    setMurmurPaneRunnerForTests(fake.pane);
    setMurmurHookRunnerForTests(fake.hook);
  });

  afterEach(() => {
    setMurmurPaneRunnerForTests(null);
    setMurmurHookRunnerForTests(null);
  });

  it("a tmux-like backend: hooks with a remote key in the env and the anchor, read by link.exec", async () => {
    await staticPlugin({}, {}, { pathPrefix: join(node.dir, "bin") });
    forwardOnView({ anchorsPanes: true, pasteToPane: async () => {} });
    await h.spawn({ cli: "claude", cwd: remote });
    const row = getAgent(h.db, "w1", "ws") ?? expect.fail("no row");
    expect(row).toMatchObject({ channel: "hooks", host: "box" });
    expect(channelPlugin()).toBeNull();
    const key = (
      h.db.prepare("SELECT remote_key FROM agents WHERE id = ?").get(row.incarnation) as {
        remote_key: string;
      }
    ).remote_key;
    expect(key).toMatch(/\/ws\.w1\./);
    const spec = startSpec();
    expect(spec.env).toMatchObject({ MU_REMOTE_KEY: key, MU_AGENT_CLI: "claude" });
    expect(spec.sockets).toBeUndefined();
    expect(spec.cmd).toContain("mu-anchor");
    expect(spec.cmd).toContain(key);
    expect(viewCommand()).not.toContain("</dev/null");

    node.emit("session_start", { source: "startup" });
    const r = await channelTarget(h.db, row).remote?.read();
    expect(r).toMatchObject({ ok: true, snapshot: { sessionId: "sess-1" } });
    const execs = h.calls("link.exec").map((c) => String(c.params.script));
    expect(execs.some((s) => s.includes("murmur pane --remote"))).toBe(true);
  });

  it("a backend that does not anchor and paste: the harness is on mux, interactive, no key", async () => {
    await staticPlugin();
    forwardOnView();
    await h.spawn({ cli: "claude", cwd: remote });
    expect(getAgent(h.db, "w1", "ws")).toMatchObject({ channel: "mux" });
    expect(channelPlugin()).toBeNull();
    expect(startSpec().env.MU_REMOTE_KEY).toBeUndefined();
    expect(viewCommand()).not.toContain("</dev/null");
  });
});

describe("a static --worktree base resolves in the caller's checkout (§3.3)", () => {
  /** A local checkout one commit ahead of the host's repo: the host lacks that commit. */
  const ahead = (): { local: string; sha: string } => {
    const local = join(h.dir, "local");
    git(h.dir, "clone", "-q", remote, local);
    git(local, "commit", "-q", "--allow-empty", "-m", "two");
    process.chdir(local);
    return { local, sha: git(local, "rev-parse", "HEAD") };
  };

  it("a sha the host lacks refuses naming host, repo, sha and both fixes; nothing is left; the retry with that sha works", async () => {
    // The link advertises push: a static host is never pushed to.
    await staticPlugin({}, { push: true });
    forwardOnView();
    const { local, sha } = ahead();
    const err = await h.spawn({ cli: "pi", worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteBaseMissingError);
    const msg = (err as Error).message;
    expect(msg).toContain(`${remote} on box lacks commit ${sha} (--from HEAD)`);
    expect(msg).toContain(`If ${sha} is published (a remote the host can fetch has it)`);
    expect(msg).toContain(`mu host exec box -- git -C ${remote} fetch <remote> ${sha}`);
    expect(msg).toContain(
      "If it is local-only: push it to a remote the host can fetch, then run that fetch on the host; or spawn from a published commit",
    );
    expect(msg).toContain(`spawn again with --from ${sha}`);
    expect(h.calls("link.push")).toEqual([]);
    expect(h.calls("job.start")).toEqual([]);
    expect(h.panes.size).toBe(0);
    expect(listCarrierJobs(h.db)).toEqual([]);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(existsSync(treeOf("w1"))).toBe(false);
    // The remedy (a host-side fetch), then the retry the message names.
    git(remote, "fetch", "-q", local, sha);
    const a = await h.spawn({ cli: "pi", worktree: true, from: sha });
    expect(a).toMatchObject({ base: sha });
  });

  it("the host's HEAD differs from the caller's: the tree is made from the caller's commit", async () => {
    await staticPlugin();
    forwardOnView();
    const { local, sha } = ahead();
    git(remote, "fetch", "-q", local, sha); // the host has it, but its HEAD is still `one`
    expect(git(remote, "rev-parse", "HEAD")).not.toBe(sha);
    const a = await h.spawn({ cli: "pi", worktree: true });
    expect(a).toMatchObject({ base: sha });
  });

  it("a --from that names no local commit refuses naming the ref, before any remote call", async () => {
    await staticPlugin();
    forwardOnView();
    const err = await h.spawn({ cli: "pi", worktree: true, from: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteBaseRefError);
    expect((err as Error).message).toContain("--from nope names no commit in");
    expect(h.calls("link.exec")).toEqual([]);
    expect(h.calls("job.start")).toEqual([]);
    expect(listCarrierJobs(h.db)).toEqual([]);
  });
});

describe("an own-channel kind keeps its shape (G2 regression)", () => {
  it("at-start, detached, honours env and sockets false, on a provider host: env {}, no sockets, read-only view, ctl skipped", async () => {
    const honours = { command: false, env: false, sockets: false, roles: ["full-access"] };
    await h.setup({ firstTurn: "at-start", view: "detached", honours });
    const a = await h.spawn({ firstPrompt: "build it" });
    expect(a).toMatchObject({ ctl: "skipped", ctlSocket: "" });
    expect(a.firstSend).toMatchObject({ transport: CLOUD.name, runs: 0 });
    const spec = startSpec();
    expect(spec.env).toEqual({});
    expect(spec.sockets).toBeUndefined();
    expect(spec.cmd).toBe("claude"); // no presets, no anchor
    expect(viewCommand().startsWith("exec </dev/null; ")).toBe(true);
    expect(getAgent(h.db, "w1", "ws")).toMatchObject({ channel: "cloud" });
    expect(channelPlugin()).toBe("fake");
    // Detached: the job is stopped first, the view after.
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(h.stopsAtKill).toEqual([1]);
  });

  it("an at-start kind with no channel of its own refuses before any record", async () => {
    await staticPlugin({ firstTurn: "at-start" });
    forwardOnView();
    const err = await h.spawn({ cli: "pi", cwd: remote, firstPrompt: "x" }).catch((e) => e);
    expect(String(err)).toMatch(/needs its own channel/);
    expect(listCarrierJobs(h.db)).toEqual([]);
  });
});
