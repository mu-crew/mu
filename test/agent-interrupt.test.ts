// mu agent send --interrupt: abort a busy pi, wait for settle, then send.
// A real unix-socket server at the derived path stands in for the mu pi
// extension (op order of the real one: extension-mu-pi.test.ts); the mux
// is the fake tmux harness, so a paste would show up in its calls.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
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
let ops: Record<string, unknown>[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mai-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  servers = [];
  ops = [];
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

/**
 * Fake extension, busy at runs 3. `hasInterrupt` false plays an extension
 * that predates the op. `settles` false: an abort never settles.
 */
async function serve(opts: { hasInterrupt: boolean; busy?: boolean; settles?: boolean }) {
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
        const req = JSON.parse(line) as { op: string; afterRuns?: number; timeoutMs?: number };
        ops.push(req);
        const status = () => ({ state, since: 0, runs, pending: true });
        const reply = (r: object) => sock.end(encode({ v: 1, ...r }));
        if (req.op === "interrupt" && opts.hasInterrupt) {
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
  runCli(["agent", "send", "worker-1", ...args, "-w", "auth", "--json"], dbPath);

const opNames = () => ops.map((o) => o.op);
const pasted = () => mux.calls.some((c) => c[0] === "paste-buffer");

describe("mu agent send --interrupt", () => {
  it("busy: one interrupt op; reports was busy, pending, and the post-abort wait baseline", async () => {
    seed();
    await serve({ hasInterrupt: true });
    const r = await send("--interrupt", "stop, do X");
    expect(r.exitCode).toBeNull();
    expect(ops).toEqual([{ op: "interrupt", text: "stop, do X", timeoutMs: 30_000 }]);
    const body = JSON.parse(r.stdout) as Record<string, unknown> & {
      nextSteps: Array<{ command: string }>;
    };
    expect(body).toMatchObject({ transport: "ctl", wasBusy: true, pending: true, runs: 4 });
    expect(body.nextSteps.map((s) => s.command)).toContain(
      "mu agent wait worker-1 --after-runs 4 --json -w auth",
    );
    expect(pasted()).toBe(false);
  });

  it("human output says queued messages went back to the editor", async () => {
    seed();
    await serve({ hasInterrupt: true });
    const r = await runCli(
      ["agent", "send", "worker-1", "--interrupt", "go", "-w", "auth"],
      dbPath,
    );
    expect(r.stdout).toMatch(/interrupted a busy run/);
    expect(r.stdout).toMatch(/queued messages went back to the pane's editor/);
  });

  it("idle: just sends", async () => {
    seed();
    await serve({ hasInterrupt: true, busy: false });
    const r = await send("--interrupt", "hi");
    expect(r.exitCode).toBeNull();
    expect(JSON.parse(r.stdout)).toMatchObject({ wasBusy: false, runs: 3 });
  });

  it("--timeout reaches the op in ms", async () => {
    seed();
    await serve({ hasInterrupt: true, busy: false });
    await send("--interrupt", "--timeout", "2", "hi");
    expect(ops[0]).toMatchObject({ op: "interrupt", timeoutMs: 2000 });
  });

  it("settle timeout: exit 5, kick hint", async () => {
    seed();
    await serve({ hasInterrupt: true, settles: false });
    const r = await send("--interrupt", "--timeout", "0.1", "x");
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain("mu agent kick worker-1");
  });

  it("old extension (no interrupt op): falls back to abort, settle, then send; never pastes", async () => {
    seed();
    await serve({ hasInterrupt: false });
    const r = await send("--interrupt", "stop");
    expect(r.exitCode).toBeNull();
    expect(opNames()).toEqual(["interrupt", "status", "abort", "wait", "send"]);
    expect(ops.at(-1)).toMatchObject({ op: "send", text: "stop" });
    expect(JSON.parse(r.stdout)).toMatchObject({ wasBusy: true, pending: true, runs: 4 });
    expect(pasted()).toBe(false);
  });

  it("old extension, idle: falls back to a plain send", async () => {
    seed();
    await serve({ hasInterrupt: false, busy: false });
    const r = await send("--interrupt", "hi");
    expect(opNames()).toEqual(["interrupt", "status", "send"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ wasBusy: false, runs: 3 });
  });

  it("old extension, settle timeout: exit 5 and the text is not sent", async () => {
    seed();
    await serve({ hasInterrupt: false, settles: false });
    const r = await send("--interrupt", "--timeout", "0.1", "x");
    expect(r.exitCode).toBe(5);
    expect(opNames()).not.toContain("send");
    expect(pasted()).toBe(false);
  });

  it.each([
    [["--fresh"], /--interrupt and --fresh are mutually exclusive/],
    [["--steer"], /--interrupt and --steer are mutually exclusive/],
    [["--via", "mux"], /--interrupt and --via mux are mutually exclusive/],
  ])("exclusive with %j: exit 2, nothing sent", async (flags, msg) => {
    seed();
    await serve({ hasInterrupt: true });
    const r = await send("--interrupt", ...flags, "x");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(msg);
    expect(ops).toEqual([]);
    expect(pasted()).toBe(false);
  });

  it("slash-command text: exit 2", async () => {
    seed();
    await serve({ hasInterrupt: true });
    const r = await send("--interrupt", "/new");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--interrupt sends a prompt, not a slash command/);
    expect(ops).toEqual([]);
  });

  it("--timeout without --interrupt: exit 2", async () => {
    seed();
    await serve({ hasInterrupt: true });
    const r = await send("--timeout", "3", "x");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--timeout only applies with --interrupt/);
  });

  it("non-pi agent: exit 2 pointing at kick, never pastes", async () => {
    seed("claude");
    const r = await send("--interrupt", "x");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("mu agent kick");
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
