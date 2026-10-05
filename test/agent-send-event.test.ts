// `mu agent send` records an `agent.send` op (mode, transport, and pi's
// pre-send state), so a drift audit can tell whether a note on a running
// task reached its owner and whether the owner was stuck in a long turn.
// A real unix-socket server stands in for the mu pi extension.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { renderOp } from "../src/log-render.js";
import { listLogs } from "../src/logs.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const SINCE = Date.parse("2026-10-05T06:00:00.000Z");
let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mse-"));
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

/** Stand-in extension: busy since SINCE at runs 3; every op succeeds. */
async function serve(): Promise<void> {
  const path = ctlSocketPath("auth", "worker-1", dir);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string };
        const status = { state: "busy", since: SINCE, runs: 3, pending: false };
        const extra = req.op === "interrupt" ? { wasBusy: true } : {};
        sock.end(encode({ v: 1, ok: true, ...status, ...extra }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

function sendOps() {
  return listLogs(db, { workstream: "auth", intent: "agent.send" });
}

describe("agent.send op", () => {
  it.each([
    [[], "mode=plain transport=ctl state=busy since=2026-10-05T06:00:00.000Z"],
    [["--steer"], "mode=steer transport=ctl state=busy since=2026-10-05T06:00:00.000Z"],
    [["--interrupt"], "mode=interrupt transport=ctl wasBusy=true"],
    [["--fresh"], "mode=fresh transport=ctl"],
  ])("%j: one op naming mode, transport and pi's state", async (flags, detail) => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
    await serve();
    const r = await runCli(["agent", "send", "worker-1", ...flags, "go", "-w", "auth"], dbPath);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBeNull();
    const ops = sendOps();
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op?.kind).toBe("agent");
    expect(op?.payload).toContain(detail);
    expect(op && renderOp(op)).toMatchObject({ verb: "agent send", subject: "worker-1" });
  });

  it("mux paste (non-pi): mode=plain transport=mux, no state", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "claude" });
    const r = await runCli(["agent", "send", "worker-1", "go", "-w", "auth"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(sendOps().map((o) => o.payload)).toEqual([
      "agent send worker-1 (mode=plain transport=mux, 2 bytes)",
    ]);
  });

  it("a failed send records nothing", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
    const r = await runCli(["agent", "send", "worker-1", "go", "-w", "auth"], dbPath);
    expect(r.exitCode).not.toBeNull();
    expect(sendOps()).toEqual([]);
  });
});
