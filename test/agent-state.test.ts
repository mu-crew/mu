import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentKey,
  ambiguousReason,
  murmurAvailable,
  resetAgentStateCacheForTests,
  type StateAgentRef,
  setMurmurRunnerForTests,
  UNKNOWN_REASON,
} from "../src/agent-state.js";
import { readAgentStates } from "../src/channels/index.js";
import { type MuxBackend, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { withEnv } from "./_env.js";

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
    ["error", "needs_input"],
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

  it("a murmur status that timed out reads as its own explained unknown, never no row or missing", async () => {
    tmuxOutput("%1\t\t");
    installMurmur();
    linkExtension();
    setMurmurRunnerForTests(async () => ({ timedOut: true }));

    expect((await reading()).get(agentKey(agent))).toEqual({
      state: "unknown",
      source: "none",
      since: null,
      alive: true,
      reason: UNKNOWN_REASON.murmurTimeout,
    });
    expect(UNKNOWN_REASON.murmurTimeout).toContain("timed out after 10s");
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
      paneAlive: async () => true,
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
      paneAlive: async () => false,
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

describe("murmurAvailable(cli): per harness (spec D13)", () => {
  const originalHookHome = process.env.MURMUR_HOOK_HOME;
  beforeEach(() => {
    process.env.MURMUR_HOOK_HOME = join(tempDir, "home");
  });
  afterEach(() => {
    if (originalHookHome === undefined) delete process.env.MURMUR_HOOK_HOME;
    else process.env.MURMUR_HOOK_HOME = originalHookHome;
  });

  /** One hook config file under the hook home, as `murmur init` (or a user) wrote it. */
  function hookFile(rel: string, root: unknown): void {
    const file = join(tempDir, "home", rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(root));
  }
  const grouped = (command: string) => ({
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command }] }] },
  });

  it("claude hooks installed: claude is available, a missing pi extension is not hidden", async () => {
    installMurmur();
    hookFile(".claude/settings.json", grouped("murmur hook claude"));
    expect(murmurAvailable("claude")).toBe(true);
    expect(murmurAvailable("pi")).toBe(false);
    expect(murmurAvailable()).toBe(false);
    const { murmurDoctorCheck } = await import("../src/doctor-summary.js");
    const check = murmurDoctorCheck("murmur");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(UNKNOWN_REASON.extensionMissing);
  });

  it("the pi extension alone leaves a claude agent without murmur", () => {
    installMurmur();
    linkExtension();
    expect(murmurAvailable("pi")).toBe(true);
    expect(murmurAvailable("claude")).toBe(false);
    expect(murmurAvailable("codex")).toBe(false);
  });

  it("only murmur's own handler counts, in the harness's own file and shape", () => {
    installMurmur();
    hookFile(".claude/settings.json", grouped("museum hook claude"));
    hookFile(".codex/hooks.json", grouped("murmur hook claude"));
    expect(murmurAvailable("claude")).toBe(false);
    expect(murmurAvailable("codex")).toBe(false);
    hookFile(".cursor/hooks.json", {
      version: 1,
      hooks: { stop: [{ command: "murmur hook cursor-agent" }] },
    });
    hookFile(".config/muse/settings.json", grouped("  murmur hook muse"));
    expect(murmurAvailable("cursor-agent")).toBe(true);
    expect(murmurAvailable("muse")).toBe(true);
  });

  it("a cli key maps to its harness, and murmur off PATH is never available", () => {
    hookFile(".claude/settings.json", grouped("murmur hook claude"));
    expect(murmurAvailable("claude-big")).toBe(false);
    installMurmur();
    expect(murmurAvailable("claude-big")).toBe(true);
  });

  it("claude's and codex's entries count where CLAUDE_CONFIG_DIR and CODEX_HOME move them", async () => {
    installMurmur();
    hookFile(".claude/settings.json", grouped("murmur hook claude"));
    hookFile("moved-codex/hooks.json", grouped("murmur hook codex"));
    await withEnv("CODEX_HOME", join(tempDir, "home", "moved-codex"), async () => {
      expect(murmurAvailable("codex")).toBe(true);
      await withEnv("CLAUDE_CONFIG_DIR", join(tempDir, "home", "moved-claude"), async () => {
        // murmur writes claude's entries into the moved directory, not ~/.claude
        expect(murmurAvailable("claude")).toBe(false);
        hookFile("moved-claude/settings.json", grouped("murmur hook claude"));
        expect(murmurAvailable("claude")).toBe(true);
      });
      // an empty value is unset
      await withEnv("CLAUDE_CONFIG_DIR", "", async () => {
        expect(murmurAvailable("claude")).toBe(true);
      });
    });
    expect(murmurAvailable("codex")).toBe(false);
  });

  it("an unreported claude agent reads `hooks not installed`, a pi agent `extension not linked`", async () => {
    installMurmur();
    tmuxOutput("%1\t\t\n%2\t\t");
    setMurmurRunnerForTests(async () => null);
    const claude: StateAgentRef = {
      name: "w2",
      workstreamName: "demo",
      paneId: "%2",
      cli: "claude",
    };
    const got = await readAgentStates([agent, claude]);
    expect(got.get(agentKey(agent))?.reason).toBe(UNKNOWN_REASON.extensionMissing);
    expect(got.get(agentKey(claude))?.reason).toBe(UNKNOWN_REASON.hooksMissing);
  });

  it("murmur answering with no row still names the harness's missing wiring", async () => {
    installMurmur();
    linkExtension();
    tmuxOutput("%1\t\t\n%2\t\t");
    setMurmurRunnerForTests(async () => JSON.stringify({ panes: [] }));
    const claude: StateAgentRef = {
      name: "w2",
      workstreamName: "demo",
      paneId: "%2",
      cli: "claude",
    };
    let got = await readAgentStates([agent, claude]);
    expect(got.get(agentKey(agent))?.reason).toBe(UNKNOWN_REASON.noRow);
    expect(got.get(agentKey(claude))?.reason).toBe(UNKNOWN_REASON.hooksMissing);

    // claude hooks installed, the pi extension gone: the claude pane simply has no row yet.
    hookFile(".claude/settings.json", grouped("murmur hook claude"));
    rmSync(join(tempDir, "pi"), { recursive: true, force: true });
    resetAgentStateCacheForTests();
    got = await readAgentStates([agent, claude]);
    expect(got.get(agentKey(agent))?.reason).toBe(UNKNOWN_REASON.extensionMissing);
    expect(got.get(agentKey(claude))?.reason).toBe(UNKNOWN_REASON.noRow);
  });
});
