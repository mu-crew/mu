// `mu agent check <agent> <msgId>`: one status{msgId} probe after an
// ambiguous send. accepted (0) / not-accepted (3) / unreachable (1).
// A real unix-socket server stands in for the mu pi extension.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkMessage, insertAgent } from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { INC } from "./_ctl-ext.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];
let requests: Record<string, unknown>[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mck-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
  servers = [];
  requests = [];
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

/** An extension that answers status with `msg` computed from the request's msgId. */
async function serve(reply: (id: string) => Record<string, unknown> | "silent"): Promise<void> {
  const path = ctlSocketPath("auth", "worker-1", dir);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; msgId?: string };
        requests.push(req);
        const r = reply(req.msgId ?? "");
        if (r === "silent") continue; // hold the connection: a timeout
        sock.end(
          encode({
            v: 1,
            ok: true,
            incarnation: INC,
            state: "idle",
            since: 1,
            runs: 4,
            pending: false,
            ...r,
          }),
        );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

const check = (...extra: string[]) =>
  runCli(["agent", "check", "worker-1", "msg-123", "-w", "auth", ...extra], dbPath);

describe("mu agent check", () => {
  it("accepted: `accepted runs=<n> at=<iso>`, exit 0, ONE status request carrying the msgId", async () => {
    await serve((id) => ({
      msg: { id, accepted: true, runs: 4, at: Date.parse("2026-10-24T12:00:00.000Z") },
    }));
    const r = await check();
    expect(r.exitCode).toBeNull();
    expect(r.stdout.trim()).toBe("accepted runs=4 at=2026-10-24T12:00:00.000Z");
    expect(requests).toEqual([{ op: "status", msgId: "msg-123" }]);
  });

  it("not-accepted: `not-accepted`, exit 3", async () => {
    await serve((id) => ({ msg: { id, accepted: false } }));
    const r = await check();
    expect(r.exitCode).toBe(3);
    expect(r.stdout.trim()).toBe("not-accepted");
  });

  it("unreachable (no socket): `unreachable`, exit 1; never `not-accepted`", async () => {
    const r = await check();
    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe("unreachable");
  });

  it("unreachable (an extension that reports no receipts): exit 1, not a false not-accepted", async () => {
    await serve(() => ({}));
    const r = await check();
    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe("unreachable");
  });

  it("unreachable (the socket answers an error): exit 1", async () => {
    await serve(() => ({ ok: false, error: "msgId must be a string of 1-64 characters" }));
    const r = await check();
    expect(r.exitCode).toBe(1);
  });

  it("--json returns the msg object for each outcome", async () => {
    await serve((id) => ({ msg: { id, accepted: true, runs: 4, at: 1 } }));
    const ok = await check("--json");
    expect(JSON.parse(ok.stdout)).toMatchObject({
      agentName: "worker-1",
      state: "accepted",
      id: "msg-123",
      runs: 4,
      at: 1,
      incarnation: INC,
    });
  });

  it("--json not-accepted and unreachable carry their state and still exit 3 / 1", async () => {
    await serve((id) => ({ msg: { id, accepted: false } }));
    const no = await check("--json");
    expect(no.exitCode).toBe(3);
    expect(JSON.parse(no.stdout)).toMatchObject({ state: "not-accepted", id: "msg-123" });
  });

  it("--json on a failure is ONE failure document: the verdict in data, the real exit beside it", async () => {
    await serve((id) => ({ msg: { id, accepted: false } }));
    const no = await runCliWire(
      ["agent", "check", "worker-1", "msg-123", "-w", "auth", "--json"],
      dbPath,
    );
    expect(no.exitCode).toBe(3);
    expect(no.stderr).toBe("");
    expect(JSON.parse(no.stdout)).toMatchObject({
      ok: false,
      error: "MessageNotAccepted",
      next: null,
      exit: 3,
      data: { agentName: "worker-1", state: "not-accepted", id: "msg-123" },
    });
  });

  it("an unknown agent is exit 3 from the verb's own not-found path", async () => {
    const r = await runCli(["agent", "check", "ghost", "m", "-w", "auth"], dbPath);
    expect(r.exitCode).toBe(3);
  });
});

describe("checkMessage (SDK)", () => {
  it("never throws: a held connection is unreachable after its timeout", async () => {
    await serve(() => "silent");
    const r = await checkMessage(ctlSocketPath("auth", "worker-1", dir), "m", 50);
    expect(r).toMatchObject({ state: "unreachable", id: "m" });
  });
});
