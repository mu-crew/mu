// sendViaTransport: pi agents go through the control socket, never a
// silent paste. A real unix-socket server at the derived path stands in
// for the mu pi extension; the mux is the fake tmux harness.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentFreshNeedsCtlError,
  type AgentRow,
  expectsCtl,
  insertAgent,
  sendToAgent,
  sendViaTransport,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];
let received: Record<string, unknown>[];

beforeEach(() => {
  // Short prefix: the socket path must fit macOS's 104-byte sun_path.
  dir = mkdtempSync(join(tmpdir(), "mat-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  servers = [];
  received = [];
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

function sockFor(agent: string): string {
  return ctlSocketPath("auth", agent, dir);
}

/** Stand-in for the extension: records requests, answers `reply` (default ok, busy). */
async function serveExtension(
  path: string,
  reply: Record<string, unknown> = { v: 1, ok: true, state: "busy" },
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        received.push(JSON.parse(line) as Record<string, unknown>);
        sock.end(encode(reply));
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

function seed(name: string, cli = "pi"): AgentRow {
  return insertAgent(db, { name, workstream: "auth", paneId: "%1", cli });
}

function pasted(): boolean {
  return mux.calls.some((c) => c[0] === "paste-buffer");
}

describe("expectsCtl", () => {
  it("is the speaksMuCtl rule", () => {
    expect(expectsCtl(seed("worker-1", "pi"))).toBe(true);
    expect(expectsCtl(seed("worker-2", "pi-meta"))).toBe(true);
    expect(expectsCtl(seed("worker-3", "claude"))).toBe(false);
  });
});

describe("sendViaTransport", () => {
  it("sends a pi agent's text to its control socket", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const res = await sendToAgent(db, "worker-1", "hello", { workstream: "auth" });
    expect(res).toEqual({ transport: "ctl", state: "busy" });
    expect(received).toEqual([{ op: "send", text: "hello", mode: "followUp" }]);
    expect(pasted()).toBe(false);
  });

  it("passes --steer through as mode steer", async () => {
    const agent = seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    await sendViaTransport(agent, "stop", { mode: "steer", socket: sockFor("worker-1") });
    expect(received[0]).toMatchObject({ op: "send", mode: "steer" });
  });

  it("throws AgentCtlUnreachableError and does not paste when nothing answers", async () => {
    seed("worker-1");
    const err = await sendToAgent(db, "worker-1", "hello", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentCtlUnreachableError);
    expect((err as AgentCtlUnreachableError).kind).toBe("missing");
    expect((err as AgentCtlUnreachableError).socket).toBe(sockFor("worker-1"));
    expect(pasted()).toBe(false);
  });

  it("via mux forces the paste path for a pi agent", async () => {
    seed("worker-1");
    const res = await sendToAgent(db, "worker-1", "hello", {
      workstream: "auth",
      via: "mux",
      readinessMs: 0,
    });
    expect(res).toEqual({ transport: "mux" });
    expect(pasted()).toBe(true);
  });

  it("sends slash commands through the mux even for a pi agent", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const res = await sendToAgent(db, "worker-1", "/new", { workstream: "auth", readinessMs: 0 });
    expect(res.transport).toBe("mux");
    expect(received).toEqual([]);
    expect(pasted()).toBe(true);
  });

  it("sends to a non-pi CLI through the mux", async () => {
    seed("worker-1", "claude");
    const res = await sendToAgent(db, "worker-1", "hi", { workstream: "auth", readinessMs: 0 });
    expect(res.transport).toBe("mux");
    expect(pasted()).toBe(true);
  });
});

describe("mu agent send transport", () => {
  it("reports transport ctl in --json", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const { stdout, exitCode } = await runCli(
      ["agent", "send", "worker-1", "hello", "--steer", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(JSON.parse(stdout)).toMatchObject({ transport: "ctl", state: "busy" });
    expect(received[0]).toMatchObject({ mode: "steer" });
  });

  it("exits non-zero with next steps when the socket is missing", async () => {
    seed("worker-1");
    const { stderr, exitCode } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth"],
      dbPath,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ctl: missing");
    expect(stderr).toContain("mu link pi");
    expect(pasted()).toBe(false);
  });

  it("rejects an unknown --via", async () => {
    seed("worker-1");
    const { exitCode, stderr } = await runCli(
      ["agent", "send", "worker-1", "hello", "--via", "ssh", "-w", "auth"],
      dbPath,
    );
    expect(exitCode).not.toBeNull();
    expect(stderr).toContain("--via must be ctl or mux");
  });
});

describe("send --fresh", () => {
  it("sends op fresh over ctl, even for slash-looking text", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const res = await sendToAgent(db, "worker-1", "/do-thing", { workstream: "auth", fresh: true });
    expect(res.transport).toBe("ctl");
    expect(received).toEqual([{ op: "fresh", text: "/do-thing" }]);
    expect(pasted()).toBe(false);
  });

  it("passes force through", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    await sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true, force: true });
    expect(received).toEqual([{ op: "fresh", text: "x", force: true }]);
  });

  it("maps a busy refusal to AgentBusyError with abort / --force next steps", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: false, error: "busy" });
    const err = await sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentBusyError);
    const cmds = (err as AgentBusyError).errorNextSteps().map((n) => n.command);
    expect(cmds.join("\n")).toContain("mu agent abort worker-1");
    expect(cmds.join("\n")).toContain("--fresh --force");
  });

  it("refuses non-pi agents and --via mux without pasting", async () => {
    seed("worker-1", "claude");
    seed("worker-2");
    await expect(
      sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true }),
    ).rejects.toBeInstanceOf(AgentFreshNeedsCtlError);
    await expect(
      sendToAgent(db, "worker-2", "x", { workstream: "auth", fresh: true, via: "mux" }),
    ).rejects.toBeInstanceOf(AgentFreshNeedsCtlError);
    expect(pasted()).toBe(false);
  });

  it("CLI: --fresh --json reports fresh; busy exits 4; --force without --fresh is usage", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const ok = await runCli(
      ["agent", "send", "worker-1", "go", "--fresh", "-w", "auth", "--json"],
      dbPath,
    );
    expect(ok.exitCode).toBeNull();
    expect(JSON.parse(ok.stdout)).toMatchObject({ transport: "ctl", fresh: true });

    seed("worker-2");
    await serveExtension(sockFor("worker-2"), { v: 1, ok: false, error: "busy" });
    const busy = await runCli(["agent", "send", "worker-2", "go", "--fresh", "-w", "auth"], dbPath);
    expect(busy.exitCode).toBe(4);
    expect(busy.stderr).toContain("mu agent abort worker-2");

    const bad = await runCli(["agent", "send", "worker-1", "go", "--force", "-w", "auth"], dbPath);
    expect(bad.exitCode).toBe(2);
  });
});
