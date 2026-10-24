import { afterEach, beforeEach, vi } from "vitest";
import {
  DELEGATE_TOOL,
  type DelegateCtx,
  type DelegateTool,
  type MuResult,
  type MuRunner,
} from "../extension/delegate.js";

const ENV_KEYS = [
  "MU_MANAGED_AGENT",
  "MU_DELEGATE",
  "MU_DELEGATE_MAX",
  "MU_MUX",
  "MU_CTL_SOCK",
  "XDG_CACHE_HOME",
] as const;
const saved: Record<string, string | undefined> = {};

/** Register the env save/restore hooks every delegate test file needs. */
export function installDelegateEnv(): void {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.MU_MUX = "tmux"; // a mux "is detected" without probing the host
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

/** A mu success: an object is the envelope's `data` (`{ok:true,data,next}`, as
 *  `mu --json` prints it); a string is plain text, as `mu agent read` prints. */
export const ok = (stdout: unknown): MuResult => ({
  code: 0,
  stdout:
    typeof stdout === "string" ? stdout : JSON.stringify({ ok: true, data: stdout, next: null }),
  stderr: "",
});

/** A mu failure under --json: ONE document on stdout, `data` its partial evidence. */
export const failed = (code: number, error: string, message: string, data?: unknown): MuResult => ({
  code,
  stdout: JSON.stringify({
    ok: false,
    error,
    message,
    next: null,
    exit: code,
    ...(data !== undefined ? { data } : {}),
  }),
  stderr: "",
});

type Deferred = { resolve: (r: MuResult) => void; signal?: AbortSignal };

/** A fake `mu`: records argv, answers spawn/list/send/read/close, holds waits open. */
type Override = (args: readonly string[]) => Promise<MuResult> | undefined;

export function fakeMu(
  opts: {
    ctl?: string;
    workspace?: string;
    /** Overrides per agent verb. `send` answers the `--send` inside spawn,
     *  as `mu agent send --json` would (a non-zero code fails the send). */
    on?: Record<string, Override>;
    /** `mu task <verb>` overrides; default `task show` finds the task in ws `crew`. */
    task?: Record<string, Override>;
  } = {},
) {
  const calls: string[][] = [];
  const waits = new Map<string, Deferred>();
  /** Agents up in scratch: delegate-1 belongs to someone else. */
  const taken = new Set(["delegate-1"]);
  /** `--next-free`, as mu picks it. */
  const nextFree = (base: string) => {
    const m = /^(.*)-(\d+)$/.exec(base);
    const [stem, first] = m ? [m[1] ?? "", Number(m[2])] : [base, 1];
    for (let n = first; ; n++) {
      const name = n === first ? base : `${stem}-${n}`;
      if (!taken.has(name)) return name;
    }
  };
  const spawnReply = async (args: readonly string[]): Promise<MuResult> => {
    const name = args.includes("--next-free") ? nextFree(String(args[2])) : String(args[2]);
    taken.add(name);
    const base = {
      agent: { name, cwd: opts.workspace ?? null },
      ctl: opts.ctl ?? "ok",
      nextSteps: [{ intent: "Attach the pane", command: `tmux attach -t mu-scratch` }],
    };
    const text = args[args.indexOf("--send") + 1];
    if (!args.includes("--send") || base.ctl !== "ok") return ok(base);
    const sendArgs = ["agent", "send", name, String(text), "-w", "scratch", "--json"];
    const s = (await opts.on?.send?.(sendArgs)) ?? ok({ transport: "ctl", runs: 0 });
    if (s.code !== 0) {
      const send = { ok: false, message: s.stderr, ...(s.stdout ? { error: s.stdout } : {}) };
      return failed(s.code, s.stdout || "Error", s.stderr, { ...base, send });
    }
    const sent = (JSON.parse(s.stdout) as { data: object }).data;
    return ok({ ...base, send: { ok: true, ...sent } });
  };
  const run: MuRunner = (args, signal) => {
    calls.push([...args]);
    const [ns, verb, name] = args;
    if (ns === "task") {
      const o = opts.task?.[verb ?? ""]?.(args);
      if (o) return o;
      if (verb === "show") {
        const ref = String(name);
        const [ws, local] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
        const wi = args.indexOf("-w");
        const workstreamName = ws ?? (wi >= 0 ? args[wi + 1] : "crew");
        return Promise.resolve(ok({ task: { name: local, workstreamName } }));
      }
      return Promise.resolve(ok("{}"));
    }
    if (ns !== "agent") return Promise.resolve(ok(""));
    const o = opts.on?.[verb ?? ""]?.(args);
    if (o) return o;
    switch (verb) {
      case "list":
        return Promise.resolve(ok({ agents: [...taken].map((n) => ({ name: n })) }));
      case "spawn":
        return spawnReply(args);
      case "close":
        taken.delete(String(name));
        return Promise.resolve(ok("{}"));
      case "wait":
        return new Promise((resolve) => {
          waits.set(name ?? "", { resolve, ...(signal ? { signal } : {}) });
        });
      case "read":
        return Promise.resolve(ok("last pane lines\n"));
      default:
        return Promise.resolve(ok("{}"));
    }
  };
  return { run, calls, waits, taken };
}

/** The text a spawn call sent (`--send`), or undefined. */
export const sentArg = (c: readonly string[]) =>
  c[1] === "spawn" && c.includes("--send") ? c[c.indexOf("--send") + 1] : undefined;

export function fakePi() {
  const tools = new Map<string, DelegateTool>();
  const shutdown: Array<(e: unknown, c: DelegateCtx) => unknown> = [];
  const handlers = new Map<string, Array<(e: unknown, c: DelegateCtx) => unknown>>();
  /** pi mid-turn: a follow-up waits in its queue instead of starting at once. */
  const state = { busy: false };
  const start = (m: unknown) =>
    fire("message_start", { type: "message_start", message: { role: "custom", ...(m as object) } });
  const sendMessage = vi.fn(async (m: unknown, _o?: unknown) => {
    if (!state.busy) await start(m);
  });
  const emitted: { channel: string; data: unknown }[] = [];
  const pi = {
    events: { emit: (channel: string, data: unknown) => void emitted.push({ channel, data }) },
    registerTool: (t: DelegateTool) => {
      tools.set(t.name, t);
    },
    sendMessage,
    on: (e: string, h: (e: unknown, c: DelegateCtx) => unknown) => {
      if (e === "session_shutdown") shutdown.push(h);
      handlers.set(e, [...(handlers.get(e) ?? []), h]);
    },
  };
  /** Fire a pi event at the extension's handlers. */
  const fire = async (event: string, data: unknown) => {
    for (const h of handlers.get(event) ?? []) await h(data, {});
  };
  /** The turn ends and pi starts every queued follow-up. */
  const drainQueue = async () => {
    state.busy = false;
    for (const [m] of sendMessage.mock.calls) await start(m);
  };
  return { pi, tools, sendMessage, shutdown, emitted, state, fire, drainQueue, handlers };
}

export function sentText(p: { sendMessage: { mock: { calls: unknown[][] } } }): string {
  const m = p.sendMessage.mock.calls[0]?.[0] as { content?: string } | undefined;
  return m?.content ?? "";
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

export function tool(p: ReturnType<typeof fakePi>, name = DELEGATE_TOOL): DelegateTool {
  const t = p.tools.get(name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}
