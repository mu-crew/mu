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
  AgentEmptySendError,
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
  AgentPaneDeadError,
  AgentReplacedError,
  type AgentRow,
  AgentSendIndeterminateError,
  AgentSendUnsupportedError,
  AgentSlashCommandUnsupportedError,
  expectsCtl,
  insertAgent,
  respawnCommand,
  sendToAgent,
  sendViaTransport,
} from "../src/agents.js";
import { setStdinReaderForTests } from "../src/cli/stdin.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { helloReply, INC, withHello } from "./_ctl-ext.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson, runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];
let received: Record<string, unknown>[];
let hellos: Record<string, unknown>[];
let paneAlive: boolean;

beforeEach(() => {
  // Short prefix: the socket path must fit macOS's 104-byte sun_path.
  dir = mkdtempSync(join(tmpdir(), "mat-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  servers = [];
  received = [];
  hellos = [];
  setSleepForTests(async () => {});
  paneAlive = true;
  mux = installMux("tmux", async (args) => ({
    stdout: args[0] === "display-message" && paneAlive ? "%1\n" : "",
    stderr: "",
    exitCode: 0,
  }));
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
        // hello is the served-ops check, not the request under test.
        if (req.op !== "hello") received.push(req);
        else hellos.push(req);
        sock.end(
          encode(
            typeof reply === "function"
              ? reply(req)
              : withHello(req, reply as Record<string, unknown>),
          ),
        );
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
    expect(res).toEqual({
      transport: "ctl",
      state: "busy",
      incarnation: INC,
      msgId: expect.any(String),
    });
    expect(received).toEqual([
      { op: "send", text: "hello", mode: "followUp", msgId: res.msgId, expectIncarnation: INC },
    ]);
    expect(res.msgId).toHaveLength(36);
    expect(hellos).toHaveLength(1); // one served-ops check per send
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

  it("a silent socket on a vanished pane is AgentPaneDeadError, not link advice", async () => {
    seed("worker-1");
    paneAlive = false;
    const err = await sendToAgent(db, "worker-1", "hello", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentPaneDeadError);
    expect(pasted()).toBe(false);
  });

  it("a live pane whose socket refuses stays AgentCtlUnreachableError", async () => {
    seed("worker-1");
    // A stale socket file nobody listens on: connect gets ECONNREFUSED.
    const path = sockFor("worker-1");
    const s = createServer();
    mkdirSync(dirname(path), { recursive: true });
    await new Promise<void>((r) => s.listen(path, () => r()));
    s.unref();
    // the socket file is gone after close, so this reads "missing" with the pane still alive.
    await new Promise<void>((r) => s.close(() => r()));
    const err = await sendToAgent(db, "worker-1", "hello", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentCtlUnreachableError);
  });

  /**
   * An extension that answers hello and status{msgId}, but swallows the
   * request under test (written, then the connection closes: delivery
   * unknown). `accepts` is what `status {msgId}` then says.
   */
  async function serveSilentOn(op: string, accepts: boolean): Promise<void> {
    const path = sockFor("worker-1");
    mkdirSync(dirname(path), { recursive: true });
    const server = createServer((sock) => {
      const dec = new LineDecoder();
      sock.setEncoding("utf8");
      sock.on("error", () => {});
      sock.on("data", (chunk: string) => {
        for (const line of dec.push(chunk)) {
          const req = JSON.parse(line) as Record<string, unknown>;
          if (req.op === "hello") {
            hellos.push(req);
            sock.end(encode(helloReply()));
            continue;
          }
          received.push(req);
          if (req.op === op) sock.destroy();
          else if (req.op === "status" && typeof req.msgId === "string") {
            sock.end(
              encode({
                v: 1,
                ok: true,
                incarnation: INC,
                state: "busy",
                since: 1,
                runs: 5,
                pending: false,
                msg: accepts
                  ? { id: req.msgId, accepted: true, runs: 5, at: 1 }
                  : { id: req.msgId, accepted: false },
              }),
            );
          } else sock.end(encode({ v: 1, ok: false, error: "unexpected" }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
  }

  it("a send closed without a reply, not accepted: AgentSendIndeterminateError carrying the msgId; ONE status probe, never a resend", async () => {
    seed("worker-1");
    await serveSilentOn("send", false);
    const err = await sendToAgent(db, "worker-1", "hello", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentSendIndeterminateError);
    const id = (received[0] as { msgId: string }).msgId;
    expect((err as AgentSendIndeterminateError).msgId).toBe(id);
    expect((err as Error).message).toContain(id);
    expect(received.map((r) => r.op)).toEqual(["send", "status"]);
    expect(received[1]).toEqual({ op: "status", msgId: id });
    expect(pasted()).toBe(false);
  });

  it("a send closed without a reply, but status {msgId} says accepted: success with receipt confirmed-after-timeout", async () => {
    seed("worker-1");
    await serveSilentOn("send", true);
    const res = await sendToAgent(db, "worker-1", "hello", { workstream: "auth" });
    expect(res).toMatchObject({
      transport: "ctl",
      receipt: "confirmed-after-timeout",
      runs: 5,
      incarnation: INC,
      msgId: expect.any(String),
    });
    expect(received.map((r) => r.op)).toEqual(["send", "status"]);
  });

  it.each([
    ["fresh", { fresh: true }],
    ["send", { mode: "steer" as const }],
  ])("%s: same receipt path (confirmed, then not accepted)", async (op, extra) => {
    seed("worker-1");
    await serveSilentOn(op, true);
    const ok = await sendToAgent(db, "worker-1", "go", { workstream: "auth", ...extra });
    expect(ok.receipt).toBe("confirmed-after-timeout");
    expect(received.map((r) => r.op)).toEqual([op, "status"]);
  });

  it("the CLI: indeterminate exits 1 and --json carries msgId/incarnation/delivery as structured fields", async () => {
    seed("worker-1");
    await serveSilentOn("send", false);
    const bad = await runCliWire(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(bad.exitCode).toBe(1);
    // The failure is ONE document on stdout; stderr stays empty.
    expect(bad.stderr).toBe("");
    const id = (received[0] as { msgId: string }).msgId;
    const env = JSON.parse(bad.stdout) as Record<string, unknown>;
    expect(env).toMatchObject({
      ok: false,
      error: "AgentSendIndeterminateError",
      exit: 1,
      // The receipt check (never a resend), while the row the send went to stands.
      next: { mode: "alt", commands: [`mu agent check worker-1 ${id} -w auth --json`] },
      msgId: id,
      incarnation: INC,
      delivery: "unknown",
    });
    expect(env.message).toContain(id);
  });

  // Every --json send form carries the same receipt triple, delivered or not.
  it.each([
    ["plain", ["hello"], "send"],
    ["--steer", ["hello", "--steer"], "send"],
    ["--fresh", ["hello", "--fresh"], "fresh"],
    ["--interrupt", ["hello", "--interrupt"], "interrupt"],
  ])(
    "%s --json: delivery-unknown error carries the wire msgId, incarnation, delivery",
    async (_n, args, op) => {
      seed("worker-1");
      await serveSilentOn(op, false);
      const bad = await runCliWire(
        ["agent", "send", "worker-1", ...args, "-w", "auth", "--json"],
        dbPath,
      );
      expect(bad.exitCode).toBe(1);
      const wire = received.find((r) => r.op === op) as { msgId: string };
      expect(JSON.parse(bad.stdout)).toMatchObject({
        ok: false,
        msgId: wire.msgId,
        incarnation: INC,
        delivery: "unknown",
      });
    },
  );

  it("a confirmed-after-timeout send --json: msgId, incarnation, delivery 'delivered', one wait as next", async () => {
    seed("worker-1");
    await serveSilentOn("send", true);
    const r = await runCliJson(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const id = (received[0] as { msgId: string }).msgId;
    expect(r.data).toMatchObject({
      msgId: id,
      incarnation: INC,
      delivery: "delivered",
      receipt: "confirmed-after-timeout",
    });
    expect(r.doc.next).toEqual({
      mode: "alt",
      commands: [`mu wait 'agent:auth/worker-1@5#${INC}'`],
    });
  });

  it("a normal send --json carries delivery 'delivered' with msgId and incarnation", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const r = await runCliJson(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.doc).toMatchObject({ ok: true, next: null });
    expect(r.data).toMatchObject({
      msgId: received[0]?.msgId,
      incarnation: INC,
      delivery: "delivered",
    });
  });

  // No path may send a side-effecting request twice (reviewer mutant 6: a
  // retry inside ctlRequestFor). Counted on the wire, per op, for every
  // verb that writes: send, fresh, command (/new, /reload, /compact).
  it.each([
    ["plain send", "hello", {}, "send"],
    ["--steer", "hello", { mode: "steer" as const }, "send"],
    ["--fresh", "hello", { fresh: true }, "fresh"],
    ["/new", "/new", {}, "command"],
    ["/compact x", "/compact x", {}, "command"],
  ])(
    "%s that gets no reply is written exactly ONCE (never retried)",
    async (_n, text, extra, op) => {
      seed("worker-1");
      await serveSilentOn(op, false);
      const err = await sendToAgent(db, "worker-1", text, { workstream: "auth", ...extra }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentSendIndeterminateError);
      expect(received.filter((r) => r.op === op)).toHaveLength(1);
      // the only other traffic is the single receipt probe (a session command carries no msgId)
      expect(received.filter((r) => r.op === "status").length).toBeLessThanOrEqual(1);
      expect(received.filter((r) => r.op !== op && r.op !== "status")).toEqual([]);
    },
  );

  it("a session command's indeterminate error carries no msgId and points at reading the pane", async () => {
    seed("worker-1");
    await serveSilentOn("command", false);
    const err = await sendToAgent(db, "worker-1", "/compact", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect((err as AgentSendIndeterminateError).msgId).toBeUndefined();
  });

  it("an indeterminate send on a vanished pane is still AgentPaneDeadError", async () => {
    seed("worker-1");
    paneAlive = false;
    const path = sockFor("worker-1");
    mkdirSync(dirname(path), { recursive: true });
    const server = createServer((sock) => {
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          const req = JSON.parse(line) as Record<string, unknown>;
          if (req.op === "hello") sock.write(encode(helloReply()));
          else {
            received.push(req);
            sock.end();
          }
        }
      });
      sock.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
    const err = await sendToAgent(db, "worker-1", "hello", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentPaneDeadError);
    // The write happened before the pane check: the error keeps that evidence.
    expect((err as AgentPaneDeadError).msgId).toBe((received[0] as { msgId: string }).msgId);
    expect((err as Error).message).toContain("delivery is unknown");
  });

  it("a caller-reserved msgId is the id on the wire (and the receipt); default sends still mint their own", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const reserved = await sendToAgent(db, "worker-1", "hi", {
      workstream: "auth",
      msgId: "reserved-id-1",
    });
    expect(reserved.msgId).toBe("reserved-id-1");
    expect((received[0] as { msgId: string }).msgId).toBe("reserved-id-1");
    const minted = await sendToAgent(db, "worker-1", "hi", { workstream: "auth" });
    expect(minted.msgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(minted.msgId).not.toBe("reserved-id-1");
  });

  it("a reserved msgId that goes unanswered is the id the indeterminate error names", async () => {
    seed("worker-1");
    await serveSilentOn("send", false);
    const err = await sendToAgent(db, "worker-1", "hello", {
      workstream: "auth",
      msgId: "reserved-id-2",
    }).catch((e: unknown) => e);
    expect((err as AgentSendIndeterminateError).msgId).toBe("reserved-id-2");
    expect(received[1]).toEqual({ op: "status", msgId: "reserved-id-2" });
  });

  it("an empty send to a pi agent over ctl is refused, pointing at the pane", async () => {
    seed("worker-1");
    const err = await sendToAgent(db, "worker-1", "", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentEmptySendError);
    expect((err as AgentEmptySendError).message).not.toContain("--via");
    expect(pasted()).toBe(false);
  });

  it("send to a non-pi agent on tmux throws AgentSendUnsupportedError", async () => {
    seed("worker-1", "claude");
    const err = await sendToAgent(db, "worker-1", "hi", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentSendUnsupportedError);
    expect((err as Error).message).toBe(
      "agent worker-1 runs claude, not pi: tmux has no reliable send for it; spawn it on herdr (MU_MUX=herdr), start it with the prompt as an argument (--command \"claude '<prompt>'\"), or use pi",
    );
    expect(pasted()).toBe(false);
    expect(mux.calls.some((c) => c[0] === "send-keys" || c[0] === "set-buffer")).toBe(false);
  });

  it("send to a non-pi agent on herdr goes through the atomic agent prompt", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "w1:p1", cli: "claude" });
    const herdr = installMux("herdr", [["agent prompt", "{}"]]);
    try {
      const res = await sendToAgent(db, "worker-1", "hi", { workstream: "auth" });
      expect(res).toEqual({ transport: "mux" });
      expect(herdr.calls.some((c) => c[0] === "agent" && c[1] === "prompt")).toBe(true);
    } finally {
      herdr.restore();
    }
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
    expect(received).toEqual([{ ...op, expectIncarnation: INC }]);
  });

  describe("incarnation fence on the command route (rr_r3_session_ignores_fence)", () => {
    const commands = () => received.filter((r) => r.op === "command");

    it("an explicit expectIncarnation naming another pi is refused before the command is written", async () => {
      seed("worker-1");
      await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "idle" });
      const err = await sendToAgent(db, "worker-1", "/new", {
        workstream: "auth",
        expectIncarnation: "old-proc",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentReplacedError);
      expect(commands()).toEqual([]);
    });

    it("the extension's own refusal (a pi bound after the hello) is AgentReplacedError too", async () => {
      seed("worker-1");
      await serveExtension(sockFor("worker-1"), (req) =>
        req.op === "hello"
          ? helloReply()
          : req.expectIncarnation !== undefined && req.expectIncarnation !== "replacement"
            ? { v: 1, ok: false, error: "incarnation mismatch", incarnation: "replacement" }
            : { v: 1, ok: true, state: "idle" },
      );
      const err = await sendToAgent(db, "worker-1", "/compact", {
        workstream: "auth",
        expectIncarnation: INC,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentReplacedError);
      expect(commands()).toHaveLength(1);
    });

    it("the right expectIncarnation rides on the command; with none, the hello's incarnation does", async () => {
      seed("worker-1");
      await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "idle" });
      await sendToAgent(db, "worker-1", "/new", { workstream: "auth", expectIncarnation: INC });
      await sendToAgent(db, "worker-1", "/reload", { workstream: "auth" });
      expect(commands()).toEqual([
        { op: "command", name: "new", expectIncarnation: INC },
        { op: "command", name: "reload", expectIncarnation: INC },
      ]);
    });

    it("an extension that does not serve the fence: an explicit fence is refused, never silently dropped; an implicit one degrades", async () => {
      seed("worker-1");
      await serveExtension(sockFor("worker-1"), (req) =>
        req.op === "hello"
          ? helloReply({ features: ["incarnation", "msgId"] })
          : { v: 1, ok: true, state: "idle" },
      );
      const err = await sendToAgent(db, "worker-1", "/new", {
        workstream: "auth",
        expectIncarnation: INC,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentExtensionOutdatedError);
      expect(err).toMatchObject({ op: "fence" });
      expect(commands()).toEqual([]);
      await sendToAgent(db, "worker-1", "/new", { workstream: "auth" });
      expect(commands()).toEqual([{ op: "command", name: "new" }]);
    });
  });

  it("passes force through and maps busy to AgentBusyError naming the command", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), (req) =>
      req.op === "hello"
        ? helloReply()
        : req.force
          ? { v: 1, ok: true, state: "idle" }
          : { v: 1, ok: false, error: "busy" },
    );
    const err = await sendToAgent(db, "worker-1", "/new", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentBusyError);
    await sendToAgent(db, "worker-1", "/new", { workstream: "auth", force: true });
    expect(received.at(-1)).toEqual({
      op: "command",
      name: "new",
      force: true,
      expectIncarnation: INC,
    });
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

  it("an extension without op command raises AgentExtensionOutdatedError on /reload (slash commands skip the msgId check)", async () => {
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

  it("an extension that serves op command but lacks the msgId feature: refused before writing; Next is /reload over ctl, then respawn", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), (req) =>
      req.op === "hello"
        ? helloReply({ features: [], ops: ["hello", "send", "command"], extVersion: "3.2.1" })
        : { v: 1, ok: true, state: "idle" },
    );
    const err = await sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentExtensionOutdatedError);
    expect(err).toMatchObject({ op: "msgId", extVersion: "3.2.1" });
    expect((err as Error).message).toContain("predates feature msgId");
    expect(received).toEqual([]); // nothing was written
    expect(pasted()).toBe(false);
  });

  it("refuses any other slash command, naming the supported ones", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const err = await sendToAgent(db, "worker-1", "/tree", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentSlashCommandUnsupportedError);
    const msg = (err as Error).message;
    for (const s of ["/new", "/reload", "/compact"]) expect(msg).toContain(s);
    expect(msg).not.toContain("--via");
    expect(received).toEqual([]);
    expect(mux.calls).toEqual([]);
  });

  it("a path or prose starting with / is a plain prompt, not a slash command", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    await sendToAgent(db, "worker-1", "/tmp/x.log has the trace", { workstream: "auth" });
    expect(received).toEqual([
      {
        op: "send",
        text: "/tmp/x.log has the trace",
        mode: "followUp",
        msgId: expect.any(String),
        expectIncarnation: INC,
      },
    ]);
  });

  // The point of Task 20: a pi agent never reaches pane scraping or paste timing.
  it("send, --fresh, /new, /reload, /compact to a pi agent never touch the mux", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "idle" });
    // Actor attribution may probe the mux for a pane title; pin it so only transport is measured.
    process.env.MU_AGENT_NAME = "orch-1";
    try {
      for (const text of ["hello", "/new", "/reload", "/compact x"]) {
        await sendToAgent(db, "worker-1", text, { workstream: "auth" });
      }
      await sendToAgent(db, "worker-1", "task", { workstream: "auth", fresh: true });
    } finally {
      delete process.env.MU_AGENT_NAME;
    }
    expect(received.map((r) => r.op)).toEqual(["send", "command", "command", "command", "fresh"]);
    expect(mux.calls).toEqual([]);
  });

  it("CLI: /compact --force --json reports command; unknown slash exits 2", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "idle" });
    const ok = await runCliJson(
      ["agent", "send", "worker-1", "/compact", "--force", "-w", "auth", "--json"],
      dbPath,
    );
    expect(ok.exitCode).toBeNull();
    expect(ok.data).toMatchObject({ transport: "ctl", command: "compact" });
    expect(received.at(-1)).toEqual({
      op: "command",
      name: "compact",
      force: true,
      expectIncarnation: INC,
    });
    const bad = await runCliJson(
      ["agent", "send", "worker-1", "/tree", "-w", "auth", "--json"],
      dbPath,
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toBe("");
    expect(bad.doc).toMatchObject({ error: "AgentSlashCommandUnsupportedError", next: null });
  });
});

describe("mu agent send transport", () => {
  it("`-` sends stdin verbatim (prose-quoting)", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const brief = "it's the worker's task: $HOME `pwd`";
    setStdinReaderForTests(async () => `${brief}\n`);
    try {
      const r = await runCli(["agent", "send", "worker-1", "-", "-w", "auth", "--fresh"], dbPath);
      expect(r.exitCode).toBeNull();
    } finally {
      setStdinReaderForTests(null);
    }
    expect(received).toEqual([
      { op: "fresh", text: brief, msgId: expect.any(String), expectIncarnation: INC },
    ]);
  });

  it("agent.send is attributed to $MU_AGENT_NAME, not system", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    process.env.MU_AGENT_NAME = "orch-1";
    try {
      await runCli(["agent", "send", "worker-1", "hi", "-w", "auth"], dbPath);
    } finally {
      delete process.env.MU_AGENT_NAME;
    }
    const row = openDb({ path: dbPath })
      .prepare("SELECT actor FROM ops WHERE intent = 'agent.send'")
      .get();
    expect(row).toEqual({ actor: "orch-1" });
  });

  it("reports transport ctl in --json", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "worker-1", "hello", "--steer", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      transport: "ctl",
      state: "busy",
      incarnation: INC,
      msgId: received[0]?.msgId,
    });
    expect(received[0]).toMatchObject({ mode: "steer" });
  });

  it("a plain send is one ctl op; its reply status feeds --json runs", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), {
      v: 1,
      ok: true,
      state: "idle",
      since: 1,
      runs: 4,
      pending: false,
    });
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(received.map((r) => r.op)).toEqual(["send"]);
    expect(data).toMatchObject({ state: "idle", runs: 4 });
  });

  it("a ctl send with runs points at mu wait, not a pane read", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), {
      v: 1,
      ok: true,
      state: "idle",
      since: 1,
      runs: 4,
      pending: false,
    });
    const { doc } = await runCliJson(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(doc.next).toEqual({ mode: "alt", commands: [`mu wait 'agent:auth/worker-1@4#${INC}'`] });
  });

  it("--steer and --fresh ctl replies with runs also point at mu wait", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), {
      v: 1,
      ok: true,
      state: "busy",
      since: 1,
      runs: 7,
      pending: false,
    });
    for (const flag of ["--steer", "--fresh"]) {
      const { doc } = await runCliJson(
        ["agent", "send", "worker-1", "hello", flag, "-w", "auth", "--json"],
        dbPath,
      );
      expect(doc.next?.commands, flag).toEqual([`mu wait 'agent:auth/worker-1@7#${INC}'`]);
    }
  });

  it("a ctl reply without runs owes no wait: next is null", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "busy" });
    const old = await runCliJson(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(old.doc.next).toBeNull();
  });

  it("an older extension's send reply (no runs) skips the state hints", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: true, state: "busy" });
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(received.map((r) => r.op)).toEqual(["send"]);
    const body = data as { runs?: number };
    expect(body.runs).toBeUndefined();
  });

  it("exits non-zero naming the missing socket", async () => {
    seed("worker-1");
    const { stderr, exitCode } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth"],
      dbPath,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ctl: missing");
    expect(pasted()).toBe(false);
  });

  it("--via is no longer an option; a send to a non-pi agent on tmux exits 4", async () => {
    seed("worker-1");
    const via = await runCli(
      ["agent", "send", "worker-1", "hello", "--via", "mux", "-w", "auth"],
      dbPath,
    );
    expect(via.exitCode).not.toBeNull();
    expect(via.stderr).toMatch(/unknown option/);
    seed("shy", "claude");
    const r = await runCliJson(["agent", "send", "shy", "hello", "-w", "auth", "--json"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.doc.error).toBe("AgentSendUnsupportedError");
  });
});

describe("plain send and fresh bind the hello's incarnation (rr_r3_send_unbound_incarnation)", () => {
  it.each([
    ["plain", {}],
    ["fresh", { fresh: true }],
  ])(
    "%s: a pi bound after the hello refuses it: AgentReplacedError, no receipt probe",
    async (_n, extra) => {
      seed("worker-1");
      await serveExtension(sockFor("worker-1"), (req) =>
        req.op === "hello"
          ? helloReply()
          : req.expectIncarnation === "replacement"
            ? { v: 1, ok: true, state: "idle" }
            : { v: 1, ok: false, error: "incarnation mismatch", incarnation: "replacement" },
      );
      const err = await sendToAgent(db, "worker-1", "x", { workstream: "auth", ...extra }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentReplacedError);
      expect(received.map((r) => r.op)).toEqual(["fresh" in extra ? "fresh" : "send"]);
    },
  );

  it("an extension that names no incarnation is sent to unbound", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), (req) =>
      req.op === "hello" ? helloReply({ incarnation: undefined }) : { v: 1, ok: true },
    );
    await sendToAgent(db, "worker-1", "x", { workstream: "auth" });
    expect(received[0]).not.toHaveProperty("expectIncarnation");
  });
});

describe("send --fresh", () => {
  it("sends op fresh over ctl, even for slash-looking text", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const res = await sendToAgent(db, "worker-1", "/do-thing", { workstream: "auth", fresh: true });
    expect(res.transport).toBe("ctl");
    expect(received).toEqual([
      { op: "fresh", text: "/do-thing", msgId: res.msgId, expectIncarnation: INC },
    ]);
    expect(pasted()).toBe(false);
  });

  it("passes force through", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    await sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true, force: true });
    expect(received).toEqual([
      { op: "fresh", text: "x", force: true, msgId: expect.any(String), expectIncarnation: INC },
    ]);
  });

  it("maps a busy refusal to AgentBusyError with abort / --force next steps", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"), { v: 1, ok: false, error: "busy" });
    const err = await sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentBusyError);
  });

  // The incident: a pi started before msgId/fresh merged. Its hello lists no
  // features and no command op.
  const oldExtension = (req: Record<string, unknown>) =>
    req.op === "hello"
      ? { v: 1, ok: true, agent: "worker-1", extVersion: "3.0.0", ops: ["hello", "send"] }
      : { v: 1, ok: false, error: `unknown op: ${String(req.op)}`, ops: ["hello", "send"] };

  it("no ctl command op, no mux reload (tmux): the ladder is close, then the respawn line rebuilt from the row", async () => {
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%1",
      cli: "pi-meta",
      command: "pi-meta --no-solo",
      commandSource: "explicit",
      cwd: "/work/x",
    });
    await serveExtension(sockFor("worker-1"), oldExtension);
    const err = await sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentExtensionOutdatedError);
    expect(err).toMatchObject({ op: "msgId", extVersion: "3.0.0" });
    expect(pasted()).toBe(false);
  });

  it("a row with a command but no recorded source is not guessed: no respawn line", () => {
    const row = insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%1",
      command: "pi",
      commandSource: null,
    });
    expect(respawnCommand(row)).toBeUndefined();
  });

  it("CLI: the outdated-extension error exits 4 with the ladder in --json", async () => {
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%1",
      cli: "pi",
      command: "pi",
      commandSource: "cli-key",
      cwd: "/work/x",
    });
    await serveExtension(sockFor("worker-1"), oldExtension);
    const r = await runCliJson(
      ["agent", "send", "worker-1", "go", "--fresh", "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(4);
    expect(r.doc).toMatchObject({ error: "AgentExtensionOutdatedError", next: null });
  });

  it("refuses --fresh to a non-pi agent without pasting", async () => {
    seed("worker-1", "claude");
    await expect(
      sendToAgent(db, "worker-1", "x", { workstream: "auth", fresh: true }),
    ).rejects.toBeInstanceOf(AgentFreshNeedsCtlError);
    expect(pasted()).toBe(false);
  });

  it("CLI: --fresh --json reports fresh; busy exits 4; --force without --fresh is usage", async () => {
    seed("worker-1");
    await serveExtension(sockFor("worker-1"));
    const ok = await runCliJson(
      ["agent", "send", "worker-1", "go", "--fresh", "-w", "auth", "--json"],
      dbPath,
    );
    expect(ok.exitCode).toBeNull();
    expect(ok.data).toMatchObject({ transport: "ctl", fresh: true });

    seed("worker-2");
    await serveExtension(sockFor("worker-2"), { v: 1, ok: false, error: "busy" });
    const busy = await runCli(["agent", "send", "worker-2", "go", "--fresh", "-w", "auth"], dbPath);
    expect(busy.exitCode).toBe(4);
    expect(busy.stderr).toContain("busy");

    const bad = await runCli(["agent", "send", "worker-1", "go", "--force", "-w", "auth"], dbPath);
    expect(bad.exitCode).toBe(2);
  });
});
