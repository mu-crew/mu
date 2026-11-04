// `mu agent reattach` on a REAL tmux server with a fake carrier SCRIPT (spec
// docs/specs/2026-11-04-lease-adopt.md § mu_adopt): a real lease spawn, its pane killed and
// its row reaped by reconcile (the 2026-11-04 aiv-blog incident's shape), then the
// profile's attach template opens a new carrier that holds (binds the ctl socket and serves
// a stub ctl) or exits with mule's `not running` line. No real host, and no mule.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewReattach, ReattachFailedError, reattachAgent } from "../src/agents/reattach.js";
import { closeAgent, getAgent, spawnAgent } from "../src/agents.js";
import { getCarrierJobByName, listCarrierJobs } from "../src/carrier-jobs.js";
import { CTL_FEATURES, CTL_OPS } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { reconcile } from "../src/reconcile.js";
import { listRemoteRecoveries } from "../src/remote-recovery.js";
import { killPane, killSession } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;

const SHA = "a".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/lri/worker-1";

/**
 * The fake carrier: argv <mode dir> <log> <job file> <local sock> [<job>]. Without a job it is
 * a fresh lease (writes the handle); with one it attaches. Mode `attachdie` (a file in the
 * mode dir): the attach prints mule's line and exits 1. Otherwise it serves a stub ctl.
 */
const CARRIER = `
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const [modes, log, jobFile, sock, fifth] = process.argv.slice(2);
const attach = fifth === "--" ? undefined : fifth;
const say = (l) => fs.appendFileSync(log, l + "\\n");
process.on("SIGHUP", () => { say("sighup " + (attach ?? "lease")); process.exit(129); });
if (attach && fs.existsSync(path.join(modes, "attachdie"))) {
  process.stdout.write("mule: job " + attach + " is not running (Done(0))\\n");
  setTimeout(() => process.exit(1), 700);
} else {
  if (!attach) {
    const handle = "job-" + process.pid;
    fs.mkdirSync(path.dirname(jobFile), { recursive: true });
    fs.writeFileSync(jobFile + ".tmp", handle + "\\n");
    fs.renameSync(jobFile + ".tmp", jobFile);
    say("dispatch " + handle);
  } else say("attach " + attach);
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
  setInterval(() => {}, 1000);
}
`;

let dir: string;
let db: Db;
let ws: string;
let log: string;
let modes: string;
let saved: Record<string, string | undefined>;
const ENV_KEYS = ["MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS", "MU_SPAWN_JOB_MS"];

const lines = (): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mlri-")));
  log = join(dir, "log");
  modes = join(dir, "modes");
  mkdirSync(modes);
  writeFileSync(join(dir, "carrier.js"), CARRIER);
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_SPAWN_CTL_MS = "3000";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_JOB_MS = "5000";
  db = openDb({ path: join(dir, "mu.db") });
  ws = `lri${process.pid}x${Math.floor(Math.random() * 1e6)}`.slice(0, 32);
  ensureWorkstream(db, ws);
  const exec = join(dir, "exec.sh");
  writeFileSync(
    exec,
    `#!/bin/sh
case "$1" in
  *'worktree add'*) echo "MU_REPO $(printf /srv/repo | od -An -v -tx1 | tr -d ' \\n')"; echo "MU_WT ${SHA} ${WT}" ;;
  *MU_RM*) echo "exec rm" >> '${log}'; echo "MU_RM removed" ;;
  *MU_STATE*) echo "MU_STATE clean ${SHA}" ;;
esac
`,
  );
  const stop = join(dir, "stop.sh");
  writeFileSync(stop, `#!/bin/sh\necho "stop $1" >> '${log}'\n`);
  chmodSync(exec, 0o755);
  chmodSync(stop, 0o755);
  const node = `exec ${process.execPath} ${join(dir, "carrier.js")} ${modes} ${log}`;
  addHost(db, {
    name: "dev",
    transport: "lease",
    shell: `${node} {job_file} {local_sock} -- {env} {cmd} {remote_sock}`,
    attach: `${node} {job_file} {local_sock} {job} {remote_sock}`,
    exec: `/bin/sh ${exec} {cmd}`,
    stop: `/bin/sh ${stop} {job}`,
    fetch: "true",
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

/** A real lease --worktree spawn whose pane then dies and whose row reconcile reaps; its spawn process is gone. */
async function reapedLease(): Promise<{ job: string; agentId: number }> {
  const a = await spawnAgent(db, { name: "worker-1", workstream: ws, host: "dev", worktree: true });
  const job = getCarrierJobByName(db, ws, "worker-1")?.job ?? "";
  await killPane(a.paneId);
  await until(() => lines().includes("sighup lease"), "the carrier's SIGHUP");
  await reconcile(db, { workstream: ws });
  expect(getAgent(db, "worker-1", ws)).toBeUndefined();
  // The CLI process that spawned it has exited (here: the test process stands in; point it at a dead pid).
  db.prepare("UPDATE carrier_jobs SET creator_pid = ?").run(spawnSync("true").pid);
  return { job, agentId: a.incarnation };
}

describeIfTmux("agent reattach (real tmux, fake carrier script)", () => {
  it("a holding carrier: ready, the row takes the tree, then a reap records it under the new incarnation", async () => {
    const { job, agentId } = await reapedLease();
    expect(listRemoteRecoveries(db).map((r) => r.agentId)).toEqual([agentId]);
    const p = await previewReattach(db, ws, "worker-1");
    expect(p).toMatchObject({ job, recovery_id: agentId, cwd: WT });
    const r = await reattachAgent(db, ws, "worker-1", { ifRevision: p.revision });
    expect(r).toMatchObject({ ready: true, ctl: "ok" });
    expect(lines()).toContain(`attach ${job}`);
    expect(listRemoteRecoveries(db)).toEqual([]);
    expect(getAgent(db, "worker-1", ws)).toMatchObject({ cwd: WT, base: SHA, host: "dev" });
    // Pane death is agent death again: the new carrier's SIGHUP, the reap, a NEW record.
    await killPane(r.pane_id);
    await until(() => lines().includes(`sighup ${job}`), "the attached carrier's SIGHUP");
    await reconcile(db, { workstream: ws });
    expect(listRemoteRecoveries(db).map((x) => x.agentId)).toEqual([r.agent_id]);
    expect(getCarrierJobByName(db, ws, "worker-1")).toMatchObject({ agentId: r.agent_id, job });
  }, 30_000);

  it("after a reattach, agent close stops the job and closes the tree", async () => {
    const { job } = await reapedLease();
    await reattachAgent(db, ws, "worker-1", {
      ifRevision: (await previewReattach(db, ws, "worker-1")).revision,
    });
    const out = await closeAgent(db, "worker-1", { workstream: ws });
    expect(out.deletedRow).toBe(true);
    expect(lines()).toContain(`stop ${job}`);
    expect(lines()).toContain("exec rm");
    expect(listCarrierJobs(db)).toEqual([]);
    expect(listRemoteRecoveries(db)).toEqual([]);
  }, 30_000);

  it("a carrier that exits (job not running): rolled back, record and reservation restored, mule's line shown", async () => {
    await reapedLease();
    const before = JSON.stringify(listRemoteRecoveries(db));
    const reservation = getCarrierJobByName(db, ws, "worker-1");
    writeFileSync(join(modes, "attachdie"), "");
    const e = await reattachAgent(db, ws, "worker-1", {
      ifRevision: (await previewReattach(db, ws, "worker-1")).revision,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReattachFailedError);
    expect((e as ReattachFailedError).rollback).toBe("restored");
    expect((e as Error).message).toContain("is not running (Done(0))");
    expect(JSON.stringify(listRemoteRecoveries(db))).toBe(before);
    expect(getCarrierJobByName(db, ws, "worker-1")).toEqual(reservation);
    expect(getAgent(db, "worker-1", ws)).toBeUndefined();
    expect(lines().some((l) => l.startsWith("stop"))).toBe(false);
  }, 30_000);
});
