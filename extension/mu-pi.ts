/**
 * mu pi extension: serves the per-agent control socket from inside the
 * agent's interactive pi, so mu gets exact send / status / wait without
 * replacing the TUI or scraping the pane.
 *
 * Inert unless `$MU_CTL_SOCK` is set (mu injects it at spawn). Imports
 * nothing from mu except the protocol, and nothing from pi: the pi API is
 * typed structurally below so pi stays a peer, not a dependency.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  CTL_PROTOCOL_VERSION,
  type CtlReply,
  type CtlState,
  encode,
  LineDecoder,
} from "../src/ctl/protocol.js";

/** The slice of pi's ExtensionContext this extension uses. */
export interface MuPiContext {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
}

/** The slice of pi's ExtensionAPI this extension uses. */
export interface MuPiApi {
  on(
    event: "session_start" | "session_shutdown" | "agent_start" | "agent_settled",
    handler: (event: unknown, ctx: MuPiContext) => unknown,
  ): unknown;
  sendUserMessage(
    text: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void | Promise<void>;
}

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

export default function muPi(pi: MuPiApi): void {
  const sock = process.env.MU_CTL_SOCK;
  if (!sock) return;
  const sockPath: string = sock;

  let state: CtlState = "idle";
  let since = Date.now();
  let runs = 0;
  let ctx: MuPiContext | undefined;
  let server: Server | undefined;
  const conns = new Set<Socket>();
  const waiters = new Set<() => void>();
  const piVersion = detectPiVersion();

  const status = () => ({
    state,
    since,
    runs,
    pending: ctx?.hasPendingMessages() ?? false,
  });

  pi.on("agent_start", (_e, c) => {
    ctx = c;
    state = "busy";
    since = Date.now();
  });

  pi.on("agent_settled", (_e, c) => {
    ctx = c;
    state = "idle";
    since = Date.now();
    runs++;
    for (const w of [...waiters]) w();
  });

  async function handle(req: Record<string, unknown>, conn: Socket): Promise<Reply> {
    switch (req.op) {
      case "hello":
        return {
          v: V,
          ok: true,
          agent: process.env.MU_AGENT_NAME,
          workstream: process.env.MU_WORKSTREAM,
          piVersion,
        };
      case "status":
        return { v: V, ok: true, ...status() };
      case "send": {
        const text = str(req, "text");
        if (text === undefined) return fail("send needs a string text");
        const mode = req.mode === "steer" ? "steer" : "followUp";
        // A message sent while idle starts a run; options are only for a busy pi.
        if (ctx?.isIdle() ?? state === "idle") await pi.sendUserMessage(text);
        else await pi.sendUserMessage(text, { deliverAs: mode });
        return { v: V, ok: true, state };
      }
      case "wait":
        return wait(num(req, "afterRuns"), num(req, "timeoutMs"), conn);
      case "abort":
        if (!ctx) return fail("no pi context yet");
        ctx.abort();
        return { v: V, ok: true, state };
      default:
        return fail(`unknown op: ${String(req.op)}`);
    }
  }

  /** Resolve once a run past `afterRuns` has settled (any next settle when omitted). */
  function wait(afterRuns: number | undefined, timeoutMs: number | undefined, conn: Socket) {
    if (afterRuns !== undefined && runs > afterRuns && state === "idle") {
      return Promise.resolve<Reply>({ v: V, ok: true, ...status() });
    }
    return new Promise<Reply>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (r: Reply) => {
        waiters.delete(waiter);
        if (timer) clearTimeout(timer);
        conn.off("close", onClose);
        resolve(r);
      };
      const waiter = () => done({ v: V, ok: true, ...status() });
      const onClose = () => done(fail("client closed"));
      waiters.add(waiter);
      conn.on("close", onClose);
      if (timeoutMs !== undefined) timer = setTimeout(() => done(fail("timeout")), timeoutMs);
    });
  }

  function onConnection(conn: Socket): void {
    conns.add(conn);
    conn.setEncoding("utf8");
    const dec = new LineDecoder();
    let seen = false;
    conn.on("close", () => conns.delete(conn));
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
      handle(req as Record<string, unknown>, conn).then(
        (r) => {
          if (!conn.destroyed) conn.end(encode(r));
        },
        (e: unknown) => {
          if (!conn.destroyed) conn.end(encode(fail(e instanceof Error ? e.message : String(e))));
        },
      );
    });
  }

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    if (server) return; // a new/resumed session keeps the same socket
    mkdirSync(dirname(sockPath), { recursive: true, mode: 0o700 });
    rmSync(sockPath, { force: true });
    const s = createServer(onConnection);
    server = s;
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(sockPath, () => {
        s.off("error", reject);
        resolve();
      });
    });
    chmodSync(sockPath, 0o600);
  });

  pi.on("session_shutdown", async () => {
    const s = server;
    server = undefined;
    if (!s) return;
    waiters.clear();
    for (const c of conns) c.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
    rmSync(sockPath, { force: true });
  });
}
