// Leftovers in `mu agent list` (spec docs/specs/2026-11-04-lease-adopt.md § G4 mu_list), fast
// tier. A reaped lease agent (row gone, reservation + recovery kept) is a `lease-job`; any
// other remote recovery record is a `recovery`. Each `next` is a preview: reattach when the
// shared preflight is clear, else the close. The mu-side stop-failure record lifecycle too.
// Fake tmux; `stop` and `exec` are sh shims logging to one order log.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dropStopFailed,
  rollbackLeaseJob,
  stopLeaseReservation,
} from "../src/agents/lease-carrier.js";
import { markerPath } from "../src/agents/reattach-marker.js";
import { deleteAgent, insertAgent } from "../src/agents.js";
import {
  bindCarrierJobAgent,
  type CarrierJob,
  fillCarrierJob,
  getCarrierJobByName,
  markCarrierLaunch,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import { carrierJobFilePath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import * as execFile from "../src/exec-file.js";
import { addHost } from "../src/hosts.js";
import { type Leftover, leftoverLines, listLeftovers, withStopFailed } from "../src/leftovers.js";
import { safeJsonLine } from "../src/output-contract.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

vi.mock("../src/exec-file.js", async (orig) => {
  const real = await orig<typeof import("../src/exec-file.js")>();
  return {
    ...real,
    execGroupCapture: vi.fn(real.execGroupCapture),
    execFileCapture: vi.fn(real.execFileCapture),
  };
});

const real = await vi.importActual<typeof import("../src/exec-file.js")>("../src/exec-file.js");
const BASE = "b".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/worker-1";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let orderLog: string;
let stop: string;
let saved: Record<string, string | undefined>;
const ENV_KEYS = ["MU_DB_PATH", "MU_STATE_DIR", "MU_SYNC_DIR"];

const order = (): string[] =>
  existsSync(orderLog) ? readFileSync(orderLog, "utf8").trim().split("\n").filter(Boolean) : [];
const jobFile = (name = "worker-1") => carrierJobFilePath("auth", name, dir);
const record = (job: string, name = "worker-1") => `${jobFile(name)}.${job}.stop-failed`;
const reservation = (): CarrierJob => {
  const r = getCarrierJobByName(db, "auth", "worker-1");
  if (r === undefined) throw new Error("no reservation");
  return r;
};
const deadPid = (): number => spawnSync("true").pid ?? 999_999;
const leftovers = () => listLeftovers(db, "auth");
const REATTACH = "mu agent reattach worker-1 -w auth";
const CLOSE = "mu agent close worker-1 -w auth";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mlo-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  orderLog = join(dir, "order");
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_DB_PATH = dbPath;
  process.env.MU_STATE_DIR = join(dir, "state");
  process.env.MU_SYNC_DIR = join(dir, "sync");
  const sh = (file: string, body: string): string => {
    writeFileSync(join(dir, file), `#!/bin/sh\n${body}\n`);
    return `/bin/sh ${join(dir, file)}`;
  };
  stop = `${sh("stop.sh", `echo "stop $1" >> '${orderLog}'`)} {job}`;
  addHost(db, {
    name: "dev",
    transport: "lease",
    shell: "carrier J={job_file} L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
    exec: `${sh("exec.sh", `echo "exec $*" >> '${orderLog}'`)} {cmd}`,
    stop,
    attach:
      "carrier --attach {job} --job-file {job_file} --forward-unix {local_sock}:{remote_sock}",
    fetch: "true",
    repo: "/srv/repo",
    max_sessions: 1,
  });
  state = freshMockState();
  mux = installMux("tmux", mockTmux(state).executor);
  vi.mocked(execFile.execGroupCapture).mockClear();
  vi.mocked(execFile.execFileCapture).mockClear();
});

afterEach(() => {
  mux.restore();
  vi.mocked(execFile.execGroupCapture).mockImplementation(real.execGroupCapture);
  vi.mocked(execFile.execFileCapture).mockImplementation(real.execFileCapture);
  db.close();
  rmFixtureDir(dir);
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A remote `--worktree` row of `name`, deleted: the trigger leaves its recovery record. */
function reapedTree(name: string, cwd: string): number {
  const row = insertAgent(db, {
    name,
    workstream: "auth",
    paneId: "%80",
    host: "dev",
    cwd,
    base: BASE,
    repo: "/srv/repo",
  });
  deleteAgent(db, name, "auth");
  return row.incarnation;
}

/**
 * A lease agent the reaper removed: its pane gone, its row deleted (a `--worktree` row leaves
 * a recovery record), its reservation (launched, bound, handle known) and job file kept.
 */
function reaped(over: { worktree?: boolean; job?: string; name?: string } = {}): number {
  const name = over.name ?? "worker-1";
  const r = reserveCarrierJob(db, {
    workstream: "auth",
    name,
    host: "dev",
    hostStop: stop,
    creatorPid: deadPid(),
  });
  if (r === undefined) throw new Error("reserved already");
  markCarrierLaunch(db, r.token);
  const row = insertAgent(db, {
    name,
    workstream: "auth",
    paneId: "%90",
    host: "dev",
    hostTransport: "lease",
    reservation: r.token,
    ...(over.worktree === false
      ? { cwd: "/srv/repo" }
      : { cwd: WT, base: BASE, repo: "/srv/repo" }),
  });
  const job = over.job ?? "job-1";
  bindCarrierJobAgent(db, r.token, row.incarnation, "%90");
  fillCarrierJob(db, r.token, job);
  mkdirSync(dirname(jobFile(name)), { recursive: true });
  writeFileSync(jobFile(name), `${job}\n`);
  deleteAgent(db, name, "auth");
  return row.incarnation;
}

/** A pre-reservation-shape second reservation of worker-1 (legacy ordinal 1). */
const legacySecond = (agentId: number | null) =>
  db
    .prepare(
      "INSERT INTO carrier_jobs (token, workstream, name, host, host_stop, launch, agent_id, created_at, ordinal) VALUES ('t2','auth','worker-1','dev','x','none',?,?,1)",
    )
    .run(agentId, new Date().toISOString());

describe("lease-job leftovers", () => {
  it("a reaped lease --worktree agent: one lease-job, its record folded in, next = the reattach preview", async () => {
    const agentId = reaped();
    expect(await leftovers()).toEqual([
      {
        kind: "lease-job",
        name: "worker-1",
        host: "dev",
        job: "job-1",
        agent_id: agentId,
        recovery_id: agentId,
        stop_failed: null,
        next: REATTACH,
      },
    ]);
  });

  it("a --cwd lease agent: no record to fold", async () => {
    const agentId = reaped({ worktree: false });
    expect(await leftovers()).toEqual([
      expect.objectContaining({ kind: "lease-job", agent_id: agentId, recovery_id: null }),
    ]);
  });

  const blocked: [string, () => void][] = [
    ["no attach template", () => db.prepare("UPDATE host_profiles SET attach = NULL").run()],
    [
      "a live previous pane",
      () => state.panes.set("%90", { windowId: "@1", paneId: "%90", command: "carrier" }),
    ],
    ["a conflicting job file", () => writeFileSync(jobFile(), "job-2\n")],
    [
      "a pending reattach marker",
      () => {
        const path = markerPath(db, "auth", "worker-1");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ job: "job-1", pid: 1 }));
      },
    ],
  ];
  for (const [what, block] of blocked) {
    it(`a blocker (${what}) gives the close preview`, async () => {
      reaped();
      block();
      expect((await leftovers()).map((l) => l.next)).toEqual([CLOSE]);
    });
  }

  it("two reservations (legacy ordinals): one leftover each, both the close preview; the record folds into the matching agent_id only", async () => {
    const agentId = reaped();
    legacySecond(agentId + 100);
    const out = await leftovers();
    expect(out.map((l) => [l.kind, l.agent_id, l.recovery_id, l.next])).toEqual([
      ["lease-job", agentId, agentId, CLOSE],
      ["lease-job", agentId + 100, null, CLOSE],
    ]);
  });

  it("another incarnation's record stays a separate recovery, with --recovery", async () => {
    const old = reapedTree("worker-1", `${WT}-old`);
    const agentId = reaped();
    expect((await leftovers()).map((l) => [l.kind, l.recovery_id, l.next])).toEqual([
      ["lease-job", agentId, REATTACH],
      ["recovery", old, `${CLOSE} --recovery ${old}`],
    ]);
    // Blocked with several records: the close names the folded one.
    db.prepare("UPDATE host_profiles SET attach = NULL").run();
    expect((await leftovers())[0]?.next).toBe(`${CLOSE} --recovery ${agentId}`);
  });
});

describe("recovery leftovers", () => {
  it("a bare record, also with a live agent of the name: close … --recovery <id>", async () => {
    const id = reapedTree("worker-2", "/home/u/wt/worker-2");
    insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%5", cli: "pi" });
    state.panes.set("%5", { windowId: "@1", paneId: "%5", command: "pi" });
    expect(await leftovers()).toEqual([
      {
        kind: "recovery",
        name: "worker-2",
        host: "dev",
        job: null,
        agent_id: id,
        recovery_id: id,
        stop_failed: null,
        next: `mu agent close worker-2 -w auth --recovery ${id}`,
      },
    ]);
  });

  it("a live agent's reservation and other workstreams are not listed", async () => {
    reaped();
    ensureWorkstream(db, "other");
    expect(await listLeftovers(db, "other")).toEqual([]);
    const r = reserveCarrierJob(db, {
      workstream: "other",
      name: "w",
      host: "dev",
      hostStop: stop,
    });
    if (r === undefined) throw new Error("reserved");
    markCarrierLaunch(db, r.token);
    const row = insertAgent(db, {
      name: "w",
      workstream: "other",
      paneId: "%6",
      host: "dev",
      hostTransport: "lease",
      reservation: r.token,
    });
    bindCarrierJobAgent(db, r.token, row.incarnation, "%6");
    fillCarrierJob(db, r.token, "job-6");
    expect(await listLeftovers(db, "other")).toEqual([]);
    expect((await leftovers()).map((l) => l.name)).toEqual(["worker-1"]);
  });
});

/** Code points of one leftover as `--json` prints it (the envelope's encoder re-escapes). */
const jsonChars = (l: Leftover): number => [...safeJsonLine(JSON.stringify(l))].length;
/** Code points of one leftover's `--table` line. */
const tableLine = (l: Leftover): string => leftoverLines([l]).at(-1) ?? "";
const tableChars = (l: Leftover): number => [...tableLine(l)].length;
const FULL = "full: mu doctor";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

describe("stop_failed", () => {
  it("the record's text after `<job> `, escaped and cut with cut= and the way back", async () => {
    reaped();
    writeFileSync(record("job-1"), `job-1 x\t${"é".repeat(200)}\n`);
    const [l] = await leftovers();
    // "x\\t" is 3 chars once escaped, then 200: 160 kept, 43 cut.
    expect(l?.stop_failed).toBe(`x\\t${"é".repeat(157)} cut=43 ${FULL}`);
    writeFileSync(record("job-1"), "job-1 on dev not stopped: no control master\n");
    expect((await leftovers())[0]?.stop_failed).toBe("on dev not stopped: no control master");
  });

  it("C1, bidi and U+2028 are escaped, ordinary Unicode stays readable; a cut never splits an escape", async () => {
    reaped();
    writeFileSync(
      record("job-1"),
      "job-1 bad\u009b31m\u202eabcd\u2028nl\u001b[2J\ttab é\u2029\u2066\u061c\u007f\\\n",
    );
    const [l] = await leftovers();
    expect(l?.stop_failed).toBe(
      "bad\\u{9b}31m\\u{202e}abcd\\u{2028}nl\\u{1b}[2J\\ttab é\\u{2029}\\u{2066}\\u{61c}\\u{7f}\\\\",
    );
    const line = leftoverLines(l === undefined ? [] : [l]).at(-1) ?? "";
    expect(line).not.toMatch(UNSAFE);
    // 155 kept, then an 8-char escape would pass 160: it is dropped whole with the rest.
    writeFileSync(record("job-1"), `job-1 ${"x".repeat(155)}\u202e${"y".repeat(10)}\n`);
    expect((await leftovers())[0]?.stop_failed).toBe(`${"x".repeat(155)} cut=11 ${FULL}`);
  });

  it("a 32-char name, a 128-char handle and a 511-byte record stay a record <= 400 chars", async () => {
    const name = "w".repeat(32);
    const job = "j".repeat(128);
    reaped({ name, job });
    const next = `mu agent reattach ${name} -w auth`;
    for (const fill of ["x", '"', "\\", "é", "\u202e"]) {
      let body = "";
      while (Buffer.byteLength(`${job} ${body}${fill}\n`) <= 511) body += fill;
      const text = `${job} ${body}\n`;
      expect(Buffer.byteLength(text)).toBeGreaterThan(507);
      writeFileSync(record(job, name), text);
      const [l] = await leftovers();
      if (l === undefined) throw new Error("no leftover");
      expect(jsonChars(l), fill).toBeLessThanOrEqual(400);
      expect(tableChars(l), fill).toBeLessThanOrEqual(400);
      expect(l).toMatchObject({ name, job, next });
      expect(l.stop_failed).toMatch(new RegExp(`^\\S* ?cut=\\d+ ${FULL}$`));
    }
  });

  /** A lease-job leftover at mu's name limits (32-char name, host, workstream; 128-char handle). */
  const atLimits = (id: number, next: "reattach" | "close" | "recovery" = "recovery"): Leftover => {
    const name = "n".repeat(32);
    const ws = "w".repeat(32);
    return {
      kind: "lease-job",
      name,
      host: "h".repeat(32),
      job: "j".repeat(128),
      agent_id: id,
      recovery_id: id,
      stop_failed: null,
      next:
        next === "reattach"
          ? `mu agent reattach ${name} -w ${ws}`
          : `mu agent close ${name} -w ${ws}${next === "recovery" ? ` --recovery ${id}` : ""}`,
    };
  };

  it("with no room for the way back the field is `cut=N` alone, if that fits", () => {
    const base = atLimits(1);
    const l = withStopFailed(base, "x".repeat(400));
    expect(l.stop_failed).toBe("cut=400");
    expect([jsonChars(l), tableChars(l)]).toEqual([400, 346]);
    expect({ ...l, stop_failed: null }).toEqual(base);
    // With room, a short body is shown whole.
    expect(withStopFailed({ ...base, job: "job-1" }, "ok").stop_failed).toBe("ok");
  });

  it("when `cut=N` does not fit either the field is null; identity and next are never cut", () => {
    // Review fixture: was 415 JSON chars with `cut=400`. Identity and next alone are 410: the
    // cap bounds stop_failed, so this valid record stays over 400.
    const base = atLimits(123456);
    const l = withStopFailed(base, "x".repeat(400));
    expect(l).toEqual(base);
    expect([jsonChars(l), tableChars(l)]).toEqual([410, 335]);
  });

  it("a valid 511-byte record whose `cut=N` would pass 400 lists with stop_failed null (CLI)", async () => {
    // Review reproducer: incarnation 11, an ambiguous folded recovery, no attach: was a
    // 403-char JSON item with `cut=381`.
    const ws = "s".repeat(32);
    const name = "n".repeat(32);
    const host = "h".repeat(32);
    const job = "j".repeat(128);
    ensureWorkstream(db, ws);
    addHost(db, {
      name: host,
      transport: "lease",
      shell: "carrier {job_file} {local_sock} {remote_sock} {cwd} {env} -- {cmd}",
      exec: "true {cmd}",
      stop: "true {job}",
      fetch: "true",
      repo: "/srv/repo",
      max_sessions: 1,
    });
    for (let i = 0; i < 9; i++) {
      insertAgent(db, { name: `dummy-${i}`, workstream: ws, paneId: `%${200 + i}` });
      deleteAgent(db, `dummy-${i}`, ws);
    }
    insertAgent(db, {
      name,
      workstream: ws,
      paneId: "%80",
      host,
      cwd: "/old",
      base: BASE,
      repo: "/srv/repo",
    });
    deleteAgent(db, name, ws);
    const r = reserveCarrierJob(db, {
      workstream: ws,
      name,
      host,
      hostStop: "true {job}",
      creatorPid: deadPid(),
    });
    if (r === undefined) throw new Error("reserved already");
    markCarrierLaunch(db, r.token);
    const row = insertAgent(db, {
      name,
      workstream: ws,
      paneId: "%90",
      host,
      hostTransport: "lease",
      reservation: r.token,
      cwd: "/new",
      base: BASE,
      repo: "/srv/repo",
    });
    expect(row.incarnation).toBe(11);
    bindCarrierJobAgent(db, r.token, row.incarnation, "%90");
    fillCarrierJob(db, r.token, job);
    deleteAgent(db, name, ws);
    const jf = carrierJobFilePath(ws, name, dir);
    mkdirSync(dirname(jf), { recursive: true });
    writeFileSync(jf, `${job}\n`);
    const text = `${job} ${"x".repeat(381)}\n`;
    expect(Buffer.byteLength(text)).toBe(511);
    writeFileSync(`${jf}.${job}.stop-failed`, text);
    const next = `mu agent close ${name} -w ${ws} --recovery 11`;
    const j = await runCliJson(["agent", "list", "-w", ws, "--json"], dbPath);
    expect(j.exitCode, j.stderr).toBeNull();
    const l = j.data.leftovers[0] as Leftover;
    expect(l).toMatchObject({
      name,
      host,
      job,
      agent_id: 11,
      recovery_id: 11,
      stop_failed: null,
      next,
    });
    expect(jsonChars(l)).toBe(398);
    const t = await runCli(["agent", "list", "-w", ws, "--table"], dbPath);
    const line = t.stdout.split("\n").find((x) => x.startsWith(`  ${name}  lease-job`));
    expect([...(line ?? "")].length).toBe(327);
    expect(line).toBe(tableLine(l));
  });

  it("at mu's limits: <= 400 whenever identity and next fit, else stop_failed null; never cut", () => {
    // Worst case: the 128-char handle, 32-char name/host/workstream and close --recovery <id>
    // put identity and next alone at 392 + 3 x digits(id) JSON chars: over 400 from id 100.
    expect(jsonChars(atLimits(99))).toBe(398);
    expect(jsonChars(atLimits(100))).toBe(401);
    expect(jsonChars(atLimits(Number.MAX_SAFE_INTEGER))).toBe(440);
    const bodies = [
      "ok",
      "x".repeat(510),
      '"'.repeat(300),
      "\\".repeat(300),
      "é".repeat(250),
      "\u202e".repeat(160),
      "😀".repeat(120),
    ];
    for (const id of [1, 9, 10, 99, 100, 123456, Number.MAX_SAFE_INTEGER]) {
      for (const kind of ["reattach", "close", "recovery"] as const) {
        const base = atLimits(id, kind);
        const fits = Math.max(jsonChars(base), tableChars(base)) <= 400;
        for (const body of bodies) {
          const l = withStopFailed(base, body);
          const at = `${id} ${kind} ${body.slice(0, 3)}`;
          expect({ ...l, stop_failed: null }, at).toEqual(base);
          if (fits) {
            expect(jsonChars(l), at).toBeLessThanOrEqual(400);
            expect(tableChars(l), at).toBeLessThanOrEqual(400);
          } else expect(l.stop_failed, at).toBeNull();
        }
      }
    }
  });

  it("a record of another id, by path or by content, is not shown and the file is kept", async () => {
    reaped();
    writeFileSync(record("job-9"), "job-9 on dev not stopped\n");
    expect((await leftovers())[0]?.stop_failed).toBeNull();
    writeFileSync(record("job-1"), "job-9 on dev not stopped\n");
    expect((await leftovers())[0]?.stop_failed).toBeNull();
    expect(existsSync(record("job-9"))).toBe(true);
    expect(existsSync(record("job-1"))).toBe(true);
  });

  it("after name reuse an old child's late write is not shown; a late delete removes only its own path", async () => {
    reaped({ job: "job-2" });
    writeFileSync(record("job-1"), "job-1 on dev not stopped: late\n");
    expect((await leftovers())[0]?.stop_failed).toBeNull();
    writeFileSync(record("job-2"), "job-2 on dev not stopped: mine\n");
    dropStopFailed(jobFile(), "job-1");
    expect(existsSync(record("job-1"))).toBe(false);
    expect((await leftovers())[0]?.stop_failed).toBe("on dev not stopped: mine");
  });
});

describe("record lifecycle (mu side)", () => {
  const seed = () => {
    writeFileSync(record("job-1"), "job-1 on dev not stopped: no control master\n");
    writeFileSync(record("job-9"), "job-9 other\n");
  };

  it("a stop removes the job's record, with no job file; another id's stays", async () => {
    reaped();
    rmSync(jobFile());
    seed();
    const close = await stopLeaseReservation(db, reservation());
    expect(close?.action).toBe("stopped");
    expect(order()).toContain("stop job-1");
    expect(existsSync(record("job-1"))).toBe(false);
    expect(existsSync(record("job-9"))).toBe(true);
  });

  it("a rollback's stop removes it", async () => {
    reaped();
    seed();
    const r = reservation();
    const out = await rollbackLeaseJob(
      db,
      { workstream: "auth", name: "worker-1", token: r.token },
      true,
    );
    expect(out).toBe("stopped");
    expect(existsSync(record("job-1"))).toBe(false);
    expect(existsSync(record("job-9"))).toBe(true);
  });

  it("an abandon keeps it", async () => {
    reaped();
    seed();
    const close = await stopLeaseReservation(db, reservation(), { abandon: true });
    expect(close?.action).toBe("abandon");
    expect(order()).toEqual([]);
    expect(existsSync(record("job-1"))).toBe(true);
  });
});

describe("agent list", () => {
  it("--json and bare carry data.leftovers; --table prints the section", async () => {
    const agentId = reaped();
    writeFileSync(record("job-1"), "job-1 on dev not stopped: no control master\n");
    const j = await runCliJson(["agent", "list", "-w", "auth", "--json"], dbPath);
    expect(j.exitCode, j.stderr).toBeNull();
    expect(j.data.leftovers).toEqual([
      expect.objectContaining({ kind: "lease-job", job: "job-1", next: REATTACH }),
    ]);
    expect(j.doc.next).toBeNull();
    const bare = await runCliJson(["agent", "list", "-w", "auth"], dbPath);
    expect(bare.data.leftovers).toEqual(j.data.leftovers);
    const t = await runCli(["agent", "list", "-w", "auth", "--table"], dbPath);
    expect(t.stdout).toContain("Leftovers (1)");
    expect(t.stdout).toContain(
      `  worker-1  lease-job on dev job=job-1 recovery=${agentId} stop failed: on dev not stopped: no control master  → ${REATTACH}`,
    );
  });

  it("runs no host command (an exec stub that throws)", async () => {
    reaped();
    writeFileSync(record("job-1"), "job-1 on dev not stopped\n");
    const boom = () => {
      throw new Error("a host command ran");
    };
    vi.mocked(execFile.execGroupCapture).mockImplementation(boom);
    vi.mocked(execFile.execFileCapture).mockImplementation(boom);
    expect((await leftovers()).map((l) => l.next)).toEqual([REATTACH]);
    const j = await runCliJson(["agent", "list", "-w", "auth", "--json"], dbPath);
    expect(j.exitCode, j.stderr).toBeNull();
    expect(j.data.leftovers).toHaveLength(1);
    expect(execFile.execGroupCapture).not.toHaveBeenCalled();
    expect(execFile.execFileCapture).not.toHaveBeenCalled();
    expect(order()).toEqual([]);
  });
});
