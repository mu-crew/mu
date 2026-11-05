// `mu agent reattach` (spec docs/specs/2026-11-04-lease-adopt.md § G3 mu_adopt), fast tier.
// A reaped lease agent (row gone, reservation + recovery kept) gets a new carrier pane. The
// fake tmux's pane creation is the carrier: per `carrier` it serves the ctl socket, serves
// nothing, or "exits" (its pane disappears). `stop` and `exec` are sh shims logging to ONE
// order log, so "no stop ran" is read from it. No real host, no mule.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  previewReattach,
  ReattachFailedError,
  ReattachRefusedError,
  reattachAgent,
  reattachBlockers,
} from "../src/agents/reattach.js";
import {
  AgentExistsError,
  AgentReplacedError,
  closeAgent,
  deleteAgent,
  getAgent,
  insertAgent,
} from "../src/agents.js";
import {
  bindCarrierJobAgent,
  type CarrierJob,
  fillCarrierJob,
  getCarrierJobByName,
  listCarrierJobs,
  markCarrierLaunch,
  noteCarrierJob,
  releaseCarrierJob,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import { carrierJobFilePath, ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { listLogs } from "../src/logs.js";
import { reconcile } from "../src/reconcile.js";
import { listRemoteRecoveries, type RemoteRecovery } from "../src/remote-recovery.js";
import { agentRevision, RevisionMismatchError } from "../src/revision.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import {
  previewReinit,
  reinitWorkstream,
  teardownWorkstream,
  workstreamRevision,
} from "../src/workstream.js";
import { helloReply, withHello } from "./_ctl-ext.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const BASE = "b".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/worker-1";
const ATTACH =
  "carrier --attach {job} --job-file {job_file} --forward-unix {local_sock}:{remote_sock}";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let servers: Server[];
let orderLog: string;
let stop: string;
/** What the fake carrier does when its pane opens. */
let carrier: "ctl" | "noctl" | "exit" | "exit-after-ctl" | "retained-exit";
/** Runs before every tmux call. */
let beforeTmux: ((args: readonly string[]) => void) | undefined;
/** The pane the `exit` carrier leaves at its first liveness probe. */
let dieAfterCapture: string | undefined;
let saved: Record<string, string | undefined>;
const ENV_KEYS = ["MU_DB_PATH", "MU_STATE_DIR", "MU_SYNC_DIR", "MU_SPAWN_CTL_MS"];

const order = (): string[] =>
  existsSync(orderLog) ? readFileSync(orderLog, "utf8").trim().split("\n").filter(Boolean) : [];
const jobFile = () => carrierJobFilePath("auth", "worker-1", dir);
const reservation = (): CarrierJob | undefined => getCarrierJobByName(db, "auth", "worker-1");
const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
/** A pid that is certainly gone: a child that already exited. */
const deadPid = (): number => spawnSync("true").pid ?? 999_999;
const isPaneCall = (a: readonly string[]): boolean =>
  ["new-session", "new-window", "split-window"].includes(a[0] ?? "");

async function serveCtl(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string };
        const status = { v: 1, ok: true, state: "idle", since: 1, runs: 1, pending: false };
        sock.end(encode(withHello(req, status, helloReply())));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mra-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  orderLog = join(dir, "order");
  servers = [];
  carrier = "ctl";
  beforeTmux = undefined;
  dieAfterCapture = undefined;
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_DB_PATH = dbPath;
  process.env.MU_STATE_DIR = join(dir, "state");
  process.env.MU_SYNC_DIR = join(dir, "sync");
  process.env.MU_SPAWN_CTL_MS = "300";
  setSleepForTests(async () => {});
  const sh = (file: string, body: string): string => {
    writeFileSync(join(dir, file), `#!/bin/sh\n${body}\n`);
    return `/bin/sh ${join(dir, file)}`;
  };
  stop = `${sh("stop.sh", `echo "stop $1" >> '${orderLog}'`)} {job}`;
  addHost(db, {
    name: "dev",
    transport: "lease",
    shell: "carrier J={job_file} L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
    exec: `${sh(
      "exec.sh",
      `case "$1" in *MU_RM*) echo "exec rm" >> '${orderLog}'; echo "MU_RM removed" ;;
  *MU_STATE*) echo "exec observe" >> '${orderLog}'; echo "MU_STATE clean ${BASE}" ;;
esac`,
    )} {cmd}`,
    stop,
    attach: ATTACH,
    fetch: "true",
    repo: "/srv/repo",
    max_sessions: 1,
  });
  state = freshMockState();
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    beforeTmux?.(args);
    const target = args[args.indexOf("-t") + 1] ?? "";
    if (args[0] === "display-message" && target === dieAfterCapture) state.panes.delete(target);
    if (args[0] === "kill-pane") writeFileSync(orderLog, `kill ${args[2]}\n`, { flag: "a" });
    const res = await fake(args);
    if (!isPaneCall(args)) return res;
    const pane = res.stdout.trim();
    if (carrier === "ctl" || carrier === "exit-after-ctl") {
      await serveCtl(ctlSocketPath("auth", "worker-1", dir));
    }
    if (carrier === "exit") {
      // mule's own line is in the scrollback for one capture, then the pane is gone.
      const p = state.panes.get(pane);
      if (p) p.scrollback = "mule: job job-1 is not running (Done(0))";
      dieAfterCapture = pane;
    }
    if (carrier === "retained-exit") {
      const p = state.panes.get(pane);
      if (p) p.exit = { code: 1, signal: null };
    }
    return res;
  });
});

afterEach(async () => {
  mux.restore();
  resetSleep();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmFixtureDir(dir);
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/**
 * A lease agent the reaper removed, as the incident left it: its pane gone, its row deleted
 * (the trigger wrote a recovery for a `--worktree` row), its reservation (launched, bound,
 * handle known) and its job file kept. Its spawn's process is gone.
 */
function reaped(
  over: {
    worktree?: boolean;
    collected?: string;
    fill?: boolean;
    job?: string;
    pane?: string;
  } = {},
): {
  agentId: number;
  r: CarrierJob;
} {
  const r = reserveCarrierJob(db, {
    workstream: "auth",
    name: "worker-1",
    host: "dev",
    hostStop: stop,
    creatorPid: deadPid(),
  });
  if (r === undefined) throw new Error("reserved already");
  markCarrierLaunch(db, r.token);
  const worktree = over.worktree !== false;
  const row = insertAgent(db, {
    name: "worker-1",
    workstream: "auth",
    paneId: over.pane ?? "%90",
    host: "dev",
    hostTransport: "lease",
    reservation: r.token,
    ...(worktree
      ? {
          cwd: WT,
          base: BASE,
          repo: "/srv/repo",
          ...(over.collected ? { collectedHead: over.collected } : {}),
        }
      : { cwd: "/srv/repo" }),
  });
  const job = over.job ?? "job-1";
  bindCarrierJobAgent(db, r.token, row.incarnation, over.pane ?? "%90");
  if (over.fill !== false) fillCarrierJob(db, r.token, job);
  mkdirSync(dirname(jobFile()), { recursive: true });
  writeFileSync(jobFile(), `${job}\n`);
  deleteAgent(db, "worker-1", "auth");
  const out = reservation();
  if (out === undefined) throw new Error("no reservation");
  return { agentId: row.incarnation, r: out };
}

const rev = (): number => agentRevision(db, "auth", "worker-1");
const apply = (ifRevision = rev()) => reattachAgent(db, "auth", "worker-1", { ifRevision });
const snapshot = () => ({
  agents: db.prepare("SELECT * FROM agents").all(),
  jobs: listCarrierJobs(db),
  recs: listRemoteRecoveries(db),
});

describe("happy path", () => {
  it("a reaped --worktree agent: preview gives a rev; apply installs the row, drops the record, rebinds", async () => {
    const { agentId } = reaped({ collected: "c".repeat(40) });
    const p = await previewReattach(db, "auth", "worker-1");
    expect(p).toMatchObject({
      host: "dev",
      job: "job-1",
      previous_agent_id: agentId,
      previous_pane_id: "%90",
      recovery_id: agentId,
      cwd: WT,
      base: BASE,
      revision: rev(),
    });
    const res = await apply(p.revision);
    expect(res).toMatchObject({ ready: true, ctl: "ok" });
    expect(getAgent(db, "worker-1", "auth")).toMatchObject({
      incarnation: res.agent_id,
      paneId: res.pane_id,
      cli: "pi",
      command: "pi",
      commandSource: "cli-key",
      role: "full-access",
      tab: "worker-1",
      cwd: WT,
      base: BASE,
      collectedHead: "c".repeat(40),
      repo: "/srv/repo",
      host: "dev",
    });
    expect(listRemoteRecoveries(db)).toEqual([]);
    expect(reservation()).toMatchObject({
      agentId: res.agent_id,
      paneId: res.pane_id,
      job: "job-1",
    });
    // The pane ran the attach template with the handle and the job file.
    const pane = mux.calls.find(isPaneCall)?.at(-1) ?? "";
    expect(pane).toContain(`--attach '"'"'job-1'"'"'`);
    expect(pane).toContain(`--job-file '"'"'${jobFile()}'"'"'`);
    const said = listLogs(db, { workstream: "auth" }).map((l) => [l.intent, l.payload]);
    expect(said).toContainEqual([
      "agent.reattach",
      `agent reattach worker-1 (host=dev, job=job-1, pane=${res.pane_id}, ctl=ok)`,
    ]);
    expect(order().some((l) => l.startsWith("stop"))).toBe(false);
  });

  it("a --cwd agent (no record): the tree fields are NULL", async () => {
    reaped({ worktree: false });
    expect(listRemoteRecoveries(db)).toEqual([]);
    const res = await apply();
    expect(res.recovery_id).toBeNull();
    expect(getAgent(db, "worker-1", "auth")).toMatchObject({ cwd: null, base: null, repo: null });
  });

  it("the CLI: bare previews with next = the --if apply; --if applies; a ready reattach removes its stop-failure record", async () => {
    reaped();
    writeFileSync(
      `${jobFile()}.job-1.stop-failed`,
      "job-1 on dev not stopped: no control master\n",
    );
    writeFileSync(`${jobFile()}.job-9.stop-failed`, "job-9 other\n");
    const pre = await runCliJson(["agent", "reattach", "worker-1", "-w", "auth", "--json"], dbPath);
    expect(pre.exitCode).toBeNull();
    expect(pre.data).toMatchObject({ dryRun: true, job: "job-1", revision: rev() });
    expect(pre.doc.next).toEqual({
      mode: "alt",
      commands: [`mu agent reattach worker-1 -w auth --if ${rev()}`],
    });
    const done = await runCliJson(
      ["agent", "reattach", "worker-1", "-w", "auth", "--if", String(rev()), "--json"],
      dbPath,
    );
    expect(done.exitCode).toBeNull();
    expect(done.data).toMatchObject({ ready: true, ctl: "ok" });
    expect(existsSync(`${jobFile()}.job-1.stop-failed`)).toBe(false);
    expect(existsSync(`${jobFile()}.job-9.stop-failed`)).toBe(true);
  });
});

describe("preflight refusals: nothing changed, the close preview named", () => {
  const refuses = async (setup: () => void | Promise<void>, why: RegExp, code?: string) => {
    setup();
    const before = snapshot();
    const blockers = await reattachBlockers(db, "auth", "worker-1");
    if (code !== undefined) expect(blockers[0]?.code).toBe(code);
    const e = await failure(previewReattach(db, "auth", "worker-1"));
    expect(e).toBeInstanceOf(ReattachRefusedError);
    expect((e as Error).message).toMatch(why);
    expect((e as ReattachRefusedError).closeCommand).toMatch(/^mu agent close worker-1 -w auth/);
    expect(await failure(apply(0))).toBeInstanceOf(ReattachRefusedError);
    expect(snapshot()).toEqual(before);
    expect(mux.calls.some(isPaneCall)).toBe(false);
  };

  it("live row → AgentExistsError", async () => {
    reaped();
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%1",
      reservation: reservation()?.token ?? "",
    });
    expect(await failure(previewReattach(db, "auth", "worker-1"))).toBeInstanceOf(AgentExistsError);
    expect((await reattachBlockers(db, "auth", "worker-1"))[0]?.code).toBe("row");
  });
  it("torn-down workstream", () =>
    refuses(
      async () => {
        reaped();
        db.prepare("UPDATE workstreams SET torn_down_at = 'x' WHERE name = 'auth'").run();
      },
      /torn down/,
      "workstream",
    ));
  it("bound in another workstream generation", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE carrier_jobs SET workstream_id = workstream_id + 100").run();
      },
      /created again/,
      "workstream",
    ));
  it("a binding older than the generation stamp (NULL) is unknown", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE carrier_jobs SET workstream_id = NULL").run();
      },
      /binding's workstream is unknown/,
      "workstream",
    ));
  it("two reservations (legacy ordinals)", () =>
    refuses(
      () => {
        reaped();
        db.prepare(
          "INSERT INTO carrier_jobs (token, workstream, name, host, host_stop, launch, created_at, ordinal) VALUES ('t2','auth','worker-1','dev','x','none',?, 1)",
        ).run(new Date().toISOString());
      },
      /2 lease reservations/,
      "reservation",
    ));
  it("no handle", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE carrier_jobs SET job = NULL").run();
      },
      /no job handle/,
      "reservation",
    ));
  it("a reason", () =>
    refuses(
      () => {
        const { r } = reaped();
        noteCarrierJob(db, r.token, "tree kept");
      },
      /kept: tree kept/,
      "reservation",
    ));
  it("unbound reservation", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE carrier_jobs SET agent_id = NULL").run();
      },
      /no job handle bound/,
      "reservation",
    ));
  it("previous pane alive", () =>
    refuses(
      () => {
        reaped();
        state.panes.set("%90", { windowId: "@1", paneId: "%90", command: "carrier" });
      },
      /previous pane %90 is alive/,
      "carrier",
    ));
  it("pane probe throws → unknown", () =>
    refuses(
      () => {
        reaped();
        beforeTmux = (a) => {
          if (a[0] === "display-message") throw new Error("tmux broke");
        };
      },
      /previous pane %90 is unknown/,
      "carrier",
    ));
  it("creator alive", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE carrier_jobs SET creator_pid = ?").run(process.pid);
      },
      /not proven gone/,
      "carrier",
    ));
  it("no attach template", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE host_profiles SET attach = NULL").run();
      },
      /attach template/,
      "profile",
    ));
  it("changed stop", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE host_profiles SET stop = 'other {job}'").run();
      },
      /stop changed/,
      "profile",
    ));
  it("session profile", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE host_profiles SET transport = 'session'").run();
      },
      /no lease profile/,
      "profile",
    ));
  it("record with another workstream_id", () =>
    refuses(
      () => {
        reaped();
        db.prepare("UPDATE remote_recovery SET workstream_id = workstream_id + 100").run();
      },
      /another workstream/,
      "recovery",
    ));
  it("newer record on the path", () =>
    refuses(
      () => {
        const { agentId } = reaped();
        db.prepare(
          "INSERT INTO remote_recovery SELECT agent_id + 50, workstream, workstream_id, workstream_created_at, 'worker-2', pane_id, host, cwd, base, collected_head, aside, host_exec, host_repo, reason, preserved_at FROM remote_recovery WHERE agent_id = ?",
        ).run(agentId);
      },
      /newer recovery/,
      "recovery",
    ));
  it("job file naming another handle", () =>
    refuses(
      () => {
        reaped();
        writeFileSync(jobFile(), "job-2\n");
      },
      /handle job-2/,
      "job-file",
    ));
  it("several records name --recovery in the close preview", async () => {
    const { agentId } = reaped();
    db.prepare(
      "INSERT INTO remote_recovery SELECT agent_id + 50, workstream, workstream_id, workstream_created_at, name, pane_id, host, cwd || '-x', base, collected_head, aside, host_exec, host_repo, reason, preserved_at FROM remote_recovery WHERE agent_id = ?",
    ).run(agentId);
    db.prepare("UPDATE host_profiles SET attach = NULL").run();
    const e = (await failure(previewReattach(db, "auth", "worker-1"))) as ReattachRefusedError;
    expect(e.closeCommand).toBe(`mu agent close worker-1 -w auth --recovery ${agentId}`);
  });
  it("stale --if → RevisionMismatchError, nothing changed", async () => {
    reaped();
    const before = snapshot();
    expect(await failure(apply(rev() + 1))).toBeInstanceOf(RevisionMismatchError);
    expect(snapshot()).toEqual(before);
    expect(mux.calls.some(isPaneCall)).toBe(false);
  });
  it("the CLI refusal: exit 4, the close preview in extra", async () => {
    reaped();
    db.prepare("UPDATE host_profiles SET attach = NULL").run();
    const r = await runCliJson(["agent", "reattach", "worker-1", "-w", "auth", "--json"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.doc).toMatchObject({
      ok: false,
      error: "ReattachRefusedError",
      close: "mu agent close worker-1 -w auth",
    });
  });
});

describe("readiness", () => {
  const rec = (): RemoteRecovery[] => listRemoteRecoveries(db);

  it("the carrier exits at once → record restored byte for byte, reservation rebound, no stop", async () => {
    const { r } = reaped();
    const before = JSON.stringify(db.prepare("SELECT * FROM remote_recovery").all());
    carrier = "exit";
    const e = await failure(apply());
    expect(e).toBeInstanceOf(ReattachFailedError);
    expect((e as ReattachFailedError).rollback).toBe("restored");
    expect((e as Error).message).toContain("not running (Done(0))");
    expect((e as Error).message).toContain("mu agent close worker-1 -w auth");
    expect(JSON.stringify(db.prepare("SELECT * FROM remote_recovery").all())).toBe(before);
    expect(reservation()).toEqual(r);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(order()).toEqual([]);
  });

  it("a retained exited pane counts as dead", async () => {
    reaped();
    carrier = "retained-exit";
    const e = await failure(apply());
    expect((e as ReattachFailedError).rollback).toBe("restored");
    expect(rec()).toHaveLength(1);
  });

  it.each(["missing", "refused"] as const)(
    "ctl %s with a live pane → row kept, ready:false",
    async (kind) => {
      reaped();
      carrier = "noctl";
      if (kind === "refused") {
        // A stale file at the path that no one serves: probes refused.
        beforeTmux = (a) => {
          if (isPaneCall(a)) {
            const p = ctlSocketPath("auth", "worker-1", dir);
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, "");
          }
        };
      }
      const res = await apply();
      expect(res).toMatchObject({ ready: false, ctl: kind });
      expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(res.agent_id);
      expect(rec()).toEqual([]);
    },
  );

  it("the mux probe throws during readiness → row kept, ctl unknown", async () => {
    reaped();
    carrier = "noctl";
    let created = false;
    beforeTmux = (a) => {
      if (isPaneCall(a)) created = true;
      else if (created && a[0] === "display-message") throw new Error("tmux broke");
    };
    const res = await apply();
    expect(res).toMatchObject({ ready: false, ctl: "unknown" });
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("handshake ok but the pane gone at the final check → rollback", async () => {
    reaped();
    carrier = "exit-after-ctl";
    // The handshake answers on its first probe; the pane is gone by the final check's capture.
    beforeTmux = (a) => {
      if (a[0] === "capture-pane") for (const id of [...state.panes.keys()]) state.panes.delete(id);
    };
    const e = await failure(apply());
    expect((e as ReattachFailedError).rollback).toBe("restored");
    expect(rec()).toHaveLength(1);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });
});

describe("a signal during readiness", () => {
  it("SIGINT/SIGTERM (the abort) keeps the row: the pane holds the job", async () => {
    reaped();
    carrier = "noctl";
    const ctl = new AbortController();
    beforeTmux = (a) => {
      if (a[0] === "capture-pane") ctl.abort();
    };
    const e = await failure(
      reattachAgent(db, "auth", "worker-1", { ifRevision: rev(), signal: ctl.signal }),
    );
    expect(e).not.toBeInstanceOf(ReattachFailedError);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(listRemoteRecoveries(db)).toEqual([]);
    expect(order()).toEqual([]);
  });
});

describe("races", () => {
  it("the new row reaped during readiness → already-handled, exactly one record (the new one)", async () => {
    reaped();
    carrier = "exit";
    let reapedNew = false;
    beforeTmux = (a) => {
      if (a[0] === "capture-pane" && !reapedNew) {
        reapedNew = true;
        deleteAgent(db, "worker-1", "auth");
      }
    };
    const e = await failure(apply());
    expect((e as ReattachFailedError).rollback).toBe("already-handled");
    const recs = listRemoteRecoveries(db);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.agentId).toBe(reservation()?.agentId);
  });

  it("the install transaction fails → the new pane killed and named on the reservation, nothing else changed", async () => {
    reaped();
    const before = snapshot();
    beforeTmux = (a) => {
      if (isPaneCall(a)) db.prepare("UPDATE remote_recovery SET collected_head = 'moved'").run();
    };
    const e = await failure(apply());
    expect((e as ReattachFailedError).rollback).toBe("pane-killed");
    expect((e as Error).message).toMatch(/recovery \d+ changed/);
    const pane = [...state.panes.keys()];
    expect(pane).toEqual([]);
    const killed = order()
      .find((l) => l.startsWith("kill %"))
      ?.slice("kill ".length);
    expect(killed).toBeDefined();
    const after = snapshot();
    expect(after.agents).toEqual(before.agents);
    expect(after.jobs).toEqual(before.jobs.map((j) => ({ ...j, paneId: killed })));
  });

  it("a teardown between preflight and install → pane killed, nothing installed", async () => {
    reaped();
    beforeTmux = (a) => {
      if (isPaneCall(a)) db.prepare("UPDATE workstreams SET torn_down_at = 'x'").run();
    };
    const e = await failure(apply());
    expect((e as ReattachFailedError).rollback).toBe("pane-killed");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(listRemoteRecoveries(db)).toHaveLength(1);
  });
});

describe("finding reattach_failed_kill_fence: a kill that fails after a failed install", () => {
  it("names the new pane on the reservation, reports pane-unknown, and the next preflight refuses on it", async () => {
    reaped();
    beforeTmux = (a) => {
      if (isPaneCall(a)) db.prepare("UPDATE remote_recovery SET collected_head = 'moved'").run();
      if (a[0] === "kill-pane") throw new Error("tmux transport broke");
    };
    const e = await failure(apply());
    expect(e).toBeInstanceOf(ReattachFailedError);
    expect((e as ReattachFailedError).rollback).toBe("pane-unknown");
    const [pane] = [...state.panes.keys()];
    expect(pane).toBeDefined();
    expect((e as Error).message).toContain(`${pane}`);
    expect(reservation()?.paneId).toBe(pane);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    beforeTmux = undefined;
    const blockers = await reattachBlockers(db, "auth", "worker-1");
    expect(blockers[0]).toMatchObject({ code: "carrier" });
    expect(blockers[0]?.detail).toContain(`${pane} is alive`);
  });

  it("a kill that throws but leaves the pane gone is pane-killed", async () => {
    reaped();
    beforeTmux = (a) => {
      if (isPaneCall(a)) db.prepare("UPDATE remote_recovery SET collected_head = 'moved'").run();
      if (a[0] === "kill-pane") {
        state.panes.clear();
        throw new Error("tmux answered late");
      }
    };
    const e = await failure(apply());
    expect((e as ReattachFailedError).rollback).toBe("pane-killed");
    expect(await reattachBlockers(db, "auth", "worker-1")).toEqual([]);
  });
});

describe("finding reattach_workstream_generation: the binding's workstream, not the handle's time", () => {
  const recreate = async (): Promise<void> => {
    await teardownWorkstream(db, {
      workstream: "auth",
      ifRevision: workstreamRevision(db, "auth"),
    });
    await reinitWorkstream(db, "auth", previewReinit(db, "auth")?.revision ?? 0);
  };

  it("an old --cwd binding whose handle lands after a real teardown + reinit refuses", async () => {
    const { r } = reaped({ worktree: false, fill: false });
    await recreate();
    // The late fill: a close of the name learns the handle (and its stop fails).
    expect(fillCarrierJob(db, r.token, "job-1")).toBe(true);
    const blockers = await reattachBlockers(db, "auth", "worker-1");
    expect(blockers[0]).toMatchObject({ code: "workstream" });
    expect(await failure(apply())).toBeInstanceOf(ReattachRefusedError);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("a reservation bound in the recreated workstream is allowed", async () => {
    reaped({ worktree: false });
    await recreate();
    // The old reservation is released (its close ran); the name is spawned and reaped anew.
    const old = reservation();
    if (old) releaseCarrierJob(db, old);
    reaped({ worktree: false });
    expect(await reattachBlockers(db, "auth", "worker-1")).toEqual([]);
  });
});

describe("finding reattach_preview_snapshot: facts and revision of one snapshot", () => {
  /** Close + respawn + reap of the name: a new token, incarnation and handle. */
  const replace = (job: string): void => {
    const old = reservation();
    if (old) releaseCarrierJob(db, old);
    reaped({ worktree: false, job, pane: "%91" });
    // No job file (the preflight accepts its absence), so the file cannot give the race away.
    rmSync(jobFile(), { force: true });
  };

  it("the reservation replaced during the pane probe: the preview describes what its rev applies", async () => {
    reaped({ worktree: false });
    let replaced = false;
    beforeTmux = (a) => {
      if (a[0] === "display-message" && !replaced) {
        replaced = true;
        replace("job-2");
      }
    };
    const p = await previewReattach(db, "auth", "worker-1");
    beforeTmux = undefined;
    expect(p.revision).toBe(rev());
    expect(p.job).toBe(reservation()?.job);
    expect(p.job).toBe("job-2");
    const res = await apply(p.revision);
    expect(res.job).toBe(p.job);
  });

  it("a name that will not hold still is refused, not described half and half", async () => {
    reaped({ worktree: false });
    let n = 0;
    beforeTmux = (a) => {
      if (a[0] === "display-message") replace(`job-r${++n}`);
    };
    const e = await failure(previewReattach(db, "auth", "worker-1"));
    expect(e).toBeInstanceOf(AgentReplacedError);
    expect((e as Error).message).toContain("mu agent reattach worker-1 -w auth");
  });
});

describe("after a reattach", () => {
  it("a reap writes a NEW record under the new incarnation", async () => {
    const { agentId } = reaped();
    const res = await apply();
    for (const id of [...state.panes.keys()]) state.panes.delete(id);
    await reconcile(db, { workstream: "auth" });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    const recs = listRemoteRecoveries(db);
    expect(recs.map((r) => r.agentId)).toEqual([res.agent_id]);
    expect(recs[0]?.agentId).not.toBe(agentId);
    expect(reservation()?.agentId).toBe(res.agent_id);
  });

  it("agent close stops the job and closes the tree", async () => {
    reaped();
    await apply();
    const out = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(out.deletedRow).toBe(true);
    expect(order().filter((l) => !l.startsWith("kill"))).toEqual([
      "stop job-1",
      "exec observe",
      "exec rm",
    ]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(listRemoteRecoveries(db)).toEqual([]);
  });
});
