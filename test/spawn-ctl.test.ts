// Spawn injects MU_CTL_SOCK and handshakes with the mu pi extension.
// A real unix-socket server at the derived path stands in for the
// extension; the mux is the fake tmux harness.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAgent,
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
import { freshMockState, mockTmux } from "./_verbs-mock.js";

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
