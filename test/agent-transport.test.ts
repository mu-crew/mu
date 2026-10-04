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
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
  type AgentRow,
  AgentSlashCommandUnsupportedError,
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
  reply: Record<string, unknown> | ((req: Record<string, unknown>) => Record<string, unknown>) = {
    v: 1,
    ok: true,
    state: "busy",
  },
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as Record<string, unknown>;
        received.push(req);
        sock.end(encode(typeof reply === "function" ? reply(req) : reply));
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

  // Review finding pictl_fix_clikey: `--cli helper --command "pi-meta ..."`
  // spawns pi (handshake ok) but the cli key alone says "helper". The
  // agent's own socket answering is the proof, so it stays a ctl agent.
  it("a custom cli key whose derived socket exists is a ctl agent", async () => {
    const agent = seed("rv1-alias", "helper");
    expect(expectsCtl(agent, sockFor("rv1-alias"))).toBe(false);
    await serveExtension(sockFor("rv1-alias"));
    expect(expectsCtl(agent, sockFor("rv1-alias"))).toBe(true);
  });

  it("send to a custom-key pi agent goes through its socket, not a paste", async () => {
    seed("rv1-alias", "helper");
    await serveExtension(sockFor("rv1-alias"));
    const res = await sendToAgent(db, "rv1-alias", "hi", { workstream: "auth" });
    expect(res.transport).toBe("ctl");
    expect(pasted()).toBe(false);
    const fresh = await sendToAgent(db, "rv1-alias", "task", { workstream: "auth", fresh: true });
    expect(fresh.transport).toBe("ctl");
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

  it("sends to a non-pi CLI through the mux", async () => {
    seed("worker-1", "claude");
    const res = await sendToAgent(db, "worker-1", "hi", { workstream: "auth", readinessMs: 0 });
    expect(res.transport).toBe("mux");
    expect(pasted()).toBe(true);
  });
});

describe("pi session commands over ctl", () => {
  it.each([
    ["/new", { op: "command", name: "new" }],
    ["/reload", { op: "command", name: "reload" }],
    [" /compact ", { op: "command", name: "compact" }],
    [
      "/compact keep the API notes",
      { op: "command", name: "compact", instructions: "keep the API notes" },
    ],
  ])("%j runs as the ctl command op", async (text, op) => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "idle" });
    const res = await sendToAgent(db, "worker-1", text, { workstream: "auth" });
    expect(res).toEqual({ transport: "ctl", command: op.name, state: "idle" });
    expect(received).toEqual([op]);
  });

  it("passes force through and maps busy to AgentBusyError naming the command", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), (req) =>
      req.force ? { v: 1, ok: true, state: "idle" } : { v: 1, ok: false, error: "busy" },
    );
    const err = await sendToAgent(db, "worker-1", "/new", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentBusyError);
    expect((err as AgentBusyError).errorNextSteps().map((n) => n.command)).toContain(
      "mu agent send worker-1 '/new' --force -w auth",
    );
    await sendToAgent(db, "worker-1", "/new", { workstream: "auth", force: true });
    expect(received.at(-1)).toEqual({ op: "command", name: "new", force: true });
  });

  it("surfaces pi's own refusal (Nothing to compact)", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), {
      v: 1,
      ok: false,
      error: "Nothing to compact (session too small)",
    });
    await expect(sendToAgent(db, "worker-1", "/compact", { workstream: "auth" })).rejects.toThrow(
      "pi refused /compact: Nothing to compact (session too small)",
    );
  });

  it("an extension without op command raises AgentExtensionOutdatedError (reload via mux)", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), (req) =>
      req.op === "hello"
        ? { v: 1, ok: true, extVersion: "3.2.1" }
        : { v: 1, ok: false, error: `unknown op: ${String(req.op)}` },
    );
    const err = await sendToAgent(db, "worker-1", "/reload", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentExtensionOutdatedError);
    expect(err).toMatchObject({ op: "command" });
    expect(pasted()).toBe(false);
  });

  it("refuses any other slash command, naming the supported ones and --via mux", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const err = await sendToAgent(db, "worker-1", "/tree", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentSlashCommandUnsupportedError);
    const msg = (err as Error).message;
    for (const s of ["/new", "/reload", "/compact", "--via mux"]) expect(msg).toContain(s);
    expect(received).toEqual([]);
    expect(mux.calls).toEqual([]);
  });

  it("a path or prose starting with / is a plain prompt, not a slash command", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    await sendToAgent(db, "worker-1", "/tmp/x.log has the trace", { workstream: "auth" });
    expect(received).toEqual([{ op: "send", text: "/tmp/x.log has the trace", mode: "followUp" }]);
  });

  // The point of Task 20: a pi agent never reaches pane scraping or paste timing.
  it("send, --fresh, /new, /reload, /compact to a pi agent never touch the mux", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "idle" });
    for (const text of ["hello", "/new", "/reload", "/compact x"]) {
      await sendToAgent(db, "worker-1", text, { workstream: "auth" });
    }
    await sendToAgent(db, "worker-1", "task", { workstream: "auth", fresh: true });
    expect(received.map((r) => r.op)).toEqual(["send", "command", "command", "command", "fresh"]);
    expect(mux.calls).toEqual([]);
  });

  it("a non-pi agent's /new still uses the paste path", async () => {
    seed("worker-1", "claude");
    const res = await sendToAgent(db, "worker-1", "/new", { workstream: "auth", readinessMs: 0 });
    expect(res.transport).toBe("mux");
    expect(pasted()).toBe(true);
  });

  it("--via mux still types an arbitrary slash command into a pi pane", async () => {
    seed("worker-1");
    const res = await sendToAgent(db, "worker-1", "/tree", {
      workstream: "auth",
      via: "mux",
      readinessMs: 0,
    });
    expect(res.transport).toBe("mux");
    expect(pasted()).toBe(true);
  });

  it("CLI: /compact --force --json reports command; unknown slash exits 2 with the --via mux hint", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "idle" });
    const ok = await runCli(
      ["agent", "send", "worker-1", "/compact", "--force", "-w", "auth", "--json"],
      dbPath,
    );
    expect(ok.exitCode).toBeNull();
    expect(JSON.parse(ok.stdout)).toMatchObject({ transport: "ctl", command: "compact" });
    expect(received.at(-1)).toEqual({ op: "command", name: "compact", force: true });
    const bad = await runCli(
      ["agent", "send", "worker-1", "/tree", "-w", "auth", "--json"],
      dbPath,
    );
    expect(bad.exitCode).toBe(2);
    const body = JSON.parse(bad.stderr) as { error: string; nextSteps: { command: string }[] };
    expect(body.error).toBe("AgentSlashCommandUnsupportedError");
    expect(body.nextSteps[0]?.command).toBe("mu agent send worker-1 '/tree' --via mux -w auth");
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

  it("a plain send is one ctl op; its reply status feeds --json runs and the hints", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), {
      v: 1,
      ok: true,
      state: "idle",
      since: 1,
      runs: 4,
      pending: false,
    });
    const { stdout, exitCode } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(received.map((r) => r.op)).toEqual(["send"]);
    const body = JSON.parse(stdout) as { runs?: number; state?: string; nextSteps: unknown[] };
    expect(body).toMatchObject({ state: "idle", runs: 4 });
    expect(JSON.stringify(body.nextSteps)).toContain("--fresh next time");
  });

  it("a ctl send with runs points at wait --after-runs, not a pane read", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), {
      v: 1,
      ok: true,
      state: "idle",
      since: 1,
      runs: 4,
      pending: false,
    });
    const { stdout } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    const cmds = (JSON.parse(stdout) as { nextSteps: Array<{ command: string }> }).nextSteps.map(
      (s) => s.command,
    );
    expect(cmds[0]).toBe("mu agent wait worker-1 --after-runs 4 --json -w auth");
    expect(cmds.some((c) => c.startsWith("mu agent read"))).toBe(false);
  });

  it("a mux send and a ctl reply without runs keep the pane-read hint", async () => {
    seed("shy", "claude");
    const mux1 = await runCli(["agent", "send", "shy", "hello", "-w", "auth", "--json"], dbPath);
    expect(JSON.stringify(JSON.parse(mux1.stdout).nextSteps)).toContain(
      "mu agent read shy -n 50 -w auth",
    );
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "busy" });
    const old = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    const body = JSON.stringify(JSON.parse(old.stdout).nextSteps);
    expect(body).toContain("mu agent read worker-1 -n 50 -w auth");
    expect(body).not.toContain("--after-runs");
  });

  it("an older extension's send reply (no runs) skips the state hints", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "busy" });
    const { stdout, exitCode } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(received.map((r) => r.op)).toEqual(["send"]);
    const body = JSON.parse(stdout) as { runs?: number; nextSteps: unknown[] };
    expect(body.runs).toBeUndefined();
    expect(JSON.stringify(body.nextSteps)).not.toContain("--steer");
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

  // The incident: a pi started before --fresh merged answers "unknown op".
  const oldExtension = (req: Record<string, unknown>) =>
    req.op === "hello"
      ? { v: 1, ok: true, agent: "worker-1", extVersion: "3.0.0" }
      : { v: 1, ok: false, error: `unknown op: ${String(req.op)}`, ops: ["hello", "send"] };

  it("an extension without op fresh raises AgentExtensionOutdatedError: /reload or respawn", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), oldExtension);
    const err = await sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentExtensionOutdatedError);
    expect(err).toMatchObject({ op: "fresh", extVersion: "3.0.0" });
    const cmds = (err as AgentExtensionOutdatedError).errorNextSteps().map((n) => n.command);
    expect(cmds).toEqual([
      "mu agent send worker-1 '/reload' --via mux -w auth",
      "mu agent close worker-1 -w auth && mu agent spawn worker-1 -w auth ...",
    ]);
    expect(pasted()).toBe(false);
  });

  it("CLI: the outdated-extension error exits 4 with both next steps in --json", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), oldExtension);
    const r = await runCli(
      ["agent", "send", "worker-1", "go", "--fresh", "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(4);
    const body = JSON.parse(r.stderr) as { error: string; nextSteps: { command: string }[] };
    expect(body.error).toBe("AgentExtensionOutdatedError");
    expect(body.nextSteps.map((n) => n.command).join("\n")).toContain("'/reload' --via mux");
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
