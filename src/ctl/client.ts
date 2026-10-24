/**
 * Client for the per-agent control socket served by the mu pi extension.
 * One request per connection: connect, write one line, read one line, end.
 */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  CTL_PROTOCOL_VERSION,
  type CtlFeature,
  type CtlReply,
  type CtlRequest,
  type CtlStatus,
  encode,
  LineDecoder,
  UNKNOWN_OP_PREFIX,
} from "./protocol.js";

/** Default client timeout for non-`wait` requests. */
export const CTL_DEFAULT_TIMEOUT_MS = 5000;
/** Client timeout for `fresh` and `command`: the new session must start its run, or pi reload. */
export const CTL_FRESH_TIMEOUT_MS = 60_000;
/** Slack added to a `wait` request's own timeoutMs for the client timeout. */
export const CTL_WAIT_SLACK_MS = 5000;

export type CtlProbe =
  | {
      kind: "ok";
      status: CtlStatus;
      /** From hello: the ops the extension serves. Absent: it predates reporting them. */
      ops?: string[];
      /** From hello: the mu version the extension was built from. */
      extVersion?: string;
      /** From hello: the optional features the extension serves. Absent: it predates reporting them. */
      features?: string[];
      /** The pi process's incarnation (status reply, else hello's); absent from older extensions. */
      incarnation?: string;
    }
  | { kind: "missing" }
  | { kind: "refused"; error: string }
  | { kind: "version"; got: unknown };

export class CtlVersionError extends Error {
  constructor(readonly got: unknown) {
    super(`control socket speaks protocol v${String(got)}; mu expects v${CTL_PROTOCOL_VERSION}`);
    this.name = "CtlVersionError";
  }
}

export class CtlTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`control socket did not reply within ${timeoutMs}ms`);
    this.name = "CtlTimeoutError";
  }
}

/**
 * A side-effecting request (send, fresh, interrupt, command) was written
 * to the socket, then the connection timed out, errored or closed with no
 * reply. pi may or may not have acted on it. `cause` is the raw failure.
 */
export class CtlDeliveryUnknownError extends Error {
  constructor(
    readonly op: string,
    override readonly cause: Error,
  ) {
    super(`control socket ${op} request was written but no reply arrived: ${cause.message}`);
    this.name = "CtlDeliveryUnknownError";
  }
}

/** Ops that change pi's state: a failure after the write is ambiguous. */
const SIDE_EFFECT_OPS: ReadonlySet<string> = new Set(["send", "fresh", "interrupt", "command"]);

/**
 * The extension answered "unknown op": it was loaded before mu learned
 * `op`. `ops` lists what it serves (absent from extensions that predate
 * reporting them).
 */
export class CtlUnknownOpError extends Error {
  constructor(
    readonly op: string,
    readonly ops?: readonly string[],
  ) {
    super(`control socket does not serve op ${op}`);
    this.name = "CtlUnknownOpError";
  }
}

function clientTimeout(req: CtlRequest, override?: number): number | undefined {
  if (override !== undefined) return override;
  if (req.op === "fresh" || req.op === "command") return CTL_FRESH_TIMEOUT_MS;
  if (req.op !== "wait" && req.op !== "interrupt") return CTL_DEFAULT_TIMEOUT_MS;
  // An unbounded wait (or interrupt) is held until pi settles.
  return req.timeoutMs === undefined ? undefined : req.timeoutMs + CTL_WAIT_SLACK_MS;
}

function parseReply(line: string): CtlReply {
  const msg: unknown = JSON.parse(line);
  const v = typeof msg === "object" && msg !== null ? (msg as { v?: unknown }).v : undefined;
  if (v !== CTL_PROTOCOL_VERSION) throw new CtlVersionError(v);
  return msg as CtlReply;
}

/**
 * Send one request and resolve with its reply. Rejects with the socket
 * error (its `code` intact), CtlTimeoutError, CtlDeliveryUnknownError
 * (side-effecting op failed after the write), CtlVersionError, or
 * CtlUnknownOpError (an ok:false "unknown op" reply).
 * Aborting `signal` closes the connection and rejects.
 */
export function ctlRequest(
  sock: string,
  req: CtlRequest,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CtlReply> {
  const timeoutMs = clientTimeout(req, opts?.timeoutMs);
  return new Promise((resolve, reject) => {
    const conn = createConnection(sock);
    // Set when conn.write is called. A write callback is not a delivery ack, so never cleared.
    let written = false;
    const ambiguous = (err: Error): Error =>
      written && SIDE_EFFECT_OPS.has(req.op) ? new CtlDeliveryUnknownError(req.op, err) : err;
    const dec = new LineDecoder();
    let done = false;
    const finish = (err: Error | null, reply?: CtlReply): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      conn.destroy();
      if (err) reject(err);
      else if (reply) resolve(reply);
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => finish(ambiguous(new CtlTimeoutError(timeoutMs))), timeoutMs);
    const signal = opts?.signal;
    if (signal?.aborted) finish(new Error("control socket request aborted"));
    signal?.addEventListener("abort", () => finish(new Error("control socket request aborted")), {
      once: true,
    });
    conn.setEncoding("utf8");
    conn.on("connect", () => {
      written = true;
      conn.write(encode(req));
    });
    conn.on("data", (chunk: string) => {
      const line = dec.push(chunk)[0];
      if (line === undefined) return;
      try {
        const reply = parseReply(line);
        if (!reply.ok && reply.error.startsWith(UNKNOWN_OP_PREFIX)) {
          finish(new CtlUnknownOpError(req.op, reply.ops));
        } else finish(null, reply);
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
    conn.on("error", (e) => finish(ambiguous(e)));
    conn.on("close", () => finish(ambiguous(new Error("control socket closed without a reply"))));
  });
}

/** A fresh msgId for a send/fresh/interrupt: 36 characters, within the extension's limit. */
export function newMsgId(): string {
  return randomUUID();
}

/** Whether a hello reply lists `feature`. An older extension lists none. */
export function ctlServes(hello: CtlReply, feature: CtlFeature): boolean {
  return hello.ok && (hello.features?.includes(feature) ?? false);
}

/** A Node system error's `code` (ENOENT, ECONNREFUSED, ...), if any. */
export function errCode(e: unknown): string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * hello + status (status only with `hello: false`, one connection).
 * `timeoutMs` bounds the whole probe, not each request. ENOENT → missing;
 * a version mismatch → version; any other failure (ECONNREFUSED,
 * ENOTSOCK, timeout, bad reply) → refused.
 */
export async function ctlProbe(
  sock: string,
  timeoutMs = CTL_DEFAULT_TIMEOUT_MS,
  opts: { hello?: boolean } = {},
): Promise<CtlProbe> {
  const deadline = Date.now() + timeoutMs;
  try {
    let hello: CtlReply | undefined;
    if (opts.hello !== false) {
      hello = await ctlRequest(sock, { op: "hello" }, { timeoutMs });
      if (!hello.ok) return { kind: "refused", error: hello.error };
    }
    const left = Math.max(1, deadline - Date.now());
    const st = await ctlRequest(sock, { op: "status" }, { timeoutMs: left });
    if (!st.ok) return { kind: "refused", error: st.error };
    const { state, since, runs, pending, blocked } = st;
    if (state === undefined || since === undefined || runs === undefined || pending === undefined) {
      return { kind: "refused", error: "status reply is missing fields" };
    }
    return {
      kind: "ok",
      status: { state, since, runs, pending, ...(blocked !== undefined ? { blocked } : {}) },
      ...(hello?.ok && hello.ops !== undefined ? { ops: hello.ops } : {}),
      ...(hello?.ok && hello.extVersion !== undefined ? { extVersion: hello.extVersion } : {}),
      ...(hello?.ok && hello.features !== undefined ? { features: hello.features } : {}),
      ...(st.incarnation !== undefined || (hello?.ok && hello.incarnation !== undefined)
        ? { incarnation: st.incarnation ?? (hello?.ok ? hello.incarnation : undefined) }
        : {}),
    };
  } catch (e) {
    if (e instanceof CtlVersionError) return { kind: "version", got: e.got };
    if (errCode(e) === "ENOENT") return { kind: "missing" };
    return { kind: "refused", error: e instanceof Error ? e.message : String(e) };
  }
}
