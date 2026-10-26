// mu — the sync-dir guard: mu-next never reads or writes a MU_SYNC_DIR that
// a 3.x peer shares. 3.x reads only v1 lines and warns `unknown-version` on
// every command once a v2 line lands in its folder (the 18:04 incident), so
// no segment may open with a v1 line for mu-next to touch the dir.
// Builtins only: segments.ts and the CLI's handle() both import it.
//
// The guard lives INSIDE flushSegment, discoverPeers and ingestSegment, so
// every caller (CLI, SDK, extension, TUI tick) is covered; handle() repeats it
// before the DB opens so a refused run creates nothing at all.

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

/** The one-line refusal. Exit 4 (conflict); nothing was written or read. */
export const SYNC_DIR_FOREIGN_MESSAGE = "MU_SYNC_DIR holds 3.x segments; give mu-next its own dir";

export class SyncDirForeignError extends Error {
  override readonly name = "SyncDirForeignError";
  constructor(
    readonly dir: string,
    /** The segment that opens with a pre-v2 line. */
    readonly segment: string,
  ) {
    super(`${SYNC_DIR_FOREIGN_MESSAGE} (${segment})`);
  }
}

/** Every writer emits `{"v":N,` first (`encodeSegmentLine`), so the first
 *  bytes are enough: no line is parsed, so a segment still being copied in
 *  does not block the dir. */
const VERSION_PREFIX = /^\{"v":(\d+)[,}]/;

/** Test seam: the foreign-version tests deliberately write v1 and v3 segments
 *  into the dir. Never set outside a test. */
let guardOffForTests = false;
export function setSyncDirGuardForTests(off: boolean): void {
  guardOffForTests = off;
}

/** True when a `.manifest` says `"v"` below 2: a 3.x peer's sidecar. A 3.x
 *  peer with no ops yet leaves an EMPTY segment and a v1 manifest, so the
 *  segment's first line cannot show it. Unreadable or torn: not evidence. */
function manifestIsPreV2(path: string): boolean {
  try {
    const v: unknown = (JSON.parse(readFileSync(path, "utf8")) as { v?: unknown } | null)?.v;
    return typeof v === "number" && v < 2;
  } catch {
    return false;
  }
}

/** False only when the file's first bytes are a recognisable pre-v2 line (what
 *  3.x writes). Empty, torn, garbage and newer-than-v2 files are not evidence
 *  of a 3.x peer: the segment reader reports them as defects, and a v3 line
 *  keeps its "upgrade mu" warning rather than a message that blames 3.x. */
function startsAsV2OrUnknown(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return true; // vanished or unreadable: not evidence of a 3.x peer
  }
  try {
    const buf = Buffer.alloc(24);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = VERSION_PREFIX.exec(buf.toString("utf8", 0, n));
    return m === null || Number(m[1]) >= 2;
  } catch {
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Throw `SyncDirForeignError` when ANY file in `dir` is 3.x evidence: a
 * `*.jsonl` (conflict copies included) whose first line is pre-v2, or a
 * `*.manifest` whose `"v"` is below 2 (covers an empty segment). Every file is
 * scanned, in name order. A missing or empty dir passes. Only the first line
 * decides: a v1 file that later gained v2 lines is a 3.x file.
 */
export function assertSyncDirV2(dir: string): void {
  if (guardOffForTests) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const path = join(dir, name);
    const foreign = name.endsWith(".jsonl")
      ? !startsAsV2OrUnknown(path)
      : name.endsWith(".manifest") && manifestIsPreV2(path);
    if (foreign) throw new SyncDirForeignError(dir, name);
  }
}
