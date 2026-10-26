/**
 * The pure wording of a mux-free delegate (no tmux, no herdr): the tool
 * result and the follow-up for one `mu delegates run <call-id> --json`
 * result. The runner (src/delegate-process.ts) has already finished the
 * call durably; this only words what it printed. Split from delegate.ts
 * (the runtime) so each stays under the file cap.
 */
import { formatElapsed } from "../src/delegate-verdict.js";
import type { CallInfo } from "./delegate-calls.js";

/** The fields of a `mu delegates run --json` result (or failure envelope) the tool reads. */
export type ProcessRun = {
  outcome?: string;
  state?: string;
  error?: string;
  message?: string;
  answer?: string;
  sessionFile?: string;
  sessionDir?: string;
  logPath?: string;
  workspace?: string;
};

/** The tool result for a call that now runs as a child pi. */
export function processStarted(call: CallInfo, cancelTool: string) {
  const ws = call.workstream;
  const name = call.task;
  const text = [
    `Delegated to ${ws}/${name} (call ${call.callId}) as a child pi process: no multiplexer, so no pane to attach. Its answer arrives as a follow-up message when it finishes, and stays on the task (mu task notes ${call.task} -w ${ws}); do not wait or poll.`,
    call.request.keep === true
      ? "keep: true needs a multiplexer; the child stops after its answer (its session file stays)."
      : undefined,
    `Cancel: ${cancelTool} { name: "${name}" }`,
  ].filter((x) => x !== undefined);
  return {
    content: [{ type: "text" as const, text: text.join("\n") }],
    details: {
      name,
      workstream: ws,
      task: `${ws}/${call.task}`,
      state: "running",
      call_id: call.callId,
      transport: "process",
      attach: null,
      workspace: null,
      keep: false,
    },
  };
}

/** Why a run sent nothing (refused) or died without a result (finished failed), with the next step. */
export function processFailedText(
  call: CallInfo,
  o: ProcessRun,
  fallback: string,
  code: number,
  reissueTool: string,
): string {
  const reason = (o.error ?? o.message ?? fallback).replace(/[.\s]+$/, "");
  const next =
    o.state === "refused"
      ? `The call is durable and refused: reissue it with ${reissueTool} { call_id: "${call.callId}" }`
      : `\`mu delegates run\` exited ${code} without a result; the call is recorded as failed (mu delegates show ${call.callId})`;
  return `${reason}. ${next} (task ${call.workstream}/${call.task}).`;
}

/** The follow-up head, evidence and body for a run that finished; `recorded` is the recorded line. */
export function processMessage(
  call: CallInfo,
  o: ProcessRun,
  elapsedMs: number,
  recorded: string,
  queuedAs?: string,
): string {
  const who = `Delegate ${call.workstream}/${call.task}${queuedAs ? ` (queued as ${queuedAs})` : ""}`;
  const took = formatElapsed(elapsedMs);
  const done = o.outcome === "done";
  const head = done
    ? `${who} finished after ${took}. Child pi stopped.`
    : `${who} ended ${o.outcome} after ${took}, without an answer. Child pi stopped.`;
  const evidence = [
    o.workspace ? `Workspace: ${o.workspace}` : undefined,
    o.sessionFile
      ? `Session: ${o.sessionFile}`
      : o.sessionDir
        ? `Session dir: ${o.sessionDir}`
        : undefined,
    !done && o.logPath ? `Log: ${o.logPath}` : undefined,
  ].filter((x) => x !== undefined);
  const body = done ? (o.answer ?? "") : (o.error ?? "");
  return [[head, ...evidence].join("\n"), body, recorded].filter((x) => x !== "").join("\n\n");
}
