// `mu orchestrate` and what an orchestrator's identity changes (spec D9, D10,
// U7): its pane carries MU_ORCHESTRATOR=1 and MU_AGENT_CLI, so a pi keeps
// `mu_delegate`, gets no close nudge and no implicit -w; nothing it starts
// inherits the flag; a hook harness starts through the anchor wrapper; and no
// agent ever starts a tmux server. Fake tmux (mockTmux): no real panes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { delegateEnabled } from "../extension/delegate.js";
import {
  getAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { anchorDir } from "../src/anchors.js";
import { injectedIdentity, injectedWorkstream } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import { delegateChildEnv } from "../src/delegate-process.js";
import { herdrBackend, rexBackend, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { LOCAL_ONLY_ENV } from "../src/remote-agent.js";
import { resetSleep, setSleepForTests, TmuxServerInAgentError } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson, runCliWire } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
/** While true, the fake tmux answers `has-session` as a machine with no server running. */
let serverDown: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-orch-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  state = freshMockState();
  serverDown = false;
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    if (serverDown && args[0] === "has-session") {
      return { stdout: "", stderr: "no server running on /tmp/tmux-501/default", exitCode: 1 };
    }
    if (args[0] === "new-session") serverDown = false;
    return fake(args);
  });
});

afterEach(() => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  const key = "MU_SPAWN_LIVENESS_MS";
  delete process.env[key];
  db.close();
  rmFixtureDir(dir);
});

/** The tmux call that created `name`'s pane. */
function paneCall(name: string): readonly string[] {
  const call = mux.calls.find(
    (c) =>
      ["new-session", "new-window", "split-window"].includes(c[0] ?? "") &&
      c.includes(`MU_AGENT_NAME=${name}`),
  );
  if (call === undefined) throw new Error(`no pane call for ${name}`);
  return call;
}

/** The `-e K=V` env of `name`'s pane. */
function paneEnv(name: string): Record<string, string> {
  const args = paneCall(name);
  return Object.fromEntries(
    args.flatMap((a, i) =>
      args[i - 1] === "-e" ? [a.split(/=(.*)/s).slice(0, 2) as [string, string]] : [],
    ),
  );
}

/** The command `name`'s pane runs: the last argument of its creating call. */
const paneCommand = (name: string): string => paneCall(name).at(-1) ?? "";

/** Run `fn` with every key of `env` set (undefined deletes), restoring after. */
async function asEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const keys = Object.keys(env);
  const run = async (i: number): Promise<void> => {
    const key = keys[i];
    if (key === undefined) return fn();
    await withEnv(key, env[key], () => run(i + 1));
  };
  await run(0);
}

describe("mu orchestrate", () => {
  it("starts a pi orchestrator whose pane keeps mu_delegate; its workers and delegates do not get it", async () => {
    const r = await runCliJson(["orchestrate", "-w", "auth", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({
      orchestrator: true,
      caller: "auth/orchestrator-1",
      agent: { name: "orchestrator-1", cli: "pi" },
    });
    const orch = paneEnv("orchestrator-1");
    expect(orch).toMatchObject({
      MU_MANAGED_AGENT: "1",
      MU_WORKSTREAM: "auth",
      MU_AGENT_NAME: "orchestrator-1",
      MU_AGENT_CLI: "pi",
      MU_ORCHESTRATOR: "1",
    });
    expect(delegateEnabled(orch)).toBe(true);
    // pi keeps its plain command: no anchor wrapper.
    expect(paneCommand("orchestrator-1")).toBe("pi");

    // What the orchestrator starts, from inside its pane: a worker spawn builds the pane env
    // afresh, and a mux-free delegate's child pi has the flag removed.
    await asEnv(orch, async () => {
      await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    });
    const worker = paneEnv("worker-1");
    expect(worker.MU_ORCHESTRATOR).toBeUndefined();
    expect(worker.MU_MANAGED_AGENT).toBe("1");
    expect(delegateEnabled(worker)).toBe(false);
    expect(getAgent(db, "worker-1", "auth")?.spawner).toBe("auth/orchestrator-1");
    const child = delegateChildEnv(orch, { MU_MANAGED_AGENT: "1", MU_AGENT_NAME: "d1" });
    expect(child.MU_ORCHESTRATOR).toBeUndefined();
    expect(delegateEnabled(child)).toBe(false);
    // A remote pane unsets it too.
    expect(LOCAL_ONLY_ENV).toContain("MU_ORCHESTRATOR");
  });

  it("takes the next free name when none is given, and a named one exactly", async () => {
    expect(
      (await runCliJson(["orchestrate", "-w", "auth", "--json"], dbPath)).data.agent.name,
    ).toBe("orchestrator-1");
    expect(
      (await runCliJson(["orchestrate", "-w", "auth", "--json"], dbPath)).data.agent.name,
    ).toBe("orchestrator-2");
    const named = await runCliWire(
      ["orchestrate", "-w", "auth", "--name", "orchestrator-1"],
      dbPath,
    );
    expect(named.exitCode).not.toBeNull();
    expect(named.stdout + named.stderr).toContain("orchestrator-1");
  });

  it("an orchestrator gets no implicit -w, and keeps its explicit identity", async () => {
    const identity = { MU_MANAGED_AGENT: "1", MU_WORKSTREAM: "auth", MU_AGENT_NAME: "orch-1" };
    await asEnv({ ...identity, MU_ORCHESTRATOR: undefined }, async () => {
      expect(injectedWorkstream()).toBe("auth");
    });
    await asEnv({ ...identity, MU_ORCHESTRATOR: "1" }, async () => {
      expect(injectedWorkstream()).toBeUndefined();
      expect(injectedIdentity()).toEqual({ name: "orch-1", workstream: "auth" });
    });
  });
});

describe("anchors: a hook harness starts through the wrapper (spec D3)", () => {
  it("a claude worker's pane writes its anchor, then runs claude", async () => {
    await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "claude" });
    const cmd = paneCommand("worker-1");
    expect(cmd.startsWith("exec /bin/sh -c ")).toBe(true);
    expect(cmd.endsWith(" mu-anchor 'claude'")).toBe(true);
    expect(cmd).toContain(anchorDir());
    expect(cmd).toContain(
      '{"agent_name":"worker-1","workstream":"auth","role":"worker","cli":"claude","orchestrator":false,"remote_key":null,"start_time":',
    );
    expect(paneEnv("worker-1").MU_AGENT_CLI).toBe("claude");
    // The row keeps the command the user asked for.
    expect(getAgent(db, "worker-1", "auth")?.command).toBe("claude");
  });

  it("an orchestrator's anchor says so, and a cli key maps to its harness", async () => {
    await withEnv("MU_CODEX_FAST_COMMAND", "codex -m fast", async () => {
      const r = await runCliJson(
        ["orchestrate", "-w", "auth", "--cli", "codex-fast", "--json"],
        dbPath,
      );
      expect(r.exitCode).toBeNull();
    });
    const cmd = paneCommand("orchestrator-1");
    expect(cmd).toContain('"role":"orchestrator","cli":"codex","orchestrator":true');
    expect(cmd.endsWith(" mu-anchor 'codex -m fast'")).toBe(true);
    expect(paneEnv("orchestrator-1")).toMatchObject({
      MU_AGENT_CLI: "codex",
      MU_ORCHESTRATOR: "1",
    });
  });

  it("only tmux anchors: a claude pane on a backend without a hook reader keeps its plain command", async () => {
    expect(tmuxBackend.anchorsPanes).toBe(true);
    expect(rexBackend.anchorsPanes).toBe(false);
    expect(herdrBackend.anchorsPanes).toBe(false);
    // tmux's functions on the installed fake executor, with Rex's capability.
    const previous = setMuxForTests({ ...tmuxBackend, anchorsPanes: false });
    try {
      await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "claude" });
    } finally {
      setMuxForTests(previous);
    }
    expect(paneCommand("worker-1")).toBe("claude");
    expect(paneEnv("worker-1").MU_AGENT_CLI).toBe("claude");
  });

  it("a CLI outside the blessed five runs as before, with its key as MU_AGENT_CLI", async () => {
    await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "opencode" });
    expect(paneCommand("worker-1")).toBe("opencode");
    expect(paneEnv("worker-1").MU_AGENT_CLI).toBe("opencode");
  });
});

describe("the tmux server is born outside every agent (spec D10)", () => {
  it.each([
    ["Claude Code", { CLAUDECODE: "1" }],
    ["Codex", { CODEX_THREAD_ID: "t-1" }],
    ["a mu-managed agent", { MU_MANAGED_AGENT: "1" }],
  ])("inside %s with no server running, spawn fails typed and starts nothing", async (_, env) => {
    serverDown = true;
    ensureWorkstream(db, "auth");
    await asEnv(env, async () => {
      await expect(spawnAgent(db, { name: "worker-1", workstream: "auth" })).rejects.toBeInstanceOf(
        TmuxServerInAgentError,
      );
    });
    expect(mux.calls.some((c) => c[0] === "new-session")).toBe(false);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("the CLI maps it to exit 5 with the typed error and the way out", async () => {
    serverDown = true;
    await asEnv({ CLAUDECODE: "1" }, async () => {
      const r = await runCliWire(["agent", "spawn", "worker-1", "-w", "auth", "--json"], dbPath);
      expect(r.exitCode).toBe(5);
      const doc = JSON.parse(r.stdout) as { error: string; message: string };
      expect(doc.error).toBe("TmuxServerInAgentError");
      expect(doc.message).toContain("Start tmux from a terminal");
    });
  });

  it("outside an agent the server starts; inside one a running server is used", async () => {
    serverDown = true;
    await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(mux.calls.some((c) => c[0] === "new-session")).toBe(true);
    // The server runs now (the session is missing in another workstream): an agent may spawn.
    await asEnv({ CLAUDECODE: "1" }, async () => {
      await spawnAgent(db, { name: "worker-2", workstream: "other" });
    });
    expect(getAgent(db, "worker-2", "other")).toBeDefined();
  });
});
