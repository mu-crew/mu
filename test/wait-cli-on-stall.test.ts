// `mu wait --on-stall steer|release` (v_wait_steer / v_wait_release wired onto the CLI): the
// stalled owner is a pi agent behind a fake control socket; the printed stall names what was
// done (sent / released / refused / unknown). Real SQLite, a fake ctl socket, no real mux.

import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { authorizeTasks } from "../src/task-auto.js";
import { claimTask } from "../src/tasks/claim.js";
import { setWaitSleepForTests } from "../src/tasks/wait.js";
import { addTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { loadResume } from "../src/wait-resume.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";
import { type FakeExt, newExt, serveFake } from "./_steer-ext.js";

const CALLER = "pi:s";
let dir: string;
let dbPath: string;
let db: Db;
let servers: Server[];
let ext: FakeExt;
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-onstall-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  servers = [];
  // runs 0: the owner has no run past the registration baseline, so no settle is owed ahead of the stall.
  ext = newExt({ runs: 0 });
  setSleepForTests(async () => {});
  setWaitSleepForTests(async (ms) => {
    await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  });
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  // The per-poll reconcile must see the worker's pane alive, or the reaper reopens the task.
  mux = installMux("tmux", async (args) => ({
    stdout:
      args[0] === "list-panes"
        ? args[1] === "-a"
          ? `%w1\tidle\t${Date.now() - 600_000}\n`
          : "@1\t%w1\tagent\tsh\n"
        : "",
    stderr: "",
    exitCode: 0,
  }));
});
afterEach(async () => {
  mux.restore();
  resetSleep();
  setWaitSleepForTests(undefined);
  resetCommandResolverForTests();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

/** A pi worker `w1` spawned by CALLER, owning IN_PROGRESS t1, idle on ctl since the epoch. */
async function stalledWorker(over: { auth?: boolean } = {}): Promise<void> {
  addTask(db, { localId: "t1", workstream: "w", title: "t1", impact: 50, effortDays: 1 });
  insertAgent(db, { name: "w1", workstream: "w", paneId: "%w1", cli: "pi", spawner: CALLER });
  await claimTask(db, "t1", { workstream: "w", agentName: "w1" });
  if (over.auth !== false) {
    authorizeTasks(db, ["t1"], { workstream: "w", cli: "pi", worktree: false, maxRuns: 1 });
  }
  await serveFake(ctlSocketPath("w", "w1", dir), ext, servers);
}

const wait = (action: string, extra: string[] = []) =>
  withEnvs(() =>
    runCli(
      ["wait", "task:w/t1", "--stuck-after", "1", "--on-stall", action, "--timeout", "1", ...extra],
      dbPath,
    ),
  );
async function withEnvs<T>(fn: () => Promise<T>): Promise<T> {
  let out: T | undefined;
  await withEnv("PI_SESSION_ID", "s", () =>
    withEnv("MU_MANAGED_AGENT", undefined, async () => {
      out = await fn();
    }),
  );
  return out as T;
}
const data = (stdout: string) => JSON.parse(stdout).data as Record<string, unknown>;
const taskRow = () => db.prepare("SELECT status, owner_id FROM tasks WHERE local_id = 't1'").get();

describe("mu wait --on-stall steer", () => {
  it("sends ONE reminder, says so on stderr, and keeps waiting to the deadline", async () => {
    await stalledWorker();
    const r = await wait("steer");
    expect(ext.sends).toHaveLength(1);
    expect(r.stderr).toMatch(/--on-stall steer: sent the reminder to w1; still waiting/);
    expect(r.exitCode).toBeNull();
    expect(data(r.stdout)).toMatchObject({ timedOut: true, exit: 0 });
  });

  it("an unknown outcome returns the stall and names it", async () => {
    ext.sendBehaviour = "swallow";
    ext.forgetful = true;
    await stalledWorker();
    const r = await wait("steer");
    expect(r.exitCode).toBe(7);
    const d = data(r.stdout);
    expect(d.action).toMatchObject({ action: "steer", state: "unknown", disposition: "return" });
    expect(d.reason).toMatch(/--on-stall steer: unknown/);
    expect(r.stderr).toMatch(/unknown whether the steer reached w1/);
  });

  it("a refused steer (the owner refuses the send) returns the stall as refused", async () => {
    ext.sendBehaviour = "refuse";
    await stalledWorker();
    const r = await wait("steer");
    expect(r.exitCode).toBe(7);
    expect(data(r.stdout).action).toMatchObject({ action: "steer", state: "refused" });
    expect(r.stderr).toMatch(/steer refused/);
  });
});

describe("mu wait --on-stall release", () => {
  it("releases the stalled task, ends the wait with the stall and says released", async () => {
    await stalledWorker();
    const r = await wait("release");
    expect(r.exitCode).toBe(7);
    const d = data(r.stdout);
    expect(d.action).toMatchObject({ action: "release", state: "released", disposition: "return" });
    expect(d.reason).toMatch(/--on-stall release: released/);
    expect(r.stderr).toMatch(/--on-stall release: released the task from w1/);
    expect(taskRow()).toMatchObject({ status: "OPEN", owner_id: null });
    expect(ext.sends).toHaveLength(0);
  });

  it("a worker the caller may not act on is refused; the task is untouched", async () => {
    await stalledWorker({ auth: false });
    const r = await wait("release");
    expect(r.exitCode).toBe(7);
    expect(data(r.stdout).action).toMatchObject({ action: "release", state: "refused" });
    expect(r.stderr).toMatch(/release refused/);
    expect(taskRow()).toMatchObject({ status: "IN_PROGRESS" });
  });

  it("without a caller identity nothing is acted on: the stall is returned as exit does", async () => {
    await stalledWorker();
    await withEnv("PI_SESSION_ID", undefined, () =>
      withEnv("MU_MANAGED_AGENT", undefined, async () => {
        out = await runCli(
          ["wait", "task:w/t1", "--stuck-after", "1", "--on-stall", "release", "--timeout", "1"],
          dbPath,
        );
      }),
    );
    expect(out.exitCode).toBe(7);
    expect(data(out.stdout).action).toBeUndefined();
    expect(taskRow()).toMatchObject({ status: "IN_PROGRESS" });
  });
});

let out: Awaited<ReturnType<typeof runCli>>;

describe("the stored wait", () => {
  it("--resume replays --on-stall steer", async () => {
    await stalledWorker();
    const r = await wait("steer");
    const id = /--resume (\w+)/.exec(String(data(r.stdout).resume))?.[1] ?? "";
    expect(loadResume(db, id).spec.onStall).toBe("steer");
  });
});
