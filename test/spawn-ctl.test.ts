// Spawn injects MU_CTL_SOCK and handshakes with the mu pi extension.
// A real unix-socket server at the derived path stands in for the
// extension; the mux is the fake tmux harness.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentSpawnStartupError,
} from "../src/agents/errors.js";
import {
  getAgent,
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
  speaksMuCtl,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const ENV_KEYS = ["MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS"] as const;

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let servers: Server[];
let saved: Map<string, string | undefined>;

beforeEach(() => {
  // Short prefix: the socket path must fit macOS's 104-byte sun_path.
  dir = mkdtempSync(join(tmpdir(), "msc-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  servers = [];
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_SPAWN_CTL_MS = "300";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  setSleepForTests(async () => {});
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  mux = installMux("tmux", mockTmux(freshMockState()).executor);
});

afterEach(async () => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Stand-in for the mu pi extension: answers hello + status as idle. */
async function serveExtension(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      for (const _line of dec.push(chunk)) {
        sock.end(encode({ v: 1, ok: true, state: "idle", since: 1, runs: 0, pending: false }));
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

function sockFor(agent: string): string {
  return ctlSocketPath("auth", agent, dir);
}

function newSessionArgs(): readonly string[] {
  const call = mux.calls.find((c) => c[0] === "new-session");
  if (!call) throw new Error("no new-session call");
  return call;
}

/**
 * Install the fake mux; when `extensionFor` is set, a pane creation
 * starts the stand-in extension at that agent's socket, as pi would.
 */
function installPanes(extensionFor?: string): void {
  mux.restore();
  const fake = mockTmux(freshMockState()).executor;
  mux = installMux("tmux", async (args) => {
    const res = await fake(args);
    if (extensionFor !== undefined && args[0] === "new-session") {
      await serveExtension(sockFor(extensionFor));
    }
    return res;
  });
}

describe("spawn control socket", () => {
  it("injects MU_CTL_SOCK at the derived path and creates its directory", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    const args = newSessionArgs();
    const i = args.indexOf(`MU_CTL_SOCK=${sockFor("worker-1")}`);
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe("-e");
    expect(existsSync(dirname(sockFor("worker-1")))).toBe(true);
    expect(agent.ctlSocket).toBe(sockFor("worker-1"));
    expect(agent.ctl).toBe("skipped");
  });

  it("injects MU_CTL_SOCK for non-pi CLIs too, without a handshake", async () => {
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "claude" });
    expect(newSessionArgs()).toContain(`MU_CTL_SOCK=${sockFor("worker-1")}`);
    expect(agent.ctl).toBe("skipped");
  });

  it("reports ctl ok when the extension answers", async () => {
    installPanes("worker-1");
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(agent.ctl).toBe("ok");
  });

  it("reports ctl missing on timeout, without rolling back", async () => {
    const started = Date.now();
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(agent.ctl).toBe("missing");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("ctl: false skips the handshake", async () => {
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth", ctl: false });
    expect(agent.ctl).toBe("skipped");
  });

  it("clears a stale socket file left by an earlier agent of the same name", async () => {
    mkdirSync(dirname(sockFor("worker-1")), { recursive: true });
    writeFileSync(sockFor("worker-1"), "");
    await spawnAgent(db, { name: "worker-1", workstream: "auth", ctl: false });
    expect(existsSync(sockFor("worker-1"))).toBe(false);
  });
});

describe("spawn liveness for ctl agents (tmux)", () => {
  let sleeps: number[];
  let state: MockState;

  /**
   * Fake tmux driven by the spawn's own calls, no timers.
   * `scrollback`: what the new pane shows from the moment it exists.
   * `dieOnProbe`: the pane vanishes when spawn first asks whether it
   * exists, so a capture taken after that answer fails as on real tmux.
   */
  function installLivePanes(
    o: { extension?: boolean; scrollback?: string; dieOnProbe?: boolean } = {},
  ): void {
    mux.restore();
    state = freshMockState();
    const fake = mockTmux(state).executor;
    mux = installMux("tmux", async (args) => {
      if (o.dieOnProbe && args[0] === "display-message" && args.includes("#{pane_id}")) {
        state.panes.clear();
      }
      const res = await fake(args);
      if (args[0] === "new-session") {
        for (const pane of state.panes.values()) pane.scrollback = o.scrollback;
        if (o.extension) await serveExtension(sockFor("worker-1"));
      }
      return res;
    });
  }

  beforeEach(() => {
    sleeps = [];
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
  });

  it("a pi spawn whose socket answers skips the fixed liveness sleep", async () => {
    installLivePanes({ extension: true });
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(agent.ctl).toBe("ok");
    expect(sleeps).not.toContain(1500);
  });

  it("a pane dying during the handshake throws AgentDiedOnSpawnError with its scrollback and rolls back", async () => {
    process.env.MU_SPAWN_CTL_MS = "5000";
    installLivePanes({ dieOnProbe: true, scrollback: "fatal: instance lock held" });
    const started = Date.now();
    const err = await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentDiedOnSpawnError);
    expect((err as AgentDiedOnSpawnError).scrollback).toBe("fatal: instance lock held");
    expect((err as Error).message).toContain("fatal: instance lock held");
    // The ctl path can die anywhere in the handshake budget, not "within 1500ms".
    expect((err as Error).message).toContain("during the ctl handshake (up to 5000ms");
    expect((err as Error).message).not.toContain("within 1500ms");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("scans for a startup error once the handshake times out, and rolls back", async () => {
    installLivePanes({ scrollback: "Error: No API key found for amazon-bedrock" });
    const err = await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentSpawnStartupError);
    expect((err as Error).message).toContain("during the ctl handshake (up to 300ms");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("scans for a startup error after an ok handshake, and rolls back", async () => {
    installLivePanes({ extension: true, scrollback: "Error: No API key found for amazon-bedrock" });
    const err = await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentSpawnStartupError);
    expect((err as AgentSpawnStartupError).matchedLine).toContain("No API key found");
    expect((err as Error).message).not.toContain("within 1500ms");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(state.panes.size).toBe(0);
  });

  it("after an ok handshake, exec-failure text in the tail (resumed session output) is not a startup error", async () => {
    installLivePanes({
      extension: true,
      scrollback: "$ grep foo src/doctor.ts\ngrep: src/doctor.ts: No such file or directory\n> ",
    });
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(agent.ctl).toBe("ok");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(state.panes.size).toBe(1);
  });

  it("without an answering socket, an exec-failure line still rolls back", async () => {
    installLivePanes({ scrollback: "sh: pi: command not found" });
    const err = await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentSpawnStartupError);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("MU_SPAWN_LIVENESS_MS=0 skips the pane check and the scan on the ctl path", async () => {
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    installLivePanes({
      dieOnProbe: true,
      scrollback: "Error: No API key found for amazon-bedrock",
    });
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(agent.ctl).toBe("missing");
    expect(sleeps).not.toContain(1500);
    expect(mux.calls.some((c) => c[0] === "capture-pane")).toBe(false);
    expect(mux.calls.some((c) => c[0] === "display-message" && c.includes("#{pane_id}"))).toBe(
      false,
    );
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("a non-ctl spawn still runs the fixed liveness check", async () => {
    installLivePanes();
    await spawnAgent(db, { name: "worker-1", workstream: "auth", cli: "claude" });
    expect(sleeps).toContain(1500);
  });

  it("ctl: false and MU_SPAWN_CTL_MS=0 keep the fixed liveness check", async () => {
    installLivePanes();
    await spawnAgent(db, { name: "worker-1", workstream: "auth", ctl: false });
    process.env.MU_SPAWN_CTL_MS = "0";
    await spawnAgent(db, { name: "worker-2", workstream: "auth" });
    expect(sleeps.filter((ms) => ms === 1500)).toHaveLength(2);
  });
});

describe("spawn of a name already taken", () => {
  it("parallel spawns of one name: the loser gets AgentExistsError and the winner keeps its row and pane", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    const state = freshMockState();
    mux.restore();
    mux = installMux("tmux", mockTmux(state).executor);
    const results = await Promise.allSettled([
      spawnAgent(db, { name: "worker-1", workstream: "auth" }),
      spawnAgent(db, { name: "worker-1", workstream: "auth" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(AgentExistsError);
    const winner = (won[0] as PromiseFulfilledResult<{ paneId: string }>).value;
    expect(getAgent(db, "worker-1", "auth")?.paneId).toBe(winner.paneId);
    expect([...state.panes.keys()]).toEqual([winner.paneId]);
  });

  it("insertAgent maps the UNIQUE (workstream, name) violation to AgentExistsError", () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
    expect(() => insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%2" })).toThrow(
      AgentExistsError,
    );
    expect(getAgent(db, "worker-1", "auth")?.paneId).toBe("%1");
  });
});

describe("speaksMuCtl", () => {
  it("matches the pi cli key or a pi / pi-meta argv0", () => {
    expect(speaksMuCtl("pi", "anything")).toBe(true);
    expect(speaksMuCtl("pi_big", "/opt/bin/pi-meta --no-solo")).toBe(true);
    expect(speaksMuCtl("x", "pi")).toBe(true);
    expect(speaksMuCtl("claude", "claude")).toBe(false);
    expect(speaksMuCtl("x", "pipx run")).toBe(false);
  });
});

describe("mu agent spawn (CLI)", () => {
  it("--json reports ctl ok and the socket path", async () => {
    db.close();
    installPanes("worker-1");
    const r = await runCli(["agent", "spawn", "worker-1", "-w", "auth", "--json"], dbPath);
    db = openDb({ path: dbPath });
    expect(r.exitCode ?? 0).toBe(0);
    const out = JSON.parse(r.stdout) as {
      ctl: string;
      ctlSocket: string;
      nextSteps: { command: string }[];
    };
    expect(out.ctl).toBe("ok");
    expect(out.ctlSocket).toBe(sockFor("worker-1"));
    expect(out.nextSteps[0]?.command).toBe("mu agent send worker-1 --fresh '...' -w auth");
  });

  it("a non-pi CLI keeps the plain Send work hint", async () => {
    db.close();
    const r = await runCli(
      ["agent", "spawn", "worker-1", "--cli", "claude", "-w", "auth", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    const out = JSON.parse(r.stdout) as { nextSteps: { intent: string; command: string }[] };
    expect(out.nextSteps[0]).toEqual({
      intent: "Send work",
      command: "mu agent send worker-1 '...' -w auth",
    });
  });

  it("exits 0 with a stderr warning naming mu link pi when ctl is missing", async () => {
    db.close();
    const r = await runCli(["agent", "spawn", "worker-1", "-w", "auth", "--json"], dbPath);
    db = openDb({ path: dbPath });
    expect(r.exitCode ?? 0).toBe(0);
    expect((JSON.parse(r.stdout) as { ctl: string }).ctl).toBe("missing");
    expect(r.stderr).toContain("mu link pi");
    expect(r.stderr).toContain("mu doctor");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("--no-ctl reports skipped", async () => {
    db.close();
    const r = await runCli(
      ["agent", "spawn", "worker-1", "-w", "auth", "--no-ctl", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    expect((JSON.parse(r.stdout) as { ctl: string }).ctl).toBe("skipped");
    expect(r.stderr).not.toContain("mu link pi");
  });
});
