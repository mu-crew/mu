// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// One isolated sandbox per run: own HOME, own DB, own sync dir, own private tmux server (tmux shim + TMUX_TMPDIR inside the sandbox).
// Never touches the default tmux server, herdr, or the user's real mu state.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertInRow } from "./claim.ts";
import { AUT_NAMES } from "./fake-payloads.ts";
import { type CodexHooks, type HookTools, setupHarnesses } from "./harness.ts";
import { pinScript, shellStartupEnv, writeShellStartup } from "./isolation.ts";
import { stageRig } from "./rig-guard.ts";
import type { Sandbox, Surface } from "./types.ts";

/** Where the AUT sees the surface's skill: a copy inside the sandbox (a regular tree, so `find /` hits it too), so its own recipes are the first (and shortest) path it meets. */
export function sandboxSkillDir(dir: string): string {
  return join(dir, "skills", "mu");
}

export const FAUX_EXT: string = fileURLToPath(new URL("./faux.ts", import.meta.url));

function resolveRealPi(): string {
  try {
    const all = execFileSync("which", ["-a", "pi"], { encoding: "utf8" }).split("\n");
    // Skip the test setup's stub (test/_setup.ts): it only satisfies spawn's binary check.
    const real = all.map((p) => p.trim()).find((p) => p !== "" && !isPiStub(p));
    return real ?? "pi";
  } catch {
    return "pi";
  }
}

/** The marker test/_setup.ts writes into its `pi` stub. */
export const PI_STUB_MARKER = "pi: test stub (test/_setup.ts)";

function isPiStub(path: string): boolean {
  try {
    return readFileSync(path, "utf8").slice(0, 200).includes(PI_STUB_MARKER);
  } catch {
    return false;
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

const KEEP = new Set(["TERM", "LANG", "LC_ALL", "USER", "SHELL"]);

/**
 * Pure: what the host pi launcher needs from the caller's env to start at all, named by the
 * caller in EVAL_LAUNCHER_ENV (space-separated NAME=VALUE pairs; a caller value of NAME wins).
 * Inside a launcher's own sandbox (the rig run from a pi agent's bash tool), a launcher that
 * nests its own sandbox-exec is refused ("sandbox_apply: Operation not permitted") and every
 * model fails before any request; the pair that has it keep the outer sandbox goes here.
 */
export function launcherEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (base.EVAL_LAUNCHER_ENV ?? "").split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    out[name] = base[name] ?? pair.slice(eq + 1);
  }
  return out;
}

/**
 * Copy the host pi launcher's cached model catalog (`[<name>-]model-catalog*.json` in the caller's pi
 * agent dir) into a sandbox's agent dir. Without a cache, an interactive pi launcher fetches the
 * catalog first; where it cannot (inside a pi agent's sandbox, no network) it waits on "Press any
 * key to continue" and a worker pane never opens its control socket. A cache only: no auth, no
 * settings. Returns the files copied.
 */
export function seedLauncherCache(hostAgentDir: string, sandboxAgentDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(hostAgentDir).filter((n) => /^(\w+-)?model-catalog[\w.-]*\.json$/.test(n));
  } catch {
    return [];
  }
  for (const n of names) copyFileSync(join(hostAgentDir, n), join(sandboxAgentDir, n));
  return names;
}

/** System directories only: the host's mise, ~/.local/bin and ~/.pi/agent/bin entries (and the tools and docs they hold) stay out of the AUT's PATH. */
export function systemPathDirs(pathEnv: string | undefined): string[] {
  return (pathEnv ?? "").split(":").filter((d) => /^\/(usr|bin|sbin|opt)(\/|$)/.test(d));
}

/** Tools the scenarios and the faux workers need that live outside the system dirs (mise installs): linked into the sandbox bin. */
const TOOLS = ["node", "sqlite3", "git", "ssh"];

function linkTools(binDir: string, pathEnv: string | undefined): void {
  const system = new Set(systemPathDirs(pathEnv));
  for (const tool of TOOLS) {
    for (const d of (pathEnv ?? "").split(":")) {
      if (!isAbsolute(d)) continue;
      const p = join(d, tool);
      try {
        accessSync(p, constants.X_OK);
      } catch {
        continue;
      }
      if (!system.has(d) && !existsSync(join(binDir, tool))) symlinkSync(p, join(binDir, tool));
      break;
    }
  }
}

/**
 * What a live sandbox drops from the caller's environment: mu's, tmux's, herdr's, murmur's and
 * pi's own variables, and each harness's session and nesting markers (the caller may itself be an
 * agent), named one by one. A harness's configuration and auth variables (CLAUDE_CODE_USE_*,
 * CLAUDE_CODE_OAUTH_TOKEN, CODEX_HOME, ANTHROPIC_*, ...) stay.
 */
export const LIVE_DROP = new RegExp(
  `^(MU_|TMUX|HERDR_|MURMUR_|PI_|EVAL_|(${[
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CURRENT_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_[A-Z_]+",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_TMPDIR",
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_ENV_FILE",
    "CLAUDE_PLUGIN_[A-Z_]+",
    "CLAUDE_LAUNCHER_SESSION_FILE",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "CODEX_TOOL_CALL_ID",
    "CODEX_CI",
    "CURSOR_AGENT",
    "CURSOR_CONVERSATION_ID",
    "CURSOR_REQUEST_ID",
    "CURSOR_TRANSCRIPT_PATH",
    "CURSOR_PROJECT_DIR",
    "CURSOR_ASKPASS_[A-Z_]+",
    "MUSE_SESSION_ID",
    "MUSE_THREAD_ID",
    "MUSE_PLUGIN_[A-Z_]+",
  ].join("|")})$)`,
);

/**
 * Pure: the environment of a sandbox.
 *
 * - Fake run (default): a whitelist. HOME, XDG state and cache, the DB and every crew state dir
 *   are inside the sandbox; nothing of MU_*, TMUX*, HERDR_*, PI_* is inherited.
 * - Live run (`live`, real harness binaries): the caller's environment with LIVE_DROP removed, so
 *   each harness keeps its own HOME, config and auth (D1). The sandbox still owns mu's DB and
 *   state, murmur's state, the tmux server and TMPDIR; PATH is the sandbox bin, then the caller's;
 *   ZDOTDIR and CLAUDE_ENV_FILE re-apply that after the user's shell startup files (isolation.ts).
 */
export function sandboxEnv(
  dir: string,
  surface: Surface,
  tmuxSocket: string,
  base: NodeJS.ProcessEnv,
  opts: { live?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (opts.live ? !LIVE_DROP.test(k) : KEEP.has(k)) env[k] = v;
  }
  Object.assign(env, launcherEnv(base));
  const home = join(dir, "home");
  const state = join(dir, "state");
  env.TERM ??= "xterm-256color";
  if (!opts.live) {
    env.HOME = home;
    env.XDG_STATE_HOME = join(home, ".local", "state");
    env.XDG_CACHE_HOME = join(home, ".cache");
  }
  env.MURMUR_STATE_DIR = join(dir, "murmur2");
  env.MU_DB_PATH = join(state, "mu.db");
  env.MU_STATE_DIR = state;
  env.MU_SYNC_DIR = join(dir, "sync");
  env.MU_TMUX_SOCKET = tmuxSocket;
  env.TMUX_TMPDIR = join(dir, "tmux-tmp");
  env.TMPDIR = join(dir, "tmp");
  env.MU_MUX = "tmux";
  env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
  env.GIT_AUTHOR_NAME = "eval";
  env.GIT_AUTHOR_EMAIL = "eval@example.invalid";
  env.GIT_COMMITTER_NAME = "eval";
  env.GIT_COMMITTER_EMAIL = "eval@example.invalid";
  env.EVAL_WORKER_DIR = join(dir, "workers");
  env.EVAL_SURFACE_FAMILY = surface.family ?? "3x";
  if (opts.live) {
    // the sandbox root as TMPDIR: a harness sandbox that lets its tools write TMPDIR (cursor-agent's,
    // codex's workspace-write when a command picks it) then reaches the run's logs, DB dir and
    // worktree gitdirs
    env.TMPDIR = dir;
    Object.assign(env, shellStartupEnv(dir, base));
    env.EVAL_LIVE = "1";
    env.EVAL_CALLER_PATH = base.PATH ?? "";
    env.PATH = [join(dir, "bin"), ...(base.PATH ?? "").split(":").filter((d) => d !== "")].join(
      ":",
    );
  } else {
    env.PATH = [join(dir, "bin"), ...systemPathDirs(base.PATH)].join(":");
  }
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

const live = new Set<{ dir: string; sockets: () => string[]; restore: () => void }>();
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

/**
 * Dirs already removed that a late hook may bring back: a harness killed with its tmux server
 * fires SessionEnd through murmur, whose CLI recreates `<MURMUR_STATE_DIR>/compile-cache` at
 * startup. Swept again a few seconds after the close and at exit.
 */
const removed = new Set<string>();
const RESWEEP_MS = 5_000;

function sweepRemoved(): void {
  for (const dir of [...removed]) {
    removed.delete(dir);
    if (existsSync(dir)) removeSandboxDir(dir);
  }
}

/** Remove a closed sandbox's dir now and sweep it again once late hooks have exited. */
function removeClosed(dir: string): void {
  removeSandboxDir(dir);
  removed.add(dir);
  setTimeout(() => {
    if (removed.delete(dir) && existsSync(dir)) removeSandboxDir(dir);
  }, RESWEEP_MS).unref();
}

/** Sync, idempotent: kill every live sandbox's tmux servers and remove its dir. */
function cleanupAll(): void {
  for (const s of [...live]) {
    live.delete(s);
    s.restore();
    for (const sock of s.sockets()) killServer(sock);
    removeSandboxDir(s.dir);
  }
  sweepRemoved();
}

/**
 * Remove a sandbox dir without throwing. A hook a dying harness fired as its tmux server went
 * down (SessionEnd, say) can still be writing murmur state into the dir while it is removed,
 * which fails the removal with ENOTEMPTY; retry a few times, then leave the dir and say so
 * rather than fail the run over a leftover temp dir.
 */
export function removeSandboxDir(dir: string, attempts = 10, delayMs = 200): void {
  for (let i = 1; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (e) {
      if (i >= attempts) {
        process.stderr.write(`eval: left ${dir} behind: ${(e as Error).message}\n`);
        return;
      }
      if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
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

/**
 * Machine-local tables (MACHINE_LOCAL_TABLES in src/db.ts; vcs_workspaces is 3.x's worktrees) that
 * a raw `mu sql` write changes WITHOUT writing an op (only captured tables write ops). The shim
 * fingerprints them around each AUT call (observe.ts: localWrites). Not `sqlite3 -readonly`: a
 * read-only connection cannot open a WAL DB whose -shm file is gone (fixtures.ts DRIVER), and every
 * table's fingerprint would read as the empty dump.
 */
export const LOCAL_TABLES =
  "agents worktrees vcs_workspaces task_auto task_substates delegate_calls";

/** Epoch ms in SQL: 'now' is fixed within a statement and carries milliseconds. */
const NOW_SQL = "SELECT strftime('%s','now')*1000+CAST(substr(strftime('%f','now'),4) AS INTEGER);";

/**
 * One sqlite3 call for the shim, three lines out: the time, "<table>:<hash>,..." over LOCAL_TABLES,
 * the time again. A table's hash covers what `.dump <table>` printed (its schema rows, indexes and
 * triggers included, then its rows): sha3_query is the sqlite3 shell's own function. A table the DB
 * lacks hashes to "" (3.x/4.x have different sets).
 */
export function fpSql(tables = LOCAL_TABLES): string {
  const one = (t: string): string => {
    const inner = `SELECT type,name,sql FROM sqlite_master WHERE tbl_name=''${t}'' ORDER BY name; SELECT * FROM "${t}"`;
    return `'${t}:'||coalesce((SELECT substr(lower(hex(sha3_query('${inner}'))),1,16) FROM sqlite_master WHERE type='table' AND name='${t}'),'')||','`;
  };
  const fp = tables.split(" ").map(one).join("||");
  return `${NOW_SQL} SELECT ${fp}; ${NOW_SQL}`;
}

/** GNU tee's -p (survives a reader that went away); BSD tee has none. Probed once per process. */
let teeCmd: string | undefined;
function teeWithP(): string {
  if (teeCmd === undefined) {
    try {
      execFileSync("tee", ["-p", "/dev/null"], { input: "", stdio: ["pipe", "ignore", "ignore"] });
      teeCmd = "tee -p";
    } catch {
      teeCmd = "tee";
    }
  }
  return teeCmd;
}

/**
 * The sandbox's `mu`: runs the surface's CLI and records the call (see observe.ts). Exit status and
 * output are untouched. `pin` (isolation.ts pinScript) sets the sandbox's DB, state, sync dir and
 * tmux server whatever the caller's env says.
 *
 * Cheap on purpose: one run fans out to dozens of sandboxes, each calling mu hundreds of times. An
 * AUT call costs two sqlite3 processes (time + table hashes + time, before and after) besides mu
 * and tee; a worker's call costs nothing on bash 5 (EPOCHREALTIME) and two sqlite3 clocks on
 * macOS's bash 3.2, which has no ms clock (BSD date has no %N).
 */
export function muShim(cli: string, pin = ""): string {
  const raw = (t: string): string => t.replace(/\\\$\{/g, "${");
  return `${raw(String.raw`#!/bin/bash
# a user's own \`mu hook stop\` entry, read by a live harness: the rig's runs the build by path
[ "$1" = hook ] && [ "$2" = stop ] && exit 0
`)}${pin}${raw(String.raw`D="\${EVAL_WORKER_DIR:-}"
aut=
# the AUT: no agent name (pi over rpc), or an orchestrator pane the rig started (aut, aut-2)
[ -n "$D" ] && [ -z "\${MU_AGENT_NAME:-}" ] && aut=1
case " ${AUT_NAMES.join(" ")} " in *" \${MU_AGENT_NAME:-} "*) [ -n "$D" ] && aut=1 ;; esac
# NOW=epoch ms: bash 5's EPOCHREALTIME, else sqlite3's clock
now() { if [ -n "\${EPOCHREALTIME:-}" ]; then NOW=\${EPOCHREALTIME/[.,]/}; NOW=\${NOW%???}; else NOW=$(sqlite3 :memory: "${NOW_SQL}" 2>/dev/null); fi; }
# FP1=time FP2="<table>:<hash>,..." of the db right now FP3=time (one sqlite3, it only reads)
fp() { local o; o=$(sqlite3 -cmd ".timeout 2000" "$MU_DB_PATH" "${fpSql().replace(/"/g, '\\"')}" 2>/dev/null); { read -r FP1; read -r FP2; read -r FP3; } <<< "$o"; case "$FP1$FP3" in ''|*[!0-9]*) now; FP1=$NOW; FP3=$NOW ;; esac; }
# the shim's own span (its fingerprints included) for the AUT: mu-shim.log, so the timed rule counts
# the rig's overhead as time in mu, not as time the answer spent elsewhere
if [ -n "$aut" ]; then
  fp; s0=$FP1; before=$FP2; s=$FP3
  [ -d "$D/mu-out" ] || mkdir -p "$D/mu-out"
  node ${JSON.stringify(cli)} "$@" | ${teeWithP()} "$D/mu-out/$$"
  rc=\${PIPESTATUS[0]}
  fp; e=$FP1; after=$FP2; s1=$FP3
else
  [ -n "$D" ] && now && s=$NOW
  node ${JSON.stringify(cli)} "$@"
  rc=$?
  [ -n "$D" ] && now && e=$NOW
fi
if [ -n "$D" ]; then
  who=\${MU_AGENT_NAME:--}; [ -n "$aut" ] && who=-
  args=$*; args=\${args//$'\n'/ }
  printf '%s %s %s %s %s %s\n' "$s" "$e" "$rc" "$who" "$$" "$args" >> "$D/mu-calls.log" 2>/dev/null
fi
[ -n "$aut" ] && printf '%s|%s|%s\n' "$$" "$before" "$after" >> "$D/mu-local.log" 2>/dev/null
[ -n "$aut" ] && printf '%s %s %s\n' "$$" "$s0" "$s1" >> "$D/mu-shim.log" 2>/dev/null
exit $rc
`)}`;
}

const hostPiInfo: { version?: string; models?: string } = {};

function hostPiOutput(arg: string, fallback: string): string {
  try {
    return execFileSync(REAL_PI, [arg], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return fallback;
  }
}

/** Where the sandbox keeps what the AUT must not stumble on: the real pi (as a sandbox-path symlink, so `ps` shows no host path) and the faux pi's real command line. */
export function sandboxPi(dir: string): string {
  // named `pi`: a launcher may dispatch on its argv0's basename
  return join(dir, ".rt", "real", "pi");
}

/**
 * The sandbox's `pi`: scripted workers behind a wrapper that looks like a real pi. `--version` and
 * `--list-models` answer from the host pi's own output (captured once), so the AUT finds nothing odd
 * and cannot learn the real pi path, the host's ~/.local/bin or the evalfaux provider from bin/pi.
 */
function installFauxPi(dir: string, binDir: string, surface: Surface): void {
  const rt = join(dir, ".rt");
  mkdirSync(rt, { recursive: true });
  hostPiInfo.version ??= hostPiOutput("--version", "pi\n");
  hostPiInfo.models ??= hostPiOutput(
    "--list-models",
    "provider  model  context  max-out  thinking  images\n",
  );
  writeFileSync(join(rt, "version"), hostPiInfo.version);
  writeFileSync(join(rt, "models"), hostPiInfo.models);
  mkdirSync(dirname(sandboxPi(dir)), { recursive: true });
  symlinkSync(REAL_PI, sandboxPi(dir));
  writeShim(
    join(rt, "pi"),
    `exec env MU_NUDGE=0 ${JSON.stringify(sandboxPi(dir))} "$@" --no-extensions -e ${JSON.stringify(surface.extension)} -e ${JSON.stringify(stageRig(dir, "faux.ts"))} --no-skills --no-context-files --no-session --model evalfaux/worker`,
  );
  writeShim(
    join(binDir, "pi"),
    `for a in "$@"; do
  case "$a" in
    -v|--version) cat ${JSON.stringify(join(rt, "version"))}; exit 0;;
    --list-models) cat ${JSON.stringify(join(rt, "models"))}; exit 0;;
  esac
done
exec ${JSON.stringify(join(rt, "pi"))} "$@"`,
  );
}

/**
 * A live sandbox's `pi`: the user's pi with the surface's extension and the provider extension
 * (as the AUT runs), the sandbox's copy of the mu skill, no context files.
 */
function installLivePi(dir: string, binDir: string, surface: Surface, providerExt?: string): void {
  mkdirSync(join(dir, ".rt"), { recursive: true });
  mkdirSync(dirname(sandboxPi(dir)), { recursive: true });
  symlinkSync(REAL_PI, sandboxPi(dir));
  writeShim(
    join(binDir, "pi"),
    `for a in "$@"; do
  case "$a" in
    -v|--version|--list-models) exec ${JSON.stringify(sandboxPi(dir))} "$@";;
  esac
done
exec ${JSON.stringify(sandboxPi(dir))} "$@" --no-extensions${providerExt ? ` -e ${JSON.stringify(providerExt)}` : ""} -e ${JSON.stringify(surface.extension)} --no-skills --skill ${JSON.stringify(sandboxSkillDir(dir))} --no-context-files`,
  );
}

/**
 * bin/mu, bin/tmux and (live) the shell startup files. Every shim and every shell startup
 * re-applies the sandbox's isolation variables, baked in now: a harness's shell tool re-sources the
 * user's rc, which may point mu elsewhere.
 */
export function writeIsolatedShims(o: {
  dir: string;
  binDir: string;
  env: Record<string, string | undefined>;
  cli: string;
  live: boolean;
  tmuxBin: string;
  tmuxSocket: string;
}): void {
  const pin = pinScript(o.env, o.binDir);
  if (o.live) writeShellStartup(o.dir, pin);
  writeFileSync(join(o.binDir, "mu"), muShim(o.cli, pin), { mode: 0o755 });
  // Bare tmux from the AUT or a worker joins the run's private server (an explicit later -L/-S
  // still wins, but TMUX_TMPDIR keeps even that inside the sandbox).
  writeShim(
    join(o.binDir, "tmux"),
    `export TMUX_TMPDIR=${JSON.stringify(o.env.TMUX_TMPDIR ?? join(o.dir, "tmux-tmp"))}\nexec ${JSON.stringify(o.tmuxBin)} -L ${o.tmuxSocket} "$@"`,
  );
}

export interface SandboxOptions {
  env?: Record<string, string>;
  /**
   * Real harness binaries (claude, codex, cursor-agent, muse, pi) and the caller's own HOME and
   * auth (sandboxEnv `live`). Default: fake harnesses and faux pis, HOME inside the sandbox.
   */
  live?: boolean;
  /** The provider extension a live pi worker loads (as the AUT does). */
  /** Run the user's pi (live); without it the sandbox's pi is the faux one. */
  livePi?: boolean;
  /** A pi provider extension for a live pi; none means pi's own built-in providers. */
  providerExt?: string;
  /** Hook harnesses: binaries, tool shims and hook entries (harness.ts). */
  harness?: { tools: HookTools; codexHooks?: CodexHooks; stopTimeoutS?: number; fake?: boolean };
}

export async function createSandbox(surface: Surface, opts: SandboxOptions = {}): Promise<Sandbox> {
  assertInRow("createSandbox");
  const tmuxBin = realTmux(); // fail before creating anything on disk
  const id = `mu-eval-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const dir = join(tmpdir(), id);
  const tmuxSocket = id;
  if (tmuxSocketPath(dir, tmuxSocket).length > SOCKET_PATH_MAX) {
    throw new Error(
      `tmux socket path too long (${tmuxSocketPath(dir, tmuxSocket).length}); set TMPDIR shorter`,
    );
  }
  const isLive = opts.live === true;
  const env = {
    ...sandboxEnv(dir, surface, tmuxSocket, process.env, { live: isLive }),
    ...opts.env,
  };
  if (isLive && opts.harness?.codexHooks === "codex-home") env.CODEX_HOME = join(dir, "codex-home");
  const binDir = join(dir, "bin");
  const repoDir = join(dir, "repo");
  const workerDir = join(dir, "workers");
  for (const sub of [
    "home",
    "state",
    "sync",
    "sessions",
    "pi-agent",
    "bin",
    "repo",
    "workers",
    "tmp",
    "skills",
    "murmur",
  ]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  mkdirSync(join(dir, "home", ".local", "state"), { recursive: true });
  mkdirSync(join(dir, "home", ".cache"), { recursive: true });
  writeFileSync(
    join(dir, "pi-agent", "settings.json"),
    `${JSON.stringify({ retry: { enabled: false } })}\n`,
  );
  seedLauncherCache(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    join(dir, "pi-agent"),
  );

  if (existsSync(surface.skillDir))
    cpSync(surface.skillDir, sandboxSkillDir(dir), { recursive: true });
  linkTools(binDir, process.env.PATH);
  // Record-only observer (see observe.ts): every mu invocation appends
  // "<start-ms> <end-ms> <exit> <agent|-> <pid> <argv>" to <workers>/mu-calls.log, and the AUT's own
  // calls (no MU_AGENT_NAME) also tee their stdout to <workers>/mu-out/<pid>. The shim changes
  // neither the exit status nor the output, so a judge can tell what mu itself returned (and when)
  // from what the AUT's shell printed around it.
  writeIsolatedShims({ dir, binDir, env, cli: surface.cli, live: isLive, tmuxBin, tmuxSocket });
  // Workers and delegates are scripted: faux model, no mu nudges (they would only rerun the script).
  // The AUT sees a plain `pi` that answers --version / --list-models like the real one; the real pi
  // path, the extension paths and the faux model name sit one level down in <dir>/.rt (never in bin/).
  if (isLive && opts.livePi === true) installLivePi(dir, binDir, surface, opts.providerExt);
  else installFauxPi(dir, binDir, surface);

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
      entry.restore();
      for (const sock of entry.sockets()) killServer(sock);
      if (!o?.keep) removeClosed(dir);
    },
  };
  const entry = { dir, sockets: () => sandboxSockets(dir, tmuxSocket), restore: () => {} };
  live.add(entry);
  installHandlers();

  try {
    await sh(
      sb,
      "git init -q -b main && printf '# eval repo\\n' > README.md && git add README.md && git commit -q -m init",
    );
    // `mu workspace refresh` rebases onto origin/HEAD, which a repo with no remote lacks. Point it at
    // local main: always current, no second copy of the repo to keep in step.
    await sh(sb, "git symbolic-ref refs/remotes/origin/HEAD refs/heads/main");
    if (opts.harness) {
      const hs = await setupHarnesses(sb, {
        live: isLive,
        skillDir: sandboxSkillDir(dir),
        ...opts.harness,
      });
      entry.restore = hs.restore;
    }
    mkdirSync(env.TMUX_TMPDIR ?? join(dir, "tmux-tmp"), { recursive: true });
    await sh(sb, `tmux -L ${tmuxSocket} -f /dev/null new-session -d -s eval-boot`);
  } catch (e) {
    await sb.close();
    throw e;
  }
  return sb;
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
