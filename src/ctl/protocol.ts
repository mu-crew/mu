/**
 * mu control socket protocol: JSON lines over a unix socket, one request
 * per connection. Shared by mu's client and the mu pi extension, so this
 * file imports nothing from mu — the extension loads it standalone.
 */

export const CTL_PROTOCOL_VERSION = 1;

export type CtlState = "busy" | "idle";

/**
 * pi is waiting on a blocking extension dialog (ui_prompt_start without
 * its ui_prompt_end): a confirm, select, input, editor or custom prompt.
 * `kind` and `title` are the innermost open dialog's; `since` is when the
 * first one opened (ms epoch).
 */
export type CtlBlocked = { kind: string; title?: string; since: number };

export type CtlRequest =
  | { op: "hello" }
  /** With msgId, also reply `msg`: whether this extension accepted that send/fresh/interrupt. */
  | { op: "status"; msgId?: string }
  /**
   * `msgId` (send, fresh, interrupt; a string of 1-CTL_MSGID_MAX_LENGTH
   * characters) lets the caller ask `status` later whether the request
   * was accepted, when no reply arrived.
   */
  | { op: "send"; text: string; mode?: "steer" | "followUp"; msgId?: string }
  /**
   * Resolve once a run past afterRuns settles. With returnOnBlocked, also
   * resolve (ended "blocked", runs unchanged) when a dialog is open or
   * opens. Older extensions ignore the flag and hold until the settle.
   */
  | {
      op: "wait";
      afterRuns?: number;
      timeoutMs?: number;
      returnOnBlocked?: boolean;
      /** Refused at once (INCARNATION_MISMATCH) when it is not the extension's current one. */
      incarnation?: string;
    }
  | { op: "abort" }
  /**
   * Make a busy pi act on `text` now: abort the running turn, wait for
   * agent_settled (up to timeoutMs), then send `text` as a new run. Idle:
   * just send. Replies `timeout` and sends nothing when pi does not settle.
   */
  | { op: "interrupt"; text: string; timeoutMs?: number; msgId?: string }
  /** New session + prompt as one operation. Refused with error "busy" unless force. */
  | { op: "fresh"; text: string; force?: boolean; msgId?: string }
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

/**
 * Optional capabilities, listed in the `hello` reply's `features`. Ops stay
 * as they are: a feature is a field an old client never sends and ignores.
 */
export const CTL_FEATURES = ["incarnation", "msgId"] as const;
export type CtlFeature = (typeof CTL_FEATURES)[number];

/** How many accepted msgIds the extension remembers (oldest evicted). */
export const CTL_MSGID_MEMORY = 64;
/** Longest msgId the extension accepts. */
export const CTL_MSGID_MAX_LENGTH = 64;

/** Error text of a `wait` that named another pi process's incarnation. */
export const INCARNATION_MISMATCH = "incarnation mismatch";

export type CtlStatus = {
  state: CtlState;
  since: number;
  runs: number;
  pending: boolean;
  /** The pi session file (where the transcript is written); absent for an ephemeral pi or an older extension. */
  sessionFile?: string;
  /** Set while pi waits on an extension dialog; absent from older extensions. */
  blocked?: CtlBlocked;
};

export type CtlReply =
  | ({ v: 1; ok: true } & Partial<CtlStatus> & {
        agent?: string;
        workstream?: string;
        piVersion?: string;
        /** hello only: the ops this extension serves. Absent: predates reporting. */
        ops?: string[];
        /** hello only: the optional features this extension serves. Absent: none. */
        features?: string[];
        /**
         * hello, status, send, fresh, interrupt, wait: minted once per pi
         * process per socket; stable across /new and /reload, new after pi
         * restarts. Absent from older extensions.
         */
        incarnation?: string;
        /** status with msgId only: whether that msgId was accepted, and the reply's `runs`/time if so. */
        msg?: { id: string; accepted: boolean; runs?: number; at?: number };
        /** hello only: the mu package version the extension was built from. */
        extVersion?: string;
        /** wait only: "blocked" when a dialog ended the wait before a settle (returnOnBlocked). */
        ended?: "settled" | "blocked";
        /** wait only: text of the settled run's final assistant message ("" when none). */
        lastText?: string;
        /** wait only: true when `lastText` lost its head to the 64 KiB tail cap. Absent otherwise. */
        lastTextTruncated?: boolean;
        /** wait only: the error that ended the settled run (retries exhausted). */
        lastError?: string;
        /** wait only: the settled pi's session file, where its full transcript lives. */
        sessionFile?: string;
        /**
         * abort, interrupt: pi was busy, so a turn was aborted. For abort,
         * absent from older extensions (which always call abort).
         */
        wasBusy?: boolean;
      })
  | {
      v: 1;
      ok: false;
      error: string;
      ops?: string[];
      /** With INCARNATION_MISMATCH: the extension's current incarnation. */
      incarnation?: string;
    };

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
