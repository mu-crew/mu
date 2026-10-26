// Producer arming (v_wait_arming): what spawn --send, send, send --interrupt and
// claim --for register for the next wait, with the unconsumed run fence; the one wait
// hint; send --wait / claim --and-wait. A real unix-socket server stands in for the mu
// pi extension; the mux is the fake tmux harness; the caller is whoever the env says.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { armWait } from "../src/cli/wait-arm.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { isWaitVerbArgv } from "../src/output.js";
import { addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { setWaitSleepForTests } from "../src/wait.js";
import { readWaitRegistration } from "../src/wait-registration.js";
import { ensureWorkstream } from "../src/workstream.js";
import { helloReply, INC, withHello } from "./_ctl-ext.js";
import { withEnv } from "./_env.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];
/** The fake pi: its completed-run count and state, and every op it was asked. */
let pi: {
  runs: number;
  state: "idle" | "busy";
  ops: string[];
  /** A send starts a run that settles at once (the count moves), and `wait` honours `afterRuns`. */
  real?: boolean;
  /** A send is written, then the connection drops with no answer: delivery UNKNOWN. */
  dropSend?: boolean;
};
let sockets: Socket[];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mwa-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  saved = { c: process.env.MU_SPAWN_CTL_MS, l: process.env.MU_SPAWN_LIVENESS_MS };
  process.env.MU_SPAWN_CTL_MS = "300";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  servers = [];
  sockets = [];
  pi = { runs: 3, state: "idle", ops: [] };
  ensureWorkstream(db, "auth");
  ensureWorkstream(db, "other");
  mux = installMux("tmux", mockTmux(freshMockState()).executor);
});

afterEach(async () => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  setWaitSleepForTests(undefined);
  for (const sock of sockets) sock.destroy();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ["MU_SPAWN_CTL_MS", saved.c],
    ["MU_SPAWN_LIVENESS_MS", saved.l],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A stand-in extension for `ws/agent`: idle/busy at `pi.runs`; a send starts a run that settles at once. */
async function serve(agent: string, ws = "auth", onSend?: () => void): Promise<void> {
  const path = ctlSocketPath(ws, agent, dir);
  mkdirSync(dirname(path), { recursive: true });
  const status = () => ({
    incarnation: INC,
    state: pi.state,
    since: Date.now(),
    runs: pi.runs,
    pending: false,
  });
  const server = createServer((sock) => {
    sockets.push(sock);
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; afterRuns?: number };
        if (req.op !== "hello") pi.ops.push(req.op);
        if (req.op === "hello") sock.end(encode(helloReply()));
        else if (req.op === "wait" && pi.real) {
          // Honours the fence: answers only once a run past `afterRuns` has settled.
          if (pi.runs > (req.afterRuns ?? 0)) {
            sock.end(
              encode({
                v: 1,
                ok: true,
                ...status(),
                state: "idle",
                ended: "settled",
                lastText: "the answer",
              }),
            );
          }
        } else if (req.op === "wait") {
          // The run past the baseline already settled: answer at once.
          sock.end(
            encode({
              v: 1,
              ok: true,
              ...status(),
              state: "idle",
              runs: Math.max(pi.runs, (req.afterRuns ?? 0) + 1),
              ended: "settled",
              lastText: "the answer",
            }),
          );
        } else if (req.op === "interrupt") {
          // The reply carries the count AFTER the aborted run settled, before the new run.
          const wasBusy = pi.state === "busy";
          if (wasBusy) pi.runs++;
          pi.state = "idle";
          sock.end(encode({ v: 1, ok: true, ...status(), wasBusy, pending: false }));
        } else if (req.op === "send" && pi.dropSend) {
          sock.destroy();
        } else if (req.op === "send" || req.op === "command") {
          sock.end(encode(withHello(req, { v: 1, ok: true, ...status() })));
          // the reply carries the count BEFORE the run it started, which then settles
          if (pi.real && req.op === "send") pi.runs++;
          onSend?.();
        } else sock.end(encode(withHello(req, { v: 1, ok: true, ...status() })));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

type Who = { pi?: string; managed?: string };
/** Run argv as `who` (a pi session, a managed agent, or a plain shell). */
async function as(who: Who, argv: string[]) {
  const [mws, mname] = (who.managed ?? "").split("/");
  let out: Awaited<ReturnType<typeof runCliJson>> | undefined;
  db.close();
  await withEnv("PI_SESSION_ID", who.pi, () =>
    withEnv("MU_MANAGED_AGENT", who.managed === undefined ? undefined : "1", () =>
      withEnv("MU_WORKSTREAM", mws, () =>
        withEnv("MU_AGENT_NAME", mname, async () => {
          out = await runCliJson(argv, dbPath);
        }),
      ),
    ),
  );
  db = openDb({ path: dbPath });
  if (out === undefined) throw new Error("no capture");
  return out;
}
const reg = (caller: string) => readWaitRegistration(db, caller);
const agentIdOf = (name: string, ws = "auth"): number =>
  (
    db
      .prepare(
        "SELECT a.id FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE a.name = ? AND w.name = ?",
      )
      .get(name, ws) as { id: number }
  ).id;
const seedAgent = (name = "worker-1", ws = "auth"): void => {
  insertAgent(db, { name, workstream: ws, paneId: `%${name}`, cli: "pi" });
};
const seedTask = (id: string, ws = "auth"): void => {
  addTask(db, { localId: id, workstream: ws, title: id, impact: 50, effortDays: 1 });
};
const SESSION = { pi: "sess-1" };
const CALLER = "pi:sess-1";

describe("armWait", () => {
  it("a plain shell arms nothing; a managed agent arms under ws/name, ahead of its pi session", async () => {
    seedAgent();
    const ref = { kind: "agent", workstream: "auth", id: "worker-1" } as const;
    await withEnv("PI_SESSION_ID", undefined, () =>
      withEnv("MU_MANAGED_AGENT", undefined, async () => {
        expect(armWait(db, [ref])).toEqual({ armed: false });
      }),
    );
    await withEnv("PI_SESSION_ID", "s", () =>
      withEnv("MU_MANAGED_AGENT", "1", () =>
        withEnv("MU_WORKSTREAM", "auth", () =>
          withEnv("MU_AGENT_NAME", "orch", async () => {
            expect(armWait(db, [ref])).toEqual({ armed: true, caller: "auth/orch" });
          }),
        ),
      ),
    );
    expect(reg("auth/orch")?.refs).toHaveLength(1);
    expect(reg("pi:s")).toBeUndefined();
  });

  it("never throws: a ref that does not exist comes back as a warning, nothing stored", async () => {
    await withEnv("PI_SESSION_ID", "s", async () => {
      const r = armWait(db, [{ kind: "task", workstream: "auth", id: "ghost" }]);
      expect(r.armed).toBe(false);
      expect(r.warning).toMatch(/not armed.*committed/);
    });
    expect(reg("pi:s")).toBeUndefined();
  });
});

describe("send arms the run it started", () => {
  it("a delivered ctl send: the agent ref with the runs, incarnation and registry id measured BEFORE it", async () => {
    seedAgent();
    await serve("worker-1");
    const r = await as(SESSION, ["agent", "send", "worker-1", "go", "-w", "auth", "--json"]);
    expect(r.exitCode).toBeNull();
    const got = reg(CALLER);
    expect(got?.refs).toEqual([{ kind: "agent", workstream: "auth", id: "worker-1" }]);
    expect(Object.values(got?.baselines ?? {})).toEqual([
      { afterRuns: 3, incarnation: INC, agentId: agentIdOf("worker-1") },
    ]);
  });

  it("a repeated send keeps the EARLIEST fence of the same pi (the first run is still owed)", async () => {
    seedAgent();
    await serve("worker-1");
    await as(SESSION, ["agent", "send", "worker-1", "one", "-w", "auth", "--json"]);
    pi.runs = 4;
    await as(SESSION, ["agent", "send", "worker-1", "two", "-w", "auth", "--json"]);
    expect(Object.values(reg(CALLER)?.baselines ?? {})[0]?.afterRuns).toBe(3);
  });

  it("a replacement agent (new registry id) replaces the fence, never inherits the old one", async () => {
    seedAgent();
    await serve("worker-1");
    await as(SESSION, ["agent", "send", "worker-1", "one", "-w", "auth", "--json"]);
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    seedAgent();
    pi.runs = 9;
    await as(SESSION, ["agent", "send", "worker-1", "two", "-w", "auth", "--json"]);
    expect(Object.values(reg(CALLER)?.baselines ?? {})).toEqual([
      { afterRuns: 9, incarnation: INC, agentId: agentIdOf("worker-1") },
    ]);
  });

  it("a slash command starts no run: nothing armed", async () => {
    seedAgent();
    await serve("worker-1");
    const r = await as(SESSION, ["agent", "send", "worker-1", "/reload", "-w", "auth", "--json"]);
    expect(r.exitCode).toBeNull();
    expect(reg(CALLER)).toBeUndefined();
  });

  it("no identity: the send works and arms nothing", async () => {
    seedAgent();
    await serve("worker-1");
    const r = await as({}, ["agent", "send", "worker-1", "go", "-w", "auth", "--json"]);
    expect(r.exitCode).toBeNull();
    expect(readWaitRegistrationAny()).toBe(0);
  });

  it("--interrupt arms the run it started, fenced after the aborted one settled", async () => {
    seedAgent();
    pi.state = "busy";
    await serve("worker-1");
    const r = await as(SESSION, [
      "agent",
      "send",
      "worker-1",
      "--interrupt",
      "stop",
      "-w",
      "auth",
      "--json",
    ]);
    expect(r.exitCode).toBeNull();
    const b = Object.values(reg(CALLER)?.baselines ?? {})[0];
    expect(b).toMatchObject({ afterRuns: 4, incarnation: INC });
  });

  it("the hint is ONE executable `mu wait` on the same ref the registration holds", async () => {
    seedAgent();
    await serve("worker-1");
    const r = await as(SESSION, ["agent", "send", "worker-1", "go", "-w", "auth", "--json"]);
    const steps = (r.data as { nextSteps: { command: string }[] }).nextSteps;
    expect(steps.map((s) => s.command)).toEqual([`mu wait 'agent:auth/worker-1@3#${INC}'`]);
  });
});

function readWaitRegistrationAny(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM wait_registrations").get() as { n: number }).n;
}

describe("claim --for arms the task and its owner", () => {
  it("the task in ITS workstream and the owner agent from owner_id (cross-workstream)", async () => {
    seedAgent("worker-9", "other");
    seedTask("t1");
    const r = await as(SESSION, [
      "task",
      "claim",
      "t1",
      "--for",
      "other/worker-9",
      "-w",
      "auth",
      "--json",
    ]);
    expect(r.error).toBeUndefined();
    expect(reg(CALLER)?.refs).toEqual([
      { kind: "agent", workstream: "other", id: "worker-9" },
      { kind: "task", workstream: "auth", id: "t1" },
    ]);
  });

  it("--self (owner NULL) arms nothing: the caller would wait on its own work", async () => {
    seedTask("t2");
    const r = await as(SESSION, ["task", "claim", "t2", "--self", "-w", "auth", "--json"]);
    expect(r.error).toBeUndefined();
    expect(reg(CALLER)).toBeUndefined();
  });

  it("a worker's own claim arms nothing", async () => {
    seedAgent();
    seedTask("t3");
    const r = await as({ managed: "auth/worker-1" }, [
      "task",
      "claim",
      "t3",
      "-w",
      "auth",
      "--json",
    ]);
    expect(r.error).toBeUndefined();
    expect(readWaitRegistrationAny()).toBe(0);
  });

  it("a managed orchestrator that dispatches to ITSELF is not armed on its own agent", async () => {
    seedAgent("orch");
    seedTask("t4");
    await as({ managed: "auth/orch" }, [
      "task",
      "claim",
      "t4",
      "--for",
      "orch",
      "-w",
      "auth",
      "--json",
    ]);
    expect(reg("auth/orch")?.refs).toEqual([{ kind: "task", workstream: "auth", id: "t4" }]);
  });
});

describe("spawn --send arms the ACTUAL agent", () => {
  /** A pane creation starts the stand-in extension for the agent it names. */
  function installPanes(): void {
    mux.restore();
    const fake = mockTmux(freshMockState()).executor;
    mux = installMux("tmux", async (args) => {
      const res = await fake(args);
      if (args[0] === "new-session" || args[0] === "new-window" || args[0] === "split-window") {
        const name = /MU_AGENT_NAME=(\S+)/.exec(args.join(" "))?.[1];
        if (name !== undefined) await serve(name);
      }
      return res;
    });
  }

  it("--next-free renamed it: the registration and the hint name the returned agent", async () => {
    seedAgent("worker-1");
    installPanes();
    db.close();
    let r: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("PI_SESSION_ID", "sess-1", async () => {
      r = await runCliJson(
        ["agent", "spawn", "worker-1", "-w", "auth", "--next-free", "--send", "hi", "--json"],
        dbPath,
      );
    });
    db = openDb({ path: dbPath });
    expect(r?.exitCode ?? 0).toBe(0);
    expect(reg(CALLER)?.refs).toEqual([{ kind: "agent", workstream: "auth", id: "worker-2" }]);
    const steps = ((r as NonNullable<typeof r>).data as { nextSteps: { command: string }[] })
      .nextSteps;
    expect(steps[0]?.command).toBe(`mu wait 'agent:auth/worker-2@3#${INC}'`);
  });

  it("without --send nothing is owed yet", async () => {
    installPanes();
    db.close();
    await withEnv("PI_SESSION_ID", "sess-1", async () => {
      await runCliJson(["agent", "spawn", "worker-1", "-w", "auth", "--json"], dbPath);
    });
    db = openDb({ path: dbPath });
    expect(reg(CALLER)).toBeUndefined();
  });

  it("--task arms the task AND the agent from the receipt; a replay arms the same refs again", async () => {
    seedTask("t5");
    installPanes();
    db.close();
    const run = async () => {
      let out: Awaited<ReturnType<typeof runCliJson>> | undefined;
      await withEnv("PI_SESSION_ID", "sess-1", async () => {
        out = await runCliJson(
          ["agent", "spawn", "worker-1", "-w", "auth", "--task", "t5", "--send", "do t5", "--json"],
          dbPath,
        );
      });
      return out;
    };
    const first = await run();
    expect(first?.exitCode ?? 0).toBe(0);
    db = openDb({ path: dbPath });
    expect(reg(CALLER)?.refs).toEqual([
      { kind: "agent", workstream: "auth", id: "worker-1" },
      { kind: "task", workstream: "auth", id: "t5" },
    ]);
    const before = reg(CALLER)?.baselines;
    db.close();
    const again = await run();
    db = openDb({ path: dbPath });
    expect(
      ((again as NonNullable<typeof again>).data as { task: { replay: boolean } }).task.replay,
    ).toBe(true);
    expect(reg(CALLER)?.refs).toHaveLength(2);
    expect(reg(CALLER)?.baselines).toEqual(before);
  });
});

/** A mux whose panes are exactly the registered agents' (a wait reconciles first: no ghost, no death). */
function liveMux(): void {
  mux.restore();
  mux = installMux("tmux", async (args) => {
    if (args[0] === "list-panes") {
      const rows = db.prepare("SELECT pane_id FROM agents").all() as { pane_id: string }[];
      return {
        stdout: rows.map((r) => `${r.pane_id}\tworking\t1000`).join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

describe("send --wait / claim --and-wait", () => {
  beforeEach(liveMux);

  it("send --wait: ONE document: the wait's result with the send's receipt as data.sent", async () => {
    seedAgent();
    await serve("worker-1");
    const r = await as(SESSION, ["agent", "send", "worker-1", "go", "--wait", "-w", "auth"]);
    expect(r.exitCode).toBeNull();
    const d = r.data as {
      firing: { kind: string; ref: string };
      exit: number;
      sent: { agentName: string; runs: number; incarnation: string; delivered: boolean };
      snapshots: { lastText?: string }[];
    };
    expect(d.firing).toMatchObject({ kind: "settled", ref: "agent:auth/worker-1" });
    expect(d.sent).toMatchObject({
      agentName: "worker-1",
      runs: 3,
      incarnation: INC,
      delivered: true,
    });
    expect(d.snapshots[0]?.lastText).toBe("the answer");
    // delivered by the wait: nothing left owed
    expect(reg(CALLER)?.refs).toEqual([]);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("send --wait on a slash command is refused before anything is sent (one JSON error)", async () => {
    seedAgent();
    await serve("worker-1");
    const r = await as(SESSION, ["agent", "send", "worker-1", "/reload", "--wait", "-w", "auth"]);
    expect(r.exitCode).toBe(2);
    expect(r.doc).toMatchObject({ ok: false, error: "UsageError" });
    expect(pi.ops).toEqual([]);
  });

  it("claim --and-wait: waits for the task; data.claimed is the claim", async () => {
    seedAgent();
    seedTask("t6");
    // the poll sleep closes the task, as the worker would
    setWaitSleepForTests(async () => {
      // `as` closed the test's handle: the worker closes the task through its own connection.
      const w = openDb({ path: dbPath });
      try {
        closeTask(w, "t6", { workstream: "auth", evidence: "done" });
      } catch {
        // already closed by an earlier poll
      } finally {
        w.close();
      }
    });
    await serve("worker-1");
    const r = await as(SESSION, [
      "task",
      "claim",
      "t6",
      "--for",
      "worker-1",
      "--and-wait",
      "-w",
      "auth",
    ]);
    expect(r.exitCode).toBeNull();
    const d = r.data as {
      firing: { kind: string; ref: string };
      claimed: { task: string; ownerName: string };
    };
    expect(d.firing).toMatchObject({ kind: "closed", ref: "task:auth/t6" });
    expect(d.claimed).toMatchObject({ task: "t6", ownerName: "worker-1" });
  });

  it("claim --and-wait without --for is a usage error, and nothing is claimed", async () => {
    seedTask("t7");
    const r = await as(SESSION, ["task", "claim", "t7", "--self", "--and-wait", "-w", "auth"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("--for");
    expect(
      (db.prepare("SELECT status FROM tasks WHERE local_id = 't7'").get() as { status: string })
        .status,
    ).toBe("OPEN");
  });

  it("the JSON default covers the two entry verbs and nothing else", () => {
    const argv = (...a: string[]) => ["node", "mu", ...a];
    expect(isWaitVerbArgv(argv("agent", "send", "w", "x", "--wait"))).toBe(true);
    expect(isWaitVerbArgv(argv("task", "claim", "t", "--for", "w", "--and-wait"))).toBe(true);
    expect(isWaitVerbArgv(argv("agent", "send", "w", "x"))).toBe(false);
    expect(isWaitVerbArgv(argv("task", "claim", "t", "--for", "w"))).toBe(false);
    expect(isWaitVerbArgv(argv("agent", "wait", "w", "--wait"))).toBe(false);
  });
});

describe("df1_wait_stale_dead: a deliberate close of a finished worker is not a death", () => {
  const closeTaskAs = (id: string): void => {
    closeTask(db, id, { workstream: "auth", evidence: "done" });
  };
  /** Wait on `t2` (still open) for a moment: the only thing that can end it early is a false event. */
  const waitOpen = () => as(SESSION, ["task", "wait", "t2", "-w", "auth", "--timeout", "0.3"]);
  /** `mu agent close` as the orchestrator runs it: the preview names the revision, then the apply. */
  async function closeWorker(): Promise<void> {
    const p = await as(SESSION, ["agent", "close", "worker-1", "-w", "auth", "--json"]);
    const rev = (p.data as { revision: number }).revision;
    const done = await as(SESSION, [
      "agent",
      "close",
      "worker-1",
      "-w",
      "auth",
      "--if",
      String(rev),
      "--json",
    ]);
    expect(done.exitCode).toBeNull();
    expect(done.data).toMatchObject({ deletedRow: true });
  }
  /** Dispatch t1 to worker-1, let it finish, and have the orchestrator take the close (a delivered wait). */
  async function dispatchAndFinish(armBySend: boolean): Promise<void> {
    liveMux();
    seedAgent();
    seedTask("t1");
    seedTask("t2");
    await serve("worker-1");
    if (armBySend) await as(SESSION, ["agent", "send", "worker-1", "go", "-w", "auth", "--json"]);
    await as(SESSION, ["task", "claim", "t1", "--for", "worker-1", "-w", "auth", "--json"]);
    closeTaskAs("t1");
    const first = await as(SESSION, ["task", "wait", "t1", "-w", "auth"]);
    expect(first.data).toMatchObject({ firing: { kind: "closed", ref: "task:auth/t1" } });
  }

  it("claim --for, task CLOSED and delivered, agent close, wait on another OPEN task: no dead event", async () => {
    await dispatchAndFinish(false);
    await closeWorker();
    const r = await waitOpen();
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ exit: 0, timedOut: true, firing: { kind: "heartbeat" } });
    expect(reg(CALLER)?.refs.some((x) => x.kind === "agent")).toBe(false);
  });

  it("provenance-registered worker (the caller spawned it, it claimed its own task), same flow: no dead event", async () => {
    liveMux();
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%worker-1",
      cli: "pi",
      spawner: CALLER,
    });
    seedTask("t1");
    seedTask("t2");
    await serve("worker-1");
    await as({ managed: "auth/worker-1" }, ["task", "claim", "t1", "-w", "auth", "--json"]);
    // a wait registers the spawned worker and its task by provenance, then delivers the close
    const t1 = await as(SESSION, ["wait", "-w", "auth", "--timeout", "0.3"]);
    expect(reg(CALLER)?.refs.some((x) => x.kind === "agent")).toBe(true);
    closeTaskAs("t1");
    const first = await as(SESSION, ["wait", "-w", "auth"]);
    expect(first.data).toMatchObject({ firing: { kind: "closed", ref: "task:auth/t1" } });
    expect(t1.exitCode).toBeNull();
    await closeWorker();
    const r = await waitOpen();
    expect((r.data as { firing: { kind: string } }).firing.kind).not.toBe("dead");
    expect(r.data).toMatchObject({ exit: 0, timedOut: true });
  });

  it("send-armed worker (agent ref + fence), same flow: no dead event, the fence is dropped with the ref", async () => {
    await dispatchAndFinish(true);
    await closeWorker();
    const r = await waitOpen();
    expect((r.data as { firing: { kind: string } }).firing.kind).not.toBe("dead");
    expect(r.data).toMatchObject({ exit: 0, timedOut: true });
    expect(reg(CALLER)?.baselines).toEqual({});
  });

  it("another caller's registration for the closed agent is dropped by ITS next wait, not reported", async () => {
    await dispatchAndFinish(false);
    await as({ pi: "other" }, ["agent", "send", "worker-1", "hi", "-w", "auth", "--json"]);
    expect(reg("pi:other")?.refs).toHaveLength(1);
    await closeWorker();
    const r = await as({ pi: "other" }, ["task", "wait", "t2", "-w", "auth", "--timeout", "0.3"]);
    expect(r.data).toMatchObject({ exit: 0, timedOut: true });
    expect(reg("pi:other")?.refs).toEqual([]);
  });

  it("closing a worker that still holds an UNFINISHED task: the task is reported dead (the work is not done)", async () => {
    liveMux();
    seedAgent();
    seedTask("t2");
    await serve("worker-1");
    await as(SESSION, ["task", "claim", "t2", "--for", "worker-1", "-w", "auth", "--json"]);
    await closeWorker();
    const r = await waitOpen();
    expect(r.exitCode).toBe(6);
    expect(r.data).toMatchObject({ firing: { kind: "dead" } });
    // the task it left unfinished is among the dead snapshots, so the loop can recover it
    const snaps = (r.data as { snapshots: { ref: string; dead: boolean }[] }).snapshots;
    expect(snaps.some((x) => x.ref === "task:auth/t2")).toBe(true);
  });

  it("a worker that DIES (row pruned, no agent close) still fires dead for its agent ref; the reason does not claim unfinished work", async () => {
    liveMux();
    seedAgent();
    seedTask("t2");
    await serve("worker-1");
    await as(SESSION, ["agent", "send", "worker-1", "go", "-w", "auth", "--json"]);
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    const r = await waitOpen();
    expect(r.exitCode).toBe(6);
    expect(r.data).toMatchObject({ firing: { kind: "dead", ref: "agent:auth/worker-1" } });
    expect((r.data as { reason: string }).reason).not.toMatch(/work is not done/);
  });
});

describe("owed vs done: an agent ref is owed only while it owns open work or an unsettled run", () => {
  beforeEach(liveMux);

  /** The reviewer's sequence: claim --for + send, the task closes, a wait delivers it, `agent close`, then more work. */
  async function finishedThenClosed(): Promise<void> {
    seedAgent("worker-1");
    seedAgent("worker-2");
    seedTask("t1");
    seedTask("t2");
    await serve("worker-1");
    await serve("worker-2");
    await as(SESSION, ["task", "claim", "t1", "--for", "worker-1", "-w", "auth", "--json"]);
    await as(SESSION, ["agent", "send", "worker-1", "do t1", "-w", "auth", "--json"]);
    closeTask(db, "t1", { workstream: "auth", evidence: "done" });
    const first = await as(SESSION, ["wait", "-w", "auth", "--timeout", "2"]);
    expect(first.data).toMatchObject({ exit: 0, firing: { kind: "closed", ref: "task:auth/t1" } });
    // the first-mode wait delivered only the task: the agent ref is still registered
    expect(reg(CALLER)?.refs.some((x) => x.kind === "agent")).toBe(true);
    const p = await as(SESSION, ["agent", "close", "worker-1", "-w", "auth", "--json"]);
    const rev = (p.data as { revision: number }).revision;
    await as(SESSION, ["agent", "close", "worker-1", "-w", "auth", "--if", String(rev), "--json"]);
    await as(SESSION, ["task", "claim", "t2", "--for", "worker-2", "-w", "auth", "--json"]);
    closeTask(db, "t2", { workstream: "auth", evidence: "done" });
  }

  it("a bare wait after the close returns the real event, exit 0", async () => {
    await finishedThenClosed();
    const r = await as(SESSION, ["wait", "-w", "auth", "--timeout", "2"]);
    expect(r.data).toMatchObject({ exit: 0, firing: { kind: "closed", ref: "task:auth/t2" } });
    expect((r.data as { reason: string }).reason).not.toMatch(/gone|not done/);
  });

  it("an explicit task wait after the close returns the real event, exit 0", async () => {
    await finishedThenClosed();
    const r = await as(SESSION, ["wait", "task:auth/t2", "-w", "auth", "--timeout", "2"]);
    expect(r.data).toMatchObject({ exit: 0, firing: { kind: "closed", ref: "task:auth/t2" } });
  });

  it("send --wait to another worker after the close returns settled, exit 0", async () => {
    await finishedThenClosed();
    const r = await as(SESSION, ["agent", "send", "worker-2", "go", "--wait", "-w", "auth"]);
    expect(r.data).toMatchObject({
      exit: 0,
      firing: { kind: "settled", ref: "agent:auth/worker-2" },
    });
  });

  it("a pane lost MID-RUN (seen busy, row gone, no agent close) is dead, exit 6", async () => {
    seedAgent("worker-1");
    seedTask("t2");
    pi.state = "busy";
    await serve("worker-1");
    await as(SESSION, ["agent", "send", "worker-1", "go", "-w", "auth", "--json"]);
    pi.real = true; // the run never settles: a wait holds on it
    // a wait sees it working, then the pane dies
    const seen = await as(SESSION, ["wait", "-w", "auth", "--timeout", "0.3"]);
    expect(seen.data).toMatchObject({ exit: 0, timedOut: true });
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    const r = await as(SESSION, ["task", "wait", "t2", "-w", "auth", "--timeout", "0.3"]);
    expect(r.exitCode).toBe(6);
    expect(r.data).toMatchObject({ firing: { kind: "dead", ref: "agent:auth/worker-1" } });
  });

  it("agent close while its run is still going is NOT the end of the work: dead", async () => {
    seedAgent("worker-1");
    seedTask("t2");
    pi.state = "busy";
    await serve("worker-1");
    await as(SESSION, ["agent", "send", "worker-1", "go", "-w", "auth", "--json"]);
    const p = await as(SESSION, ["agent", "close", "worker-1", "-w", "auth", "--json"]);
    const rev = (p.data as { revision: number }).revision;
    await as(SESSION, ["agent", "close", "worker-1", "-w", "auth", "--if", String(rev), "--json"]);
    const r = await as(SESSION, ["task", "wait", "t2", "-w", "auth", "--timeout", "0.3"]);
    expect(r.exitCode).toBe(6);
    expect(r.data).toMatchObject({ firing: { kind: "dead", ref: "agent:auth/worker-1" } });
  });

  it("agent close with NO wait in between still ends the work (the close itself marks)", async () => {
    seedAgent("worker-1");
    seedTask("t1");
    seedTask("t2");
    await serve("worker-1");
    await as(SESSION, ["task", "claim", "t1", "--for", "worker-1", "-w", "auth", "--json"]);
    closeTask(db, "t1", { workstream: "auth", evidence: "done" });
    const p = await as(SESSION, ["agent", "close", "worker-1", "-w", "auth", "--json"]);
    const rev = (p.data as { revision: number }).revision;
    await as(SESSION, ["agent", "close", "worker-1", "-w", "auth", "--if", String(rev), "--json"]);
    const r = await as(SESSION, ["task", "wait", "t2", "-w", "auth", "--timeout", "0.3"]);
    // the undelivered close of t1 is the news; the closed agent is not
    expect(r.data).toMatchObject({ exit: 0, firing: { kind: "closed", ref: "task:auth/t1" } });
  });

  it("a pane that dies AFTER the work finished (no agent close) is not dead either: the wait saw it done", async () => {
    seedAgent("worker-1");
    seedTask("t1");
    seedTask("t2");
    await serve("worker-1");
    await as(SESSION, ["task", "claim", "t1", "--for", "worker-1", "-w", "auth", "--json"]);
    closeTask(db, "t1", { workstream: "auth", evidence: "done" });
    await as(SESSION, ["wait", "-w", "auth", "--timeout", "2"]);
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    const r = await as(SESSION, ["task", "wait", "t2", "-w", "auth", "--timeout", "0.3"]);
    console.log(JSON.stringify(r.data).slice(0, 600));
    expect(r.data).toMatchObject({ exit: 0, timedOut: true });
    expect(reg(CALLER)?.refs.some((x) => x.kind === "agent")).toBe(false);
  });

  it("an idle agent that still owns an OPEN task is owed, whatever else it finished: its pane dying is dead", async () => {
    seedAgent("worker-1");
    seedTask("t1");
    seedTask("t2");
    await serve("worker-1");
    await as(SESSION, ["task", "claim", "t1", "--for", "worker-1", "-w", "auth", "--json"]);
    closeTask(db, "t1", { workstream: "auth", evidence: "done" });
    await as(SESSION, ["task", "claim", "t2", "--for", "worker-1", "-w", "auth", "--json"]);
    const seen = await as(SESSION, ["wait", "-w", "auth", "--timeout", "0.5"]);
    expect(seen.data).toMatchObject({ firing: { kind: "closed", ref: "task:auth/t1" } });
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    const r = await as(SESSION, ["wait", "-w", "auth", "--timeout", "0.5"]);
    expect(r.exitCode).toBe(6);
  });

  it("new work (a send) for a finished agent owes again: dead if its pane then dies", async () => {
    seedAgent("worker-1");
    seedTask("t1");
    seedTask("t2");
    await serve("worker-1");
    await as(SESSION, ["task", "claim", "t1", "--for", "worker-1", "-w", "auth", "--json"]);
    closeTask(db, "t1", { workstream: "auth", evidence: "done" });
    await as(SESSION, ["wait", "-w", "auth", "--timeout", "2"]);
    pi.real = true;
    await as(SESSION, ["agent", "send", "worker-1", "more", "-w", "auth", "--json"]);
    pi.runs = 3; // the run it started never counted: it is still unsettled when the pane dies
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    const r = await as(SESSION, ["task", "wait", "t2", "-w", "auth", "--timeout", "0.3"]);
    expect(r.exitCode).toBe(6);
    expect(r.data).toMatchObject({ firing: { kind: "dead", ref: "agent:auth/worker-1" } });
  });
});

describe("arming guards", () => {
  /** A pane creation starts the stand-in extension for the agent it names. */
  function installPanes(): void {
    mux.restore();
    const fake = mockTmux(freshMockState()).executor;
    mux = installMux("tmux", async (args) => {
      const res = await fake(args);
      if (args[0] === "new-session" || args[0] === "new-window" || args[0] === "split-window") {
        const name = /MU_AGENT_NAME=(\S+)/.exec(args.join(" "))?.[1];
        if (name !== undefined) await serve(name);
      }
      return res;
    });
  }
  const spawnTask = (id: string) =>
    as(SESSION, [
      "agent",
      "spawn",
      "worker-1",
      "-w",
      "auth",
      "--task",
      id,
      "--send",
      `do ${id}`,
      "--json",
    ]);

  it("a replay whose agent was REPLACED arms nothing (never a replacement under the old receipt)", async () => {
    seedTask("t5");
    installPanes();
    await spawnTask("t5");
    expect(reg(CALLER)?.refs).toHaveLength(2);
    db.prepare("DELETE FROM wait_registrations").run();
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    seedAgent("worker-1");
    const again = await spawnTask("t5");
    expect(again.data).toMatchObject({ task: { replay: true, stale: "replaced" } });
    expect(reg(CALLER)).toBeUndefined();
  });

  it("a replay whose agent was DELETED arms nothing", async () => {
    seedTask("t5");
    installPanes();
    await spawnTask("t5");
    db.prepare("DELETE FROM wait_registrations").run();
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    const again = await spawnTask("t5");
    expect(again.data).toMatchObject({ task: { replay: true, stale: "deleted" } });
    expect(reg(CALLER)).toBeUndefined();
  });

  it("a delivery-UNKNOWN attempt arms the task only: the prompt may be running, nothing is fenced", async () => {
    seedTask("t5");
    installPanes();
    pi.dropSend = true;
    const r = await spawnTask("t5");
    expect(r.exitCode).toBe(1);
    expect(reg(CALLER)?.refs).toEqual([{ kind: "task", workstream: "auth", id: "t5" }]);
    expect(reg(CALLER)?.baselines).toEqual({});
  });

  it("send --wait on a run that settles DURING the send returns settled (the fence is the send's run count)", async () => {
    liveMux();
    seedAgent();
    pi.real = true;
    await serve("worker-1");
    const r = await as({}, ["agent", "send", "worker-1", "go", "--wait", "-w", "auth"]);
    expect(r.data).toMatchObject({
      exit: 0,
      firing: { kind: "settled", ref: "agent:auth/worker-1" },
    });
    expect(pi.ops).toContain("wait");
  }, 15_000);
});
