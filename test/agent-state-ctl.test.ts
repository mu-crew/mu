// The control socket as the state source for pi agents, and the
// event-driven `mu agent wait`. A real unix-socket server at the derived
// path stands in for the mu pi extension; tmux is the mock executor.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentKey,
  readAgentStates,
  resetAgentStateCacheForTests,
  setMurmurRunnerForTests,
  UNKNOWN_REASON,
} from "../src/agent-state.js";
import { getAgent, insertAgent, listLiveAgents } from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { StallDetectedDuringWaitError } from "../src/tasks/errors.js";
import { addTask, claimTask, setWaitStuckWarnForTests, waitForTasks } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { runCli } from "./_runCli.js";

const WS = "cs";
let dir: string;
let dbPath: string;
let db: Db;
let servers: Server[];
/** tmux pane option for %1: what a (wrong) murmur fallback would read. */
let murmurToken: string;

beforeEach(() => {
  // Short prefix: the socket path must fit macOS's 104-byte sun_path.
  dir = mkdtempSync(join(tmpdir(), "msx-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  servers = [];
  murmurToken = "";
  setMuxForTests(tmuxBackend);
  setTmuxExecutor(async (args) => {
    if (args[0] === "list-panes") {
      return { stdout: `%1\t${murmurToken}\t1000\n%2\t\t\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  setMurmurRunnerForTests(async () => null);
  resetAgentStateCacheForTests();
  insertAgent(db, { name: "pia", workstream: WS, paneId: "%1", cli: "pi" });
});

afterEach(async () => {
  resetTmuxExecutor();
  setMuxForTests(undefined);
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
  for (const s of servers) s.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface FakeExt {
  ops: string[];
  /** Fire agent_settled: runs++, idle, answer held waits. */
  settle: (lastText?: string, lastError?: string) => void;
  start: () => void;
  close: () => Promise<void>;
}

/** Stand-in for the mu pi extension with the real wait semantics. */
async function fakeExtension(
  initial: { state: "busy" | "idle"; since: number; runs: number; pending?: boolean },
  path = ctlSocketPath(WS, "pia", dir),
): Promise<FakeExt> {
  let { state, since, runs } = initial;
  const pending = initial.pending ?? false;
  const ops: string[] = [];
  const waiters: Array<{ after: number | undefined; sock: Socket }> = [];
  let lastText: string | undefined;
  let lastError: string | undefined;
  const settled = () => ({
    ...(lastText === undefined ? {} : { lastText }),
    ...(lastError === undefined ? {} : { lastError }),
  });
  const status = () => ({ v: 1, ok: true, state, since, runs, pending });
  mkdirSync(dirname(path), { recursive: true });
  const conns = new Set<Socket>();
  const server = createServer((sock) => {
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; afterRuns?: number };
        ops.push(req.op);
        if (req.op === "wait") {
          if (req.afterRuns !== undefined && runs > req.afterRuns && state === "idle") {
            sock.end(encode({ ...status(), ...settled() }));
          } else waiters.push({ after: req.afterRuns, sock });
        } else sock.end(encode(status()));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return {
    ops,
    start: () => {
      state = "busy";
      since = Date.now();
    },
    settle: (text?: string, error?: string) => {
      state = "idle";
      since = Date.now();
      runs++;
      lastText = text;
      lastError = error;
      const reply = { ...status(), ...settled() };
      for (const w of waiters.splice(0)) w.sock.end(encode(reply));
    },
    close: async () => {
      for (const c of conns) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const pia = () => ({ name: "pia", workstreamName: WS, paneId: "%1", cli: "pi" });
const read = async () => (await readAgentStates([pia()], { stateDir: dir })).get(agentKey(pia()));

describe("readAgentStates via the control socket", () => {
  it("reads busy, then needs_input after a settle, with ctl's since", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1_790_000_000_000, runs: 0 });
    expect(await read()).toEqual({
      state: "busy",
      source: "ctl",
      since: 1_790_000_000_000,
      alive: true,
      ctl: "ok",
      pending: false,
      runs: 0,
    });
    ext.settle();
    expect(await read()).toMatchObject({ state: "needs_input", source: "ctl", ctl: "ok" });
  });

  it("a missing socket reads unknown 'ctl missing', not murmur's working", async () => {
    murmurToken = "working";
    expect(await read()).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: true,
      reason: UNKNOWN_REASON.ctlMissing,
      ctl: "missing",
    });
  });

  it("a hung socket costs one connection and one probe budget, and no murmur read", async () => {
    const path = ctlSocketPath(WS, "pia", dir);
    mkdirSync(dirname(path), { recursive: true });
    let conns = 0;
    const held: Socket[] = [];
    const server = createServer((sock) => {
      conns++;
      held.push(sock); // accepts, never replies
      sock.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
    let murmurCalls = 0;
    setMurmurRunnerForTests(async () => {
      murmurCalls++;
      return null;
    });
    const started = Date.now();
    expect(await read()).toMatchObject({ state: "unknown", ctl: "refused" });
    const elapsed = Date.now() - started;
    for (const s of held) s.destroy();
    expect(elapsed).toBeLessThan(1500);
    expect(conns).toBe(1);
    expect(murmurCalls).toBe(0);
  });

  it("a non-pi agent keeps murmur and has no ctl field", async () => {
    murmurToken = "working";
    const sh = { name: "sh1", workstreamName: WS, paneId: "%1", cli: "sh" };
    const got = (await readAgentStates([sh], { stateDir: dir })).get(agentKey(sh));
    expect(got).toEqual({ state: "busy", source: "murmur", since: 1000, alive: true });
  });

  it("listLiveAgents carries source ctl and ctl ok / n/a", async () => {
    await fakeExtension({ state: "idle", since: 5, runs: 1 });
    insertAgent(db, { name: "shx", workstream: WS, paneId: "%2", cli: "sh" });
    const view = await listLiveAgents(db, { workstream: WS, mode: "report-only" });
    const byName = new Map(view.agents.map((a) => [a.name, a]));
    expect(byName.get("pia")).toMatchObject({ source: "ctl", ctl: "ok", state: "needs_input" });
    expect(byName.get("shx")?.ctl).toBe("n/a");
  });
});

describe("mu agent wait on a pi agent", () => {
  it("resolves on the extension's settle without polling status", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 3 });
    const pending = runCli(["agent", "wait", "pia", "-w", WS, "--timeout", "10", "--json"], dbPath);
    // Let the wait request arrive, then settle.
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ext.ops).toContain("wait");
    ext.settle("ok");
    const res = await pending;
    expect(res.error).toBeUndefined();
    expect(res.exitCode).toBeNull();
    const payload = JSON.parse(res.stdout) as {
      agents: Array<{ fired: boolean; lastText?: string; outcome?: string }>;
    };
    expect(payload.agents[0]?.fired).toBe(true);
    expect(payload.agents[0]?.lastText).toBe("ok");
    expect(payload.agents[0]?.outcome).toBe("done");
    expect(ext.ops.filter((op) => op === "status").length).toBeLessThan(3);
  });

  it("fires when the run settled between the status read and the wait (afterRuns)", async () => {
    // idle with runs already past nothing: a fresh send made pi busy and it
    // settled; the status read before the wait is the baseline.
    const ext = await fakeExtension({ state: "idle", since: 1, runs: 0 });
    const pending = runCli(["agent", "wait", "pia", "-w", WS, "--timeout", "10", "--json"], dbPath);
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // The waiter must hold: idle at start is not "this work finished".
    await new Promise((r) => setTimeout(r, 30));
    ext.start();
    ext.settle();
    const res = await pending;
    expect(res.exitCode).toBeNull();
    expect((JSON.parse(res.stdout) as { agents: Array<{ fired: boolean }> }).agents[0]?.fired).toBe(
      true,
    );
  });

  it("--after-runs catches a run that settled before the wait started", async () => {
    // send replied runs:2, then the run went 2 → 3 before the wait ran.
    const ext = await fakeExtension({ state: "idle", since: 1, runs: 3 });
    const res = await runCli(
      ["agent", "wait", "pia", "-w", WS, "--after-runs", "2", "--timeout", "2", "--json"],
      dbPath,
    );
    expect(res.exitCode).toBeNull();
    expect((JSON.parse(res.stdout) as { agents: Array<{ fired: boolean }> }).agents[0]?.fired).toBe(
      true,
    );
    expect(ext.ops).toEqual(["wait"]);
  });

  it("--after-runs <runs-1> on an idle pi returns the last run's lastText at once", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    ext.settle("the answer"); // runs 1, idle; no waiter held
    const started = Date.now();
    const res = await runCli(
      ["agent", "wait", "pia", "-w", WS, "--after-runs", "0", "--timeout", "5", "--json"],
      dbPath,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.exitCode).toBeNull();
    const a = (JSON.parse(res.stdout) as { agents: Array<{ fired: boolean; lastText?: string }> })
      .agents[0];
    expect(a).toMatchObject({ fired: true, lastText: "the answer" });
    expect(ext.ops).toEqual(["wait"]);
  });

  it("--first with lastText drops the read hint; an empty lastText keeps it", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    ext.settle("the answer");
    const args = ["agent", "wait", "pia", "-w", WS, "--after-runs", "0", "--first"];
    const withText = await runCli([...args, "--timeout", "5", "--json"], dbPath);
    expect(JSON.parse(withText.stdout).nextSteps).toEqual([]);
    ext.start();
    ext.settle("");
    const empty = await runCli(
      ["agent", "wait", "pia", "-w", WS, "--after-runs", "1", "--first", "--json"],
      dbPath,
    );
    expect(JSON.stringify(JSON.parse(empty.stdout).nextSteps)).toContain("mu agent read pia -w cs");
  });

  it("--first keeps the read hint for a run with lastText and a lastError", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    ext.settle("partial", "rate limited");
    const res = await runCli(
      ["agent", "wait", "pia", "-w", WS, "--after-runs", "0", "--first", "--json"],
      dbPath,
    );
    expect(JSON.stringify(JSON.parse(res.stdout).nextSteps)).toContain("mu agent read pia -w cs");
  });

  it("--first human output prints the read hint only when the run has no lastText", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    ext.settle("the answer");
    const args = ["agent", "wait", "pia", "-w", WS, "--first"];
    const withText = await runCli([...args, "--after-runs", "0"], dbPath);
    expect(withText.stdout).toContain("finished");
    expect(withText.stdout).not.toContain("mu agent read");
    ext.start();
    ext.settle("");
    const empty = await runCli([...args, "--after-runs", "1"], dbPath);
    expect(empty.stdout).toContain("mu agent read pia -w cs");
  });

  it("--after-runs refuses a non-pi agent (usage, exit 2)", async () => {
    insertAgent(db, { name: "shy", workstream: WS, paneId: "%2", cli: "sh" });
    const res = await runCli(
      ["agent", "wait", "shy", "-w", WS, "--after-runs", "0", "--timeout", "1"],
      dbPath,
    );
    expect(res.stderr).toContain("--after-runs needs a pi agent");
    expect(res.stderr).toContain("shy");
    expect(res.exitCode ?? process.exitCode).toBe(2);
    process.exitCode = undefined;
  });

  it("--lines is gone", async () => {
    await fakeExtension({ state: "idle", since: 1, runs: 0 });
    const res = await runCli(
      ["agent", "wait", "pia", "-w", WS, "--lines", "5", "--timeout", "1"],
      dbPath,
    );
    expect(res.stderr).toContain("unknown option '--lines'");
    process.exitCode = undefined;
  });

  it("exits 5 on timeout while pi stays busy", async () => {
    await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const res = await runCli(["agent", "wait", "pia", "-w", WS, "--timeout", "1"], dbPath);
    expect(process.exitCode).toBe(5);
    process.exitCode = undefined;
    expect(res.stdout).toContain("Timed out");
  });

  it("exits 6 when the socket goes away mid-wait", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const pending = runCli(["agent", "wait", "pia", "-w", WS, "--timeout", "10"], dbPath);
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await ext.close();
    rmSync(ctlSocketPath(WS, "pia", dir), { force: true });
    await pending;
    expect(process.exitCode).toBe(6);
    process.exitCode = undefined;
  });
});

describe("mu task wait --stuck-after for a pi owner", () => {
  it("uses ctl's since for the stuck age", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 60_000, runs: 1 });
    addTask(db, { localId: "t1", workstream: WS, title: "T", impact: 50, effortDays: 1 });
    await claimTask(db, "t1", { workstream: WS, agentName: "pia" });
    const owner = getAgent(db, "pia", WS);
    if (owner === undefined) throw new Error("no agent row");
    const res = await waitForTasks(db, [{ workstreamName: WS, name: "t1" }], {
      timeoutMs: 1,
      stuckAfterMs: 30_000,
      readOwnerState: async () =>
        (await readAgentStates([owner], { stateDir: dir })).get(agentKey(owner)) ?? null,
    });
    expect(res.refs[0]?.stuck).toBe(true);
  });

  // ctl's idle is exact and lands after the close nudge, so the default
  // threshold for a ctl owner is seconds, not the 120 s debounce that
  // screen-scraped murmur/herdr readings need.
  const waitOnPia = async (opts: { stuckAfterMs?: number; ctlStuckAfterMs?: number } = {}) => {
    addTask(db, { localId: "t1", workstream: WS, title: "T", impact: 50, effortDays: 1 });
    await claimTask(db, "t1", { workstream: WS, agentName: "pia" });
    const owner = getAgent(db, "pia", WS);
    if (owner === undefined) throw new Error("no agent row");
    const res = await waitForTasks(db, [{ workstreamName: WS, name: "t1" }], {
      timeoutMs: 1,
      ...opts,
      readOwnerState: async () =>
        (await readAgentStates([owner], { stateDir: dir })).get(agentKey(owner)) ?? null,
    });
    return res.refs[0]?.stuck;
  };

  it("flags an idle ctl owner after seconds, not the 120 s default", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 10_000, runs: 1 });
    expect(await waitOnPia()).toBe(true);
  });

  it("does not flag a ctl owner that settled within the grace", async () => {
    await fakeExtension({ state: "idle", since: Date.now(), runs: 1 });
    expect(await waitOnPia()).toBe(false);
  });

  it("does not flag an idle ctl owner with queued messages", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 600_000, runs: 1, pending: true });
    expect(await waitOnPia()).toBe(false);
  });

  it("the reading carries ctl runs; the stall warn and exit 7 lead with wait --after-runs", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 600_000, runs: 3 });
    expect((await read())?.runs).toBe(3);
    addTask(db, { localId: "t1", workstream: WS, title: "T", impact: 50, effortDays: 1 });
    await claimTask(db, "t1", { workstream: WS, agentName: "pia" });
    const owner = getAgent(db, "pia", WS);
    if (owner === undefined) throw new Error("no agent row");
    const warns: string[] = [];
    const restore = setWaitStuckWarnForTests((m) => warns.push(m));
    try {
      const err = await waitForTasks(db, [{ workstreamName: WS, name: "t1" }], {
        timeoutMs: 1,
        onStall: "exit",
        readOwnerState: async () =>
          (await readAgentStates([owner], { stateDir: dir })).get(agentKey(owner)) ?? null,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StallDetectedDuringWaitError);
      const cmds = (err as StallDetectedDuringWaitError).errorNextSteps().map((s) => s.command);
      expect(cmds[0]).toBe("mu agent wait pia --after-runs 2 --json -w cs");
      expect(cmds[1]).toBe("mu agent read pia -w cs --lines 60");
      expect(warns.join("")).toContain("mu agent wait pia --after-runs 2 --json -w cs");
      expect(warns.join("")).toContain("mu agent read pia -w cs --lines 60");
    } finally {
      setWaitStuckWarnForTests(restore);
    }
  });

  it("stuckAfterMs 0 disables the ctl threshold too", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 600_000, runs: 1 });
    expect(await waitOnPia({ stuckAfterMs: 0 })).toBe(false);
  });
});
