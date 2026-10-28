// `agent spawn --host` on a LEASE profile on a REAL tmux server, with a fake
// carrier SCRIPT in the pane (spec 2026-10-28-lease-transport.md, § Testing):
// it writes the job file first (temp + rename), binds the local ctl socket and
// serves a stub ctl there, records SIGHUP, and the profile's `stop` logs every
// call with its handle. `exec` is a canned sh shim; `fetch` is a real git fetch,
// so `agent collect` runs for real. No real host, and no mule.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CarrierJobUnstoppedError, LeaseJobTimeoutError } from "../src/agents/lease-carrier.js";
import {
  AgentDiedOnSpawnError,
  AgentSpawnStartupError,
  getAgent,
  spawnAgent,
} from "../src/agents.js";
import { getCarrierJobByAgent, getCarrierJobByName, listCarrierJobs } from "../src/carrier-jobs.js";
import { carrierJobFilePath } from "../src/ctl/path.js";
import { CTL_FEATURES, CTL_OPS } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, HostProfileError, listHostChannels } from "../src/hosts.js";
import { collectRemoteAgent } from "../src/remote-collect.js";
import { listRemoteRecoveries } from "../src/remote-recovery.js";
import { killSession, tmux } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { initGitRepo } from "./_git.js";
import { tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;

const SHA = "a".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/lease/worker-1";

/**
 * The fake carrier: argv <job file> <local sock> <log> <mode dir> -- <env words...> <cmd>.
 * Modes (files in <mode dir>): `nofile` never writes the handle, `die` prints and exits first,
 * `noctl` binds no socket, `print` prints its content (a startup line for the scan).
 */
const CARRIER = `
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const [jobFile, sock, log, modes] = process.argv.slice(2);
const mode = (m) => fs.existsSync(path.join(modes, m));
const say = (l) => fs.appendFileSync(log, l + "\\n");
process.on("SIGHUP", () => { say("sighup"); process.exit(129); });
if (mode("print")) process.stdout.write(fs.readFileSync(path.join(modes, "print"), "utf8") + "\\n");
if (mode("die")) {
  process.stdout.write("mule: no master for dev\\n");
  setTimeout(() => process.exit(3), 700);
} else {
  const handle = "job-" + process.pid;
  if (!mode("nofile")) {
    fs.mkdirSync(path.dirname(jobFile), { recursive: true });
    fs.writeFileSync(jobFile + ".tmp", handle + "\\n", { mode: 0o600 });
    fs.renameSync(jobFile + ".tmp", jobFile);
    say("dispatch " + handle);
  }
  if (!mode("noctl")) {
    const hello = { v: 1, ok: true, ops: ${JSON.stringify([...CTL_OPS])}, features: ${JSON.stringify([...CTL_FEATURES])}, incarnation: "inc-lease", extVersion: "3.99.0" };
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    fs.rmSync(sock, { force: true });
    net.createServer((c) => {
      let buf = "";
      c.on("error", () => {});
      c.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\\n")) >= 0) {
          const req = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          c.write(JSON.stringify(req.op === "hello" ? hello : { v: 1, ok: true, state: "idle", since: 1, runs: 1, pending: false, incarnation: "inc-lease" }) + "\\n");
        }
      });
    }).listen(sock);
  }
  setInterval(() => {}, 1000);
}
`;

let dir: string;
let db: Db;
let ws: string;
let log: string;
let modes: string;
let local: string;
let remote: string;
let saved: Record<string, string | undefined>;
const ENV_KEYS = ["MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS", "MU_SPAWN_JOB_MS"];

const lines = (): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
const mode = (m: string, content = ""): void => writeFileSync(join(modes, m), content);
const unmode = (m: string): void => rmSync(join(modes, m), { force: true });
const channels = () => listHostChannels(db, "dev");
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mlsi-")));
  log = join(dir, "log");
  modes = join(dir, "modes");
  local = join(dir, "local");
  remote = join(dir, "remote");
  for (const d of [modes, local, remote]) mkdirSync(d);
  initGitRepo(local);
  initGitRepo(remote);
  writeFileSync(join(dir, "carrier.js"), CARRIER);
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_SPAWN_CTL_MS = "3000";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_JOB_MS = "5000";
  db = openDb({ path: join(dir, "mu.db") });
  ws = `lsi${process.pid}x${Math.floor(Math.random() * 1e6)}`.slice(0, 32);
  ensureWorkstream(db, ws);
  const exec = join(dir, "exec.sh");
  writeFileSync(
    exec,
    `#!/bin/sh
case "$1" in
  *'worktree add'*) echo "exec add" >> '${log}'
    echo "MU_REPO $(printf /srv/repo | od -An -v -tx1 | tr -d ' \\n')"; echo "MU_WT ${SHA} ${WT}" ;;
  *'worktree remove'*) echo "exec rm" >> '${log}'; echo "MU_RM removed" ;;
  *MU_CWD*) echo "MU_CWD /srv/repo" ;;
esac
`,
  );
  const stop = join(dir, "stop.sh");
  writeFileSync(
    stop,
    `#!/bin/sh\necho "stop $1" >> '${log}'\n[ -f '${modes}/stopfail' ] && { echo "no route" >&2; exit 1; }\nexit 0\n`,
  );
  chmodSync(exec, 0o755);
  chmodSync(stop, 0o755);
  addHost(db, {
    name: "dev",
    transport: "lease",
    shell: `exec ${process.execPath} ${join(dir, "carrier.js")} {job_file} {local_sock} ${log} ${modes} -- {env} {cmd} {remote_sock}`,
    exec: `/bin/sh ${exec} {cmd}`,
    stop: `/bin/sh ${stop} {job}`,
    fetch: `git fetch -q '${remote}' HEAD`,
    repo: "/srv/repo",
    max_sessions: 1,
  });
});

afterEach(async () => {
  try {
    await killSession(`mu-${ws}`);
  } catch {}
  db.close();
  rmFixtureDir(dir);
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const spawn = (over: Partial<Parameters<typeof spawnAgent>[1]> = {}) =>
  spawnAgent(db, { name: "worker-1", workstream: ws, host: "dev", ...over });
const handleOf = (): string =>
  lines()
    .find((l) => l.startsWith("dispatch "))
    ?.slice("dispatch ".length) ?? "";

describeIfTmux("lease spawn (real tmux, fake carrier script)", () => {
  it("records the carrier's handle, holds no channel, and collect at --max-sessions 1 runs beside it", async () => {
    const a = await spawn({ worktree: true });
    expect(a.ctl).toBe("ok");
    expect(getCarrierJobByAgent(db, a.incarnation)).toMatchObject({ host: "dev", job: handleOf() });
    expect(channels()).toEqual([]);
    const r = await collectRemoteAgent(db, { workstream: ws, name: "worker-1", repo: local });
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
    expect(channels()).toEqual([]);
    expect(getAgent(db, "worker-1", ws)?.collectedHead).toBe(r.head);
  }, 30_000);

  it("the job handshake runs under --no-ctl and under MU_SPAWN_CTL_MS=0", async () => {
    mode("noctl");
    const a = await spawn({ ctl: false });
    expect(a.ctl).toBe("skipped");
    expect(getCarrierJobByAgent(db, a.incarnation)?.job).toMatch(/^job-\d+$/);
    process.env.MU_SPAWN_CTL_MS = "0";
    const b = await spawn({ name: "worker-2" });
    expect(b.ctl).toBe("skipped");
    expect(getCarrierJobByAgent(db, b.incarnation)?.job).toMatch(/^job-\d+$/);
  }, 30_000);

  it("no job file by MU_SPAWN_JOB_MS: the carrier gets SIGHUP, nothing is stopped, reservation and tree kept", async () => {
    process.env.MU_SPAWN_JOB_MS = "800";
    mode("nofile");
    const err = await spawn({ worktree: true, ctl: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseJobTimeoutError);
    await until(() => lines().includes("sighup"), "the carrier's SIGHUP");
    expect(lines().filter((l) => l.startsWith("stop"))).toEqual([]);
    expect(lines()).not.toContain("exec rm");
    expect(getAgent(db, "worker-1", ws)).toBeUndefined();
    expect(getCarrierJobByName(db, ws, "worker-1")).toMatchObject({ launch: "intent", job: null });
  }, 30_000);

  it("a carrier that dies before its handle: AgentDiedOnSpawnError carries its screen; reservation kept", async () => {
    mode("die");
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDiedOnSpawnError);
    expect((err as Error).message).toContain("mule: no master for dev");
    expect(lines()).toEqual(["exec add"]);
    expect(getCarrierJobByName(db, ws, "worker-1")).toMatchObject({ launch: "intent", job: null });
  }, 30_000);

  // The refuter's counterexamples (fix_mu_lease_spawn REVISION 3): tmux runs the pane
  // command and still makes the spawn reject before mu learns the pane id. The carrier
  // may publish later, so the reservation is KEPT and the name stays fenced.
  for (const [what, hook] of [
    ["an after-new-window hook that fails", "select-pane -t %999999"],
    ["an after-new-window hook that prints extra output", "display-message -p EXTRA"],
  ] as const) {
    it(`${what}: the spawn rejects after the launch, and the reservation is kept`, async () => {
      // A session hook (never global): the session must exist first.
      await tmux(["new-session", "-d", "-s", `mu-${ws}`, "-n", "_mu", "exec sleep 60"]);
      await tmux(["set-hook", "-t", `mu-${ws}`, "after-new-window", hook]);
      const err = await spawn({ ctl: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      await until(() => handleOf() !== "", "the carrier's late publication");
      expect(getCarrierJobByName(db, ws, "worker-1")).toMatchObject({
        launch: "intent",
        job: null,
        paneId: null,
      });
      const again = await spawn({ ctl: false }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(CarrierJobUnstoppedError);
      expect(existsSync(carrierJobFilePath(ws, "worker-1", dir))).toBe(true);
    }, 30_000);
  }

  it("rollback after the handle: stop (with the handle) runs before the worktree removal", async () => {
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    mode("print", "Error: invalid API key");
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSpawnStartupError);
    const job = handleOf();
    const l = lines().filter((x) => x !== "sighup");
    expect(l).toEqual(["exec add", `dispatch ${job}`, `stop ${job}`, "exec rm"]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(existsSync(carrierJobFilePath(ws, "worker-1", dir))).toBe(false);
    expect(listRemoteRecoveries(db)).toEqual([]);
  }, 30_000);

  it("a failed stop keeps the worktree and the handle; a respawn of the name then refuses", async () => {
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    mode("print", "Error: invalid API key");
    mode("stopfail");
    await expect(spawn({ worktree: true })).rejects.toBeInstanceOf(AgentSpawnStartupError);
    const job = handleOf();
    expect(lines()).not.toContain("exec rm");
    expect(listCarrierJobs(db)).toMatchObject([{ name: "worker-1", job, host: "dev" }]);
    expect(listRemoteRecoveries(db)).toMatchObject([{ name: "worker-1", cwd: WT }]);
    unmode("print");
    unmode("stopfail");
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierJobUnstoppedError);
    expect((err as Error).message).toBe(
      `worker-1 has an unstopped job ${job} on dev: mu agent close worker-1`,
    );
    expect(lines().filter((l) => l === "exec add")).toHaveLength(1);
  }, 30_000);

  it("a lease profile refuses a command gate before any effect", async () => {
    const err = await spawn({ command: "npm test" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostProfileError);
    expect(lines()).toEqual([]);
  }, 30_000);
});
