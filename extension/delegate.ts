/**
 * mu pi extension, parent side: the `mu_delegate` tool.
 *
 * A delegate is a scratch agent started for one task. The tool spawns it,
 * hands it the task, returns at once, and posts the answer back into this
 * conversation as a follow-up when the delegate's run settles.
 *
 * Everything is the `mu` CLI (spawn / send / wait --json / read / abort /
 * close): the tool only orders the calls and formats the result, so a
 * shell gets the same delegation (VISION § 1, rule 2). The one
 * thing only an extension can do is the callback into the parent
 * conversation, and that is presentation. No extension-only state: the
 * in-flight set below is the list of `mu agent wait` children this pi owns.
 *
 * Separate from the child side (the control-socket server in mu-pi.ts):
 * that one serves a pi mu spawned; this one runs in a pi that is not.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The slice of pi's ExtensionAPI the delegate side uses. */
export interface MuDelegateApi {
  registerTool(tool: DelegateTool): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void | Promise<void>;
  on(
    event: "session_shutdown" | "message_start" | "agent_settled",
    handler: (event: unknown, ctx: DelegateCtx) => unknown,
  ): unknown;
  /** pi's in-process bus between extensions. */
  events: { emit(channel: string, data: unknown): void };
}

/** The slice of pi's ExtensionContext the delegate side uses. */
export interface DelegateCtx {
  hasUI?: boolean;
  cwd?: string;
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus?(key: string, text: string | undefined): void;
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

export type MuResult = { code: number; stdout: string; stderr: string };
/** Runs `mu <args>`. The test seam: tests inject a fake. */
export type MuRunner = (args: readonly string[], signal?: AbortSignal) => Promise<MuResult>;

export const DELEGATE_TOOL = "mu_delegate";
export const DELEGATE_CANCEL_TOOL = "mu_delegate_cancel";
export const DELEGATE_MESSAGE_TYPE = "mu-delegate";
export const DELEGATE_WORKSTREAM = "scratch";
/** The footer status key (`ctx.ui.setStatus`), like goal / watchloop. */
export const DELEGATE_STATUS_KEY = "mu-delegate";
/**
 * murmur's channel for outstanding background work, as
 * `{ source, count }`. murmur shows the count on this agent's card,
 * renders a stopped agent with work out as `waiting`, and holds back
 * `done` until it is zero: a parent that ended its turn to wait on
 * delegates has not finished. A string, not an import: neither side
 * depends on the other, and with no murmur loaded nobody listens.
 */
export const PENDING_CHANNEL = "murmur:pending";

/** Footer text: delegates running (pane up), starting (no pane yet),
 *  queued, failed, and finished whose answer has not reached this
 *  conversation yet (pending); undefined clears the entry. */
export function delegateStatus(
  running: number,
  starting = 0,
  queued = 0,
  failed = 0,
  pending = 0,
): string | undefined {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} delegate${running === 1 ? "" : "s"} running`);
  if (starting > 0) parts.push(`${starting} starting`);
  if (queued > 0) parts.push(`${queued} queued`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} result${pending === 1 ? "" : "s"} pending`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}
/** Default `mu agent wait --timeout` for a delegate, in seconds. */
export const DELEGATE_TIMEOUT_S = 3600;
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

/** Registration guards: unmanaged pi, a mux in reach, not switched off. */
export function delegateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MU_MANAGED_AGENT) return false; // no helper-spawns-helper
  if (env.MU_DELEGATE === "0") return false;
  if (env.MU_MUX || env.HERDR_ENV === "1" || env.TMUX || env.TMUX_PANE) return true;
  return onPath("tmux", env) || onPath("herdr", env);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(delimiter).some((d) => d !== "" && existsSync(join(d, bin)));
}

/** The CLI this extension ships with (dist/cli.js next to dist/extension/), else `mu` on PATH. */
export function defaultRunner(): MuRunner {
  let cli: string | undefined;
  try {
    const p = fileURLToPath(new URL("../cli.js", import.meta.url));
    if (existsSync(p)) cli = p;
  } catch {
    // not a file: URL; use PATH
  }
  return (args, signal) =>
    new Promise((resolve) => {
      const [cmd, argv] = cli ? [process.execPath, [cli, ...args]] : ["mu", [...args]];
      execFile(
        cmd,
        argv,
        { maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr || err?.message || "") });
        },
      );
    });
}

/** One agent row of `mu agent wait --json`, as far as the tool reads it. */
export type WaitAgent = { outcome?: string; lastText?: string; lastError?: string };

/** What happened to the pane after delivery, for the message. */
export type PaneFate = { closed: true } | { closed: false; why: string };

/** Extras for the follow-up message; all optional. */
export type MessageExtras = {
  /** `mu agent read -n 50` for the outcomes without text. */
  tail?: string;
  attach?: string;
  timeoutS?: number;
  workspace?: string;
  /** How long the delegate ran, in ms. */
  elapsedMs?: number;
  /** The queue handle the caller was given (`queued-3`), if it was queued. */
  queuedAs?: string;
};

/** `42s`, `3m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m ${String(t % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * The follow-up message for one finished wait. Pure: the CLI already
 * classified the outcome (`mu agent wait --json` → `outcome`); this only
 * words it.
 */
export function delegateMessage(
  name: string,
  agent: WaitAgent | undefined,
  pane: PaneFate,
  x: MessageExtras = {},
): string {
  const timeoutS = x.timeoutS ?? DELEGATE_TIMEOUT_S;
  const who = `Delegate ${W}/${name}${x.queuedAs ? ` (queued as ${x.queuedAs})` : ""}`;
  const took = x.elapsedMs !== undefined ? ` after ${formatElapsed(x.elapsedMs)}` : "";
  const fate = pane.closed ? "Pane closed." : `Pane kept (${pane.why}).`;
  const look = [
    x.attach ? `Attach: ${x.attach}` : undefined,
    `Read: mu agent read ${name} -n 50 -w ${W}`,
  ].filter((v) => v !== undefined);
  const tailBlock = x.tail?.trim() ? `\n\nPane tail:\n${x.tail.trimEnd()}` : "";
  const ws = x.workspace ? ` Workspace: ${x.workspace}` : "";
  switch (agent?.outcome) {
    case "done":
      return `${who} finished${took}. ${fate}${ws}\n\n${agent.lastText ?? ""}`;
    case "empty":
      return `${who} finished${took} without a text answer. ${fate}${ws}${tailBlock}`;
    case "error":
      return [
        `${who} stopped on an API error${took}, after pi's own retries: ${(agent.lastError ?? "unknown error").replace(/[.\s]+$/, "")}. ${fate}${ws}`,
        "Decide: re-issue the call, or record the check as UNVERIFIED.",
        ...look,
        `Close: mu agent close ${name} -w ${W}`,
      ].join("\n");
    case "died":
      return `${who} died${took} before answering. ${fate}${ws}${tailBlock}`;
    case "timeout":
    case "pending":
      return [
        `${who} is still running after ${timeoutS}s; stopped waiting, so its answer will not arrive here. ${fate}${ws}`,
        ...look,
        `Wait again: mu agent wait ${name} -w ${W} --json`,
      ].join("\n");
    default:
      return `${who}: mu agent wait gave no result. ${fate}${ws}${tailBlock}`;
  }
}

/** Where a delegate's answer is recorded: a task, resolved by `mu task show`. */
export type RecordTarget = { workstream: string; task: string };

/** Cap on a recorded note, in chars. */
export const RECORD_NOTE_MAX = 4000;
/** Without a VERDICT line, this much of the answer's end is recorded. */
export const RECORD_FALLBACK_TAIL = 1500;

const VERDICT_LINE = /^[\s>*_`-]*VERDICT:/;
const EVIDENCE_LINE = /^[\s>*_`-]*EVIDENCE:/;

/**
 * The note a delegate's answer leaves on the task it judged. Pure. A done
 * answer keeps its last `VERDICT:` line and every `EVIDENCE:` line after
 * it (else its tail, marked NO VERDICT LINE); any other outcome records
 * the gap.
 */
export function recordNote(
  label: string,
  name: string,
  outcome: string | undefined,
  lastText: string | undefined,
  elapsedMs: number,
): string {
  if (outcome !== "done" || !lastText?.trim())
    return `REFUTER ${label}: no verdict (${outcome === "done" ? "empty" : (outcome ?? "no result")})`;
  const lines = lastText.trimEnd().split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--)
    if (VERDICT_LINE.test(lines[i] ?? "")) at = i;
  const body =
    at >= 0
      ? [lines[at] ?? "", ...lines.slice(at + 1).filter((l) => EVIDENCE_LINE.test(l))].join("\n")
      : `NO VERDICT LINE: ${lastText.trimEnd().slice(-RECORD_FALLBACK_TAIL)}`;
  const note = `REFUTER ${label} (${name}, ${formatElapsed(elapsedMs)}):\n${body}`;
  const mark = "\n[truncated]";
  return note.length <= RECORD_NOTE_MAX
    ? note
    : note.slice(0, RECORD_NOTE_MAX - mark.length) + mark;
}

/** A label → agent-name stem: lowercase, [a-z0-9-], ≤ 20 chars. */
export function labelStem(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const stem = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  return stem || undefined;
}

/** A `model` value pi takes as `--model` (`provider/id:thinking`); no
 *  shell characters, since it lands inside a `--command` string. */
const MODEL_RE = /^[A-Za-z0-9._:/@+-]+$/;

/**
 * The command a delegate with `model` runs: the cli key's command
 * (`$MU_<KEY>_COMMAND`, else the key itself, as `resolveCliCommand` in
 * src/agents/spawn.ts does) plus `--model <model>`. Inlined: the extension
 * bundles standalone and spawn.ts pulls in the DB.
 */
export function modelCommand(
  cli: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[`MU_${cli.toUpperCase().replace(/-/g, "_")}_COMMAND`];
  const base = override && override.trim() !== "" ? override.trim() : cli;
  return `${base} --model ${model}`;
}

/**
 * One delegate this pi waits on. `cancelling` is set while a cancel's abort
 * is in flight: the abort itself settles the run, so a wait resolving then
 * is parked in `parked` instead of delivered, and delivered after all if
 * the abort fails.
 */
type Inflight = {
  abort: AbortController;
  record?: { target: RecordTarget; label: string };
  cancelling: boolean;
  parked?: () => Promise<void>;
};

/** A call past the cap, waiting for a slot. Its delegate name is picked
 *  at spawn, so the queue hands out its own handle (`queued-3`). */
type Queued = {
  handle: string;
  params: Record<string, unknown>;
  ctx: DelegateCtx | undefined;
  record?: RecordTarget;
};

export function registerDelegate(pi: MuDelegateApi, run: MuRunner = defaultRunner()): void {
  if (!delegateEnabled()) return;
  const inflight = new Map<string, Inflight>();
  /** Calls past the cap check whose delegate is not yet in `inflight`. */
  let starting = 0;
  /** Calls past the cap, FIFO, at most `DELEGATE_QUEUE_FACTOR * delegateMax()` long. */
  const queue: Queued[] = [];
  let queueSeq = 0;
  /** Delegates that settled on an error, pane kept: counted in the footer
   *  until the model closes or re-issues them (no call to action). */
  const failed = new Set<string>();
  /** Delegates that finished whose follow-up has not entered the
   *  conversation: being delivered, or queued behind a running turn.
   *  Keyed by a per-delivery id carried in the message's details, and
   *  cleared on that message's message_start. The value says whether
   *  pi.sendMessage has returned, i.e. the message sits in pi's queue. */
  const arriving = new Map<number, boolean>();
  let deliverySeq = 0;
  // The ctx of the latest tool call: answers settle outside any call, so
  // the footer is refreshed through the last ctx pi handed us.
  let ui: DelegateCtx["ui"];
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
  // Every change to the counts already refreshes the footer, so the
  // report rides along rather than being a second set of call sites.
  const showStatus = () => {
    reportPending();
    try {
      ui?.setStatus?.(
        DELEGATE_STATUS_KEY,
        delegateStatus(inflight.size, starting, queue.length, failed.size, arriving.size),
      );
    } catch {
      // stale ctx after a session switch: the footer is decoration
    }
  };
  const track = (ctx: DelegateCtx | undefined) => {
    if (ctx?.hasUI !== false && ctx?.ui) ui = ctx.ui;
  };
  /** Drop a delegate from the in-flight set, start the next queued call
   *  into the freed slot, and refresh the footer. */
  const forget = (name: string) => {
    inflight.delete(name);
    drain();
    showStatus();
  };
  /** Start queued calls while there is a free slot. A queued call's tool
   *  call has already returned, so a failed start becomes a follow-up. */
  function drain(): void {
    while (queue.length > 0 && inflight.size + starting < delegateMax()) {
      const q = queue.shift();
      if (!q) break;
      starting++; // held until start() takes over the slot
      void start(q.params, undefined, q.ctx, q.handle, q.record).then(
        () => {},
        (e: unknown) => {
          void Promise.resolve(
            pi.sendMessage(
              {
                customType: DELEGATE_MESSAGE_TYPE,
                content: `Queued delegate ${q.handle} could not start: ${e instanceof Error ? e.message : String(e)}`,
                display: true,
                details: { name: q.handle, workstream: W, outcome: null, closed: false },
              },
              { deliverAs: "followUp", triggerTurn: true },
            ),
          ).catch(() => {});
        },
      );
    }
  }

  const mu = run;
  const json = (r: MuResult): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(r.stdout);
      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const failure = (what: string, r: MuResult) =>
    new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);

  /** A failed delegate whose pane is gone (closed from bash) leaves the
   *  footer. Off the call's path: only a footer count rides on it. */
  function pruneFailed(): void {
    if (failed.size === 0) return;
    void mu(["agent", "list", "-w", W, "--json"]).then((r) => {
      const agents = json(r)?.agents;
      if (!Array.isArray(agents)) return;
      const taken = new Set(agents.map((a: unknown) => (a as { name?: unknown }).name));
      for (const f of [...failed]) if (!taken.has(f)) failed.delete(f);
      showStatus();
    });
  }

  /**
   * Spawn the delegate and send it the task in ONE mu call (`spawn
   * --next-free --send`): mu picks the free name under its spawn lock, so
   * parallel calls get distinct names with no `agent list` first. Returns
   * the name and the send's `runs`, the exact wait baseline.
   */
  async function spawn(
    params: Record<string, unknown>,
    text: string,
    cwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ name: string; runs: number; attach?: string; workspace?: string }> {
    signal?.throwIfAborted();
    pruneFailed();
    const stem = labelStem(params.label);
    // A label names the delegate (delegate-review, then delegate-review-2);
    // without one it is numbered (delegate-1, delegate-2).
    const base = stem ? `delegate-${stem}` : "delegate-1";
    const args = ["agent", "spawn", base, "-w", W, "--next-free", "--send", text, "--json"];
    if (params.workspace === true) args.push("--workspace");
    else if (cwd) args.push("--cwd", cwd);
    const cli = typeof params.cli === "string" && params.cli ? params.cli : undefined;
    if (cli) args.push("--cli", cli);
    if (typeof params.model === "string" && params.model)
      args.push("--command", modelCommand(cli ?? "pi", params.model));
    const r = await mu(args);
    const out = json(r);
    const spawned = (out?.agent as { name?: unknown } | undefined)?.name;
    // No agent in the reply: the spawn itself failed, nothing is up.
    if (typeof spawned !== "string") throw failure("mu agent spawn", r);
    const name = spawned;
    if (signal?.aborted) {
      // The user cancelled while the pane came up: take it down again.
      await mu(["agent", "close", name, "-w", W]);
      signal.throwIfAborted();
    }
    if (out?.ctl !== "ok") {
      throw new Error(
        `${W}/${name} spawned but its control socket is ${String(out?.ctl)}, so its answer cannot come back. Pane kept; close it with: mu agent close ${name} -w ${W}`,
      );
    }
    const sent = out.send as { ok?: unknown; runs?: unknown; message?: unknown } | undefined;
    if (sent?.ok !== true) {
      // Nothing reached it: the pane is just an idle pi. Take it down.
      const c = await mu(["agent", "close", name, "-w", W]);
      const pane =
        c.code === 0 ? "Pane closed." : `Pane kept; close it with: mu agent close ${name} -w ${W}`;
      const why = typeof sent?.message === "string" ? sent.message : (r.stderr || r.stdout).trim();
      throw new Error(`mu agent send to ${W}/${name} failed (exit ${r.code}): ${why}. ${pane}`);
    }
    const steps = Array.isArray(out.nextSteps) ? out.nextSteps : [];
    const attach = steps
      .map((s: unknown) => s as { intent?: unknown; command?: unknown })
      .find((s) => s.intent === "Attach the pane")?.command;
    const wsPath = (out.workspace as { path?: unknown } | null | undefined)?.path;
    return {
      name,
      // A pi just spawned has settled no run, so 0 is exact when an older
      // extension's reply carries no runs.
      runs: typeof sent.runs === "number" ? sent.runs : 0,
      ...(typeof attach === "string" ? { attach } : {}),
      ...(typeof wsPath === "string" ? { workspace: wsPath } : {}),
    };
  }

  /** The note label: the caller's label, else the delegate's name. */
  const recordLabel = (params: Record<string, unknown>, name: string) =>
    typeof params.label === "string" && params.label.trim() ? params.label.trim() : name;

  /** Check `record` names a real task, before anything spawns. */
  async function resolveRecord(raw: unknown): Promise<RecordTarget | undefined> {
    if (raw === undefined) return undefined;
    const r = raw as { task?: unknown; workstream?: unknown } | null;
    const task = typeof r?.task === "string" ? r.task.trim() : "";
    if (!task) throw new Error("mu_delegate: record.task must name a task");
    const ws = typeof r?.workstream === "string" ? r.workstream.trim() : "";
    // Without a workstream, mu resolves it as any verb does (<ws>/<task>, $MU_SESSION, tmux).
    const shown = await mu(["task", "show", task, ...(ws ? ["-w", ws] : []), "--json"]);
    const out = json(shown);
    const t = out?.task as { name?: unknown; workstreamName?: unknown } | undefined;
    if (shown.code !== 0 || typeof t?.name !== "string" || typeof t.workstreamName !== "string") {
      const why =
        typeof out?.message === "string" ? out.message : (shown.stderr || shown.stdout).trim();
      throw new Error(
        `mu_delegate: record task ${ws ? `${ws}/` : ""}${task} not found (exit ${shown.code}): ${why}. Nothing spawned.`,
      );
    }
    return { workstream: t.workstreamName, task: t.name };
  }

  /** Write one note on the record task; the follow-up's line about it. */
  async function writeRecord(rec: RecordTarget, name: string, text: string): Promise<string> {
    const where = `${rec.workstream}/${rec.task}`;
    try {
      const r = await mu(["task", "note", rec.task, "-w", rec.workstream, "--author", name, text]);
      if (r.code === 0) return `Recorded on ${where} as a note.`;
      return `Recording on ${where} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}. Record it yourself.`;
    } catch (e) {
      return `Recording on ${where} failed: ${e instanceof Error ? e.message : String(e)}. Record it yourself.`;
    }
  }

  async function deliver(
    name: string,
    wait: MuResult,
    keep: boolean,
    extras: MessageExtras,
    delivery: number,
    record?: { target: RecordTarget; label: string },
  ) {
    const agent = (json(wait)?.agents as WaitAgent[] | undefined)?.[0];
    const outcome = agent?.outcome;
    const tail =
      outcome === "done" || outcome === "timeout" || outcome === "pending" || outcome === "error"
        ? undefined
        : (await mu(["agent", "read", name, "-n", "50", "-w", W])).stdout;
    // Close only after a clean finish: a died or timed-out pane is evidence.
    let pane: PaneFate = { closed: false, why: "keep: true" };
    if (outcome !== "done" && outcome !== "empty")
      pane = { closed: false, why: "kept as evidence" };
    else if (!keep) {
      const c = await mu(["agent", "close", name, "-w", W]);
      pane =
        c.code === 0
          ? { closed: true }
          : { closed: false, why: `close refused: ${(c.stderr || c.stdout).trim()}` };
    }
    if (outcome === "error" && !pane.closed) {
      failed.add(name);
      showStatus();
    }
    const recorded = record
      ? await writeRecord(
          record.target,
          name,
          recordNote(record.label, name, outcome, agent?.lastText, extras.elapsedMs ?? 0),
        )
      : undefined;
    const message = delegateMessage(name, agent, pane, { ...extras, ...(tail ? { tail } : {}) });
    await pi.sendMessage(
      {
        customType: DELEGATE_MESSAGE_TYPE,
        content: recorded ? `${message}\n\n${recorded}` : message,
        display: true,
        details: {
          name,
          workstream: W,
          outcome: outcome ?? null,
          closed: pane.closed,
          answer: outcome === "done" ? (agent?.lastText ?? null) : null,
          elapsedMs: extras.elapsedMs ?? null,
          workspace: extras.workspace ?? null,
          delivery,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  /** Spawn, send, and watch one delegate. The caller holds one
   *  `starting` slot; it is released once the delegate is in `inflight`
   *  (or on failure). Returns the tool result text. */
  async function start(
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: DelegateCtx | undefined,
    queuedAs?: string,
    record?: RecordTarget,
  ): Promise<ToolResult> {
    let slotHeld = true;
    const freeSlot = () => {
      if (slotHeld) {
        starting--;
        showStatus();
      }
      slotHeld = false;
    };
    showStatus(); // the footer moves at once, before the pane exists
    try {
      const task = typeof params.task === "string" ? params.task.trim() : "";
      const brief = typeof params.brief === "string" ? params.brief.trim() : "";
      const keep = params.keep === true;
      const t = params.timeout;
      if (t !== undefined && !(typeof t === "number" && Number.isFinite(t) && t > 0))
        throw new Error(
          `mu_delegate: timeout must be a positive number of seconds (got ${JSON.stringify(t)})`,
        );
      const timeoutS = typeof t === "number" ? Math.ceil(t) : DELEGATE_TIMEOUT_S;
      // Without --cwd the pane inherits the mux session's start dir (wherever
      // the FIRST scratch spawn ran), and a missing dir silently becomes
      // $HOME: pin it to the caller's and check it exists.
      let cwd: string | undefined;
      if (params.workspace !== true) {
        cwd =
          typeof params.cwd === "string" && params.cwd ? params.cwd : (ctx?.cwd ?? process.cwd());
        if (!isDir(cwd)) throw new Error(`mu_delegate: cwd ${cwd} is not a directory`);
      }
      const { name, runs, attach, workspace } = await spawn(
        params,
        brief ? `${brief}\n\n${task}` : task,
        cwd,
        signal,
      );
      const entry: Inflight = {
        abort: new AbortController(),
        cancelling: false,
        ...(record ? { record: { target: record, label: recordLabel(params, name) } } : {}),
      };
      inflight.set(name, entry);
      freeSlot(); // now counted in inflight
      showStatus();
      const started = Date.now();
      // The send's `runs` is pi's count before this prompt: waiting past it
      // catches the run even if it settled before this wait started.
      const waiting = mu(
        [
          "agent",
          "wait",
          name,
          "-w",
          W,
          "--json",
          "--timeout",
          String(timeoutS),
          "--after-runs",
          String(runs),
        ],
        entry.abort.signal,
      );
      const settle = async (r: MuResult) => {
        const delivery = ++deliverySeq;
        arriving.set(delivery, false);
        forget(name);
        try {
          await deliver(
            name,
            r,
            keep,
            {
              timeoutS,
              elapsedMs: Date.now() - started,
              ...(queuedAs ? { queuedAs } : {}),
              ...(attach ? { attach } : {}),
              ...(workspace ? { workspace } : {}),
            },
            delivery,
            entry.record,
          );
          if (arriving.has(delivery)) arriving.set(delivery, true);
        } catch (e) {
          // A throw here would be an unhandled rejection and a lost answer.
          await Promise.resolve(
            pi.sendMessage(
              {
                customType: DELEGATE_MESSAGE_TYPE,
                content: `Delegate ${W}/${name} settled, but delivering its answer failed: ${e instanceof Error ? e.message : String(e)}. Read it with: mu agent read ${name} -n 50 -w ${W}`,
                display: true,
                details: { name, workstream: W, outcome: null, closed: false, delivery },
              },
              { deliverAs: "followUp", triggerTurn: true },
            ),
          ).catch(() => {
            // Nothing will arrive: stop counting it.
            arriving.delete(delivery);
            showStatus();
          });
        }
      };
      void waiting.then(async (r) => {
        if (inflight.get(name) !== entry) return; // cancelled or shut down
        if (entry.cancelling) entry.parked = () => settle(r);
        else await settle(r);
      });
      const lines = [
        `Delegated to ${W}/${name}. Its answer arrives as a follow-up message when it finishes; do not wait or poll.`,
        workspace ? `Workspace: ${workspace}` : undefined,
        attach ? `Attach: ${attach}` : undefined,
        `Cancel: ${DELEGATE_CANCEL_TOOL} { name: "${name}" }`,
      ].filter((x) => x !== undefined);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          name,
          workstream: W,
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

  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "mu delegate",
    description: `Subagent: run one self-contained task in a fresh pi agent (its own mux pane in mu's ${W} workstream) while you keep working. Use it whenever you would reach for a subagent: research, a review, a draft, an investigation, or a refuter of a claim, plan or fix before you act on it; call it several times to fan out in parallel (at most ${delegateMax()} run at once; up to ${DELEGATE_QUEUE_FACTOR * delegateMax()} more are queued and start as slots free). The subagent starts with no context, in your working directory: put everything it needs in task. The call returns at once and the answer arrives later as a follow-up message: carry on with other work, or end your turn if your next step needs the answer (the follow-up resumes you). The pane closes after a clean finish; keep: true leaves it open. When the check judges a mu task, set record so its verdict lands on that task; leave it out when there is no task.`,
    promptSnippet:
      "Subagent: delegate a self-contained task to a background pi agent; its answer arrives later as a follow-up",
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
            "Working directory for the delegate (default: yours; ignored with workspace)",
        },
        timeout: {
          type: "number",
          exclusiveMinimum: 0,
          description: `Seconds to wait for the answer (default ${DELEGATE_TIMEOUT_S}). On timeout you get a "still running" follow-up instead of the answer, and the answer will not arrive later; the subagent keeps running in its pane.`,
        },
        workspace: {
          type: "boolean",
          description:
            "For tasks that edit files: its own VCS checkout (jj workspace / git worktree / sl share) branched from the current commit. The result and follow-up name the path; changes stay there until you merge them. This isolates repository edits only: the subagent runs as you, with your files, environment and network.",
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
          description: "Keep the pane after it finishes, to talk to it again",
        },
        record: {
          type: "object",
          description:
            "When the answer arrives, write its VERDICT/EVIDENCE onto this task as a note (for a check that judges a mu task; omit with no task); task may be <ws>/<task>.",
          properties: {
            task: { type: "string" },
            workstream: { type: "string" },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      track(ctx);
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) throw new Error("mu_delegate needs a non-empty task");
      const t = params.timeout;
      if (t !== undefined && !(typeof t === "number" && Number.isFinite(t) && t > 0))
        throw new Error(
          `mu_delegate: timeout must be a positive number of seconds (got ${JSON.stringify(t)})`,
        );
      if (params.workspace !== true) {
        const cwd =
          typeof params.cwd === "string" && params.cwd ? params.cwd : (ctx?.cwd ?? process.cwd());
        if (!isDir(cwd)) throw new Error(`mu_delegate: cwd ${cwd} is not a directory`);
      }
      const m = params.model;
      if (m !== undefined && !(typeof m === "string" && MODEL_RE.test(m)))
        throw new Error(
          `mu_delegate: model must be a pi model id like 'provider/id:thinking' (got ${JSON.stringify(m)})`,
        );
      const record = await resolveRecord(params.record);
      // Count slots synchronously, before any await: parallel calls in one
      // turn all run this line before the first spawn returns.
      const max = delegateMax();
      if (inflight.size + starting < max) {
        starting++;
        return start(params, signal, ctx, undefined, record);
      }
      // Full: queue up to DELEGATE_QUEUE_FACTOR caps' worth; past that, refuse.
      if (queue.length >= DELEGATE_QUEUE_FACTOR * max)
        throw new Error(
          `mu_delegate: ${inflight.size + starting} running and ${queue.length} queued (MU_DELEGATE_MAX=${max}). End your turn; issue the rest as answers arrive (each answer resumes you).`,
        );
      const handle = `queued-${++queueSeq}`;
      queue.push({
        handle,
        params: {
          ...params,
          cwd:
            typeof params.cwd === "string" && params.cwd ? params.cwd : (ctx?.cwd ?? process.cwd()),
        },
        ctx,
        ...(record ? { record } : {}),
      });
      showStatus();
      return {
        content: [
          {
            type: "text",
            text: `Queued as ${handle} (#${queue.length}; ${inflight.size + starting} running, MU_DELEGATE_MAX=${max}). It starts when a slot frees, and its answer arrives as a follow-up message like any delegate's; do not wait or poll. Cancel: ${DELEGATE_CANCEL_TOOL} { name: "${handle}" }`,
          },
        ],
        details: { name: handle, workstream: W, queued: true, position: queue.length },
      };
    },
  });

  pi.registerTool({
    name: DELEGATE_CANCEL_TOOL,
    label: "mu delegate cancel",
    description: `Stop a delegate started by ${DELEGATE_TOOL}: abort its turn and close its pane (keep: true leaves the pane open). No follow-up message is sent for it afterwards.`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Delegate name, e.g. delegate-1" },
        keep: { type: "boolean", description: "Leave the pane open after aborting" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      track(ctx);
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) throw new Error("mu_delegate_cancel needs a name");
      const qi = queue.findIndex((q) => q.handle === name);
      if (qi >= 0) {
        const [q] = queue.splice(qi, 1);
        showStatus();
        const recorded = q?.record
          ? ` ${await writeRecord(q.record, name, recordNote(recordLabel(q.params, name), name, "cancelled", undefined, 0))}`
          : "";
        return {
          content: [
            { type: "text", text: `Dropped ${name} from the queue; it never started.${recorded}` },
          ],
          details: { name, workstream: W },
        };
      }
      const entry = inflight.get(name);
      if (entry) entry.cancelling = true;
      const ab = await mu(["agent", "abort", name, "-w", W]);
      if (ab.code !== 0) {
        // Not cancelled after all: keep waiting, or deliver what settled meanwhile.
        if (entry) {
          entry.cancelling = false;
          const parked = entry.parked;
          entry.parked = undefined;
          if (parked) void parked();
        }
        throw failure(`mu agent abort ${W}/${name}`, ab);
      }
      if (entry) {
        entry.abort.abort();
        forget(name);
      }
      failed.delete(name);
      let text = `Aborted ${W}/${name}.`;
      if (entry?.record)
        text += ` ${await writeRecord(entry.record.target, name, recordNote(entry.record.label, name, "cancelled", undefined, 0))}`;
      if (params.keep === true) text += " Pane kept.";
      else {
        const c = await mu(["agent", "close", name, "-w", W]);
        text +=
          c.code === 0
            ? " Pane closed."
            : ` Pane kept: close refused: ${(c.stderr || c.stdout).trim()}`;
      }
      return { content: [{ type: "text", text }], details: { name, workstream: W } };
    },
  });

  // A follow-up enters the conversation at its message_start: at once
  // when pi is idle, or when the running turn drains its follow-ups.
  pi.on("message_start", (e) => {
    const m = (e as { message?: { role?: unknown; customType?: unknown; details?: unknown } })
      .message;
    if (m?.role !== "custom" || m.customType !== DELEGATE_MESSAGE_TYPE) return;
    const id = (m.details as { delivery?: unknown } | undefined)?.delivery;
    if (typeof id === "number" && arriving.delete(id)) showStatus();
  });

  // Escape clears pi's follow-up queue along with the run: answers that
  // were queued in it never arrive, so stop counting them.
  pi.on("agent_settled", (e) => {
    if ((e as { aborted?: unknown }).aborted !== true) return;
    let dropped = false;
    for (const [id, queued] of arriving)
      if (queued) {
        arriving.delete(id);
        dropped = true;
      }
    if (dropped) showStatus();
  });

  // The watchers die with this runtime (/reload, /new, quit): say which
  // delegates lose their callback, so none is lost silently. The names
  // are also in the tool results, and `mu agent wait` recovers them.
  pi.on("session_shutdown", (_e, ctx) => {
    if (arriving.size > 0) {
      // Answers still being delivered or queued die with this runtime.
      arriving.clear();
      showStatus();
    }
    if (inflight.size === 0 && queue.length === 0) return;
    const names = [...inflight.keys()];
    const never = queue.splice(0).map((q) => q.handle);
    for (const e of inflight.values()) e.abort.abort();
    inflight.clear();
    showStatus();
    ui = undefined;
    const parts: string[] = [];
    if (names.length > 0)
      parts.push(
        `${names.length} delegate${names.length === 1 ? "" : "s"} still running: ${names.join(", ")}. Their answers will not come back here; use mu agent wait <name> -w ${W} --json.`,
      );
    if (never.length > 0)
      parts.push(`${never.length} queued, never started: ${never.join(", ")}. Re-issue them.`);
    const msg = parts.join(" ");
    if (ctx?.hasUI && ctx.ui) ctx.ui.notify(msg, "warning");
    else process.stderr.write(`mu: ${msg}\n`);
  });
}
