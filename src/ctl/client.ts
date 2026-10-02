/**
 * Client for the per-agent control socket served by the mu pi extension.
 * One request per connection: connect, write one line, read one line, end.
 */
import { createConnection } from "node:net";
import {
  CTL_PROTOCOL_VERSION,
  type CtlReply,
  type CtlRequest,
  type CtlStatus,
  encode,
  LineDecoder,
  UNKNOWN_OP_PREFIX,
} from "./protocol.js";

/** Default client timeout for non-`wait` requests. */
export const CTL_DEFAULT_TIMEOUT_MS = 5000;
/** Client timeout for `fresh`: the new session must start its run. */
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
  if (req.op === "fresh") return CTL_FRESH_TIMEOUT_MS;
  if (req.op !== "wait") return CTL_DEFAULT_TIMEOUT_MS;
  // An unbounded wait is held until pi settles.
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
 * error (its `code` intact), CtlTimeoutError, CtlVersionError, or
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
        : setTimeout(() => finish(new CtlTimeoutError(timeoutMs)), timeoutMs);
    const signal = opts?.signal;
    if (signal?.aborted) finish(new Error("control socket request aborted"));
    signal?.addEventListener("abort", () => finish(new Error("control socket request aborted")), {
      once: true,
    });
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(encode(req)));
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
    conn.on("error", (e) => finish(e));
    conn.on("close", () => finish(new Error("control socket closed without a reply")));
  });
}

/** A Node system error's `code` (ENOENT, ECONNREFUSED, ...), if any. */
export function errCode(e: unknown): string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * hello + status. ENOENT → missing; a version mismatch → version; any
 * other failure (ECONNREFUSED, ENOTSOCK, timeout, bad reply) → refused.
 */
export async function ctlProbe(
  sock: string,
  timeoutMs = CTL_DEFAULT_TIMEOUT_MS,
): Promise<CtlProbe> {
  try {
    const hello = await ctlRequest(sock, { op: "hello" }, { timeoutMs });
    if (!hello.ok) return { kind: "refused", error: hello.error };
    const st = await ctlRequest(sock, { op: "status" }, { timeoutMs });
    if (!st.ok) return { kind: "refused", error: st.error };
    const { state, since, runs, pending } = st;
    if (state === undefined || since === undefined || runs === undefined || pending === undefined) {
      return { kind: "refused", error: "status reply is missing fields" };
    }
    return {
      kind: "ok",
      status: { state, since, runs, pending },
      ...(hello.ops !== undefined ? { ops: hello.ops } : {}),
      ...(hello.extVersion !== undefined ? { extVersion: hello.extVersion } : {}),
    };
  } catch (e) {
    if (e instanceof CtlVersionError) return { kind: "version", got: e.got };
    if (errCode(e) === "ENOENT") return { kind: "missing" };
    return { kind: "refused", error: e instanceof Error ? e.message : String(e) };
  }
}
