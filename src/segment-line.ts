// mu — the segment line: its version rules, framing, encode and decode.
// Split out of segments.ts (1500-LOC cap); segments.ts re-exports the
// public names. Pure: no filesystem, no DB.

import { crc32 } from "node:zlib";

/** The segment line format this build WRITES. Bumped only on a breaking
 *  shape change. */
export const SEGMENT_FORMAT_VERSION = 2;

/** The line versions this build READS. The version is checked per line,
 *  and a line of any other version (v1 included) is REFUSED rather than
 *  guessed at. */
export const SEGMENT_READ_VERSIONS: readonly number[] = [2];

/** One serialized op, as it appears on a line of a segment. */
export interface SegmentLine {
  v: number;
  hlc: string;
  machine: string;
  group: string;
  intent: string | null;
  actor: string | null;
  entity: string;
  key: string;
  op: "put" | "del";
  payload: unknown;
  crc: string;
}

/** Why a segment line was rejected. Reported, never silently swallowed. */
export type SegmentDefectKind =
  | "torn-write"
  | "manifest-mismatch"
  | "crc-mismatch"
  | "non-monotonic-hlc"
  | "unknown-version"
  | "malformed-shape"
  | "entity-not-synced"
  | "duplicate-op";

export interface SegmentDefect {
  kind: SegmentDefectKind;
  /** 1-based line number within the segment. */
  line: number;
  detail: string;
  /** The format version found, for an `unknown-version` defect. */
  version?: number;
}

// ─── framing ──────────────────────────────────────────────────────────

/**
 * Canonical serialization the crc is computed over.
 *
 * Field order is FIXED here rather than taken from object key order, so
 * two machines (or two Node versions) cannot disagree about the bytes and
 * produce a spurious mismatch. `payload` is embedded as its stored JSON
 * TEXT, verbatim, for the same reason: re-serializing a parsed object
 * risks key reordering and number reformatting.
 */
function canonicalBytes(line: Omit<SegmentLine, "crc">, payloadText: string): string {
  return [
    String(line.v),
    line.hlc,
    line.machine,
    line.group,
    line.intent ?? "",
    line.actor ?? "",
    line.entity,
    line.key,
    line.op,
    payloadText,
  ].join("\u001f"); // Unit Separator: cannot occur in any of these fields
}

function computeCrc(line: Omit<SegmentLine, "crc">, payloadText: string): string {
  return crc32(canonicalBytes(line, payloadText)).toString(16).padStart(8, "0");
}

/**
 * `ops.payload` is TEXT that is *usually* JSON but is not guaranteed to
 * be: `appendLog` has always accepted a bare prose payload (entity
 * 'message' via `mu log "text"`), and pre-1.0 rows carry plenty of it.
 * Embedding such text raw produced `"payload":Added 5 tasks, ...` — a
 * line that is not JSON at all, which every later read then reported as
 * a torn write, on every single mu invocation, forever (the segment is
 * regenerated from `ops`, so the repair re-emitted the same bad bytes).
 *
 * So: pass valid JSON through (minus line breaks, see singleLinePayload),
 * and encode anything else as a JSON string. A stored JSON string SCALAR
 * (`mu log '"hello"'`) is encoded too: passed through, it would read back
 * as a string and `storedPayloadFor` could not tell it from wrapped prose.
 */
function payloadTextFor(payload: string): string {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return JSON.stringify(payload);
  }
  if (typeof value === "string") return JSON.stringify(payload);
  return singleLinePayload(payload);
}

/** `payload` with its line breaks removed when it is JSON spanning
 *  several lines, else unchanged (prose keeps its newlines: the segment
 *  JSON-escapes it). Not JSON.stringify(JSON.parse()): that rounds big
 *  numbers and merges duplicate keys. JSON strings cannot hold a raw
 *  CR/LF, so each one, with the whitespace around it, sits between
 *  tokens, and two adjacent JSON tokens are never both literals.
 *
 *  `appendLog` stores new rows this way; the encoder applies it again so
 *  a row stored before that fix still fits on one segment line. */
export function singleLinePayload(payload: string): string {
  if (!/[\r\n]/.test(payload)) return payload;
  try {
    JSON.parse(payload);
  } catch {
    return payload;
  }
  return payload.replace(/[ \t\r\n]*[\r\n][ \t\r\n]*/g, "");
}

/** Serialize one op row to a segment line (without its trailing newline). */
export function encodeSegmentLine(
  op: {
    hlc: string;
    machineId: string;
    groupId: string;
    intent: string | null;
    actor: string | null;
    entity: string;
    key: string;
    op: "put" | "del";
    payload: string;
  },
  /** Test seam: forge a line of another version (the crc covers `v`). */
  version: number = SEGMENT_FORMAT_VERSION,
): string {
  const base: Omit<SegmentLine, "crc"> = {
    v: version,
    hlc: op.hlc,
    machine: op.machineId,
    group: op.groupId,
    intent: op.intent,
    actor: op.actor,
    entity: op.entity,
    key: op.key,
    op: op.op,
    payload: null, // replaced below; kept out of the crc input shape
  };
  const payloadText = payloadTextFor(op.payload);
  // A raw CR/LF would split one op over several physical lines, which
  // every reader reports as a torn write. payloadTextFor removes them;
  // this is defensive.
  if (/[\r\n]/.test(payloadText))
    throw new Error(`segment line: payload of op ${op.hlc} contains a line break`);
  const crc = computeCrc(base, payloadText);
  // Assemble by hand so `payload` is embedded as raw JSON rather than
  // being re-encoded, keeping the bytes the crc covered.
  return `{"v":${base.v},"hlc":${JSON.stringify(base.hlc)},"machine":${JSON.stringify(
    base.machine,
  )},"group":${JSON.stringify(base.group)},"intent":${JSON.stringify(
    base.intent,
  )},"actor":${JSON.stringify(base.actor)},"entity":${JSON.stringify(
    base.entity,
  )},"key":${JSON.stringify(base.key)},"op":${JSON.stringify(
    base.op,
  )},"payload":${payloadText},"crc":${JSON.stringify(crc)}}`;
}

/** Outcome of decoding one line. */
export type DecodeResult =
  | { ok: true; line: SegmentLine; payloadText: string }
  | { ok: false; kind: SegmentDefectKind; detail: string; version?: number };

/**
 * Decode and verify one line.
 *
 * Layers 1 and 2 both live here. Layer 1 (JSON.parse) is what actually
 * fires in practice — a truncated transfer leaves a partial line, which
 * cannot parse. Layer 2 (crc) only catches damage that leaves valid JSON,
 * i.e. bit rot inside a string or number.
 */
export function decodeLine(
  raw: string,
  readVersions: readonly number[] = SEGMENT_READ_VERSIONS,
): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // LAYER 1: torn write. The dominant failure mode, and free.
    //
    // But only call it TORN when the line actually looks cut off. A
    // complete line that does not parse has a different cause (a writer
    // bug, or a hand edit) and a different remediation, and mislabelling
    // it sends the reader hunting for a crash-during-write that never
    // happened.
    const detail = err instanceof Error ? err.message : String(err);
    return looksComplete(raw)
      ? { ok: false, kind: "malformed-shape", detail: `complete line is not valid JSON: ${detail}` }
      : { ok: false, kind: "torn-write", detail };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, kind: "malformed-shape", detail: "line is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.v !== "number") {
    return { ok: false, kind: "malformed-shape", detail: "missing numeric 'v'" };
  }
  if (!readVersions.includes(obj.v)) {
    // Refuse rather than guess: another version may mean different
    // things by the same field names.
    return {
      ok: false,
      kind: "unknown-version",
      detail: `segment format v${obj.v}, this mu understands ${readVersions.map((v) => `v${v}`).join(", ")}`,
      version: obj.v,
    };
  }
  for (const field of ["hlc", "machine", "group", "entity", "key", "op", "crc"]) {
    if (typeof obj[field] !== "string") {
      return { ok: false, kind: "malformed-shape", detail: `missing string '${field}'` };
    }
  }
  const opKind = obj.op;
  if (opKind !== "put" && opKind !== "del") {
    return { ok: false, kind: "malformed-shape", detail: `bad op '${String(opKind)}'` };
  }
  if (!("payload" in obj)) {
    return { ok: false, kind: "malformed-shape", detail: "missing 'payload'" };
  }

  // Recover the payload's ORIGINAL text from the raw line so the crc is
  // computed over the same bytes the writer covered. Re-serializing the
  // parsed value could reorder keys and would false-positive.
  const payloadText = extractPayloadText(raw);
  if (payloadText === null) {
    return { ok: false, kind: "malformed-shape", detail: "could not locate payload text" };
  }

  const line: SegmentLine = {
    v: obj.v,
    hlc: obj.hlc as string,
    machine: obj.machine as string,
    group: obj.group as string,
    intent: typeof obj.intent === "string" ? obj.intent : null,
    actor: typeof obj.actor === "string" ? obj.actor : null,
    entity: obj.entity as string,
    key: obj.key as string,
    op: opKind,
    payload: obj.payload,
    crc: obj.crc as string,
  };

  // LAYER 2: crc over the canonical bytes. Belt-and-braces.
  const expected = computeCrc({ ...line, payload: null }, payloadText);
  if (expected !== line.crc) {
    return {
      ok: false,
      kind: "crc-mismatch",
      detail: `crc ${line.crc} != computed ${expected} (bit rot?)`,
    };
  }
  return { ok: true, line, payloadText: storedPayloadFor(line, payloadText) };
}

/**
 * The text to store back into `ops.payload`, undoing the wrapping
 * `payloadTextFor` applied on the way out, so a peer's ops table holds
 * the bytes the origin's does and `mu log` renders a prose message as
 * prose rather than as a quoted string.
 *
 * The inverse is exact because the wrap rule is: wrap iff the stored
 * text is NOT valid JSON or is a JSON string. So unwrap iff the line's
 * payload is a string whose contents are NOT valid JSON or ARE a JSON
 * string. Anything else was passed through and must stay that way: a
 * line written before string scalars were wrapped carries the stored
 * `"123"` as the string `123`, which this keeps as `"123"`.
 */
function storedPayloadFor(line: SegmentLine, payloadText: string): string {
  if (typeof line.payload !== "string") return payloadText;
  try {
    return typeof JSON.parse(line.payload) === "string" ? line.payload : payloadText;
  } catch {
    return line.payload;
  }
}

/** Whether a line carries the trailing framing `encodeSegmentLine`
 *  always writes. A transfer caught in flight cannot: it stops wherever
 *  the bytes stopped. */
function looksComplete(raw: string): boolean {
  return raw.trimEnd().endsWith("}") && raw.includes(',"crc":"');
}

/** Slice out the raw `"payload":<json>` text, between its key and the
 *  trailing `,"crc":`. Written by `encodeSegmentLine`, so the anchors are
 *  exact rather than heuristic. */
function extractPayloadText(raw: string): string | null {
  const start = raw.indexOf('"payload":');
  if (start < 0) return null;
  const end = raw.lastIndexOf(',"crc":');
  if (end <= start) return null;
  return raw.slice(start + '"payload":'.length, end);
}
