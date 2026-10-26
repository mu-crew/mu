/**
 * mu pi extension, parent side: the `mu_delegate` tool.
 *
 * A delegate is a scratch agent started for one task. The tool spawns it,
 * hands it the task and returns at once. When the delegate's run settles its
 * answer is recorded (`mu delegates finish`: verdict note, report, close) and
 * the parent's settle wait shows it to the model (nudge.ts). The one identity
 * is the call id; the pi message this side sends is only a WAKE, a one-line
 * pointer that starts a turn when pi is idle and nothing else will. Losing or
 * repeating a wake loses or repeats no answer.
 *
 * Everything is the `mu` CLI (spawn / send / wait --json / read / abort /
 * close): the tool only orders the calls and formats the result, so a
 * shell gets the same delegation (VISION § 1, rule 2). With no multiplexer
 * the spawn fails NoMultiplexerError and the call runs as a child pi under
 * `mu delegates run <call-id>` instead (src/delegate-process.ts). The one
 * thing only an extension can do is the callback into the parent
 * conversation, and that is presentation. No extension-only state: the
 * in-flight set below is the list of `mu agent wait` children this pi owns.
 *
 * Separate from the child side (the control-socket server in mu-pi.ts):
 * that one serves a pi mu spawned; this one runs in a pi that is not.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { qualifiedRefProblem, workstreamNameProblem } from "../src/workstream-scope.js";
import { labelStem, modelCommand, normalizeModel } from "./delegate-args.js";
import { type CallInfo, callsApi, type FinishResult, type RecordTarget } from "./delegate-calls.js";
import {
  DELEGATE_TIMEOUT_S,
  DELEGATE_WORKSTREAM,
  type DroppedWake,
  delegateMessage,
  droppedNote,
  evidenceLines,
  lastAssistantTextIn,
  type MessageExtras,
  type PaneFate,
  type WaitAgent,
  type WakeAnswer,
  wakeText,
} from "./delegate-format.js";
import { type ProcessRun, processFailedText, processStarted } from "./delegate-process-format.js";
import { delegateTraceOn, TRACE_EVENTS, trace, traceFields } from "./delegate-trace.js";
import {
  defaultRunner,
  type MuResult,
  type MuRunner,
  parseEnvelope,
  parseOkEnvelope,
} from "./mu-run.js";

export { recordNote } from "../src/delegate-verdict.js";
export { labelStem, modelCommand, normalizeModel } from "./delegate-args.js";
export {
  DELEGATE_TIMEOUT_S,
  DELEGATE_WORKSTREAM,
  type DroppedWake,
  delegateMessage,
  droppedNote,
  formatElapsed,
  lastAssistantTextIn,
  type MessageExtras,
  type PaneFate,
  type WaitAgent,
  type WakeAnswer,
  wakeText,
} from "./delegate-format.js";
export { delegateTraceOn, delegateTracePath } from "./delegate-trace.js";
export {
  defaultRunner,
  type MuResult,
  type MuRunner,
  parseEnvelope,
  parseOkEnvelope,
} from "./mu-run.js";

/** The slice of pi's ExtensionAPI the delegate side uses. */
export interface MuDelegateApi {
  registerTool(tool: DelegateTool): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void | Promise<void>;
  on(event: string, handler: (event: unknown, ctx: DelegateCtx) => unknown): unknown;
  /** pi's in-process bus between extensions. */
  events: { emit(channel: string, data: unknown): void };
}

/** The slice of pi's ExtensionContext the delegate side uses. */
export interface DelegateCtx {
  hasUI?: boolean;
  cwd?: string;
  isIdle?(): boolean;
  hasPendingMessages?(): boolean;
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    /** Raw terminal input, non-consuming here (the settle wait's Esc). */
    onTerminalInput?(handler: (data: string) => undefined): () => void;
  };
}

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

export interface DelegateTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: object;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: DelegateCtx,
  ): Promise<ToolResult>;
}

export const DELEGATE_TOOL = "mu_delegate";
export const DELEGATE_CANCEL_TOOL = "mu_delegate_cancel";
export const DELEGATE_REISSUE_TOOL = "mu_delegate_reissue";
export const DELEGATE_MESSAGE_TYPE = "mu-delegate";
/**
 * murmur's channel for outstanding background work, as
 * `{ source, count }`. murmur shows the count on this agent's card,
 * renders a stopped agent with work out as `waiting`, and holds back
 * `done` until it is zero: a parent that ended its turn to wait on
 * delegates has not finished. A string, not an import: neither side
 * depends on the other, and with no murmur loaded nobody listens.
 */
export const PENDING_CHANNEL = "murmur:pending";

/** Default cap on delegates in flight from one pi session. */
export const DELEGATE_MAX_DEFAULT = 16;
/** The queue holds this many caps' worth of calls waiting for a slot. A
 *  fan-out (refuters per finding, checkers per claim) issues several
 *  caps' worth in one turn; past this, the model is refused. */
export const DELEGATE_QUEUE_FACTOR = 4;

/** `MU_DELEGATE_MAX`: a positive integer, else the default. */
export function delegateMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MU_DELEGATE_MAX);
  return Number.isInteger(n) && n > 0 ? n : DELEGATE_MAX_DEFAULT;
}
const W = DELEGATE_WORKSTREAM;

/** Registration guards: an unmanaged pi, not switched off. No mux needed:
 *  without one a delegate runs as a child pi process (`mu delegates run`). */
export function delegateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MU_MANAGED_AGENT) return false; // no helper-spawns-helper
  return env.MU_DELEGATE !== "0";
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Which agent a delegate spawned as: the registry incarnation and pane the
 *  spawn reported. A close acts on that one only, never on a replacement
 *  that took the name since. */
export type DelegateIdentity = { paneId: string; incarnation: number };

/**
 * One delegate this pi waits on. `cancelling` is set while a cancel's abort
 * is in flight: the abort itself settles the run, so a wait resolving then
 * is parked in `parked` instead of delivered, and delivered after all if
 * the abort fails.
 */
type Inflight = {
  abort: AbortController;
  call: CallInfo;
  /** The delegate's pi session file, reported by the spawn's send. */
  sessionFile?: string;
  /** What it spawned as; closing is bound to it. */
  identity?: DelegateIdentity;
  cancelling: boolean;
  parked?: () => Promise<void>;
  /** Mux-free: the `mu delegates run` of a child pi, no pane. Aborting
   *  `abort` SIGTERMs it, which cancels the call durably before it exits. */
  process?: Promise<MuResult>;
};

/** A call past the cap, waiting for a slot. Its delegate name is picked
 *  at spawn, so the queue also hands out a handle (`queued-3`); the call
 *  id works as well. `registered` settles once its row is durable. */
type Queued = {
  handle: string;
  call: CallInfo;
  ctx: DelegateCtx | undefined;
  /** Settles once the call's row is durable. */
  registered: Promise<unknown>;
};

/** The pi session id of a ctx whose sessionManager exposes it (a stale ctx throws). */
function piSessionId(ctx: DelegateCtx | undefined): string | undefined {
  try {
    const sm = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
      ?.sessionManager;
    return sm?.getSessionId?.();
  } catch {
    return undefined;
  }
}

/** What the rest of the extension may ask the delegate side. */
export interface DelegateHandle {
  /** A wake is being delivered or waits in pi's follow-up queue: its own turn
   *  runs the settle wait. pi's hasPendingMessages() does not count custom
   *  follow-ups, so this is the only signal. */
  answerPending(): boolean;
  /** The settle showed these answers (call ids), or found nothing owed by a wait
   *  started at epoch ms `before`: no wake is owed for them. */
  delivered(shown: readonly string[] | { before: number }): void;
}

export function registerDelegate(
  pi: MuDelegateApi,
  run: MuRunner = defaultRunner(),
): DelegateHandle {
  if (!delegateEnabled()) return { answerPending: () => false, delivered: () => {} };
  if (delegateTraceOn())
    for (const ev of TRACE_EVENTS)
      pi.on(ev, (e, ctx) => {
        trace(ev, traceFields(e, ctx));
      });
  /** pi.sendMessage, traced: the call, its options, and how it returned. */
  const send = (
    message: Parameters<MuDelegateApi["sendMessage"]>[0],
    options: Parameters<MuDelegateApi["sendMessage"]>[1],
    why: string,
  ): void | Promise<void> => {
    const d = message.details as { wake?: unknown; calls?: unknown } | undefined;
    const a = typeof d?.wake === "number" ? arriving.get(d.wake) : undefined;
    if (a && options) {
      options = { ...options };
      a.message = message;
      a.opts = [...(a.opts ?? []), options];
    }
    const at = { why, wake: d?.wake, calls: d?.calls, ...options };
    trace("sendMessage", { ...at, arriving: arriving.size });
    try {
      const r = pi.sendMessage(message, options);
      trace("sendMessage.returned", { ...at, async: r !== undefined });
      return r;
    } catch (e) {
      trace("sendMessage.threw", { ...at, error: String(e) });
      throw e;
    }
  };
  const inflight = new Map<string, Inflight>();
  /** Calls past the cap check whose delegate is not yet in `inflight`. */
  let starting = 0;
  /** Calls past the cap, FIFO, at most `DELEGATE_QUEUE_FACTOR * delegateMax()` long. */
  const queue: Queued[] = [];
  let queueSeq = 0;
  /** Answers recorded here that no settle has shown yet and no wake has
   *  carried into the conversation, by call id. */
  const owed = new Map<string, WakeAnswer & { at: number }>();
  /** Wakes that have not entered the conversation: being delivered, or queued
   *  behind a running turn. Keyed by a per-wake id carried in the message's
   *  details, cleared on its message_start. `sent`: pi.sendMessage returned (pi
   *  accepted it, which says nothing about where it sits). */
  const arriving = new Map<
    number,
    {
      sent: boolean;
      calls: string[];
      /** The wake as sent, to send again if pi's queue loses it. */
      message?: Parameters<MuDelegateApi["sendMessage"]>[0];
      /** Sent again after pi lost it; one more loss drops it. */
      resent?: boolean;
      /** Every options object handed to pi for it: pi reads one lazily when it
       *  runs a send it deferred, so a dropped wake is defused through them. */
      opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }[];
    }
  >();
  let wakeSeq = 0;
  /** A pi run is active (agent_start .. agent_settled): its settle will look. */
  let busy = false;
  let settleCheck: ReturnType<typeof setImmediate> | undefined;
  let closed = false;
  let lastPending = 0;
  /** Running, starting and queued: every delegate whose answer is still
   *  to come back here. Failed panes have answered, so they do not count. */
  const reportPending = () => {
    const count = inflight.size + starting + queue.length;
    if (count === lastPending) return;
    lastPending = count;
    try {
      pi.events.emit(PENDING_CHANNEL, { source: DELEGATE_TOOL, count });
    } catch {
      // a listener's fault must not cost a delegate its answer
    }
  };
  /** Wake pi for every owed answer no wake covers yet: ONE message, a pointer per
   *  answer; its turn's settle delivers the reports. */
  const wake = (why: string) => {
    const covered = new Set([...arriving.values()].flatMap((a) => a.calls));
    const due = [...owed.values()].filter((a) => !covered.has(a.callId));
    if (due.length === 0 || closed) return;
    const id = ++wakeSeq;
    const ids = due.map((a) => a.callId);
    arriving.set(id, { sent: false, calls: ids });
    void Promise.resolve(
      send(
        {
          customType: DELEGATE_MESSAGE_TYPE,
          content: wakeText(due),
          display: true,
          details: { wake: id, calls: ids },
        },
        { deliverAs: "followUp", triggerTurn: true },
        why,
      ),
    ).then(
      () => {
        const a = arriving.get(id);
        if (a) a.sent = true;
      },
      () => arriving.delete(id), // nothing will arrive; the next settle looks again
    );
  };
  let wakeSoon: ReturnType<typeof setImmediate> | undefined;
  /** An answer recorded while pi is idle: nothing will settle and show it, so
   *  wake now (batched: answers recorded in one tick share one wake). */
  const wakeIfIdle = () => {
    if (wakeSoon !== undefined) return;
    wakeSoon = setImmediate(() => {
      wakeSoon = undefined;
      if (!busy) wake("wake");
    });
  };
  const calls = callsApi(run);
  /** Per runtime: two reloads of one session never reuse a call id. */
  const token = randomBytes(3).toString("hex");
  let callSeq = 0;
  const inflightKey = (ws: string, name: string) => `${ws}/${name}`;
  /** Drop a delegate from the in-flight set, start the next queued call
   *  into the freed slot. */
  const forget = (key: string) => {
    inflight.delete(key);
    drain();
    reportPending();
  };
  /** A start that failed after its tool call returned, said as a follow-up. */
  const startFailed = (handle: string, e: unknown, what = "Queued delegate") =>
    void Promise.resolve(
      send(
        {
          customType: DELEGATE_MESSAGE_TYPE,
          content: `${what} ${handle} could not start: ${e instanceof Error ? e.message : String(e)}`,
          display: true,
          details: { name: handle, workstream: W, outcome: null, closed: false },
        },
        { deliverAs: "followUp", triggerTurn: true },
        "start-failed",
      ),
    ).catch(() => {});
  /** Start queued calls while there is a free slot. A queued call's tool
   *  call has already returned, so a failed start becomes a follow-up. */
  function drain(): void {
    while (queue.length > 0 && inflight.size + starting < delegateMax()) {
      const q = queue.shift();
      if (!q) break;
      starting++; // held until start() takes over the slot
      void q.registered
        .then(async () => {
          try {
            await calls.mark(q.call.callId, "starting");
          } catch (e) {
            starting--; // start() never ran: its finally would have freed the slot
            reportPending();
            throw e;
          }
          return start(q.call, undefined, q.ctx, q.handle);
        })
        .then(
          () => {},
          (e: unknown) => {
            startFailed(q.handle, e);
            drain();
          },
        );
    }
  }

  const mu = run;
  // mu prints ONE envelope: `{ok:true,data,next}` or `{ok:false,error,message,
  // next,exit,data?}`. A success yields its `data`; a failure yields its
  // partial `data` (a spawn whose --send failed) plus `error` and `message`.
  const json = (r: MuResult): Record<string, unknown> | undefined => parseEnvelope(r.stdout);
  /** One line on why a call failed: the envelope's message, else the raw text. */
  const why = (r: MuResult): string => {
    const m = json(r)?.message;
    return (typeof m === "string" ? m : r.stderr || r.stdout).trim();
  };
  const failure = (what: string, r: MuResult) =>
    new Error(`${what} failed (exit ${r.code}): ${why(r)}`);
  /** The words for a failed `mu delegates` write. */
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /**
   * Close a delegate's pane, bound to the agent it spawned as. `agent close`
   * only previews until it gets `--if <revision>`, so: preview, check that
   * the preview is a success envelope for THIS pane and incarnation with a
   * safe-integer revision, then apply once with that revision. Anything
   * else (no identity, a failed or malformed preview, another incarnation
   * under the name, a stale revision) keeps the pane and says why. It never
   * previews again and never retries onto a replacement.
   */
  async function closeDelegate(
    name: string,
    id: DelegateIdentity | undefined,
    W: string,
  ): Promise<PaneFate> {
    if (id === undefined) return { closed: false, why: "its spawn did not report an identity" };
    const p = await mu(["agent", "close", name, "-w", W, "--json"]);
    const d = p.code === 0 ? parseOkEnvelope(p.stdout) : undefined;
    if (d === undefined) return { closed: false, why: `close preview failed: ${why(p)}` };
    if (d.kind === "none") return { closed: false, why: "it is no longer registered" };
    if (d.kind !== "agent" || d.id !== id.incarnation || d.pane_id !== id.paneId)
      return { closed: false, why: "the name now belongs to another agent" };
    if (!Number.isSafeInteger(d.revision))
      return { closed: false, why: "close preview had no revision" };
    const c = await mu(["agent", "close", name, "-w", W, "--if", String(d.revision), "--json"]);
    return c.code === 0 ? { closed: true } : { closed: false, why: `close refused: ${why(c)}` };
  }

  /** A spawn that failed. `unsent`: nothing was written to a pane, so the call
   *  stays reissuable (refused). `kept`: a pane may be running; it is evidence. */
  class SpawnFail extends Error {
    constructor(
      message: string,
      readonly kind: "unsent" | "kept" | "unknown" | "aborted" | "refused" | "nomux",
    ) {
      super(message);
    }
  }

  /**
   * Spawn the delegate bound to its task and send it the prompt in ONE mu call
   * (`spawn --next-free --task <delegate task> --attempt <task> --send`): mu
   * picks the free name under its spawn lock, claims the task for the new
   * agent and journals the delivery, so a replay never sends twice. Returns
   * the name and the send's `runs`, the exact wait baseline.
   */
  async function spawn(
    call: CallInfo,
    text: string,
    cwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<{
    name: string;
    runs: number;
    attach?: string;
    workspace?: string;
    sessionFile?: string;
    identity?: DelegateIdentity;
  }> {
    if (signal?.aborted) throw new SpawnFail("cancelled before it spawned", "aborted");
    const ws = call.workstream;
    const req = call.request;
    const stem = labelStem(req.label);
    // A label names the delegate (delegate-review, then delegate-review-2);
    // without one it is numbered (delegate-1, delegate-2).
    const base = stem ? `delegate-${stem}` : "delegate-1";
    const args = [
      "agent",
      "spawn",
      base,
      "-w",
      ws,
      "--next-free",
      "--task",
      call.task,
      "--attempt",
      call.task,
      "--send",
      text,
      "--json",
    ];
    // With a workspace, cwd names the git repo the worktree is made from.
    if (req.workspace === true) args.push("--worktree", ...(req.cwd ? ["--root", req.cwd] : []));
    else if (cwd) args.push("--cwd", cwd);
    const cli = req.cli ? req.cli : undefined;
    if (cli) args.push("--cli", cli);
    if (req.model) args.push("--command", modelCommand(cli ?? "pi", req.model));
    // An abort SIGTERMs the spawn, which rolls itself back; the runner returns once it exited.
    const r = await mu(args, signal);
    const out = json(r);
    const stale = (out?.task as { stale?: unknown } | undefined)?.stale;
    if (typeof stale === "string")
      throw new SpawnFail(
        `the attempt of ${ws}/${call.task} is stale: its agent was ${stale}; the replacement was left alone`,
        "unsent",
      );
    const spawned = (out?.agent as { name?: unknown } | undefined)?.name;
    // No multiplexer, nothing spawned: start() runs it as a child pi instead.
    // Only this error: any other failure is not a licence to start it twice.
    if (typeof spawned !== "string" && out?.error === "NoMultiplexerError")
      throw new SpawnFail("no multiplexer", "nomux");
    // No agent in the reply: the spawn itself failed, nothing is up.
    if (typeof spawned !== "string" && signal?.aborted)
      throw new SpawnFail("cancelled while it spawned; the spawn rolled back", "aborted");
    if (typeof spawned !== "string") {
      const msg = failure("mu agent spawn", r).message;
      // A refusal that fails the same on every reissue is final, not 'reissue'.
      if (out?.error === "WorktreeVcsRequiredError")
        throw new SpawnFail(`${msg}. Pass cwd: <a git repo>`, "refused");
      throw new SpawnFail(msg, out?.error === "UsageError" ? "refused" : "unsent");
    }
    const name = spawned;
    // The agent record's SQL keys: `id` is the registry incarnation.
    const row = out?.agent as { pane_id?: unknown; id?: unknown; cwd?: unknown } | undefined;
    const identity: DelegateIdentity | undefined =
      typeof row?.pane_id === "string" && Number.isSafeInteger(row.id)
        ? { paneId: row.pane_id, incarnation: row.id as number }
        : undefined;
    if (signal?.aborted) {
      // The user cancelled while the pane came up: take it down again.
      await closeDelegate(name, identity, ws);
      throw new SpawnFail("cancelled while it spawned", "aborted");
    }
    // A fresh spawn reports its control socket; a replay answers from the
    // journal and carries none (the send below is the proof).
    if (out?.ctl !== undefined && out.ctl !== "ok") {
      throw new SpawnFail(
        `${ws}/${name} spawned but its control socket is ${String(out.ctl)}, so its answer cannot come back. Pane kept; close it with: mu agent close ${name} -w ${ws}`,
        "kept",
      );
    }
    const sent = out?.send as
      | { ok?: unknown; error?: unknown; runs?: unknown; message?: unknown; sessionFile?: unknown }
      | undefined;
    if (sent?.ok !== true && sent?.error === "AgentSendIndeterminateError") {
      // The prompt may already be running: keep the pane, never auto-retry.
      const reason = typeof sent.message === "string" ? sent.message : "no reply";
      throw new SpawnFail(
        `mu agent send to ${ws}/${name}: delivery unknown (${reason}). Pane kept; do NOT resend blindly. Check with: mu agent read ${name} -w ${ws} -n 20 (or attach), then close it with: mu agent close ${name} -w ${ws}`,
        "unknown",
      );
    }
    if (sent?.ok !== true) {
      // Nothing reached it: the pane is just an idle pi. Take it down.
      const c = await closeDelegate(name, identity, ws);
      const pane = c.closed
        ? "Pane closed."
        : `Pane kept (${c.why}); close it with: mu agent close ${name} -w ${ws}`;
      const reason = typeof sent?.message === "string" ? sent.message : why(r);
      throw new SpawnFail(
        `mu agent send to ${ws}/${name} failed (exit ${r.code}): ${reason}. ${pane}`,
        "unsent",
      );
    }
    const attach: unknown = out?.attach;
    // The worktree is the agent's cwd (`agents.cwd`).
    const wsPath = req.workspace === true ? (row as { cwd?: unknown } | undefined)?.cwd : undefined;
    return {
      name,
      // A pi just spawned has settled no run, so 0 is exact when an older
      // extension's reply carries no runs.
      runs: typeof sent.runs === "number" ? sent.runs : 0,
      ...(identity ? { identity } : {}),
      ...(typeof attach === "string" ? { attach } : {}),
      ...(typeof wsPath === "string" ? { workspace: wsPath } : {}),
      ...(typeof sent.sessionFile === "string" ? { sessionFile: sent.sessionFile } : {}),
    };
  }

  /** Check `record` names a real task, before anything spawns. */
  async function resolveRecord(raw: unknown): Promise<RecordTarget | undefined> {
    if (raw === undefined) return undefined;
    const r = raw as { task?: unknown; workstream?: unknown } | null;
    const task = typeof r?.task === "string" ? r.task : "";
    if (task.trim() === "") throw new Error("mu_delegate: record.task must name a task");
    // The one validator (never trims): an empty, blank or padded scope is an
    // error here, as it is at the CLI, never another valid workstream.
    const scope = (value: string, what: string): string => {
      const problem = workstreamNameProblem(value, what);
      if (problem !== undefined) throw new Error(`mu_delegate: ${problem} Nothing spawned.`);
      return value;
    };
    const rawWs = r?.workstream;
    const ws =
      rawWs === undefined || rawWs === null
        ? ""
        : scope(typeof rawWs === "string" ? rawWs : String(rawWs), "record.workstream");
    const slash = task.indexOf("/");
    if (slash >= 0) {
      const refProblem = qualifiedRefProblem(task);
      if (refProblem !== undefined) throw new Error(`mu_delegate: ${refProblem} Nothing spawned.`);
      const prefix = task.slice(0, slash);
      if (ws && ws !== prefix) {
        throw new Error(
          `mu_delegate: record.task ${task} conflicts with record.workstream ${ws}. Nothing spawned.`,
        );
      }
    }
    if (task !== task.trim()) {
      throw new Error(
        `mu_delegate: record.task ${JSON.stringify(task)} has surrounding whitespace. Nothing spawned.`,
      );
    }
    // Scope is explicit: <ws>/<task> or record.workstream. mu has no ambient
    // default, so refuse here, before anything spawns, rather than let `task
    // show` guess or fail after the fact.
    if (!ws && slash < 0) {
      throw new Error(
        `mu_delegate: record.task ${task} needs a workstream: pass record.task as <workstream>/${task}, or set record.workstream. Nothing spawned.`,
      );
    }
    const shown = await mu(["task", "show", task, ...(ws ? ["-w", ws] : []), "--json"]);
    const out = json(shown);
    // `show` names the task by `id` (its local_id) and its workstream by `workstream`.
    const t = out?.task as { id?: unknown; workstream?: unknown } | undefined;
    if (shown.code !== 0 || typeof t?.id !== "string" || typeof t.workstream !== "string") {
      throw new Error(
        `mu_delegate: record task ${ws ? `${ws}/` : ""}${task} not found (exit ${shown.code}): ${why(shown)}. Nothing spawned.`,
      );
    }
    return { workstream: t.workstream, task: t.id };
  }

  /** The follow-up's line about where the answer is durable (a failed record only). */
  const recordedLine = (call: CallInfo, err: string): string =>
    `Recording failed: ${err}. The call ${call.callId} is still open; its answer is in this message. Record it yourself.`;

  /**
   * Record one finished wait, then let the settle show it. The result is made
   * durable FIRST: the verdict on the judged task, then the delegate's report
   * and close, in one op group (`mu delegates finish`). A run with no final
   * answer records what the follow-up used to say (outcome, error, what to do,
   * session, partial text, pane tail). Only a `done` call may then lose its
   * pane. A record that failed leaves nothing for a wait to find: that answer
   * alone is sent whole, as a follow-up.
   */
  async function deliver(
    call: CallInfo,
    name: string,
    wait: MuResult,
    keep: boolean,
    extras: MessageExtras,
    identity?: DelegateIdentity,
  ) {
    const ws = call.workstream;
    const agent = (json(wait)?.agents as WaitAgent[] | undefined)?.[0];
    const outcome = agent?.outcome;
    const tail =
      outcome === "done" || outcome === "timeout" || outcome === "pending" || outcome === "error"
        ? undefined
        : (await mu(["agent", "read", name, "-n", "50", "-w", ws])).stdout;
    const sessionFile = agent?.sessionFile ?? extras.sessionFile;
    const x: MessageExtras = {
      ...extras,
      workstream: ws,
      ...(sessionFile ? { sessionFile } : {}),
      ...(tail ? { tail } : {}),
    };
    // A blocked run is mid-flight: no partial text, which could read as its answer.
    const partial =
      outcome !== "done" && outcome !== "blocked" && sessionFile
        ? lastAssistantTextIn(sessionFile)
        : undefined;
    // What a gap records: its own wording (the pane is kept for every outcome but
    // empty, and the pane line is the only difference), plus what it wrote so far.
    const kept: PaneFate = {
      closed: false,
      why: outcome === "blocked" ? "waiting on a dialog" : "kept as evidence",
    };
    const gap = () =>
      [
        delegateMessage(
          name,
          agent,
          outcome === "empty" ? ({ closed: !keep } as PaneFate) : kept,
          x,
        ),
        partial ? `Partial answer so far:\n${partial}` : undefined,
      ]
        .filter((v) => v !== undefined)
        .join("\n\n");
    let fin: FinishResult | undefined;
    let finErr = "unknown error";
    try {
      fin = await calls.finish(call.callId, {
        outcome: outcome ?? "no result",
        text: outcome === "done" ? (agent?.lastText ?? "") : gap(),
        ...(extras.elapsedMs !== undefined ? { elapsedMs: extras.elapsedMs } : {}),
        author: name,
      });
    } catch (e) {
      finErr = errText(e);
    }
    // Close only after a clean finish that is on record: a died or timed-out
    // pane, or one whose record failed, is evidence.
    let pane: PaneFate = { closed: false, why: "keep: true" };
    if (outcome === "blocked") pane = kept;
    else if (outcome !== "done" && outcome !== "empty") pane = kept;
    else if (fin?.state !== "done" && outcome === "done")
      pane = { closed: false, why: "its result is not recorded" };
    else if (!keep) pane = await closeDelegate(name, identity, ws);
    if (fin === undefined) {
      // Nothing durable for the settle to show: the whole answer, once, here.
      await send(
        {
          customType: DELEGATE_MESSAGE_TYPE,
          content: `${delegateMessage(name, agent, pane, x)}\n\n${recordedLine(call, finErr)}`,
          display: true,
          details: { name, workstream: ws, call_id: call.callId, outcome: outcome ?? null },
        },
        { deliverAs: "followUp", triggerTurn: true },
        "unrecorded",
      );
      return;
    }
    owed.set(call.callId, {
      callId: call.callId,
      name,
      workstream: ws,
      task: call.task,
      // A failed record says so (the answer is kept as the report): record it yourself.
      outcome:
        fin.state === "failed" && fin.error
          ? `${outcome ?? "no result"}, NOT recorded: ${fin.error}`
          : (outcome ?? "no result"),
      ...(fin.verdict ? { verdict: fin.verdict } : {}),
      ...(call.record && fin.recorded
        ? { record: `${call.record.workstream}/${call.record.task}` }
        : {}),
      ...(pane.closed ? {} : { kept: pane.why }),
      at: Date.now(),
    });
    wakeIfIdle();
  }

  /** Spawn, send, and watch one registered call. The caller holds one
   *  `starting` slot and has already moved the call to `starting`; the slot
   *  is released once the delegate is in `inflight` (or on failure). A
   *  failure is made durable here: nothing sent leaves the call refused
   *  (reissuable), a pane that may be running fails it with the pane kept.
   *  Returns the tool result. */
  async function start(
    call: CallInfo,
    signal: AbortSignal | undefined,
    ctx: DelegateCtx | undefined,
    queuedAs?: string,
  ): Promise<ToolResult> {
    let slotHeld = true;
    const freeSlot = () => {
      if (slotHeld) {
        starting--;
        reportPending();
      }
      slotHeld = false;
    };
    reportPending(); // the count moves at once, before the pane exists
    const ws = call.workstream;
    const req = call.request;
    try {
      const keep = req.keep === true;
      const timeoutS = req.timeoutS ?? DELEGATE_TIMEOUT_S;
      // Without --cwd the pane inherits the mux session's start dir (wherever
      // the FIRST scratch spawn ran), and a missing dir silently becomes
      // $HOME: pin it to the caller's and check it exists.
      let cwd: string | undefined;
      if (req.workspace !== true) {
        cwd = req.cwd ? req.cwd : (ctx?.cwd ?? process.cwd());
        if (!isDir(cwd))
          throw new SpawnFail(`mu_delegate: cwd ${cwd} is not a directory`, "unsent");
      }
      let spawned: Awaited<ReturnType<typeof spawn>>;
      try {
        spawned = await spawn(call, req.text, cwd, signal);
      } catch (e) {
        if (e instanceof SpawnFail && e.kind === "nomux") {
          freeSlot(); // startProcess counts it in inflight at once
          return startProcess(call);
        }
        const fail = e instanceof SpawnFail ? e : new SpawnFail(errText(e), "unsent");
        await settleFailedStart(call, fail);
        throw new Error(
          fail.kind === "unsent"
            ? `${fail.message}. The call is durable and refused: reissue it with ${DELEGATE_REISSUE_TOOL} { call_id: "${call.callId}" } (task ${ws}/${call.task}).`
            : `${fail.message}. Recorded on ${ws}/${call.task} as failed.`,
        );
      }
      const { name, runs, attach, workspace, sessionFile, identity } = spawned;
      const key = inflightKey(ws, name);
      const entry: Inflight = {
        abort: new AbortController(),
        call,
        cancelling: false,
        ...(sessionFile ? { sessionFile } : {}),
        ...(identity ? { identity } : {}),
      };
      inflight.set(key, entry);
      freeSlot(); // now counted in inflight
      reportPending();
      await calls.mark(call.callId, "running", { agent: name }).catch((e) => {
        trace("mark.running.failed", { call: call.callId, error: errText(e) });
      });
      const started = Date.now();
      // The send's `runs` is pi's count before this prompt: waiting past it
      // catches the run even if it settled before this wait started.
      const waiting = mu(
        [
          "agent",
          "wait",
          name,
          "-w",
          ws,
          "--json",
          "--timeout",
          String(timeoutS),
          "--after-runs",
          String(runs),
        ],
        entry.abort.signal,
      );
      const settle = async (r: MuResult) => {
        trace("settle", { call: call.callId, name, code: r.code });
        forget(key);
        try {
          await deliver(
            call,
            name,
            r,
            keep,
            {
              timeoutS,
              elapsedMs: Date.now() - started,
              ...(queuedAs ? { queuedAs } : {}),
              ...(attach ? { attach } : {}),
              ...(workspace ? { workspace } : {}),
              ...(entry.sessionFile ? { sessionFile: entry.sessionFile } : {}),
            },
            entry.identity,
          );
        } catch (e) {
          // A throw here would be an unhandled rejection and a lost answer.
          const content = `Delegate ${ws}/${name} settled, but delivering its answer failed: ${e instanceof Error ? e.message : String(e)}. Read it with: mu agent read ${name} -n 50 -w ${ws}`;
          await Promise.resolve(
            send(
              {
                customType: DELEGATE_MESSAGE_TYPE,
                content,
                display: true,
                details: { name, workstream: ws, outcome: null, closed: false },
              },
              { deliverAs: "followUp", triggerTurn: true },
              "deliver-failed",
            ),
          ).catch(() => {});
        }
      };
      void waiting.then(async (r) => {
        if (inflight.get(key) !== entry) return; // cancelled or shut down
        if (entry.cancelling) entry.parked = () => settle(r);
        else await settle(r);
      });
      const lines = [
        `Delegated to ${ws}/${name} (task ${ws}/${call.task}, call ${call.callId}). Its answer arrives with your next settle (and stays on the task: mu task notes ${call.task} -w ${ws}); carry on, or end your turn if your next step needs it. Do not poll.`,
        workspace ? `Workspace: ${workspace}` : undefined,
        attach ? `Attach: ${attach}` : undefined,
        `Cancel: ${DELEGATE_CANCEL_TOOL} { name: "${name}" }`,
      ].filter((x) => x !== undefined);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          name,
          workstream: ws,
          task: `${ws}/${call.task}`,
          state: "running",
          call_id: call.callId,
          attach: attach ?? null,
          workspace: workspace ?? null,
          keep,
        },
      };
    } finally {
      // A start that threw frees its slot here, and a call queued while it
      // was starting must take that slot: drain whether queued or direct.
      freeSlot();
      drain();
    }
  }

  /**
   * No multiplexer: run the call as a child `pi --mode rpc` through
   * `mu delegates run <call-id>`, which sends once, waits, finishes the call
   * durably (verdict, report, close) and stops the child before it prints its
   * one result. The delegate is named by its task; there is no pane to attach
   * or close, and `keep` needs a pane (the run would hold its child forever),
   * so it is dropped here. A refused run (nothing sent) stays reissuable.
   */
  /** A run that exited without finishing its call (killed before its own
   *  signal handler, or a crash) must not leave it starting: finish it. A
   *  finished call ignores this, so the normal path writes nothing. */
  const finishOrphan = (call: CallInfo, outcome: string, text: string) =>
    calls.finish(call.callId, { outcome, text, author: call.caller }).catch((e: unknown) => {
      trace("finishOrphan.failed", { call: call.callId, error: errText(e) });
      return undefined;
    });

  function startProcess(call: CallInfo): ToolResult {
    const ws = call.workstream;
    const name = call.task;
    const key = inflightKey(ws, name);
    const entry: Inflight = { abort: new AbortController(), call, cancelling: false };
    inflight.set(key, entry);
    reportPending();
    const settle = async (r: MuResult) => {
      const o = (json(r) ?? {}) as ProcessRun;
      forget(key);
      if (o.outcome === undefined || o.state === "refused") {
        const text = processFailedText(call, o, why(r), r.code, DELEGATE_REISSUE_TOOL);
        if (o.state !== "refused") await finishOrphan(call, "error", text);
        startFailed(name, new Error(text), "Delegate");
        return;
      }
      // The run finished the call durably (verdict, report, close): owed to the settle.
      const verdict = await calls
        .show(call.callId)
        .then((x) => x.verdict ?? undefined)
        .catch(() => undefined);
      owed.set(call.callId, {
        callId: call.callId,
        name,
        workstream: ws,
        task: call.task,
        outcome: o.outcome,
        ...(verdict ? { verdict } : {}),
        ...(call.record && o.state === "done"
          ? { record: `${call.record.workstream}/${call.record.task}` }
          : {}),
        at: Date.now(),
      });
      wakeIfIdle();
    };
    // A cancel's SIGTERM aborts the turn, finishes the call, then stops the
    // child (up to ~11 s); SIGKILL before that would orphan the child pi.
    const running = mu(
      ["delegates", "run", call.callId, "--no-keep", "--json"],
      entry.abort.signal,
      undefined,
      { drainMs: 20_000 },
    );
    entry.process = running;
    void running.then(async (r) => {
      if (inflight.get(key) !== entry) return; // cancelled or shut down
      await settle(r);
    });
    return processStarted(call, DELEGATE_CANCEL_TOOL);
  }

  /** Make a failed start durable: unsent -> refused (reissuable, brief kept);
   *  a possibly-running pane -> finished as failed; a cancel -> cancelled. */
  async function settleFailedStart(call: CallInfo, fail: SpawnFail): Promise<void> {
    try {
      if (fail.kind === "unsent") await calls.mark(call.callId, "refused", { error: fail.message });
      else
        await calls.finish(call.callId, {
          outcome:
            fail.kind === "aborted" ? "cancelled" : fail.kind === "unknown" ? "unknown" : "error",
          text: fail.message,
          author: call.caller,
        });
    } catch (e) {
      trace("settleFailedStart.failed", { call: call.callId, error: errText(e) });
    }
  }

  /** The delegate's own pi session file, for a never-started or cancelled call: none. */
  const callIdIn = (name: string) => name.startsWith("pi:");

  /** Admit a registered call: a free slot starts it now, else the queue holds
   *  it. (Refusal past the queue is decided by the caller, before it registers.) */
  const admission = (): "starting" | "queued" | "refused" => {
    const max = delegateMax();
    if (inflight.size + starting < max) return "starting";
    return queue.length < DELEGATE_QUEUE_FACTOR * max ? "queued" : "refused";
  };

  /** The text and details of a call that was queued or refused. */
  const queuedResult = (
    call: CallInfo,
    state: "queued" | "refused",
    handle: string,
    position: number,
  ): ToolResult => {
    const max = delegateMax();
    const taskRef = `${call.workstream}/${call.task}`;
    const text =
      state === "refused"
        ? `REFUSED, not started: ${inflight.size + starting} running and ${queue.length} queued (MU_DELEGATE_MAX=${max}). The call is durable (task ${taskRef}, call ${call.callId}) and will NOT start on its own. Reissue it once slots free, as answers arrive: ${DELEGATE_REISSUE_TOOL} { call_id: "${call.callId}" }. List: mu delegates.`
        : `Queued as ${handle} (#${position}; ${inflight.size + starting} running, MU_DELEGATE_MAX=${max}; task ${taskRef}, call ${call.callId}). It starts when a slot frees, and its answer arrives with a settle like any delegate's; do not poll. Cancel: ${DELEGATE_CANCEL_TOOL} { name: "${handle}" }`;
    return {
      content: [{ type: "text", text }],
      details: {
        name: handle,
        workstream: call.workstream,
        task: taskRef,
        state,
        call_id: call.callId,
        ...(state === "queued" ? { queued: true, position } : { refused: true }),
      },
    };
  };

  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "mu delegate",
    description: `Subagent: run one self-contained task in a fresh pi agent (its own mux pane in mu's ${W} workstream; with no tmux or herdr, a child pi process with no pane) while you keep working. Use it whenever you would reach for a subagent: research, a review, a draft, an investigation, or a refuter of a claim, plan or fix before you act on it; call it several times to fan out in parallel (at most ${delegateMax()} run at once; up to ${DELEGATE_QUEUE_FACTOR * delegateMax()} more are queued and start as slots free; past that a call is refused: durable, reissue it with ${DELEGATE_REISSUE_TOOL}). Every call is a mu task (kind delegate): the result names it, and the full answer stays on it. The subagent starts with no context, in your working directory: put everything it needs in task. The call returns at once and the answer arrives later, with a settle (a wave's as ONE summary): carry on with other work, or end your turn if your next step needs the answer (it resumes you). The pane closes after a clean finish; keep: true leaves it open (needs a mux). When the check judges a mu task, set record so its verdict lands on that task; leave it out when there is no task. Set wave to group a fan-out (mu delegates tally).`,
    promptSnippet:
      "Subagent: delegate a self-contained task to a background pi agent; its answer arrives later, with a settle",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete task, with all context it needs" },
        label: {
          type: "string",
          description:
            "Short label naming the delegate, e.g. 'review' → delegate-review. Use one per subtask when fanning out.",
        },
        brief: {
          type: "string",
          description:
            "Optional standing role or rules, sent before the task, e.g. 'You are a reviewer; read only.' The rules are instructions, not enforced. The job itself goes in task.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for the delegate (default: yours); with workspace, the git repo the worktree is made from",
        },
        timeout: {
          type: "number",
          exclusiveMinimum: 0,
          description: `Seconds to wait for the answer (default ${DELEGATE_TIMEOUT_S}). On timeout you get a "still running" answer instead, and the real answer will not arrive later; the subagent keeps running in its pane.`,
        },
        workspace: {
          type: "boolean",
          description:
            "For tasks that edit files: its own git worktree branched from the current commit of the repo at cwd (default: yours). The result names the path; changes stay there until you merge them. This isolates repository edits only: the subagent runs as you, with your files, environment and network.",
        },
        cli: {
          type: "string",
          description:
            "Agent CLI key (default pi). Only keys with $MU_<KEY>_COMMAND set in pi's environment exist; to pick a model, use model instead.",
        },
        model: {
          type: "string",
          description:
            "Model for the subagent, passed to pi as --model (e.g. 'sonnet', '<provider>/<model>:high' copied from `pi --list-models`); appended to the cli's command. Default: the cli's own model. Use it to vary models across a review panel.",
        },
        keep: {
          type: "boolean",
          description:
            "Keep the pane after it finishes, to talk to it again (needs a mux; ignored without one)",
        },
        record: {
          type: "object",
          description:
            "When the answer arrives, write its VERDICT/EVIDENCE onto this task as a note (for a check that judges a mu task; omit with no task); name the workstream: task as <ws>/<task>, or set workstream.",
          properties: {
            task: { type: "string" },
            workstream: { type: "string" },
          },
          required: ["task"],
          additionalProperties: false,
        },
        wave: {
          type: "string",
          description:
            "Label grouping the calls of one fan-out; `mu delegates tally -w <workstream> --wave <label>` counts their verdicts per judged task.",
        },
        workstream: {
          type: "string",
          description: `Workstream that holds the delegate task and runs the delegate (default: ${W}).`,
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) throw new Error("mu_delegate needs a non-empty task");
      const t = params.timeout;
      if (t !== undefined && !(typeof t === "number" && Number.isFinite(t) && t > 0))
        throw new Error(
          `mu_delegate: timeout must be a positive number of seconds (got ${JSON.stringify(t)})`,
        );
      // With workspace, cwd is only what the caller named: the repo to branch.
      const callCwd =
        typeof params.cwd === "string" && params.cwd
          ? params.cwd
          : params.workspace !== true
            ? (ctx?.cwd ?? process.cwd())
            : undefined;
      if (callCwd !== undefined && !isDir(callCwd))
        throw new Error(`mu_delegate: cwd ${callCwd} is not a directory`);
      let model: string | undefined;
      if (params.model !== undefined && params.model !== "") {
        model = normalizeModel(params.model);
        if (!model)
          throw new Error(
            `mu_delegate: model must be one pi model id like 'provider/id:thinking', as listed by \`pi --list-models\` (got ${JSON.stringify(params.model)}); omit it for the cli's default`,
          );
      }
      let workstream = W;
      if (params.workstream !== undefined) {
        const problem = workstreamNameProblem(
          typeof params.workstream === "string" ? params.workstream : String(params.workstream),
          "workstream",
        );
        if (problem !== undefined) throw new Error(`mu_delegate: ${problem} Nothing spawned.`);
        workstream = params.workstream as string;
      }
      if (
        params.wave !== undefined &&
        (typeof params.wave !== "string" || params.wave.trim() === "")
      )
        throw new Error(
          `mu_delegate: wave must be a non-empty label (got ${JSON.stringify(params.wave)})`,
        );
      const record = await resolveRecord(params.record);
      const brief = typeof params.brief === "string" ? params.brief.trim() : "";
      const label =
        typeof params.label === "string" && params.label.trim() ? params.label.trim() : undefined;
      // Count slots synchronously, before any await: parallel calls in one
      // turn all run this line before the first register returns.
      const decision = admission();
      const handle = decision === "starting" ? "" : `queued-${++queueSeq}`;
      if (decision === "starting") starting++;
      const session = piSessionId(ctx) || process.env.PI_SESSION_ID || `local-${token}`;
      const caller = `pi:${session}`;
      const info: Omit<CallInfo, "task"> = {
        callId: `${caller}:${token}-${++callSeq}`,
        caller,
        workstream,
        ...(typeof params.wave === "string" ? { wave: params.wave.trim() } : {}),
        ...(record ? { record } : {}),
        request: {
          text: brief ? `${brief}\n\n${task}` : task,
          ...(label ? { label } : {}),
          ...(typeof params.cli === "string" && params.cli ? { cli: params.cli } : {}),
          ...(model ? { model } : {}),
          ...(callCwd !== undefined ? { cwd: callCwd } : {}),
          ...(params.workspace === true ? { workspace: true } : {}),
          ...(typeof t === "number" ? { timeoutS: Math.ceil(t) } : {}),
          ...(params.keep === true ? { keep: true } : {}),
        },
      };
      if (decision === "starting") {
        // Durable before it spawns: a start that fails here frees its slot.
        let reg: Awaited<ReturnType<typeof calls.register>>;
        try {
          reg = await calls.register(info, "starting");
        } catch (e) {
          starting--;
          reportPending();
          drain();
          throw new Error(
            `mu_delegate: could not register the call: ${errText(e)}. Nothing spawned.`,
          );
        }
        return start(reg.call, signal, ctx);
      }
      if (decision === "refused") {
        let reg: Awaited<ReturnType<typeof calls.register>>;
        try {
          reg = await calls.register(info, "refused");
        } catch (e) {
          throw new Error(
            `mu_delegate: could not register the call: ${errText(e)}. Nothing spawned.`,
          );
        }
        return queuedResult(reg.call, "refused", handle, 0);
      }
      // Full: wait in the queue (FIFO, up to DELEGATE_QUEUE_FACTOR caps' worth).
      const entry: Queued = {
        handle,
        call: { ...info, task: "" },
        ctx,
        registered: Promise.resolve(),
      };
      entry.registered = calls.register(info, "queued").then((reg) => {
        entry.call = reg.call;
      });
      queue.push(entry);
      reportPending();
      try {
        await entry.registered;
      } catch (e) {
        const at = queue.indexOf(entry);
        if (at >= 0) queue.splice(at, 1);
        reportPending();
        throw new Error(`mu_delegate: could not register the call: ${errText(e)}. Nothing queued.`);
      }
      return queuedResult(entry.call, "queued", handle, queue.indexOf(entry) + 1 || queue.length);
    },
  });

  pi.registerTool({
    name: DELEGATE_REISSUE_TOOL,
    label: "mu delegate reissue",
    description: `Run a call ${DELEGATE_TOOL} refused (the queue was full): same call, same task, never a second verdict. Takes the call_id from the refusal; starts now if a slot is free, else queues.`,
    parameters: {
      type: "object",
      properties: { call_id: { type: "string", description: "The refused call's id" } },
      required: ["call_id"],
      additionalProperties: false,
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const callId = typeof params.call_id === "string" ? params.call_id : "";
      if (!callId) throw new Error(`${DELEGATE_REISSUE_TOOL} needs a call_id`);
      const shown = await calls.show(callId).catch((e: unknown) => {
        throw new Error(`${DELEGATE_REISSUE_TOOL}: ${errText(e)}`);
      });
      if (shown.state !== "refused")
        throw new Error(`${DELEGATE_REISSUE_TOOL}: call ${callId} is ${shown.state}, not refused.`);
      // Synchronous from here to the slot count: parallel reissues cannot overfill.
      const decision = admission();
      if (decision === "refused")
        throw new Error(
          `${DELEGATE_REISSUE_TOOL}: still full (${inflight.size + starting} running, ${queue.length} queued). Nothing changed; reissue ${callId} when an answer arrives.`,
        );
      if (decision === "starting") starting++;
      try {
        await calls.mark(callId, decision === "starting" ? "starting" : "queued");
      } catch (e) {
        if (decision === "starting") {
          starting--;
          reportPending();
          drain();
        }
        throw new Error(`${DELEGATE_REISSUE_TOOL}: ${errText(e)}`);
      }
      if (decision === "starting") return start(shown.call, signal, ctx);
      const handle = `queued-${++queueSeq}`;
      queue.push({ handle, call: shown.call, ctx, registered: Promise.resolve() });
      reportPending();
      return queuedResult(shown.call, "queued", handle, queue.length);
    },
  });

  pi.registerTool({
    name: DELEGATE_CANCEL_TOOL,
    label: "mu delegate cancel",
    description: `Stop a delegate started by ${DELEGATE_TOOL}: abort its turn and close its pane (keep: true leaves the pane open; a mux-free one's child pi is stopped). A queued or refused call is cancelled too (name it by its handle or call_id). The verdict target, if any, gets "no verdict (cancelled)". Its answer is not shown afterwards.`,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Delegate name (delegate-1), queue handle (queued-2) or call_id",
        },
        keep: { type: "boolean", description: "Leave the pane open after aborting" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) throw new Error("mu_delegate_cancel needs a name");
      const cancelCall = async (call: CallInfo, author: string, text?: string) => {
        try {
          const f = await calls.finish(call.callId, {
            outcome: "cancelled",
            ...(text ? { text } : {}),
            author,
          });
          if (f.recorded && call.record)
            return ` Recorded on ${call.record.workstream}/${call.record.task} as a note (no verdict: cancelled).`;
          return f.changed ? ` Task ${call.workstream}/${call.task} closed (cancelled).` : "";
        } catch (e) {
          return ` Recording the cancel failed: ${errText(e)}.`;
        }
      };
      const qi = queue.findIndex((q) => q.handle === name || q.call.callId === name);
      if (qi >= 0) {
        const [q] = queue.splice(qi, 1);
        reportPending();
        let recorded = "";
        if (q) {
          await q.registered.catch(() => {});
          recorded = await cancelCall(q.call, q.handle);
        }
        return {
          content: [
            { type: "text", text: `Dropped ${name} from the queue; it never started.${recorded}` },
          ],
          details: { name, workstream: q?.call.workstream ?? W },
        };
      }
      const found = [...inflight].find(
        ([key, e]) =>
          key === name || key === inflightKey(e.call.workstream, name) || e.call.callId === name,
      );
      if (!found && callIdIn(name)) {
        // Not in this runtime (refused, or another session's): cancel the durable call.
        const shown = await calls.show(name).catch((e: unknown) => {
          throw new Error(`mu_delegate_cancel: ${errText(e)}`);
        });
        const recorded = await cancelCall(shown.call, name);
        return {
          content: [{ type: "text", text: `Cancelled ${name} (${shown.state}).${recorded}` }],
          details: { name, workstream: shown.call.workstream },
        };
      }
      const key = found?.[0];
      const entry = found?.[1];
      const ws = entry?.call.workstream ?? W;
      const agentName = key ? key.slice(key.indexOf("/") + 1) : name;
      if (entry?.process && key) {
        // SIGTERM the run: it aborts the child's turn, finishes the call
        // cancelled and stops the child; its log and session file stay.
        entry.abort.abort();
        forget(key);
        await entry.process;
        await finishOrphan(entry.call, "cancelled", "cancelled");
        const shown = await calls.show(entry.call.callId).catch(() => undefined);
        const where = entry.call.record
          ? ` Recorded on ${entry.call.record.workstream}/${entry.call.record.task} as a note (no verdict: cancelled).`
          : "";
        return {
          content: [
            {
              type: "text",
              text: `Cancelled ${ws}/${agentName} (child pi stopped; call ${shown?.state ?? "cancelling"}).${where}`,
            },
          ],
          details: { name: agentName, workstream: ws },
        };
      }
      if (entry) entry.cancelling = true;
      const ab = await mu(["agent", "abort", agentName, "-w", ws]);
      if (ab.code !== 0) {
        // Not cancelled after all: keep waiting, or deliver what settled meanwhile.
        if (entry) {
          entry.cancelling = false;
          const parked = entry.parked;
          entry.parked = undefined;
          if (parked) void parked();
        }
        throw failure(`mu agent abort ${ws}/${agentName}`, ab);
      }
      if (entry && key) {
        entry.abort.abort();
        forget(key);
      }
      let text = `Aborted ${ws}/${agentName}.`;
      // Its transcript; what it wrote before the abort goes into the report.
      const sessionFile = entry?.sessionFile;
      const evidence = evidenceLines({ ...(sessionFile ? { sessionFile } : {}) });
      // The result is durable before the pane goes: the cancel closes the task.
      if (entry)
        text += await cancelCall(
          entry.call,
          agentName,
          sessionFile ? lastAssistantTextIn(sessionFile) : undefined,
        );
      if (params.keep === true) text += " Pane kept.";
      else {
        const c = await closeDelegate(agentName, entry?.identity, ws);
        text += c.closed ? " Pane closed." : ` Pane kept: ${c.why}`;
      }
      if (evidence.length > 0) text += `\n${evidence.join("\n")}`;
      return { content: [{ type: "text", text }], details: { name: agentName, workstream: ws } };
    },
  });

  // A wake enters the conversation at its message_start: at once when pi is
  // idle, or when the running turn drains its follow-ups. Its answers are then
  // in front of the model (as pointers); its turn's settle shows the reports.
  pi.on("message_start", (e) => {
    const m = (e as { message?: { role?: unknown; customType?: unknown; details?: unknown } })
      .message;
    if (m?.role !== "custom" || m.customType !== DELEGATE_MESSAGE_TYPE) return;
    const id = (m.details as { wake?: unknown } | undefined)?.wake;
    if (typeof id !== "number") return;
    for (const c of arriving.get(id)?.calls ?? []) owed.delete(c);
    arriving.delete(id);
  });

  /** Stop waking for these: the reports stay recorded and the next settle's wait
   *  still owes them. One line per answer in the conversation (no turn). */
  const dropWakes = (ids: number[], also: string[] = []) => {
    const names = new Set(also);
    for (const id of ids) {
      const a = arriving.get(id);
      if (!a) continue;
      arriving.delete(id);
      // pi may still run a send it deferred while settling: no turn.
      for (const o of a.opts ?? []) o.triggerTurn = false;
      for (const c of a.calls) names.add(c);
    }
    const dropped: DroppedWake[] = [];
    for (const c of names) {
      const a = owed.get(c);
      if (!a) continue;
      owed.delete(c);
      dropped.push(a);
    }
    trace("dropped", { calls: dropped.map((d) => d.callId) });
    if (dropped.length === 0) return;
    void Promise.resolve(
      send(
        {
          customType: DELEGATE_MESSAGE_TYPE,
          content: droppedNote(dropped),
          display: true,
          details: { dropped: dropped.map((d) => d.callId) },
        },
        { triggerTurn: false },
        "dropped-note",
      ),
    ).catch(() => {});
  };
  /** After a normal settle, with pi idle one tick later (pi runs the sends it
   *  deferred right after this event) and nothing accepted since: a wake pi
   *  accepted that never started was cleared from its queue (the dequeue key, a
   *  failed compaction flush). Resend ONE; lost twice, drop it with a note. With
   *  no wake lost, wake for any answer the settle did not show. */
  const recoverLost = (candidates: number[], ctx: DelegateCtx) => {
    settleCheck = undefined;
    if (closed) return;
    let idle = false;
    try {
      idle = ctx.isIdle?.() ?? true;
    } catch {
      // stale ctx: the next settle looks again
    }
    if (!idle) return;
    // Accepted after the settle began: pi may be about to run it, and its own
    // run settles again.
    if ([...arriving].some(([id, a]) => a.sent && !candidates.includes(id))) return;
    const lost = candidates.filter((id) => arriving.get(id)?.sent);
    dropWakes(lost.filter((id) => arriving.get(id)?.resent));
    const next = lost.find((id) => arriving.has(id));
    const a = next === undefined ? undefined : arriving.get(next);
    if (next === undefined || !a?.message) {
      wake("wake-after-settle");
      return;
    }
    a.resent = true;
    trace("resend", { wake: next, calls: a.calls });
    void Promise.resolve(
      send(a.message, { deliverAs: "followUp", triggerTurn: true }, "resend"),
    ).catch(() => {
      arriving.delete(next);
    });
  };
  pi.on("agent_start", () => {
    busy = true;
  });
  pi.on("agent_settled", (e, ctx) => {
    busy = false;
    const sent = [...arriving].filter(([, a]) => a.sent).map(([id]) => id);
    // Escape clears pi's queue along with the run: what it held never arrives,
    // and the user stopped. No wake: one note; the next prompt's settle shows them.
    if ((e as { aborted?: unknown }).aborted === true) {
      clearImmediate(settleCheck);
      dropWakes(sent, [...owed.keys()]);
      return;
    }
    if (sent.length === 0 && owed.size === 0) return;
    clearImmediate(settleCheck);
    settleCheck = setImmediate(() => recoverLost(sent, ctx));
  });

  // The watchers die with this runtime (/reload, /new, quit): say which
  // delegates lose their callback, so none is lost silently. The names
  // are also in the tool results, and `mu agent wait` recovers them.
  pi.on("session_shutdown", async (e, ctx) => {
    closed = true;
    clearImmediate(settleCheck);
    clearImmediate(wakeSoon);
    trace("session_shutdown.state", {
      arriving: [...arriving.values()].map((a) => ({ calls: a.calls, sent: a.sent })),
      owed: [...owed.keys()],
      inflight: [...inflight.keys()],
    });
    // Wakes die with this runtime; the recorded answers stay owed to the next wait.
    arriving.clear();
    owed.clear();
    if (inflight.size === 0 && queue.length === 0) return;
    const shown = (key: string) => (key.startsWith(`${W}/`) ? key.slice(W.length + 1) : key);
    const names = [...inflight].flatMap(([k, e]) => (e.process ? [] : [shown(k)]));
    const procs = [...inflight].flatMap(([k, e]) => (e.process ? [shown(k)] : []));
    const sessions = [...inflight].flatMap(([k, e]) =>
      e.sessionFile ? [`${shown(k)}: ${e.sessionFile}`] : [],
    );
    const dropped = queue.splice(0);
    // A mux-free run is this pi's child: quit cancels it (durably), while a
    // reload or session switch leaves it to finish onto its task.
    const reason = (e as { reason?: unknown } | undefined)?.reason;
    const replacing =
      reason === "reload" || reason === "new" || reason === "resume" || reason === "fork";
    const stopping: Promise<unknown>[] = [];
    for (const f of inflight.values())
      if (!f.process || !replacing) {
        f.abort.abort();
        const call = f.call;
        if (f.process)
          stopping.push(f.process.then(() => finishOrphan(call, "cancelled", "pi quit")));
      }
    inflight.clear();
    reportPending();
    // Quit: each run has cancelled its call and stopped its child before it exits.
    await Promise.all(stopping);
    // A queued call never started and nothing will drain it now: park it as
    // refused (durable, listable, reissuable) instead of leaving it queued forever.
    const refused: string[] = [];
    await Promise.all(
      dropped.map(async (q) => {
        try {
          await q.registered;
          await calls.mark(q.call.callId, "refused", {
            error: "its session ended before it started",
          });
          refused.push(q.call.callId);
        } catch {
          // best effort: `mu delegates` shows what state it stayed in
        }
      }),
    );
    const parts: string[] = [];
    if (names.length > 0)
      parts.push(
        `${names.length} delegate${names.length === 1 ? "" : "s"} still running: ${names.join(", ")}. Their answers will not come back here; use mu agent wait <name> -w ${W} --json.`,
      );
    if (procs.length > 0)
      parts.push(
        replacing
          ? `${procs.length} mux-free delegate${procs.length === 1 ? "" : "s"} still running: ${procs.join(", ")}. Each finishes onto its task (mu task notes <name> -w ${W}); the answer will not come back here.`
          : `${procs.length} mux-free delegate${procs.length === 1 ? "" : "s"} cancelled: ${procs.join(", ")}.`,
      );
    if (sessions.length > 0) parts.push(`Sessions: ${sessions.join("; ")}.`);
    if (dropped.length > 0)
      parts.push(
        `${dropped.length} queued, never started: ${dropped.map((q) => q.handle).join(", ")}. Re-issue them${refused.length > 0 ? ` (durable and refused: ${DELEGATE_REISSUE_TOOL} in a new pi session; list: mu delegates --all)` : ""}.`,
      );
    const msg = parts.join(" ");
    if (ctx?.hasUI && ctx.ui) ctx.ui.notify(msg, "warning");
    else process.stderr.write(`mu: ${msg}\n`);
  });

  return {
    answerPending: () => arriving.size > 0,
    delivered(shown) {
      if (Array.isArray(shown)) for (const c of shown) owed.delete(c);
      else
        for (const [c, a] of owed) if (a.at < (shown as { before: number }).before) owed.delete(c);
    },
  };
}
