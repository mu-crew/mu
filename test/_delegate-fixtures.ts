import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import {
  DELEGATE_TOOL,
  type DelegateCtx,
  type DelegateTool,
  type MuResult,
  type MuRunner,
} from "../extension/delegate.js";
import { classifyError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import {
  finishDelegate,
  getDelegateCall,
  markDelegate,
  registerDelegateCall,
  reissueDelegateCall,
} from "../src/delegates.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask } from "../src/tasks.js";
import { rmFixtureDir } from "./_fs.js";

const ENV_KEYS = [
  "MU_MANAGED_AGENT",
  "MU_DELEGATE",
  "MU_DELEGATE_MAX",
  "MU_MUX",
  "MU_CTL_SOCK",
  "XDG_CACHE_HOME",
] as const;
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
const dbs: Db[] = [];

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
    for (const d of dbs.splice(0)) {
      try {
        d.close();
      } catch {}
    }
    for (const d of dirs.splice(0)) rmFixtureDir(d);
  });
}

/** A real SQLite DB in a temp dir, closed and removed after the test. */
export function tempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-delegate-ext-"));
  dirs.push(dir);
  const db = openDb({ path: join(dir, "mu.db") });
  dbs.push(db);
  return db;
}

/** The value of `--flag` in argv, or undefined. */
const flag = (a: readonly string[], f: string): string | undefined =>
  a.includes(f) ? a[a.indexOf(f) + 1] : undefined;

/**
 * `mu delegates <verb>` answered by the REAL SDK (src/delegates.ts) on a real
 * SQLite DB, as the CLI would print it: an envelope, and a typed error mapped
 * to the exit code `handle()` gives it. `stdin` is the `--text -` payload.
 */
export function delegatesVerb(db: Db, args: readonly string[], stdin?: string): MuResult {
  const [, verb, id = ""] = args;
  const wrap = (data: unknown): MuResult => ok(data);
  try {
    switch (verb) {
      case "register": {
        const rec = flag(args, "--record");
        const slash = rec?.indexOf("/") ?? -1;
        const out = registerDelegateCall(db, {
          callId: id,
          caller: flag(args, "--caller") ?? "pi:test",
          workstream: flag(args, "-w") ?? "scratch",
          request: {
            text: stdin ?? "",
            ...(flag(args, "--label") ? { label: flag(args, "--label") as string } : {}),
            ...(flag(args, "--cli") ? { cli: flag(args, "--cli") as string } : {}),
            ...(flag(args, "--model") ? { model: flag(args, "--model") as string } : {}),
            ...(flag(args, "--cwd") ? { cwd: flag(args, "--cwd") as string } : {}),
            ...(args.includes("--workspace") ? { workspace: true } : {}),
            ...(flag(args, "--timeout") ? { timeoutS: Number(flag(args, "--timeout")) } : {}),
            ...(args.includes("--keep") ? { keep: true } : {}),
          },
          ...(flag(args, "--wave") ? { wave: flag(args, "--wave") as string } : {}),
          ...(rec && slash > 0
            ? { record: { workstream: rec.slice(0, slash), task: rec.slice(slash + 1) } }
            : {}),
          state: (flag(args, "--state") ?? "queued") as "queued" | "starting" | "refused",
        });
        return wrap(out);
      }
      case "mark":
        return wrap({
          call: markDelegate(db, id, args[3] as "starting" | "running" | "refused", {
            ...(flag(args, "--agent") ? { agent: flag(args, "--agent") as string } : {}),
            ...(flag(args, "--error") ? { error: flag(args, "--error") as string } : {}),
          }),
        });
      case "finish":
        return wrap(
          finishDelegate(db, id, {
            outcome: flag(args, "--outcome") ?? "",
            ...(stdin !== undefined ? { text: stdin } : {}),
            ...(flag(args, "--elapsed-ms")
              ? { elapsedMs: Number(flag(args, "--elapsed-ms")) }
              : {}),
            author: flag(args, "--author") ?? "",
            ...(args.includes("--no-record") ? { record: false } : {}),
          }),
        );
      case "reissue":
        return wrap({ call: reissueDelegateCall(db, id) });
      case "show": {
        const call = getDelegateCall(db, id);
        if (!call)
          throw new (class DelegateNotFoundError extends Error {})(`no such delegate call: ${id}`);
        return wrap({ call });
      }
      default:
        return ok({});
    }
  } catch (err) {
    const { exitCode } = classifyError(err);
    const name = err instanceof Error ? err.name : "Error";
    return failed(exitCode, name, err instanceof Error ? err.message : String(err));
  }
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

export type FakeMu = {
  run: MuRunner;
  calls: string[][];
  waits: Map<string, Deferred>;
  taken: Set<string>;
  registry: Map<string, { id: number; pane_id: string }>;
  replace: (name: string) => { id: number; pane_id: string };
  /** The real SQLite DB `mu delegates` wrote to. */
  db: Db;
};

export function fakeMu(
  opts: {
    ctl?: string;
    workspace?: string;
    /** Overrides per agent verb. `send` answers the `--send` inside spawn,
     *  as `mu agent send --json` would (a non-zero code fails the send). */
    on?: Record<string, Override>;
    /** `mu task <verb>` overrides; default `task show` finds the task in ws `crew`. */
    task?: Record<string, Override>;
    /** The DB `mu delegates` writes to (default: a fresh temp one). */
    db?: Db;
  } = {},
): FakeMu {
  const db = opts.db ?? tempDb();
  const calls: string[][] = [];
  const waits = new Map<string, Deferred>();
  /** Agents up in scratch: delegate-1 belongs to someone else. */
  const taken = new Set(["delegate-1"]);
  /** The registry the way `mu agent close` sees it: one registry id per spawn,
   *  a revision that moves with it. `replace(name)` re-registers a name as
   *  another agent (a respawn behind the delegate's back). */
  const registry = new Map<string, { id: number; pane_id: string }>();
  let nextIncarnation = 100;
  const register = (name: string) => {
    const n = nextIncarnation++;
    const row = { id: n, pane_id: `%${n}` };
    registry.set(name, row);
    return row;
  };
  const replace = (name: string) => register(name);
  /** `--next-free`, as mu picks it. */
  const nextFree = (base: string) => {
    const m = /^(.*)-(\d+)$/.exec(base);
    const [stem, first] = m ? [m[1] ?? "", Number(m[2])] : [base, 1];
    for (let n = first; ; n++) {
      const name = n === first ? base : `${stem}-${n}`;
      if (!taken.has(name)) return name;
    }
  };
  /** Attempts already spawned: `${task}/${attempt}` -> its saved reply (a replay). */
  const attempts = new Map<string, { name: string; row: { id: number; pane_id: string } }>();
  const spawnReply = async (args: readonly string[]): Promise<MuResult> => {
    const ws = flag(args, "-w") ?? "scratch";
    const taskId = flag(args, "--task");
    const attempt = flag(args, "--attempt") ?? taskId;
    const saved = taskId ? attempts.get(`${ws}/${taskId}/${attempt}`) : undefined;
    if (saved) {
      // A replay answers from the journal: no new pane, no ctl, no second send.
      return ok({
        agent: { name: saved.name, cwd: opts.workspace ?? null, ...saved.row },
        send: { ok: true, transport: "ctl", runs: 0 },
        task: { id: taskId, attempt: `manual:${attempt}`, state: "sent", replay: true },
        nextSteps: [{ intent: "Attach the pane", command: `tmux attach -t mu-${ws}` }],
      });
    }
    const name = args.includes("--next-free") ? nextFree(String(args[2])) : String(args[2]);
    taken.add(name);
    const row = register(name);
    if (taskId) attempts.set(`${ws}/${taskId}/${attempt}`, { name, row });
    const base = {
      agent: { name, cwd: opts.workspace ?? null, ...row },
      ctl: opts.ctl ?? "ok",
      nextSteps: [{ intent: "Attach the pane", command: `tmux attach -t mu-scratch` }],
      ...(taskId
        ? { task: { id: taskId, attempt: `manual:${attempt}`, state: "sent", replay: false } }
        : {}),
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
  const run: MuRunner = (args, signal, stdin) => {
    calls.push([...args]);
    const [ns, verb, name] = args;
    if (ns === "delegates") return Promise.resolve(delegatesVerb(db, args, stdin));
    if (ns === "task") {
      const o = opts.task?.[verb ?? ""]?.(args);
      if (o) return o;
      if (verb === "show") {
        const ref = String(name);
        const [ws, local] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
        const wi = args.indexOf("-w");
        const workstreamName = ws ?? (wi >= 0 ? args[wi + 1] : "crew");
        // The task exists, as the real `task show` would have found it.
        if (local && workstreamName && !getTask(db, local, workstreamName))
          addTask(db, { workstream: workstreamName, localId: local, title: local });
        return Promise.resolve(ok({ task: { id: local, workstream: workstreamName } }));
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
      case "close": {
        // Read only without --if (the preview); a fenced apply with --if.
        const cur = registry.get(String(name));
        const ifAt = args.indexOf("--if");
        if (ifAt < 0) {
          if (!cur) return Promise.resolve(ok({ kind: "none", revision: 0, dryRun: true }));
          return Promise.resolve(ok({ kind: "agent", revision: cur.id * 7, dryRun: true, ...cur }));
        }
        if (!cur || Number(args[ifAt + 1]) !== cur.id * 7)
          return Promise.resolve(
            failed(4, "RevisionMismatchError", `agent ${String(name)} changed since preview`),
          );
        registry.delete(String(name));
        taken.delete(String(name));
        return Promise.resolve(ok({ agentName: name, killedPane: true, deletedRow: true }));
      }
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
  return { run, calls, waits, taken, registry, replace, db };
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
