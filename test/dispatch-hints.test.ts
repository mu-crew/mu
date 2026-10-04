// Dispatch-time Next: hints: a new task to a pi agent is sent --fresh;
// steering stays a plain send; pi agents are pointed at `mu agent abort`.
// A real unix-socket server stands in for the mu pi extension; the mux
// is the fake tmux harness.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import {
  abortHint,
  dispatchHint,
  nextDispatchHint,
  plainSendHints,
} from "../src/cli/dispatch-hints.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { StallDetectedDuringWaitError } from "../src/tasks/errors.js";
import { addTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

type Step = { intent: string; command: string };

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];

beforeEach(() => {
  // Short prefix: the socket path must fit macOS's 104-byte sun_path.
  dir = mkdtempSync(join(tmpdir(), "mdh-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  servers = [];
  setSleepForTests(async () => {});
  mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
});

afterEach(async () => {
  mux.restore();
  resetSleep();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Stand-in extension: status answers `state`/`runs`; send answers ok. */
async function serve(agent: string, state: "busy" | "idle", runs: number): Promise<void> {
  const path = ctlSocketPath("auth", agent, dir);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const _line of dec.push(chunk)) {
        sock.end(encode({ v: 1, ok: true, state, since: 1, runs, pending: false }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

const pi = { name: "worker-1", cli: "pi", workstreamName: "auth" };
const claude = { name: "worker-2", cli: "claude", workstreamName: "auth" };

describe("dispatchHint", () => {
  it("pi: --fresh; non-pi and plain: today's plain send", () => {
    expect(dispatchHint(pi)).toEqual({
      intent: "Send the first task (fresh session + prompt in one step)",
      command: "mu agent send worker-1 --fresh '...' -w auth",
    });
    expect(dispatchHint(claude)).toEqual({
      intent: "Send work",
      command: "mu agent send worker-2 '...' -w auth",
    });
    expect(dispatchHint(pi, { plain: true }).command).not.toContain("--fresh");
  });

  it("with a task: the prompt names the task and its notes", () => {
    expect(dispatchHint(pi, { task: { id: "t1", workstream: "auth" } }).command).toBe(
      "mu agent send worker-1 --fresh 'Claim done: work on t1. Read: mu task notes t1 -w auth' -w auth",
    );
  });

  it("abort and next-dispatch hints are pi-only", () => {
    expect(abortHint(pi)?.command).toBe("mu agent abort worker-1 -w auth");
    expect(abortHint(claude)).toBeNull();
    expect(nextDispatchHint(pi, "auth")?.command).toContain(
      "mu task claim <id> --for worker-1 -w auth && mu agent send worker-1 --fresh",
    );
    expect(nextDispatchHint(claude, "auth")).toBeNull();
  });

  it("plain send: busy → --steer + abort; idle after a run → --fresh nudge; first run → none", () => {
    const busy = plainSendHints(pi, { state: "busy", runs: 2 }).map((s) => s.command);
    expect(busy).toEqual([
      "mu agent send worker-1 --steer '...' -w auth",
      "mu agent abort worker-1 -w auth",
    ]);
    expect(plainSendHints(pi, { state: "idle", runs: 2 })[0]?.intent).toMatch(/--fresh next time/);
    expect(plainSendHints(pi, { state: "idle", runs: 0 })).toEqual([]);
  });

  it("stall error names abort first-resort only for a ctl owner", () => {
    const withCtl = new StallDetectedDuringWaitError("t", "worker-1", "auth", 300, true);
    const without = new StallDetectedDuringWaitError("t", "worker-2", "auth", 300);
    expect(withCtl.errorNextSteps().map((s) => s.command)).toContain(
      "mu agent abort worker-1 -w auth",
    );
    expect(without.errorNextSteps().some((s) => s.command.includes("abort"))).toBe(false);
  });

  it("stall error leads with wait --after-runs only for a ctl owner with runs", () => {
    const ctl = new StallDetectedDuringWaitError("t", "worker-1", "auth", 300, true, 3);
    expect(
      ctl
        .errorNextSteps()
        .map((s) => s.command)
        .slice(0, 2),
    ).toEqual([
      "mu agent wait worker-1 --after-runs 2 --json -w auth",
      "mu agent read worker-1 -w auth --lines 60",
    ]);
    for (const e of [
      new StallDetectedDuringWaitError("t", "worker-2", "auth", 300),
      new StallDetectedDuringWaitError("t", "worker-1", "auth", 300, true, 0),
    ]) {
      expect(e.errorNextSteps()[0]?.command).toMatch(/^mu agent read /);
      expect(e.errorNextSteps().some((s) => s.command.includes("--after-runs"))).toBe(false);
    }
  });
});

describe("mu task claim --for", () => {
  function seedTask(id: string): void {
    addTask(db, { localId: id, workstream: "auth", title: id, impact: 50, effortDays: 1 });
  }

  it("pi owner: first next step is the --fresh send of the task (also in --json)", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
    seedTask("t1");
    const r = await runCli(
      ["task", "claim", "t1", "--for", "worker-1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    const steps = (JSON.parse(r.stdout) as { nextSteps: Step[] }).nextSteps;
    expect(steps[0]).toEqual({
      intent: "Send the task to worker-1 (fresh session + prompt in one step)",
      command:
        "mu agent send worker-1 --fresh 'Claim done: work on t1. Read: mu task notes t1 -w auth' -w auth",
    });
  });

  it("non-pi owner: plain send of the task", async () => {
    insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%2", cli: "claude" });
    seedTask("t2");
    const r = await runCli(
      ["task", "claim", "t2", "--for", "worker-2", "-w", "auth", "--json"],
      dbPath,
    );
    const steps = (JSON.parse(r.stdout) as { nextSteps: Step[] }).nextSteps;
    expect(steps[0]?.command).toBe(
      "mu agent send worker-2 'Claim done: work on t2. Read: mu task notes t2 -w auth' -w auth",
    );
  });

  it("--self: no send hint", async () => {
    seedTask("t3");
    const r = await runCli(["task", "claim", "t3", "--self", "-w", "auth", "--json"], dbPath);
    const steps = (JSON.parse(r.stdout) as { nextSteps: Step[] }).nextSteps;
    expect(steps.some((s) => s.command.startsWith("mu agent send"))).toBe(false);
  });
});

describe("mu agent send hints", () => {
  function seed(): void {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
  }
  async function send(...extra: string[]): Promise<Step[]> {
    const r = await runCli(
      ["agent", "send", "worker-1", "go", ...extra, "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    return (JSON.parse(r.stdout) as { nextSteps: Step[] }).nextSteps;
  }

  it("plain send to an idle pi after a settled run: --fresh nudge", async () => {
    seed();
    await serve("worker-1", "idle", 3);
    const steps = await send();
    expect(steps.some((s) => /--fresh next time/.test(s.intent))).toBe(true);
  });

  it("--steer: no nudge", async () => {
    seed();
    await serve("worker-1", "idle", 3);
    const steps = await send("--steer");
    expect(steps.some((s) => s.command.includes("--fresh"))).toBe(false);
  });

  it("plain send to a busy pi: --steer and abort, no --fresh nudge", async () => {
    seed();
    await serve("worker-1", "busy", 3);
    const cmds = (await send()).map((s) => s.command);
    expect(cmds).toContain("mu agent send worker-1 --steer '...' -w auth");
    expect(cmds).toContain("mu agent abort worker-1 -w auth");
    expect(cmds.some((c) => c.includes("--fresh"))).toBe(false);
  });
});
