/**
 * The pure wording of the mu_delegate tool: the words for one finished wait
 * (recorded as the report of a run with no answer; sent whole only when the
 * record failed), the wake, and the note left when Escape drops wakes. Split
 * from delegate.ts (the runtime) so each stays under the file cap;
 * delegate.ts re-exports all of it.
 */
import { readFileSync } from "node:fs";
import { formatElapsed } from "../src/delegate-verdict.js";

/** The reserved workstream delegates run in. */
export const DELEGATE_WORKSTREAM = "scratch";
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

/** Where to look next for a delegate with no final answer: its session file. */
export function evidenceLines(x: { sessionFile?: string }): string[] {
  return x.sessionFile ? [`Session: ${x.sessionFile}`] : [];
}

/**
 * The words for one finished wait. Pure: the CLI already
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

/** One recorded answer a wake points at. */
export type WakeAnswer = {
  callId: string;
  name: string;
  workstream: string;
  /** The delegate task's local id: its report is the full answer. */
  task: string;
  outcome: string;
  verdict?: string;
  /** `<ws>/<task>` its verdict was recorded on. */
  record?: string;
  /** Why the pane was kept (it is evidence), when it was. */
  kept?: string;
};

/** A wake an aborted run dropped: the answer it pointed at. */
export type DroppedWake = WakeAnswer;

function answerLine(a: WakeAnswer): string {
  const how = [a.outcome, a.verdict, a.record ? `recorded on ${a.record}` : undefined]
    .filter((x) => x !== undefined)
    .join(", ");
  const pane = a.kept
    ? ` Pane kept (${a.kept}): mu agent read ${a.name} -n 50 -w ${a.workstream}.`
    : "";
  return `- ${a.workstream}/${a.name} (${how}; call ${a.callId}): mu task notes ${a.task} -w ${a.workstream}.${pane}`;
}

/**
 * The wake: a one-line pointer per recorded answer, no answer text. It starts a
 * turn whose settle wait shows the reports; a lost or repeated wake loses or
 * repeats nothing. Pure.
 */
export function wakeText(answers: readonly WakeAnswer[]): string {
  const n = answers.length;
  return [
    `${n === 1 ? "A delegate answer is" : `${n} delegate answers are`} recorded; the settle shows ${n === 1 ? "it" : "them"} (or read the report):`,
    ...answers.map(answerLine),
  ].join("\n");
}

/**
 * The note left in the conversation when Escape drops queued wakes (no turn):
 * one line per answer. The reports stay recorded, and the next settle's wait
 * still owes them. Pure.
 */
export function droppedNote(dropped: readonly DroppedWake[]): string {
  const n = dropped.length;
  return [
    `Interrupted: ${n} delegate answer${n === 1 ? "" : "s"} recorded but not shown; the next settle shows ${n === 1 ? "it" : "them"}:`,
    ...dropped.map(answerLine),
  ].join("\n");
}
