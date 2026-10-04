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
  abortAgent,
  insertAgent,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let servers: Server[];
let ops: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mab-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  servers = [];
  ops = [];
});

afterEach(async () => {
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
): Promise<void> {
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
        const req = JSON.parse(line) as { op: string; afterRuns?: number; timeoutMs?: number };
        ops.push(req.op);
        const status = { state, since: 0, runs, pending: false };
        if (req.op === "status") sock.end(encode({ v: 1, ok: true, ...status }));
        else if (req.op === "abort") {
          sock.end(encode({ v: 1, ok: true, state }));
          if (settles) {
            state = afterAbort;
            runs++;
          }
        } else if (req.op === "wait") {
          if (runs > (req.afterRuns ?? runs) && (state === "idle" || afterAbort === "busy")) {
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

  it("idle: sends no abort and is settled", async () => {
    seed("worker-1");
    await serve("worker-1", "idle");
    const r = await abortAgent(db, "worker-1", { workstream: "auth" });
    expect(ops).toEqual(["status"]);
    expect(r).toMatchObject({ before: "idle", after: "idle", settled: true, aborted: false });
  });

  it("never settles: timeout error with a kick next step", async () => {
    seed("worker-1");
    await serve("worker-1", "busy", false);
    const err = await abortAgent(db, "worker-1", { workstream: "auth", timeoutMs: 200 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentAbortTimeoutError);
    const steps = (err as AgentAbortTimeoutError).errorNextSteps().map((s) => s.command);
    expect(steps).toContain("mu agent kick worker-1 -w auth");
  });

  it("no socket: AgentCtlUnreachableError naming mu agent kick", async () => {
    seed("worker-1");
    const err = await abortAgent(db, "worker-1", { workstream: "auth" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCtlUnreachableError);
    expect((err as AgentCtlUnreachableError).kind).toBe("missing");
    const steps = (err as AgentCtlUnreachableError).errorNextSteps().map((s) => s.command);
    expect(steps).toContain("mu agent kick worker-1 -w auth");
    const intents = (err as AgentCtlUnreachableError).errorNextSteps().map((s) => s.intent);
    expect(intents.join("\n")).toMatch(/trust prompt/);
    expect(steps.join("\n")).toMatch(/\/trust/);
    expect(steps.join("\n")).toMatch(/--approve/);
  });

  it("custom cli key running pi (its socket answers): aborts through ctl", async () => {
    seed("rv1-alias", "helper");
    await serve("rv1-alias", "busy");
    const r = await abortAgent(db, "rv1-alias", { workstream: "auth" });
    expect(ops).toEqual(["status", "abort", "wait"]);
    expect(r).toMatchObject({ aborted: true, settled: true });
  });

  it("non-pi agent: typed error pointing at kick, nothing sent", async () => {
    seed("worker-1", "claude");
    const err = await abortAgent(db, "worker-1", { workstream: "auth" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentAbortNeedsCtlError);
    expect((err as Error).message).toContain("mu agent kick");
    expect(ops).toEqual([]);
  });
});

describe("mu agent abort (CLI)", () => {
  it("exit 0 with --json result", async () => {
    seed("worker-1");
    await serve("worker-1", "busy");
    const r = await runCli(["agent", "abort", "worker-1", "-w", "auth", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(JSON.parse(r.stdout)).toMatchObject({ before: "busy", after: "idle", aborted: true });
  });

  it("an abort that reported idle drops the read-the-pane hint", async () => {
    seed("worker-1");
    await serve("worker-1", "busy");
    const r = await runCli(["agent", "abort", "worker-1", "-w", "auth", "--json"], dbPath);
    const body = JSON.parse(r.stdout) as { after: string; nextSteps: Array<{ command: string }> };
    expect(body.after).toBe("idle");
    expect(body.nextSteps.some((s) => s.command.startsWith("mu agent read"))).toBe(false);
  });

  it("an abort that ends busy (a queued run started) keeps the read-the-pane hint", async () => {
    seed("worker-1");
    await serve("worker-1", "busy", true, "busy");
    const r = await runCli(["agent", "abort", "worker-1", "-w", "auth", "--json"], dbPath);
    const body = JSON.parse(r.stdout) as { after: string; nextSteps: Array<{ command: string }> };
    expect(body.after).toBe("busy");
    expect(body.nextSteps.map((s) => s.command)).toContain("mu agent read worker-1 -n 30 -w auth");
  });

  it("exit 5 on timeout", async () => {
    seed("worker-1");
    await serve("worker-1", "busy", false);
    const r = await runCli(
      ["agent", "abort", "worker-1", "-w", "auth", "--timeout", "0.2", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("mu agent kick worker-1");
  });

  it("exit 2 for a non-pi agent", async () => {
    seed("worker-1", "claude");
    const r = await runCli(["agent", "abort", "worker-1", "-w", "auth"], dbPath);
    expect(r.exitCode).toBe(2);
  });
});
