// abortAgent: status → abort → wait through the control socket. A real
// unix-socket server at the derived path stands in for the mu pi extension.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentAbortNeedsCtlError,
  AgentAbortTimeoutError,
  AgentCtlUnreachableError,
  AgentRestartedError,
  abortAgent,
  insertAgent,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, INCARNATION_MISMATCH, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let servers: Server[];
let waitReqs: { op: string; incarnation?: string }[];
let ops: string[];
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mab-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  servers = [];
  ops = [];
  waitReqs = [];
  // The pane is alive: a silent socket is then "unreachable", not "dead".
  mux = installMux("tmux", async () => ({ stdout: "%1\n", stderr: "", exitCode: 0 }));
});

afterEach(async () => {
  mux.restore();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Fake extension. `settles` decides whether an abort makes the run settle;
 * a wait with no settle times out after its own timeoutMs like the real one.
 */
async function serve(
  agent: string,
  initial: "busy" | "idle",
  settles = true,
  afterAbort: "busy" | "idle" = "idle",
  abortWasBusy?: boolean,
  /** The incarnation the fake reports; `restartAfterAbort` swaps it when the abort lands. */
  restartAfterAbort?: string,
): Promise<void> {
  let inc = "inc-abort-1";
  let state = initial;
  let runs = 3;
  const path = ctlSocketPath("auth", agent, dir);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as {
          op: string;
          afterRuns?: number;
          timeoutMs?: number;
          incarnation?: string;
        };
        ops.push(req.op);
        waitReqs.push(req);
        const status = { incarnation: inc, state, since: 0, runs, pending: false };
        if (req.op === "status") sock.end(encode({ v: 1, ok: true, ...status }));
        else if (req.op === "abort") {
          sock.end(
            encode({
              v: 1,
              ok: true,
              state,
              ...(abortWasBusy !== undefined ? { wasBusy: abortWasBusy } : {}),
            }),
          );
          if (settles) {
            state = afterAbort;
            runs++;
          }
          if (restartAfterAbort !== undefined) inc = restartAfterAbort;
        } else if (req.op === "wait") {
          if (req.incarnation !== undefined && req.incarnation !== inc) {
            sock.end(encode({ v: 1, ok: false, error: INCARNATION_MISMATCH, incarnation: inc }));
          } else if (
            runs > (req.afterRuns ?? runs) &&
            (state === "idle" || afterAbort === "busy")
          ) {
            sock.end(encode({ v: 1, ok: true, ...status }));
          } else {
            setTimeout(
              () => sock.end(encode({ v: 1, ok: false, error: "timeout" })),
              req.timeoutMs ?? 0,
            );
          }
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

function seed(name: string, cli = "pi"): void {
  insertAgent(db, { name, workstream: "auth", paneId: "%1", cli });
}

describe("abortAgent", () => {
  it("busy: sends status, abort, wait in order and returns settled idle", async () => {
    seed("worker-1");
    await serve("worker-1", "busy");
    const r = await abortAgent(db, "worker-1", { workstream: "auth" });
    expect(ops).toEqual(["status", "abort", "wait"]);
    expect(r).toMatchObject({ before: "busy", after: "idle", settled: true, aborted: true });
  });

  it("the abort's own wait carries the incarnation its status named", async () => {
    seed("worker-1");
    await serve("worker-1", "busy");
    await abortAgent(db, "worker-1", { workstream: "auth" });
    expect(waitReqs.find((r) => r.op === "wait")).toMatchObject({ incarnation: "inc-abort-1" });
  });

  it("pi restarted between the abort and its wait: AgentRestartedError, not a false 'settled'", async () => {
    seed("worker-1");
    await serve("worker-1", "busy", true, "idle", undefined, "inc-abort-2");
    const err = await abortAgent(db, "worker-1", { workstream: "auth" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRestartedError);
    expect((err as Error).message).toContain("inc-abort-1 → inc-abort-2");
  });

  const abortRows = () =>
    db.prepare("SELECT actor, payload FROM ops WHERE intent = 'agent.abort'").all();

  it("busy abort logs agent.abort attributed to $MU_AGENT_NAME; idle logs nothing", async () => {
    process.env.MU_AGENT_NAME = "orch-1";
    try {
      seed("worker-1");
      seed("worker-2");
      await serve("worker-1", "busy");
      await abortAgent(db, "worker-1", { workstream: "auth" });
      expect(abortRows()).toEqual([
        { actor: "orch-1", payload: "agent abort worker-1 (state=busy, pending=false)" },
      ]);
      await serve("worker-2", "idle");
      await abortAgent(db, "worker-2", { workstream: "auth" });
      expect(abortRows()).toHaveLength(1);
    } finally {
      delete process.env.MU_AGENT_NAME;
    }
  });

  it("settled between status and abort (wasBusy=false): no agent.abort row", async () => {
    seed("worker-1");
    await serve("worker-1", "busy", true, "idle", false);
    const r = await abortAgent(db, "worker-1", { workstream: "auth" });
    expect(r.aborted).toBe(false);
    expect(abortRows()).toEqual([]);
  });

  it("idle: sends no abort and is settled", async () => {
    seed("worker-1");
    await serve("worker-1", "idle");
    const r = await abortAgent(db, "worker-1", { workstream: "auth" });
    expect(ops).toEqual(["status"]);
    expect(r).toMatchObject({ before: "idle", after: "idle", settled: true, aborted: false });
  });

  it("never settles: timeout error", async () => {
    seed("worker-1");
    await serve("worker-1", "busy", false);
    const err = await abortAgent(db, "worker-1", { workstream: "auth", timeoutMs: 200 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentAbortTimeoutError);
  });

  it("no socket: AgentCtlUnreachableError (missing)", async () => {
    seed("worker-1");
    const err = await abortAgent(db, "worker-1", { workstream: "auth" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCtlUnreachableError);
    expect((err as AgentCtlUnreachableError).kind).toBe("missing");
  });

  it("custom cli key running pi (its socket answers): aborts through ctl", async () => {
    seed("rv1-alias", "helper");
    await serve("rv1-alias", "busy");
    const r = await abortAgent(db, "rv1-alias", { workstream: "auth" });
    expect(ops).toEqual(["status", "abort", "wait"]);
    expect(r).toMatchObject({ aborted: true, settled: true });
  });

  it("non-pi agent: typed error pointing at close, nothing sent", async () => {
    seed("worker-1", "claude");
    const err = await abortAgent(db, "worker-1", { workstream: "auth" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentAbortNeedsCtlError);
    expect((err as Error).message).toContain("close the agent");
    expect(ops).toEqual([]);
  });
});

describe("mu agent abort (CLI)", () => {
  it("exit 0 with --json result", async () => {
    seed("worker-1");
    await serve("worker-1", "busy");
    const r = await runCliJson(["agent", "abort", "worker-1", "-w", "auth", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ before: "busy", after: "idle", aborted: true });
  });

  it("an abort is never hinted at a read: next is null either way", async () => {
    seed("worker-1");
    await serve("worker-1", "busy");
    const r = await runCliJson(["agent", "abort", "worker-1", "-w", "auth", "--json"], dbPath);
    expect(r.data).toMatchObject({ after: "idle" });
    expect(r.doc.next).toBeNull();
  });

  it("exit 5 on timeout", async () => {
    seed("worker-1");
    await serve("worker-1", "busy", false);
    const r = await runCliJson(
      ["agent", "abort", "worker-1", "-w", "auth", "--timeout", "0.2", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(5);
    expect(r.doc).toMatchObject({ error: "AgentAbortTimeoutError", next: null });
  });

  it("exit 2 for a non-pi agent", async () => {
    seed("worker-1", "claude");
    const r = await runCli(["agent", "abort", "worker-1", "-w", "auth"], dbPath);
    expect(r.exitCode).toBe(2);
  });
});
