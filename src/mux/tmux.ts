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
  type MuxBackend,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  type MuxPane,
  type MuxSession,
  type MuxWindow,
  type NewSessionOptions,
  type NewSessionWithPaneOptions,
  type NewWindowOptions,
  PaneNotFoundError,
  parseAgentNameFromTitle,
  type SplitWindowOptions,
} from "./types.js";

// Re-exported so the historical `import { ... } from "./tmux.js"` surface
// keeps resolving these names (47 test files and 12 src modules use it).
export {
  type AttachTarget,
  type CaptureOptions,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  type NewSessionOptions,
  type NewSessionWithPaneOptions,
  type NewWindowOptions,
  PaneNotFoundError,
  parseAgentNameFromTitle,
  type SplitWindowOptions,
};

/** Back-compat aliases: tmux-specific names predating the MuxBackend
 *  extraction. Same shapes, now owned by ./types.js. */
export type TmuxSession = MuxSession;
export type TmuxWindow = MuxWindow;
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

// ─── Domain types ──────────────────────────────────────────────────────

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

export async function listSessions(): Promise<TmuxSession[]> {
  // `list-sessions` exits 1 when no sessions exist; treat as empty.
  try {
    const out = await tmux(["list-sessions", "-F", "#{session_name}"]);
    return out
      .split("\n")
      .filter((line) => line.length > 0)
      .map((name) => ({ name }));
  } catch (err) {
    if (
      err instanceof TmuxError &&
      (NO_SERVER_RE.test(err.stderr) || /no sessions/i.test(err.stderr))
    ) {
      return [];
    }
    throw err;
  }
}

export async function sessionExists(name: string): Promise<boolean> {
  const result = await currentExecutor(["has-session", "-t", exactSessionTarget(name)]);
  return result.exitCode === 0;
}

/**
 * A detached session otherwise gets tmux's default-size (80x24), so
 * `mu agent read` captures wrap at 80. Never resize-window: it pins
 * window-size to manual.
 */
const DETACHED_SIZE = ["-x", "200", "-y", "50"];

export async function newSession(name: string, opts: NewSessionOptions = {}): Promise<void> {
  const args = ["new-session"];
  if (opts.detached !== false) args.push("-d", ...DETACHED_SIZE);
  args.push("-s", name);
  if (opts.windowName) args.push("-n", opts.windowName);
  if (opts.cwd) args.push("-c", opts.cwd);
  appendEnvFlags(args, opts.env);
  if (opts.command) args.push(opts.command);
  await tmux(args);
}

/**
 * Create a tmux session AND its first window+pane in one atomic call.
 * Returns the new pane's stable id. Used by mu when spawning the first
 * agent in a workstream so we never end up with an empty `mu-<workstream>`
 * session left behind by a failed spawn.
 */
export async function newSessionWithPane(
  name: string,
  opts: NewSessionWithPaneOptions,
): Promise<string> {
  const args = ["new-session"];
  if (opts.detached !== false) args.push("-d", ...DETACHED_SIZE);
  args.push("-s", name, "-n", opts.windowName);
  if (opts.cwd) args.push("-c", opts.cwd);
  appendEnvFlags(args, opts.env);
  args.push("-P", "-F", "#{pane_id}", opts.command);
  const out = (await tmux(args)).trim();
  assertValidPaneId(out);
  return out;
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

// ─── Windows ───────────────────────────────────────────────────────────

export async function listWindows(session?: string): Promise<TmuxWindow[]> {
  if (session) {
    const out = await tmux([
      "list-windows",
      "-t",
      exactSessionTarget(session),
      "-F",
      "#{window_id}\t#{window_name}",
    ]);
    return parseWindows(out);
  }
  // Cross-session: include the session name.
  const out = await tmux([
    "list-windows",
    "-a",
    "-F",
    "#{session_name}\t#{window_id}\t#{window_name}",
  ]);
  const windows: TmuxWindow[] = [];
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const [sessionName, id, name] = line.split("\t");
    if (!sessionName || !id || name === undefined) continue;
    windows.push({ id, name, sessionName });
  }
  return windows;
}

function parseWindows(output: string): TmuxWindow[] {
  const windows: TmuxWindow[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const [id, name] = line.split("\t");
    if (!id || name === undefined) continue;
    windows.push({ id, name });
  }
  return windows;
}

/**
 * Create a new tmux window with one pane. Returns the new pane's stable
 * pane id (e.g. `%15`).
 */
export async function newWindow(opts: NewWindowOptions): Promise<string> {
  const args = ["new-window"];
  if (opts.detached !== false) args.push("-d");
  if (opts.session) args.push("-t", exactSessionTarget(opts.session));
  args.push("-n", opts.name);
  if (opts.cwd) args.push("-c", opts.cwd);
  appendEnvFlags(args, opts.env);
  args.push("-P", "-F", "#{pane_id}", opts.command);
  const out = (await tmux(args)).trim();
  assertValidPaneId(out);
  return out;
}

// ─── Panes ─────────────────────────────────────────────────────────────

/**
 * List ALL panes in a tmux session (across every window). Used by
 * reconciliation to find every pane in the workstream's session.
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
 * with zero sessions), so we match any of them.
 */
export async function listPanesInSession(session: string): Promise<TmuxPane[]> {
  const args = [
    "list-panes",
    "-s",
    "-t",
    exactSessionTarget(session),
    "-F",
    "#{window_id}\t#{pane_id}\t#{pane_title}\t#{pane_current_command}",
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
  const panes: TmuxPane[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [windowId, paneId, title, command] = line.split("\t");
    if (!windowId || !paneId || command === undefined) continue;
    panes.push({ paneId, title: title ?? "", command, windowId });
  }
  return panes;
}

/**
 * List panes in the current session, a specific window/session target, or
 * all panes across all sessions when `target` is the literal "*".
 */
export async function listPanes(target?: string): Promise<TmuxPane[]> {
  if (target === "*") {
    const out = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_title}\t#{pane_current_command}",
    ]);
    const panes: TmuxPane[] = [];
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      const [sessionName, windowId, paneId, title, command] = line.split("\t");
      if (!sessionName || !windowId || !paneId || command === undefined) continue;
      panes.push({ paneId, title: title ?? "", command, windowId, sessionName });
    }
    return panes;
  }

  const args = ["list-panes"];
  if (target !== undefined) args.push("-t", target);
  args.push("-F", "#{pane_id}\t#{pane_title}\t#{pane_current_command}");
  const out = await tmux(args);
  const panes: TmuxPane[] = [];
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const [paneId, title, command] = line.split("\t");
    if (!paneId || command === undefined) continue;
    panes.push({ paneId, title: title ?? "", command });
  }
  return panes;
}

/**
 * Split a window and run a command in the new pane. Returns the new pane's
 * stable pane id.
 */
export async function splitWindow(opts: SplitWindowOptions): Promise<string> {
  const args = ["split-window"];
  if (opts.horizontal !== false) args.push("-h");
  if (opts.detached !== false) args.push("-d");
  args.push("-t", opts.target);
  if (opts.cwd) args.push("-c", opts.cwd);
  appendEnvFlags(args, opts.env);
  args.push("-P", "-F", "#{pane_id}", opts.command);
  const out = (await tmux(args)).trim();
  assertValidPaneId(out);
  return out;
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

export async function paneExists(paneId: string): Promise<boolean> {
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

export async function setPaneTitle(paneId: string, title: string): Promise<void> {
  assertValidPaneId(paneId);
  await tmux(["select-pane", "-t", paneId, "-T", title]);
}

/** Pane-scoped `allow-set-title off`: OSC title escapes from the app no longer overwrite the mu title. */
export async function lockPaneTitle(paneId: string): Promise<void> {
  assertValidPaneId(paneId);
  await tmux(["set-option", "-p", "-t", paneId, "allow-set-title", "off"]);
}

/**
 * Look up the window id (e.g. `@42`) that contains a given pane id
 * (e.g. `%15`). Used by spawn so we can apply window-scoped options
 * (`pane-border-status`) to the freshly created window.
 *
 * Returns undefined if the pane no longer exists.
 */
export async function getWindowIdForPane(paneId: string): Promise<string | undefined> {
  if (!isValidPaneId(paneId)) return undefined;
  const result = await currentExecutor(["display-message", "-t", paneId, "-p", "#{window_id}"]);
  if (result.exitCode !== 0) return undefined;
  const id = result.stdout.trim();
  return id.length > 0 ? id : undefined;
}

/**
 * Single source of truth for the operator opt-out from the mu pane
 * banner / border decorations. Set `MU_BANNER_QUIET=1` to disable.
 * All `enableMuPaneBorders*` helpers self-check this so callers
 * don't have to wrap them in env guards (a footgun: forget the
 * guard and you set the border even when the operator wanted
 * quiet).
 */
function muBannersDisabled(): boolean {
  return process.env.MU_BANNER_QUIET === "1";
}

/**
 * Enable the mu pane border on EVERY window currently in `session`
 * without overriding the user's pane-border format. Idempotent. Best-effort:
 * windows that have vanished mid-iteration are silently skipped. Used
 * by `mu workstream init` (covers the placeholder `_mu` window plus
 * any windows that already exist, e.g. on re-init of an upgraded
 * mu-pre-border session) and by `mu agent spawn` (covers the
 * just-created window so the border shows immediately on attach).
 *
 * No-op (returns 0) when `MU_BANNER_QUIET=1`.
 *
 * Returns the number of windows that received the option.
 */
export async function enableMuPaneBordersForSession(session: string): Promise<number> {
  if (muBannersDisabled()) return 0;
  const windows = await listWindows(session).catch(() => []);
  let n = 0;
  for (const w of windows) {
    try {
      await enableMuPaneBorders(w.id);
      n += 1;
    } catch {
      // Window vanished; skip silently. Border is decorative.
    }
  }
  return n;
}

/**
 * Apply the mu pane border to the window containing `paneId`. This is
 * the spawn shape: callers have a pane id (from `new-window` or
 * `split-window`), and need to resolve the enclosing window
 * before calling `enableMuPaneBorders` (a window-scoped option).
 *
 * Self-checks `MU_BANNER_QUIET` and swallows tmux errors — the border
 * is decorative; failing to set it is never load-bearing.
 */
export async function enableMuPaneBordersForPane(paneId: string): Promise<void> {
  if (muBannersDisabled()) return;
  if (!isValidPaneId(paneId)) return;
  // Target the pane directly: `set-option -w` resolves a pane target to
  // its window, so no `display-message #{window_id}` round-trip needed.
  await enableMuPaneBorders(paneId).catch(() => {});
}

/**
 * Enable a one-line top pane border on a specific window/session target.
 * The user's inherited `pane-border-format` is left intact; mu owns the
 * title's durable context, not border presentation. Idempotent
 * (`set-option` is a write, not a toggle).
 *
 * IMPORTANT: tmux's `pane-border-status` is a **window** option, not a
 * session option. `set-option -t <session>`
 * only updates the active window at call time — windows created later
 * inherit from the GLOBAL value (which is `off` by default and which
 * we deliberately do NOT touch, since changing the global would
 * affect every other tmux session on the user's machine, including
 * dotfile-curated ones).
 *
 * Therefore mu must call this twice:
 *   1. At `mu workstream init` time on the placeholder `_mu` window
 *      (so an attached operator sees a border immediately).
 *   2. On every `mu agent spawn` (which calls `tmux new-window`),
 *      against the new window's id.
 *
 * The border is tmux chrome, not pane content: it doesn't scroll, it
 * survives copy-mode, and the inner CLI never sees it.
 *
 * Designed as the pane-border visual cue for mu-managed panes.
 */
export async function enableMuPaneBorders(target: string): Promise<void> {
  if (muBannersDisabled()) return;
  // One tmux invocation (`;`-chained) instead of four: each spawn of the
  // tmux client costs ~10 ms. tmux aborts the chain at the first error.
  // Bottom + sides: heavy box-drawing lines so a mu-managed pane is
  // visually distinct even when not the active pane (top carries the
  // labeled status text; the rest of the frame carries the visual
  // "this is mu" cue). Cyan-bold for the active pane, dim brightblack
  // for inactive ones, so the operator's eye lands on the pane that
  // currently has focus.
  await tmux([
    ...["set-option", "-w", "-t", target, "pane-border-status", "top"],
    ";",
    ...["set-option", "-w", "-t", target, "pane-border-lines", "heavy"],
    ";",
    ...["set-option", "-w", "-t", target, "pane-active-border-style", "fg=cyan,bold"],
    ";",
    ...["set-option", "-w", "-t", target, "pane-border-style", "fg=brightblack"],
  ]);
}

export async function getPaneTitle(paneId: string): Promise<string | undefined> {
  if (!isValidPaneId(paneId)) return undefined;
  const result = await currentExecutor(["display-message", "-t", paneId, "-p", "#{pane_title}"]);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trimEnd();
}

/**
 * Read the title of the *current* pane (the one whose shell is running this
 * process), via $TMUX_PANE. Returns undefined when not inside tmux. Used by
 * `mu claim` to derive the agent identity from the pane title — the claim
 * protocol's zero-config identity step.
 */
export async function currentPaneTitle(): Promise<string | undefined> {
  const paneId = process.env.TMUX_PANE;
  if (!paneId || !isValidPaneId(paneId)) return undefined;
  return getPaneTitle(paneId);
}

/**
 * Convenience: read the current pane's title and extract the agent name.
 */
export async function currentAgentName(): Promise<string | undefined> {
  const title = await currentPaneTitle();
  if (title === undefined) return undefined;
  return parseAgentNameFromTitle(title);
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

export async function selectLayout(window: string, layout: string): Promise<void> {
  await tmux(["select-layout", "-t", window, layout]);
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
export async function capturePane(paneId: string, opts: CaptureOptions = {}): Promise<string> {
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
// repoints the existing client and returns immediately. From outside
// it is `attach-session` followed by a separate `select-window`: `tmux
// attach -t session:window` does not reliably select the window across
// tmux versions, and the select must run after the attach detaches.

function attachTargetSpec(target: AttachTarget): string {
  return target.window === undefined ? target.session : `${target.session}:${target.window}`;
}

export function attachHint(target: AttachTarget): string {
  const spec = attachTargetSpec(target);
  if (target.inside === true) return `tmux switch-client -t ${spec}`;
  if (target.window === undefined) return `tmux attach -t ${target.session}`;
  return `tmux attach -t ${target.session} && tmux select-window -t ${spec}`;
}

export function attachCommands(target: AttachTarget): readonly MuxCommand[] {
  const spec = attachTargetSpec(target);
  if (target.inside === true) {
    return [{ command: "tmux", args: ["switch-client", "-t", spec] }];
  }
  const steps: MuxCommand[] = [{ command: "tmux", args: ["attach-session", "-t", target.session] }];
  if (target.window !== undefined) {
    // Best-effort: if it fails the user is at least in the right session.
    steps.push({ command: "tmux", args: ["select-window", "-t", spec], optional: true });
  }
  return steps;
}

// ─── Diagnostics ────────────────────────────────────────────────

export function paneNotFoundNextSteps(paneId: string): NextStep[] {
  return [
    {
      intent: `Verify the pane id ${paneId} actually exists`,
      command: `tmux display-message -t ${paneId} -p '#{pane_id} #{pane_title}'`,
    },
    {
      intent: "List all live panes across all sessions",
      command:
        "tmux list-panes -a -F '#{session_name}:#{window_id}.#{pane_id}\\t#{pane_title}\\t#{pane_current_command}'",
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

/** `MuxBackend` with tmux's synchronous attach methods: SDK callers of
 *  `tmuxBackend.attachHint()` keep getting a string, not a Promise. */
export interface TmuxBackend extends MuxBackend {
  attachHint(target: AttachTarget): string;
  attachCommands(target: AttachTarget): readonly MuxCommand[];
}

/**
 * The tmux implementation of `MuxBackend`. A frozen record of the
 * module's functions — no state of its own, so swapping backends is a
 * pointer assignment (see ./detect.ts).
 */
export const tmuxBackend: TmuxBackend = Object.freeze({
  name: "tmux" as const,
  available: tmuxAvailable,

  isValidPaneId,
  assertValidPaneId,

  listSessions,
  sessionExists,
  newSession,
  newSessionWithPane,
  killSession,

  listWindows,
  newWindow,
  selectLayout,

  listPanes,
  listPanesInSession,
  splitWindow,
  killPane,
  paneExists,

  setPaneTitle,
  lockPaneTitle,
  getPaneTitle,
  currentAgentName,
  currentSessionName,

  capturePane,

  enableMuPaneBordersForSession,
  enableMuPaneBordersForPane,

  attachHint,
  attachCommands,

  paneNotFoundNextSteps,
  healthCheck,
});
