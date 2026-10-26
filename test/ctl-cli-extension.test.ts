// Contract: the CLI verbs against the REAL extension (extension/mu-pi.ts on a
// fake pi), not a hand-written fake. If the extension's replies drift from
// what `send`, `check`, `wait --inc` and the served-ops check expect, this
// fails where the fakes would not.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import muPi, { type MuPiContext } from "../extension/mu-pi.js";
import { insertAgent, sendToAgent } from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

type Handler = (event: unknown, ctx: MuPiContext) => unknown;

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let emit: (event: string) => Promise<void>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cce-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
  setSleepForTests(async () => {});
  mux = installMux("tmux", async (args) => ({
    stdout: args[0] === "display-message" ? "%1\n" : "",
    stderr: "",
    exitCode: 0,
  }));
  const sock = ctlSocketPath("auth", "worker-1", dir);
  mkdirSync(dirname(sock), { recursive: true });
  process.env.MU_CTL_SOCK = sock;
  process.env.MU_MANAGED_AGENT = "1";
  process.env.MU_AGENT_NAME = "worker-1";
  process.env.MU_WORKSTREAM = "auth";
  const handlers = new Map<string, Handler[]>();
  const ctx = { isIdle: () => true, hasPendingMessages: () => false, abort: vi.fn() };
  muPi({
    on(e: string, h: Handler) {
      handlers.set(e, [...(handlers.get(e) ?? []), h]);
      return () => {};
    },
    sendUserMessage: vi.fn(async () => {}),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    events: { emit: vi.fn() },
  } as never);
  emit = async (event) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event }, ctx as never);
  };
  await emit("session_start");
});

afterEach(async () => {
  await emit("session_shutdown");
  for (const k of ["MU_CTL_SOCK", "MU_MANAGED_AGENT", "MU_AGENT_NAME", "MU_WORKSTREAM"])
    delete process.env[k];
  mux.restore();
  resetSleep();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CLI against the real extension", () => {
  it("send returns msgId + incarnation + runs; check confirms the same msgId; the wait hint names both", async () => {
    const r = await runCliJson(["agent", "send", "worker-1", "go", "-w", "auth", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const out = r.data as {
      msgId: string;
      incarnation: string;
      runs: number;
      nextSteps: { command: string }[];
    };
    expect(out.msgId).toHaveLength(36);
    expect(out.incarnation).toMatch(/\S/);
    expect(out.runs).toBe(0);
    expect(out.nextSteps[0]?.command).toBe(`mu wait 'agent:auth/worker-1@0#${out.incarnation}'`);
    const check = await runCli(["agent", "check", "worker-1", out.msgId, "-w", "auth"], dbPath);
    expect(check.exitCode).toBeNull();
    expect(check.stdout).toMatch(/^accepted runs=0 at=\d{4}-\d\d-\d\dT/);
    const never = await runCli(["agent", "check", "worker-1", "never-sent", "-w", "auth"], dbPath);
    expect(never.exitCode).toBe(3);
    expect(never.stdout.trim()).toBe("not-accepted");
  });

  it("wait --inc with the real incarnation settles; with another it is AgentRestartedError (exit 4)", async () => {
    const sent = await sendToAgent(db, "worker-1", "go", { workstream: "auth" });
    const inc = sent.incarnation ?? "";
    await emit("agent_start");
    await emit("agent_settled");
    const ok = await runCliJson(
      [
        "agent",
        "wait",
        "worker-1",
        "-w",
        "auth",
        "--after-runs",
        "0",
        "--inc",
        inc,
        "--timeout",
        "5",
        "--json",
      ],
      dbPath,
    );
    expect(ok.exitCode).toBeNull();
    expect(ok.data.agents[0]).toMatchObject({ fired: true });
    const stale = await runCliJson(
      [
        "agent",
        "wait",
        "worker-1",
        "-w",
        "auth",
        "--after-runs",
        "0",
        "--inc",
        "inc-from-an-old-pi",
        "--timeout",
        "5",
        "--json",
      ],
      dbPath,
    );
    expect(stale.exitCode).toBe(4);
    expect(stale.doc).toMatchObject({ error: "AgentRestartedError" });
    expect(stale.doc.message).toContain(`inc-from-an-old-pi → ${inc}`);
  });
});
