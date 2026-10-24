// One isolated sandbox per run: own HOME, own DB, own sync dir, own private tmux server (tmux shim + TMUX_TMPDIR inside the sandbox).
// Never touches the default tmux server, herdr, or the user's real mu state.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox, Surface } from "./types.ts";

export const FAUX_EXT: string = fileURLToPath(new URL("./faux.ts", import.meta.url));

function resolveRealPi(): string {
  try {
    return execFileSync("which", ["pi"], { encoding: "utf8" }).trim() || "pi";
  } catch {
    return "pi";
  }
}

/** pi resolved once at import, from the caller's PATH, before any sandbox PATH exists. */
export const REAL_PI: string = resolveRealPi();

/**
 * Where tmux puts socket `name` for a sandbox. TMUX_TMPDIR is pinned inside the sandbox, so
 * every tmux the AUT or a worker starts (bare, absolute path, -L, default socket) lands here
 * and none can reach the user's default server.
 */
export function tmuxSocketPath(dir: string, name: string): string {
  return join(dir, "tmux-tmp", `tmux-${process.getuid?.() ?? 0}`, name);
}

/** Absolute path of tmux on `pathEnv`. Throws when absent: a bare "tmux" fallback would resolve to the sandbox shim and exec itself forever. */
export function resolveRealTmux(pathEnv: string | undefined = process.env.PATH): string {
  for (const d of (pathEnv ?? "").split(":")) {
    if (!isAbsolute(d)) continue;
    const p = join(d, "tmux");
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  throw new Error(
    "eval sandbox: tmux not found on PATH (it is required for the private tmux server)",
  );
}

let realTmuxPath: string | undefined;

/** tmux resolved on first use (never at import, so tmux-free tests can import this file), from the caller's PATH, and cached. Throws when absent. */
export function realTmux(): string {
  realTmuxPath ??= resolveRealTmux();
  return realTmuxPath;
}

const KEEP = new Set(["PATH", "TERM", "LANG", "LC_ALL", "USER", "SHELL"]);

/** Pure: the whitelisted environment of a sandbox. Never inherits MU_*, TMUX*, HERDR_*, PI_*. */
export function sandboxEnv(
  dir: string,
  surface: Surface,
  tmuxSocket: string,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (KEEP.has(k) || k.startsWith("MODELBRIDGE_")) env[k] = v;
  }
  const home = join(dir, "home");
  const state = join(dir, "state");
  env.TERM ??= "xterm-256color";
  env.HOME = home;
  env.XDG_STATE_HOME = join(home, ".local", "state");
  env.XDG_CACHE_HOME = join(home, ".cache");
  env.MU_DB_PATH = join(state, "mu.db");
  env.MU_STATE_DIR = state;
  env.MU_SYNC_DIR = join(dir, "sync");
  env.MU_TMUX_SOCKET = tmuxSocket;
  env.TMUX_TMPDIR = join(dir, "tmux-tmp");
  env.MU_MUX = "tmux";
  env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
  env.GIT_AUTHOR_NAME = "eval";
  env.GIT_AUTHOR_EMAIL = "eval@example.invalid";
  env.GIT_COMMITTER_NAME = "eval";
  env.GIT_COMMITTER_EMAIL = "eval@example.invalid";
  env.EVAL_WORKER_DIR = join(dir, "workers");
  env.EVAL_SURFACE_FAMILY = surface.family ?? "3x";
  env.PATH = `${join(dir, "bin")}:${base.PATH ?? ""}`;
  return env;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; cwd: string; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

export async function sh(
  sb: Sandbox,
  cmd: string,
  opts: { cwd?: string; allowFail?: boolean } = {},
): Promise<ExecResult> {
  const r = await exec("bash", ["-c", cmd], { env: sb.env, cwd: opts.cwd ?? sb.repoDir });
  if (r.code !== 0 && !opts.allowFail) {
    throw new Error(`sh failed (${r.code}): ${cmd}\n${r.stderr || r.stdout}`);
  }
  return r;
}

/** Run the surface's mu. Never throws. */
export async function mu(sb: Sandbox, args: string[]): Promise<ExecResult> {
  return exec("node", [sb.surface.cli, ...args], { env: sb.env, cwd: sb.repoDir });
}

const live = new Set<{ dir: string; sockets: () => string[] }>();
const SOCKET_PATH_MAX = 104; // sun_path is 108 on Linux
let handlersInstalled = false;

/** Kill the server behind a socket path. Always -S <path under a sandbox>, never the default. */
function killServer(socketPath: string): void {
  try {
    execFileSync(realTmux(), ["-S", socketPath, "kill-server"], { stdio: "ignore" });
  } catch {
    // no server on that socket: fine
  }
}

/** Every socket path of a sandbox: the run's, the sandbox default, and names scenarios recorded
 * (one per line) in <dir>/tmux-sockets. All of them live under <dir>/t. */
function sandboxSockets(dir: string, tmuxSocket: string): string[] {
  const names = [tmuxSocket, "default"];
  const file = join(dir, "tmux-sockets");
  if (existsSync(file)) {
    for (const l of readFileSync(file, "utf8").split("\n")) {
      const n = l.trim();
      if (n !== "" && !n.includes("/")) names.push(n);
    }
  }
  return names.map((n) => tmuxSocketPath(dir, n));
}

/** Sync, idempotent: kill every live sandbox's tmux servers and remove its dir. */
function cleanupAll(): void {
  for (const s of [...live]) {
    live.delete(s);
    for (const sock of s.sockets()) killServer(sock);
    rmSync(s.dir, { recursive: true, force: true });
  }
}

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(sig, () => {
      cleanupAll();
      process.exit(code);
    });
  }
  // A crash anywhere (a throwing judge, a bug) must not leave a sandbox dir or tmux server behind.
  for (const ev of ["unhandledRejection", "uncaughtException"] as const) {
    process.on(ev, (e: unknown) => {
      cleanupAll();
      console.error(e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    });
  }
  process.on("exit", cleanupAll);
}

function writeShim(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

export async function createSandbox(
  surface: Surface,
  opts: { env?: Record<string, string> } = {},
): Promise<Sandbox> {
  const tmuxBin = realTmux(); // fail before creating anything on disk
  const id = `mu-eval-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const dir = join(tmpdir(), id);
  const tmuxSocket = id;
  if (tmuxSocketPath(dir, tmuxSocket).length > SOCKET_PATH_MAX) {
    throw new Error(
      `tmux socket path too long (${tmuxSocketPath(dir, tmuxSocket).length}); set TMPDIR shorter`,
    );
  }
  const env = { ...sandboxEnv(dir, surface, tmuxSocket, process.env), ...opts.env };
  const binDir = join(dir, "bin");
  const repoDir = join(dir, "repo");
  const workerDir = join(dir, "workers");
  for (const sub of ["home", "state", "sync", "sessions", "pi-agent", "bin", "repo", "workers"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  mkdirSync(join(dir, "home", ".local", "state"), { recursive: true });
  mkdirSync(join(dir, "home", ".cache"), { recursive: true });
  writeFileSync(
    join(dir, "pi-agent", "settings.json"),
    `${JSON.stringify({ retry: { enabled: false } })}\n`,
  );

  writeShim(join(binDir, "mu"), `exec node ${JSON.stringify(surface.cli)} "$@"`);
  // Workers and delegates are scripted: faux model, no mu nudges (they would only rerun the script).
  writeShim(
    join(binDir, "pi"),
    `exec env MU_NUDGE=0 ${JSON.stringify(REAL_PI)} "$@" --no-extensions -e ${JSON.stringify(surface.extension)} -e ${JSON.stringify(FAUX_EXT)} --no-skills --no-context-files --no-session --model evalfaux/worker`,
  );

  // Bare tmux from the AUT or a worker joins the run's private server (an explicit later -L/-S
  // still wins, but TMUX_TMPDIR keeps even that inside the sandbox).
  writeShim(join(binDir, "tmux"), `exec ${JSON.stringify(tmuxBin)} -L ${tmuxSocket} "$@"`);

  const sb: Sandbox = {
    dir,
    env,
    binDir,
    repoDir,
    workerDir,
    tmuxSocket,
    dbPath: env.MU_DB_PATH ?? join(dir, "state", "mu.db"),
    surface,
    async close(o) {
      live.delete(entry);
      for (const sock of entry.sockets()) killServer(sock);
      if (!o?.keep) rmSync(dir, { recursive: true, force: true });
    },
  };
  const entry = { dir, sockets: () => sandboxSockets(dir, tmuxSocket) };
  live.add(entry);
  installHandlers();

  try {
    await sh(
      sb,
      "git init -q -b main && printf '# eval repo\\n' > README.md && git add README.md && git commit -q -m init",
    );
    mkdirSync(env.TMUX_TMPDIR ?? join(dir, "tmux-tmp"), { recursive: true });
    await sh(sb, `tmux -L ${tmuxSocket} -f /dev/null new-session -d -s eval-boot`);
  } catch (e) {
    await sb.close();
    throw e;
  }
  return sb;
}
