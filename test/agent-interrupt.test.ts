// mu agent send --interrupt: abort a busy pi, wait for settle, then send.
// A real unix-socket server at the derived path stands in for the mu pi
// extension (op order of the real one: extension-mu-pi.test.ts); the mux
// is the fake tmux harness, so a paste would show up in its calls.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentEmptySendError,
  AgentExtensionOutdatedError,
  AgentReplacedError,
  insertAgent,
  interruptAgent,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];
let ops: Record<string, unknown>[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mai-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  servers = [];
  ops = [];
  setSleepForTests(async () => {});
  // The pane is alive: a silent socket then reads as delivery-unknown, not a dead agent.
  mux = installMux("tmux", async (args) => ({
    stdout: args[0] === "display-message" ? "%1\n" : "",
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

/**
 * Fake extension, busy at runs 3. `hello` overrides the hello reply (an
 * extension without the msgId feature, say). `settles` false: an abort
 * never settles. `silent` swallows the interrupt (written, no reply) while
 * `accepts` says what `status {msgId}` answers afterwards.
 */
async function serve(
  opts: {
    busy?: boolean;
    settles?: boolean;
    hello?: Record<string, unknown>;
    silent?: boolean;
    accepts?: boolean;
    /** The pi bound after the hello: its own incarnation, which refuses any other expectation. */
    replacement?: string;
  } = {},
) {
  let state: "busy" | "idle" = opts.busy === false ? "idle" : "busy";
  let runs = 3;
  const settles = opts.settles !== false;
  const path = ctlSocketPath("auth", "worker-1", dir);
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
          msgId?: string;
          expectIncarnation?: string;
        };
        ops.push(req);
        const status = () => ({ incarnation: INC, state, since: 0, runs, pending: true });
        const reply = (r: object) => sock.end(encode({ v: 1, ...r }));
        if (req.op === "hello") reply(helloReply(opts.hello));
        else if (
          req.op === "interrupt" &&
          opts.replacement !== undefined &&
          req.expectIncarnation !== opts.replacement
        ) {
          reply({ ok: false, error: "incarnation mismatch", incarnation: opts.replacement });
        } else if (req.op === "interrupt" && opts.silent) sock.destroy();
        else if (req.op === "status" && req.msgId !== undefined) {
          reply({
            ok: true,
            ...status(),
            msg: opts.accepts
              ? { id: req.msgId, accepted: true, runs, at: 1 }
              : { id: req.msgId, accepted: false },
          });
        } else if (req.op === "interrupt") {
          const wasBusy = state === "busy";
          if (wasBusy && !settles) {
            setTimeout(() => reply({ ok: false, error: "timeout" }), req.timeoutMs ?? 0);
          } else {
            if (wasBusy) runs++;
            reply({ ok: true, ...status(), wasBusy, pending: true });
            state = "busy";
          }
        } else if (req.op === "status") reply({ ok: true, ...status() });
        else if (req.op === "abort") {
          reply({ ok: true, state });
          if (settles) {
            state = "idle";
            runs++;
          }
        } else if (req.op === "wait") {
          if (runs > (req.afterRuns ?? runs) && state === "idle") reply({ ok: true, ...status() });
          else setTimeout(() => reply({ ok: false, error: "timeout" }), req.timeoutMs ?? 0);
        } else if (req.op === "send") {
          reply({ ok: true, ...status() });
          state = "busy";
        } else reply({ ok: false, error: `unknown op: ${req.op}`, ops: ["status", "send"] });
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

function seed(cli = "pi"): void {
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli });
}

const send = (...args: string[]) =>
  runCliJson(["agent", "send", "worker-1", ...args, "-w", "auth", "--json"], dbPath);

const opNames = () => ops.filter((o) => o.op !== "hello").map((o) => o.op);
const sent = () => ops.filter((o) => o.op !== "hello");
const pasted = () => mux.calls.some((c) => c[0] === "paste-buffer");

describe("mu agent send --interrupt", () => {
  it("busy: one interrupt op; reports was busy, pending, and the post-abort wait baseline", async () => {
    seed();
    await serve();
    const r = await send("--interrupt", "stop, do X");
    expect(r.exitCode).toBeNull();
    expect(sent()).toEqual([
      {
        op: "interrupt",
        text: "stop, do X",
        timeoutMs: 30_000,
        msgId: expect.any(String),
        expectIncarnation: INC,
      },
    ]);
    const body = r.data as Record<string, unknown>;
    expect(body).toMatchObject({ transport: "ctl", wasBusy: true, pending: true, runs: 4 });
    expect(body).toMatchObject({ incarnation: INC, msgId: expect.any(String) });
    expect(r.doc.next?.commands).toEqual([`mu wait 'agent:auth/worker-1@4#${INC}'`]);
    expect(pasted()).toBe(false);
  });

  it("human output says queued messages went back to the editor", async () => {
    seed();
    await serve();
    const r = await runCli(
      ["agent", "send", "worker-1", "--interrupt", "go", "-w", "auth"],
      dbPath,
    );
    expect(r.stdout).toMatch(/interrupted a busy run/);
    expect(r.stdout).toMatch(/queued messages went back to the pane's editor/);
  });

  describe("incarnation fence (rr_r3_interrupt_unbound_incarnation)", () => {
    const interrupt = (o: Record<string, unknown> = {}) =>
      interruptAgent(db, "worker-1", "go", { workstream: "auth", ...o });

    it("the interrupt carries the hello's incarnation by default", async () => {
      seed();
      await serve();
      await interrupt();
      expect(sent()[0]).toMatchObject({ op: "interrupt", expectIncarnation: INC });
    });

    it("a pi bound after the hello refuses it: AgentReplacedError, one interrupt written, no abort or send", async () => {
      seed();
      await serve({ replacement: "other-pi" });
      await expect(interrupt()).rejects.toBeInstanceOf(AgentReplacedError);
      expect(opNames()).toEqual(["interrupt"]);
    });

    it("an explicit expectIncarnation naming another pi is refused before any interrupt is written", async () => {
      seed();
      await serve();
      await expect(interrupt({ expectIncarnation: "old-proc" })).rejects.toBeInstanceOf(
        AgentReplacedError,
      );
      expect(opNames()).toEqual([]);
    });

    it("an extension that does not serve the fence: explicit is refused, implicit sends unfenced", async () => {
      seed();
      await serve({ hello: helloReply({ features: ["incarnation", "msgId"] }) });
      await expect(interrupt({ expectIncarnation: INC })).rejects.toBeInstanceOf(
        AgentExtensionOutdatedError,
      );
      expect(opNames()).toEqual([]);
      await interrupt();
      expect(sent()[0]).not.toHaveProperty("expectIncarnation");
    });
  });

  it("idle: just sends", async () => {
    seed();
    await serve({ busy: false });
    const r = await send("--interrupt", "hi");
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ wasBusy: false, runs: 3 });
  });

  it("--timeout reaches the op in ms", async () => {
    seed();
    await serve({ busy: false });
    await send("--interrupt", "--timeout", "2", "hi");
    expect(sent()[0]).toMatchObject({ op: "interrupt", timeoutMs: 2000 });
  });

  it("settle timeout: exit 5, close hint", async () => {
    seed();
    await serve({ settles: false });
    const r = await send("--interrupt", "--timeout", "0.1", "x");
    expect(r.exitCode).toBe(5);
    expect(r.doc).toMatchObject({ error: "AgentAbortTimeoutError", next: null });
  });

  it("an extension without the msgId feature: refused before anything is aborted or sent", async () => {
    seed();
    await serve({ hello: helloReply({ features: [] }) });
    const r = await send("--interrupt", "stop");
    expect(r.exitCode).toBe(4);
    expect(r.doc).toMatchObject({ error: "AgentExtensionOutdatedError" });
    expect(opNames()).toEqual([]);
    expect(pasted()).toBe(false);
  });

  it("no reply, but status {msgId} says it landed: success with receipt confirmed-after-timeout, one interrupt only", async () => {
    seed();
    await serve({ silent: true, accepts: true });
    const r = await send("--interrupt", "stop");
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({
      transport: "ctl",
      receipt: "confirmed-after-timeout",
      incarnation: INC,
    });
    expect(opNames()).toEqual(["interrupt", "status"]);
  });

  it("no reply and not accepted: AgentSendIndeterminateError (exit 1) carrying the msgId; never resent", async () => {
    seed();
    await serve({ silent: true, accepts: false });
    const r = await send("--interrupt", "stop");
    expect(r.exitCode).toBe(1);
    const env = r.doc as unknown as { error: string; message: string; next: unknown };
    expect(env.error).toBe("AgentSendIndeterminateError");
    const id = (ops.find((o) => o.op === "interrupt") as { msgId: string }).msgId;
    expect(env.message).toContain(id);
    // The receipt check, never a resend: the registry row the send went to still stands.
    expect(env.next).toEqual({
      mode: "alt",
      commands: [`mu agent check worker-1 ${id} -w auth --json`],
    });
    expect(opNames()).toEqual(["interrupt", "status"]);
  });

  it.each([
    [["--fresh"], /--interrupt and --fresh are mutually exclusive/],
    [["--steer"], /--interrupt and --steer are mutually exclusive/],
  ])("exclusive with %j: exit 2, nothing sent", async (flags, msg) => {
    seed();
    await serve();
    const r = await send("--interrupt", ...flags, "x");
    expect(r.exitCode).toBe(2);
    expect(JSON.stringify(r.doc)).toMatch(msg);
    expect(ops).toEqual([]);
    expect(pasted()).toBe(false);
  });

  it("slash-command text: exit 2", async () => {
    seed();
    await serve();
    const r = await send("--interrupt", "/new");
    expect(r.exitCode).toBe(2);
    expect(JSON.stringify(r.doc)).toMatch(/--interrupt sends a prompt, not a slash command/);
    expect(ops).toEqual([]);
  });

  it("empty text: exit 2, and nothing is aborted", async () => {
    seed();
    await serve();
    const r = await send("--interrupt", "");
    expect(r.exitCode).toBe(2);
    expect(JSON.stringify(r.doc)).toMatch(/--interrupt needs a non-empty prompt/);
    expect(ops).toEqual([]);
  });

  it("SDK interruptAgent refuses empty text before any ctl op", async () => {
    seed();
    await serve();
    await expect(interruptAgent(db, "worker-1", "", { workstream: "auth" })).rejects.toBeInstanceOf(
      AgentEmptySendError,
    );
    expect(ops).toEqual([]);
  });

  it("--timeout without --interrupt: exit 2", async () => {
    seed();
    await serve();
    const r = await send("--timeout", "3", "x");
    expect(r.exitCode).toBe(2);
    expect(JSON.stringify(r.doc)).toMatch(/--timeout only applies with --interrupt/);
  });

  it("non-pi agent: exit 2 pointing at close, never pastes", async () => {
    seed("claude");
    const r = await send("--interrupt", "x");
    expect(r.exitCode).toBe(2);
    expect(r.doc).toMatchObject({ error: "AgentAbortNeedsCtlError" });
    expect(pasted()).toBe(false);
  });
});

describe("--steer no longer promises an interrupt", () => {
  it("send --help: --steer lands after the current tool calls; --interrupt stops the run", async () => {
    const r = await runCli(["agent", "send", "--help"], dbPath);
    const help = r.stdout.replace(/\s+/g, " ");
    expect(help).not.toMatch(/--steer[^-]*interrupt the current run/);
    expect(help).toContain("deliver after the current tool calls finish");
    expect(help).toMatch(/--interrupt .*abort/);
  });

  it("docs and skill: no line pairs --steer with interrupting", () => {
    for (const f of [
      "docs/guide/dispatch.md",
      "skills/mu/SKILL.md",
      "skills/mu/recipes/orchestrator-loop.md",
    ]) {
      const lines = readFileSync(f, "utf8").split("\n");
      expect(lines.filter((l) => /--steer/.test(l) && /\binterrupt the/.test(l))).toEqual([]);
    }
  });
});
