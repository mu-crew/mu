/**
 * mu control socket protocol: JSON lines over a unix socket, one request
 * per connection. Shared by mu's client and the mu pi extension, so this
 * file imports nothing from mu — the extension loads it standalone.
 */

export const CTL_PROTOCOL_VERSION = 1;

export type CtlState = "busy" | "idle";

export type CtlRequest =
  | { op: "hello" }
  | { op: "status" }
  | { op: "send"; text: string; mode?: "steer" | "followUp" }
  | { op: "wait"; afterRuns?: number; timeoutMs?: number }
  | { op: "abort" }
  /**
   * Make a busy pi act on `text` now: abort the running turn, wait for
   * agent_settled (up to timeoutMs), then send `text` as a new run. Idle:
   * just send. Replies `timeout` and sends nothing when pi does not settle.
   */
  | { op: "interrupt"; text: string; timeoutMs?: number }
  /** New session + prompt as one operation. Refused with error "busy" unless force. */
  | { op: "fresh"; text: string; force?: boolean }
  /**
   * Run one of pi's session commands inside pi (sendUserMessage cannot run
   * built-in slash commands). Refused with error "busy" unless force.
   */
  | { op: "command"; name: CtlCommandName; instructions?: string; force?: boolean };

/** Session commands the `command` op runs: `/new`, `/reload`, `/compact`. */
export const CTL_COMMANDS = ["new", "reload", "compact"] as const;
export type CtlCommandName = (typeof CTL_COMMANDS)[number];

/**
 * Every op this protocol defines. The extension reports the ops it serves
 * in its `hello` reply (and in an unknown-op error), so mu can tell an
 * extension loaded by an older pi process from a broken one.
 */
export const CTL_OPS = [
  "hello",
  "status",
  "send",
  "wait",
  "abort",
  "interrupt",
  "fresh",
  "command",
] as const satisfies readonly CtlRequest["op"][];

export type CtlStatus = { state: CtlState; since: number; runs: number; pending: boolean };

export type CtlReply =
  | ({ v: 1; ok: true } & Partial<CtlStatus> & {
        agent?: string;
        workstream?: string;
        piVersion?: string;
        /** hello only: the ops this extension serves. Absent: predates reporting. */
        ops?: string[];
        /** hello only: the mu package version the extension was built from. */
        extVersion?: string;
        /** wait only: text of the settled run's final assistant message ("" when none). */
        lastText?: string;
        /** wait only: the error that ended the settled run (retries exhausted). */
        lastError?: string;
        /** interrupt only: pi was busy, so the turn was aborted before the send. */
        wasBusy?: boolean;
      })
  | { v: 1; ok: false; error: string; ops?: string[] };

/** Error text of a reply to an op the extension does not serve. */
export const UNKNOWN_OP_PREFIX = "unknown op: ";

/** One frame. JSON.stringify escapes "\n" inside strings, so the frame is one line. */
export function encode(msg: object): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Splits a stream into lines on "\n" only (never U+2028/U+2029). */
export class LineDecoder {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts;
  }
}
