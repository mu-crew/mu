import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeState, StateReading } from "../src/agent-state.js";
import { insertAgent, WorkspaceOwnerBusyError } from "../src/agents.js";
import { cmdWorkspaceFree } from "../src/cli/workspace.js";
import { type Db, openDb } from "../src/db.js";
import { gitBackend } from "../src/vcs.js";
import { freeWorkspace } from "../src/workspace.js";
import { installMux, type MuxHarness } from "./_mux.js";

let nextState: RuntimeState = "busy";
vi.mock("../src/agent-state.js", async (orig) => {
  const real = await orig<typeof import("../src/agent-state.js")>();
  return {
    ...real,
    readAgentStates: async (agents: readonly { name: string; workstreamName: string }[]) =>
      new Map(
        agents.map((a): [string, StateReading] => [
          real.agentKey(a),
          { state: nextState, source: "ctl", since: null, alive: true },
        ]),
      ),
  };
});

let tempDir: string;
let db: Db;
let mux: MuxHarness;
let wsPath: string;
let paneLive = true;
let probeThrows = false;
let probeStderr: string | undefined;

function workspaceRows(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM vcs_workspaces").get() as { n: number }).n;
}

beforeEach(() => {
  // Fast tier spawns no git: the guard is under test, not the teardown.
  vi.spyOn(gitBackend, "freeWorkspace").mockResolvedValue({ removed: true });
  tempDir = mkdtempSync(join(tmpdir(), "mu-free-guard-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  insertAgent(db, { name: "w1", workstream: "ws", paneId: "%7" });
  wsPath = join(tempDir, "w1-ws");
  mkdirSync(wsPath);
  db.prepare(
    `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
     SELECT a.id, a.workstream_id, 'git', ?, NULL, '2026-01-01T00:00:00Z' FROM agents a WHERE a.name = 'w1'`,
  ).run(wsPath);
  paneLive = true;
  probeThrows = false;
  probeStderr = undefined;
  mux = installMux("tmux", async () => {
    if (probeThrows) throw new Error("probe boom");
    if (probeStderr !== undefined) return { stdout: "", stderr: probeStderr, exitCode: 1 };
    return {
      stdout: paneLive ? "%7\n" : "",
      stderr: "",
      exitCode: 0,
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  mux.restore();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const free = (force = false) => cmdWorkspaceFree(db, "w1", { workstream: "ws", force, json: true });

describe("mu workspace free owner-state guard", () => {
  it.each(["busy", "needs_permission"] as const)("refuses when owner is %s", async (s) => {
    nextState = s;
    await expect(free()).rejects.toBeInstanceOf(WorkspaceOwnerBusyError);
    expect(workspaceRows()).toBe(1);
  });

  it("refuses unknown with a live pane", async () => {
    nextState = "unknown";
    await expect(free()).rejects.toBeInstanceOf(WorkspaceOwnerBusyError);
    expect(workspaceRows()).toBe(1);
  });

  it("fails closed when tmux exits nonzero for a reason other than a gone pane", async () => {
    nextState = "unknown";
    probeStderr = "error connecting to /tmp/tmux-501/default (Permission denied)";
    const err = await free().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceOwnerBusyError);
    expect(workspaceRows()).toBe(1);
  });

  it("allows free when tmux reports the pane gone", async () => {
    nextState = "unknown";
    probeStderr = "can't find pane: %7";
    await free();
    expect(workspaceRows()).toBe(0);
  });

  it("fails closed when the liveness probe throws", async () => {
    nextState = "unknown";
    probeThrows = true;
    const err = await free().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceOwnerBusyError);
    expect((err as WorkspaceOwnerBusyError).detail).toMatch(/liveness probe failed/);
    expect(workspaceRows()).toBe(1);
  });

  it("allows needs_input", async () => {
    nextState = "needs_input";
    await free();
    expect(workspaceRows()).toBe(0);
  });

  it("allows unknown with a dead pane", async () => {
    nextState = "unknown";
    paneLive = false;
    await free();
    expect(workspaceRows()).toBe(0);
  });

  it("--force skips the check", async () => {
    nextState = "busy";
    await free(true);
    expect(workspaceRows()).toBe(0);
  });

  it("the SDK (agent close, spawn rollback) is not guarded", async () => {
    nextState = "busy";
    const r = await freeWorkspace(db, "w1", { workstream: "ws" });
    expect(r.rowDeleted).toBe(true);
  });
});
