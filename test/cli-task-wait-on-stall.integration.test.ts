// `mu task wait --on-stall <warn|exit>` (task_wait_stall_action_flag) through the unified
// wait: a stall is an event (kind `stall`, exit 7) in the one JSON document; `warn` flags the
// snapshot (`stuck`) and one stderr line, and keeps waiting.
//
// Real SQLite (in-temp-dir), no tmux. Drives the CLI in-process via
// runCli — same pattern as test/cli-task-wait-cross-ws.integration.test.ts.
// Determinism comes from running outside any tmux session: the
// per-poll reconcile in cmdTaskWait wraps `reconcile()` in
// try/catch, so the absence of tmux silently no-ops the reaper —
// and the stall predicate (which is pure DB read on the agent row's
// status + updated_at) takes the spotlight.
//
// What we cover:
//   1. --on-stall exit (target=CLOSED): stuck task → exit 7; the event names the task,
//      the snapshot names the owner and why.
//   2. --on-stall exit + --status OPEN carve-out: behaves as warn-only.
//   3. --stuck-after 0 disables both warn AND exit.
//   4. Multi-ref --on-stall exit fires on the FIRST stalled ref (argv
//      order; the loop iterates refs in order).
//
// The dead-pane-vs-stall PRECEDENCE proof lives at the SDK level in
// test/tasks.test.ts ("--on-stall exit: a beforePoll throw pre-empts
// the stuck-check throw"). An integration version of that test is
// unavoidably racy: tick 0 snapshot vs tmux's pane-death propagation
// can land in either order depending on system load. The SDK seam reaches the same
// assertion deterministically.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor, type TmuxExecutor } from "../src/tmux.js";
import { setWaitSleepForTests } from "../src/wait.js";
import { ensureWorkstream } from "../src/workstream.js";
import { freshWorkstream } from "./_fixture.js";
import { runCli } from "./_runCli.js";

describe("mu task wait --on-stall warn|exit", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;
  let workstream: string;
  let restoreSleep: ((ms: number) => Promise<void>) | undefined;

  // Track every paneId seeded by setupStalledWorker so the mock
  // tmux executor below reports them all as live (otherwise the
  // per-poll reconcile would treat them as ghosts and reap them —
  // exactly the failure mode that breaks integration runs of this
  // test under load).
  const liveAgentPaneIds = new Set<string>();
  const servers: Server[] = [];

  /** Stand-in for the mu pi extension: idle since `since`, for any request. */
  async function serveCtl(agentName: string, since: number, runs = 1): Promise<void> {
    const path = ctlSocketPath(workstream, agentName, tempDir);
    mkdirSync(dirname(path), { recursive: true });
    const server = createServer((sock) => {
      const dec = new LineDecoder();
      sock.setEncoding("utf8");
      sock.on("error", () => {});
      sock.on("data", (chunk: string) => {
        for (const _line of dec.push(chunk)) {
          sock.end(encode({ v: 1, ok: true, state: "idle", since, runs, pending: false }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-stall-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    // Per-test unique workstream so even if a future change runs the
    // file in parallel-test mode the rows don't bleed across tests.
    workstream = freshWorkstream("stall");
    ensureWorkstream(db, workstream);
    liveAgentPaneIds.clear();
    // Mock tmux so the per-poll reconcile in cmdTaskWait sees every
    // seeded agent's pane as alive (no ghost-prune → no reaper-flip).
    // We answer ONLY the calls reconcile makes and return harmless
    // empties for everything else; tests don't exercise other tmux
    // paths.
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "list-panes" && args[1] === "-a") {
        const since = Date.now() - 10 * 60_000;
        const lines = [...liveAgentPaneIds].map((paneId) => `${paneId}\tidle\t${since}`).join("\n");
        return { stdout: lines, stderr: "", exitCode: 0 };
      }
      // list-panes for `mu-<ws>`: synthesize one row per live pane id.
      if (args[0] === "list-panes") {
        const lines = [...liveAgentPaneIds].map((paneId) => `@1\t${paneId}\tagent\tsh`).join("\n");
        return { stdout: `${lines}\n`, stderr: "", exitCode: 0 };
      }
      // capture-pane: empty scrollback → detector falls through to
      // 'needs_input' → matches the seeded status → no UPDATE →
      // updated_at stays stale (the desired stuck state).
      if (args[0] === "capture-pane") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // set-option / display-message etc.: noop.
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    setTmuxExecutor(executor);
    // Tight poll-sleep so timeout-path tests don't burn real wall time.
    restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));
    });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((srv) => new Promise((r) => srv.close(() => r(null)))));
    if (restoreSleep !== undefined) setWaitSleepForTests(restoreSleep);
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Set up a registered worker owning an IN_PROGRESS task. The
   *  agent's status is set to needs_input with `updated_at` 10min
   *  in the past so the --stuck-after predicate fires immediately.
   *
   *  Direct DB manipulation (instead of `claimTask`) keeps the
   *  setup deterministic outside any tmux session: claimTask
   *  resolves an actor identity via tmux/$USER and would fail
   *  silently in this no-tmux unit harness. Mirrors the same
   *  pattern in test/tasks.test.ts ("emits exactly one STUCK warning
   *  per stuck task per wait call"). */
  function setupStalledWorker(agentName: string, taskName: string, cli = "claude"): void {
    const paneId = `%${Math.floor(Math.random() * 1e6)}`;
    liveAgentPaneIds.add(paneId);
    // Default: a non-pi CLI, so murmur (the tmux mock above) is the
    // state source. pi agents read the control socket instead.
    insertAgent(db, {
      name: agentName,
      workstream,
      paneId,
      cli,
    });
    addTask(db, { localId: taskName, workstream, title: "T", impact: 50, effortDays: 1 });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS', substate = 'active',
              owner_id = (SELECT id FROM agents WHERE name = ?),
              updated_at = ?
        WHERE local_id = ?`,
    ).run(agentName, new Date().toISOString(), taskName);
  }

  interface Doc {
    firing: { kind: string; ref: string | null };
    exit: number;
    timedOut: boolean;
    snapshots: {
      ref: string;
      owner?: string;
      stuck?: boolean;
      stuckWhy?: string;
      fired: boolean;
    }[];
  }
  const doc = (stdout: string): Doc => JSON.parse(stdout).data as Doc;

  it("--on-stall exit: stall → exit 7; the event names the task, the snapshot the owner and why", async () => {
    setupStalledWorker("alice", "build");

    const start = Date.now();
    const { exitCode, stdout, stderr } = await runCli(
      [
        "task",
        "wait",
        "build",
        "-w",
        workstream,
        "--stuck-after",
        "1",
        "--on-stall",
        "exit",
        "--timeout",
        "30",
      ],
      dbPath,
    );
    const elapsedMs = Date.now() - start;

    expect(exitCode).toBe(7);
    expect(stderr).toBe("");
    const d = doc(stdout);
    expect(d).toMatchObject({ exit: 7, timedOut: false });
    expect(d.firing).toEqual({ kind: "stall", ref: `task:${workstream}/build` });
    expect(d.snapshots[0]).toMatchObject({ owner: "alice", stuck: true, stuckWhy: "needs_input" });
    // Fail-fast property: well under --timeout.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("--on-stall exit + --status OPEN: no stall (a non-CLOSED target is not stalled by its owner)", async () => {
    // The carve-out rule: a stall is only reported when the wait target is CLOSED. With
    // --status OPEN the worker reaching needs_input might BE the success path.
    setupStalledWorker("carol", "review");

    const { exitCode, stdout } = await runCli(
      [
        "task",
        "wait",
        "review",
        "-w",
        workstream,
        "--status",
        "OPEN",
        "--stuck-after",
        "1",
        "--on-stall",
        "exit",
        "--timeout",
        "0.3",
      ],
      dbPath,
    );

    expect(exitCode).toBeNull(); // the heartbeat, NOT exit 7
    const d = doc(stdout);
    expect(d).toMatchObject({ timedOut: true, exit: 0 });
    expect(d.snapshots[0]?.stuck).toBeUndefined();
  });

  it("--stuck-after 0 disables stall detection (--on-stall exit no-ops)", async () => {
    setupStalledWorker("eve", "audit");

    const { exitCode, stdout, stderr } = await runCli(
      [
        "task",
        "wait",
        "audit",
        "-w",
        workstream,
        "--stuck-after",
        "0",
        "--on-stall",
        "exit",
        "--timeout",
        "0.3",
      ],
      dbPath,
    );

    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    expect(doc(stdout)).toMatchObject({ timedOut: true, exit: 0 });
  });

  it("multi-ref --on-stall exit fires on the FIRST stalled task (argv order)", async () => {
    setupStalledWorker("w1", "t1");
    setupStalledWorker("w2", "t2");

    const { exitCode, stdout } = await runCli(
      [
        "task",
        "wait",
        "t1",
        "t2",
        "-w",
        workstream,
        "--stuck-after",
        "1",
        "--on-stall",
        "exit",
        "--timeout",
        "30",
      ],
      dbPath,
    );

    expect(exitCode).toBe(7);
    // Names t1 (first in argv), not t2.
    expect(doc(stdout).firing).toEqual({ kind: "stall", ref: `task:${workstream}/t1` });
  });

  it("--on-stall exit is the default: a stuck task → exit 7 without the flag", async () => {
    // Orchestrators kept forgetting --on-stall exit and polled past a
    // worker that needed them until --timeout. The flag is now the default.
    setupStalledWorker("dave", "ship");

    const { exitCode, stdout } = await runCli(
      ["task", "wait", "ship", "-w", workstream, "--stuck-after", "1", "--timeout", "30"],
      dbPath,
    );

    expect(exitCode).toBe(7);
    const d = doc(stdout);
    expect(d.firing.kind).toBe("stall");
    // A stall leaves the task owed: next is its resume (4226d0c), never a pane read.
    const next = JSON.parse(stdout).next;
    expect(next?.commands?.[0]).toMatch(/^mu wait --resume /);
    expect(JSON.stringify(next)).not.toContain("agent read");
  });

  it("--on-stall warn: one stderr line, keeps waiting, times out ok:true", async () => {
    setupStalledWorker("frank", "deploy");

    const { exitCode, stdout, stderr } = await runCli(
      [
        "task",
        "wait",
        "deploy",
        "-w",
        workstream,
        "--stuck-after",
        "1",
        "--on-stall",
        "warn",
        "--timeout",
        "0.3",
      ],
      dbPath,
    );

    expect(exitCode).toBeNull(); // timed out, warn-only
    expect(stderr).toMatch(/needs attention/i);
    expect(stderr.trim().split("\n")).toHaveLength(1); // once, not once per poll
    expect(doc(stdout)).toMatchObject({ timedOut: true, exit: 0 });
  });

  it("pi owner: ctl idle with an old since → --on-stall exit 7", async () => {
    setupStalledWorker("piper", "pi_task", "pi");
    await serveCtl("piper", Date.now() - 10 * 60_000);

    const { exitCode, stdout } = await runCli(
      [
        "task",
        "wait",
        "pi_task",
        "-w",
        workstream,
        "--stuck-after",
        "1",
        "--on-stall",
        "exit",
        "--timeout",
        "30",
      ],
      dbPath,
    );

    expect(exitCode).toBe(7);
    expect(doc(stdout).snapshots[0]).toMatchObject({ owner: "piper", stuckWhy: "needs_input" });
  });

  it("pi owner: without --stuck-after, ctl idle for 10 s → exit 7 (ctl default is 5 s)", async () => {
    setupStalledWorker("pip", "pi_quick", "pi");
    await serveCtl("pip", Date.now() - 10_000);

    const { exitCode, stdout } = await runCli(
      ["task", "wait", "pi_quick", "-w", workstream, "--timeout", "30"],
      dbPath,
    );

    expect(exitCode).toBe(7);
    expect(doc(stdout).snapshots[0]?.owner).toBe("pip");
  });

  it("pi owner: an explicit --stuck-after overrides the ctl default", async () => {
    setupStalledWorker("pat", "pi_slow", "pi");
    await serveCtl("pat", Date.now() - 10_000);

    const { exitCode, stdout } = await runCli(
      ["task", "wait", "pi_slow", "-w", workstream, "--stuck-after", "60", "--timeout", "0.3"],
      dbPath,
    );

    expect(exitCode).toBeNull();
    expect(doc(stdout).timedOut).toBe(true); // 10 s idle < 60 s: the heartbeat, not a stall
  });

  it("pi owner with no control socket: needs attention, not a dead pane", async () => {
    // Live pane, no socket: nothing will report the worker settling, so
    // the stall predicate fires (age from when the wait first saw it).
    setupStalledWorker("nosock", "orphan_task", "pi");

    const { exitCode, stdout } = await runCli(
      [
        "task",
        "wait",
        "orphan_task",
        "-w",
        workstream,
        "--stuck-after",
        "0.2",
        "--on-stall",
        "exit",
        "--timeout",
        "30",
      ],
      dbPath,
    );

    expect(exitCode).toBe(7); // stall, NOT exit 6
    const d = doc(stdout);
    expect(d.firing.kind).toBe("stall");
    expect(d.snapshots[0]).toMatchObject({ owner: "nosock" });
    expect(d.snapshots[0]?.stuckWhy).toMatch(/ctl missing|ctl/);
  });

  it("pi owner with no control socket, --on-stall warn: warns, then times out ok:true", async () => {
    setupStalledWorker("nosock2", "orphan2", "pi");

    const { exitCode, stdout, stderr } = await runCli(
      [
        "task",
        "wait",
        "orphan2",
        "-w",
        workstream,
        "--stuck-after",
        "0.2",
        "--on-stall",
        "warn",
        "--timeout",
        "0.8",
      ],
      dbPath,
    );

    expect(exitCode).toBeNull();
    expect(stderr).toMatch(/nosock2 needs attention \(ctl/);
    expect(doc(stdout)).toMatchObject({ timedOut: true, exit: 0 });
  });

  it("--on-stall <bad>: usage error as one JSON document", async () => {
    addTask(db, {
      localId: "x",
      workstream,
      title: "X",
      impact: 50,
      effortDays: 1,
    });

    const { exitCode, stdout } = await runCli(
      ["task", "wait", "x", "-w", workstream, "--on-stall", "bogus"],
      dbPath,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, exit: 2 });
    expect(JSON.parse(stdout).message).toMatch(/--on-stall/);
  });

  it("--on-stall nope: a usage error naming the four actions", async () => {
    addTask(db, { localId: "y", workstream, title: "Y", impact: 50, effortDays: 1 });
    const { exitCode, stdout } = await runCli(
      ["task", "wait", "y", "-w", workstream, "--on-stall", "nope"],
      dbPath,
    );
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout).message).toMatch(/'exit', 'warn', 'steer' or 'release'/);
  });
});
