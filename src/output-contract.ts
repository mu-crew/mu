// mu-next wire contract: the one JSON document a `--json` invocation prints.
//
//   success  {"ok":true,"data":<payload>,"next":null}
//   failure  {"ok":false,"error":<class>,"message":<one line>,"next":null,"exit":<n>}
//
// Both go to STDOUT (a failure with the real non-zero exit), so
// `2>/dev/null` loses nothing. NDJSON log rows are not enveloped.
//
// Pure: no I/O, no mux, no DB. cli.ts (emitJson) and cli/handle.ts
// (emitError) are the only writers.

/** A follow-up plan: `seq` runs in order and is never truncated; `alt` offers alternatives. */
export type NextPlan = { mode: "seq" | "alt"; commands: string[] } | null;

export type Envelope<T> =
  | { ok: true; data: T; next: NextPlan }
  | {
      ok: false;
      error: string;
      message: string;
      next: NextPlan;
      /** The real process exit code that follows. */
      exit: number;
      /** Structured receipts kept beside the fixed keys (msgId, incarnation, delivery, usage…). */
      extra?: Record<string, unknown>;
      /** Partial evidence the failed verb already produced (a spawn whose --send failed). */
      data?: T;
    };

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const SGR = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(SGR, "");

/**
 * Re-escape the characters JSON.stringify leaves raw but a terminal or line
 * tool treats specially (DEL, C1 controls incl. 8-bit CSI/NEL, bidi controls,
 * U+2028/9) as `\uXXXX` JSON escapes: still valid, lossless JSON, one inert line.
 */
export function safeJsonLine(json: string): string {
  return json.replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * One line of JSON, no trailing newline, inert (see safeJsonLine). Every JSON
 * document goes through here, so a size measured on this string is the size emitted.
 * Error text is ANSI-free; `extra` never shadows a fixed key.
 */
export function encodeEnvelope<T>(envelope: Envelope<T>): string {
  return safeJsonLine(encodeEnvelopeRaw(envelope));
}

function encodeEnvelopeRaw<T>(envelope: Envelope<T>): string {
  if (envelope.ok) {
    return JSON.stringify({ ok: true, data: envelope.data, next: envelope.next });
  }
  const { extra, data } = envelope;
  const doc: Record<string, unknown> = {
    ok: false,
    error: stripAnsi(envelope.error),
    message: stripAnsi(envelope.message),
    next: envelope.next,
    exit: envelope.exit,
  };
  for (const [k, v] of Object.entries(extra ?? {})) if (!(k in doc)) doc[k] = v;
  if (data !== undefined && !("data" in doc)) doc.data = data;
  return JSON.stringify(doc);
}

/** True only for an explicit success envelope: exactly `ok:true`, `data`, `next`. Never sniffs `data.ok`. */
export function isEnvelope(value: unknown): value is Extract<Envelope<unknown>, { ok: true }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 3 &&
    (value as { ok?: unknown }).ok === true &&
    "data" in value &&
    "next" in value
  );
}

/** Wrap a payload as a success envelope exactly once (an envelope passes through). */
export function okEnvelope<T>(data: T): Extract<Envelope<T>, { ok: true }> {
  if (isEnvelope(data)) return data as Extract<Envelope<T>, { ok: true }>;
  return { ok: true, data, next: null };
}

/** Default byte budget for one result. */
export const RESULT_BYTES = 4096;
