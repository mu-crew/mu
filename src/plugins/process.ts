// mu — the plugin process manager (spec 2026-11-09-mu-plugins.md, D13 Process
// and Timeouts).
//
// mu starts a plugin's registered argv as its child, in its own process group,
// for one invocation. Requests are framed lines on its stdin; replies and
// notifications come back on its stdout; stderr is drained, never parsed and
// never stored (its first line may name a failure).
//
// ─── One lifecycle per process ──────────────────────────────────────────
//
//   starting ──ready()──▶ ready ──┐
//      │                          ├──stop(why)──▶ stopping ──▶ gone
//      └──────────────────────────┘
//
// - starting: spawned and TRACKED (in `live`, the moment spawn() returns a
//   pid, before any event); only the handshake runs.
// - ready: the handshake held (the client calls `ready()`); calls run.
// - stopping: the ONE stop sequence, whatever began it (a request's deadline
//   or abort, a SIGINT, SIGTERM or SIGHUP, an invalid message, the leader's
//   exit, a normal shutdown): every request's timer and abort listener is
//   disarmed, `$/cancel` goes out for each pending call and `shutdown` after
//   them, stdin closes, then at most ONE grace (`graceMs`, HOST_GRACE_MS) for
//   the group to empty, then the group is killed. Replies that arrive meanwhile
//   are ignored. No request is accepted.
// - gone: the group is empty (killed until it is), the pipes closed, and
//   every pending request settled, exactly once, with no answer.
//
// mu tracks the group, not the leader: the leader's exit begins the stop, and
// whatever it left in its group is killed. A helper that left the group
// (setsid, a double fork into another group) is a protocol violation mu cannot
// reach; the contract suite detects it.
//
// ─── Terminating ────────────────────────────────────────────────────────
//
// The first SIGINT, SIGTERM or SIGHUP mu receives while a plugin lives sets a
// process-wide latch (`muTerminating`). From then on no plugin starts, no
// session restarts, no request is sent; every live plugin takes its stop
// sequence; later signals are absorbed. Once every plugin is gone, a signal no
// verb listens for is raised again (signal-exit stands aside while mu
// listens), so mu dies by it. A verb that listens exits through handle(). An
// exit that cannot wait (`process.exit`, a crash) kills the groups at once
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

export type PluginState = "starting" | "ready" | "stopping" | "gone";

type Tap = (stream: "in" | "out" | "err", text: string) => void;
let tap: Tap | undefined;

/** Tests: see every line mu writes (`in`), every line it reads (`out`) and the stderr bytes. */
export function setPluginTapForTests(fn: Tap | undefined): void {
  tap = fn;
}

/**
 * One stop sequence, timed (ms epoch): `began` (stop() called), the grace's wait from
 * `graceFrom` to `graceTo`, ended `by` the leader's exit or the grace running out, and
 * `gone` (the group killed, the pipes closed, every call settled). Outside the wait, the
 * time is mu's own.
 */
export interface StopTrace {
  pgid: number;
  why: string;
  began: number;
  graceFrom: number;
  graceTo: number;
  by: "leader" | "grace";
  /** When the leader's exit reached mu; null if it never did. */
  leaderAt: number | null;
  gone: number;
}

let stopTrace: ((t: StopTrace) => void) | undefined;

/** Tests: see each stop sequence's timings as it completes. */
export function setStopTraceForTests(fn: ((t: StopTrace) => void) | undefined): void {
  stopTrace = fn;
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

// ─── The terminating latch ──────────────────────────────────────────────

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type StopSignal = (typeof SIGNALS)[number];

let terminating: StopSignal | undefined;

/** The terminating signal mu got while a plugin lived; undefined while mu is not terminating. */
export function muTerminating(): StopSignal | undefined {
  return terminating;
}

/** Why nothing new may start or be sent, once the latch is set. */
export function terminatingReason(sig: StopSignal): string {
  return `mu is stopping (it got ${sig})`;
}

let raise = (sig: StopSignal): void => {
  process.kill(process.pid, sig);
};

/** Tests: what mu does with a signal no verb handles, once its plugins are gone. */
export function setSignalRaiseForTests(fn: ((sig: StopSignal) => void) | undefined): void {
  raise =
    fn ??
    ((sig) => {
      process.kill(process.pid, sig);
    });
}

/** Tests: clear the latch (a test process lives past its "terminating" signal). */
export function resetTerminatingForTests(): void {
  terminating = undefined;
}

/** signal-exit's own listeners on each signal (one per loaded instance). */
function signalExitListeners(): number {
  const emitter = (globalThis as Record<symbol, { count?: unknown } | undefined>)[
    Symbol.for("signal-exit emitter")
  ];
  return typeof emitter?.count === "number" ? emitter.count : 0;
}

const onSignal = new Map<StopSignal, () => void>(
  SIGNALS.map((sig) => [
    sig,
    () => {
      // Later signals are absorbed: the first one owns the stop.
      if (terminating !== undefined) return;
      terminating = sig;
      // A verb that listens handles the signal itself (and exits through handle()).
      const verbs = process.listeners(sig).length - 1 - signalExitListeners();
      void Promise.all([...live].map((p) => p.stop(`mu got ${sig}`))).then(() => {
        removeSignals();
        if (verbs <= 0) raise(sig);
      });
    },
  ]),
);

function installSignals(): void {
  removeExitHook ??= onExit(killLive);
  for (const [sig, fn] of onSignal) if (!process.listeners(sig).includes(fn)) process.on(sig, fn);
}

function removeSignals(): void {
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
  /** Clear the request's timer and abort listener: the stop sequence owns it now. */
  disarm(): void;
  /** It was written to the plugin's stdin: an effect may have happened. */
  sent: boolean;
}

type Unrefable = { ref?: () => void; unref?: () => void };

/** How a watch ended: its notification, or `gone` (the plugin stopped; `params` says why). */
export type WatchNote = { method: string; params: unknown };

export class PluginProcess {
  readonly pgid: number;
  /** The group leader's start time, where the platform tells it (Linux), for D4's group proof. */
  readonly pgidStart: string | null;
  state: PluginState = "starting";
  /** Why the plugin stopped (set when stopping begins); undefined while it runs. */
  broken: string | undefined;
  /** It broke the protocol (an invalid message): it stays refused for the invocation. */
  poisoned = false;
  /** The notification handler; without one a notification breaks the plugin. */
  onNotification: ((method: string, params: unknown) => void) | undefined;
  private stderrHead = "";
  private stderrDone = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Open watches by id (D13 Streaming watch): their one notification, or the stop, ends each. */
  private readonly watches = new Map<string, (end: WatchNote) => void>();
  /** Watches mu cancelled: a notification for one that crossed the cancel is ignored. */
  private readonly cancelled = new Set<string>();
  private readonly early = new Map<string, WatchNote>();
  private leaderExit: string | undefined;
  private leaderExitAt: number | null = null;
  private readonly leaderGone: Promise<void>;
  private readonly stdoutClosed: Promise<void>;
  private stopping: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcess & { pid: number },
    /** The one grace: a stop's wait for the group to empty, and a run's reply allowance (link.ts). */
    readonly graceMs: number,
  ) {
    this.pgid = child.pid;
    this.pgidStart = pidStart(child.pid);
    this.leaderGone = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.leaderExitAt = Date.now();
        this.leaderExit = String(code ?? signal);
        resolve();
        // What the leader left in its group answers for no one: the stop takes it.
        void this.stop(`the plugin exited (${this.leaderExit})`);
      });
    });
    this.stdoutClosed = new Promise((resolve) => child.stdout?.once("close", () => resolve()));
    const reader = new LineReader();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.state === "stopping" || this.state === "gone") {
        tap?.("out", chunk.toString("utf8").trimEnd()); // read and ignored: the stop owns it
        return;
      }
      for (const line of reader.push(chunk)) {
        tap?.("out", line);
        this.onLine(line);
        if (this.state !== "starting" && this.state !== "ready") return;
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

  /**
   * Start `argv` in its own process group, tracked from the moment spawn() returns. Refused
   * once mu is terminating. A spawn failure (ENOENT, EACCES) rejects.
   */
  static start(
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    graceMs = defaultGraceMs,
  ): Promise<PluginProcess> {
    if (terminating !== undefined) {
      return Promise.reject(new RpcUnanswered(terminatingReason(terminating), false));
    }
    const [cmd, ...args] = argv;
    if (cmd === undefined) return Promise.reject(new Error("empty plugin argv"));
    const child = spawn(cmd, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    if (child.pid === undefined) {
      // Not started (ENOENT, EACCES): nothing to track; the error event says why.
      return new Promise((_, reject) => child.once("error", reject));
    }
    const p = new PluginProcess(child as ChildProcess & { pid: number }, graceMs);
    live.add(p);
    installSignals();
    return new Promise((resolve, reject) => {
      child.once("error", (e) => {
        void p.stop(`the plugin did not start: ${e.message}`);
        reject(e);
      });
      child.once("spawn", () => resolve(p));
    });
  }

  /** The handshake held: calls may run. False when the plugin is already stopping. */
  ready(): boolean {
    if (this.state !== "starting") return false;
    this.state = "ready";
    return true;
  }

  /** The first line of what the plugin wrote to stderr so far. */
  stderrLine(): string {
    return firstLine(this.stderrHead);
  }

  /** One request. Resolves the result; rejects `RpcFailure` or `RpcUnanswered`. */
  request(method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
    if (terminating !== undefined) {
      return Promise.reject(
        new RpcUnanswered(`not sent: ${terminatingReason(terminating)}`, false),
      );
    }
    if (this.state !== "starting" && this.state !== "ready") {
      return Promise.reject(new RpcUnanswered(`not sent: ${this.broken ?? this.state}`, false));
    }
    // Aborted before it could be written: nothing went out, and the plugin is untouched.
    if (opts.signal?.aborted) {
      return Promise.reject(new RpcUnanswered("not sent: cancelled before it was sent", false));
    }
    if (this.child.stdin?.writable !== true) {
      return Promise.reject(new RpcUnanswered("not sent: the plugin's stdin is closed", false));
    }
    const id = this.nextId++;
    const line = encodeMessage({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      let settled = false;
      const disarm = (): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        disarm();
        this.pending.delete(id);
        this.refStreams(this.busy());
        fn();
      };
      // A deadline or an abort stops the plugin: the one stop sequence owns it from here.
      const onAbort = (): void => void this.stop("cancelled; cancelled, and the plugin was killed");
      const timer = setTimeout(
        () =>
          void this.stop(
            `no answer within ${opts.timeoutMs} ms; cancelled, and the plugin was killed`,
          ),
        opts.timeoutMs,
      );
      const pending: Pending = {
        resolve: (v) => settle(() => resolve(v)),
        reject: (e) => settle(() => reject(e)),
        disarm,
        sent: false,
      };
      this.pending.set(id, pending);
      this.refStreams(true);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      // Written in this same turn, so a stop can never find it registered but unsent.
      pending.sent = this.write(line);
    });
  }

  /**
   * Route watch `id`'s notification to `on`, once; a stop ends it with `gone`. The plugin stays
   * referenced while a watch is open. Returns the cancel: `$/cancel {watchId}`, then nothing more.
   */
  watch(id: string, on: (end: WatchNote) => void): () => void {
    if (this.state === "stopping" || this.state === "gone") {
      on({ method: "gone", params: this.broken ?? this.state });
      return () => {};
    }
    const early = this.early.get(id);
    if (early !== undefined) {
      this.early.delete(id);
      on(early);
      return () => {};
    }
    this.watches.set(id, on);
    this.refStreams(true);
    return () => {
      if (!this.watches.delete(id)) return;
      this.cancelled.add(id);
      this.refStreams(this.busy());
      this.write(encodeMessage({ jsonrpc: "2.0", method: "$/cancel", params: { watchId: id } }));
    };
  }

  private busy(): boolean {
    return this.pending.size > 0 || this.watches.size > 0;
  }

  /** A normal exit's stop. Idempotent. */
  shutdown(): Promise<void> {
    return this.stop("shut down");
  }

  /**
   * The one stop sequence (idempotent: the first caller's reason stands): every request
   * disarmed, `$/cancel` for each pending call, `shutdown`, stdin closed, at most one grace
   * for the group to empty, the group killed, every pending request settled with no answer.
   */
  stop(why: string): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    const began = Date.now();
    this.state = "stopping";
    this.broken = why;
    for (const p of this.pending.values()) p.disarm();
    this.refStreams(true);
    // The promise exists before anything is written: a stop begun from inside this one (a
    // signal while `$/cancel` goes out) joins it.
    let begin: () => void = () => {};
    this.stopping = new Promise<void>((r) => {
      begin = r;
    }).then(async () => {
      const graceFrom = Date.now();
      const by = await Promise.race([
        this.leaderGone.then(() => "leader" as const),
        sleep(this.graceMs).then(() => "grace" as const),
      ]);
      const graceTo = Date.now();
      for (let i = 0; i < 500 && signalGroup(this.pgid, "SIGKILL"); i++) await sleep(10);
      await this.leaderGone;
      // With the group gone the pipe drains and closes; a helper that left the group may
      // still hold it, so mu stops reading after a moment.
      await Promise.race([this.stdoutClosed, sleep(200)]);
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      this.child.stdin?.destroy();
      const reason = `${why}${this.stderrHead ? `: ${this.stderrLine()}` : ""}`;
      for (const p of [...this.pending.values()]) p.reject(new RpcUnanswered(reason, p.sent));
      for (const on of [...this.watches.values()]) on({ method: "gone", params: reason });
      this.watches.clear();
      this.state = "gone";
      this.refStreams(false);
      live.delete(this);
      if (live.size === 0 && terminating === undefined) removeSignals();
      stopTrace?.({
        pgid: this.pgid,
        why,
        began,
        graceFrom,
        graceTo,
        by,
        leaderAt: this.leaderExitAt,
        gone: Date.now(),
      });
    });
    if (this.leaderExit === undefined) {
      for (const id of this.pending.keys()) {
        this.write(encodeMessage({ jsonrpc: "2.0", method: "$/cancel", params: { id } }));
      }
      if (!this.poisoned) {
        this.write(
          encodeMessage({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown", params: null }),
        );
      }
    }
    this.child.stdin?.end();
    begin();
    return this.stopping;
  }

  /** Write one line; false when stdin no longer takes it (nothing went out). */
  private write(line: string): boolean {
    if (this.child.stdin?.writable !== true) return false;
    tap?.("in", line.trimEnd());
    this.child.stdin.write(line);
    return true;
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
      const id = (m.params as { watchId?: unknown }).watchId;
      const on = typeof id === "string" ? this.watches.get(id) : undefined;
      if (on !== undefined && typeof id === "string") {
        this.watches.delete(id);
        this.refStreams(this.busy());
        on({ method: m.method, params: m.params });
      } else if (this.onNotification !== undefined) {
        this.onNotification(m.method, m.params);
      } else if (typeof id === "string" && !this.cancelled.has(id)) {
        // A settled turn is reported at once, maybe before mu has read the watch's reply:
        // held until the reply's caller claims it, at most until the next macrotask.
        this.early.set(id, { method: m.method, params: m.params });
        setImmediate(() => {
          if (this.early.delete(id)) this.poison(`an unexpected notification ${m.method}`);
        });
      } else if (typeof id !== "string") {
        this.poison(`an unexpected notification ${m.method}`);
      }
      return;
    }
    if (m.type === "error" && m.id === null) {
      this.poison(`an error with no id (${firstLine(m.error.message)})`);
      return;
    }
    if (m.id === null) return;
    const p = this.pending.get(m.id);
    if (p === undefined) {
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
   * invocation; its stop sequence settles every pending call with `reason`.
   */
  poison(reason: string): void {
    if (this.state === "stopping" || this.state === "gone") return;
    this.poisoned = true;
    void this.stop(reason);
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
