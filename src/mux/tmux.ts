// mu — tmux substrate.
//
// Single source of truth for all tmux interactions. Every tmux invocation
// goes through `tmux(args)`, which wraps child_process and produces structured
// `TmuxError`s carrying args + stderr.
//
// tmux has no `sendToPane`: a bracketed paste cannot be confirmed
// (cut in mu-next). pi agents use the control socket
// (src/agents/transport.ts); herdr has its own atomic `agent prompt`.

import { execFileCapture } from "../exec-file.js";
import type { NextStep } from "../output.js";
import {
  type AttachTarget,
  type CaptureOptions,
  type EnsureSessionResult,
  MU_PLACEHOLDER_WINDOW,
  type MuxBackend,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  type MuxPane,
  PaneNotFoundError,
  type SpawnAgentPaneOptions,
} from "./types.js";

// Re-exported so the historical `import { ... } from "./tmux.js"` surface
// keeps resolving these names.
export {
  type AttachTarget,
  type CaptureOptions,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  PaneNotFoundError,
};

/** Back-compat alias: tmux-specific name predating the MuxBackend extraction. */
export type TmuxPane = MuxPane;

// ─── Error type ────────────────────────────────────────────────────────

export class TmuxError extends MuxError {
  constructor(
    public readonly args: readonly string[],
    public readonly stderr: string,
    public readonly stdout: string,
    public readonly exitCode: number | null,
  ) {
    const detail = stderr.trim() || stdout.trim() || "no output";
    super(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${detail}`);
    this.name = "TmuxError";
  }
  override errorNextSteps(): NextStep[] {
    return [
      { intent: "Run health check", command: "mu doctor" },
      {
        intent: "Verify tmux is running and reachable",
        command: "tmux info | head",
      },
      {
        intent: "Check the failing tmux command in isolation",
        command: `tmux ${this.args.join(" ")}`,
      },
    ];
  }
}

// ─── Pane ID validation ────────────────────────────────────────────────

/**
 * Stable tmux pane IDs are of the form `%N` (e.g. "%15"). They never change
 * for the lifetime of the pane. **Pane indexes** (0, 1, 2…) are volatile and
 * shift when other panes close — never store or pass them.
 */
export const PANE_ID_RE = /^%\d+$/;

export function isValidPaneId(s: string): boolean {
  return PANE_ID_RE.test(s);
}

export function assertValidPaneId(s: string): void {
  if (!isValidPaneId(s)) {
    throw new TypeError(`invalid tmux pane id: ${JSON.stringify(s)} (expected /^%\\d+$/)`);
  }
}

// ─── Executor (swappable for tests) ────────────────────────────────────

export interface TmuxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type TmuxExecutor = (args: readonly string[]) => Promise<TmuxExecResult>;

/**
 * Optional global-flag prefix to splice in front of every tmux args
 * vector. When `MU_TMUX_SOCKET=<name>` is set, this returns
 * `["-L", name, "-f", "/dev/null"]`:
 *
 *   `-L <name>` routes every call through a private tmux server with
 *   the given socket name (Linux: `/tmp/tmux-<uid>/<name>`,
 *   macOS: `$TMPDIR/tmux-<uid>/<name>`) instead of the user's default
 *   `/tmp/tmux-<uid>/default`. Set by the test harness in Layer 3 of
 *   bug_test_suite_flake_leaks_isolation so the integration suite
 *   can never observe — or contaminate — the user's interactive
 *   tmux server.
 *
 *   `-f /dev/null` skips the user's `~/.tmux.conf`. This matters
 *   because tmux auto-starts the server on the first client call if
 *   none is running (e.g. after a test’s last `kill-session`
 *   shuts the server down). A typical user config uses `run-shell`
 *   for status-bar plugins (TPM, hostname/network probes), and each
 *   such hook adds ~1–4s to that auto-start. Without `-f /dev/null`
 *   a single integration test grows from 3s to 48s on a configured
 *   dev box. The suite drives tmux through the documented protocol,
 *   not through bound keys, so the user's config is irrelevant.
 *
 * Read fresh on every call so a setupFiles hook that mutates
 * `process.env.MU_TMUX_SOCKET` mid-run takes effect immediately.
 *
 * Production code never sets this; it's a test-isolation seam.
 */
function tmuxGlobalFlags(): readonly string[] {
  const socket = process.env.MU_TMUX_SOCKET;
  if (socket === undefined || socket.length === 0) return [];
  return ["-L", socket, "-f", "/dev/null"];
}

const realExecutor: TmuxExecutor = (args) =>
  execFileCapture("tmux", [...tmuxGlobalFlags(), ...args]);

let currentExecutor: TmuxExecutor = realExecutor;

/**
 * Install a custom executor (for tests). Returns the previous executor so
 * tests can restore it cleanly. Production code should never call this.
 */
export function setTmuxExecutor(executor: TmuxExecutor): TmuxExecutor {
  const previous = currentExecutor;
  currentExecutor = executor;
  return previous;
}

/** Restore the real (child_process-backed) executor. */
export function resetTmuxExecutor(): void {
  currentExecutor = realExecutor;
}

/**
 * Run an arbitrary tmux command. The single point of contact with the
 * tmux binary; every higher-level operation in this module goes through it.
 *
 * Throws `TmuxError` on non-zero exit. Returns stdout on success.
 */
export async function tmux(args: readonly string[]): Promise<string> {
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    throw new TmuxError([...args], result.stderr, result.stdout, result.exitCode);
  }
  return result.stdout;
}

// ─── Sleep helper (testable) ──────────────────────────────────────────

let currentSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setSleepForTests(
  impl: (ms: number) => Promise<void>,
): (ms: number) => Promise<void> {
  const previous = currentSleep;
  currentSleep = impl;
  return previous;
}

export function resetSleep(): void {
  currentSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-aware sleep — honours `setSleepForTests`. Public so other modules
 *  (notably `agents.ts` for spawn liveness polling) get free no-op-ing in
 *  tests without re-implementing the swap. */
export function sleep(ms: number): Promise<void> {
  return currentSleep(ms);
}

// ─── Sessions ──────────────────────────────────────────────────────────

/**
 * The `-t` form that names session `name` EXACTLY. A bare `-t mu-auth`
 * falls back to prefix matching, so it resolves to `mu-auth-refactor`
 * when `mu-auth` does not exist, and a teardown of workstream `auth`
 * kills another workstream's session. `=` disables the prefix and
 * pattern fallback. The trailing `:` makes it a session target for
 * pane- and window-scoped verbs too: `list-panes -s -t =mu-auth`
 * still prefix-matches through the pane lookup, but
 * `-t =mu-auth:` does not (verified on tmux 3.7c).
 */
function exactSessionTarget(name: string): string {
  return `=${name}:`;
}

/**
 * stderr shapes that mean "no tmux server is running", so there is no
 * session, window or pane to find. tmux prints "no server running on
 * <path>" when the socket file exists but nothing listens, and "error
 * connecting to <path> (No such file or directory)" when the socket file
 * does not exist at all (fresh boot, cleared /tmp, new TMUX_TMPDIR).
 * Other "error connecting" causes, such as permission denied, stay
 * real errors.
 */
const NO_SERVER_RE = /no server running|error connecting to .*\(No such file or directory\)/i;

async function sessionExists(name: string): Promise<boolean> {
  const result = await currentExecutor(["has-session", "-t", exactSessionTarget(name)]);
  return result.exitCode === 0;
}

/**
 * A detached session otherwise gets tmux's default-size (80x24), so
 * `mu agent read` captures wrap at 80. Never resize-window: it pins
 * window-size to manual.
 */
const DETACHED_SIZE = ["-x", "200", "-y", "50"];

/** `[id, name]` of every window in `session`. */
async function listWindows(session: string): Promise<{ id: string; name: string }[]> {
  const out = await tmux([
    "list-windows",
    "-t",
    exactSessionTarget(session),
    "-F",
    "#{window_id}\t#{window_name}",
  ]);
  const windows: { id: string; name: string }[] = [];
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const [id, name] = line.split("\t");
    if (!id || name === undefined) continue;
    windows.push({ id, name });
  }
  return windows;
}

/**
 * Create `session` with its placeholder `_mu` window when it is missing,
 * and re-add the window when the session exists without it (the operator
 * killed it, or the session predates it). Without `_mu`, closing the last
 * agent kills the last window and tmux destroys the session.
 */
export async function ensureSession(session: string): Promise<EnsureSessionResult> {
  if (!(await sessionExists(session))) {
    await tmux(["new-session", "-d", ...DETACHED_SIZE, "-s", session, "-n", MU_PLACEHOLDER_WINDOW]);
    return { created: true, repaired: false };
  }
  const windows = await listWindows(session).catch(() => []);
  if (windows.some((w) => w.name === MU_PLACEHOLDER_WINDOW)) {
    return { created: false, repaired: false };
  }
  await tmux([
    "new-window",
    "-d",
    "-t",
    exactSessionTarget(session),
    "-n",
    MU_PLACEHOLDER_WINDOW,
    process.env.SHELL ?? "/bin/sh",
  ]);
  return { created: false, repaired: true };
}

/**
 * Idempotent: succeeds even if the session is already gone.
 *
 * Four swallowed shapes:
 *   - "can't find session: <name>"  — session never existed.
 *   - "session not found"           — alternate phrasing on some tmux builds.
 *   - "no server running on <path>" (or "error connecting to <path> (No
 *     such file or directory)", see NO_SERVER_RE) — the tmux server itself has exited
 *     (typical when the test suite runs against a private `tmux -L
 *     <socket>` server and the just-killed session was its last; tmux
 *     quietly shuts the server down). Without this, killSession would
 *     throw on the very next idempotent call — only visible under
 *     Layer 3 of bug_test_suite_flake_leaks_isolation.
 *   - "no current target"           — the server is UP but has zero
 *     sessions, so `-t <name>` has no session list to resolve against
 *     and tmux never gets as far as "can't find session". Reachable
 *     whenever the server outlives its last session: the suite's
 *     private server (`exit-empty off`, see test/_global-teardown.ts)
 *     and any user whose ~/.tmux.conf sets `exit-empty off`. Same
 *     meaning as "can't find session" for our purposes — the session
 *     we were asked to kill is gone.
 */
export async function killSession(name: string): Promise<void> {
  const args = ["kill-session", "-t", exactSessionTarget(name)];
  const result = await currentExecutor(args);
  if (
    result.exitCode !== 0 &&
    !/can't find session|session not found|no current target/i.test(result.stderr) &&
    !NO_SERVER_RE.test(result.stderr)
  ) {
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
}

// ─── Panes ─────────────────────────────────────────────────────────────

/**
 * Create the agent's pane and run `opts.command` in it, one tmux call:
 *   - session doesn't exist          → new session+window+pane
 *   - session exists, no such window → new window for this agent
 *   - session and window both exist  → split the window to add a pane
 * Returns the pane's stable id (`%15`).
 */
export async function spawnAgent(opts: SpawnAgentPaneOptions): Promise<string> {
  const tail = (args: string[]): string[] => {
    if (opts.cwd) args.push("-c", opts.cwd);
    appendEnvFlags(args, opts.env);
    args.push("-P", "-F", "#{pane_id}", opts.command);
    return args;
  };
  const created = async (args: string[]): Promise<string> => {
    const paneId = (await tmux(args)).trim();
    assertValidPaneId(paneId);
    opts.onPaneCreated?.(paneId);
    return paneId;
  };

  if (!(await sessionExists(opts.session))) {
    return created(
      tail(["new-session", "-d", ...DETACHED_SIZE, "-s", opts.session, "-n", opts.window]),
    );
  }
  const matching = (await listWindows(opts.session)).find((w) => w.name === opts.window);
  if (matching) {
    // tmux splits a WINDOW: target it as `=<session>:<window_id>`. A bare
    // `<session>:<name>` falls back to tmux's session prefix match, so if
    // `mu-auth` vanishes between list-windows and here, `mu-auth:Backend`
    // splits `mu-auth-refactor`'s Backend window. `=` makes the session
    // exact and the stable window id (from the listing above) must live
    // in that session, so a vanished session or window fails instead of
    // landing elsewhere.
    return created(tail(["split-window", "-h", "-d", "-t", `=${opts.session}:${matching.id}`]));
  }
  return created(
    tail(["new-window", "-d", "-t", exactSessionTarget(opts.session), "-n", opts.window]),
  );
}

/**
 * List ALL panes in a tmux session (across every window).
 *
 * Note `list-panes -t <session>` (no -s) lists panes in the current
 * *window* of that session, not the whole session — a common gotcha.
 * `-s` is the flag that says "all panes in this session."
 *
 * Returns `[]` (not throws) when the session doesn't exist or has no
 * panes. tmux destroys a session as soon as its last pane closes, so the
 * "session was just here a moment ago" case is normal during reconcile.
 * tmux's error wording in this case varies ("can't find session",
 * "can't find window", or "no current target" when the server is up
 * with zero sessions), so we match any of them. Every other failure
 * throws.
 */
export async function listPanes(session: string): Promise<MuxPane[]> {
  const args = [
    "list-panes",
    "-s",
    "-t",
    exactSessionTarget(session),
    "-F",
    "#{window_id}\t#{pane_id}\t#{pane_current_command}",
  ];
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    if (
      /can't find (session|window)|no sessions|no current target/i.test(result.stderr) ||
      NO_SERVER_RE.test(result.stderr)
    ) {
      return [];
    }
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  const panes: MuxPane[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [windowId, paneId, command] = line.split("\t");
    if (!windowId || !paneId || command === undefined) continue;
    panes.push({ paneId, command, windowId });
  }
  return panes;
}

/**
 * Push one `-e KEY=VALUE` flag per entry into `args`, validating that
 * keys are non-empty and contain no `=` (tmux would error obscurely
 * otherwise; throwing TypeError keeps the failure at the call site).
 * No-op when `env` is undefined or empty.
 *
 * Iteration order follows Object.entries (insertion order); tests
 * shouldn't depend on a specific ordering, only on the presence of
 * each `-e KEY=VALUE` pair in the captured args.
 */
function appendEnvFlags(args: string[], env: Record<string, string> | undefined): void {
  if (!env) return;
  for (const [k, v] of Object.entries(env)) {
    if (k.length === 0) {
      throw new TypeError("tmux env key must be non-empty");
    }
    if (k.includes("=")) {
      throw new TypeError(`tmux env key must not contain '=': ${JSON.stringify(k)}`);
    }
    args.push("-e", `${k}=${v}`);
  }
}

/** Idempotent: succeeds even if the pane is already gone. */
export async function killPane(paneId: string): Promise<void> {
  assertValidPaneId(paneId);
  const result = await currentExecutor(["kill-pane", "-t", paneId]);
  if (
    result.exitCode !== 0 &&
    !/can't find pane/i.test(result.stderr) &&
    !NO_SERVER_RE.test(result.stderr)
  ) {
    throw new TmuxError(["kill-pane", "-t", paneId], result.stderr, result.stdout, result.exitCode);
  }
}

export async function paneAlive(paneId: string): Promise<boolean> {
  if (!isValidPaneId(paneId)) return false;
  // tmux's `display-message -t <bogus>` exits 0 but emits empty output; we
  // must check that the echoed pane id matches what we asked for.
  const args = ["display-message", "-t", paneId, "-p", "#{pane_id}"];
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    // Only "the pane or server is gone" means false. Any other failure
    // (permission denied, a broken socket) is unknown, not dead: callers
    // that gate destructive work on liveness must not read it as gone.
    if (/can't find pane|pane not found|no current target/i.test(result.stderr)) return false;
    if (NO_SERVER_RE.test(result.stderr)) return false;
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  return result.stdout.trim() === paneId;
}

/**
 * Name of the tmux session this process is running inside, or
 * undefined outside tmux. Gated on `$TMUX` so a call from a plain
 * shell doesn't get whatever session the server happens to consider
 * current.
 */
export async function currentSessionName(): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined;
  const result = await currentExecutor(["display-message", "-p", "#S"]);
  if (result.exitCode !== 0) return undefined;
  const name = result.stdout.trim();
  return name === "" ? undefined : name;
}

// ─── Capture ───────────────────────────────────────────────────────────

/**
 * Read pane scrollback as plain text (no ANSI escapes).
 *
 * - No options: full scrollback (`-S - -E -`)
 * - `lines: 0`: visible pane only
 * - `lines: N`: last N lines, ending at the last non-blank row
 *
 * `-S -N` counts from the TOP of the visible screen, so tmux returns the
 * N rows above the screen plus every visible row, blank rows below the
 * cursor included. That range always holds the last N non-blank-ended
 * lines, so drop the trailing blank rows and keep the last N.
 */
export async function capture(paneId: string, opts: CaptureOptions = {}): Promise<string> {
  assertValidPaneId(paneId);
  const args = ["capture-pane", "-t", paneId, "-p"];
  if (opts.lines === undefined) {
    args.push("-S", "-", "-E", "-");
  } else if (opts.lines > 0) {
    args.push("-S", `-${opts.lines}`);
    return lastLines(await tmux(args), opts.lines);
  }
  return tmux(args);
}

/** The last `n` lines of `text` after dropping trailing blank lines.
 *  Keeps a trailing newline when `text` had one (tmux prints one). */
function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  if (end === 0) return "";
  const kept = lines.slice(Math.max(0, end - n), end).join("\n");
  return text.endsWith("\n") ? `${kept}\n` : kept;
}

// ─── Backend record ────────────────────────────────────────────────────

/**
 * True iff tmux can be reached right now. `tmux -V` rather than a PATH
 * probe: a tmux binary that cannot execute (broken install, missing
 * libtinfo) is not an available backend, and the version call is the
 * cheapest thing that proves the binary actually runs.
 *
 * Deliberately does NOT require `$TMUX` — mu creates its own detached
 * sessions, so a usable tmux server is enough. `$TMUX` only tells us
 * whether the CALLER is inside a pane, which is a detection-precedence
 * signal (see ./detect.ts), not an availability one.
 */
async function tmuxAvailable(): Promise<boolean> {
  try {
    await tmux(["-V"]);
    return true;
  } catch {
    return false;
  }
}

// ─── Attach ────────────────────────────────────────────────────
//
// From INSIDE a tmux client the right verb is `switch-client`, which
// repoints the existing client and returns immediately. From outside it
// is ONE `attach-session -t <session>:<window>`: the window half of the
// target selects the window the client opens on. (A separate
// `select-window` after the attach would run only once the blocking
// client detached.) Every step carries the same `-L <socket>` as `tmux()`
// does, so the line printed for a private `MU_TMUX_SOCKET` reaches the
// server that holds the session, not the user's default one.

function attachTargetSpec(target: AttachTarget): string {
  return target.window === undefined ? target.session : `${target.session}:${target.window}`;
}

export async function attachCommands(target: AttachTarget): Promise<readonly MuxCommand[]> {
  const spec = attachTargetSpec(target);
  const socket = process.env.MU_TMUX_SOCKET;
  const route = socket === undefined || socket.length === 0 ? [] : ["-L", socket];
  const verb =
    target.inside === true && target.outside !== true ? "switch-client" : "attach-session";
  return [{ command: "tmux", args: [...route, verb, "-t", spec] }];
}

// ─── Diagnostics ────────────────────────────────────────────────

export function paneNotFoundNextSteps(paneId: string): NextStep[] {
  return [
    {
      intent: `Verify the pane id ${paneId} actually exists`,
      command: `tmux display-message -t ${paneId} -p '#{pane_id}'`,
    },
    {
      intent: "List all live panes across all sessions",
      command:
        "tmux list-panes -a -F '#{session_name}:#{window_id}.#{pane_id}\\t#{pane_current_command}'",
    },
  ];
}

/**
 * Version probe + the two ambient env facts tmux exposes. Returns DATA;
 * `mu doctor` owns every string the user sees, so a second backend
 * reporting different env vars needs no doctor change.
 */
export async function healthCheck(): Promise<MuxHealth> {
  let version: string | null = null;
  try {
    version = (await tmux(["-V"])).trim();
  } catch {
    version = null;
  }
  return {
    name: "tmux",
    ok: version !== null,
    version,
    env: [
      { name: "$TMUX", value: process.env.TMUX ?? null },
      { name: "$TMUX_PANE", value: process.env.TMUX_PANE ?? null },
    ],
    remediation: "install tmux ≥ 3.0",
  };
}

/**
 * The tmux implementation of `MuxBackend`. A frozen record of the
 * module's functions — no state of its own, so swapping backends is a
 * pointer assignment (see ./detect.ts).
 */
export const tmuxBackend: MuxBackend = Object.freeze({
  name: "tmux" as const,
  spawnAgentWaitsReady: false,
  runsShellCommand: true,
  available: tmuxAvailable,

  isValidPaneId,
  assertValidPaneId,

  ensureSession,
  killSession,

  spawnAgent,
  listPanes,
  paneAlive,
  killPane,
  capture,

  attachCommands,

  currentSessionName,

  paneNotFoundNextSteps,
  healthCheck,
});
