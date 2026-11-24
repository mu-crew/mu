// Vitest global hooks. Workers get a private tmux namespace and a shared
// scratch directory via provide/inject; cleanup never probes a user server.
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execa } from "execa";
import type { TestProject } from "vitest/node";
import { openDb } from "../src/db.js";
import { DB_TEMPLATE_KEY } from "./_db-template.js";
import { RUN_ROOT_KEY } from "./_run-root.js";
import {
  createServerRoot,
  registerTmuxSocket,
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
    [TMUX_SOCKET_KEY]?: string;
  }
}

export function leakedVitestTmpDir(project: unknown, tmp: string = tmpdir()): string | null {
  const dir = (project as { vitest?: { _tmpDir?: unknown } } | null)?.vitest?._tmpDir;
  if (typeof dir !== "string" || !isAbsolute(dir)) return null;
  const parent = dirname(dir);
  if (parent === tmp) return dir;
  try {
    // macOS can spell the same directory /var or /private/var.
    return realpathSync(parent) === realpathSync(tmp) ? dir : null;
  } catch {
    return null;
  }
}

export async function setup(project: TestProject): Promise<void> {
  vitestTmpDir = leakedVitestTmpDir(project);
  try {
    stopServers = undefined;
    runRoot = createServerRoot();
    stopServers = await watchTestServers(runRoot);
    project.provide(RUN_ROOT_KEY, runRoot);
    const template = join(runRoot, "template.db");
    const db = openDb({ path: template });
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    project.provide(DB_TEMPLATE_KEY, template);
    const socket = registerTmuxSocket(runRoot);
    // Disable exit-empty atomically with start-server; otherwise the last
    // session exiting can race the next fixture's new-session.
    const result = await execa(
      "tmux",
      ["-L", socket, "-f", "/dev/null", "start-server", ";", "set", "-s", "exit-empty", "off"],
      { env: { TMUX_TMPDIR: runRoot }, reject: false, timeout: 5000 },
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
    if (stopServers) await stopServers();
    else if (runRoot) rmSync(runRoot, { recursive: true, force: true });
  } finally {
    if (vitestTmpDir) rmSync(vitestTmpDir, { recursive: true, force: true });
  }
}
