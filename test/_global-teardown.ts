// Vitest global hooks. Workers get a private tmux namespace and a shared
// scratch directory via provide/inject; cleanup never probes a user server.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execa } from "execa";
import type { TestProject } from "vitest/node";
import { openDb } from "../src/db.js";
import { DB_TEMPLATE_KEY } from "./_db-template.js";
import { pinRealGit } from "./_real-git.js";
import { RUN_ROOT_KEY } from "./_run-root.js";
import {
  createServerRoot,
  registerTmuxSocket,
  SERVER_ROOT_KEY,
  TMUX_SOCKET_KEY,
  watchTestServers,
} from "./_server-registry.js";

// Vitest leaves its root SSR temp dir behind; project-level dirs get removed.
let vitestTmpDir: string | null = null;
let runRoot: string | null = null;
let stopServers: (() => Promise<void>) | undefined;

declare module "vitest" {
  interface ProvidedContext {
    [RUN_ROOT_KEY]: string;
    [DB_TEMPLATE_KEY]: string;
    [SERVER_ROOT_KEY]: string;
    [TMUX_SOCKET_KEY]?: string;
  }
}

export function leakedVitestTmpDir(project: unknown, tmp: string = tmpdir()): string | null {
  const dir = (project as { vitest?: { _tmpDir?: unknown } } | null)?.vitest?._tmpDir;
  if (typeof dir !== "string" || !isAbsolute(dir)) return null;
  return dirname(dir) === tmp ? dir : null;
}

export async function setup(project: TestProject): Promise<void> {
  vitestTmpDir = leakedVitestTmpDir(project);
  try {
    pinRealGit();
    runRoot = mkdtempSync(join(tmpdir(), "mu-test-run-"));
    const serverRoot = createServerRoot();
    try {
      stopServers = await watchTestServers(serverRoot, runRoot);
    } catch (err) {
      rmSync(serverRoot, { recursive: true, force: true });
      throw err;
    }
    project.provide(SERVER_ROOT_KEY, serverRoot);
    project.provide(RUN_ROOT_KEY, runRoot);
    // Fixtures don't need the machine's system config or sample hooks.
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const gitTemplate = join(runRoot, "git-template");
    process.env.GIT_TEMPLATE_DIR = gitTemplate;
    mkdirSync(join(gitTemplate, "info"), { recursive: true });
    mkdirSync(join(gitTemplate, "hooks"));
    const template = join(runRoot, "template.db");
    const db = openDb({ path: template });
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    project.provide(DB_TEMPLATE_KEY, template);
    const socket = registerTmuxSocket(serverRoot);
    // Disable exit-empty atomically with start-server; otherwise the last
    // session exiting can race the next fixture's new-session.
    const result = await execa(
      "tmux",
      ["-L", socket, "-f", "/dev/null", "start-server", ";", "set", "-s", "exit-empty", "off"],
      { env: { TMUX_TMPDIR: serverRoot }, reject: false, timeout: 5000 },
    );
    if (result.exitCode === 0) project.provide(TMUX_SOCKET_KEY, socket);
    else
      console.warn(
        `[mu-test] private tmux unavailable; skipping real-tmux tests: ${result.stderr ?? ""}`,
      );
  } catch (err) {
    await teardown();
    throw err;
  }
}

export async function teardown(): Promise<void> {
  try {
    await stopServers?.();
  } finally {
    if (vitestTmpDir) rmSync(vitestTmpDir, { recursive: true, force: true });
    if (runRoot) rmSync(runRoot, { recursive: true, force: true });
  }
}
