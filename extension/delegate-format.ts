/**
 * The pure wording of the mu_delegate tool: the follow-up message for one
 * finished wait, the note left when Escape drops answers, and the copies of
 * a delegate's partial text. Split from delegate.ts (the runtime) so each
 * stays under the file cap; delegate.ts re-exports all of it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatElapsed } from "../src/delegate-verdict.js";
import { defaultCacheDir } from "../src/state-dir.js";

/** The reserved workstream delegates run in. */
export const DELEGATE_WORKSTREAM = "scratch";
const W = DELEGATE_WORKSTREAM;
/** Default `mu agent wait --timeout` for a delegate, in seconds. */
export const DELEGATE_TIMEOUT_S = 3600;

export { formatElapsed };

/** One agent row of `mu agent wait --json`, as far as the tool reads it. */
export type WaitAgent = {
  outcome?: string;
  lastText?: string;
  lastError?: string;
  /** The delegate's pi session file (mu ≥ 3.11.2 on the delegate side). */
  sessionFile?: string;
  /** outcome `blocked`: the extension dialog the delegate's pi waits on. */
  blocked?: { kind?: string; title?: string };
  /** The run baseline the wait counted from; a re-wait passes it as
   *  `--after-runs` so a run that settles in between is not missed. */
  afterRuns?: number;
};

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
  /** The workstream the delegate runs in (default `scratch`). */
  workstream?: string;
  /** The delegate task (`<workstream>/<task>`): its report holds the full answer. */
  task?: string;
  /** The queue handle the caller was given (`queued-3`), if it was queued. */
  queuedAs?: string;
  /** The delegate's pi session file: the full transcript. */
  sessionFile?: string;
  /** A local copy of the delegate's last assistant text so far. */
  partial?: string;
};

/**
 * Text of the last assistant message in a pi session file (JSONL), or
 * undefined when there is none or the file cannot be read. A delegate
 * that timed out, died or was cancelled has no final answer, but what it
 * wrote so far is here.
 */
export function lastAssistantTextIn(sessionFile: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"assistant"')) continue;
    try {
      const e = JSON.parse(line) as { message?: { role?: unknown; content?: unknown } };
      if (e.message?.role !== "assistant") continue;
      const c = e.message.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .map((p: unknown) => {
                  const q = p as { type?: unknown; text?: unknown };
                  return q.type === "text" && typeof q.text === "string" ? q.text : "";
                })
                .join("")
            : "";
      if (text.trim()) return text;
    } catch {
      // a torn last line while pi writes: keep looking
    }
  }
  return undefined;
}

/** Where to look next for a delegate with no final answer: the copy of
 *  its partial text and its session file, one line each. */
export function evidenceLines(x: { sessionFile?: string; partial?: string }): string[] {
  return [
    x.partial ? `Partial answer so far: ${x.partial}` : undefined,
    x.sessionFile ? `Session: ${x.sessionFile}` : undefined,
  ].filter((v) => v !== undefined);
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
  const W = x.workstream ?? DELEGATE_WORKSTREAM;
  const who = `Delegate ${W}/${name}${x.queuedAs ? ` (queued as ${x.queuedAs})` : ""}`;
  const took = x.elapsedMs !== undefined ? ` after ${formatElapsed(x.elapsedMs)}` : "";
  const fate = pane.closed ? "Pane closed." : `Pane kept (${pane.why}).`;
  const look = [
    x.attach ? `Attach: ${x.attach}` : undefined,
    `Read: mu agent read ${name} -n 50 -w ${W}`,
  ].filter((v) => v !== undefined);
  const tailBlock = x.tail?.trim() ? `\n\nPane tail:\n${x.tail.trimEnd()}` : "";
  const ws = x.workspace ? ` Workspace: ${x.workspace}` : "";
  const ev = evidenceLines(x);
  const evBlock = ev.length > 0 ? `\n${ev.join("\n")}` : "";
  switch (agent?.outcome) {
    case "done":
      return `${who} finished${took}. ${fate}${ws}\n\n${agent.lastText ?? ""}`;
    case "empty":
      return `${who} finished${took} without a text answer. ${fate}${ws}${evBlock}${tailBlock}`;
    case "error":
      return [
        `${who} stopped on an API error${took}, after pi's own retries: ${(agent.lastError ?? "unknown error").replace(/[.\s]+$/, "")}. ${fate}${ws}`,
        "Decide: re-issue the call, or record the check as UNVERIFIED.",
        ...ev,
        ...look,
        `Close: mu agent close ${name} -w ${W}`,
      ].join("\n");
    case "died":
      return `${who} died${took} before answering. ${fate}${ws}${evBlock}${tailBlock}`;
    case "blocked": {
      const b = agent.blocked;
      const dialog = `${b?.kind ?? "dialog"}${b?.title ? ` "${b.title}"` : ""}`;
      const lines = [
        `${who} is blocked on a ${dialog} dialog${took} and has NOT finished; stopped waiting, so its answer will not arrive here. ${fate}${ws}`,
        "Answer the dialog in its pane (attach), then wait again; or close it and record the check as UNVERIFIED.",
        ...ev,
        ...look,
        `Wait again: mu agent wait ${name} -w ${W} --json${agent.afterRuns !== undefined ? ` --after-runs ${agent.afterRuns}` : ""}`,
        `Close: mu agent close ${name} -w ${W}`,
      ];
      return `${lines.join("\n")}${tailBlock}`;
    }
    case "timeout":
    case "pending":
      return [
        `${who} is still running after ${timeoutS}s; stopped waiting, so its answer will not arrive here. ${fate}${ws}`,
        ...ev,
        ...look,
        `Wait again: mu agent wait ${name} -w ${W} --json${agent.afterRuns !== undefined ? ` --after-runs ${agent.afterRuns}` : ""}`,
      ].join("\n");
    default:
      return `${who}: mu agent wait gave no result. ${fate}${ws}${evBlock}${tailBlock}`;
  }
}

/** A finished delegate whose answer an aborted run dropped from pi's queue. */
export type DroppedAnswer = {
  name: string;
  outcome?: string;
  elapsedMs?: number;
  /** The local copy of the follow-up message, if writing it worked. */
  copy?: string;
  sessionFile?: string;
  /** Default `scratch`. */
  workstream?: string;
};

/** Where dropped answers are copied: `<mu cache dir>/delegate-answers`.
 *  Cache, not state: the delegate's pi session file keeps the answer. */
export function droppedAnswersDir(): string {
  return join(defaultCacheDir(), "delegate-answers");
}

/**
 * The note left in the conversation when Escape drops queued answers:
 * one line per delegate, pointing at the local copy and the delegate's
 * own session file. Pure.
 */
export function droppedNote(dropped: readonly DroppedAnswer[]): string {
  const n = dropped.length;
  const lines = dropped.map((d) => {
    const how = [
      d.outcome ?? "no result",
      d.elapsedMs !== undefined ? formatElapsed(d.elapsedMs) : undefined,
    ]
      .filter((x) => x !== undefined)
      .join(", ");
    const where = [
      d.copy ? `answer: ${d.copy}` : undefined,
      d.sessionFile ? `session: ${d.sessionFile}` : undefined,
    ].filter((x) => x !== undefined);
    const ws = d.workstream ?? W;
    if (where.length === 0) where.push(`read: mu agent read ${d.name} -n 50 -w ${ws}`);
    return `- ${ws}/${d.name} (${how}) ${where.join(" · ")}`;
  });
  return [
    `The interrupt dropped ${n} delegate answer${n === 1 ? "" : "s"} before ${n === 1 ? "it" : "they"} arrived:`,
    ...lines,
    "The answer file holds the message that would have arrived; in a session file the answer is the last assistant message.",
  ].join("\n");
}
