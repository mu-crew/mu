// mu — Rex substrate.
//
// Single source of truth for all Rex interactions. Every call goes through
// `rex(args)`; structured calls use the server API (`rex api call <method>
// <json>`), which documents its own schemas (`rex api describe <method>`),
// instead of parsing the human CLI. The one CLI verb used is `rex capture`,
// which pages long scrollback in for us.
//
// Topology, the Rex way:
//
//   mu workstream = Rex SESSION labelled `mu-<name>`
//   mu window     = Rex WINDOW (a tab), found by label
//   mu agent      = Rex BLOCK (a terminal pane), id `block:<uuid>`
//
// Rex keeps an empty session, but mu reads "has panes" as "alive", so a
// session still carries the `_mu` shell window, created with it atomically.
// Exit retention is a creation option (`exit.on_completion`), so a retained
// pane is armed before its command can run, with no placeholder respawn.
// Agent status is the Program Status Protocol (OSC 7501): pi reports it
// natively and Rex returns the records from the terminal's `program_status`
// method. Attach is an app action (`session.select`), since the user is
// inside Rex.app already; it needs Remote Control on in the app's settings.

import { constants } from "node:os";
import { join } from "node:path";
import { execFileCapture } from "../exec-file.js";
import { say } from "../messages.js";
import { sleep } from "./tmux.js";
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
  type MuxPaneStatus,
  type PaneResult,
  type SpawnAgentPaneOptions,
} from "./types.js";

// ─── Errors ────────────────────────────────────────────────────────────

/** Rex itself failed. `code` is the server's error code (`not_found`, …) when it gave one. */
export class RexError extends MuxError {
  constructor(
    public readonly args: readonly string[],
    public readonly stderr: string,
    public readonly exitCode: number | null,
    public readonly code?: string,
  ) {
    super(say("mux.rex_failed", args, exitCode, stderr.trim() || "no output"));
    this.name = "RexError";
  }
}

// ─── Pane ID validation ────────────────────────────────────────────────

/** Rex block ids are `block:<uuid>`, stable for the block's life and never reused. */
export const PANE_ID_RE = /^block:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidPaneId(s: string): boolean {
  return PANE_ID_RE.test(s);
}

export function assertValidPaneId(s: string): void {
  if (!isValidPaneId(s)) {
    throw new TypeError(`invalid rex block id: ${JSON.stringify(s)} (expected block:<uuid>)`);
  }
}

// ─── Executor (swappable for tests) ────────────────────────────────────

export interface RexExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type RexExecutor = (args: readonly string[]) => Promise<RexExecResult>;

/** `-S <server>` when `MU_REX_SERVER` names one: a private server (tests, demos). */
function rexGlobalFlags(): readonly string[] {
  const server = process.env.MU_REX_SERVER;
  return server === undefined || server.length === 0 ? [] : ["-S", server];
}

/** Rex puts its own CLI's directory in `$REX_BIN_DIR` in every pane; prefer it over PATH. */
function rexBinary(): string {
  const dir = process.env.REX_BIN_DIR;
  return dir === undefined || dir.length === 0 ? "rex" : join(dir, "rex");
}

const realExecutor: RexExecutor = (args) =>
  execFileCapture(rexBinary(), [...rexGlobalFlags(), ...args]);

let currentExecutor: RexExecutor = realExecutor;

/** Install a custom executor (tests). Returns the previous one. */
export function setRexExecutor(executor: RexExecutor): RexExecutor {
  const previous = currentExecutor;
  currentExecutor = executor;
  return previous;
}

export function resetRexExecutor(): void {
  currentExecutor = realExecutor;
}

/** The server's error code from a failed call: `… (status=404 code=not_found)`. */
function errorCode(stderr: string): string | undefined {
  return /\bcode=([a-z_]+)\)/.exec(stderr)?.[1];
}

/** Run a rex command; throws `RexError` on a non-zero exit, returns stdout. */
export async function rex(args: readonly string[]): Promise<string> {
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    throw new RexError([...args], result.stderr, result.exitCode, errorCode(result.stderr));
  }
  return result.stdout;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Call a server API method and return its JSON result object. A reply that
 * is empty or not a JSON object throws: a reader must never mistake a
 * changed reply for "nothing there" (that is how ghosts get pruned).
 */
async function api(
  method: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const args = ["api", "call", method, JSON.stringify(input)];
  const out = (await rex(args)).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new RexError(args, `unparseable reply: ${out.slice(0, 200)}`, 0);
  }
  if (!isRecord(parsed))
    throw new RexError(args, `reply is not an object: ${out.slice(0, 200)}`, 0);
  return parsed;
}

/** A field the method's output schema requires: an array, else the reply changed shape and this throws. `null` is an empty list. */
function required(reply: Record<string, unknown>, field: string, method: string): unknown[] {
  const v = reply[field];
  if (v === null) return [];
  if (!Array.isArray(v)) {
    throw new RexError(
      [method],
      `reply has no ${field} array: ${JSON.stringify(reply).slice(0, 200)}`,
      0,
    );
  }
  return v;
}

/** Like `api`, but undefined when the server answers with one of `gone`'s codes. */
async function apiUnlessGone(
  method: string,
  input: Record<string, unknown>,
  gone: readonly string[] = ["not_found", "session_not_found"],
): Promise<Record<string, unknown> | undefined> {
  try {
    return await api(method, input);
  } catch (err) {
    if (err instanceof RexError && err.code !== undefined && gone.includes(err.code))
      return undefined;
    throw err;
  }
}

const TERMINAL_FLAVOR = "com.superlogical.terminal.shell";

/** What a detached session's terminal starts at, so captures do not wrap at 80. The app resizes it on view. */
const DETACHED_SIZE = { columns: 200, rows: 50 };

// ─── Sessions and windows ──────────────────────────────────────────────

/** Ids of every session labelled exactly `label`. Labels are not unique in Rex. */
async function sessionIds(label: string): Promise<string[]> {
  const list = await api("session.list", {});
  const ids: string[] = [];
  for (const raw of required(list, "sessions", "session.list")) {
    if (isRecord(raw) && raw.label === label) {
      const id = asString(raw.session_id);
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

/** The session labelled `label`, or undefined. mu refuses duplicate workstreams, so the first is ours. */
async function resolveSession(label: string): Promise<string | undefined> {
  return (await sessionIds(label))[0];
}

async function requireSession(label: string): Promise<string> {
  const id = await resolveSession(label);
  if (id === undefined) {
    throw new RexError(
      ["session.list"],
      `no rex session labelled ${label}`,
      1,
      "session_not_found",
    );
  }
  return id;
}

/** The window labelled `label` in `sessionId`, or undefined. */
async function findWindow(sessionId: string, label: string): Promise<string | undefined> {
  const view = await api("session.view", { session_id: sessionId });
  for (const w of required(view, "windows", "session.view")) {
    if (isRecord(w) && w.label === label) return asString(w.window_id);
  }
  return undefined;
}

/** The `_mu` window: a plain shell, so the session outlives its last agent like on tmux. */
const placeholderWindow = {
  window_label: MU_PLACEHOLDER_WINDOW,
  layout: { block: { flavor: TERMINAL_FLAVOR, label: MU_PLACEHOLDER_WINDOW } },
};

/** Create `session` with its `_mu` window (one call), or re-add a missing `_mu` window. */
export async function ensureSession(session: string): Promise<EnsureSessionResult> {
  return (await ensureSessionId(session)).result;
}

async function ensureSessionId(
  session: string,
): Promise<{ id: string; result: EnsureSessionResult }> {
  const id = await resolveSession(session);
  if (id === undefined) {
    const created = await api("session.create", {
      label: session,
      initial_windows: [placeholderWindow],
    });
    const newId = asString(created.session_id);
    if (newId === undefined) {
      throw new RexError(
        ["session.create"],
        `no session id in reply: ${JSON.stringify(created)}`,
        0,
      );
    }
    // Labels are not unique in Rex, so a concurrent ensure (workstream init
    // racing a spawn) can create a second `mu-<ws>`. The first in Rex's order
    // wins and every other copy is destroyed, so all callers converge.
    const winner = await resolveSession(session);
    if (winner !== undefined && winner !== newId) {
      await apiUnlessGone("session.destroy", { session_id: newId });
      return { id: winner, result: { created: false, repaired: false } };
    }
    return { id: newId, result: { created: true, repaired: false } };
  }
  if ((await findWindow(id, MU_PLACEHOLDER_WINDOW)) !== undefined) {
    return { id, result: { created: false, repaired: false } };
  }
  await api("session.new_window", { session_id: id, focus: false, ...placeholderWindow });
  return { id, result: { created: false, repaired: true } };
}

/** Idempotent: destroys every session with that label, and succeeds when there is none. */
export async function killSession(session: string): Promise<void> {
  for (const id of await sessionIds(session)) {
    await apiUnlessGone("session.destroy", { session_id: id });
  }
}

// ─── Blocks ────────────────────────────────────────────────────────────

/**
 * The session holding `paneId`, or undefined when Rex reports the block
 * gone. Block calls need both ids, and Rex scopes a block lookup to one
 * session, so the block's session is found with `target.resolve` (which
 * searches every session when given no context). Only `not_found` is
 * absence: any other status or a malformed reply throws, so a liveness
 * gate fails closed. (Rex's docs say to treat an unknown status as
 * not_found; for a gate that would read an unknown as "dead".)
 */
async function blockSession(paneId: string): Promise<string | undefined> {
  if (!isValidPaneId(paneId)) return undefined;
  const found = await api("target.resolve", { kinds: ["block"], queries: [paneId] });
  const first = required(found, "results", "target.resolve")[0];
  if (isRecord(first) && first.status === "not_found") return undefined;
  const sessionId =
    isRecord(first) && first.status === "resolved" && isRecord(first.target)
      ? asString(first.target.session_id)
      : undefined;
  if (sessionId === undefined) {
    throw new RexError(["target.resolve", paneId], `block lookup: ${JSON.stringify(first)}`, 0);
  }
  return sessionId;
}

/** `blockSession`, but a gone block throws: for verbs that act on the pane. */
async function requireBlockSession(paneId: string, verb: string): Promise<string> {
  assertValidPaneId(paneId);
  const sessionId = await blockSession(paneId);
  if (sessionId === undefined) {
    throw new RexError([verb, paneId], `block not found: ${paneId}`, 3, "not_found");
  }
  return sessionId;
}

/** Call a terminal method on `paneId` in `sessionId`; undefined when the block is gone. */
function blockMethod(
  sessionId: string,
  paneId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown> | undefined> {
  return apiUnlessGone("block.method", { session_id: sessionId, block_id: paneId, method, args });
}

/** `blockMethod` for a block whose session is not known yet. */
async function terminalCall(
  paneId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown> | undefined> {
  const sessionId = await blockSession(paneId);
  if (sessionId === undefined) return undefined;
  return blockMethod(sessionId, paneId, method, args);
}

/**
 * The pane's argv: mu's env pairs, then the command line through the user's
 * shell as an INTERACTIVE shell. Rex runs a block's command in a login
 * environment only (`.zprofile`, not `.zshrc`), while a tab the user opens
 * runs an interactive shell. `-i` gives an agent the environment of the
 * user's own Rex tabs (API keys exported from rc files). The cost: an rc
 * file that execs another program (`exec tmux`) replaces the agent; see
 * docs/guide/backends.md. `$SHELL` is the caller's, which matches the
 * server's account on the local server (the only one `rex` autostarts).
 */
function paneCommand(opts: SpawnAgentPaneOptions): string[] {
  const argv = ["env"];
  for (const [k, v] of Object.entries(opts.env)) {
    if (k.length === 0) throw new TypeError("rex env key must be non-empty");
    if (k.includes("="))
      throw new TypeError(`rex env key must not contain '=': ${JSON.stringify(k)}`);
    argv.push(`${k}=${v}`);
  }
  argv.push(userShell(), "-ic", opts.command);
  return argv;
}

function userShell(): string {
  const shell = process.env.SHELL;
  return shell?.startsWith("/") === true ? shell : "/bin/sh";
}

/**
 * Create the agent's block and run `opts.command` in it, one server call:
 * a new window labelled `opts.window`, or a side-by-side split of that
 * window's focused block. Never takes focus. A pane closes
 * on any exit like a tmux pane (no "quick failure" hold), unless
 * `retainOnExit` keeps it for `paneResult`.
 */
export async function spawnAgent(opts: SpawnAgentPaneOptions): Promise<string> {
  const { id: sessionId } = await ensureSessionId(opts.session);
  const block = {
    flavor: TERMINAL_FLAVOR,
    label: opts.name,
    options: {
      command: paneCommand(opts),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      size: DETACHED_SIZE,
      exit: opts.retainOnExit === true ? { on_completion: false } : { quick_exit_threshold_ms: 0 },
    },
  };
  const windowId = await findWindow(sessionId, opts.window);
  const created =
    windowId === undefined
      ? await api("session.new_window", {
          session_id: sessionId,
          window_label: opts.window,
          focus: false,
          layout: { block },
        })
      : await api("session.new_split", {
          session_id: sessionId,
          window_id: windowId,
          direction: "horizontal",
          side: "after",
          focus: false,
          layout: { block },
        });
  const paneId = asString(asArray(created.block_ids)[0]);
  if (paneId === undefined || !isValidPaneId(paneId)) {
    // The command may already run in a block we cannot name: close what we can.
    const windowCreated = asString(created.window_id);
    if (windowCreated !== undefined) {
      await apiUnlessGone("session.close_window", {
        session_id: sessionId,
        window_id: windowCreated,
      }).catch(() => undefined);
    }
    throw new RexError(["spawnAgent"], `no block id in reply: ${JSON.stringify(created)}`, 0);
  }
  opts.onPaneCreated?.(paneId);
  return paneId;
}

/** The foreground program's name: `argv0` (pi runs as node but reports `pi`), else its name. */
function foregroundCommand(process: Record<string, unknown> | undefined): string {
  const fg = process?.foreground;
  if (!isRecord(fg)) return "";
  const argv0 = asString(fg.argv0);
  return (
    (argv0 !== undefined && argv0.length > 0 ? argv0.split("/").pop() : asString(fg.name)) ?? ""
  );
}

/** Every block in `session`. `[]` when the session is gone; any other failure throws. */
export async function listPanes(session: string): Promise<MuxPane[]> {
  const sessionId = await resolveSession(session);
  if (sessionId === undefined) return [];
  const listed = await apiUnlessGone("session.list_blocks", { session_id: sessionId });
  if (listed === undefined) return [];
  const blocks = required(listed, "blocks", "session.list_blocks").filter(isRecord);
  // One `process` call per block, in parallel: a block that closed since the
  // listing reads as no command (Rex reported it gone); any other failure throws.
  return Promise.all(
    blocks.flatMap((b) => {
      const paneId = asString(b.block_id);
      if (paneId === undefined) return [];
      const windowId = asString(b.window_id);
      return [
        blockMethod(sessionId, paneId, "process").then((p) => ({
          paneId,
          command: foregroundCommand(p),
          ...(windowId ? { windowId } : {}),
        })),
      ];
    }),
  );
}

/** False only when Rex reports the block gone; any other failure throws. */
export async function paneAlive(paneId: string): Promise<boolean> {
  return (await blockSession(paneId)) !== undefined;
}

export function killPaneCommand(paneId: string): MuxCommand {
  return { command: rexBinary(), args: [...rexGlobalFlags(), "block", "close", paneId] };
}

/** Idempotent: succeeds when the block is already gone. */
export async function killPane(paneId: string): Promise<void> {
  assertValidPaneId(paneId);
  const sessionId = await blockSession(paneId);
  if (sessionId === undefined) return;
  await apiUnlessGone("block.close", { session_id: sessionId, block_id: paneId });
}

/** Rex (Go's os.ProcessState) reports a signal death as `signal: <name>` with exit code -1. */
const SIGNAL_NAMES: Readonly<Record<string, keyof typeof constants.signals>> = {
  hangup: "SIGHUP",
  interrupt: "SIGINT",
  quit: "SIGQUIT",
  "illegal instruction": "SIGILL",
  "trace/BPT trap": "SIGTRAP",
  "abort trap": "SIGABRT",
  aborted: "SIGABRT",
  "bus error": "SIGBUS",
  "floating point exception": "SIGFPE",
  killed: "SIGKILL",
  "user defined signal 1": "SIGUSR1",
  "segmentation fault": "SIGSEGV",
  "user defined signal 2": "SIGUSR2",
  "broken pipe": "SIGPIPE",
  "alarm clock": "SIGALRM",
  terminated: "SIGTERM",
};

/**
 * Running, exited (a retained block keeps its `last_exit`) or absent. A
 * death Rex reports with no exit code and an unrecognised error is
 * `code: 1`, so the result always carries exactly one of code or signal.
 */
export async function paneResult(paneId: string): Promise<PaneResult> {
  const process = await terminalCall(paneId, "process");
  if (process === undefined) return { state: "absent" };
  const last = process.last_exit;
  if (isRecord(process.child) || !isRecord(last)) return { state: "running" };
  if (typeof last.exit_code === "number" && last.exit_code >= 0) {
    return { state: "exited", code: last.exit_code, signal: null };
  }
  const name = /^signal: (.+)$/.exec(asString(last.error) ?? "")?.[1];
  const sig = name !== undefined ? SIGNAL_NAMES[name] : undefined;
  return sig !== undefined
    ? { state: "exited", code: null, signal: constants.signals[sig] }
    : { state: "exited", code: 1, signal: null };
}

/** The pid of the block's program; undefined when the block is gone or its program exited. */
export async function panePid(paneId: string): Promise<number | undefined> {
  const process = await terminalCall(paneId, "process");
  const child = process?.child;
  return isRecord(child) && typeof child.pid === "number" ? child.pid : undefined;
}

/**
 * The agent's status as the program reports it over OSC 7501. Only records
 * the block's own program wrote count: a tool the agent runs (cargo, brew)
 * reports into the same terminal and must not speak for the agent. Of
 * those, a blocked record wins (permission over the rest), else the root
 * record. At rest (idle, done, error) reads as waiting on a human, like
 * herdr's mapping. Undefined when the block is gone or the agent reported
 * nothing.
 */
export async function paneStatus(paneId: string): Promise<MuxPaneStatus | undefined> {
  const sessionId = await blockSession(paneId);
  if (sessionId === undefined) return undefined;
  const [reply, process] = await Promise.all([
    blockMethod(sessionId, paneId, "program_status"),
    blockMethod(sessionId, paneId, "process"),
  ]);
  if (reply === undefined) return undefined;
  const agentPid = isRecord(process?.child) ? process.child.pid : undefined;
  const records = required(reply, "records", "program_status")
    .filter(isRecord)
    .filter((r) => !isRecord(r.owner) || r.owner.pid === agentPid);
  const blocked = records.filter((r) => r.state === "blocked");
  if (blocked.some((r) => r.kind === "permission")) return "needs_permission";
  if (blocked.length > 0) return "needs_input";
  const root = records.find((r) => r.id === undefined || r.id === "");
  if (root === undefined) return undefined;
  return root.state === "working" ? "busy" : "needs_input";
}

/** How long a TUI gets to take a paste before the Enter that submits it. */
const PASTE_SETTLE_MS = 150;

/**
 * Submit `text`: a `paste` event, then a carriage return written as typed
 * input (the terminal's documented `write` method). Rex wraps the paste in
 * bracketed-paste markers only when the program enabled that mode (pi,
 * claude and codex do), so a multi-line text is refused for a program that
 * has not: its newlines would submit early, line by line. Verified on
 * claude and codex: the whole text lands as one prompt and is submitted.
 * The short settle before Enter leaves a TUI time to finish the paste.
 */
export async function sendToPane(paneId: string, text: string): Promise<void> {
  const sessionId = await requireBlockSession(paneId, "send");
  if (text.includes("\n")) {
    const modes = await blockMethod(sessionId, paneId, "modes");
    const bracketed = asArray(modes?.modes).some(
      (m) => isRecord(m) && m.number === 2004 && m.set === true,
    );
    if (!bracketed) {
      throw new MuxError(say("mux.rex_no_bracketed_paste", paneId));
    }
  }
  if (text.length > 0) {
    await api("block.event", {
      session_id: sessionId,
      block_id: paneId,
      event: { type: "paste", payload: { text } },
    });
    await sleep(PASTE_SETTLE_MS);
  }
  if ((await blockMethod(sessionId, paneId, "write", { data: "\r" })) === undefined) {
    throw new RexError(["send", paneId], `block not found: ${paneId}`, 3, "not_found");
  }
}

// ─── Capture ───────────────────────────────────────────────────────────

/**
 * Read the block's scrollback and screen as plain text, tmux's way: no
 * options is everything, `lines: N` the last N lines ending at the last
 * non-blank one, newline kept. `lines: 0` is the last `rows` lines: the
 * visible screen once output fills it. Rex's text ends at the last written
 * row, so a screen not yet full reads as all of its (short) content.
 * `rex capture` pages output past the API's single-reply cap.
 */
export async function capture(paneId: string, opts: CaptureOptions = {}): Promise<string> {
  const sessionId = await requireBlockSession(paneId, "capture");
  const text = await rex(["capture", "-s", sessionId, "-b", paneId]);
  if (opts.lines === undefined) return text;
  if (opts.lines === 0) {
    const size = await blockMethod(sessionId, paneId, "size");
    const rows = typeof size?.rows === "number" ? size.rows : DETACHED_SIZE.rows;
    return text.split("\n").slice(-rows).join("\n");
  }
  return lastLines(text, opts.lines);
}

/** The last `n` lines of `text`, ending at the last non-blank line, with a trailing newline. */
function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  if (end === 0) return "";
  return `${lines.slice(Math.max(0, end - n), end).join("\n")}\n`;
}

// ─── Attach ────────────────────────────────────────────────────────────

/**
 * Show `target` in Rex.app: `session.select` switches the app to the
 * session and window. Rex has no terminal client to attach, so the steps
 * are the same from inside a Rex pane or from any shell on the machine.
 * With one app connected, `rex do` picks it; set `REX_CLIENT` for several.
 */
export async function attachCommands(target: AttachTarget): Promise<readonly MuxCommand[]> {
  const sessionId = await requireSession(target.session);
  const windowId =
    target.window === undefined ? undefined : await findWindow(sessionId, target.window);
  const select = ["do", "session.select", `session_id=${sessionId}`];
  if (windowId !== undefined) select.push(`window_id=${windowId}`);
  return [{ command: "rex", args: [...rexGlobalFlags(), ...select] }];
}

/** The label of the Rex session this process runs in (`$REX_SESSION`), or undefined outside Rex. */
export async function currentSessionName(): Promise<string | undefined> {
  const id = process.env.REX_SESSION;
  if (id === undefined || id.length === 0) return undefined;
  try {
    const view = await api("session.view", { session_id: id });
    return asString(view.label);
  } catch {
    return undefined;
  }
}

// ─── Backend record ────────────────────────────────────────────────────

/** The CLI runs. No server is needed: the first API call starts one, as tmux does. */
async function rexAvailable(): Promise<boolean> {
  try {
    await rex(["version"]);
    return true;
  } catch {
    return false;
  }
}

export async function healthCheck(): Promise<MuxHealth> {
  let version: string | null = null;
  try {
    const parsed: unknown = JSON.parse(await rex(["version", "--json"]));
    version = isRecord(parsed) ? (asString(parsed.rex_version) ?? null) : null;
  } catch {
    version = null;
  }
  return {
    name: "rex",
    ok: version !== null,
    version,
    env: [
      { name: "$REX_SESSION", value: process.env.REX_SESSION ?? null },
      { name: "$REX_BLOCK", value: process.env.REX_BLOCK ?? null },
      { name: "$TERM_PROGRAM", value: process.env.TERM_PROGRAM ?? null },
      { name: "$MU_REX_SERVER", value: process.env.MU_REX_SERVER ?? null },
    ],
    remediation: "install Rex (rex version) or put its CLI on PATH",
  };
}

/** True when this process runs in a Rex terminal (and not in a tmux or herdr nested inside it). */
export function insideRex(): boolean {
  return Boolean(process.env.REX_SESSION) && process.env.TERM_PROGRAM === "rex";
}

export const rexBackend: MuxBackend = Object.freeze({
  name: "rex" as const,
  spawnAgentWaitsReady: false,
  runsShellCommand: true,
  anchorsPanes: false,
  available: rexAvailable,

  isValidPaneId,
  assertValidPaneId,

  ensureSession,
  killSession,

  spawnAgent,
  listPanes,
  paneAlive,
  paneResult,
  panePid,
  killPane,
  killPaneCommand,
  capture,

  attachCommands,

  paneStatus,
  sendToPane,
  currentSessionName,
  healthCheck,
});
