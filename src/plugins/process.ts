// mu — the plugin process manager (spec 2026-11-09-mu-plugins.md, D13 Process
// and Timeouts).
//
// mu starts a plugin's registered argv as its child, in its own process group,
// for one invocation. Requests are framed lines on its stdin; replies and
// notifications come back on its stdout; stderr is drained, never parsed and
// never stored (its first line may name a failure). An invalid message breaks
// the plugin for the rest of the invocation (`poisoned`): every pending call
// loses its answer and the group is reaped.
//
// The group, not the leader, is what mu tracks: a plugin is live until its
// group is empty. When the leader exits, whatever it left in its group is
// killed at once (it has no one to answer for). A helper that left the group
// (setsid, a double fork into another group) is a protocol violation mu cannot
// reach; the contract suite detects it.
//
// One grace, owned here (`graceMs`, HOST_GRACE_MS): on a call's deadline or
// its abort signal mu sends `$/cancel {id}`, waits at most one grace (a reply
// to the call ends the wait early, and is ignored), then kills the group. To
// stop a plugin (a normal exit, or a SIGINT, SIGTERM or SIGHUP mu receives)
// mu sends `$/cancel` for each pending call and `shutdown`, closes stdin,
// waits at most one grace for the group to empty, then kills it. A signal
// that no verb handles is raised again once every plugin is stopped. An exit
// that cannot wait (`process.exit`, a crash) kills the groups at once
// (signal-exit). A mu killed by SIGKILL leaves the plugin its stdin EOF, on
// which it must exit within the grace.
//
// The streams are unref'd while no call is pending: a plugin never holds mu
// open.

import { type ChildProcess, spawn } from "node:child_process";
import { onExit } from "signal-exit";
import { HOST_GRACE_MS, pidStart } from "../hosts.js";
import {
  encodeMessage,
  firstLine,
  LineReader,
  type PluginErrorKind,
  parseMessage,
} from "./protocol.js";

/** The plugin answered the request with an error. */
export class RpcFailure extends Error {
  constructor(
    public readonly kind: PluginErrorKind,
    message: string,
    public readonly remedy?: string,
  ) {
    super(message);
  }
}

/** No answer. `sent`: the request went out, so an effect may have happened. */
export class RpcUnanswered extends Error {
  constructor(
    message: string,
    public readonly sent: boolean,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

type Tap = (stream: "in" | "out" | "err", text: string) => void;
let tap: Tap | undefined;

/** Tests: see every line mu writes (`in`), every line it reads (`out`) and the stderr bytes. */
export function setPluginTapForTests(fn: Tap | undefined): void {
  tap = fn;
}

let defaultGraceMs = HOST_GRACE_MS;

/** Tests: the grace a plugin started without an explicit one gets (default HOST_GRACE_MS). */
export function setPluginGraceForTests(ms: number | undefined): void {
  defaultGraceMs = ms ?? HOST_GRACE_MS;
}

const live = new Set<PluginProcess>();
let removeExitHook: (() => void) | undefined;

function signalGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Signals ────────────────────────────────────────────────────────────

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type StopSignal = (typeof SIGNALS)[number];

let raise = (sig: StopSignal): void => {
  process.kill(process.pid, sig);
};

/** Tests: what mu does with a signal no verb handles, once its plugins are stopped. */
export function setSignalRaiseForTests(fn: ((sig: StopSignal) => void) | undefined): void {
  raise =
    fn ??
    ((sig) => {
      process.kill(process.pid, sig);
    });
}

/** signal-exit's own listeners on each signal (one per loaded instance). */
function signalExitListeners(): number {
  const emitter = (globalThis as Record<symbol, { count?: unknown } | undefined>)[
    Symbol.for("signal-exit emitter")
  ];
  return typeof emitter?.count === "number" ? emitter.count : 0;
}

let signalled = false;
const onSignal = new Map<StopSignal, () => void>(
  SIGNALS.map((sig) => [
    sig,
    () => {
      // A verb that listens handles the signal itself (and exits through handle()); else mu
      // raises it again once the plugins are stopped. signal-exit stands aside while we listen.
      const verbs = process.listeners(sig).length - 1 - signalExitListeners();
      if (signalled) return;
      signalled = true;
      void Promise.all([...live].map((p) => p.stop(`mu got ${sig}`))).then(() => {
        signalled = false;
        uninstallSignals();
        if (verbs <= 0) raise(sig);
      });
    },
  ]),
);

function installSignals(): void {
  removeExitHook ??= onExit(killLive);
  for (const [sig, fn] of onSignal) if (!process.listeners(sig).includes(fn)) process.on(sig, fn);
}

function uninstallSignals(): void {
  if (live.size > 0) return;
  for (const [sig, fn] of onSignal) process.off(sig, fn);
  removeExitHook?.();
  removeExitHook = undefined;
}

function killLive(): void {
  for (const p of live) signalGroup(p.pgid, "SIGKILL");
}

// ─── The process ────────────────────────────────────────────────────────

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

type Unrefable = { ref?: () => void; unref?: () => void };

export class PluginProcess {
  readonly pgid: number;
  /** The group leader's start time, where the platform tells it (Linux), for D4's group proof. */
  readonly pgidStart: string | null;
  /** Why the plugin can take no call in this invocation; undefined while it can. */
  broken: string | undefined;
  /** It broke the protocol (an invalid message): it stays refused for the invocation. */
  poisoned = false;
  /** The notification handler; without one a notification breaks the plugin. */
  onNotification: ((method: string, params: unknown) => void) | undefined;
  private stderrHead = "";
  private stderrDone = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Cancelled ids whose late reply is ignored; the value ends the cancel's grace early. */
  private readonly cancelled = new Map<number, () => void>();
  private leaderExit: string | undefined;
  private readonly leaderGone: Promise<void>;
  private readonly stdoutClosed: Promise<void>;
  private ending: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcess & { pid: number },
    private readonly graceMs: number,
  ) {
    this.pgid = child.pid;
    this.pgidStart = pidStart(child.pid);
    this.leaderGone = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.leaderExit = String(code ?? signal);
        resolve();
        // What the leader left in its group answers for no one: killed now.
        void this.end(`the plugin exited (${this.leaderExit})`);
      });
    });
    this.stdoutClosed = new Promise((resolve) => child.stdout?.once("close", () => resolve()));
    const reader = new LineReader();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.poisoned) return;
      for (const line of reader.push(chunk)) {
        tap?.("out", line);
        this.onLine(line);
        if (this.poisoned) return;
      }
      if (reader.invalid !== undefined) this.poison(`an invalid message (${reader.invalid})`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tap?.("err", text);
      if (this.stderrDone) return;
      this.stderrHead += text;
      if (this.stderrHead.includes("\n") || this.stderrHead.length > 4096) {
        this.stderrDone = true;
        this.stderrHead = firstLine(this.stderrHead);
      }
    });
    child.stdin?.on("error", () => {});
    this.refStreams(false);
  }

  /** Start `argv` in its own process group. A spawn failure (ENOENT, EACCES) rejects. */
  static start(
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    graceMs = defaultGraceMs,
  ): Promise<PluginProcess> {
    const [cmd, ...args] = argv;
    if (cmd === undefined) return Promise.reject(new Error("empty plugin argv"));
    const child = spawn(cmd, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        child.off("error", reject);
        child.on("error", () => {});
        if (child.pid === undefined) {
          reject(new Error("the plugin has no pid"));
          return;
        }
        const p = new PluginProcess(child as ChildProcess & { pid: number }, graceMs);
        live.add(p);
        installSignals();
        resolve(p);
      });
    });
  }

  /** The first line of what the plugin wrote to stderr so far. */
  stderrLine(): string {
    return firstLine(this.stderrHead);
  }

  /** One request. Resolves the result; rejects `RpcFailure` or `RpcUnanswered`. */
  request(method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
    if (this.broken !== undefined) {
      return Promise.reject(new RpcUnanswered(`not sent: ${this.broken}`, false));
    }
    const id = this.nextId++;
    const line = encodeMessage({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (): void => {
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        this.refStreams(this.pending.size > 0);
      };
      const expire = (why: string): void => {
        if (done) return;
        finish();
        void this.cancel(id, why).then(reject);
      };
      const onAbort = (): void => expire("cancelled");
      const timer = setTimeout(
        () => expire(`no answer within ${opts.timeoutMs} ms`),
        opts.timeoutMs,
      );
      this.pending.set(id, {
        resolve: (v) => {
          if (done) return;
          finish();
          resolve(v);
        },
        reject: (e) => {
          if (done) return;
          finish();
          reject(e);
        },
      });
      this.refStreams(true);
      if (opts.signal?.aborted) {
        expire("cancelled");
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.write(line);
    });
  }

  /** `shutdown`, at a normal exit: the one-grace stop. Idempotent. */
  shutdown(): Promise<void> {
    return this.stop("shut down");
  }

  /**
   * Stop the plugin: `$/cancel` for each pending call, `shutdown`, stdin closed, at most one
   * grace for the group to empty, then the group killed. Idempotent.
   */
  stop(why: string): Promise<void> {
    this.stopping ??= (async () => {
      this.broken ??= why;
      if (this.leaderExit === undefined) {
        for (const id of [...this.pending.keys()]) {
          this.cancelled.set(id, () => {});
          this.write(encodeMessage({ jsonrpc: "2.0", method: "$/cancel", params: { id } }));
        }
        if (!this.poisoned) {
          this.write(
            encodeMessage({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown", params: null }),
          );
        }
      }
      this.child.stdin?.end();
      this.refStreams(true);
      await Promise.race([this.leaderGone, sleep(this.graceMs)]);
      await this.end(why);
    })();
    return this.stopping;
  }

  /** The group killed until empty, the pipes closed, every pending call unanswered. Idempotent. */
  private end(why: string): Promise<void> {
    this.ending ??= (async () => {
      this.refStreams(true);
      for (let i = 0; i < 500 && signalGroup(this.pgid, "SIGKILL"); i++) await sleep(10);
      await this.leaderGone;
      // With the group gone the pipe drains and closes; a helper that left the group may
      // still hold it, so mu stops reading after a moment.
      await Promise.race([this.stdoutClosed, sleep(200)]);
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      this.child.stdin?.destroy();
      const reason = `${why}${this.stderrHead ? `: ${this.stderrLine()}` : ""}`;
      this.broken ??= reason;
      this.failPending(reason);
      this.refStreams(false);
      live.delete(this);
      uninstallSignals();
    })();
    return this.ending;
  }

  /** The deadline's (or abort's) cancel: `$/cancel`, at most one grace, the group killed. */
  private async cancel(id: number, why: string): Promise<RpcUnanswered> {
    this.refStreams(true);
    const answered = new Promise<void>((resolve) => this.cancelled.set(id, resolve));
    if (this.leaderExit === undefined) {
      this.write(encodeMessage({ jsonrpc: "2.0", method: "$/cancel", params: { id } }));
    }
    await Promise.race([answered, this.leaderGone, sleep(this.graceMs)]);
    this.broken ??= `a call was cancelled (${why}): the plugin was killed`;
    await this.end(this.broken);
    return new RpcUnanswered(`${why}; cancelled, and the plugin was killed`, true);
  }

  private write(line: string): void {
    tap?.("in", line.trimEnd());
    if (this.child.stdin?.writable) this.child.stdin.write(line);
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      this.poison(`an invalid message (${parsed.reason})`);
      return;
    }
    const m = parsed.value;
    if (m.type === "notification") {
      // A watch owns its notifications; with none open, one is unexpected.
      if (this.onNotification !== undefined) {
        this.onNotification(m.method, m.params);
      } else {
        this.poison(`an unexpected notification ${m.method}`);
      }
      return;
    }
    if (m.type === "error" && m.id === null) {
      this.poison(`an error with no id (${firstLine(m.error.message)})`);
      return;
    }
    if (m.id === null) return;
    const late = this.cancelled.get(m.id);
    if (late !== undefined) {
      late(); // a cancelled call's reply: it ends the grace, and is ignored
      return;
    }
    const p = this.pending.get(m.id);
    if (p === undefined) {
      // The reply to `shutdown` (sent without a pending entry) is expected; anything else is not.
      if (this.stopping !== undefined) return;
      this.poison(`a reply to no pending request (id ${m.id})`);
      return;
    }
    if (m.type === "error") {
      p.reject(new RpcFailure(m.error.kind, firstLine(m.error.message), m.error.remedy));
    } else {
      p.resolve(m.result);
    }
  }

  /**
   * It broke the protocol (an invalid message, or a result mu found invalid): refused for the
   * invocation; pending calls lose their answer; stopped.
   */
  poison(reason: string): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.broken ??= reason;
    this.failPending(reason);
    void this.stop(reason);
  }

  private failPending(reason: string): void {
    for (const p of [...this.pending.values()]) p.reject(new RpcUnanswered(reason, true));
  }

  private refStreams(on: boolean): void {
    const streams = [
      this.child,
      this.child.stdin,
      this.child.stdout,
      this.child.stderr,
    ] as unknown as Unrefable[];
    for (const s of streams) (on ? s?.ref : s?.unref)?.call(s);
  }
}

/** Every plugin process this invocation started whose group is not yet empty. */
export function livePluginProcesses(): PluginProcess[] {
  return [...live];
}
