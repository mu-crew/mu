// mu — the mux-free delegate runner: one child `pi --mode rpc` for one delegate
// call (docs/VOCABULARY.md § delegate call). No pane, no agents row, no daemon.
//
// `delegate_calls` and the call's task stay the authority; every state change
// goes through the src/delegates.ts writers. This file adds the process:
// identities derived from the call (agent name = the task id, ctl socket, log,
// session dir) and a machine-local attempt receipt under
// `<state dir>/delegate-process/<hash of call id>/`. The child is driven with
// the existing ctl client, never a second command transport.
//
// The prompt is sent ONCE, with a stable msgId and the incarnation the
// handshake saw. A failure before the send is a definite no: the child is
// stopped, the receipt removed, the call `refused` (reissuable). Once the send
// may have landed, an ambiguity finishes the call `unknown` with the evidence;
// nothing is respawned or resent. A receipt that is already there (an earlier
// attempt) is the same: `unknown`, never a second child.
// Nothing here imports src/cli.ts (the CLI wiring cycle).

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { delegateOutcome } from "./agents/delegate.js";
import { resolveCliCommand } from "./agents/spawn.js";
import {
  CtlDeliveryUnknownError,
  type CtlProbe,
  ctlProbe,
  ctlRequest,
  errCode,
} from "./ctl/client.js";
import { CTL_SOCK_ENV, ctlSocketPath } from "./ctl/path.js";
import { type Db, defaultStateDir } from "./db.js";
import {
  DelegateNotFoundError,
  type DelegateRow,
  DelegateStateError,
  finishDelegate,
  getDelegateCall,
  markDelegate,
  TERMINAL_DELEGATE_STATES,
} from "./delegates.js";
import { addWorktree, gitToplevel, headSha, owningRoot } from "./vcs/git.js";
import {
  getWorktreeAt,
  type ReleasedWorktree,
  reclaimWorktreePath,
  registerWorktree,
  releaseWorktree,
  worktreePath,
} from "./worktree.js";

/** Seconds to wait for an answer when the call names none (the extension's default). */
const DEFAULT_TIMEOUT_S = 3600;
const STOP_GRACE_MS = 3000;
const LOG_TAIL_BYTES = 2000;

export interface DelegateRunOptions {
  /** Aborting cancels: the child's turn is aborted and the call finishes `cancelled`. */
  signal?: AbortSignal;
  /** The mu pi extension to load. Default: the shipped dist/extension/mu-pi.js. */
  extension?: string;
  /** Budget for the child to serve its control socket. Default `MU_SPAWN_CTL_MS`, else 30 s. */
  startupMs?: number;
  /** Overrides the call's `keep`: false stops the child after the finish (the extension waits for the exit). */
  keep?: boolean;
}

export interface DelegateRunResult {
  callId: string;
  /** False: the call was already finished; nothing started. */
  ran: boolean;
  state: DelegateRow["state"];
  /** `done`, `empty`, `error`, `died`, `blocked`, `timeout`, `cancelled`, `unknown` (delivery), `refused` (nothing was sent). */
  outcome?: string;
  task: string;
  workstream: string;
  transport: "process";
  attach: null;
  pid?: number;
  logPath?: string;
  sessionFile?: string;
  sessionDir?: string;
  /** The call's own git worktree (`workspace: true`). */
  workspace?: string;
  /** What the close rule did with it; absent while the work is not clean and recorded. */
  worktree?: ReleasedWorktree | { kept: string };
  error?: string;
  /** The recorded answer, when `outcome` is `done`. */
  answer?: string;
  /** With `keep: true` after a clean finish: the live child. `stop()` closes its stdin, then its process group. */
  live?: { exited: Promise<void>; stop(): Promise<void> };
}

interface Receipt {
  runner: number;
  pid?: number;
  phase: "starting" | "spawned" | "sending" | "sent";
  msgId: string;
  incarnation?: string;
  runs?: number;
  sock: string;
  log: string;
  sessionDir: string;
  startedAt: string;
}

const sha = (s: string, n: number): string =>
  createHash("sha256").update(s).digest("hex").slice(0, n);

/** Every file of one call, derived from its id and the DB's directory. */
export function delegateProcessPaths(
  db: Db,
  row: Pick<DelegateRow, "callId" | "task" | "workstream">,
) {
  const base = dirname(db.name);
  const dir = join(base, "delegate-process", sha(row.callId, 16));
  return {
    dir,
    log: join(dir, "pi.log"),
    receipt: join(dir, "receipt.json"),
    sessionDir: join(dir, "session"),
    sock: ctlSocketPath(row.workstream, row.task, base),
  };
}

function shippedExtension(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [
    join(here, "extension", "mu-pi.js"),
    join(here, "..", "dist", "extension", "mu-pi.js"),
  ])
    if (existsSync(p)) return p;
  throw new Error(
    "the mu pi extension (dist/extension/mu-pi.js) is not built: run `npm run build`",
  );
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === "EPERM";
  }
};

function tail(path: string): string {
  try {
    return readFileSync(path, "utf8").slice(-LOG_TAIL_BYTES).trimEnd();
  } catch {
    return "";
  }
}

/** The call's own `git worktree`, through the same registry and close rule as an agent's. */
async function stageWorktree(db: Db, row: DelegateRow): Promise<string> {
  const path = worktreePath(row.workstream, row.task);
  const dir = resolve(row.request.cwd ?? process.cwd());
  const top = await gitToplevel(dir);
  if (top === undefined) throw new Error(`workspace: true needs a git repo, and ${dir} is not one`);
  const root = (await owningRoot(top)) ?? top;
  await reclaimWorktreePath(db, { agent: row.task, workstream: row.workstream, path });
  const base = await addWorktree(root, path, await headSha(top));
  const createdAt = new Date().toISOString();
  registerWorktree(db, {
    path,
    agent: row.task,
    workstream: row.workstream,
    root,
    base,
    createdAt,
  });
  return path;
}

async function releaseWorktreeAt(
  db: Db,
  path: string,
): Promise<ReleasedWorktree | { kept: string }> {
  try {
    const row = getWorktreeAt(db, path);
    return row ? await releaseWorktree(db, row) : { kept: "not registered" };
  } catch (e) {
    return { kept: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run a `queued` or `starting` call in a child pi and finish it durably: the
 * verdict, report and close are written (by `finishDelegate`) before the
 * child's stdin is closed. Outcomes are results, not throws; a throw is a
 * caller error: no such call, or one that is running, refused or held by a
 * live runner.
 */
export async function runDelegateProcess(
  db: Db,
  callId: string,
  opts: DelegateRunOptions = {},
): Promise<DelegateRunResult> {
  let row = getDelegateCall(db, callId);
  if (!row) throw new DelegateNotFoundError(callId);
  const call = row;
  const req = call.request;
  const p = delegateProcessPaths(db, call);
  const base = {
    callId,
    task: call.task,
    workstream: call.workstream,
    transport: "process" as const,
    attach: null,
  };
  if (TERMINAL_DELEGATE_STATES.includes(call.state))
    return { ...base, ran: false, state: call.state };
  if (call.state !== "queued" && call.state !== "starting")
    throw new DelegateStateError(callId, call.state, "run");
  row = call.state === "queued" ? markDelegate(db, callId, "starting") : call;

  const msgId = `mu-${sha(callId, 24)}`;
  const result = (outcome: string, extra: Partial<DelegateRunResult> = {}): DelegateRunResult => ({
    ...base,
    ran: true,
    outcome,
    state: getDelegateCall(db, callId)?.state ?? "failed",
    logPath: p.log,
    sessionDir: p.sessionDir,
    ...extra,
  });
  const unknown = (why: string): DelegateRunResult => {
    const text = `${why}. Not respawned, not resent. Receipt: ${p.receipt}. Log: ${p.log}`;
    finishDelegate(db, callId, { outcome: "unknown", text, author: call.caller });
    return result("unknown", { error: text });
  };

  // The receipt is created exclusively, before anything spawns.
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const write = (r: Partial<Receipt>): void => {
    const cur = existsSync(p.receipt)
      ? (JSON.parse(readFileSync(p.receipt, "utf8")) as Partial<Receipt>)
      : {};
    writeFileSync(`${p.receipt}.tmp`, JSON.stringify({ ...cur, ...r }));
    renameSync(`${p.receipt}.tmp`, p.receipt);
  };
  try {
    writeFileSync(
      p.receipt,
      JSON.stringify({
        runner: process.pid,
        phase: "starting",
        msgId,
        sock: p.sock,
        log: p.log,
        sessionDir: p.sessionDir,
        startedAt: new Date().toISOString(),
      } satisfies Receipt),
      { flag: "wx" },
    );
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
    const old = JSON.parse(readFileSync(p.receipt, "utf8")) as Partial<Receipt>;
    if (old.runner !== undefined && alive(old.runner))
      throw new DelegateStateError(callId, call.state, `run (runner pid ${old.runner} holds it)`);
    return unknown(`an earlier attempt of this call left a receipt (phase ${old.phase ?? "?"})`);
  }

  let child: ChildProcess | undefined;
  let gone = false;
  let exited: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  /** Close stdin (pi's clean shutdown); then TERM, then KILL, its own process group only. */
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      const c = child;
      if (!c || gone) return;
      c.stdin?.end();
      for (const sig of [undefined, "SIGTERM", "SIGKILL"] as const) {
        if (sig !== undefined && c.pid !== undefined)
          try {
            process.kill(-c.pid, sig);
          } catch {
            return;
          }
        await Promise.race([exited, delay(STOP_GRACE_MS)]);
        if (gone) return;
      }
    })();
    return stopping;
  };

  let workspace: string | undefined;
  /** A definite no (nothing was sent): stop, forget the attempt, park the call to be reissued. */
  const refuse = async (error: string): Promise<DelegateRunResult> => {
    await stop();
    rmSync(p.receipt, { force: true });
    const log = tail(p.log);
    const detail = log ? `${error}\n\nchild log tail:\n${log}` : error;
    try {
      markDelegate(db, callId, "refused", { error: detail });
    } catch {
      // the call moved on (finished by a cancel): its state is the answer
    }
    const wt = workspace ? await releaseWorktreeAt(db, workspace) : undefined;
    return result("refused", { error: detail, ...(wt ? { worktree: wt } : {}) });
  };
  const aborted = new Promise<"cancel">((res) => {
    if (opts.signal?.aborted) res("cancel");
    opts.signal?.addEventListener("abort", () => res("cancel"), { once: true });
  });
  /** Abort the child's turn, finish `cancelled`, stop it. */
  const cancel = async (why: string, sent: boolean): Promise<DelegateRunResult> => {
    if (sent) await ctlRequest(p.sock, { op: "abort" }, { timeoutMs: 2000 }).catch(() => {});
    finishDelegate(db, callId, { outcome: "cancelled", text: why, author: call.caller });
    await stop();
    return result("cancelled", child?.pid !== undefined ? { pid: child.pid } : {});
  };

  let sent = false;
  try {
    if (req.cli !== undefined && req.cli !== "pi")
      return await refuse(`mux-free delegates run pi only, not --cli ${req.cli}`);
    mkdirSync(dirname(p.sock), { recursive: true, mode: 0o700 });
    rmSync(p.sock, { force: true });
    if (req.workspace === true) workspace = await stageWorktree(db, call);
    const [cmd = "pi", ...cmdArgs] = resolveCliCommand("pi").trim().split(/\s+/);
    const logFd = openSync(p.log, "a");
    try {
      child = spawn(
        cmd,
        [
          ...cmdArgs,
          "--mode",
          "rpc",
          "--extension",
          opts.extension ?? shippedExtension(),
          "--session-dir",
          p.sessionDir,
          ...(req.model ? ["--model", req.model] : []),
        ],
        {
          cwd: workspace ?? resolve(req.cwd ?? process.cwd()),
          detached: true,
          stdio: ["pipe", logFd, logFd],
          env: {
            ...process.env,
            MU_MANAGED_AGENT: "1",
            MU_AGENT_NAME: call.task,
            MU_WORKSTREAM: call.workstream,
            [CTL_SOCK_ENV]: p.sock,
            MU_DB_PATH: resolve(db.name),
            MU_STATE_DIR: resolve(defaultStateDir()),
          },
        },
      );
    } finally {
      closeSync(logFd);
    }
    const c = child;
    const failed = await new Promise<Error | undefined>((res) => {
      c.once("error", res);
      c.once("spawn", () => res(undefined));
    });
    if (failed) return await refuse(`cannot start pi (${cmd}): ${failed.message}`);
    c.stdin?.on("error", () => {});
    exited = new Promise<void>((res) =>
      c.once("exit", () => {
        gone = true;
        res();
      }),
    );
    write({ pid: c.pid, phase: "spawned" });

    // It must serve its control socket: a trust prompt or a bad model never will.
    const budget = opts.startupMs ?? (Number(process.env.MU_SPAWN_CTL_MS) || 30_000);
    const until = Date.now() + budget;
    let probe: CtlProbe = { kind: "missing" };
    while (probe.kind !== "ok") {
      if (gone) return await refuse(`pi exited before serving its control socket`);
      if (opts.signal?.aborted) return await cancel("cancelled while it started", false);
      if (Date.now() > until)
        return await refuse(`pi did not serve its control socket within ${budget}ms`);
      probe = await ctlProbe(p.sock, 1000);
      if (probe.kind !== "ok") await delay(50);
    }
    const inc = probe.incarnation;
    if (inc === undefined || !probe.features?.includes("msgId"))
      return await refuse("the child's mu extension serves no msgId/incarnation: rebuild mu");

    // Send once. Past this write nothing is retried.
    write({ phase: "sending", incarnation: inc });
    sent = true;
    let runs = 0;
    try {
      const r = await ctlRequest(p.sock, {
        op: "send",
        text: req.text,
        msgId,
        expectIncarnation: inc,
      });
      if (!r.ok) {
        sent = false;
        return await refuse(`the child refused the prompt: ${r.error}`);
      }
      runs = r.runs ?? 0;
    } catch (e) {
      if (!(e instanceof CtlDeliveryUnknownError)) {
        sent = false;
        return await refuse(e instanceof Error ? e.message : String(e));
      }
      const q = await ctlRequest(p.sock, { op: "status", msgId }, { timeoutMs: 2000 }).catch(
        () => undefined,
      );
      if (!q?.ok || !q.msg?.accepted) {
        await stop();
        return unknown(`delivery unknown: ${e.message}`);
      }
      runs = q.msg.runs ?? 0;
    }
    write({ phase: "sent", runs });
    markDelegate(db, callId, "running", { agent: call.task });

    const t0 = Date.now();
    const waited = ctlRequest(p.sock, {
      op: "wait",
      afterRuns: runs,
      timeoutMs: (req.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000,
      returnOnBlocked: true,
      incarnation: inc,
    }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    const reply = await Promise.race([waited, aborted]);
    if (reply === "cancel") return await cancel("cancelled", true);

    const ok = reply instanceof Error || !reply.ok ? undefined : reply;
    const timedOut = !(reply instanceof Error) && !reply.ok && reply.error === "timeout";
    const outcome =
      ok?.ended === "blocked"
        ? "blocked"
        : delegateOutcome(
            {
              fired: ok?.ended === "settled",
              dead: ok === undefined && !timedOut && (reply instanceof Error || !reply.ok),
              lastText: ok?.lastText,
              lastError: ok?.lastError,
              blocked: undefined,
            },
            timedOut,
          );
    const sessionFile = ok?.sessionFile;
    const text =
      outcome === "done"
        ? (ok?.lastText ?? "")
        : [
            reply instanceof Error ? `error: ${reply.message}` : undefined,
            ok?.lastError ? `error: ${ok.lastError}` : undefined,
            sessionFile ? `Session: ${sessionFile}` : `Session dir: ${p.sessionDir}`,
            tail(p.log) ? `Child log tail (${p.log}):\n${tail(p.log)}` : undefined,
          ]
            .filter((v) => v !== undefined)
            .join("\n\n");
    const fin = finishDelegate(db, callId, {
      outcome,
      text,
      elapsedMs: Date.now() - t0,
      author: call.task,
    });
    const info: Partial<DelegateRunResult> = {
      ...(c.pid !== undefined ? { pid: c.pid } : {}),
      ...(sessionFile ? { sessionFile } : {}),
      ...(workspace ? { workspace } : {}),
      ...(fin.error ? { error: fin.error } : {}),
      ...(outcome === "done" ? { answer: text } : {}),
    };
    const clean = fin.state === "done";
    if (clean && (opts.keep ?? req.keep) === true)
      return result(outcome, { ...info, live: { exited, stop } });
    // Durable first; only now does the child lose its stdin. A failed or
    // timed-out run keeps its log, session and worktree as evidence, not a process.
    if (!clean) await ctlRequest(p.sock, { op: "abort" }, { timeoutMs: 2000 }).catch(() => {});
    await stop();
    const wt = clean && workspace ? await releaseWorktreeAt(db, workspace) : undefined;
    return result(outcome, { ...info, ...(wt ? { worktree: wt } : {}) });
  } catch (e) {
    // A bug or a full disk: never leave the call starting or a child running.
    await stop();
    const msg = e instanceof Error ? e.message : String(e);
    if (!sent) return await refuse(msg);
    finishDelegate(db, callId, { outcome: "error", text: msg, author: call.caller });
    return result("error", { error: msg });
  }
}
