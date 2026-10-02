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
import { existsSync } from "node:fs";
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
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

export interface DelegateTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: object;
  execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export type MuResult = { code: number; stdout: string; stderr: string };
/** Runs `mu <args>`. The test seam: tests inject a fake. */
export type MuRunner = (args: readonly string[], signal?: AbortSignal) => Promise<MuResult>;

export const DELEGATE_TOOL = "mu_delegate";
export const DELEGATE_CANCEL_TOOL = "mu_delegate_cancel";
export const DELEGATE_MESSAGE_TYPE = "mu-delegate";
export const DELEGATE_WORKSTREAM = "scratch";
/** `mu agent wait --timeout` for a delegate, in seconds. */
export const DELEGATE_TIMEOUT_S = 3600;
const W = DELEGATE_WORKSTREAM;

/** Registration guards: unmanaged pi, a mux in reach, not switched off. */
export function delegateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MU_MANAGED_AGENT) return false; // no helper-spawns-helper
  if (env.MU_DELEGATE === "0") return false;
  if (env.MU_MUX || env.HERDR_ENV === "1" || env.TMUX || env.TMUX_PANE) return true;
  return onPath("tmux", env) || onPath("herdr", env);
}

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(delimiter).some((d) => d !== "" && existsSync(join(d, bin)));
}

/** The CLI this extension ships with (dist/cli.js next to dist/extension/), else `mu` on PATH. */
function defaultRunner(): MuRunner {
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

/**
 * The follow-up message for one finished wait. Pure: the CLI already
 * classified the outcome (`mu agent wait --json` → `outcome`); this only
 * words it. `tail` is `mu agent read -n 50` for the outcomes without text.
 */
export function delegateMessage(
  name: string,
  agent: WaitAgent | undefined,
  pane: PaneFate,
  tail?: string,
  attach?: string,
): string {
  const who = `Delegate ${W}/${name}`;
  const fate = pane.closed ? "Pane closed." : `Pane kept (${pane.why}).`;
  const look = [
    attach ? `Attach: ${attach}` : undefined,
    `Read: mu agent read ${name} -n 50 -w ${W}`,
  ].filter((x) => x !== undefined);
  const tailBlock = tail?.trim() ? `\n\nPane tail:\n${tail.trimEnd()}` : "";
  switch (agent?.outcome) {
    case "done":
      return `${who} finished. ${fate}\n\n${agent.lastText ?? ""}`;
    case "empty":
      return `${who} finished without a text answer. ${fate}${tailBlock}`;
    case "died":
      return `${who} died before answering. ${fate}${tailBlock}`;
    case "timeout":
    case "pending":
      return [
        `${who} is still running after ${DELEGATE_TIMEOUT_S}s; stopped waiting. ${fate}`,
        ...look,
        `Wait again: mu agent wait ${name} -w ${W} --json`,
      ].join("\n");
    default:
      return `${who}: mu agent wait gave no result. ${fate}${tailBlock}`;
  }
}

type Inflight = { abort: AbortController; cancelled: boolean };

export function registerDelegate(pi: MuDelegateApi, run: MuRunner = defaultRunner()): void {
  if (!delegateEnabled()) return;
  const inflight = new Map<string, Inflight>();
  const reserved = new Set<string>();

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

  async function pickName(): Promise<string> {
    const r = await mu(["agent", "list", "-w", W, "--json"]);
    const agents = json(r)?.agents;
    const taken = new Set(
      Array.isArray(agents)
        ? agents.map((a: unknown) => (a as { name?: unknown }).name).filter((n) => n)
        : [],
    );
    for (let n = 1; ; n++) {
      const name = `delegate-${n}`;
      if (!taken.has(name) && !reserved.has(name)) {
        reserved.add(name); // sync after the await: parallel calls get distinct names
        return name;
      }
    }
  }

  async function spawn(
    params: Record<string, unknown>,
  ): Promise<{ name: string; attach?: string }> {
    for (let attempt = 0; ; attempt++) {
      const name = await pickName();
      const args = ["agent", "spawn", name, "-w", W, "--json"];
      if (params.workspace === true) args.push("--workspace");
      if (typeof params.cli === "string" && params.cli) args.push("--cli", params.cli);
      const r = await mu(args);
      // Another mu took the name between list and spawn: pick again.
      if (r.code !== 0 && /already exists/.test(r.stderr) && attempt < 3) continue;
      if (r.code !== 0) {
        reserved.delete(name);
        throw failure("mu agent spawn", r);
      }
      const out = json(r) ?? {};
      if (out.ctl !== "ok") {
        throw new Error(
          `${W}/${name} spawned but its control socket is ${String(out.ctl)}, so its answer cannot come back. Pane kept; close it with: mu agent close ${name} -w ${W}`,
        );
      }
      const steps = Array.isArray(out.nextSteps) ? out.nextSteps : [];
      const attach = steps
        .map((s: unknown) => s as { intent?: unknown; command?: unknown })
        .find((s) => s.intent === "Attach the pane")?.command;
      return { name, ...(typeof attach === "string" ? { attach } : {}) };
    }
  }

  async function deliver(name: string, wait: MuResult, keep: boolean, attach?: string) {
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
        content: delegateMessage(name, agent, pane, tail, attach),
        display: true,
        details: { name, workstream: W, outcome: outcome ?? null, closed: pane.closed },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  pi.registerTool({
    name: DELEGATE_TOOL,
    label: "mu delegate",
    description: `Hand one self-contained task to a fresh pi agent in its own mux pane (mu's ${W} workstream) and keep working. Returns at once; the delegate's final answer arrives later as a follow-up message, so do not wait or poll for it. Use it for independent side work (research, a review, a draft, an investigation) you would otherwise do serially. The delegate starts with no context: put everything it needs in task. Several calls run in parallel. The pane is closed after a clean finish unless keep is true; the user can attach to it meanwhile.`,
    promptSnippet:
      "Delegate a self-contained task to a background pi agent; its answer arrives later",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete task, with all context it needs" },
        brief: {
          type: "string",
          description: "Optional persona or ground rules, sent before the task",
        },
        workspace: {
          type: "boolean",
          description: "Give it its own VCS workspace (for tasks that edit files)",
        },
        cli: {
          type: "string",
          description: "Agent CLI key; resolves $MU_<CLI>_COMMAND (default pi)",
        },
        keep: {
          type: "boolean",
          description: "Keep the pane after it finishes, to talk to it again",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) throw new Error("mu_delegate needs a non-empty task");
      const brief = typeof params.brief === "string" ? params.brief.trim() : "";
      const keep = params.keep === true;
      const { name, attach } = await spawn(params);
      const entry: Inflight = { abort: new AbortController(), cancelled: false };
      inflight.set(name, entry);
      // Start the wait alongside the send: it takes its baseline run count
      // at startup and resolves on the first settle past it. A model turn
      // outlasts a mu process start by orders of magnitude.
      const waiting = mu(
        ["agent", "wait", name, "-w", W, "--json", "--timeout", String(DELEGATE_TIMEOUT_S)],
        entry.abort.signal,
      );
      const sent = await mu(["agent", "send", name, brief ? `${brief}\n\n${task}` : task, "-w", W]);
      if (sent.code !== 0) {
        entry.abort.abort();
        inflight.delete(name);
        throw failure(`mu agent send to ${W}/${name}`, sent);
      }
      void waiting.then(async (r) => {
        if (inflight.get(name) !== entry || entry.cancelled) return;
        inflight.delete(name);
        reserved.delete(name);
        await deliver(name, r, keep, attach);
      });
      const lines = [
        `Delegated to ${W}/${name}. Its answer arrives as a follow-up message when it finishes; do not wait or poll.`,
        attach ? `Attach: ${attach}` : undefined,
        `Cancel: ${DELEGATE_CANCEL_TOOL} { name: "${name}" }`,
      ].filter((x) => x !== undefined);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { name, workstream: W, attach: attach ?? null, keep },
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
    async execute(_id, params) {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) throw new Error("mu_delegate_cancel needs a name");
      const entry = inflight.get(name);
      if (entry) entry.cancelled = true;
      const ab = await mu(["agent", "abort", name, "-w", W]);
      if (ab.code !== 0) {
        if (entry) entry.cancelled = false;
        throw failure(`mu agent abort ${W}/${name}`, ab);
      }
      entry?.abort.abort();
      inflight.delete(name);
      reserved.delete(name);
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
    const msg = `${names.length} delegate${names.length === 1 ? "" : "s"} still running: ${names.join(", ")}. Their answers will not come back here; use mu agent wait <name> -w ${W} --json.`;
    if (ctx?.hasUI && ctx.ui) ctx.ui.notify(msg, "warning");
    else process.stderr.write(`mu: ${msg}\n`);
  });
}
