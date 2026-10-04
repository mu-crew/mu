/**
 * mu pi extension, parent side: the `mu_delegate` tool.
 *
 * A delegate is a scratch agent started for one task. The tool spawns it,
 * hands it the task, returns at once, and posts the answer back into this
 * conversation as a follow-up when the delegate's run settles.
 *
 * Everything is the `mu` CLI (spawn / send / wait --json / read / abort /
 * close): the tool only orders the calls and formats the result, so a
 * shell gets the same delegation (ROADMAP § Pi extension, rule 2). The one
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
  on(event: "session_shutdown", handler: (event: unknown, ctx: DelegateCtx) => unknown): unknown;
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

/** Footer text for `n` running delegates; undefined clears the entry. */
export function delegateStatus(n: number): string | undefined {
  return n > 0 ? `${n} delegate${n === 1 ? "" : "s"} running` : undefined;
}
/** Default `mu agent wait --timeout` for a delegate, in seconds. */
export const DELEGATE_TIMEOUT_S = 3600;
/** Default cap on delegates in flight from one pi session. */
export const DELEGATE_MAX_DEFAULT = 16;

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
export type WaitAgent = { outcome?: string; lastText?: string };

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
  const who = `Delegate ${W}/${name}`;
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

/**
 * One delegate this pi waits on. `cancelling` is set while a cancel's abort
 * is in flight: the abort itself settles the run, so a wait resolving then
 * is parked in `parked` instead of delivered, and delivered after all if
 * the abort fails.
 */
type Inflight = {
  abort: AbortController;
  cancelling: boolean;
  parked?: () => Promise<void>;
};

export function registerDelegate(pi: MuDelegateApi, run: MuRunner = defaultRunner()): void {
  if (!delegateEnabled()) return;
  const inflight = new Map<string, Inflight>();
  /** Calls past the cap check whose delegate is not yet in `inflight`. */
  let starting = 0;
  const reserved = new Set<string>();
  // The ctx of the latest tool call: answers settle outside any call, so
  // the footer is refreshed through the last ctx pi handed us.
  let ui: DelegateCtx["ui"];
  const showStatus = () => {
    try {
      ui?.setStatus?.(DELEGATE_STATUS_KEY, delegateStatus(inflight.size));
    } catch {
      // stale ctx after a session switch: the footer is decoration
    }
  };
  const track = (ctx: DelegateCtx | undefined) => {
    if (ctx?.hasUI !== false && ctx?.ui) ui = ctx.ui;
  };
  /** Drop a delegate from the in-flight set and refresh the footer. */
  const forget = (name: string) => {
    inflight.delete(name);
    reserved.delete(name);
    showStatus();
  };

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

  async function pickName(stem?: string): Promise<string> {
    const r = await mu(["agent", "list", "-w", W, "--json"]);
    const agents = json(r)?.agents;
    const taken = new Set(
      Array.isArray(agents)
        ? agents.map((a: unknown) => (a as { name?: unknown }).name).filter((n) => n)
        : [],
    );
    for (let n = 1; ; n++) {
      // A label names the delegate (delegate-review, then delegate-review-2);
      // without one it is numbered.
      const name = stem
        ? n === 1
          ? `delegate-${stem}`
          : `delegate-${stem}-${n}`
        : `delegate-${n}`;
      if (!taken.has(name) && !reserved.has(name)) {
        reserved.add(name); // sync after the await: parallel calls get distinct names
        return name;
      }
    }
  }

  async function spawn(
    params: Record<string, unknown>,
    cwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ name: string; attach?: string; workspace?: string }> {
    const stem = labelStem(params.label);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const name = await pickName(stem);
      const args = ["agent", "spawn", name, "-w", W, "--json"];
      if (params.workspace === true) args.push("--workspace");
      else if (cwd) args.push("--cwd", cwd);
      if (typeof params.cli === "string" && params.cli) args.push("--cli", params.cli);
      const r = await mu(args);
      if (signal?.aborted && r.code === 0) {
        // The user cancelled while the pane came up: take it down again.
        reserved.delete(name);
        await mu(["agent", "close", name, "-w", W]);
        signal.throwIfAborted();
      }
      // Another mu took the name between list and spawn: pick again.
      if (r.code !== 0 && /already exists/.test(r.stderr) && attempt < 3) {
        reserved.delete(name);
        continue;
      }
      if (r.code !== 0) {
        reserved.delete(name);
        throw failure("mu agent spawn", r);
      }
      const out = json(r) ?? {};
      if (out.ctl !== "ok") {
        reserved.delete(name);
        throw new Error(
          `${W}/${name} spawned but its control socket is ${String(out.ctl)}, so its answer cannot come back. Pane kept; close it with: mu agent close ${name} -w ${W}`,
        );
      }
      const steps = Array.isArray(out.nextSteps) ? out.nextSteps : [];
      const attach = steps
        .map((s: unknown) => s as { intent?: unknown; command?: unknown })
        .find((s) => s.intent === "Attach the pane")?.command;
      const wsPath = (out.workspace as { path?: unknown } | null | undefined)?.path;
      return {
        name,
        ...(typeof attach === "string" ? { attach } : {}),
        ...(typeof wsPath === "string" ? { workspace: wsPath } : {}),
      };
    }
  }

  async function deliver(name: string, wait: MuResult, keep: boolean, extras: MessageExtras) {
    const agent = (json(wait)?.agents as WaitAgent[] | undefined)?.[0];
    const outcome = agent?.outcome;
    const tail =
      outcome === "done" || outcome === "timeout" || outcome === "pending"
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
    await pi.sendMessage(
      {
        customType: DELEGATE_MESSAGE_TYPE,
        content: delegateMessage(name, agent, pane, { ...extras, ...(tail ? { tail } : {}) }),
        display: true,
        details: {
          name,
          workstream: W,
          outcome: outcome ?? null,
          closed: pane.closed,
          answer: outcome === "done" ? (agent?.lastText ?? null) : null,
          elapsedMs: extras.elapsedMs ?? null,
          workspace: extras.workspace ?? null,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "mu delegate",
    description: `Subagent: run one self-contained task in a fresh pi agent (its own mux pane in mu's ${W} workstream) while you keep working. Use it whenever you would reach for a subagent: research, a review, a draft, an investigation; call it several times to fan out in parallel (at most ${delegateMax()} in flight). The subagent starts with no context, in your working directory: put everything it needs in task. The call returns at once and the answer arrives later as a follow-up message: carry on with other work, or end your turn if your next step needs the answer (the follow-up resumes you). The pane closes after a clean finish; keep: true leaves it open.`,
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
            "Agent CLI key (default pi). Name a configured key such as 'pi_fast' to run a cheaper model.",
        },
        keep: {
          type: "boolean",
          description: "Keep the pane after it finishes, to talk to it again",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      track(ctx);
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) throw new Error("mu_delegate needs a non-empty task");
      // Count slots synchronously, before any await: parallel calls in one
      // turn all run this line before the first spawn returns.
      const max = delegateMax();
      if (inflight.size + starting >= max)
        throw new Error(
          `mu_delegate: ${inflight.size + starting} delegates already running (MU_DELEGATE_MAX=${max}). End your turn; issue the rest as answers arrive (each answer resumes you).`,
        );
      starting++;
      let slotHeld = true;
      const freeSlot = () => {
        if (slotHeld) starting--;
        slotHeld = false;
      };
      try {
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
        const { name, attach, workspace } = await spawn(params, cwd, signal);
        const entry: Inflight = { abort: new AbortController(), cancelling: false };
        inflight.set(name, entry);
        freeSlot(); // now counted in inflight
        showStatus();
        const started = Date.now();
        // Start the wait alongside the send: it takes its baseline run count
        // at startup and resolves on the first settle past it. A model turn
        // outlasts a mu process start by orders of magnitude.
        const waiting = mu(
          ["agent", "wait", name, "-w", W, "--json", "--timeout", String(timeoutS)],
          entry.abort.signal,
        );
        const sent = await mu([
          "agent",
          "send",
          name,
          brief ? `${brief}\n\n${task}` : task,
          "-w",
          W,
        ]);
        if (sent.code !== 0) {
          entry.abort.abort();
          forget(name);
          // Nothing reached it: the pane is just an idle pi. Take it down.
          const c = await mu(["agent", "close", name, "-w", W]);
          const pane =
            c.code === 0
              ? "Pane closed."
              : `Pane kept; close it with: mu agent close ${name} -w ${W}`;
          throw new Error(`${failure(`mu agent send to ${W}/${name}`, sent).message}. ${pane}`);
        }
        const settle = async (r: MuResult) => {
          forget(name);
          try {
            await deliver(name, r, keep, {
              timeoutS,
              elapsedMs: Date.now() - started,
              ...(attach ? { attach } : {}),
              ...(workspace ? { workspace } : {}),
            });
          } catch (e) {
            // A throw here would be an unhandled rejection and a lost answer.
            await Promise.resolve(
              pi.sendMessage(
                {
                  customType: DELEGATE_MESSAGE_TYPE,
                  content: `Delegate ${W}/${name} settled, but delivering its answer failed: ${e instanceof Error ? e.message : String(e)}. Read it with: mu agent read ${name} -n 50 -w ${W}`,
                  display: true,
                  details: { name, workstream: W, outcome: null, closed: false },
                },
                { deliverAs: "followUp", triggerTurn: true },
              ),
            ).catch(() => {});
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
        freeSlot();
      }
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
      let text = `Aborted ${W}/${name}.`;
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

  // The watchers die with this runtime (/reload, /new, quit): say which
  // delegates lose their callback, so none is lost silently. The names
  // are also in the tool results, and `mu agent wait` recovers them.
  pi.on("session_shutdown", (_e, ctx) => {
    if (inflight.size === 0) return;
    const names = [...inflight.keys()];
    for (const e of inflight.values()) e.abort.abort();
    inflight.clear();
    showStatus();
    ui = undefined;
    const msg = `${names.length} delegate${names.length === 1 ? "" : "s"} still running: ${names.join(", ")}. Their answers will not come back here; use mu agent wait <name> -w ${W} --json.`;
    if (ctx?.hasUI && ctx.ui) ctx.ui.notify(msg, "warning");
    else process.stderr.write(`mu: ${msg}\n`);
  });
}
