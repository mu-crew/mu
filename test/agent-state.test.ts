import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentKey,
  ambiguousReason,
  murmurAvailable,
  readAgentStates,
  resetAgentStateCacheForTests,
  type StateAgentRef,
  setMurmurRunnerForTests,
  UNKNOWN_REASON,
} from "../src/agent-state.js";
import { type MuxBackend, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";

const agent: StateAgentRef = { name: "worker-1", workstreamName: "demo", paneId: "%1" };
const originalPath = process.env.PATH;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
let tempDir: string;

function tmuxOutput(stdout: string): void {
  setTmuxExecutor(async () => ({ stdout, stderr: "", exitCode: 0 }));
}

function reading(): ReturnType<typeof readAgentStates> {
  return readAgentStates([agent]);
}

function remoteRow(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    panes: [
      {
        pane: "%remote",
        local: false,
        agent_name: "worker-1",
        workstream: "demo",
        driver: "pi",
        activity: "running",
        attention: [],
        freshness: "fresh",
        updated_at: 1_790_000_000_123,
        ...overrides,
      },
    ],
  });
}

function installMurmur(): void {
  const bin = join(tempDir, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "murmur");
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  process.env.PATH = bin;
}

function linkExtension(): void {
  const extensions = join(tempDir, "pi", "extensions");
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, "murmur.ts"), "");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-agent-state-"));
  process.env.PATH = join(tempDir, "empty-bin");
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi");
  setMuxForTests(tmuxBackend);
  resetAgentStateCacheForTests();
});

afterEach(() => {
  resetTmuxExecutor();
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
  setMuxForTests(undefined);
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("readAgentStates", () => {
  it("maps a local working state and its since time", async () => {
    tmuxOutput("%1\tworking\t1790000000000");

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "busy",
      source: "murmur",
      since: 1_790_000_000_000,
      alive: true,
    });
  });

  it.each([
    ["blocked", "needs_permission"],
    ["done", "needs_input"],
    ["idle", "needs_input"],
    ["crashed", "needs_input"],
  ] as const)("maps local %s to %s", async (token, state) => {
    tmuxOutput(`%1\t${token}\tbad-time`);

    expect((await reading()).get(agentKey(agent))).toEqual({
      state,
      source: "murmur",
      since: null,
      alive: true,
    });
  });

  it("reports a pane absent from the one tmux listing as gone", async () => {
    tmuxOutput("%2\tworking\t1790000000000");

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: false,
      reason: UNKNOWN_REASON.paneGone,
    });
  });

  it("uses one fresh matching remote row when the local option is empty", async () => {
    tmuxOutput("%1\t\t");
    setMurmurRunnerForTests(async () => remoteRow());

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "busy",
      source: "murmur",
      since: 1_790_000_000_123,
      alive: true,
    });
  });

  it("rejects ambiguous remote rows", async () => {
    tmuxOutput("%1\t\t");
    const row = JSON.parse(remoteRow()).panes[0];
    setMurmurRunnerForTests(async () => JSON.stringify({ panes: [row, row] }));

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: true,
      reason: ambiguousReason(2),
    });
  });

  it("rejects a stale remote row", async () => {
    tmuxOutput("%1\t\t");
    setMurmurRunnerForTests(async () => remoteRow({ freshness: "stale" }));

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: true,
      reason: UNKNOWN_REASON.stale,
    });
  });

  it("distinguishes a missing executable from a missing extension", async () => {
    tmuxOutput("%1\t\t");
    setMurmurRunnerForTests(async () => null);

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: true,
      reason: UNKNOWN_REASON.murmurMissing,
    });

    installMurmur();
    resetAgentStateCacheForTests();
    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: true,
      reason: UNKNOWN_REASON.extensionMissing,
    });
  });

  it("does not run murmur when every agent has a local state", async () => {
    tmuxOutput("%1\tworking\t1790000000000");
    let calls = 0;
    setMurmurRunnerForTests(async () => {
      calls += 1;
      return remoteRow();
    });

    await reading();
    expect(calls).toBe(0);
  });

  it("caches the remote read for 10 seconds", async () => {
    tmuxOutput("%1\t\t");
    let calls = 0;
    setMurmurRunnerForTests(async () => {
      calls += 1;
      return remoteRow();
    });

    await readAgentStates([agent], { now: 1_000 });
    await readAgentStates([agent], { now: 6_000 });
    expect(calls).toBe(1);
    await readAgentStates([agent], { now: 12_000 });
    expect(calls).toBe(2);
  });

  it("uses a mux backend's native pane status", async () => {
    const backend: MuxBackend = {
      ...tmuxBackend,
      name: "herdr",
      paneStatus: async () => "needs_permission",
      paneExists: async () => true,
    };
    setMuxForTests(backend);

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "needs_permission",
      source: "herdr",
      since: null,
      alive: true,
    });
  });

  it("checks pane existence when herdr reports no state", async () => {
    const backend: MuxBackend = {
      ...tmuxBackend,
      name: "herdr",
      paneStatus: async () => undefined,
      paneExists: async () => false,
    };
    setMuxForTests(backend);

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: false,
      reason: UNKNOWN_REASON.paneGone,
    });
  });

  it("returns unknown without treating a failed tmux read as pane death", async () => {
    setTmuxExecutor(async () => ({ stdout: "", stderr: "server unavailable", exitCode: 1 }));

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: true,
      reason: expect.stringMatching(/^tmux:/),
    });
  });
});

describe("murmurAvailable", () => {
  it("requires both the executable and pi extension", () => {
    expect(murmurAvailable()).toBe(false);
    installMurmur();
    expect(murmurAvailable()).toBe(false);
    linkExtension();
    expect(murmurAvailable()).toBe(true);
  });
});
