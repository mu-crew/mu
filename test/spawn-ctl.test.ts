// Spawn injects MU_CTL_SOCK and handshakes with the mu pi extension.
// A real unix-socket server at the derived path stands in for the
// extension; the mux is the fake tmux harness.

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNameExhaustedError,
  AgentSpawnStartupError,
} from "../src/agents/errors.js";
import { resetHandshakeClockForTests, setHandshakeClockForTests } from "../src/agents/spawn.js";
import {
  getAgent,
  insertAgent,
  isValidAgentName,
  nextFreeAgentName,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
  speaksMuCtl,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, defaultStateDir, openDb } from "../src/db.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { getTask, selectTaskNotes } from "../src/tasks/queries.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { worktreePath } from "../src/worktree.js";
import { INC, withHello } from "./_ctl-ext.js";
import { withEnv } from "./_env.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson, runCliWire } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

/** MU_* vars the harness itself sets (and the clean-env check ignores). */
const isTestKnob = (k: string) =>
  k === "MU_SPAWN_CTL_MS" || k === "MU_SPAWN_LIVENESS_MS" || k === "MU_TMUX_SOCKET";

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
  vi.restoreAllMocks();
  mux.restore();
  resetSleep();
  resetHandshakeClockForTests();
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
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string };
        sock.end(
          encode(
            withHello(req, { v: 1, ok: true, state: "idle", since: 1, runs: 0, pending: false }),
          ),
        );
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

// The row keeps how the pane was started, so an outdated extension can be
// respawned exactly (README: Ctl versioning). Read back through getAgent AND
// the raw column: a dropped write must fail here.
describe("spawn records the command it ran (agents.command / command_source)", () => {
  const raw = (name: string) =>
    db
      .prepare(
        "SELECT command, command_source AS src FROM agents WHERE name = ? AND workstream_id = (SELECT id FROM workstreams WHERE name = 'auth')",
      )
      .get(name) as { command: string | null; src: string | null };

  it("cli-key: the cli value itself, source cli-key; the returned row and the stored row agree", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(raw("worker-1")).toEqual({ command: "pi", src: "cli-key" });
    expect(agent).toMatchObject({ command: "pi", commandSource: "cli-key" });
    expect(getAgent(db, "worker-1", "auth")).toMatchObject({
      command: "pi",
      commandSource: "cli-key",
    });
  });

  it("an $MU_<CLI>_COMMAND override: the resolved command, source env", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    process.env.MU_PI_COMMAND = "pi-alt --flag";
    try {
      await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    } finally {
      const k = "MU_PI_COMMAND";
      delete process.env[k];
    }
    expect(raw("worker-1")).toEqual({ command: "pi-alt --flag", src: "env" });
  });

  it("--command: verbatim, source explicit", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    await spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      cli: "helper",
      command: "pi-meta --no-solo",
    });
    expect(raw("worker-1")).toEqual({ command: "pi-meta --no-solo", src: "explicit" });
  });
});

// agents.spawner: who called spawn, read from the PARENT's env before the
// child's env replaces it. Never guessed from task ownership.
describe("spawn records its spawner (agents.spawner)", () => {
  const KEYS = ["MU_MANAGED_AGENT", "MU_WORKSTREAM", "MU_AGENT_NAME", "PI_SESSION_ID"] as const;
  const saveEnv = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of KEYS) {
      saveEnv.set(k, process.env[k]);
      delete process.env[k]; // the harness running these tests may itself be a managed pi
    }
    process.env.MU_SPAWN_CTL_MS = "0";
  });
  afterEach(() => {
    for (const [k, v] of saveEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const rawSpawner = (name: string, ws = "auth") =>
    (
      db
        .prepare(
          "SELECT spawner FROM agents WHERE name = ? AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)",
        )
        .get(name, ws) as { spawner: string | null }
    ).spawner;
  const asManaged = (ws: string, name: string): void => {
    process.env.MU_MANAGED_AGENT = "1";
    process.env.MU_WORKSTREAM = ws;
    process.env.MU_AGENT_NAME = name;
  };

  it("a managed caller is '<workstream>/<agent>', in the stored row and the returned one", async () => {
    asManaged("orch-ws", "orch");
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(rawSpawner("worker-1")).toBe("orch-ws/orch"); // the parent's workstream, not the child's
    expect(agent.spawner).toBe("orch-ws/orch");
    expect(getAgent(db, "worker-1", "auth")?.spawner).toBe("orch-ws/orch");
  });

  it("same-named parents in different workstreams stay distinct", async () => {
    asManaged("ws-a", "orch");
    await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    asManaged("ws-b", "orch");
    await spawnAgent(db, { name: "worker-2", workstream: "auth" });
    expect([rawSpawner("worker-1"), rawSpawner("worker-2")]).toEqual(["ws-a/orch", "ws-b/orch"]);
  });

  it("a pi session that is not a managed agent is 'pi:<PI_SESSION_ID>'", async () => {
    process.env.PI_SESSION_ID = "01abc-session";
    await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(rawSpawner("worker-1")).toBe("pi:01abc-session");
  });

  it("the managed identity wins over the pi session; a stale MU_AGENT_NAME without MU_MANAGED_AGENT does not count", async () => {
    asManaged("orch-ws", "orch");
    process.env.PI_SESSION_ID = "01abc-session";
    await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    delete process.env.MU_MANAGED_AGENT;
    await spawnAgent(db, { name: "worker-2", workstream: "auth" });
    expect([rawSpawner("worker-1"), rawSpawner("worker-2")]).toEqual([
      "orch-ws/orch",
      "pi:01abc-session",
    ]);
  });

  it("no identity at all is NULL, and a task the caller owns changes nothing", async () => {
    ensureWorkstream(db, "auth");
    addTask(db, { workstream: "auth", localId: "t1", title: "t1" });
    insertAgent(db, { name: "orch", workstream: "auth", paneId: "%99" });
    db.prepare("UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'orch')").run();
    await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(rawSpawner("worker-1")).toBeNull();
    expect(rawSpawner("orch")).toBeNull(); // rows written without a spawner stay NULL
  });

  it("spawn leaves the child's own env as the six identity keys: the parent's session is not forwarded", async () => {
    process.env.PI_SESSION_ID = "01abc-session";
    asManaged("orch-ws", "orch");
    await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    const envs = newSessionArgs().flatMap((a, i, args) => (args[i - 1] === "-e" ? [a] : []));
    expect(envs.some((e) => e.startsWith("PI_SESSION_ID"))).toBe(false);
    expect(envs).toContain("MU_AGENT_NAME=worker-1");
    expect(envs).toContain("MU_WORKSTREAM=auth");
  });

  it("insertAgent stores spawner, host and collected_head as given, NULL otherwise", () => {
    const a = insertAgent(db, {
      name: "w1",
      workstream: "auth",
      paneId: "%1",
      spawner: "x/y",
      host: "devbox",
      collectedHead: "abc123",
    });
    expect(a).toMatchObject({ spawner: "x/y", host: "devbox", collectedHead: "abc123" });
    expect(insertAgent(db, { name: "w2", workstream: "auth", paneId: "%2" })).toMatchObject({
      spawner: null,
      host: null,
      collectedHead: null,
    });
  });
});

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

  it("injects exactly the six identity keys, with no MU_* var set in the caller", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    // The caller has no MU_* var of its own: the injected values come from mu, not from inheritance.
    const stripped = Object.entries(process.env).filter(
      ([k]) => k.startsWith("MU_") && !isTestKnob(k),
    );
    for (const [k] of stripped) delete process.env[k];
    try {
      await withEnv("SSH_AUTH_SOCK", undefined, async () => {
        await spawnAgent(db, { name: "worker-1", workstream: "auth" });
      });
      const args = newSessionArgs();
      const env = Object.fromEntries(
        args.flatMap((a, i) =>
          args[i - 1] === "-e" ? [a.split(/=(.*)/s).slice(0, 2) as [string, string]] : [],
        ),
      );
      expect(Object.keys(env).sort()).toEqual([
        "MU_AGENT_NAME",
        "MU_CTL_SOCK",
        "MU_DB_PATH",
        "MU_MANAGED_AGENT",
        "MU_STATE_DIR",
        "MU_WORKSTREAM",
      ]);
      expect(env).toMatchObject({
        MU_MANAGED_AGENT: "1",
        MU_AGENT_NAME: "worker-1",
        MU_WORKSTREAM: "auth",
        MU_CTL_SOCK: sockFor("worker-1"),
        MU_DB_PATH: dbPath,
        MU_STATE_DIR: defaultStateDir(),
      });
      expect(isAbsolute(env.MU_STATE_DIR ?? "")).toBe(true);
    } finally {
      for (const [k, v] of stripped) process.env[k] = v;
    }
  });

  it("pins the default DB and state dir too: MU_DB_PATH is absolute even for an in-memory db", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    db.close();
    db = openDb({ path: ":memory:" });
    await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(newSessionArgs()).toContain(`MU_DB_PATH=${join(defaultStateDir(), "mu.db")}`);
  });

  it("resolves a relative MU_STATE_DIR against the caller's cwd", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    await withEnv("MU_STATE_DIR", "rel-state", async () => {
      await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    });
    expect(newSessionArgs()).toContain(`MU_STATE_DIR=${join(process.cwd(), "rel-state")}`);
  });

  describe("SSH_AUTH_SOCK forwarding", () => {
    const sshArg = () => newSessionArgs().find((a) => a.startsWith("SSH_AUTH_SOCK="));

    it("forwards a valid socket", async () => {
      process.env.MU_SPAWN_CTL_MS = "0";
      const path = join(dir, "agent.sock");
      await serveExtension(path);
      await withEnv("SSH_AUTH_SOCK", path, async () => {
        await spawnAgent(db, { name: "worker-1", workstream: "auth" });
      });
      expect(sshArg()).toBe(`SSH_AUTH_SOCK=${path}`);
    });

    it("skips a missing path", async () => {
      process.env.MU_SPAWN_CTL_MS = "0";
      await withEnv("SSH_AUTH_SOCK", join(dir, "nope.sock"), async () => {
        await spawnAgent(db, { name: "worker-1", workstream: "auth" });
      });
      expect(sshArg()).toBeUndefined();
    });

    it("skips a path that is not a socket", async () => {
      process.env.MU_SPAWN_CTL_MS = "0";
      const path = join(dir, "plain");
      writeFileSync(path, "x");
      await withEnv("SSH_AUTH_SOCK", path, async () => {
        await spawnAgent(db, { name: "worker-1", workstream: "auth" });
      });
      expect(sshArg()).toBeUndefined();
    });

    it("skips when unset", async () => {
      process.env.MU_SPAWN_CTL_MS = "0";
      await withEnv("SSH_AUTH_SOCK", undefined, async () => {
        await spawnAgent(db, { name: "worker-1", workstream: "auth" });
      });
      expect(sshArg()).toBeUndefined();
    });
  });

  it("resolves a relative db path against the caller's cwd", async () => {
    process.env.MU_SPAWN_CTL_MS = "0";
    const cwd = process.cwd();
    db.close();
    process.chdir(dir);
    try {
      db = openDb({ path: "mu.db" });
      expect(db.name).toBe("mu.db");
      await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    } finally {
      process.chdir(cwd);
    }
    expect(newSessionArgs()).toContain(`MU_DB_PATH=${join(realpathSync(dir), "mu.db")}`);
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

  const spawnRows = () =>
    db
      .prepare("SELECT intent, payload FROM ops WHERE intent LIKE 'agent.spawn%' ORDER BY rowid")
      .all() as { intent: string; payload: string }[];

  it("a successful spawn logs its ctl state", async () => {
    installLivePanes({ extension: true });
    await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    expect(spawnRows()[0]?.payload).toContain("ctl=ok)");
  });

  it("agent.spawn is attributed to the caller, not system", async () => {
    installLivePanes({ extension: true });
    process.env.MU_AGENT_NAME = "orch-1";
    try {
      await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    } finally {
      delete process.env.MU_AGENT_NAME;
    }
    const row = db.prepare("SELECT actor FROM ops WHERE intent = 'agent.spawn'").get();
    expect(row).toEqual({ actor: "orch-1" });
  });

  it("a rolled-back spawn logs one agent.spawn_failed", async () => {
    installLivePanes({ scrollback: "Error: No API key found for amazon-bedrock" });
    await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch(() => {});
    expect(spawnRows()).toEqual([
      {
        intent: "agent.spawn_failed",
        payload: "agent spawn failed worker-1 (phase=liveness, error=AgentSpawnStartupError)",
      },
    ]);
  });

  it("a failing cleanup keeps the original error and still logs spawn_failed", async () => {
    installLivePanes({ scrollback: "Error: No API key found for amazon-bedrock" });
    db.exec(
      "CREATE TRIGGER no_del BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT, 'cleanup delete failed'); END",
    );
    const err = await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentSpawnStartupError);
    expect(spawnRows().map((r) => r.intent)).toEqual(["agent.spawn_failed"]);
  });

  it("a finalize failure reports phase=finalize", async () => {
    installLivePanes({ extension: true });
    db.exec(
      "CREATE TRIGGER no_ins BEFORE INSERT ON agents BEGIN SELECT RAISE(ABORT, 'finalization unavailable'); END",
    );
    await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch(() => {});
    expect(spawnRows()[0]?.payload).toContain("phase=finalize");
  });

  it("a worktree pre-stage failure logs agent.spawn_failed (phase=worktree)", async () => {
    installLivePanes({ extension: true });
    const err = await spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      worktree: true,
      root: "/nonexistent/mu-no-such-root",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(spawnRows()[0]?.payload).toContain("phase=worktree");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("a socket that appears late is probed within the stat interval, not the pane-check interval", async () => {
    process.env.MU_SPAWN_CTL_MS = "5000";
    mux.restore();
    const fake = mockTmux(freshMockState()).executor;
    let boundAt = 0;
    mux = installMux("tmux", async (args) => {
      const res = await fake(args);
      if (args[0] === "new-session") {
        setTimeout(() => {
          boundAt = Date.now();
          void serveExtension(sockFor("worker-1"));
        }, 60);
      }
      return res;
    });
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    const seenAfter = Date.now() - boundAt;
    expect(agent.ctl).toBe("ok");
    // 250 ms polling (the old cadence) sees a socket bound at 60 ms at
    // ~250 ms, i.e. ~190 ms late; 50 ms stat polling sees it within ~50 ms.
    expect(seenAfter).toBeLessThan(120);
  });

  it("keeps the pane-alive check at its 250 ms cadence, plus one final check at the deadline", async () => {
    process.env.MU_SPAWN_CTL_MS = "400";
    installLivePanes();
    await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch(() => {});
    const checks = mux.calls.filter((c) => c[0] === "display-message" && c.includes("#{pane_id}"));
    // Checks at ~0, ~250 and the 400 ms deadline (+1 from the post-handshake
    // health check). A 50 ms cadence would make ~9; no deadline check, 3.
    expect(checks.length).toBeGreaterThanOrEqual(4);
    expect(checks.length).toBeLessThanOrEqual(5);
  });

  it("a pane dying in the last 250 ms of the budget keeps the scrollback from the final check", async () => {
    process.env.MU_SPAWN_CTL_MS = "300";
    mux.restore();
    const state = freshMockState();
    const fake = mockTmux(state).executor;
    // Virtual handshake clock: each delay advances it by exactly the
    // requested ms, so the pane-alive checks land at 0, 250 and 300 on
    // every run regardless of host load.
    let t = 0;
    setHandshakeClockForTests({
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
    });
    mux = installMux("tmux", async (args) => {
      // The pane dies in the last 10 ms of the budget: any capture at or
      // after virtual 290 ms finds it gone, as on real tmux.
      if (args[0] === "capture-pane" && t >= 290) state.panes.clear();
      const res = await fake(args);
      if (args[0] === "new-session") {
        for (const pane of state.panes.values()) pane.scrollback = "fatal: instance lock held";
      }
      return res;
    });
    const err = await spawnAgent(db, { name: "worker-1", workstream: "auth" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentDiedOnSpawnError);
    expect((err as AgentDiedOnSpawnError).scrollback).toBe("fatal: instance lock held");
    // Raised by the handshake's own deadline check, not the later health check.
    expect((err as Error).message).toContain("during the ctl handshake");
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
    const r = await runCliJson(["agent", "spawn", "worker-1", "-w", "auth", "--json"], dbPath);
    db = openDb({ path: dbPath });
    expect(r.exitCode ?? 0).toBe(0);
    const out = r.data as {
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
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "--cli", "claude", "-w", "auth", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    const out = r.data as { nextSteps: { intent: string; command: string }[] };
    expect(out.nextSteps[0]).toEqual({
      intent: "Send work",
      command: "mu agent send worker-1 '...' -w auth",
    });
  });

  it("exits 0 with the warning in the document (stderr empty) when ctl is missing", async () => {
    db.close();
    const r = await runCliJson(["agent", "spawn", "worker-1", "-w", "auth", "--json"], dbPath);
    db = openDb({ path: dbPath });
    expect(r.exitCode ?? 0).toBe(0);
    expect((r.data as { ctl: string }).ctl).toBe("missing");
    // --json: stderr stays empty; the warning rides in the document.
    expect(r.stderr).toBe("");
    expect((r.data as { warnings: string[] }).warnings.join("\n")).toContain("no control socket");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("--no-ctl reports skipped", async () => {
    db.close();
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--no-ctl", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    expect((r.data as { ctl: string }).ctl).toBe("skipped");
    expect(r.stderr).not.toContain("pi install npm:@mu-crew/mu");
  });

  it("--next-free takes the next free name when the asked one is taken", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1" });
    db.close();
    installPanes("worker-2");
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--next-free", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    expect(r.exitCode ?? 0).toBe(0);
    const out = r.data as { agent: { name: string }; ctl: string };
    expect(out.agent.name).toBe("worker-2");
    expect(out.ctl).toBe("ok");
    expect(getAgent(db, "worker-1", "auth")?.paneId).toBe("%1");
  });

  it("--send sends the first prompt in the same call and reports runs", async () => {
    db.close();
    installPanes("worker-1");
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--send", "hello", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    expect(r.exitCode ?? 0).toBe(0);
    const out = r.data as {
      send: { ok: boolean; runs?: number; transport: string; sentBytes: number };
      nextSteps: { command: string }[];
    };
    expect(out.send).toMatchObject({
      ok: true,
      runs: 0,
      transport: "ctl",
      sentBytes: 5,
      incarnation: INC,
      msgId: expect.any(String),
    });
    expect(out.nextSteps[0]?.command).toBe(`mu wait 'agent:auth/worker-1@0#${INC}'`);
  });

  it("--send to a pi whose socket never answered keeps the pane and exits non-zero", async () => {
    db.close();
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--send", "hello", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    expect(r.exitCode).toBe(1);
    const out = r.data as { ctl: string; send: { ok: boolean; error: string } };
    expect(out.ctl).toBe("missing");
    expect(out.send).toMatchObject({ ok: false, error: "AgentCtlUnreachableError" });
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("--send failure --json is ONE failure document: spawn evidence in data, nested send.ok false", async () => {
    db.close();
    const r = await runCliWire(
      ["agent", "spawn", "worker-2", "-w", "auth", "--send", "hello", "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    expect(r.exitCode).toBe(1);
    // stdout is exactly one document (the spawn's own stderr warning is not JSON).
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const doc = JSON.parse(r.stdout) as {
      ok: boolean;
      error: string;
      exit: number;
      data: { agent: { name: string }; ctl: string; send: { ok: boolean } };
    };
    expect(doc).toMatchObject({ ok: false, error: "AgentCtlUnreachableError", exit: 1 });
    expect(doc.data.agent.name).toBe("worker-2");
    expect(doc.data.ctl).toBe("missing");
    expect(doc.data.send.ok).toBe(false);
  });
});

describe("mu agent spawn --task (claim + brief, one journaled attempt)", () => {
  const seedTask = (local = "t1") =>
    addTask(db, { localId: local, workstream: "auth", title: "T", impact: 50, effortDays: 1 });
  const notes = (local = "t1") => selectTaskNotes(db, local, { workstream: "auth" }).notes;
  const spawnTask = async (args: string[], extension: string | null = "worker-1") => {
    db.close();
    installPanes(extension ?? undefined);
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", ...args, "--json"],
      dbPath,
    );
    db = openDb({ path: dbPath });
    return r;
  };

  it("--task claims for the new agent after the pane exists, sends, and records the brief note", async () => {
    seedTask();
    const r = await spawnTask(["--task", "t1", "--send", "do the thing"]);
    expect(r.exitCode ?? 0).toBe(0);
    const agent = getAgent(db, "worker-1", "auth");
    expect(getTask(db, "t1", "auth")).toMatchObject({
      ownerId: agent?.incarnation,
      status: "IN_PROGRESS",
    });
    expect(notes()).toMatchObject([{ kind: "brief", content: "do the thing" }]);
    const out = r.data as {
      task: Record<string, unknown>;
      send: { msgId: string; incarnation: string; delivery: string };
    };
    expect(out.task).toMatchObject({
      id: "t1",
      attempt: "manual:t1",
      state: "sent",
      replay: false,
      brief: "recorded",
      claimed: true,
    });
    expect(out.send).toMatchObject({ delivery: "delivered", incarnation: INC });
  });

  it("a replay (same CLI call again) returns the saved delivery: no second prompt, same msgId", async () => {
    seedTask();
    const first = await spawnTask(["--task", "t1", "--send", "go"]);
    const again = await spawnTask(["--task", "t1", "--send", "go"]);
    expect(again.exitCode ?? 0).toBe(0);
    const a = first.data as { send: { msgId: string } };
    const b = again.data as { send: { msgId: string }; task: { replay: boolean } };
    expect(b.task.replay).toBe(true);
    expect(b.send.msgId).toBe(a.send.msgId);
    expect(notes()).toHaveLength(1);
  });

  it("a task that already has a brief keeps it: no second copy", async () => {
    seedTask();
    addNote(db, "t1", "the pinned brief", { workstream: "auth", kind: "brief" });
    const r = await spawnTask(["--task", "t1", "--send", "Read: mu task notes t1"]);
    expect(r.exitCode ?? 0).toBe(0);
    expect(notes().map((n) => [n.kind, n.content])).toEqual([["brief", "the pinned brief"]]);
    expect((r.data as { task: { brief: string } }).task.brief).toBe("kept");
  });

  it("an unknown task fails before any pane or row exists", async () => {
    const r = await spawnTask(["--task", "nope", "--send", "x"]);
    expect(r.exitCode).toBe(3);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(mux.calls.some((c) => c[0] === "new-session" || c[0] === "new-window")).toBe(false);
  });

  it("--task without --send, and --attempt without --task, are usage errors before any side effect", async () => {
    seedTask();
    const r = await spawnTask(["--task", "t1"]);
    expect(r.exitCode).toBe(2);
    const r2 = await spawnTask(["--attempt", "k"]);
    expect(r2.exitCode).toBe(2);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("a send that never reached pi (no extension) rolls the task spawn back: no pane kept, no claim, no brief", async () => {
    seedTask();
    const r = await spawnTask(["--task", "t1", "--send", "x"], null);
    expect(r.exitCode).toBe(1); // ctl never answered
    expect(notes()).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(getTask(db, "t1", "auth")).toMatchObject({ ownerId: null, status: "OPEN" });
  });
});

describe("mu agent spawn: the attach hint does not assume a tmux client", () => {
  const attach = async (inside: boolean) => {
    db.close();
    installPanes("worker-1");
    const saved = process.env.TMUX;
    if (inside) process.env.TMUX = "/tmp/tmux-1/default,1,0";
    else {
      const key = "TMUX";
      delete process.env[key];
    }
    try {
      const r = await runCliJson(["agent", "spawn", "worker-1", "-w", "auth", "--json"], dbPath);
      const steps = (r.data as { nextSteps: { intent: string; command: string }[] }).nextSteps;
      return steps.find((x) => x.intent === "Attach the pane")?.command;
    } finally {
      if (saved === undefined) {
        const key = "TMUX";
        delete process.env[key];
      } else process.env.TMUX = saved;
      db = openDb({ path: dbPath });
    }
  };

  it("outside tmux: one attach on the private socket, targeting the agent's window", async () => {
    const sock = process.env.MU_TMUX_SOCKET;
    const route = sock ? `-L ${sock} ` : "";
    expect(await attach(false)).toBe(`tmux ${route}attach-session -t mu-auth:worker-1`);
  });

  it("inside tmux: switch-client", async () => {
    const sock = process.env.MU_TMUX_SOCKET;
    const route = sock ? `-L ${sock} ` : "";
    expect(await attach(true)).toBe(`tmux ${route}switch-client -t mu-auth:worker-1`);
  });
});

describe("nextFreeAgentName", () => {
  it("counts a -<n> suffix up, and suffixes a bare name from -2", () => {
    insertAgent(db, { name: "delegate-1", workstream: "auth", paneId: "%1" });
    insertAgent(db, { name: "delegate-2", workstream: "auth", paneId: "%2" });
    insertAgent(db, { name: "delegate-review", workstream: "auth", paneId: "%3" });
    expect(nextFreeAgentName(db, "delegate-1", "auth")).toBe("delegate-3");
    expect(nextFreeAgentName(db, "delegate-review", "auth")).toBe("delegate-review-2");
    expect(nextFreeAgentName(db, "fresh", "auth")).toBe("fresh");
    expect(nextFreeAgentName(db, "delegate-1", "other")).toBe("delegate-1");
  });

  it("skips a name whose worktree dir outlived its agent", async () => {
    await withEnv("MU_STATE_DIR", join(dir, "state"), async () => {
      // A dead delegate's checkout: no agent row, the dir kept as evidence.
      mkdirSync(worktreePath("scratch", "delegate-review"), { recursive: true });
      mkdirSync(worktreePath("scratch", "delegate-review-2"), { recursive: true });
      expect(nextFreeAgentName(db, "delegate-review", "scratch")).toBe("delegate-review-3");
      // Another workstream's dir does not count.
      expect(nextFreeAgentName(db, "delegate-review", "auth")).toBe("delegate-review");
    });
  });

  it("cuts the stem so a taken 31- or 32-char name yields a valid name", () => {
    const n31 = "a".repeat(31);
    const n32 = "b".repeat(32);
    insertAgent(db, { name: n31, workstream: "auth", paneId: "%1" });
    insertAgent(db, { name: n32, workstream: "auth", paneId: "%2" });
    insertAgent(db, { name: `${"b".repeat(30)}-2`, workstream: "auth", paneId: "%3" });
    const a = nextFreeAgentName(db, n31, "auth");
    const b = nextFreeAgentName(db, n32, "auth");
    expect(a).toBe(`${"a".repeat(30)}-2`);
    expect(b).toBe(`${"b".repeat(30)}-3`);
    expect(isValidAgentName(a) && isValidAgentName(b)).toBe(true);
  });

  it("counts a huge numeric suffix exactly and gives up typed when it outgrows the name", () => {
    const huge = `a-${"9".repeat(29)}8`; // 32 chars, beyond Number precision
    insertAgent(db, { name: huge, workstream: "auth", paneId: "%1" });
    expect(nextFreeAgentName(db, huge, "auth")).toBe(`a-${"9".repeat(30)}`);
    const full = `a-${"9".repeat(30)}`;
    insertAgent(db, { name: full, workstream: "auth", paneId: "%2" });
    // The next suffix needs 32 chars on its own: no valid name is left.
    expect(() => nextFreeAgentName(db, full, "auth")).toThrow(AgentNameExhaustedError);
  });

  it("gives up typed after a bounded number of taken names", () => {
    insertAgent(db, { name: "w-1", workstream: "auth", paneId: "%0" });
    // One transaction: 1000 separate commits otherwise (~0.5s).
    db.transaction(() => {
      for (let i = 2; i <= 1001; i++) {
        insertAgent(db, { name: `w-${i}`, workstream: "auth", paneId: `%${i}` });
      }
    })();
    expect(() => nextFreeAgentName(db, "w-1", "auth")).toThrow(AgentNameExhaustedError);
  });
});
