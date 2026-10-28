// `mu host check` on a lease profile (mu_lease_profile): template structure checks, the stop
// template expanded with a dummy handle and NOT run, pi and extension steps without a login
// shell, and `--agent` reporting the agent's carrier_jobs handle. Fake templates through /bin/sh.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addHost, bindHostChannel, checkHost, reserveHostChannel } from "../src/hosts.js";
import { filledReservation } from "./_carrier.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let cmds: string;
let stopRan: string;
let gitLog: string;
let oldPath: string | undefined;
// The fast tier runs no real git: the repo step's `git -C <root> rev-parse` is answered by the
// exec template itself (exit 0), every other command runs through a plain sh.
let execT: string;

type Step = { step: string; ok: boolean | null; detail: string };
const stepsOf = (r: { steps: Step[] }) => r.steps.map((s) => [s.step, s.ok]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-check-lease-"));
  dbPath = join(dir, "mu.db");
  cmds = join(dir, "cmds");
  stopRan = join(dir, "stop-ran");
  execT = `printf '%s\\n' {cmd} >> ${cmds}; case {cmd} in 'git -C'*) exit 0;; esac; sh -c {cmd}`;
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pi"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.99.1; elif [ "$1" = list ]; then echo "  npm:@mu-crew/mu"; fi\n',
  );
  chmodSync(join(bin, "pi"), 0o755);
  // A git spy ahead of the real one on PATH: any real git run leaves a line in `gitLog`.
  gitLog = join(dir, "git-log");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> ${gitLog}\nexit 0\n`);
  chmodSync(join(bin, "git"), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  db = openDb({ path: dbPath });
  addHost(db, {
    name: "lease",
    shell: "c --job-file {job_file} -L {local_sock}:{remote_sock} -- env {env} sh -c {cmd}",
    // Records every command it is handed, then runs it with a plain sh (a non-login shell).
    exec: execT,
    fetch: "true",
    repo: dir,
    max_sessions: 1,
    transport: "lease",
    stop: `touch ${stopRan}; echo {job}`,
  });
});
afterEach(() => {
  process.env.PATH = oldPath;
  // The whole fast file runs no real git (checked before the fixture dir goes).
  const ranGit = existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "";
  db.close();
  rmFixtureDir(dir);
  expect(ranGit).toBe("");
});

describe("host check on a lease profile", () => {
  it("checks the shell's placeholders and expands stop with a dummy handle, without running it", async () => {
    const r = await checkHost(db, "lease");
    expect(r.ok).toBe(true);
    expect(stepsOf(r)).toEqual([
      ["shell", true],
      ["stop", true],
      ["reachable", true],
      ["repo", true],
      ["pi", true],
      ["extension", true],
    ]);
    const stop = r.steps.find((s) => s.step === "stop");
    expect(stop?.detail).toContain("expands (not run)");
    expect(stop?.detail).toContain("echo 'check-job'");
    expect(existsSync(stopRan)).toBe(false);
  });

  it("runs pi and `pi list` WITHOUT a login shell: the job's non-login `sh -c` is what is proven", async () => {
    await checkHost(db, "lease");
    const handed = readFileSync(cmds, "utf8").trim().split("\n");
    expect(handed).toContain("pi --version");
    expect(handed).toContain("pi list");
    expect(handed.some((c) => c.startsWith("git -C") && c.endsWith("rev-parse --git-dir"))).toBe(
      true,
    );
    expect(handed.join("\n")).not.toMatch(/-ilc|SHELL/);
  });

  it("a session profile still runs pi under the login shell, with no shell or stop step", async () => {
    addHost(db, {
      name: "sess",
      shell: "ssh -o ControlMaster=no -o ControlPath=none h {local_sock}:{remote_sock}",
      exec: execT,
      fetch: "true",
      repo: dir,
      max_sessions: null,
    });
    const r = await checkHost(db, "sess");
    expect(stepsOf(r).map(([s]) => s)).toEqual(["reachable", "repo", "pi", "extension"]);
    expect(readFileSync(cmds, "utf8")).toMatch(/-ilc/);
  });

  it("a lease profile never gets the session-on-master warning", async () => {
    expect((await checkHost(db, "lease")).warnings).toEqual([]);
  });

  it("fails the shell step, naming what is missing, when the stored shell lacks {job_file}", async () => {
    db.prepare("UPDATE host_profiles SET shell = 'c -L {local_sock}:{remote_sock}'").run();
    const r = await checkHost(db, "lease");
    expect(r.ok).toBe(false);
    const shell = r.steps.find((s) => s.step === "shell");
    expect(shell).toMatchObject({ ok: false });
    expect(shell?.detail).toContain("{job_file} exactly once (found 0)");
  });

  it("fails the shell step on a stored template that does not parse", async () => {
    db.prepare("UPDATE host_profiles SET shell = 'c {nope}'").run();
    const shell = (await checkHost(db, "lease")).steps.find((s) => s.step === "shell");
    expect(shell).toMatchObject({ ok: false });
    expect(shell?.detail).toContain("unknown placeholder");
  });

  it("fails the stop step when the stored stop has no {job} or takes a placeholder it may not", async () => {
    db.prepare("UPDATE host_profiles SET stop = 'echo nothing'").run();
    expect((await checkHost(db, "lease")).steps.find((s) => s.step === "stop")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("must contain {job}"),
    });
    db.prepare("UPDATE host_profiles SET stop = 'echo {job} {env}'").run();
    expect((await checkHost(db, "lease")).steps.find((s) => s.step === "stop")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("{env}"),
    });
    expect(existsSync(stopRan)).toBe(false);
  });

  it("a missing pi is named (no login shell to find it through)", async () => {
    process.env.PATH = "/usr/bin:/bin";
    const r = await checkHost(db, "lease");
    expect(r.steps.find((s) => s.step === "pi")).toMatchObject({ ok: false });
  });
});

describe("host check follows the ADMITTED profile", () => {
  // Another connection edits the profile while the pane probes run (admission re-reads it after).
  const switchDuringProbe = (to: "lease" | "session") => {
    const paneAlive = async (): Promise<boolean> => {
      if (to === "lease") {
        db.prepare(
          "UPDATE host_profiles SET transport = 'lease', stop = 'echo {job}', shell = 'c --job-file {job_file} -L {local_sock}:{remote_sock} -- sh -c {cmd}' WHERE name = 'flip'",
        ).run();
      } else {
        db.prepare(
          "UPDATE host_profiles SET transport = 'session', stop = NULL, shell = 'ssh h {local_sock}:{remote_sock}' WHERE name = 'flip'",
        ).run();
      }
      return false;
    };
    return paneAlive;
  };
  const attachDead = async () => {
    const old = await reserveHostChannel(db, "flip", "agent:x");
    bindHostChannel(db, old, { agentId: 1, paneId: "%9" });
  };
  const flip = (transport: "session" | "lease") =>
    addHost(db, {
      name: "flip",
      shell:
        transport === "lease"
          ? "c --job-file {job_file} -L {local_sock}:{remote_sock} -- sh -c {cmd}"
          : "ssh h {local_sock}:{remote_sock}",
      exec: execT,
      fetch: "true",
      repo: dir,
      max_sessions: null,
      transport,
      ...(transport === "lease" ? { stop: "echo {job}" } : {}),
    });

  it("session -> lease during the probe: pi runs bare, like the admitted lease", async () => {
    flip("session");
    await attachDead();
    const r = await checkHost(db, "flip", { paneAlive: switchDuringProbe("lease") });
    expect(r.steps.map((s) => s.step)).toContain("stop");
    const handed = readFileSync(cmds, "utf8");
    expect(handed).toContain("pi --version");
    expect(handed).not.toMatch(/-ilc/);
    // The admitted profile is a lease: the session shell's missing ControlMaster flags don't warn.
    expect(r.warnings).toEqual([]);
  });

  it("lease -> session during the probe: pi runs under the login shell", async () => {
    flip("lease");
    await attachDead();
    const r = await checkHost(db, "flip", { paneAlive: switchDuringProbe("session") });
    expect(r.steps.map((s) => s.step)).not.toContain("stop");
    expect(readFileSync(cmds, "utf8")).toMatch(/-ilc/);
    // The admitted profile is a session whose shell lacks both flags: its warning is reported.
    expect(r.warnings).toEqual([
      expect.stringContaining("lacks ControlMaster=no and ControlPath=none"),
    ]);
  });
});

describe("host check --agent on a lease agent", () => {
  const ws = "auth";
  const row = (over: Record<string, unknown> = {}) => ({
    agentId: 7,
    workstream: ws,
    name: "worker-1",
    host: "lease",
    job: "mule-42",
    hostStop: `touch ${stopRan}; echo {job}`,
    ...over,
  });

  it("reports the agent's carrier_jobs handle", async () => {
    filledReservation(db, row());
    const r = await checkHost(db, "lease", { agent: { name: "worker-1", workstream: ws } });
    const job = r.steps.find((s) => s.step === "job");
    expect(job).toMatchObject({ ok: true });
    expect(job?.detail).toContain("auth/worker-1: job mule-42");
    expect(job?.detail).not.toContain("changed");
  });

  it("says so when the stop template changed since the handle was recorded", async () => {
    filledReservation(db, row({ hostStop: "older {job}" }));
    const job = (
      await checkHost(db, "lease", { agent: { name: "worker-1", workstream: ws } })
    ).steps.find((s) => s.step === "job");
    expect(job).toMatchObject({ ok: true });
    expect(job?.detail).toContain("stop template changed");
  });

  it("fails the job step when no handle is recorded for the agent", async () => {
    const r = await checkHost(db, "lease", { agent: { name: "worker-1", workstream: ws } });
    expect(r.steps.find((s) => s.step === "job")).toMatchObject({
      ok: false,
      detail: "auth/worker-1: no job handle recorded on lease",
    });
  });

  it("a handle recorded on another host is not this host's", async () => {
    filledReservation(db, row({ host: "elsewhere" }));
    const r = await checkHost(db, "lease", { agent: { name: "worker-1", workstream: ws } });
    expect(r.steps.find((s) => s.step === "job")).toMatchObject({ ok: false });
  });

  it("the CLI prints the job line, and a session profile has none", async () => {
    filledReservation(db, row());
    const human = await runCli(["host", "check", "lease", "--agent", "worker-1", "-w", ws], dbPath);
    expect(human.stdout).toContain("job");
    expect(human.stdout).toContain("mule-42");
    addHost(db, {
      name: "sess",
      shell: "ssh -o ControlMaster=no -o ControlPath=none {local_sock}:{remote_sock}",
      exec: execT,
      fetch: "true",
      repo: dir,
      max_sessions: null,
    });
    const s = await runCliJson(
      ["host", "check", "sess", "--agent", "worker-1", "-w", ws, "--json"],
      dbPath,
    );
    expect(s.data.steps.map((x: Step) => x.step)).not.toContain("job");
  });
});
