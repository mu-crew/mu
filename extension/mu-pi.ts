/**
 * mu pi extension: serves the per-agent control socket from inside the
 * agent's interactive pi, so mu gets exact send / status / wait without
 * replacing the TUI or scraping the pane.
 *
 * Inert unless `$MU_CTL_SOCK` is set (mu injects it at spawn). Imports
 * nothing from mu except the protocol, and nothing from pi: the pi API is
 * typed structurally below so pi stays a peer, not a dependency.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  CTL_COMMANDS,
  CTL_FEATURES,
  CTL_MSGID_MAX_LENGTH,
  CTL_MSGID_MEMORY,
  CTL_OPS,
  CTL_PROTOCOL_VERSION,
  type CtlBlocked,
  type CtlCommandName,
  type CtlReply,
  type CtlState,
  encode,
  INCARNATION_MISMATCH,
  LineDecoder,
  UNKNOWN_OP_PREFIX,
} from "../src/ctl/protocol.js";
import {
  type DelegateCtx,
  defaultRunner,
  type MuDelegateApi,
  type MuRunner,
  registerDelegate,
} from "./delegate.js";
import {
  type MuNudgeApi,
  parallelSettle,
  registerCloseNudge,
  registerNudge,
  withQueuedInput,
} from "./nudge.js";

/** The mu package version, baked in by tsup's `define`; absent when run from source. */
declare const __MU_VERSION__: string | undefined;
const EXT_VERSION = typeof __MU_VERSION__ === "string" ? __MU_VERSION__ : undefined;

/** The slice of pi's ExtensionContext this extension uses. */
export interface MuPiContext extends DelegateCtx {
  /** pi's session manager; only the session file is read. */
  sessionManager?: { getSessionFile(): string | undefined };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
}

/** The slice of pi's ReplacedSessionContext: bound to the NEW session. */
export interface MuPiReplacedContext extends MuPiContext {
  sendUserMessage(text: string): Promise<void>;
}

/** The slice of pi's ExtensionCommandContext (command handlers only). */
export interface MuPiCommandContext extends MuPiContext {
  newSession(options?: {
    withSession?: (ctx: MuPiReplacedContext) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
  compact(options?: {
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }): void;
}

/** The slice of pi's ExtensionAPI this extension uses. */
export interface MuPiApi extends MuDelegateApi {
  on(
    event:
      | "session_start"
      | "session_shutdown"
      | "session_before_compact"
      | "agent_start"
      | "agent_end"
      | "agent_settled"
      | "message_start"
      | "ui_prompt_start"
      | "ui_prompt_end"
      | Parameters<MuNudgeApi["on"]>[0],
    handler: (event: unknown, ctx: MuPiContext) => unknown,
  ): unknown;
  sendUserMessage(
    text: string,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): void | Promise<void>;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: MuPiCommandContext) => Promise<void>;
    },
  ): void;
}

/** Internal command behind the `fresh` op: new session + prompt, inside pi. */
export const FRESH_COMMAND = "mu-fresh";
/** The extension's own bound on a fresh op that never reaches agent_start. */
export const FRESH_TIMEOUT_MS = 30_000;
/** Internal command behind the `command` op, per session command: `mu-new`, ... */
export function commandName(name: CtlCommandName): string {
  return `mu-${name}`;
}
/** The extension's own bound on a `command` op that never completes. */
export const COMMAND_TIMEOUT_MS = 30_000;
/** Cap on `lastText` in a wait reply, in UTF-8 bytes (before the marker).
 *  A longer message keeps its TAIL: the final lines (a CLOSE block) are
 *  what a consumer reads, and the reply says `lastTextTruncated: true`. */
export const LAST_TEXT_MAX_BYTES = 64 * 1024;
export const LAST_TEXT_TRUNCATED = "[truncated, see pane]";
/** How long session_start waits for another pi to answer on the socket path. */
export const LIVE_PROBE_MS = 500;

type Reply = CtlReply;
const V = CTL_PROTOCOL_VERSION;

function fail(error: string): Reply {
  return { v: V, ok: false, error };
}

/** Best effort: the version of the pi package running this process. */
function detectPiVersion(): string | undefined {
  try {
    const entry = process.argv[1];
    if (!entry) return undefined;
    let dir = dirname(realpathSync(entry));
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (typeof pkg === "object" && pkg !== null) {
          const { name, version } = pkg as { name?: unknown; version?: unknown };
          if (typeof name === "string" && /pi/.test(name) && typeof version === "string") {
            return version;
          }
        }
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    // Unknown version is reported as absent, never as an error.
  }
  return undefined;
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  const x = o[k];
  return typeof x === "string" ? x : undefined;
}

function num(o: Record<string, unknown>, k: string): number | undefined {
  const x = o[k];
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

/** A `fresh` op in flight: its prompt and the reply it is waiting to send. */
type PendingFresh = {
  text: string;
  /** Set once the new session exists, so its agent_start is the prompt's. */
  armed: boolean;
  settle: (r: Reply) => void;
};

/** A `command` op in flight: the session command and its pending reply. */
type PendingCommand = {
  name: CtlCommandName;
  instructions?: string;
  /** reload: set by the session_start (reason reload) the reload produced. */
  reloaded: boolean;
  settle: (r: Reply) => void;
};

/**
 * Process-global state, keyed by socket path. pi re-runs this factory
 * for every session (a /new or /mu-fresh replaces the extension runtime),
 * so the socket server, the run counters and an in-flight fresh must
 * outlive any one runtime. Each runtime refreshes `pi` and `handle`.
 */
type Shared = {
  server?: Server;
  /** Set by bind(): another pi serves the socket, so this pi is not the agent. */
  nested?: boolean;
  /** Inode of the socket file this process bound; the only file it may unlink. */
  ino?: number;
  conns: Set<Socket>;
  /** Minted with the entry, so once per pi process per socket; /new and /reload keep it. */
  incarnation: string;
  /** Last CTL_MSGID_MEMORY accepted msgIds (insertion order), with the runs the reply carried. */
  accepted: Map<string, { runs: number; at: number }>;
  /** Held waits; called with "settle" on agent_settled, "blocked" on ui_prompt_start. */
  waiters: Set<(why: "settle" | "blocked") => void>;
  state: CtlState;
  since: number;
  runs: number;
  /** Final assistant text of the last settled run; served by `wait`. */
  lastText: string;
  /** True when `lastText` lost its head to the tail cap. */
  lastTextTruncated?: boolean;
  /** Captured on agent_end, published to `lastText` on agent_settled. */
  endText?: string;
  endTextTruncated?: boolean;
  /** Error that ended the last settled run, if any; served by `wait`. */
  lastError?: string;
  endError?: string;
  /** Session file of the last settled run; served by `wait`. */
  sessionFile?: string;
  ctx?: MuPiContext;
  pi: MuPiApi;
  handle: (req: Record<string, unknown>, conn: Socket) => Promise<Reply>;
  fresh?: PendingFresh;
  command?: PendingCommand;
};

const SHARED = Symbol.for("mu.pi.ctl");
type SharedMap = Map<string, Shared>;

function sharedMap(): SharedMap {
  const g = globalThis as { [SHARED]?: SharedMap };
  g[SHARED] ??= new Map();
  return g[SHARED];
}

/**
 * Text of the last assistant message in an agent_end event's `messages`:
 * its text parts joined, no tool calls or thinking. "" when there is none.
 * `truncated` when the tail cap cut the head off.
 */
export function lastAssistantText(event: unknown): { text: string; truncated: boolean } {
  const msgs =
    typeof event === "object" && event !== null
      ? (event as { messages?: unknown }).messages
      : undefined;
  if (!Array.isArray(msgs)) return { text: "", truncated: false };
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m: unknown = msgs[i];
    if (typeof m !== "object" || m === null) continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "assistant") continue;
    if (typeof content === "string") return capTail(content);
    if (!Array.isArray(content)) return { text: "", truncated: false };
    const parts = content.flatMap((c: unknown) => {
      if (typeof c !== "object" || c === null) return [];
      const { type, text } = c as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? [text] : [];
    });
    return capTail(parts.join(""));
  }
  return { text: "", truncated: false };
}

/** The final assistant message's error, when the run stopped on one
 *  (pi's own retries exhausted: overloaded, connection, auth). */
export function lastAssistantError(event: unknown): string | undefined {
  const msgs =
    typeof event === "object" && event !== null
      ? (event as { messages?: unknown }).messages
      : undefined;
  if (!Array.isArray(msgs)) return undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m: unknown = msgs[i];
    if (typeof m !== "object" || m === null) continue;
    const { role, stopReason, errorMessage } = m as {
      role?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (role !== "assistant") continue;
    if (stopReason !== "error") return undefined;
    return typeof errorMessage === "string" && errorMessage !== ""
      ? capText(errorMessage)
      : "unknown error";
  }
  return undefined;
}

/** Keep the last LAST_TEXT_MAX_BYTES bytes, the marker on its own first line. */
function capTail(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= LAST_TEXT_MAX_BYTES) return { text, truncated: false };
  const buf = Buffer.from(text, "utf8");
  // Cut on bytes; drop a code point split by the cut.
  const tail = buf
    .subarray(buf.length - LAST_TEXT_MAX_BYTES)
    .toString("utf8")
    .replace(/^\uFFFD/, "");
  return { text: `${LAST_TEXT_TRUNCATED}\n${tail}`, truncated: true };
}

function capText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= LAST_TEXT_MAX_BYTES) return text;
  // Cut on bytes; drop a code point split by the cut.
  const cut = Buffer.from(text, "utf8").subarray(0, LAST_TEXT_MAX_BYTES).toString("utf8");
  return `${cut.replace(/\uFFFD$/, "")}\n${LAST_TEXT_TRUNCATED}`;
}

/** Open extension dialogs, outermost first; process-global like Shared. */
type UiPrompts = { open: { kind: string; title?: string }[]; since: number };
const UI_PROMPTS = Symbol.for("mu.pi.uiPrompts");

function uiPrompts(): UiPrompts {
  const g = globalThis as { [UI_PROMPTS]?: UiPrompts };
  g[UI_PROMPTS] ??= { open: [], since: 0 };
  return g[UI_PROMPTS];
}

/** The open extension dialog pi is waiting on (innermost), or undefined. */
export function uiBlocked(): CtlBlocked | undefined {
  const u = uiPrompts();
  const top = u.open[u.open.length - 1];
  if (!top) return undefined;
  return {
    kind: top.kind,
    ...(top.title !== undefined ? { title: top.title } : {}),
    since: u.since,
  };
}

/** Whether pi is waiting on a blocking extension dialog right now. */
export function isUiBlocked(): boolean {
  return uiPrompts().open.length > 0;
}

function promptOf(event: unknown): { kind: string; title?: string } {
  const e = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
  const kind = typeof e.kind === "string" ? e.kind : "custom";
  const title = typeof e.title === "string" && e.title !== "" ? e.title : undefined;
  return { kind, ...(title !== undefined ? { title } : {}) };
}

/** Track ui_prompt_start / ui_prompt_end; `onStart` runs after each start. */
function trackUiPrompts(pi: MuPiApi, onStart: () => void = () => {}): void {
  pi.on("ui_prompt_start", (e) => {
    const u = uiPrompts();
    if (u.open.length === 0) u.since = Date.now();
    u.open.push(promptOf(e));
    onStart();
  });
  // A new runtime has no dialog open: drop any whose end a replaced
  // session never delivered.
  pi.on("session_start", () => {
    uiPrompts().open.length = 0;
  });
  pi.on("ui_prompt_end", (e) => {
    const u = uiPrompts();
    // Close the innermost dialog of this kind; prompts nest, so ends come LIFO.
    const { kind } = promptOf(e);
    let i = u.open.length - 1;
    while (i >= 0 && u.open[i]?.kind !== kind) i--;
    u.open.splice(i >= 0 ? i : u.open.length - 1, 1);
  });
}

/** Inode at `path`, or undefined when there is no file. */
function inodeOf(path: string): number | undefined {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
}

/**
 * Whether some process is serving `path`. Refused / missing means a stale
 * file. A connect that neither succeeds nor fails in time counts as live:
 * never steal a socket on a guess.
 */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(path);
    const done = (live: boolean) => {
      clearTimeout(timer);
      c.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(true), LIVE_PROBE_MS);
    c.once("connect", () => done(true));
    c.once("error", (e: NodeJS.ErrnoException) =>
      done(e.code !== "ENOENT" && e.code !== "ECONNREFUSED"),
    );
  });
}

/** Per-process counter so a rebind never reuses a temp name a closing server owns. */
let bindSeq = 0;

function reasonOf(event: unknown): string | undefined {
  const r =
    typeof event === "object" && event !== null
      ? (event as { reason?: unknown }).reason
      : undefined;
  return typeof r === "string" ? r : undefined;
}

export default function muPi(pi: MuPiApi, run: MuRunner = defaultRunner()): void {
  const delegates = registerDelegate(pi, run);
  // Identity follows the bind: a pi that finds MU_CTL_SOCK served by
  // another pi is nested and gets none of the agent's nudges.
  const nested = serveCtl(pi);
  // The two nudges' settle checks run in parallel, as one handler.
  // A delegate answer on its way resumes the agent itself; an open
  // dialog means nobody is driving. Either holds the nudges.
  const hold = withQueuedInput(() =>
    delegates.answerPending() ? "answer" : isUiBlocked() ? "blocked" : undefined,
  );
  const settle = parallelSettle(pi, hold);
  registerNudge(settle.api, run, undefined, nested, hold);
  registerCloseNudge(settle.api, run, process.env, nested, hold);
  settle.flush();
}

/**
 * Child side: serve `$MU_CTL_SOCK` for the mu that spawned this pi.
 * Returns whether this pi is nested (another pi serves the socket), read
 * from the process-global state so a reloaded runtime sees the decision.
 */
function serveCtl(pi: MuPiApi): () => boolean {
  const sock = process.env.MU_CTL_SOCK;
  if (!sock) {
    trackUiPrompts(pi);
    return () => false;
  }
  const sockPath: string = sock;
  const piVersion = detectPiVersion();

  const map = sharedMap();
  const existing = map.get(sockPath);
  const g: Shared = existing ?? {
    conns: new Set(),
    incarnation: randomUUID(),
    accepted: new Map(),
    waiters: new Set(),
    state: "idle",
    since: Date.now(),
    runs: 0,
    lastText: "",
    pi,
    handle,
  };
  g.pi = pi;
  g.handle = handle;
  // A /reload can hand us an entry minted by older code that lacks later fields.
  (g as Partial<Shared>).incarnation ??= randomUUID();
  (g as Partial<Shared>).accepted ??= new Map();
  map.set(sockPath, g);

  const status = () => ({
    incarnation: g.incarnation,
    state: g.state,
    since: g.since,
    runs: g.runs,
    pending: g.ctx?.hasPendingMessages() ?? false,
    ...sessionFileOf(g.ctx),
    ...blockedField(),
  });

  /** Remember an accepted msgId with the `runs` its reply carried; evicts the oldest. */
  const remember = (id: string | undefined, runs: number): void => {
    if (id === undefined) return;
    g.accepted.delete(id);
    g.accepted.set(id, { runs, at: Date.now() });
    for (const old of g.accepted.keys()) {
      if (g.accepted.size <= CTL_MSGID_MEMORY) break;
      g.accepted.delete(old);
    }
  };

  const blockedField = (): { blocked?: CtlBlocked } => {
    const b = uiBlocked();
    return b ? { blocked: b } : {};
  };

  trackUiPrompts(pi, () => {
    for (const w of [...g.waiters]) w("blocked");
  });

  const settleFresh = (r: Reply) => {
    const f = g.fresh;
    if (!f) return;
    g.fresh = undefined;
    f.settle(r);
  };

  const settleCommand = (r: Reply) => {
    const c = g.command;
    if (!c) return;
    g.command = undefined;
    c.settle(r);
  };

  pi.on("agent_start", (_e, c) => {
    g.ctx = c;
    g.state = "busy";
    g.since = Date.now();
    // The new session's run started: the fresh prompt landed.
    if (g.fresh?.armed) settleFresh({ v: V, ok: true, ...status() });
  });

  // A settled run can span several low-level runs (retry, follow-up):
  // the last agent_end before the settle holds the final answer.
  pi.on("agent_end", (e) => {
    const cut = lastAssistantText(e);
    g.endText = cut.text;
    g.endTextTruncated = cut.truncated;
    g.endError = lastAssistantError(e);
  });

  /** The session file of `c`, as a spreadable field; {} when unknown. */
  function sessionFileOf(c: MuPiContext | undefined): { sessionFile?: string } {
    try {
      const f = c?.sessionManager?.getSessionFile();
      return f ? { sessionFile: f } : {};
    } catch {
      return {}; // stale ctx: the pointer is a convenience
    }
  }

  pi.on("agent_settled", (_e, c) => {
    g.ctx = c;
    g.state = "idle";
    g.since = Date.now();
    g.runs++;
    g.lastText = g.endText ?? "";
    g.lastTextTruncated = g.endTextTruncated === true;
    g.endText = undefined;
    g.endTextTruncated = undefined;
    g.lastError = g.endError;
    g.endError = undefined;
    g.sessionFile = sessionFileOf(c).sessionFile;
    for (const w of [...g.waiters]) w("settle");
  });

  pi.registerCommand(FRESH_COMMAND, {
    description: "mu internal: new session + the prompt mu queued (run by mu agent send --fresh)",
    handler: async (_args, ctx) => {
      const f = g.fresh;
      if (!f) return; // typed by hand: nothing queued
      try {
        const r = await ctx.newSession({
          withSession: async (c) => {
            g.ctx = c;
            f.armed = true;
            await c.sendUserMessage(f.text);
          },
        });
        if (r.cancelled) settleFresh(fail("new session was cancelled"));
      } catch (e) {
        settleFresh(fail(e instanceof Error ? e.message : String(e)));
      }
      // The run finished without an agent_start we saw: still landed.
      settleFresh({ v: V, ok: true, ...status() });
    },
  });

  // A compaction we asked for has started: reply now, not after the
  // summary call. Errors before this point (e.g. "Nothing to compact")
  // reach the reply through compact's onError.
  pi.on("session_before_compact", () => {
    if (g.command?.name === "compact") settleCommand({ v: V, ok: true, ...status() });
  });

  /** Run the queued session command `name` with pi's command context. */
  async function runCommand(name: CtlCommandName, ctx: MuPiCommandContext): Promise<void> {
    const c = g.command;
    if (c?.name !== name) return; // typed by hand: nothing queued
    const ok = () => settleCommand({ v: V, ok: true, ...status() });
    const failWith = (e: unknown) =>
      settleCommand(fail(e instanceof Error ? e.message : String(e)));
    try {
      if (name === "new") {
        const r = await ctx.newSession();
        if (r.cancelled) settleCommand(fail("new session was cancelled"));
        else ok();
      } else if (name === "reload") {
        await ctx.reload();
        // pi's reload returns quietly when it refuses (streaming, compacting).
        if (c.reloaded) ok();
        else settleCommand(fail("pi did not reload (busy or compacting)"));
      } else {
        ctx.compact({
          ...(c.instructions !== undefined ? { customInstructions: c.instructions } : {}),
          onComplete: ok,
          onError: failWith,
        });
      }
    } catch (e) {
      failWith(e);
    }
  }

  for (const name of CTL_COMMANDS) {
    pi.registerCommand(commandName(name), {
      description: `mu internal: /${name} requested over the control socket (mu agent send '/${name}')`,
      handler: (_args, ctx) => runCommand(name, ctx),
    });
  }

  function command(req: Record<string, unknown>): Promise<Reply> | Reply {
    const name = CTL_COMMANDS.find((n) => n === req.name);
    if (name === undefined) {
      return fail(`command must be one of ${CTL_COMMANDS.join(", ")}`);
    }
    if (g.fresh || g.command) return fail("a fresh send or command is already in progress");
    const busy = !(g.ctx?.isIdle() ?? g.state === "idle");
    if (busy && req.force !== true) return fail("busy");
    const instructions = str(req, "instructions");
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => settleCommand(fail(`/${name} timed out`)), COMMAND_TIMEOUT_MS);
      g.command = {
        name,
        ...(instructions !== undefined ? { instructions } : {}),
        reloaded: false,
        settle: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      Promise.resolve(
        g.pi.sendUserMessage(`/${commandName(name)}`, { expandPromptTemplates: true }),
      ).catch((e: unknown) => settleCommand(fail(e instanceof Error ? e.message : String(e))));
    });
  }

  function fresh(req: Record<string, unknown>): Promise<Reply> | Reply {
    const text = str(req, "text");
    if (text === undefined) return fail("fresh needs a string text");
    const id = msgIdOf(req);
    if (id.error) return fail(id.error);
    if (g.fresh || g.command) return fail("a fresh send or command is already in progress");
    const busy = !(g.ctx?.isIdle() ?? g.state === "idle");
    if (busy && req.force !== true) return fail("busy");
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => settleFresh(fail("fresh timed out")), FRESH_TIMEOUT_MS);
      g.fresh = {
        text,
        armed: false,
        settle: (r) => {
          clearTimeout(timer);
          // Every ok settle is a landed prompt (run started, or finished unseen).
          if (r.ok) remember(id.id, r.runs ?? g.runs);
          resolve(r);
        },
      };
      // expandPromptTemplates dispatches extension commands, even mid-run.
      Promise.resolve(
        g.pi.sendUserMessage(`/${FRESH_COMMAND}`, { expandPromptTemplates: true }),
      ).catch((e: unknown) => settleFresh(fail(e instanceof Error ? e.message : String(e))));
    });
  }

  /** The optional msgId of `req`: absent is fine; present must be a string of 1-64 characters. */
  function msgIdOf(req: Record<string, unknown>): { id?: string; error?: string } {
    if (!("msgId" in req)) return {};
    const id = req.msgId;
    if (typeof id === "string" && id.length >= 1 && id.length <= CTL_MSGID_MAX_LENGTH)
      return { id };
    return { error: `msgId must be a string of 1-${CTL_MSGID_MAX_LENGTH} characters` };
  }

  async function handle(req: Record<string, unknown>, conn: Socket): Promise<Reply> {
    switch (req.op) {
      case "hello":
        return {
          v: V,
          ok: true,
          agent: process.env.MU_AGENT_NAME,
          workstream: process.env.MU_WORKSTREAM,
          piVersion,
          incarnation: g.incarnation,
          ops: [...CTL_OPS],
          features: [...CTL_FEATURES],
          ...(EXT_VERSION !== undefined ? { extVersion: EXT_VERSION } : {}),
        };
      case "status": {
        const id = msgIdOf(req);
        if (id.error) return fail(id.error);
        if (id.id === undefined) return { v: V, ok: true, ...status() };
        const got = g.accepted.get(id.id);
        const msg = got ? { id: id.id, accepted: true, ...got } : { id: id.id, accepted: false };
        return { v: V, ok: true, ...status(), msg };
      }
      case "send": {
        const text = str(req, "text");
        if (text === undefined) return fail("send needs a string text");
        const id = msgIdOf(req);
        if (id.error) return fail(id.error);
        const mode = req.mode === "steer" ? "steer" : "followUp";
        // Measured before dispatch: `runs` is the caller's wait baseline,
        // and a run this send starts may settle before the reply is read.
        const before = status();
        // A message sent while idle starts a run; options are only for a busy pi.
        if (g.ctx?.isIdle() ?? g.state === "idle") await g.pi.sendUserMessage(text);
        else await g.pi.sendUserMessage(text, { deliverAs: mode });
        remember(id.id, before.runs);
        return { v: V, ok: true, ...before };
      }
      case "fresh":
        return fresh(req);
      case "command":
        return command(req);
      case "wait":
        if ("incarnation" in req && req.incarnation !== g.incarnation) {
          return { ...fail(INCARNATION_MISMATCH), incarnation: g.incarnation };
        }
        return wait(
          num(req, "afterRuns"),
          num(req, "timeoutMs"),
          conn,
          req.returnOnBlocked === true,
        );
      case "abort":
        if (!g.ctx) return fail("no pi context yet");
        {
          // The run may have settled since the caller's status probe.
          const wasBusy = !g.ctx.isIdle();
          if (wasBusy) g.ctx.abort();
          return { v: V, ok: true, state: g.state, wasBusy };
        }
      case "interrupt":
        return interrupt(req, conn);
      default:
        return { ...fail(`${UNKNOWN_OP_PREFIX}${String(req.op)}`), ops: [...CTL_OPS] };
    }
  }

  /**
   * Abort a busy turn, wait for its settle, then send `text` as a new run.
   * The waiter is registered before the abort, so a settle that lands at
   * once is not missed. `runs` is read after that settle and before the
   * send: the caller's wait baseline for the new run, not the aborted one.
   */
  async function interrupt(req: Record<string, unknown>, conn: Socket): Promise<Reply> {
    const text = str(req, "text");
    if (text === undefined) return fail("interrupt needs a string text");
    const id = msgIdOf(req);
    if (id.error) return fail(id.error);
    const wasBusy = !(g.ctx?.isIdle() ?? g.state === "idle");
    const { pending } = status();
    if (wasBusy) {
      if (!g.ctx) return fail("no pi context yet");
      const settled = wait(g.runs, num(req, "timeoutMs"), conn);
      g.ctx.abort();
      const w = await settled;
      if (!w.ok) return w;
    }
    const before = status();
    await g.pi.sendUserMessage(text);
    remember(id.id, before.runs);
    return { v: V, ok: true, ...before, pending, wasBusy };
  }

  const settledRun = () => ({
    lastText: g.lastText,
    ...(g.lastTextTruncated === true ? { lastTextTruncated: true } : {}),
    ...(g.lastError !== undefined ? { lastError: g.lastError } : {}),
    ...(g.sessionFile !== undefined ? { sessionFile: g.sessionFile } : {}),
  });

  /**
   * Resolve once a run past `afterRuns` has settled (any next settle when
   * omitted). With `onBlocked`, an open or opening dialog ends the wait
   * first: `ended: "blocked"`, no settled-run fields, runs unchanged.
   */
  function wait(
    afterRuns: number | undefined,
    timeoutMs: number | undefined,
    conn: Socket,
    onBlocked = false,
  ) {
    if (afterRuns !== undefined && g.runs > afterRuns && g.state === "idle") {
      return Promise.resolve<Reply>({
        v: V,
        ok: true,
        ...status(),
        ...settledRun(),
        ended: "settled",
      });
    }
    const blockedReply = (): Reply => ({ v: V, ok: true, ...status(), ended: "blocked" });
    if (onBlocked && isUiBlocked()) return Promise.resolve(blockedReply());
    return new Promise<Reply>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (r: Reply) => {
        g.waiters.delete(waiter);
        if (timer) clearTimeout(timer);
        conn.off("close", onClose);
        resolve(r);
      };
      // A settle at or below `afterRuns` is not the run asked for: keep waiting.
      const waiter = (why: "settle" | "blocked") => {
        if (why === "blocked") {
          if (onBlocked) done(blockedReply());
          return;
        }
        if (afterRuns !== undefined && g.runs <= afterRuns) return;
        done({ v: V, ok: true, ...status(), ...settledRun(), ended: "settled" });
      };
      const onClose = () => done(fail("client closed"));
      g.waiters.add(waiter);
      conn.on("close", onClose);
      if (timeoutMs !== undefined) timer = setTimeout(() => done(fail("timeout")), timeoutMs);
    });
  }

  /** Created once per process; dispatches to the newest runtime's handle. */
  function onConnection(conn: Socket): void {
    g.conns.add(conn);
    conn.setEncoding("utf8");
    const dec = new LineDecoder();
    let seen = false;
    conn.on("close", () => g.conns.delete(conn));
    conn.on("error", () => {});
    conn.on("data", (chunk: string) => {
      const line = dec.push(chunk)[0];
      if (line === undefined || seen) return;
      seen = true; // one request per connection
      let req: unknown;
      try {
        req = JSON.parse(line);
      } catch {
        conn.end(encode(fail("bad json")));
        return;
      }
      if (typeof req !== "object" || req === null) {
        conn.end(encode(fail("request must be an object")));
        return;
      }
      g.handle(req as Record<string, unknown>, conn).then(
        (r) => {
          if (!conn.destroyed) conn.end(encode(r));
        },
        (e: unknown) => {
          if (!conn.destroyed) conn.end(encode(fail(e instanceof Error ? e.message : String(e))));
        },
      );
    });
  }

  /**
   * Bind the socket unless another pi already serves it. A nested pi (a
   * probe or `pi -p` run inside an agent's pane) inherits MU_CTL_SOCK; it
   * must leave the agent's socket alone, not unlink and take it.
   */
  async function bind(): Promise<void> {
    mkdirSync(dirname(sockPath), { recursive: true, mode: 0o700 });
    if (await socketIsLive(sockPath)) {
      g.nested = true;
      process.stderr.write(
        `mu: control socket ${sockPath} is served by another pi; nested pi: mu agent features off\n`,
      );
      return;
    }
    rmSync(sockPath, { force: true });
    // Listen on a private name, then hard-link it into place. libuv unlinks
    // the name a server listened on when it closes, so the public path must
    // never be that name: closing would delete whatever file sits there by
    // then. link() also fails on an existing path, so a racing pi keeps it.
    const tmp = join(dirname(sockPath), `.${process.pid.toString(36)}${(++bindSeq).toString(36)}`);
    rmSync(tmp, { force: true });
    const s = createServer(onConnection);
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(tmp, () => {
        s.off("error", reject);
        resolve();
      });
    });
    chmodSync(tmp, 0o600);
    try {
      linkSync(tmp, sockPath);
    } catch (e) {
      s.close();
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      g.nested = true;
      process.stderr.write(
        `mu: control socket ${sockPath} was taken by another pi; nested pi: mu agent features off\n`,
      );
      return;
    } finally {
      rmSync(tmp, { force: true });
    }
    g.server = s;
    g.ino = inodeOf(sockPath);
    g.nested = false;
  }

  pi.on("session_start", async (e, c) => {
    g.ctx = c;
    if (reasonOf(e) === "reload" && g.command?.name === "reload") g.command.reloaded = true;
    const s = g.server;
    if (s) {
      // A new/resumed session keeps the same socket, while the path is ours.
      if (g.ino !== undefined && inodeOf(sockPath) === g.ino) return;
      // Orphaned: the file was deleted or replaced under a live server.
      // Stop accepting on the dead inode (open connections finish) and rebind.
      g.server = undefined;
      g.ino = undefined;
      s.close();
    }
    await bind();
  });

  pi.on("session_shutdown", async (e) => {
    // Session replacement (new / resume / fork / reload) keeps the socket
    // and its connections: an in-flight fresh is answered by the next
    // runtime. Only quit (or an unknown reason) tears the server down.
    const reason = reasonOf(e);
    if (reason === "new" || reason === "resume" || reason === "fork" || reason === "reload") {
      return;
    }
    const s = g.server;
    const ino = g.ino;
    g.server = undefined;
    g.ino = undefined;
    map.delete(sockPath);
    if (!s) return;
    g.waiters.clear();
    settleFresh(fail("pi is shutting down"));
    settleCommand(fail("pi is shutting down"));
    for (const c of g.conns) c.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
    // Unlink only the file this process bound: another pi may own the path now.
    if (ino !== undefined && inodeOf(sockPath) === ino) rmSync(sockPath, { force: true });
  });

  return () => g.nested === true;
}
