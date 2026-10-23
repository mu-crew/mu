// Segment versions are checked PER LINE (mu-next README Cut-over §4).
// mu-next reads v1 and v2 and appends v2 to the same file; a line of a
// version this build does not know is refused loudly and is never
// truncated or appended after; a "3.x reader" (exact-equality on v1)
// stops at the first v2 line instead of misreading it.

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { manifestSelfConsistent, writeManifestFile } from "../src/segment-manifest.js";
import { decodeFingerprint } from "../src/segment-resume.js";
import {
  decodeLine,
  discoverPeers,
  encodeSegmentLine,
  flushSegment,
  ingestSegment,
  localMachineId,
  readManifest,
  SEGMENT_FORMAT_VERSION,
  SEGMENT_READ_VERSIONS,
  segmentPath,
  verifyAgainstManifest,
} from "../src/segments.js";
import { sha256Digest, sha256Initial, sha256Update } from "../src/sha256-resumable.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("segment versions are checked per line", () => {
  let tempDir: string;
  let dir: string;
  let a: Db;
  let b: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-seg-mixed-"));
    dir = join(tempDir, "sync");
    mkdirSync(dir, { recursive: true });
    a = openDb({ path: join(tempDir, "a.db") });
    b = openDb({ path: join(tempDir, "b.db") });
  });

  afterEach(() => {
    for (const db of [a, b]) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    rmFixtureDir(tempDir);
  });

  const seed = (db: Db, ...ids: string[]): void => {
    ensureWorkstream(db, "demo");
    for (const id of ids) {
      addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
    }
  };
  const hasTask = (db: Db, id: string): boolean =>
    db.prepare("SELECT 1 FROM tasks WHERE local_id = ?").get(id) !== undefined;
  const linesOf = (path: string): string[] =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  const segA = (): string => segmentPath(dir, localMachineId(a));

  /** The same op re-encoded at `version` (the crc covers `v`). */
  const reencode = (raw: string, version: number): string => {
    const d = decodeLine(raw);
    if (!d.ok) throw new Error(`cannot re-encode: ${d.detail}`);
    return encodeSegmentLine(
      {
        hlc: d.line.hlc,
        machineId: d.line.machine,
        groupId: d.line.group,
        intent: d.line.intent,
        actor: d.line.actor,
        entity: d.line.entity,
        key: d.line.key,
        op: d.line.op,
        payload: d.payloadText,
      },
      version,
    );
  };

  /** A's current history as a segment whose first `n` lines are v1 and
   *  the rest v2, with a manifest as an older build would have left it. */
  const writeMixed = async (n: number, versions?: readonly number[]): Promise<string[]> => {
    await flushSegment(a, dir);
    const lines = linesOf(segA()).map((l, i) => reencode(l, versions?.[i] ?? (i < n ? 1 : 2)));
    writeFileSync(segA(), `${lines.join("\n")}\n`);
    stampManifest(2, lines.length);
    return lines;
  };
  const stampManifest = (v: number, count: number): void => {
    const bytes = readFileSync(segA());
    const shaState = sha256Update(sha256Initial(), bytes);
    const last = decodeLine(linesOf(segA()).at(-1) ?? "");
    writeManifestFile(segA(), {
      v,
      machine: localMachineId(a),
      count,
      lastHlc: last.ok ? last.line.hlc : null,
      sha256: sha256Digest(shaState),
      size: bytes.length,
      mtimeMs: statSync(segA()).mtimeMs,
      shaState,
    });
  };
  const peerOfA = () => {
    const peer = discoverPeers(dir, localMachineId(b))[0];
    if (peer === undefined) throw new Error("expected a peer");
    return peer;
  };

  it("writes v2 and reads v1 and v2", () => {
    expect(SEGMENT_FORMAT_VERSION).toBe(2);
    expect(SEGMENT_READ_VERSIONS).toEqual([1, 2]);
  });

  it("(a) a file with v1 lines then v2 lines ingests all of them", async () => {
    seed(a, "t1", "t2", "t3", "t4");
    const lines = await writeMixed(3);
    expect(lines.length).toBeGreaterThan(3);

    const result = ingestSegment(b, peerOfA());
    expect(result.defects).toEqual([]);
    expect(result.watermark).toBe(lines.length);
    for (const id of ["t1", "t2", "t3", "t4"]) expect(hasTask(b, id)).toBe(true);
  });

  it("(b) a 3.x reader (read versions [1]) refuses the first v2 line and applies the v1 lines before it", async () => {
    seed(a, "t1", "t2", "t3", "t4");
    const lines = await writeMixed(3);
    const only1 = [1] as const;

    for (const l of lines.slice(0, 3)) expect(decodeLine(l, only1).ok).toBe(true);
    const refused = decodeLine(lines[3] ?? "", only1);
    expect(refused).toMatchObject({ ok: false, kind: "unknown-version", version: 2 });
    if (!refused.ok) expect(refused.detail).toBe("segment format v2, this mu understands v1");
  });

  it("(c) own segment with v1 history gets v2 appends and a clean manifest", async () => {
    seed(a, "t1", "t2");
    await writeMixed(Number.POSITIVE_INFINITY);
    const before = readFileSync(segA());
    const n = linesOf(segA()).length;
    stampManifest(1, n);

    seed(a, "t3");
    const flushed = await flushSegment(a, dir);

    expect(flushed).toMatchObject({ appended: 1, selfRepaired: null, foreignVersionAt: null });
    const after = readFileSync(segA());
    expect(after.subarray(0, before.length).equals(before)).toBe(true); // v1 bytes untouched
    const lines = linesOf(segA());
    expect(lines).toHaveLength(n + 1);
    expect(JSON.parse(lines.at(-1) ?? "").v).toBe(2);
    expect(JSON.parse(lines[0] ?? "").v).toBe(1);

    const m = readManifest(segA());
    expect(m?.count).toBe(n + 1);
    expect(m && manifestSelfConsistent(m)).toBe(true);
    expect(m?.shaState).toEqual(sha256Update(sha256Initial(), after));
    expect(verifyAgainstManifest(segA())).toMatchObject({ ok: true });
    // Nothing else pending: a second flush is a clean no-op.
    expect(await flushSegment(a, dir, { verify: true })).toMatchObject({
      appended: 0,
      selfRepaired: null,
      foreignVersionAt: null,
    });
  });

  it("a peer that read the v1 part resumes over the appended v2 lines", async () => {
    seed(a, "t1", "t2");
    await writeMixed(Number.POSITIVE_INFINITY);
    stampManifest(1, linesOf(segA()).length);
    const peer = peerOfA();
    expect(ingestSegment(b, peer).defects).toEqual([]);

    seed(a, "t3", "t4");
    await flushSegment(a, dir);
    const second = ingestSegment(b, peer);

    expect(second).toMatchObject({ defects: [], truncatedAt: null });
    expect(second.applied).toBeGreaterThanOrEqual(2);
    expect(hasTask(b, "t4")).toBe(true);
    const row = b
      .prepare("SELECT fingerprint FROM sync_fingerprints WHERE machine_id = ?")
      .get(localMachineId(a)) as { fingerprint: string };
    expect(decodeFingerprint(row.fingerprint).resume).toMatchObject({
      lines: linesOf(segA()).length,
      size: statSync(segA()).size,
    });
  });

  it("(d) own segment containing a v3 line is left byte-identical by flush", async () => {
    // A newer mu appended v3 after v2 history and stamped its manifest.
    seed(a, "t1", "t2");
    await flushSegment(a, dir);
    const n = linesOf(segA()).length;
    const lines = await writeMixed(
      Number.POSITIVE_INFINITY,
      Array.from({ length: n }, (_, i) => (i === n - 1 ? 3 : 2)),
    );
    const bytes = readFileSync(segA());
    const manifestBytes = readFileSync(segA().replace(/\.jsonl$/, ".manifest"), "utf8");

    seed(a, "t3");
    for (const verify of [false, true]) {
      const flushed = await flushSegment(a, dir, { verify });
      expect(flushed).toMatchObject({
        appended: 0,
        selfRepaired: null,
        foreignVersionAt: n,
        foreignVersion: 3,
      });
      expect(lines).toHaveLength(n);
      expect(readFileSync(segA()).equals(bytes)).toBe(true);
    }
    expect(readFileSync(segA().replace(/\.jsonl$/, ".manifest"), "utf8")).toBe(manifestBytes);
  });

  it("a corrupt v1 line followed by a v3 line: repair drops only the corrupt line, never the v3 line", async () => {
    seed(a, "t1", "t2", "t3");
    const lines = await writeMixed(Number.POSITIVE_INFINITY, [1, 1, 3, 2]);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const corrupt = (lines[1] ?? "").replace('"crc":"', '"crc":"0');
    const file = [lines[0], corrupt, ...lines.slice(2)];
    writeFileSync(segA(), `${file.join("\n")}\n`);

    const flushed = await flushSegment(a, dir, { verify: true });

    expect(flushed.selfRepaired).toMatchObject({ kind: "crc-mismatch", line: 2 });
    expect(flushed).toMatchObject({ appended: 0, foreignVersionAt: 2, foreignVersion: 3 });
    // Every line of the other version survives byte for byte, as does
    // everything after the corrupt line; only the corrupt line is gone.
    expect(linesOf(segA())).toEqual([lines[0], ...lines.slice(2)]);
  });

  it("a corrupt line with NO foreign line later is still truncated and regenerated", async () => {
    seed(a, "t1", "t2", "t3");
    const lines = await writeMixed(Number.POSITIVE_INFINITY);
    const corrupt = (lines[1] ?? "").replace('"crc":"', '"crc":"0');
    writeFileSync(segA(), `${[lines[0], corrupt, ...lines.slice(2)].join("\n")}\n`);

    const flushed = await flushSegment(a, dir, { verify: true });

    expect(flushed.selfRepaired).toMatchObject({ kind: "crc-mismatch", line: 2 });
    expect(flushed.foreignVersionAt).toBeNull();
    expect(linesOf(segA())).toHaveLength(lines.length); // regenerated
    expect(ingestSegment(b, peerOfA()).defects).toEqual([]);
  });

  it("peer ingest of a v3 line is an unknown-version defect, stops there, watermark not advanced past it", async () => {
    seed(a, "t1", "t2", "t3", "t4");
    const lines = await writeMixed(Number.POSITIVE_INFINITY, [1, 1, 1, 3, 2]);

    const result = ingestSegment(b, peerOfA());

    expect(result.defects).toEqual([
      expect.objectContaining({ kind: "unknown-version", line: 4, version: 3 }),
    ]);
    expect(result.truncatedAt).toBe(4);
    expect(result.watermark).toBe(3);
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });
});
