// What the eval observer hook (hook-observer.ts) recorded: one normalised record per hook event of
// every hook-harness agent, real or fake, in <workers>/hooks.log. Judges read harness-level facts
// here (which harness an agent ran, when its turns started and stopped, an interrupt, the text a
// turn ended with), never from a fake's own logs, so the same judge holds on a live run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "./types.ts";

export type HookKind =
  | "session_start"
  | "prompt"
  | "stop"
  | "failed"
  | "interrupt"
  | "session_end"
  | "text"
  | "other";

export interface HookRec {
  ms: number;
  harness: string;
  /** The native event name. */
  event: string;
  kind: HookKind;
  /** The mu agent (env, else mu's anchor); null when neither names one. */
  agent: string | null;
  /** The eval ssh host the hook ran on; null: this machine. */
  host: string | null;
  cwd: string;
  session: string | null;
  /** The turn (codex, muse), generation (cursor-agent) or prompt id (claude). */
  turn: string | null;
  /** prompt: the submitted text; stop/text: the turn's last text (capped). */
  text: string | null;
  /** stop: the turn was resumed by a Stop block. */
  resumed: boolean;
  /** The model the payload names (`model`), when it names one: a cursor-agent or Muse AUT's family (E2). */
  model?: string;
  /** Muse's `model_provider`, when the payload names one. */
  provider?: string;
}

const CAP = 2000;

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** One hook payload as a record. Pure; never copies a field outside the record (no account data). */
export function observerRecord(
  harness: string,
  body: unknown,
  meta: { ms: number; agent: string | null; host: string | null; cwd: string },
): HookRec {
  const p = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const event = str(p.hook_event_name) ?? "?";
  let kind: HookKind = "other";
  let text: string | null = null;
  if (/^session_?start$/i.test(event)) kind = "session_start";
  else if (event === "UserPromptSubmit" || event === "beforeSubmitPrompt") {
    kind = "prompt";
    text = str(p.prompt);
  } else if (event === "Stop") {
    kind = "stop";
    text = str(p.last_assistant_message);
  } else if (event === "stop") {
    kind = p.status === "aborted" ? "interrupt" : p.status === "error" ? "failed" : "stop";
  } else if (event === "StopFailure") kind = "failed";
  else if (event === "Interrupt") kind = "interrupt";
  else if (/^session_?end$/i.test(event)) kind = "session_end";
  else if (event === "afterAgentResponse") {
    kind = "text";
    text = str(p.text);
  }
  // codex's hidden title-generation session (transcript_path null) fires its own prompt and stop
  // beside the worker's turn: mu and murmur drop it (D6), and so does the judge
  if (harness === "codex" && "transcript_path" in p && p.transcript_path === null) kind = "other";
  const resumed =
    p.stop_hook_active === true || (typeof p.loop_count === "number" && p.loop_count > 0);
  const model = str(p.model);
  const provider = str(p.model_provider);
  return {
    ms: meta.ms,
    harness,
    event,
    kind,
    agent: meta.agent,
    host: meta.host,
    cwd: str(p.cwd) ?? meta.cwd,
    session: str(p.session_id) ?? str(p.conversation_id),
    turn: str(p.turn_id) ?? str(p.generation_id) ?? str(p.prompt_id),
    text: text === null ? null : text.slice(0, CAP),
    resumed,
    ...(model !== null ? { model: model.slice(0, 200) } : {}),
    ...(provider !== null ? { provider: provider.slice(0, 200) } : {}),
  };
}

export function parseHookLog(text: string): HookRec[] {
  return text.split("\n").flatMap((l) => {
    if (l.trim() === "") return [];
    try {
      const r = JSON.parse(l) as HookRec;
      return typeof r.ms === "number" && typeof r.kind === "string" ? [r] : [];
    } catch {
      return [];
    }
  });
}

/** Every observed hook event of the run, in time order. */
export function hookRecords(sb: Sandbox): HookRec[] {
  const f = join(sb.workerDir, "hooks.log");
  return existsSync(f) ? parseHookLog(readFileSync(f, "utf8")).sort((a, b) => a.ms - b.ms) : [];
}

/** The harness an agent's hooks reported as, or null when none fired for it (a pi worker, a dead one). */
export function harnessOf(recs: HookRec[], agent: string): string | null {
  return recs.find((r) => r.agent === agent)?.harness ?? null;
}

/** The prompts an agent's harness accepted, in order. */
export const promptsTo = (recs: HookRec[], agent: string): HookRec[] =>
  recs.filter((r) => r.agent === agent && r.kind === "prompt");

/** The turns an agent finished (its stop events, a Stop-block continuation included), in order. */
export const stopsOf = (recs: HookRec[], agent: string): HookRec[] =>
  recs.filter((r) => r.agent === agent && r.kind === "stop");

/**
 * The time an agent's harness last finished a turn whose text matched `re` (cursor-agent's text
 * arrives in its own event), or null.
 */
export function reportedAt(recs: HookRec[], agent: string, re: RegExp): number | null {
  const hits = recs.filter(
    (r) => r.agent === agent && (r.kind === "stop" || r.kind === "text") && re.test(r.text ?? ""),
  );
  const last = hits[hits.length - 1];
  return last === undefined ? null : last.ms;
}

/**
 * A model id that says which model runs: not empty, and not a harness's own pick (`default`,
 * cursor-agent's `auto`, which routes to any vendor's model) or the eval's faux model.
 */
export function namesModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m !== "" && m !== "default" && m !== "auto" && !m.startsWith("evalfaux/");
}

/**
 * Model family of a harness, for a cross-family rule: claude is Anthropic's, codex OpenAI's. A
 * cursor-agent or Muse Code model is any vendor's: its family is its model's vendor, and `unknown`
 * when the model names no vendor (cursor-agent's `auto`, either's default, or an in-house id such
 * as the ones Muse reports, U0).
 */
export function harnessFamily(harness: string, model = ""): string {
  if (harness === "claude") return "anthropic";
  if (harness === "codex") return "openai";
  if (harness === "muse" || harness === "cursor-agent") return vendorFamily(model);
  return modelFamily(model);
}

/** The vendors whose model ids modelFamily recognises. */
export const VENDOR_FAMILIES = ["anthropic", "openai", "google"] as const;

/** A model id's vendor (modelFamily) when it names one of VENDOR_FAMILIES, else `unknown`. */
export function vendorFamily(model: string): string {
  if (!namesModel(model)) return "unknown";
  const f = modelFamily(model);
  return (VENDOR_FAMILIES as readonly string[]).includes(f) ? f : "unknown";
}

/** Model family of a model id: `anthropic/claude-x` and `claude-x` are anthropic, `gpt-*` openai. */
export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(m)) return "anthropic";
  if (/gpt|openai|codex|\bo\d/.test(m)) return "openai";
  if (/gemini|google/.test(m)) return "google";
  return m.split("/")[0] || "unknown";
}
