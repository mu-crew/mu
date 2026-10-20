// mu — resume a peer segment ingest from a byte offset.
//
// A clean ingest of a peer's segment records, next to its caught-up
// fingerprint (`sync_fingerprints`), where it stopped: lines consumed,
// bytes consumed, the last hlc, and the running sha256 state over those
// bytes. When the peer appends, the next ambient ingest reads only the
// new bytes, hashes them from the saved state, and accepts them only
// when the result is the sha256 in the peer's manifest. That equals a
// whole-file check as long as the prefix is what the first read saw.
// Anything else falls back to the full read and verify: a shrunk or
// rewritten file, a stale manifest, a defect (a defect never records a
// resume point), or an explicit `mu sync` (`verify`). Split out of
// segments.ts (1500-LOC cap).

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { type Db, prepareCached } from "./db.js";
import { manifestPath, type SegmentManifest } from "./segment-manifest.js";
import { type Sha256State, sha256Digest, sha256Update } from "./sha256-resumable.js";

/** A peer manifest's optional `shaState`, usable only when it is
 *  well-formed and covers exactly `length` bytes. The manifest is peer
 *  input: anything off (null, wrong types, bad hex, a tail that is not
 *  `length % 64` bytes of canonical base64, `n` out of range) yields
 *  null and the caller hashes the bytes itself. */
export function usableShaState(state: unknown, length: number): Sha256State | null {
  if (typeof state !== "object" || state === null) return null;
  const { h, n, tail } = state as Record<string, unknown>;
  if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return null;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n !== length) return null;
  if (typeof tail !== "string") return null;
  const raw = Buffer.from(tail, "base64");
  if (raw.length !== n % 64 || raw.toString("base64") !== tail) return null;
  return { h, n, tail };
}

/** Where a clean ingest stopped, and what it hashed to get there. */
export interface ResumePoint {
  /** Lines consumed; always the watermark it was recorded with. */
  lines: number;
  /** Bytes consumed; the last one is a newline. */
  size: number;
  /** Hlc of the last line consumed (the monotonicity seed). */
  lastHlc: string;
  /** Running sha256 over those `size` bytes. */
  state: Sha256State;
}

/** The `sync_fingerprints` value: the caught-up key, optionally followed
 *  by tab-separated resume fields. An older mu compares the whole string,
 *  so it never matches and just reads in full. */
export function encodeFingerprint(key: string, resume: ResumePoint | null): string {
  if (resume === null) return key;
  const { lines, size, lastHlc, state } = resume;
  return [key, lines, size, lastHlc, state.h, state.tail].join("\t");
}

/** Split a stored fingerprint into its caught-up key and resume point
 *  (null when absent or malformed). */
export function decodeFingerprint(raw: string): { key: string; resume: ResumePoint | null } {
  const [key = "", lines, size, lastHlc, h, tail] = raw.split("\t");
  if (h === undefined || tail === undefined || lines === undefined || size === undefined) {
    return { key, resume: null };
  }
  const n = Number(size);
  const count = Number(lines);
  if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(count) || count <= 0) {
    return { key, resume: null };
  }
  if (!lastHlc || !/^[0-9a-f]{64}$/.test(h)) return { key, resume: null };
  return { key, resume: { lines: count, size: n, lastHlc, state: { h, n, tail } } };
}

/**
 * The bytes of `path` past `resume.size`, with the running hash after
 * them, or null when the file cannot be resumed: it is not longer than
 * the recorded size, or the hash does not equal `manifestSha` (the
 * manifest is stale, or the prefix is not what we hashed).
 */
export function readAppended(
  path: string,
  resume: ResumePoint,
  manifestSha: string,
): { bytes: Buffer; state: Sha256State } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= resume.size) return null;
    const bytes = Buffer.alloc(size - resume.size);
    for (let got = 0; got < bytes.length; ) {
      const n = readSync(fd, bytes, got, bytes.length - got, resume.size + got);
      if (n === 0) return null;
      got += n;
    }
    const state = sha256Update(resume.state, bytes);
    return sha256Digest(state) === manifestSha ? { bytes, state } : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * What a full, clean ingest saw of a peer's segment: its size, its
 * exact mtime, and the sha256 of its manifest's bytes, plus the count
 * that manifest claims. Null when the segment or its manifest cannot be
 * read. Taken BEFORE the read, so a file that changes mid-read no longer
 * matches next time.
 */
export function segmentFingerprint(
  path: string,
): { key: string; count: unknown; manifest: SegmentManifest | null } | null {
  try {
    const { size, mtimeMs } = statSync(path);
    const manifest = readFileSync(manifestPath(path));
    const sha = createHash("sha256").update(manifest).digest("hex");
    let count: unknown = null;
    let parsed: SegmentManifest | null = null;
    try {
      parsed = JSON.parse(manifest.toString("utf8")) as SegmentManifest;
      count = parsed?.count;
    } catch {
      // An unparseable manifest still fingerprints; its count is unknown.
    }
    return { key: `${size} ${mtimeMs} ${sha}`, count, manifest: parsed };
  } catch {
    return null;
  }
}

/** The fingerprint recorded with a watermark (see `setWatermark`), or
 *  null when the last write of the watermark recorded none. */
function recordedFingerprint(db: Db, watermarkKey: string): string | null {
  const row = prepareCached(
    db,
    "SELECT fingerprint FROM sync_fingerprints WHERE machine_id = ?",
  ).get(watermarkKey) as { fingerprint: string } | undefined;
  return row?.fingerprint ?? null;
}

/**
 * True when ingest is caught up on the segment at `path`, judged without
 * reading it: the manifest counts `lines` (the watermark), and the
 * segment's size, exact mtime and manifest bytes are what the last full,
 * defect-free ingest of this file recorded. Any difference (an append, a
 * rewrite whatever its mtime, a new or edited manifest, a watermark
 * written since by a reset or partial ingest) sends the caller down the
 * full read, which hashes the file and reports any mismatch. Cost: one
 * row lookup, one stat and one manifest read.
 */
export function segmentCaughtUp(
  db: Db,
  watermarkKey: string,
  path: string,
  lines: number,
): boolean {
  const recorded = recordedFingerprint(db, watermarkKey);
  if (recorded === null) return false;
  const now = segmentFingerprint(path);
  return now !== null && now.count === lines && now.key === decodeFingerprint(recorded).key;
}

/** The resume point recorded with the watermark's fingerprint, when it
 *  was recorded at exactly `lines`. */
export function resumePoint(db: Db, watermarkKey: string, lines: number): ResumePoint | null {
  const recorded = recordedFingerprint(db, watermarkKey);
  const resume = recorded === null ? null : decodeFingerprint(recorded).resume;
  return resume !== null && resume.lines === lines ? resume : null;
}
