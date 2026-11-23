// bound_plugin_reattach_kept_null (lease_linux_lifecycle P5) on real private tmux: a bound
// `handle: "file"` plugin kind's view (mule's carrier, here a node stand-in that publishes the
// handle and serves the forwarded ctl socket) is SIGKILLed while its job runs. Reconcile keeps
// the row; `mu agent reattach` calls `job.attach` with the job file and the rebuilt socket pair,
// opens a fresh view, binds the record to it with the server that created it, and ctl answers.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { previewReattach, reattachAgent } from "../src/agents/reattach.js";
import { getAgent } from "../src/agents.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { ctlSocketPath, remoteCtlSocketPath } from "../src/ctl/path.js";
import { addHost } from "../src/hosts.js";
import { HONOURS_ALL } from "../src/jobs/types.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { addPlugin } from "../src/plugins/registry.js";
import { reconcile } from "../src/reconcile.js";
import { shellQuote } from "../src/shell-quote.js";
import { tmux } from "../src/tmux.js";
import { helloReply } from "./_ctl-ext.js";
import { pollUntil } from "./_env.js";
import { tmuxIntegrationAvailable } from "./_mux.js";
import { fakePlugin, jobSeams, linkSeam } from "./_plugin.js";
import { pluginHostFixture } from "./_plugin-host.js";
import { registerTmuxSocket, stopTestTmux } from "./_server-registry.js";

const h = pluginHostFixture({ handshakeInProcess: true });
const FILE = { handle: "file", start: { lookup: true, fenceKey: false }, view: "bound" };
const ENV = ["MU_TMUX_SOCKET", "MU_SPAWN_LIVENESS_MS", "MU_SPAWN_CTL_MS", "HOME"] as const;

let saved: Record<string, string | undefined>;
let socket: string | undefined;
let cwd: string;

/** The view: publish the handle, then serve ctl at the local socket (what a forward exposes). */
const CTL = `import { createServer } from "node:net";
import { rmSync } from "node:fs";
const [sock, hello] = process.argv.slice(2);
rmSync(sock, { force: true });
createServer((s) => {
  s.setEncoding("utf8");
  s.on("error", () => {});
  let buf = "";
  s.on("data", (c) => {
    buf += c;
    for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
      const req = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const h = JSON.parse(hello);
      const reply = req.op === "hello" ? h : { v: 1, ok: true, state: "idle", since: 1, runs: 0, pending: false, incarnation: h.incarnation };
      s.end(JSON.stringify(reply) + "\\n");
    }
  });
}).listen(sock);
`;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  cwd = process.cwd();
  socket = registerTmuxSocket();
  process.env.MU_TMUX_SOCKET = socket;
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_CTL_MS = "5000";
  process.env.HOME = h.dir;
});
afterEach(() => {
  try {
    stopTestTmux(socket);
  } catch {}
  process.chdir(cwd);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const panePid = async (pane: string): Promise<number> =>
  Number((await tmux(["display-message", "-p", "-t", pane, "#{pane_pid}"])).trim());

describe.skipIf(!tmuxIntegrationAvailable())("a bound file view SIGKILLed, its job running", () => {
  it("reattach calls job.attach with the job file and a fresh socket pair, and binds the new view", async () => {
    const remote = join(realpathSync(h.dir), "remote");
    mkdirSync(remote);
    execFileSync("git", ["init", "-q"], { cwd: remote });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "a"],
      { cwd: remote },
    );
    process.chdir(remote);
    const jobFile = leaseJobFile(h.db, "ws", "w1");
    const sock = ctlSocketPath("ws", "w1", h.dir);
    const script = join(h.dir, "ctl.mjs");
    writeFileSync(script, CTL);
    const view = [
      `printf '%s\\n' file-job-1 > ${shellQuote(jobFile)}`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(sock)} ${shellQuote(JSON.stringify(helloReply()))}`,
    ].join("; ");
    const seams = { ...jobSeams({ honours: HONOURS_ALL, ...FILE }), ...linkSeam() };
    h.f = fakePlugin(h.dir, { seams, viewCommand: view });
    await addPlugin(h.db, "fake", h.f.argv);
    addHost(h.db, { name: "box", plugin: "fake", fetch: "true", repo: remote, max_sessions: null });
    setMuxForTests(tmuxBackend);

    const a = await h.spawn({ cli: "pi", cwd: remote });
    expect(a).toMatchObject({ ctl: "ok" });
    expect(getCarrierJobByName(h.db, "ws", "w1")).toMatchObject({
      job: "file-job-1",
      wireState: "bound",
      paneId: a.paneId,
    });

    // SIGKILL the carrier (its process group): the pane goes, the job runs on.
    const pid = await panePid(a.paneId);
    process.kill(-pid, "SIGKILL");
    await pollUntil(async () => !(await tmuxBackend.paneAlive(a.paneId)), {
      attempts: 100,
      intervalMs: 50,
      description: "the carrier pane gone",
    });
    await reconcile(h.db, { workstream: "ws" });
    expect(getAgent(h.db, "w1", "ws")?.paneId).toBe(a.paneId);

    const p = await previewReattach(h.db, "ws", "w1");
    const r = await reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision });
    expect(r).toMatchObject({ ready: true, ctl: "ok", previous_pane_id: a.paneId });

    const attach = h.calls("job.attach");
    expect(attach).toHaveLength(1);
    expect(attach[0]?.params).toMatchObject({
      jobFile,
      sockets: { local: sock, remote: remoteCtlSocketPath("ws", "w1", process.getuid?.() ?? 0) },
      target: { job: { handle: "file-job-1" } },
    });
    const server = (await tmux(["list-sessions", "-F", "#{pid}|#{start_time}"])).trim();
    expect(server).toMatch(/^\d+\|\d+$/);
    expect(getCarrierJobByName(h.db, "ws", "w1")).toMatchObject({
      wireState: "bound",
      paneId: r.pane_id,
      viewServer: `tmux:${server.split("\n")[0]}`,
    });
    expect(getAgent(h.db, "w1", "ws")).toMatchObject({
      paneId: r.pane_id,
      incarnation: a.incarnation,
    });
    expect(await tmuxBackend.paneAlive(r.pane_id)).toBe(true);
    expect(h.f.backend().stops).toBe(0);
    expect(readFileSync(jobFile, "utf8")).toBe("file-job-1\n");
  });
});
