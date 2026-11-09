// mu — the plugin process manager (spec 2026-11-09-mu-plugins.md, D13 Process
// and Timeouts).
//
// mu starts a plugin's registered argv as its child, in its own process group,
// for one invocation. Requests are framed lines on its stdin; replies and
// notifications come back on its stdout; stderr is drained, never parsed and
// never stored (its first line may name a failure). An invalid message breaks
// the plugin for the rest of the invocation: every pending call loses its
// answer and the group is reaped.
//
// Cancel: on a call's deadline or its abort signal, mu sends `$/cancel {id}`,
// gives the plugin HOST_GRACE_MS to wind the call down (a reply to it ends the
// wait early, and is ignored), then kills the group; the call has no answer.
// A verb's SIGINT reaches a call through its abort signal. At a normal exit mu
// sends `shutdown`, closes stdin, waits HOST_GRACE_MS and kills the group,
// which also takes any helper the plugin left in its group. On any other exit
// the group is killed at once (signal-exit), and a mu killed by SIGKILL leaves
// the plugin its stdin EOF, on which it must exit within the grace.
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

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

type Unrefable = { ref?: () => void; unref?: () => void };

export class PluginProcess {
  readonly pgid: number;
  /** The group leader's start time, where the platform tells it (Linux), for D4's group proof. */
  readonly pgidStart: string | null;
  /** Why the plugin is broken for this invocation; undefined while it is usable. */
  broken: string | undefined;
  /** The notification handler; without one a notification breaks the plugin. */
  onNotification: ((method: string, params: unknown) => void) | undefined;
  private stderrHead = "";
  private stderrDone = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Cancelled ids whose late reply is ignored; the value ends the cancel's grace early. */
  private readonly cancelled = new Map<number, () => void>();
  private exitedFlag = false;
  private readonly exited: Promise<void>;
  private shuttingDown: Promise<void> | undefined;

  private constructor(
    private readonly child: ChildProcess & { pid: number },
    private readonly graceMs: number,
  ) {
    this.pgid = child.pid;
    this.pgidStart = pidStart(child.pid);
    let exit = "";
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitedFlag = true;
        exit = String(code ?? signal);
        live.delete(this);
        if (live.size === 0) {
          removeExitHook?.();
          removeExitHook = undefined;
        }
        resolve();
      });
    });
    // No reply can come once stdout closes (a helper holding it open keeps it, until the reap).
    child.stdout?.once("close", () => {
      // Its exit status usually follows the pipe's close: wait a moment to name it.
      void Promise.race([this.exited, sleep(200)]).then(() => {
        const how = exit === "" ? "closed its stdout" : `exited (${exit})`;
        const why = `the plugin ${how}${this.stderrHead ? `: ${this.stderrLine()}` : ""}`;
        this.broken ??= why;
        this.failPending(why);
      });
    });
    const reader = new LineReader();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.broken !== undefined) return;
      for (const line of reader.push(chunk)) {
        tap?.("out", line);
        this.onLine(line);
        if (this.broken !== undefined) return;
      }
      if (reader.overflow) this.break("a message over 1 MiB");
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
    graceMs = HOST_GRACE_MS,
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
        if (live.size === 0) removeExitHook = onExit(killLive);
        live.add(p);
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

  /** `shutdown`, stdin closed, the grace, then the group killed. Idempotent. */
  shutdown(): Promise<void> {
    this.shuttingDown ??= (async () => {
      if (!this.exitedFlag && this.broken === undefined) {
        try {
          await this.request("shutdown", null, { timeoutMs: this.graceMs });
        } catch {}
      }
      await this.reap();
    })();
    return this.shuttingDown;
  }

  /** stdin closed (the plugin's EOF), up to the grace for it to exit, then the group killed. */
  private async reap(): Promise<void> {
    this.child.stdin?.end();
    this.refStreams(true);
    await Promise.race([this.exited, sleep(this.graceMs)]);
    // The leader may be gone while a helper it left in the group lives on.
    for (let i = 0; i < 500 && signalGroup(this.pgid, "SIGKILL"); i++) await sleep(10);
    await this.exited;
    // A helper that left the group may still hold the pipes: mu stops reading them.
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.refStreams(false);
  }

  private async cancel(id: number, why: string): Promise<RpcUnanswered> {
    this.refStreams(true);
    const answered = new Promise<void>((resolve) => this.cancelled.set(id, resolve));
    if (!this.exitedFlag)
      this.write(encodeMessage({ jsonrpc: "2.0", method: "$/cancel", params: { id } }));
    await Promise.race([answered, this.exited, sleep(this.graceMs)]);
    this.broken ??= `a call was cancelled (${why}): the plugin was killed`;
    await this.reap();
    return new RpcUnanswered(`${why}; cancelled, and the plugin was killed`, true);
  }

  private write(line: string): void {
    tap?.("in", line.trimEnd());
    this.child.stdin?.write(line);
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      this.break(`an invalid message (${parsed.reason})`);
      return;
    }
    const m = parsed.value;
    if (m.type === "notification") {
      // A watch owns its notifications; with none open, one is unexpected.
      if (this.onNotification !== undefined) {
        this.onNotification(m.method, m.params);
      } else {
        this.break(`an unexpected notification ${m.method}`);
      }
      return;
    }
    if (m.type === "error" && m.id === null) {
      this.break(`an error with no id (${firstLine(m.error.message)})`);
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
      this.break(`a reply to no pending request (id ${m.id})`);
      return;
    }
    if (m.type === "error") {
      p.reject(new RpcFailure(m.error.kind, firstLine(m.error.message), m.error.remedy));
    } else {
      p.resolve(m.result);
    }
  }

  /** Mark the plugin broken for the invocation; pending calls lose their answer; reap it. */
  break(reason: string): void {
    if (this.broken !== undefined) return;
    this.broken = reason;
    this.failPending(reason);
    void this.reap();
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

function killLive(): void {
  for (const p of live) signalGroup(p.pgid, "SIGKILL");
}

/** Every plugin process this invocation started and that still runs. */
export function livePluginProcesses(): PluginProcess[] {
  return [...live];
}
