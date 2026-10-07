// mu — segments: how ops LEAVE and ENTER a machine.
//
// THE ONE IDEA THAT MAKES THIS WORK
// ---------------------------------
//   <MU_SYNC_DIR>/<machine_id>.jsonl
//
// Each machine APPENDS ONLY to its own segment and read-onlys every
// other. No file is ever written by two machines, so there is no
// file-level conflict, ever. That single property is what makes
// Syncthing, rsync, scp, git, and a USB stick all adequate transport: it
// removes the one thing every file-mover is bad at. There is nothing to
// merge, so nothing can merge wrongly.
//
// TWO LOGS, ONLY ONE CRITICAL
// ---------------------------
// The CANONICAL log is the `ops` table inside mu.db: ACID, WAL,
// crash-safe, written in the same transaction as the mutation it records.
// A SEGMENT is DERIVED and REGENERABLE — literally `SELECT ... FROM ops` —
// so losing one costs a re-flush and nothing else.
//
// That asymmetry is what licenses plain append-only files here, and it has
// one concrete consequence worth stating because it looks like an
// oversight: NO fsync ON APPEND. Losing the tail to power loss is
// harmless, because the next flush re-derives it from the table. Paying
// for durability twice would be paying for nothing.
//
// WHY NOT A SQLITE FILE PER PEER
// ------------------------------
// Rejected deliberately (design note): a `-wal`/`-shm` sidecar in a synced
// folder is THE canonical way to corrupt a SQLite DB; a torn transfer is
// fatal to the WHOLE file rather than costing one JSONL line; and page
// churn defeats rsync/Syncthing delta transfer, whereas an append-only
// file is the best case for it.
//
// ROBUSTNESS: FOUR LAYERS
// -----------------------
// The pattern every append-only log uses (RocksDB, Kafka, etcd,
// SQLite-WAL): detect the bad record, stop at it, refetch the tail later.
// Never guess, never skip-and-continue past damage.
//
//   1. JSON.parse failure  = torn write. FREE, and truncation is the
//      DOMINANT failure mode (a transfer caught in flight).
//   2. crc32 per line      = bit rot that JSON.parse would happily
//      accept. Belt-and-braces, not load-bearing — see the note's
//      honesty about this. ~5 LOC via node:zlib.
//   3. Monotonic hlc       = reordering, duplication, and silent
//      mid-file truncation. Structural, zero extra bytes.
//   4. Manifest sidecar    = whole-file verification (count, last_hlc,
//      sha256). REPORTS, does not halt: it fires when every remaining
//      line is individually valid (a truncation on a line boundary), so
//      the prefix is safe to apply and the fix is a fresh copy.
//
// On a bad record (layers 1-3) we stop at the last GOOD one and advance
// the watermark only that far, then report it. Because `UNIQUE (machine_id, hlc)` makes
// ingest idempotent, the universal repair is "re-read from zero" — so a
// damaged segment is recoverable, never fatal.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { crc32 } from "node:zlib";
import { applyOp, type Op, OpEntityNotSyncedError, reprojectDeferredOps } from "./apply.js";
import { type Db, prepareCached, SYNCED_ENTITIES } from "./db.js";
import { locksDir, withFileLock } from "./file-lock.js";
import { receiveHlc } from "./hlc.js";
import { isLegacyLogOnlyIntent } from "./legacy-ops.js";
import {
  manifestPath,
  manifestSelfConsistent,
  readManifest,
  writeManifestFile,
} from "./segment-manifest.js";
import { type Sha256State, sha256Digest, sha256Initial, sha256Update } from "./sha256-resumable.js";

export { manifestSeal, readManifest, type SegmentManifest } from "./segment-manifest.js";

/** Current segment line format. Bumped only on a breaking shape change;
 *  a reader that sees a version it does not know REFUSES the line rather
 *  than guessing at its meaning. */
export const SEGMENT_FORMAT_VERSION = 1;

/** Segment filename suffix. */
const SEGMENT_EXT = ".jsonl";

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
}

// ─── sync dir + naming ────────────────────────────────────────────────

/**
 * The sync directory, or null when sync is not configured.
 *
 * Null is the normal single-machine case, and every entry point here
 * treats it as "do nothing, cost nothing" rather than an error. Sync is
 * opt-in by setting one env var; there is no config file and no
 * membership list (see `discoverPeers`).
 */
export function syncDir(): string | null {
  const dir = process.env.MU_SYNC_DIR;
  if (dir === undefined || dir.trim() === "") return null;
  refuseUserSyncDirDuringTests(dir);
  return dir;
}

/**
 * The sibling of `refuseUserDbDuringTests` in src/db.ts, for the OTHER
 * piece of real state a stray test can reach.
 *
 * Pointing MU_DB_PATH at a temp file is not enough to contain a test:
 * sync is ambient, so the first flush stamps the temp DB's fresh
 * `machine_id` onto a segment in whatever MU_SYNC_DIR names. On a dev
 * box that is the user's REAL sync folder, and the result is a
 * permanent phantom peer — `mu sync` lists a machine that never
 * existed, forever, because absence of a segment is the only way a
 * peer disappears and nothing prunes them.
 *
 * Observed: eight such phantoms in ~/mu, each holding one op from a
 * throwaway `workstream init`. They came from the documented
 * smoke-test recipe (`MU_DB_PATH=/tmp/mu-smoke.db mu <verb>`), which
 * overrides the DB and says nothing about the sync dir.
 *
 * So: under a test runner, refuse a sync dir that is not clearly
 * disposable. Tests that exercise sync legitimately already point at a
 * per-test temp dir (mkdtemp under $TMPDIR), which is allowed; the
 * refusal only fires for a path outside it, which is by definition
 * somebody's real folder. Production never sets VITEST, so this is a
 * no-op for the shipped CLI.
 */
function refuseUserSyncDirDuringTests(dir: string): void {
  const inTest = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
  if (!inTest) return;
  const resolved = resolve(dir);
  const temp = resolve(tmpdir());
  if (resolved === temp || resolved.startsWith(temp + sep)) return;
  throw new Error(
    `syncDir refused: tests must NEVER flush ops into a real sync dir (MU_SYNC_DIR=${resolved}). ` +
      `Doing so writes a segment named after this run's machine_id and leaves a permanent phantom peer. ` +
      `Point MU_SYNC_DIR at a mkdtemp() path under ${temp}, or leave it unset (test/_setup.ts clears it by default).`,
  );
}

/** This machine's id — the identity every op it writes is stamped with. */
export function localMachineId(db: Db): string {
  const row = db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as
    | { machine_id: string }
    | undefined;
  if (row === undefined) throw new Error("machine_identity row missing; not a mu DB");
  return row.machine_id;
}

/** Path of a machine's own segment inside `dir`. */
export function segmentPath(dir: string, machineId: string): string {
  return join(dir, `${machineId}${SEGMENT_EXT}`);
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
 * So: pass valid JSON through verbatim (byte-preserving, which is what
 * the crc contract needs), and encode anything else as a JSON string.
 */
function payloadTextFor(payload: string): string {
  try {
    JSON.parse(payload);
    return payload;
  } catch {
    return JSON.stringify(payload);
  }
}

/** Serialize one op row to a segment line (without its trailing newline). */
export function encodeSegmentLine(op: {
  hlc: string;
  machineId: string;
  groupId: string;
  intent: string | null;
  actor: string | null;
  entity: string;
  key: string;
  op: "put" | "del";
  payload: string;
}): string {
  const base: Omit<SegmentLine, "crc"> = {
    v: SEGMENT_FORMAT_VERSION,
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
type DecodeResult =
  | { ok: true; line: SegmentLine; payloadText: string }
  | { ok: false; kind: SegmentDefectKind; detail: string };

/**
 * Decode and verify one line.
 *
 * Layers 1 and 2 both live here. Layer 1 (JSON.parse) is what actually
 * fires in practice — a truncated transfer leaves a partial line, which
 * cannot parse. Layer 2 (crc) only catches damage that leaves valid JSON,
 * i.e. bit rot inside a string or number.
 */
function decodeLine(raw: string): DecodeResult {
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
  if (obj.v !== SEGMENT_FORMAT_VERSION) {
    // Refuse rather than guess: a future version may mean different
    // things by the same field names.
    return {
      ok: false,
      kind: "unknown-version",
      detail: `segment format v${obj.v}, this mu understands v${SEGMENT_FORMAT_VERSION}`,
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
 * text is NOT valid JSON. So unwrap iff the line's payload is a JSON
 * string whose contents are NOT valid JSON — anything else was passed
 * through verbatim and must stay that way.
 */
function storedPayloadFor(line: SegmentLine, payloadText: string): string {
  if (typeof line.payload !== "string") return payloadText;
  try {
    JSON.parse(line.payload);
    return payloadText;
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

// ─── flush: ops -> my segment ─────────────────────────────────────────

export interface FlushResult {
  /** Absolute path written, or null when sync is not configured. */
  segmentPath: string | null;
  /** Ops appended by this call. */
  appended: number;
  /** Total lines in the segment afterwards. */
  total: number;
  /** Ops skipped because their entity is machine-local. */
  skippedLocal: number;
  /**
   * Non-null when THIS MACHINE'S OWN segment was found defective past
   * its last good line (bit rot, a torn write not at EOF, a bad manual
   * edit). A segment is DERIVED and REGENERABLE from the canonical
   * `ops` table, so the repair is to truncate the file back to its
   * last good record and let the append below regenerate the rest —
   * never to append after the damage, which is the defect that caused
   * unbounded regrowth (each flush re-deriving the same ops from a
   * watermark frozen at the corruption point and stacking them after
   * it, forever). Surfaced here rather than printed directly: this
   * module does no I/O beyond the filesystem, callers decide how loud
   * to be (`mu sync`, `ambientFlush`).
   */
  selfRepaired: SegmentDefect | null;
  /**
   * True when ops were pending but another process held the segment
   * lock past the wait, so this call wrote nothing. The ops stay
   * unflushed in `ops` (the segment's last hlc is the watermark), and
   * the next flush appends them. Never set on a successful flush.
   */
  lockBusy?: boolean;
}

/**
 * Append this machine's not-yet-flushed ops to its own segment.
 *
 * FILTERING IS LOAD-BEARING. Only ops whose entity is in
 * `SYNCED_ENTITIES` are written. Machine-local ops (agent.*, workspace.*)
 * are captured and DO appear in `mu log`, but they must never reach a
 * segment: they carry pane ids and absolute paths that are meaningless,
 * and frequently wrong, on another machine. "Not synced" is not "not
 * logged".
 *
 * Also filters `machine_id = <me>`: a segment holds ONE machine's ops.
 * Ops ingested from a peer live in our `ops` table too, and re-flushing
 * them into our own segment would duplicate a peer's history under our
 * name — and would grow without bound as two machines echoed each other.
 *
 * The high-water mark is the last hlc already in the file (read from the
 * manifest when present, else derived by scanning), so flush is
 * incremental and idempotent: calling it twice appends nothing the second
 * time.
 */
/** How long an ambient flush (every verb's post-body hook) waits for
 *  the segment lock before deferring its ops to the next invocation.
 *  An incremental append holds the lock for milliseconds, so 2 s
 *  clears a deep queue of parallel appenders; a holder slower than
 *  that is doing a full rescan, and the verb should not wait it out. */
export const AMBIENT_FLUSH_LOCK_WAIT_MS = 2_000;
/** Explicit `mu sync` (verify) waits longer: the operator asked for the
 *  flush and a full-scan holder takes seconds on a large segment. */
export const VERIFY_FLUSH_LOCK_WAIT_MS = 15_000;

export async function flushSegment(
  db: Db,
  dir: string | null = syncDir(),
  opts?: { verify?: boolean; lockWaitMs?: number },
): Promise<FlushResult> {
  if (dir === null)
    return { segmentPath: null, appended: 0, total: 0, skippedLocal: 0, selfRepaired: null };

  const machineId = localMachineId(db);
  mkdirSync(dir, { recursive: true });
  const path = segmentPath(dir, machineId);

  // LOCK-FREE NO-OP. Most verbs write no synced op, and every mu
  // process used to queue on the lock below just to learn that, so N
  // parallel read-only verbs ran their flushes one after another. When
  // our own manifest still describes the file and no op is pending,
  // there is nothing to append and nothing to serialise against: a
  // concurrent appender either finished (we would see its manifest) or
  // has not, and its ops are its own to write.
  // `verify` (explicit `mu sync`) skips both shortcuts and decodes every
  // line, so damage that kept size, mtime and the last line intact
  // (bit rot mid-file) is still found and self-repaired somewhere.
  const verify = opts?.verify === true;
  const pre = verify ? null : trustedTail(path, machineId);
  if (pre !== null) {
    const pending = pendingLines(db, machineId, pre.lastHlc);
    if (pending.lines.length === 0) {
      return {
        segmentPath: path,
        appended: 0,
        total: pre.count,
        skippedLocal: pending.skippedLocal,
        selfRepaired: null,
      };
    }
  }

  // Serialise concurrent local flushes so two processes cannot interleave
  // partial lines in the same file. Keyed on the sync dir + machine, since
  // that names the single file being appended to.
  //
  // NEVER UNLOCKED. If the lock is still held at the deadline, write
  // nothing: an unlocked append can splice lines into another writer's,
  // or land after its self-repair truncate, and the ops are safe in the
  // DB anyway. The next invocation's flush appends them. A stale lock
  // (crashed holder) is still broken inside withFileLock.
  const lockName = createHash("sha256")
    .update(`${dir}\u001f${machineId}`)
    .digest("hex")
    .slice(0, 16);
  return withFileLock(
    join(locksDir(), `segment-${lockName}.lock`),
    `segment:${machineId}`,
    () => Promise.resolve(flushLocked(db, path, machineId, verify)),
    {
      acquireTimeoutMs:
        opts?.lockWaitMs ?? (verify ? VERIFY_FLUSH_LOCK_WAIT_MS : AMBIENT_FLUSH_LOCK_WAIT_MS),
      onUnavailable: () => ({
        segmentPath: path,
        appended: 0,
        total: pre?.count ?? 0,
        skippedLocal: 0,
        selfRepaired: null,
        lockBusy: true,
      }),
    },
  );
}

function flushLocked(db: Db, path: string, machineId: string, verify: boolean): FlushResult {
  // Fast path: our own manifest still describes the file (same size and
  // mtime, last line decodes to its lastHlc), so count and high-water
  // mark come from it and nothing before the tail is read.
  const trusted = verify ? null : trustedTail(path, machineId);
  let count: number;
  let since: string | null;
  let selfRepaired: SegmentDefect | null = null;
  if (trusted !== null) {
    count = trusted.count;
    since = trusted.lastHlc;
  } else {
    const existing = readSegmentTail(path);
    count = existing.count;
    since = existing.lastHlc;

    // The defect this exists to close: readSegmentTail STOPS at the first
    // bad record either because it hit real damage or because it simply
    // ran out of well-formed lines. Those two cases used to be
    // indistinguishable to this function, and treating "stopped early on
    // damage" the same as "reached clean EOF" is exactly what let a
    // corrupted line grow the file forever: `since` never advanced past
    // it, so every flush re-selected and re-appended the same ops after
    // it again, unbounded. Distinguish them and heal our own segment
    // (truncate back to the last verified-good line) before appending
    // anything new, rather than stacking fresh data after the wound.
    if (existing.defect !== null) {
      selfRepaired = existing.defect;
      writeFileSync(
        path,
        existing.goodLines.length > 0 ? `${existing.goodLines.join("\n")}\n` : "",
        "utf8",
      );
    }
  }

  const pending = pendingLines(db, machineId, since);
  let appended: Buffer | null = null;
  if (pending.lines.length > 0) {
    // NO fsync. The segment is derived from `ops`; a lost tail costs one
    // re-flush, so paying for durability here would buy nothing.
    appended = Buffer.from(`${pending.lines.join("\n")}\n`, "utf8");
    appendFileSync(path, appended);
  } else if (!existsSync(path)) {
    // Create the file even with nothing to say, so peers can discover
    // this machine before its first change.
    writeFileSync(path, "", "utf8");
  }

  const total = count + pending.lines.length;
  const result = {
    segmentPath: path,
    appended: pending.lines.length,
    total,
    skippedLocal: pending.skippedLocal,
    selfRepaired,
  };
  // Nothing changed and the manifest already says so: leave it alone,
  // so a read-only verb does not hand the sync tool a file to ship.
  if (trusted !== null && appended === null) return result;
  writeManifest(
    path,
    machineId,
    total,
    pending.lastHlc ?? since,
    trusted !== null && appended !== null
      ? { state: trusted.shaState, size: trusted.size, appended }
      : null,
  );
  return result;
}

/** This machine's synced ops newer than `since`, encoded as segment
 *  lines, plus how many machine-local ops were skipped. */
function pendingLines(
  db: Db,
  machineId: string,
  since: string | null,
): { lines: string[]; lastHlc: string | null; skippedLocal: number } {
  const rows = db
    .prepare(
      `SELECT hlc, machine_id, group_id, intent, actor, entity, key, op, payload
         FROM ops
        WHERE machine_id = @machineId
          AND (@since IS NULL OR hlc > @since)
        ORDER BY hlc`,
    )
    .all({ machineId, since }) as Array<{
    hlc: string;
    machine_id: string;
    group_id: string;
    intent: string | null;
    actor: string | null;
    entity: string;
    key: string;
    op: string;
    payload: string;
  }>;

  const synced = new Set<string>(SYNCED_ENTITIES);
  const lines: string[] = [];
  let skippedLocal = 0;
  let lastHlc: string | null = null;

  for (const row of rows) {
    if (!synced.has(row.entity) || isLegacyLogOnlyIntent(row.intent)) {
      skippedLocal += 1;
      continue;
    }
    lines.push(
      encodeSegmentLine({
        hlc: row.hlc,
        machineId: row.machine_id,
        groupId: row.group_id,
        intent: row.intent,
        actor: row.actor,
        entity: row.entity,
        key: row.key,
        op: row.op === "del" ? "del" : "put",
        payload: row.payload,
      }),
    );
    lastHlc = row.hlc;
  }
  return { lines, lastHlc, skippedLocal };
}

/**
 * Count, last hlc, size and running hash of OUR OWN segment, taken from
 * its manifest, or null when the manifest cannot be trusted and the
 * caller must scan the file.
 *
 * Trusted only when the manifest is ours, carries the fields this build
 * writes and they agree with each other (`manifestSelfConsistent`:
 * format, hash state finishing to `sha256`, seal), matches the file's
 * current size AND mtime (any rewrite, hand
 * edit or truncation changes one of them), and the file's last line ends
 * in a newline and decodes cleanly to the manifest's lastHlc. That last
 * check reads only the final line, so a torn or corrupt tail still falls
 * through to the full scan and its self-repair. Cost: one stat plus one
 * line, independent of file size.
 */
function trustedTail(
  path: string,
  machineId: string,
): { count: number; lastHlc: string | null; size: number; shaState: Sha256State } | null {
  const m = readManifest(path);
  if (m === null || m.v !== SEGMENT_FORMAT_VERSION || m.machine !== machineId) return null;
  if (!manifestSelfConsistent(m)) return null;
  const { count, lastHlc, size, mtimeMs, shaState } = m;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (stat.size !== size || stat.mtimeMs !== mtimeMs) return null;
  if (count === 0) return lastHlc === null ? { count, lastHlc, size, shaState } : null;
  const last = readLastLine(path, size);
  if (last === null) return null;
  const decoded = decodeLine(last);
  if (!decoded.ok || decoded.line.hlc !== lastHlc) return null;
  return { count, lastHlc, size, shaState };
}

/** The last newline-terminated line of the first `size` bytes of
 *  `path`, without its newline; null when those bytes do not end in a
 *  newline (a torn write). Reads backwards in chunks, so a long line
 *  costs its own length and the file's size costs nothing. */
function readLastLine(path: string, size: number): string | null {
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 0x0a) return null;
    const chunks: Buffer[] = [];
    let end = size - 1;
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0) {
        chunks.unshift(buf.subarray(nl + 1));
        break;
      }
      chunks.unshift(buf);
      end = start;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * True when the segment at `path` holds exactly `lines` lines, judged
 * without reading it: its manifest counts `lines`, the file's size
 * matches the manifest's when the manifest records one, the file was
 * not modified after its manifest, and the file ends in a
 * newline-terminated line that decodes to the manifest's lastHlc. A
 * peer that appended past its manifest, a rewrite after the manifest, a
 * torn tail, a missing or stale manifest, or a file shorter than its
 * manifest all fail one of these and send the caller down the full
 * read, which hashes the file and reports any mismatch. Cost: the
 * manifest, two stats and the last line, whatever the file's size.
 */
export function segmentCaughtUp(path: string, lines: number): boolean {
  const m = readManifest(path);
  if (m === null || m.count !== lines) return false;
  let size: number;
  let mtimeMs: number;
  let manifestMtimeMs: number;
  try {
    ({ size, mtimeMs } = statSync(path));
    manifestMtimeMs = statSync(manifestPath(path)).mtimeMs;
  } catch {
    return false;
  }
  if (typeof m.size === "number" && m.size !== size) return false;
  // The owner writes the segment, then its manifest, so a segment newer
  // than its manifest file was touched afterwards (rewritten, repaired by
  // hand, half-copied). The mtime the manifest recorded also vouches for
  // the file, for a transport that kept the segment's mtime but not the
  // manifest's.
  if (mtimeMs > manifestMtimeMs && m.mtimeMs !== mtimeMs) return false;
  if (lines === 0) return size === 0;
  const last = readLastLine(path, size);
  if (last === null) return false;
  const decoded = decodeLine(last);
  return decoded.ok && decoded.line.hlc === m.lastHlc;
}

/** Number of GOOD lines in a segment (stopping at the first defect, as
 *  ingest does). The denominator of "how far behind am I" — exported for
 *  `mu sync`'s peer table. */
export function segmentLineCount(path: string): number {
  return readSegmentTail(path).count;
}

/**
 * Count + last hlc of an existing segment, cheaply, plus (this is the
 * part that matters) WHY it stopped: `defect` is null when every line
 * decoded cleanly (a genuine, trustworthy EOF), and set when decoding
 * stopped early because a line was bad. Conflating those two used to be
 * the whole bug: a stop-on-damage looked exactly like a stop-on-EOF to
 * `flushLocked`, so it kept appending after the damage forever.
 * `goodLines` is the verified-good prefix, raw, so a caller that finds a
 * defect can truncate back to it byte-for-byte rather than re-encoding.
 */
function readSegmentTail(path: string): {
  count: number;
  lastHlc: string | null;
  goodLines: readonly string[];
  defect: SegmentDefect | null;
} {
  if (!existsSync(path)) return { count: 0, lastHlc: null, goodLines: [], defect: null };
  const lines = segmentLines(readFileSync(path, "utf8"));
  let lastHlc: string | null = null;
  let count = 0;
  let defect: SegmentDefect | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) break;
    // Same rule as `ingestSegment`: a blank line is damage. Skipping it
    // here while peers halt on it left the owner blind to the defect,
    // so it never self-repaired and every peer stopped there forever.
    if (line.trim() === "") {
      defect = { kind: "malformed-shape", line: index + 1, detail: "blank line" };
      break;
    }
    const decoded = decodeLine(line);
    if (!decoded.ok) {
      defect = { kind: decoded.kind, line: index + 1, detail: decoded.detail };
      break;
    }
    lastHlc = decoded.line.hlc;
    count += 1;
  }
  return { count, lastHlc, goodLines: lines.slice(0, count), defect };
}

/** Split a segment into its lines exactly as every reader must: a
 *  trailing newline is normal, a trailing PARTIAL line is a torn write
 *  (kept so layer 1 can catch it), and a blank line stays in place so
 *  the caller reports it as damage. One splitter, so the owner's
 *  self-check and a peer's ingest cannot disagree about line numbers. */
function segmentLines(raw: string): string[] {
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * LAYER 4: whole-file verification sidecar.
 *
 * `incremental` carries the running hash of the bytes the manifest last
 * covered, so an append hashes only what it added. Without it (first
 * flush, a repair, a manifest from an older build, or a file that grew
 * by more than we appended) the whole file is hashed once.
 */
function writeManifest(
  path: string,
  machine: string,
  count: number,
  lastHlc: string | null,
  incremental: { state: Sha256State; size: number; appended: Buffer } | null,
): void {
  let stat = statSync(path);
  let shaState: Sha256State;
  if (incremental !== null && stat.size === incremental.size + incremental.appended.length) {
    shaState = sha256Update(incremental.state, incremental.appended);
  } else {
    const bytes = readFileSync(path);
    shaState = sha256Update(sha256Initial(), bytes);
    stat = statSync(path);
  }
  writeManifestFile(path, {
    v: SEGMENT_FORMAT_VERSION,
    machine,
    count,
    lastHlc,
    sha256: sha256Digest(shaState),
    size: shaState.n,
    mtimeMs: stat.mtimeMs,
    shaState,
  });
}

/**
 * Verify a segment against its manifest (layer 4).
 *
 * Whole-file, so it catches damage the per-line layers cannot see: a
 * segment silently replaced wholesale, or truncated exactly on a line
 * boundary (where every remaining line is individually valid).
 */
export function verifyAgainstManifest(
  segment: string,
): { ok: true } | { ok: false; reason: string } {
  const manifest = readManifest(segment);
  if (manifest === null) return { ok: true }; // no manifest: nothing to check
  if (!existsSync(segment)) return { ok: false, reason: "segment missing but manifest present" };
  const sha = createHash("sha256").update(readFileSync(segment)).digest("hex");
  if (sha === manifest.sha256) return { ok: true };
  // A GROWN file is expected: the peer appended after writing the
  // manifest we have, or our copy is mid-transfer. That is not damage.
  const tail = readSegmentTail(segment);
  if (tail.count >= manifest.count) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `sha mismatch and file has FEWER records than the manifest (${tail.count} < ${manifest.count}): truncated`,
  };
}

// ─── peer discovery ───────────────────────────────────────────────────

export interface PeerSegment {
  /** Machine id the segment belongs to. */
  machineId: string;
  /** Key of this FILE's watermark in `sync_peers`: the machine id for
   *  the peer's own segment, the full file stem for a conflict copy.
   *  A copy diverges from its original, so line N of one says nothing
   *  about line N of the other; sharing one watermark skipped every op
   *  that existed only in the copy. Optional for SDK callers written
   *  before it existed: absent means the machine id (`peerWatermarkKey`). */
  watermarkKey?: string;
  /** Path on disk. */
  path: string;
  /** True for a Syncthing-style conflict copy. */
  conflictCopy: boolean;
}

/**
 * Every segment in `dir` that is not mine.
 *
 * IMPLICIT, with no membership list. `MU_SYNC_PEERS` was explicitly
 * rejected as "a config file with extra steps that must be kept
 * consistent across every machine" — dropping a segment in the folder
 * joins the cluster, deleting it leaves.
 *
 * CONFLICT COPIES ARE INGESTED, not ignored. Syncthing names them
 * `<machine>.sync-conflict-20260609-123456-ABCDEFG.jsonl`; they are still
 * valid op logs, and dedup by `(machine_id, hlc)` makes reading them
 * safe. Ignoring them would silently drop real ops precisely when
 * something already went wrong.
 */
export function discoverPeers(dir: string, selfMachineId: string): PeerSegment[] {
  if (!existsSync(dir)) return [];
  const peers: PeerSegment[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(SEGMENT_EXT)) continue;
    const stem = name.slice(0, -SEGMENT_EXT.length);
    // Syncthing: "<machine>.sync-conflict-<date>-<time>-<id>"
    const conflictAt = stem.indexOf(".sync-conflict-");
    const conflictCopy = conflictAt > 0;
    const machineId = conflictCopy ? stem.slice(0, conflictAt) : stem;
    if (machineId === selfMachineId && !conflictCopy) continue;
    // A conflict copy OF MY OWN segment is still a peer's view of my
    // history; ingesting it is a no-op thanks to (machine_id, hlc)
    // dedupe, so allow it rather than special-casing.
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    peers.push({ machineId, watermarkKey: conflictCopy ? stem : machineId, path, conflictCopy });
  }
  return peers.sort((a, b) => a.path.localeCompare(b.path));
}

/** The `sync_peers` key for a segment file: `watermarkKey`, else the
 *  machine id (the pre-watermarkKey `PeerSegment` shape). */
export function peerWatermarkKey(peer: PeerSegment): string {
  return peer.watermarkKey ?? peer.machineId;
}

// ─── watermarks ───────────────────────────────────────────────────────

/**
 * How far into one segment file we have applied, keyed by
 * `PeerSegment.watermarkKey` (the machine id, or a conflict copy's own
 * stem).
 *
 * ONE INTEGER SUFFICES because segments are append-only and ordered — a
 * set or a vector clock would be strictly more state for no more
 * information. Stored in `sync_peers.last_applied_seq`, which has been in
 * the v9 schema unused until now.
 *
 * The integer is a LINE COUNT within that peer's segment, not the peer's
 * `ops.seq` (which is a local-only cursor on their machine and means
 * nothing here).
 */
export function getWatermark(db: Db, watermarkKey: string): number {
  const row = db
    .prepare("SELECT last_applied_seq AS n FROM sync_peers WHERE machine_id = ?")
    .get(watermarkKey) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function setWatermark(db: Db, watermarkKey: string, value: number): void {
  db.prepare(
    `INSERT INTO sync_peers (machine_id, last_applied_seq, last_seen_at)
     VALUES (@machineId, @value, @seenAt)
     ON CONFLICT (machine_id) DO UPDATE
       SET last_applied_seq = @value, last_seen_at = @seenAt`,
  ).run({ machineId: watermarkKey, value, seenAt: new Date().toISOString() });
}

/**
 * The pending-reprojection marker: SQLite's `user_version` header field,
 * 1 while applied ops await `reprojectDeferredOps`. mu uses it for
 * nothing else (the schema version lives in `schema_version`). Written
 * inside the applying transaction, so it commits or rolls back with the
 * ops; reading it costs no table lookup and adds no row anyone lists.
 */
export function markReprojectionPending(db: Db): void {
  db.pragma("user_version = 1");
}

/**
 * Run `reprojectDeferredOps` when an ingest left the marker behind (or
 * always, with `force`), and clear the marker in the same transaction.
 *
 * The marker is what lets ambient ingest skip the repair scan (~130 ms
 * on a large log) when nothing arrived, yet still retry it after a
 * process died between its ingest commit and the repair. Clearing it
 * atomically with the repair means a concurrent ingest's marker is
 * either seen by this repair or survives it. Returns the rows changed.
 */
export function reprojectIfPending(db: Db, opts?: { force?: boolean }): number {
  if (opts?.force !== true && db.pragma("user_version", { simple: true }) === 0) return 0;
  return db
    .transaction(() => {
      const pending = db.pragma("user_version", { simple: true }) !== 0;
      if (!pending && opts?.force !== true) return 0;
      const changed = reprojectDeferredOps(db);
      if (pending) db.pragma("user_version = 0");
      return changed;
    })
    .immediate();
}

/** Reset a peer's watermark so the next ingest re-reads from zero. The
 *  universal repair, safe because ingest is idempotent. */
export function resetWatermark(db: Db, watermarkKey: string): void {
  setWatermark(db, watermarkKey, 0);
}

// ─── ingest: peer segment -> applyOp ──────────────────────────────────

export interface IngestResult {
  machineId: string;
  path: string;
  /** Lines consumed past the starting watermark: applied plus skipped
   *  (refused, re-delivered, historical log-only) lines. A line that
   *  halted ingest is not counted. */
  read: number;
  /** Ops applied (some are no-ops: already present, or lost an LWW). */
  applied: number;
  /** Ops that changed a row. */
  changed: number;
  /** Watermark after this ingest. */
  watermark: number;
  /** Problems found, in line order. Reported, never swallowed. */
  defects: readonly SegmentDefect[];
  /** True iff a defect stopped us short of the file's end. */
  truncatedAt: number | null;
}

/**
 * Read one peer segment from its watermark and apply each op.
 *
 * STOPS AT THE FIRST DAMAGED RECORD and advances the watermark only that
 * far. Never skips a damaged line to continue past it: in an ordered log,
 * a gap is indistinguishable from reordering, and applying ops around a
 * hole risks a state neither machine ever had. The tail is re-read on the
 * next ingest, by which time the transfer has usually completed.
 *
 * A REFUSED line is not a damaged one. A well-formed op naming an entity
 * that must not travel (`entity-not-synced`) is reported as a defect and
 * SKIPPED: it projects nothing, so it leaves no hole, and halting on it
 * makes the watermark unrecoverable by any means the CLI offers.
 *
 * A RE-DELIVERED line is not a damaged one either. A block of ops the
 * peer already wrote, appended verbatim a second time, breaks the hlc
 * ordering (`duplicate-op`) without losing anything: every one of those
 * ops is already in our `ops` table byte-for-byte, so applying them
 * again is a no-op by construction. Halting there is unrecoverable —
 * `--repair` re-reads from zero straight back into the same three
 * lines, forever — so it is reported and SKIPPED. A non-monotonic line
 * we have NOT seen before is still real damage and still halts.
 *
 * A HISTORICAL log-only line (`isLegacyLogOnlyIntent`: a prose payload
 * under an otherwise projectable entity, written by a mu older than the
 * flush filter) is skipped silently, exactly as flush and `--from` skip
 * it. Applying it threw a JSON SyntaxError that rolled back the whole
 * segment on every invocation.
 *
 * A manifest mismatch (layer 4) is reported but does not halt: every
 * line still present is individually valid, so applying them is safe.
 *
 * Calls `receiveHlc` per op so the local clock advances past the peer's,
 * which is what makes "laptop edits after seeing the devserver's op" order
 * correctly rather than losing to it.
 */
export function ingestSegment(
  db: Db,
  peer: PeerSegment,
  opts?: { verify?: boolean },
): IngestResult {
  const defects: SegmentDefect[] = [];
  const watermarkKey = peerWatermarkKey(peer);
  const start = getWatermark(db, watermarkKey);

  // CAUGHT UP: the peer's manifest says the file holds exactly the lines
  // we already consumed, and its last line is the one the manifest
  // names. Nothing to apply, so do not read, hash or split the file.
  // `verify` (explicit `mu sync`) skips this and checks the whole file,
  // so damage that left the count and the last line intact is still
  // reported somewhere.
  if (opts?.verify !== true && segmentCaughtUp(peer.path, start)) {
    return {
      machineId: peer.machineId,
      path: peer.path,
      read: 0,
      applied: 0,
      changed: 0,
      watermark: start,
      defects,
      truncatedAt: null,
    };
  }

  if (!existsSync(peer.path)) {
    return {
      machineId: peer.machineId,
      path: peer.path,
      read: 0,
      applied: 0,
      changed: 0,
      watermark: start,
      defects,
      truncatedAt: null,
    };
  }

  const verified = verifyAgainstManifest(peer.path);
  if (!verified.ok) {
    // Whole-file damage, distinct from a torn line: every remaining
    // record may be individually valid (truncation exactly on a line
    // boundary), which is precisely what the per-line layers cannot see.
    // Reported, NOT a halt: the lines that remain are a valid prefix, so
    // the per-line layers below still decide how far to apply.
    defects.push({ kind: "manifest-mismatch", line: 0, detail: verified.reason });
  }

  const lines = segmentLines(readFileSync(peer.path, "utf8"));

  let applied = 0;
  let changed = 0;
  let watermark = start;
  let truncatedAt: number | null = null;
  let previousHlc: string | null = null;

  // Seed the monotonicity check from the last line we already accepted,
  // so a segment rewritten out of order is caught even mid-file.
  if (start > 0 && start <= lines.length) {
    const prior = lines[start - 1];
    if (prior !== undefined) {
      const decoded = decodeLine(prior);
      if (decoded.ok) previousHlc = decoded.line.hlc;
    }
  }

  const run = db.transaction(() => {
    for (let index = start; index < lines.length; index++) {
      const raw = lines[index];
      const lineNo = index + 1;
      if (raw === undefined || raw.trim() === "") {
        // Blank line: treat as damage rather than skipping, since a
        // well-formed segment never contains one.
        defects.push({ kind: "malformed-shape", line: lineNo, detail: "blank line" });
        truncatedAt = lineNo;
        break;
      }

      const decoded = decodeLine(raw);
      if (!decoded.ok) {
        defects.push({ kind: decoded.kind, line: lineNo, detail: decoded.detail });
        truncatedAt = lineNo;
        break;
      }

      const op: Op = {
        hlc: decoded.line.hlc,
        machineId: decoded.line.machine,
        groupId: decoded.line.group,
        actor: decoded.line.actor,
        intent: decoded.line.intent,
        entity: decoded.line.entity,
        key: decoded.line.key,
        op: decoded.line.op,
        payload: decoded.payloadText,
      };

      // LAYER 3: monotonic hlc. Structural, zero extra bytes. Catches
      // reordering, duplication, and silent mid-file truncation.
      if (previousHlc !== null && decoded.line.hlc <= previousHlc) {
        // ... unless we have this exact op already, in which case the
        // peer re-appended a block it had already written and there is
        // nothing to reorder: an identical op carries identical state,
        // so skipping it cannot produce a state neither machine had.
        if (isAlreadyRecorded(db, op)) {
          defects.push({
            kind: "duplicate-op",
            line: lineNo,
            detail: `hlc ${decoded.line.hlc} re-delivered — skipped`,
          });
          watermark = lineNo;
          continue;
        }
        defects.push({
          kind: "non-monotonic-hlc",
          line: lineNo,
          detail: `hlc ${decoded.line.hlc} <= previous ${previousHlc}`,
        });
        truncatedAt = lineNo;
        break;
      }

      if (isLegacyLogOnlyIntent(decoded.line.intent)) {
        previousHlc = op.hlc;
        watermark = lineNo;
        continue;
      }

      try {
        const result = applyIncomingOp(db, op);
        if (result.changed) changed += 1;
      } catch (err) {
        if (err instanceof OpEntityNotSyncedError) {
          // A peer sent something that must never cross a machine
          // boundary (a pane id, an absolute path). Report it as a
          // bad-peer defect — and SKIP THE LINE rather than stopping.
          //
          // Stopping is right for DAMAGE, where a gap is
          // indistinguishable from reordering. This line is not
          // damaged: it decoded, its crc verified, and its hlc is in
          // order. Refusing it projects nothing, so there is no hole to
          // reason about, and continuing is strictly safer than the
          // alternative we actually shipped — one such line at position
          // 2533 of a 20,305-line segment froze that peer's watermark
          // permanently, and `mu sync --repair` re-read straight back
          // into the same wall. A defect is reported; nothing is lost;
          // the remaining 17,772 ops arrive.
          defects.push({
            kind: "entity-not-synced",
            line: lineNo,
            detail: `peer sent machine-local entity '${op.entity}' — skipped`,
          });
          previousHlc = op.hlc;
          watermark = lineNo;
          continue;
        }
        throw err;
      }

      applied += 1;
      previousHlc = op.hlc;
      watermark = lineNo;
    }
    setWatermark(db, watermarkKey, watermark);
    // In the same transaction as the ops: a process that dies before
    // the pass-wide reprojection leaves this behind for the next one.
    if (applied > 0) markReprojectionPending(db);
  });
  run.immediate();

  return {
    machineId: peer.machineId,
    path: peer.path,
    read: watermark - start,
    applied,
    changed,
    watermark,
    defects,
    truncatedAt,
  };
}

/**
 * Is this exact op already in our `ops` table?
 *
 * `UNIQUE (machine_id, hlc)` is the op's identity everywhere else in
 * the system — it is what makes `applyIncomingOp` idempotent and
 * "re-read from zero" a safe universal repair — so it is the identity
 * used here too. Entity and key are matched as well so a hlc collision
 * between genuinely different ops (which the UNIQUE constraint would
 * itself refuse) can never be mistaken for a re-delivery.
 */
function isAlreadyRecorded(db: Db, op: Op): boolean {
  const row = prepareCached(
    db,
    `SELECT 1 FROM ops
        WHERE machine_id = @machineId AND hlc = @hlc
          AND entity = @entity AND key = @key AND op = @op
        LIMIT 1`,
  ).get({
    machineId: op.machineId,
    hlc: op.hlc,
    entity: op.entity,
    key: op.key,
    op: op.op,
  });
  return row !== undefined;
}

/**
 * Apply ONE incoming op and record it in the local `ops` table.
 *
 * The shared tail of every ingest path — segment ingest above, and the
 * `mu sync --from <peer.db>` reader in `src/sync.ts`, which is a
 * different READER over the same apply semantics. Extracted so the two
 * cannot drift: a second copy of "advance the clock, apply, record" is
 * how one of them silently stops advancing the clock.
 *
 * Three steps, in this order:
 *   1. `receiveHlc` BEFORE applying, so anything we mint afterwards
 *      sorts above the peer's op.
 *   2. `applyOp`, which is capture-suppressed (no echo op is minted).
 *   3. Record the op locally so it survives, participates in
 *      provenance, and can be re-flushed by rebuild. INSERT OR IGNORE
 *      makes this idempotent via UNIQUE (machine_id, hlc) — the
 *      property that lets "re-read from zero" be the universal repair.
 */
export function applyIncomingOp(db: Db, op: Op): { changed: boolean } {
  receiveHlc(db, op.hlc);
  const result = applyOp(db, op);
  prepareCached(
    db,
    `INSERT OR IGNORE INTO ops
       (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (@hlc, @machineId, @groupId, @actor, @intent, @entity, @key, @op, @payload, @createdAt)`,
  ).run({
    hlc: op.hlc,
    machineId: op.machineId,
    groupId: op.groupId,
    actor: op.actor ?? null,
    intent: op.intent ?? null,
    entity: op.entity,
    key: op.key,
    op: op.op,
    payload: op.payload,
    createdAt: new Date().toISOString(),
  });
  return { changed: result.changed };
}

// ─── the two halves, together ─────────────────────────────────────────

export interface SyncPassResult {
  flushed: FlushResult;
  ingested: readonly IngestResult[];
  /** True iff any peer reported a defect. */
  defective: boolean;
}

/**
 * One flush + one ingest of every discovered peer.
 *
 * The SDK seam `mu sync` calls (src/cli/sync.ts); it deliberately
 * prints nothing and starts nothing. No daemon, no watcher, no polling
 * loop that outlives the command — the anti-feature pledges are firm, and
 * mu never moves files itself: the operator owns transport.
 *
 * A no-op costing nothing when `MU_SYNC_DIR` is unset, which is the
 * normal single-machine case.
 */
export async function syncPass(db: Db, dir: string | null = syncDir()): Promise<SyncPassResult> {
  if (dir === null) {
    return {
      flushed: { segmentPath: null, appended: 0, total: 0, skippedLocal: 0, selfRepaired: null },
      ingested: [],
      defective: false,
    };
  }
  const flushed = await flushSegment(db, dir, { verify: true });
  const self = localMachineId(db);
  const ingested = discoverPeers(dir, self).map((peer) =>
    ingestSegment(db, peer, { verify: true }),
  );
  // AFTER every peer, not per peer: an edge in peer A's segment may name
  // a task in peer B's, and `discoverPeers` order is `localeCompare` over
  // random UUID filenames, so "parent first" is a coin flip. One pass at
  // the end sees the union. See `reprojectDeferredOps`.
  reprojectIfPending(db, { force: true });
  return {
    flushed,
    ingested,
    defective: flushed.selfRepaired !== null || ingested.some((r) => r.defects.length > 0),
  };
}
