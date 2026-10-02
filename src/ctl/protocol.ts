/**
 * mu control socket protocol: JSON lines over a unix socket, one request
 * per connection. Shared by mu's client and the mu pi extension, so this
 * file imports nothing from mu — the extension loads it standalone.
 */

export const CTL_PROTOCOL_VERSION = 1;

export type CtlState = "busy" | "idle" | "needs_input";

export type CtlRequest =
  | { op: "hello" }
  | { op: "status" }
  | { op: "send"; text: string; mode?: "steer" | "followUp" }
  | { op: "wait"; afterRuns?: number; timeoutMs?: number }
  | { op: "abort" }
  /** New session + prompt as one operation. Refused with error "busy" unless force. */
  | { op: "fresh"; text: string; force?: boolean };

export type CtlStatus = { state: CtlState; since: number; runs: number; pending: boolean };

export type CtlReply =
  | ({ v: 1; ok: true } & Partial<CtlStatus> & {
        agent?: string;
        workstream?: string;
        piVersion?: string;
      })
  | { v: 1; ok: false; error: string };

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
