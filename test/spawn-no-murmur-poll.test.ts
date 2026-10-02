import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Spawn does not wait for murmur to claim the pane (the removed
// MU_SPAWN_READINESS_MS poll): pi agents have the ctl handshake, and
// nothing downstream of a non-pi spawn needs murmur's first claim.
import {
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
  "MU_SPAWN_CTL_MS",
] as const;

describe("spawn does not poll murmur", () => {
  let tempDir: string;
  let db: Db;
  let mux: MuxHarness | undefined;
  let originalEnv: Map<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-spawn-murmur-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.MU_SPAWN_LIVENESS_MS = "1";
    process.env.MU_SPAWN_CTL_MS = "0";
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

  function install(): { listCalls: () => number } {
    const state = freshMockState();
    const fake = mockTmux(state);
    let listCalls = 0;
    mux = installMux("tmux", async (args) => {
      // murmur's pane options are read through `list-panes -a`.
      if (args[0] === "list-panes" && args[1] === "-a") {
        listCalls += 1;
        return { stdout: "%1\t\t", stderr: "", exitCode: 0 };
      }
      return await fake.executor(args);
    });
    return { listCalls: () => listCalls };
  }

  it.each([false, true])(
    "returns after liveness without reading murmur (linked: %s)",
    async (linked) => {
      if (linked) linkMurmur();
      const calls = install();

      await spawnAgent(db, { name: "worker-1", workstream: "ready", cli: "pi" });

      expect(calls.listCalls()).toBe(0);
    },
  );
});
