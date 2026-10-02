import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentDiedOnSpawnError,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { freshMockState, mockTmux } from "./_verbs-mock.js";

const ENV_KEYS = [
  "PATH",
  "PI_CODING_AGENT_DIR",
  "MU_SPAWN_LIVENESS_MS",
  "MU_SPAWN_READINESS_MS",
] as const;

describe("spawn readiness from murmur", () => {
  let tempDir: string;
  let db: Db;
  let mux: MuxHarness | undefined;
  let originalEnv: Map<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-spawn-murmur-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.MU_SPAWN_LIVENESS_MS = "1";
    process.env.MU_SPAWN_READINESS_MS = "10000";
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi");
    process.env.PATH = join(tempDir, "bin");
    setCommandResolverForTests(async () => ({ ok: true, binary: "pi", resolvedPath: "/pi" }));
    setSleepForTests(async () => {});
  });

  afterEach(() => {
    mux?.restore();
    mux = undefined;
    resetSleep();
    resetCommandResolverForTests();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function linkMurmur(): void {
    const binDir = join(tempDir, "bin");
    const extensionDir = join(tempDir, "pi", "extensions");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    const murmur = join(binDir, "murmur");
    writeFileSync(murmur, "#!/bin/sh\n");
    chmodSync(murmur, 0o755);
    writeFileSync(join(extensionDir, "murmur.ts"), "");
  }

  function install(
    readPaneOptions: (poll: number) => string,
    disappearAtPoll?: number,
  ): { listCalls: () => number } {
    const state = freshMockState();
    const fake = mockTmux(state);
    let listCalls = 0;
    let readinessExistsCalls = 0;
    mux = installMux("tmux", async (args) => {
      if (args[0] === "list-panes" && args[1] === "-a") {
        listCalls += 1;
        return { stdout: readPaneOptions(listCalls), stderr: "", exitCode: 0 };
      }
      if (args[0] === "display-message" && state.panes.size > 0) {
        readinessExistsCalls += 1;
        // The first display-message is the liveness check. Later calls
        // belong to readiness polling.
        if (disappearAtPoll !== undefined && readinessExistsCalls - 1 >= disappearAtPoll) {
          state.panes.clear();
        }
      }
      return await fake.executor(args);
    });
    return { listCalls: () => listCalls };
  }

  it("returns after liveness without polling when murmur is unavailable", async () => {
    const calls = install(() => "%1\t\t");

    await spawnAgent(db, { name: "worker-1", workstream: "ready", cli: "pi" });

    expect(calls.listCalls()).toBe(0);
  });

  it("returns when murmur claims the pane on the third poll", async () => {
    linkMurmur();
    const calls = install((poll) => (poll === 3 ? "%1\tworking\t1000" : "%1\t\t"));

    await spawnAgent(db, { name: "worker-1", workstream: "ready", cli: "pi" });

    expect(calls.listCalls()).toBe(3);
  });

  it("returns without throwing when the readiness budget expires", async () => {
    linkMurmur();
    process.env.MU_SPAWN_READINESS_MS = "50";
    resetSleep();
    const calls = install(() => "%1\t\t");

    await expect(
      spawnAgent(db, { name: "worker-1", workstream: "ready", cli: "pi" }),
    ).resolves.toMatchObject({ name: "worker-1" });
    expect(calls.listCalls()).toBeGreaterThan(0);
  });

  it("throws when the pane disappears while waiting for murmur", async () => {
    linkMurmur();
    install(() => "%1\t\t", 2);

    await expect(
      spawnAgent(db, { name: "worker-1", workstream: "ready", cli: "pi" }),
    ).rejects.toBeInstanceOf(AgentDiedOnSpawnError);
  });
});
