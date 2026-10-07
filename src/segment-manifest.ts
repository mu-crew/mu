// mu — the segment manifest (`<machine>.manifest`): layer 4 of the
// segment robustness layers, plus the fields the owner's flush trusts
// instead of rescanning its own segment. Split out of segments.ts
// (1500-LOC cap); segments.ts re-exports the public names.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Sha256State, sha256Digest } from "./sha256-resumable.js";

/** Segment filename suffix. */
const SEGMENT_EXT = ".jsonl";
/** Manifest filename suffix. */
const MANIFEST_EXT = ".manifest";

/** Whole-file verification sidecar. */
export interface SegmentManifest {
  v: number;
  machine: string;
  count: number;
  lastHlc: string | null;
  sha256: string;
  updatedAt: string;
  /** Bytes of the segment `sha256` covers. Written by the owner so its
   *  next flush can trust this manifest instead of rescanning; absent in
   *  manifests from older builds. */
  size?: number;
  /** The segment's mtime when this manifest was written (owner-local). */
  mtimeMs?: number;
  /** Running hash state after `size` bytes, so an append rehashes only
   *  what it added. */
  shaState?: Sha256State;
  /** sha256 over the fields above (`manifestSeal`). The owner trusts
   *  count/size/shaState only when it matches, so a torn or hand-edited
   *  manifest falls back to the full scan instead of being persisted. */
  seal?: string;
}

export function manifestPath(segment: string): string {
  return segment.replace(new RegExp(`${SEGMENT_EXT}$`), MANIFEST_EXT);
}

/** A manifest as this build writes it, with every field the owner's
 *  fast path relies on. */
export type SealedManifest = SegmentManifest & {
  size: number;
  mtimeMs: number;
  shaState: Sha256State;
  seal: string;
};

/** sha256 over every field the owner's fast path trusts, in a fixed
 *  order. Not a defence against a deliberate forger, who could
 *  recompute it; it binds count, lastHlc, size and the hash state to
 *  each other so a torn write or a hand edit of one field is caught. */
export function manifestSeal(m: Omit<SealedManifest, "seal" | "updatedAt">): string {
  return createHash("sha256")
    .update(
      [
        m.v,
        m.machine,
        m.count,
        m.lastHlc ?? "",
        m.sha256,
        m.size,
        m.mtimeMs,
        m.shaState.h,
        m.shaState.n,
        m.shaState.tail,
      ].join("\u001f"),
    )
    .digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * True when the manifest's trusted fields agree with each other: well
 * formed, count is zero exactly when size is, the hash state covers
 * `size` bytes and finishes to `sha256`, and the seal matches. Cheap
 * (at most two SHA-256 blocks plus a hash of a few hundred bytes), and
 * it reads no segment bytes. Anything off sends the owner to the full
 * scan, which recounts, rehashes and rewrites the manifest, so a
 * malformed field is never carried into the next manifest.
 */
export function manifestSelfConsistent(m: SegmentManifest): m is SealedManifest {
  const { count, lastHlc, size, mtimeMs, shaState, seal } = m;
  if (!Number.isSafeInteger(count) || count < 0) return false;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return false;
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return false;
  if (lastHlc !== null && typeof lastHlc !== "string") return false;
  if ((count === 0) !== (size === 0) || (count === 0) !== (lastHlc === null)) return false;
  if (typeof m.sha256 !== "string" || !HEX64.test(m.sha256)) return false;
  if (typeof seal !== "string" || !HEX64.test(seal)) return false;
  if (
    typeof shaState !== "object" ||
    shaState === null ||
    typeof shaState.h !== "string" ||
    !HEX64.test(shaState.h) ||
    shaState.n !== size ||
    typeof shaState.tail !== "string"
  ) {
    return false;
  }
  const tail = Buffer.from(shaState.tail, "base64");
  if (tail.length !== size % 64 || tail.toString("base64") !== shaState.tail) return false;
  if (sha256Digest(shaState) !== m.sha256) return false;
  return manifestSeal({ ...m, size, mtimeMs, shaState }) === seal;
}

/** Write `fields` as the manifest of `segment`, stamped and sealed. */
export function writeManifestFile(
  segment: string,
  fields: Omit<SealedManifest, "seal" | "updatedAt">,
): void {
  const manifest: SegmentManifest = {
    ...fields,
    updatedAt: new Date().toISOString(),
    seal: manifestSeal(fields),
  };
  writeFileSync(manifestPath(segment), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Read a segment's manifest, or null when absent/unparsable. */
export function readManifest(segment: string): SegmentManifest | null {
  const path = manifestPath(segment);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SegmentManifest;
  } catch {
    return null;
  }
}
