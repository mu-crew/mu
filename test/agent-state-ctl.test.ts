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
import { insertAgent, listLiveAgents } from "../src/agents.js";
import { formatAgentsTable } from "../src/cli/format.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, INCARNATION_MISMATCH, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { addTask, claimTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { waitForEvents } from "../src/wait.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { runCli, runCliJson } from "./_runCli.js";

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
  /** Open an extension dialog: status gains `blocked`; held
   *  returnOnBlocked waits end with ended "blocked". */
  block: (kind: string, title?: string) => void;
  /** Close the dialog: status loses `blocked`. */
  unblock: () => void;
  /** Drop every held wait connection; the server keeps answering. */
  dropWaits: () => void;
  /** pi restarts: a NEW incarnation answers on the same socket and every held wait drops. */
  restart: (incarnation: string) => void;
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
  const waiters: Array<{ after: number | undefined; sock: Socket; onBlocked: boolean }> = [];
  let blocked: { kind: string; title?: string; since: number } | undefined;
  let lastText: string | undefined;
  let lastError: string | undefined;
  let inc = INC;
  const settled = () => ({
    ...(lastText === undefined ? {} : { lastText }),
    ...(lastError === undefined ? {} : { lastError }),
  });
  const status = () => ({
    v: 1,
    ok: true,
    incarnation: inc,
    state,
    since,
    runs,
    pending,
    ...(blocked ? { blocked } : {}),
  });
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
        const req = JSON.parse(line) as {
          op: string;
          afterRuns?: number;
          returnOnBlocked?: boolean;
        };
        ops.push(req.op);
        if (req.op === "hello") {
          sock.end(encode(helloReply({ incarnation: inc })));
        } else if (
          req.op === "wait" &&
          (req as { incarnation?: string }).incarnation !== undefined &&
          (req as { incarnation?: string }).incarnation !== inc
        ) {
          sock.end(encode({ v: 1, ok: false, error: INCARNATION_MISMATCH, incarnation: inc }));
        } else if (req.op === "wait") {
          const onBlocked = req.returnOnBlocked === true;
          if (req.afterRuns !== undefined && runs > req.afterRuns && state === "idle") {
            sock.end(encode({ ...status(), ...settled() }));
          } else if (onBlocked && blocked) {
            sock.end(encode({ ...status(), ended: "blocked" }));
          } else waiters.push({ after: req.afterRuns, sock, onBlocked });
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
    block: (kind: string, title?: string) => {
      blocked = { kind, ...(title !== undefined ? { title } : {}), since: 4242 };
      for (const w of waiters.filter((x) => x.onBlocked)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.sock.end(encode({ ...status(), ended: "blocked" }));
      }
    },
    unblock: () => {
      blocked = undefined;
    },
    dropWaits: () => {
      for (const w of waiters.splice(0)) w.sock.destroy();
    },
    restart: (incarnation: string) => {
      inc = incarnation;
      runs = 0;
      for (const w of waiters.splice(0)) w.sock.destroy();
    },
    settle: (text?: string, error?: string) => {
      state = "idle";
      since = Date.now();
      runs++;
      lastText = text;
      lastError = error;
      const reply = { ...status(), ...settled(), ended: "settled" };
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
      incarnation: INC,
    });
    ext.settle();
    expect(await read()).toMatchObject({ state: "needs_input", source: "ctl", ctl: "ok" });
  });

  it("an open extension dialog reads needs_permission, titled, since it opened", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    ext.block("confirm", "Allow rm?");
    expect(await read()).toMatchObject({
      state: "needs_permission",
      source: "ctl",
      since: 4242,
      reason: "dialog confirm: Allow rm?",
    });
    const view = await listLiveAgents(db, { workstream: WS, mode: "report-only" });
    expect(view.agents[0]).toMatchObject({
      state: "needs_permission",
      reason: "dialog confirm: Allow rm?",
    });
    expect(formatAgentsTable(view.agents)).toContain("needs_permission: dialog confirm: Allow rm?");
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
    const pending = runCliJson(
      ["agent", "wait", "pia", "-w", WS, "--timeout", "10", "--json"],
      dbPath,
    );
    // Let the wait request arrive, then settle.
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ext.ops).toContain("wait");
    ext.settle("ok");
    const res = await pending;
    expect(res.error).toBeUndefined();
    expect(res.exitCode).toBeNull();
    const payload = res.data as {
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
    const pending = runCliJson(
      ["agent", "wait", "pia", "-w", WS, "--timeout", "10", "--json"],
      dbPath,
    );
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // The waiter must hold: idle at start is not "this work finished".
    await new Promise((r) => setTimeout(r, 30));
    ext.start();
    ext.settle();
    const res = await pending;
    expect(res.exitCode).toBeNull();
    expect((res.data as { agents: Array<{ fired: boolean }> }).agents[0]?.fired).toBe(true);
  });

  it("--after-runs catches a run that settled before the wait started", async () => {
    // send replied runs:2, then the run went 2 → 3 before the wait ran.
    const ext = await fakeExtension({ state: "idle", since: 1, runs: 3 });
    const res = await runCliJson(
      ["agent", "wait", "pia", "-w", WS, "--after-runs", "2", "--timeout", "2", "--json"],
      dbPath,
    );
    expect(res.exitCode).toBeNull();
    expect((res.data as { agents: Array<{ fired: boolean }> }).agents[0]?.fired).toBe(true);
    expect(ext.ops).toEqual(["wait"]);
  });

  it("--after-runs <runs-1> on an idle pi returns the last run's lastText at once", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    ext.settle("the answer"); // runs 1, idle; no waiter held
    const started = Date.now();
    const res = await runCliJson(
      ["agent", "wait", "pia", "-w", WS, "--after-runs", "0", "--timeout", "5", "--json"],
      dbPath,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.exitCode).toBeNull();
    const a = (res.data as { agents: Array<{ fired: boolean; lastText?: string }> }).agents[0];
    expect(a).toMatchObject({ fired: true, lastText: "the answer" });
    expect(ext.ops).toEqual(["wait"]);
  });

  it("--first never hints a pane read (reads are never next), with or without lastText", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    ext.settle("the answer");
    const args = ["agent", "wait", "pia", "-w", WS, "--after-runs", "0", "--first"];
    const withText = await runCliJson([...args, "--timeout", "5", "--json"], dbPath);
    expect(withText.doc.next).toBeNull();
    ext.start();
    ext.settle("");
    const empty = await runCli(
      ["agent", "wait", "pia", "-w", WS, "--first", "--after-runs", "1"],
      dbPath,
    );
    expect(empty.stdout).toContain("finished");
    expect(empty.stdout).not.toContain("mu agent read");
  });

  it("a settled worker's CLOSE block is not applied by `mu agent wait` (only the wait verbs that own the task close it)", async () => {
    addTask(db, { localId: "t1", workstream: WS, title: "T", impact: 50, effortDays: 1 });
    await claimTask(db, "t1", { workstream: WS, agentName: "pia" });
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const pending = runCliJson(
      ["agent", "wait", "pia", "-w", WS, "--timeout", "10", "--json"],
      dbPath,
    );
    await new Promise((r) => setTimeout(r, 100));
    ext.settle(`Done.\n\nCLOSE: task=t1 evidence="npm test: ok"\nREPORT:\nFILES: a.ts\nDONE`);
    const res = await pending;
    expect((res.data as { agents: { fired: boolean }[] }).agents[0]?.fired).toBe(true);
    expect(db.prepare("SELECT status FROM tasks WHERE local_id = 't1'").get()).toEqual({
      status: "IN_PROGRESS",
    });
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

  it("a dialog opening mid-wait ends it: outcome blocked, not fired, exit 7", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const pending = runCliJson(
      ["agent", "wait", "pia", "-w", WS, "--after-runs", "0", "--timeout", "10", "--json"],
      dbPath,
    );
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ext.block("select", "Pick a branch");
    const res = await pending;
    expect(process.exitCode).toBe(7);
    process.exitCode = undefined;
    const out = res.data as {
      timedOut: boolean;
      agents: Array<{ fired: boolean; outcome?: string; status?: string; blocked?: unknown }>;
    };
    expect(out.timedOut).toBe(false);
    expect(out.agents[0]).toMatchObject({
      fired: false,
      outcome: "blocked",
      status: "needs_permission",
      blocked: { kind: "select", title: "Pick a branch" },
    });
  });

  it("a dialog already open ends the wait at once; human output names it", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    ext.block("confirm");
    const res = await runCli(["agent", "wait", "pia", "-w", WS, "--timeout", "10"], dbPath);
    expect(process.exitCode).toBe(7);
    process.exitCode = undefined;
    expect(res.stdout).toContain("cs/pia is waiting on a dialog confirm");
    expect(res.stdout).toContain("not finished");
  });

  it("blocked JSON carries the run baseline; a re-wait from it returns a run that settled first", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 2 });
    ext.block("confirm", "Allow push?");
    // No --after-runs: the baseline is the status read taken at wait start.
    const first = await runCliJson(
      ["agent", "wait", "pia", "-w", WS, "--timeout", "5", "--json"],
      dbPath,
    );
    expect(process.exitCode).toBe(7);
    process.exitCode = undefined;
    const out = first.data as { agents: Array<{ outcome?: string; afterRuns?: number }> };
    expect(out.agents[0]).toMatchObject({ outcome: "blocked", afterRuns: 2 });
    // The human answers and the run settles before the re-wait starts.
    ext.unblock();
    ext.settle("the answer");
    const args = [
      "agent",
      "wait",
      "pia",
      "-w",
      WS,
      "--after-runs",
      String(out.agents[0]?.afterRuns),
    ];
    const again = await runCliJson([...args, "--timeout", "2", "--json"], dbPath);
    expect(again.exitCode).toBeNull();
    expect(process.exitCode).toBeUndefined();
    expect(again.data.agents[0]).toMatchObject({
      fired: true,
      outcome: "done",
      lastText: "the answer",
    });
  });

  it("a dialog seen after a dropped wait still ends blocked, not fired", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const pending = runCliJson(
      ["agent", "wait", "pia", "-w", WS, "--after-runs", "0", "--timeout", "10", "--json"],
      dbPath,
    );
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // The held wait drops (socket still answers): mu falls back to polling,
    // and the dialog opens with no wait held to report it.
    ext.dropWaits();
    ext.block("confirm", "Allow rm?");
    const res = await pending;
    expect(process.exitCode).toBe(7);
    process.exitCode = undefined;
    const out = res.data as {
      agents: Array<{ fired: boolean; outcome?: string; status?: string; blocked?: unknown }>;
    };
    expect(out.agents[0]).toMatchObject({
      fired: false,
      outcome: "blocked",
      status: "needs_permission",
      blocked: { kind: "confirm", title: "Allow rm?" },
    });
  });

  it("exits 5 on timeout while pi stays busy", async () => {
    await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const res = await runCli(["agent", "wait", "pia", "-w", WS, "--timeout", "0.3"], dbPath);
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

describe("wait --stuck-after for a pi owner", () => {
  // ctl's idle is exact and lands after the close nudge, so the default
  // threshold for a ctl owner is seconds, not the 120 s debounce that
  // screen-scraped murmur/herdr readings need.
  const waitOnPia = async (opts: { stuckAfterMs?: number } = {}) => {
    addTask(db, { localId: "t1", workstream: WS, title: "T", impact: 50, effortDays: 1 });
    await claimTask(db, "t1", { workstream: WS, agentName: "pia" });
    const res = await waitForEvents(db, [{ kind: "task", workstream: WS, id: "t1" }], {
      callers: [],
      eventScope: "refs",
      onStall: "warn",
      sync: false,
      pollMs: 5,
      timeoutMs: 100,
      ...opts,
      ...ctlAgentHooks(db),
    });
    return res.refs[0];
  };

  it("uses ctl's since for the stuck age", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 60_000, runs: 1 });
    expect((await waitOnPia({ stuckAfterMs: 30_000 }))?.stuck).toBe(true);
  });

  it("flags an idle ctl owner after seconds, not the 120 s default", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 10_000, runs: 1 });
    expect((await waitOnPia())?.stuck).toBe(true);
  });

  it("does not flag a ctl owner that settled within the grace", async () => {
    await fakeExtension({ state: "idle", since: Date.now(), runs: 1 });
    expect((await waitOnPia())?.stuck).toBeFalsy();
  });

  it("does not flag an idle ctl owner with queued messages", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 600_000, runs: 1, pending: true });
    expect((await waitOnPia())?.stuck).toBeFalsy();
  });

  it("the stalled snapshot carries the owner's ctl runs (the stall steps lead with wait agent:<ref>@runs-1)", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 600_000, runs: 3 });
    expect((await read())?.runs).toBe(3);
    expect(await waitOnPia()).toMatchObject({ stuck: true, owner: "pia", ownerRuns: 3 });
  });

  it("stuckAfterMs 0 disables the ctl threshold too", async () => {
    await fakeExtension({ state: "idle", since: Date.now() - 600_000, runs: 1 });
    expect((await waitOnPia({ stuckAfterMs: 0 }))?.stuck).toBeFalsy();
  });
});

describe("mu agent wait --inc: a restarted agent is refused, never waited on", () => {
  const waitArgs = (...extra: string[]) => [
    "agent",
    "wait",
    "pia",
    "-w",
    WS,
    "--timeout",
    "5",
    "--json",
    ...extra,
  ];

  it("the matching incarnation waits normally and the request carries it", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const pending = runCliJson(waitArgs("--after-runs", "0", "--inc", INC), dbPath);
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ext.settle("done");
    const res = await pending;
    expect(res.exitCode).toBeNull();
    expect(res.data.agents[0]).toMatchObject({ fired: true, lastText: "done" });
  });

  it("a mismatch reply is AgentRestartedError: exit 4, old and new incarnation named, one stderr line", async () => {
    await fakeExtension({ state: "idle", since: 1, runs: 3 });
    const res = await runCliJson(waitArgs("--after-runs", "2", "--inc", "inc-OLD"), dbPath);
    expect(res.exitCode).toBe(4);
    const env = res.doc as unknown as { error: string; message: string };
    expect(env.error).toBe("AgentRestartedError");
    expect(env.message).toBe(
      `agent pia restarted (incarnation inc-OLD → ${INC}); its earlier run is gone: re-send the brief`,
    );
  });

  it("human mode: the message is the one stderr line", async () => {
    await fakeExtension({ state: "idle", since: 1, runs: 3 });
    const res = await runCli(
      ["agent", "wait", "pia", "-w", WS, "--timeout", "5", "--after-runs", "2", "--inc", "inc-OLD"],
      dbPath,
    );
    expect(res.exitCode).toBe(4);
    const sgr = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "g");
    const lines = res.stderr
      .replace(sgr, "")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines[0]).toBe(
      `conflict: agent pia restarted (incarnation inc-OLD → ${INC}); its earlier run is gone: re-send the brief`,
    );
    expect(lines).toHaveLength(1);
  });

  it("pi restarts MID-wait: the held wait drops, the reconnect finds another incarnation: fatal, not polled", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const pending = runCliJson(waitArgs("--after-runs", "0", "--inc", INC), dbPath);
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ext.restart("inc-NEW");
    const res = await pending;
    expect(res.exitCode).toBe(4);
    expect(res.doc.message).toContain(`${INC} → inc-NEW`);
  });

  it("the SAME incarnation answering after a drop (a /new) still falls back to polling", async () => {
    const ext = await fakeExtension({ state: "busy", since: 1, runs: 0 });
    const pending = runCliJson(waitArgs("--after-runs", "0", "--inc", INC), dbPath);
    for (let i = 0; i < 100 && !ext.ops.includes("wait"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ext.dropWaits();
    ext.settle("after the drop");
    const res = await pending;
    expect(res.exitCode).toBeNull();
    expect(res.data.agents[0]).toMatchObject({ fired: true });
  });

  it("without --inc nothing changes: a restarted pi is still waited on", async () => {
    const ext = await fakeExtension({ state: "idle", since: 1, runs: 3 });
    ext.restart("inc-NEW");
    ext.settle("fresh answer");
    const res = await runCliJson(waitArgs("--after-runs", "0"), dbPath);
    expect(res.exitCode).toBeNull();
    expect(res.data.agents[0]).toMatchObject({ fired: true });
  });

  it("an extension without the incarnation feature: AgentExtensionOutdatedError before waiting", async () => {
    const path = ctlSocketPath(WS, "pia", dir);
    mkdirSync(dirname(path), { recursive: true });
    const server = createServer((sock) => {
      const dec = new LineDecoder();
      sock.setEncoding("utf8");
      sock.on("error", () => {});
      sock.on("data", (chunk: string) => {
        for (const line of dec.push(chunk)) {
          const req = JSON.parse(line) as { op: string };
          sock.end(
            encode(
              req.op === "hello"
                ? helloReply({ features: ["msgId"], ops: ["hello", "status", "wait"] })
                : { v: 1, ok: true, state: "idle", since: 1, runs: 0, pending: false },
            ),
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
    const res = await runCliJson(waitArgs("--inc", "x"), dbPath);
    expect(res.exitCode).toBe(4);
    expect(res.doc).toMatchObject({ error: "AgentExtensionOutdatedError" });
  });

  it("--inc needs a pi agent and one agent: usage errors", async () => {
    insertAgent(db, { name: "shy", workstream: WS, paneId: "%2", cli: "claude" });
    const noPi = await runCli(
      ["agent", "wait", "shy", "-w", WS, "--timeout", "1", "--inc", "x"],
      dbPath,
    );
    expect(noPi.exitCode).toBe(2);
    expect(noPi.stderr).toContain("--inc needs a pi agent");
    const two = await runCli(
      ["agent", "wait", "pia", "shy", "-w", WS, "--timeout", "1", "--inc", "x"],
      dbPath,
    );
    expect(two.exitCode).toBe(2);
  });
});
