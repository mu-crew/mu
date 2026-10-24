// CLI-level tests for `mu agent send`.
//
// The non-pi test sends to an agent only herdr can reach (one atomic
// `agent prompt`), so it runs against a mocked herdr.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;
let calls: readonly (readonly string[])[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-send-"));
  process.env.MU_STATE_DIR = join(tempDir, "state");
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  // A non-pi CLI: a pi agent would need a control socket (see test/agent-transport.test.ts).
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "w1:p1", cli: "claude" });
  const seen: string[][] = [];
  calls = seen;
  setSleepForTests(async () => {});
  setTmuxExecutor(async (args) => {
    seen.push([...args]);
    return { stdout: "", stderr: "", exitCode: 0 };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    db.close();
  } catch {}
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

describe("mu agent send to a non-pi agent (herdr)", () => {
  let herdr: MuxHarness;
  beforeEach(() => {
    herdr = installMux("herdr", [["agent prompt", "{}"]]);
    calls = herdr.calls;
  });
  afterEach(() => herdr.restore());

  it("sends through the multiplexer with no staleness field", async () => {
    const { exitCode, data, stderr, error } = await runCliJson<{
      staleness?: unknown;
      transport: string;
    }>(["agent", "send", "worker-1", "hello", "-w", "auth", "--json"], dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    const out = data;
    expect(out.staleness).toBeUndefined();
    expect(out.transport).toBe("mux");
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["agent prompt w1:p1"]);
  });
});

describe("mu agent send to a pi agent", () => {
  beforeEach(() => {
    insertAgent(db, { name: "pi-1", workstream: "auth", paneId: "%2", cli: "pi" });
    // The pane is alive (paneAlive echoes the id) but has no control
    // socket: the ctl-unreachable case, not a dead pane.
    setTmuxExecutor(async (args) => {
      (calls as string[][]).push([...args]);
      const live = args[0] === "display-message" && args.includes("#{pane_id}");
      return { stdout: live ? "%2\n" : "", stderr: "", exitCode: 0 };
    });
  });

  it("fails loud when the control socket is missing, without pasting", async () => {
    const { exitCode, doc } = await runCliJson(
      ["agent", "send", "pi-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(1);
    const env = doc as unknown as { error: string; nextSteps: { command: string }[] };
    expect(env.error).toBe("AgentCtlUnreachableError");
    expect(env.nextSteps.some((s) => s.command === "pi install npm:@mu-crew/mu")).toBe(true);
    expect(calls.filter((c) => c[0] === "paste-buffer")).toEqual([]);
  });

  it("a pi agent whose pane is gone reports a dead agent, not ctl unreachable", async () => {
    setTmuxExecutor(async (args) => {
      (calls as string[][]).push([...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const { exitCode, doc } = await runCliJson(
      ["agent", "send", "pi-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(1);
    const env = doc as unknown as { error: string; nextSteps: { command: string }[] };
    expect(env.error).toBe("AgentPaneDeadError");
    expect(env.nextSteps.some((s) => s.command === "pi install npm:@mu-crew/mu")).toBe(false);
    expect(calls.filter((c) => c[0] === "paste-buffer")).toEqual([]);
  });

  it("runs /new over the control socket: fails loud without one, never pastes", async () => {
    const { exitCode, doc } = await runCliJson(
      ["agent", "send", "pi-1", "/new", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(1);
    expect((doc as unknown as { error: string }).error).toBe("AgentCtlUnreachableError");
    expect(calls.map((c) => c[0])).not.toContain("paste-buffer");
  });
});
