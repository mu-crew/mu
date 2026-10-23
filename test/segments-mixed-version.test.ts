// Segment versions are checked PER LINE (mu-next README Cut-over §4).
// mu-next reads v1 and v2 and appends v2 to the same file; a line of a
// version this build does not know is refused loudly and is never
// truncated or appended after; a "3.x reader" (exact-equality on v1)
// stops at the first v2 line instead of misreading it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { checkSegmentVersion } from "../src/fleet-hazards.js";
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
import { foreignVersionMessage } from "../src/sync.js";
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

  const rot = (raw: string): string => raw.replace('"crc":"', '"crc":"0');
  const versionsOf = (path: string): number[] =>
    linesOf(path).map((l) => (JSON.parse(l) as { v: number }).v);
  const manifestFile = (): string => segA().replace(/\.jsonl$/, ".manifest");
  const manifestOk = (): void => {
    expect(verifyAgainstManifest(segA()).ok).toBe(true);
    const m = readManifest(segA());
    if (m !== null) expect(manifestSelfConsistent(m)).toBe(true);
  };
  /** Pretend this build was upgraded to read v3 (restored by the caller). */
  const upgrade = (): (() => void) => {
    (SEGMENT_READ_VERSIONS as number[]).push(3);
    return () => {
      (SEGMENT_READ_VERSIONS as number[]).pop();
    };
  };

  describe("a segment holding a line of an unknown version is read-only to this build", () => {
    it("(d) flush appends nothing, repairs nothing, deletes the manifest and reports the segment", async () => {
      seed(a, "t1", "t2");
      await flushSegment(a, dir);
      const n = linesOf(segA()).length;
      await writeMixed(
        Number.POSITIVE_INFINITY,
        Array.from({ length: n }, (_, i) => (i === n - 1 ? 3 : 2)),
      );
      const bytes = readFileSync(segA());

      seed(a, "t3");
      for (const verify of [false, true, false]) {
        const flushed = await flushSegment(a, dir, { verify });
        expect(flushed).toMatchObject({
          segmentPath: segA(),
          appended: 0,
          selfRepaired: null,
          foreignVersionAt: n,
          foreignVersion: 3,
        });
        expect(readFileSync(segA()).equals(bytes)).toBe(true);
        expect(existsSync(manifestFile())).toBe(false);
      }
    });

    it("the message names the segment and tells the operator to upgrade", async () => {
      seed(a, "t1");
      await writeMixed(Number.POSITIVE_INFINITY, [3]);
      const flushed = await flushSegment(a, dir, { verify: true });
      expect(foreignVersionMessage(flushed)).toBe(
        `segment ${segA()} has a v3 line written by a newer mu; upgrade mu on this machine`,
      );
    });

    it("mu doctor reports it (segment-version row), and is ok on a readable segment", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      expect(checkSegmentVersion(a, dir)).toMatchObject({ severity: "ok" });
      await writeMixed(Number.POSITIVE_INFINITY, [3]);
      expect(checkSegmentVersion(a, dir)).toMatchObject({
        name: "segment-version",
        severity: "warn",
        detail: `segment ${segA()} has a v3 line written by a newer mu; upgrade mu on this machine`,
      });
    });

    it("rv6r2_segments_placeholder_loss: [v2, corrupt v2, v3, v2] is untouched; after the upgrade the corrupt op is regenerated, nothing lost", async () => {
      seed(a, "t1", "t2", "t3");
      const lines = await writeMixed(Number.POSITIVE_INFINITY, [2, 2, 3, 2]);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      const damaged = [lines[0], rot(lines[1] ?? ""), ...lines.slice(2)];
      writeFileSync(segA(), `${damaged.join("\n")}\n`);
      const bytes = readFileSync(segA());

      const flushed = await flushSegment(a, dir, { verify: true });
      expect(flushed).toMatchObject({ appended: 0, selfRepaired: null, foreignVersionAt: 3 });
      expect(readFileSync(segA()).equals(bytes)).toBe(true);
      // A peer that was behind stops at the corrupt line, as always.
      expect(ingestSegment(b, peerOfA(), { verify: true }).watermark).toBe(1);

      const restore = upgrade();
      try {
        await flushSegment(a, dir, { verify: true });
        const c = openDb({ path: join(tempDir, "c.db") });
        try {
          expect(ingestSegment(c, peerOfA(), { verify: true }).defects).toEqual([]);
          for (const id of ["t1", "t2", "t3"]) expect(hasTask(c, id)).toBe(true);
        } finally {
          c.close();
        }
        // The behind peer resumes and converges too.
        ingestSegment(b, peerOfA(), { verify: true });
        for (const id of ["t1", "t2", "t3"]) expect(hasTask(b, id)).toBe(true);
      } finally {
        restore();
      }
    });

    it("rv6r2_segments_foreign_manifest: a manifest that vouches for a v3 file is dropped by the scan and never trusted again", async () => {
      seed(a, "t1", "t2");
      await writeMixed(Number.POSITIVE_INFINITY, [1, 3, 2]);
      expect(existsSync(manifestFile())).toBe(true); // vouching, as an earlier build wrote it
      const bytes = readFileSync(segA());

      const scan = await flushSegment(a, dir, { verify: true });
      expect(scan).toMatchObject({ appended: 0, foreignVersionAt: 2, foreignVersion: 3 });
      expect(existsSync(manifestFile())).toBe(false);

      seed(a, "pending");
      for (const verify of [false, false, true]) {
        const next = await flushSegment(a, dir, { verify });
        expect(next).toMatchObject({ appended: 0, foreignVersionAt: 2, foreignVersion: 3 });
        expect(readFileSync(segA()).equals(bytes)).toBe(true);
        expect(existsSync(manifestFile())).toBe(false);
      }
    });

    it("a foreign line after a corrupt one is found: nothing is repaired or truncated", async () => {
      seed(a, "t1", "t2", "t3");
      const lines = await writeMixed(Number.POSITIVE_INFINITY, [1, 1, 3, 2]);
      writeFileSync(segA(), `${[lines[0], rot(lines[1] ?? ""), ...lines.slice(2)].join("\n")}\n`);
      const bytes = readFileSync(segA());

      const flushed = await flushSegment(a, dir, { verify: true });

      expect(flushed).toMatchObject({ appended: 0, selfRepaired: null, foreignVersionAt: 3 });
      expect(readFileSync(segA()).equals(bytes)).toBe(true);
    });

    it("pending ops are written after the upgrade, with no loss", async () => {
      seed(a, "t1", "t2");
      await flushSegment(a, dir);
      const n = linesOf(segA()).length;
      await writeMixed(
        Number.POSITIVE_INFINITY,
        Array.from({ length: n }, (_, i) => (i === n - 1 ? 3 : 2)),
      );
      seed(a, "p1", "p2");
      expect(await flushSegment(a, dir)).toMatchObject({ appended: 0, foreignVersionAt: n });
      expect(await flushSegment(a, dir, { verify: true })).toMatchObject({ appended: 0 });

      const restore = upgrade();
      try {
        const flushed = await flushSegment(a, dir);
        expect(flushed.foreignVersionAt).toBeNull();
        expect(flushed.appended).toBeGreaterThanOrEqual(2);
        expect(versionsOf(segA()).slice(0, n)).toEqual([...Array(n - 1).fill(2), 3]);
        manifestOk();
        expect(ingestSegment(b, peerOfA(), { verify: true }).defects).toEqual([]);
        for (const id of ["t1", "t2", "p1", "p2"]) expect(hasTask(b, id)).toBe(true);
      } finally {
        restore();
      }
    });
  });

  describe("repair of a segment with only known versions", () => {
    it("a damaged line between valid lines is regenerated from ops, at its own position", async () => {
      seed(a, "t1", "t2", "t3");
      const lines = await writeMixed(Number.POSITIVE_INFINITY, [1, 1, 1, 2]);
      writeFileSync(segA(), `${[lines[0], rot(lines[1] ?? ""), ...lines.slice(2)].join("\n")}\n`);

      await flushSegment(a, dir, { verify: true });

      expect(linesOf(segA())[1]).toBe(reencode(lines[1] ?? "", SEGMENT_FORMAT_VERSION));
      expect(linesOf(segA())).toHaveLength(lines.length);
      expect(linesOf(segA())[3]).toBe(lines[3]);
    });

    it("a valid v1 suffix after a corrupt v2 line is preserved byte for byte", async () => {
      seed(a, "t1", "t2", "t3");
      const lines = await writeMixed(Number.POSITIVE_INFINITY);
      const suffix = lines.slice(2).map((l) => reencode(l, 1));
      writeFileSync(segA(), `${[lines[0], rot(lines[1] ?? ""), ...suffix].join("\n")}\n`);

      const flushed = await flushSegment(a, dir, { verify: true });

      expect(flushed.selfRepaired).toMatchObject({ kind: "crc-mismatch", line: 2 });
      expect(flushed.foreignVersionAt).toBeNull();
      expect(linesOf(segA())).toHaveLength(lines.length);
      expect(linesOf(segA()).slice(2)).toEqual(suffix);
      expect(
        versionsOf(segA())
          .slice(2)
          .every((v) => v === 1),
      ).toBe(true);
      manifestOk();
      expect(ingestSegment(b, peerOfA(), { verify: true }).defects).toEqual([]);
    });

    it("a damaged line the DB cannot regenerate falls back to truncate-and-regenerate", async () => {
      seed(a, "t1", "t2", "t3");
      const lines = await writeMixed(Number.POSITIVE_INFINITY, [1, 1, 1, 2]);
      const lostOp = decodeLine(lines[1] ?? "");
      if (!lostOp.ok) throw new Error("setup");
      a.prepare("DELETE FROM ops WHERE hlc = ?").run(lostOp.line.hlc);
      writeFileSync(segA(), `${[lines[0], rot(lines[1] ?? ""), ...lines.slice(2)].join("\n")}\n`);

      const flushed = await flushSegment(a, dir, { verify: true });

      expect(flushed.selfRepaired).toMatchObject({ kind: "crc-mismatch", line: 2 });
      expect(linesOf(segA())).toHaveLength(lines.length - 1);
      manifestOk();
      expect(ingestSegment(b, peerOfA(), { verify: true }).defects).toEqual([]);
    });
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
