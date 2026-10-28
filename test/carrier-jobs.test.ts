// carrier_jobs (mu_lease_profile): the handle table's helpers, the job-file path, the
// local_sock -> remote_sock invariant a carrier may rely on, and the runStop guard.
// Every template is a fake run through /bin/sh; no ssh, no mule.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import {
  abandonCarrierJob,
  deleteCarrierJobAfterStop,
  getCarrierJob,
  getCarrierJobByName,
  insertCarrierJob,
  listCarrierJobs,
  listCarrierJobsByName,
  persistCarrierJob,
} from "../src/carrier-jobs.js";
import { CarrierStopFailedError, CarrierStopRefusedError, runStop } from "../src/carrier-stop.js";
import { classifyError } from "../src/cli/handle.js";
import {
  carrierJobFilePath,
  ctlSocketPath,
  MAX_SOCK_PATH,
  remoteCtlSocketPath,
} from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, HostHandbackError, listHostChannels } from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-carrier-"));
  db = openDb({ path: join(dir, "mu.db") });
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const job = (agentId: number, over: Record<string, unknown> = {}) => ({
  agentId,
  workstream: "ws",
  name: "w1",
  host: "dev",
  job: "job-1",
  hostStop: "x rm {job}",
  ...over,
});

describe("carrier_jobs helpers", () => {
  it("insert is guarded by the agent id AND pane: a gone or replaced agent records nothing", () => {
    const a = insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1", host: "dev" });
    const args = { ...job(a.incarnation), paneId: "%1" };
    expect(insertCarrierJob(db, { ...args, paneId: "%other" })).toBe(false);
    expect(insertCarrierJob(db, { ...args, agentId: a.incarnation + 99 })).toBe(false);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(insertCarrierJob(db, args)).toBe(true);
    expect(getCarrierJob(db, a.incarnation)).toMatchObject({
      agentId: a.incarnation,
      workstream: "ws",
      name: "w1",
      host: "dev",
      job: "job-1",
      hostStop: "x rm {job}",
    });
  });

  it("never overwrites an incarnation's handle", () => {
    const a = insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1", host: "dev" });
    expect(insertCarrierJob(db, { ...job(a.incarnation), paneId: "%1" })).toBe(true);
    expect(insertCarrierJob(db, { ...job(a.incarnation, { job: "other" }), paneId: "%1" })).toBe(
      false,
    );
    expect(persistCarrierJob(db, job(a.incarnation, { job: "third" }))).toBe(false);
    expect(getCarrierJob(db, a.incarnation)?.job).toBe("job-1");
  });

  it("persist (rollback's re-read handle) needs no agent row", () => {
    expect(persistCarrierJob(db, job(42))).toBe(true);
    expect(getCarrierJob(db, 42)?.job).toBe("job-1");
  });

  it("get by (workstream, name) is the newest incarnation; list gives all, newest first", () => {
    persistCarrierJob(db, job(3, { job: "old" }));
    persistCarrierJob(db, job(9, { job: "new" }));
    persistCarrierJob(db, job(5, { name: "w2", job: "other-name" }));
    persistCarrierJob(db, job(6, { workstream: "ws2", job: "other-ws" }));
    expect(getCarrierJobByName(db, "ws", "w1")?.job).toBe("new");
    expect(listCarrierJobsByName(db, "ws", "w1").map((j) => j.job)).toEqual(["new", "old"]);
    expect(getCarrierJobByName(db, "ws", "nope")).toBeUndefined();
  });

  it("deleting the agent row (any path, even raw SQL) leaves the handle", () => {
    const a = insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1", host: "dev" });
    insertCarrierJob(db, { ...job(a.incarnation), paneId: "%1" });
    db.prepare("DELETE FROM agents WHERE id = ?").run(a.incarnation);
    expect(getCarrierJob(db, a.incarnation)?.job).toBe("job-1");
    db.prepare("DELETE FROM workstreams WHERE name = 'ws'").run();
    expect(getCarrierJob(db, a.incarnation)?.job).toBe("job-1");
  });

  it("delete-after-stop is compare-and-set on the handle; abandon is the same delete", () => {
    persistCarrierJob(db, job(1));
    const row = getCarrierJob(db, 1);
    if (row === undefined) throw new Error("no row");
    expect(deleteCarrierJobAfterStop(db, { ...row, job: "someone-else" })).toBe(false);
    expect(getCarrierJob(db, 1)).toBeDefined();
    expect(deleteCarrierJobAfterStop(db, row)).toBe(true);
    expect(deleteCarrierJobAfterStop(db, row)).toBe(false);
    persistCarrierJob(db, job(2));
    const two = getCarrierJob(db, 2);
    if (two === undefined) throw new Error("no row");
    expect(abandonCarrierJob(db, two)).toBe(true);
    expect(listCarrierJobs(db)).toEqual([]);
  });
});

describe("job file path and the socket invariant", () => {
  it("is <state dir>/carrier/<ws>/<agent>.job, and follows MU_DB_PATH's dir", () => {
    expect(carrierJobFilePath("auth", "worker-1", "/s")).toBe("/s/carrier/auth/worker-1.job");
    const key = "MU_DB_PATH";
    const prev = process.env[key];
    process.env[key] = "/tmp/x/mu.db";
    try {
      expect(carrierJobFilePath("a", "b")).toBe("/tmp/x/carrier/a/b.job");
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("is hashed past the same bound as a ctl socket, and stays a function of (ws, agent)", () => {
    const long = "/Users/someone/.local/state/mu-next/some/deep/state/dir";
    const p = carrierJobFilePath("w".repeat(30), "a".repeat(30), long);
    expect(p).toMatch(/\/carrier\/_h\/[0-9a-f]{16}\.job$/);
    expect(p).toBe(carrierJobFilePath("w".repeat(30), "a".repeat(30), long));
    expect(carrierJobFilePath("w".repeat(30), "b".repeat(30), long)).not.toBe(p);
    // The socket sibling hashes the same input: same 16 hex digits.
    const sock = ctlSocketPath("w".repeat(30), "a".repeat(30), long);
    expect(sock.match(/([0-9a-f]{16})\.sock$/)?.[1]).toBe(p.match(/([0-9a-f]{16})\.job$/)?.[1]);
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_SOCK_PATH);
  });

  it("distinguishes ws/agent splits", () => {
    expect(carrierJobFilePath("a-b", "c", "/s")).not.toBe(carrierJobFilePath("a", "b-c", "/s"));
  });

  it("local_sock determines remote_sock: one remote per local, readable and past the hash bound", () => {
    // A mule forward table wedges if one LOCAL maps to two REMOTEs (mule spec). Both paths derive
    // from (workstream, agent), so the map local -> remote must be a function over all of these.
    const names = ["a", "b", "w1", "worker-1", "x".repeat(32), "y".repeat(31), "a-b", "b-c", "c"];
    const states = ["/s", "/Users/someone/.local/state/mu-next/some/deep/state/dir"];
    const remoteOf = new Map<string, string>();
    let hashed = 0;
    let readable = 0;
    for (const stateDir of states) {
      for (const ws of names) {
        for (const agent of names) {
          const local = ctlSocketPath(ws, agent, stateDir);
          const remote = remoteCtlSocketPath(ws, agent, 501);
          // Deterministic: the same pair, asked again, gives the same two paths.
          expect(ctlSocketPath(ws, agent, stateDir)).toBe(local);
          expect(remoteCtlSocketPath(ws, agent, 501)).toBe(remote);
          // The function: no local socket ever maps to two remotes (per state dir).
          const key = `${stateDir}\0${local}`;
          expect(remoteOf.get(key) ?? remote).toBe(remote);
          remoteOf.set(key, remote);
          if (local.includes("/sock/_h/")) hashed++;
          else readable++;
        }
      }
    }
    expect(hashed).toBeGreaterThan(0);
    expect(readable).toBeGreaterThan(0);
  });

  it("a hashed path never aliases a valid (workstream, agent): `h` + a hash-looking agent", () => {
    // The reviewer's case: ws "w"x32 / agent "worker-3"+"a"x24 hashes to fc1a869c81c2949e, which
    // is itself a valid agent name under the valid workstream "h".
    const stateDir = "/Users/someone/.local/state/mu-next";
    const longWs = "w".repeat(32);
    const longAgent = `worker-3${"a".repeat(24)}`;
    const hashed = ctlSocketPath(longWs, longAgent, stateDir);
    const hash = hashed.match(/([0-9a-f]{16})\.sock$/)?.[1] ?? "";
    expect(hash).toBe("fc1a869c81c2949e");
    for (const [ws, agent] of [
      ["h", hash],
      [longWs, longAgent],
    ] as const) {
      expect(ctlSocketPath(ws, agent, stateDir)).toBe(
        ws === "h" ? `${stateDir}/sock/h/${hash}.sock` : hashed,
      );
    }
    expect(ctlSocketPath("h", hash, stateDir)).not.toBe(hashed);
    expect(carrierJobFilePath("h", hash, stateDir)).not.toBe(
      carrierJobFilePath(longWs, longAgent, stateDir),
    );
    expect(remoteCtlSocketPath("h", hash, 501)).not.toBe(
      remoteCtlSocketPath(longWs, longAgent, 501),
    );
    // A hashed remote socket is in a directory no workstream can be named.
    expect(remoteCtlSocketPath("w".repeat(32), "a".repeat(60), 501)).toMatch(/\/mu-501\/_h\//);
  });

  it("a hashed local socket can still pair with a readable remote: still one remote per (ws, agent)", () => {
    const ws = "w".repeat(20);
    const agent = "a".repeat(20);
    const deep = "/Users/someone/.local/state/mu-next/some/deep/state/dir/more";
    expect(ctlSocketPath(ws, agent, deep)).toContain("/sock/_h/");
    expect(remoteCtlSocketPath(ws, agent, 501)).toBe(`/tmp/mu-501/${ws}/${agent}.sock`);
    // Another state dir (short): a readable local, the SAME remote for the same pair.
    expect(ctlSocketPath(ws, agent, "/s")).not.toContain("/sock/_h/");
    expect(remoteCtlSocketPath(ws, agent, 501)).toBe(remoteCtlSocketPath(ws, agent, 501));
  });
});

describe("runStop", () => {
  let log: string;
  let script: string;

  /** A stop script that logs its handle then runs `tail`; the profile's stop is `script {job}`. */
  const profile = (name: string, tail = "true", max: number | null = null) => {
    log = join(dir, `${name}.log`);
    script = join(dir, `${name}.sh`);
    writeFileSync(script, `#!/bin/sh\necho "$1" >> ${log}\n${tail}\n`);
    chmodSync(script, 0o755);
    return addHost(db, {
      name,
      shell: "c {job_file} {local_sock}:{remote_sock}",
      exec: "true",
      fetch: "true",
      repo: null,
      max_sessions: max,
      transport: "lease",
      stop: `${script} {job}`,
    });
  };
  const calls = (): string[] => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };

  it("exit 0: the handle reaches the template as one word, the channel is freed, nothing is deleted", async () => {
    const p = profile("dev");
    persistCarrierJob(db, job(1, { hostStop: p.stop }));
    await runStop(db, "dev", "job-1", p.stop ?? "");
    expect(calls()).toEqual(["job-1"]);
    expect(listHostChannels(db)).toEqual([]);
    expect(getCarrierJob(db, 1)).toBeDefined();
  });

  it("a changed stop refuses, runs nothing, and names the handle", async () => {
    const p = profile("dev");
    const err = await runStop(db, "dev", "job-1", `${p.stop} # older`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierStopRefusedError);
    expect((err as Error).message).toContain("job-1");
    expect((err as Error).message).toContain("changed");
    expect(calls()).toEqual([]);
    expect(classifyError(err)).toEqual({ label: "conflict", exitCode: 4 });
  });

  it("a removed profile refuses, runs nothing", async () => {
    await expect(runStop(db, "gone", "job-1", "x {job}")).rejects.toBeInstanceOf(
      CarrierStopRefusedError,
    );
  });

  it("refuses a handle outside the grammar before anything runs", async () => {
    const p = profile("dev");
    for (const bad of ["", "a b", "a;rm", "$(x)", "x".repeat(129), "line\nbreak"]) {
      await expect(runStop(db, "dev", bad, p.stop ?? "")).rejects.toBeInstanceOf(
        CarrierStopRefusedError,
      );
    }
    expect(calls()).toEqual([]);
  });

  it("exit 3 is a hand-back: HostHandbackError, never retried, the channel freed", async () => {
    const p = profile("dev", "echo 'touch your key' >&2; exit 3");
    const err = await runStop(db, "dev", "job-1", p.stop ?? "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostHandbackError);
    expect(err).toMatchObject({ field: "stop", detail: "touch your key", handback: true });
    expect(classifyError(err)).toEqual({ label: "human needed", exitCode: 5 });
    expect(calls()).toEqual(["job-1"]);
    expect(listHostChannels(db)).toEqual([]);
  });

  it("any other failure throws CarrierStopFailedError with the first stderr line, exit 5", async () => {
    const p = profile("dev", "echo 'no such host' >&2; echo second >&2; exit 1");
    const err = await runStop(db, "dev", "job-1", p.stop ?? "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierStopFailedError);
    expect((err as Error).message).toContain("job-1");
    expect((err as Error).message).toContain("exit 1: no such host");
    expect((err as Error).message).not.toContain("second");
    expect(classifyError(err)).toEqual({ label: "remote host", exitCode: 5 });
  });

  it("a timeout is a failure, never a pass", async () => {
    const p = profile("dev", "sleep 5");
    const err = await runStop(db, "dev", "job-1", p.stop ?? "", { timeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CarrierStopFailedError);
    expect((err as Error).message).toContain("timed out");
  });

  it("counts against --max-sessions like exec: at the cap the template is never run", async () => {
    const p = profile("dev", "true", 1);
    await db
      .prepare(
        "INSERT INTO host_channels (host, holder, kind, token, pid, opened_at) VALUES ('dev', 'busy', 'transient', 't', ?, 'n')",
      )
      .run(process.pid);
    await expect(runStop(db, "dev", "job-1", p.stop ?? "")).rejects.toThrow(/max-sessions/);
    expect(calls()).toEqual([]);
  });

  it("the stop template is expanded with {job} and {cwd} = '.'", async () => {
    log = join(dir, "cwd.log");
    addHost(db, {
      name: "dev",
      shell: "c {job_file} {local_sock}:{remote_sock}",
      exec: "true",
      fetch: "true",
      repo: null,
      max_sessions: null,
      transport: "lease",
      stop: `echo {job} {cwd} > ${log}`,
    });
    await runStop(db, "dev", "j.1", `echo {job} {cwd} > ${log}`);
    expect(readFileSync(log, "utf8").trim()).toBe("j.1 .");
  });
});
