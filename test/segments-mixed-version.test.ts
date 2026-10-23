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

  const rot = (raw: string): string => raw.replace('"crc":"', '"crc":"0');
  const versionsOf = (path: string): number[] =>
    linesOf(path).map((l) => (JSON.parse(l) as { v: number }).v);
  const manifestOk = (): void => {
    expect(verifyAgainstManifest(segA()).ok).toBe(true);
    const m = readManifest(segA());
    if (m !== null) expect(manifestSelfConsistent(m)).toBe(true);
  };

  describe("repair keeps every line at its line number", () => {
    it("a corrupt v1 line before a v3 line: the line is replaced in place by a placeholder, the v3 line keeps its number", async () => {
      seed(a, "t1", "t2", "t3");
      const lines = await writeMixed(Number.POSITIVE_INFINITY, [1, 1, 3, 2]);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      writeFileSync(segA(), `${[lines[0], rot(lines[1] ?? ""), ...lines.slice(2)].join("\n")}\n`);

      const flushed = await flushSegment(a, dir, { verify: true });

      expect(flushed.selfRepaired).toMatchObject({ kind: "crc-mismatch", line: 2 });
      expect(flushed).toMatchObject({ appended: 0, foreignVersionAt: 3, foreignVersion: 3 });
      const after = linesOf(segA());
      expect(after).toHaveLength(lines.length);
      expect(after[0]).toBe(lines[0]);
      expect(after.slice(2)).toEqual(lines.slice(2));
      // The line after the gap is foreign, so its hlc bounds nothing and
      // the op is not regenerated: a placeholder holds the place.
      expect(decodeLine(after[1] ?? "")).toMatchObject({
        ok: true,
        line: { entity: "segment.placeholder" },
      });
    });

    it("repeated ambient flushes never append behind a foreign line after a repair", async () => {
      seed(a, "t1", "t2", "t3");
      const lines = await writeMixed(Number.POSITIVE_INFINITY, [1, 1, 3, 2]);
      writeFileSync(segA(), `${[lines[0], rot(lines[1] ?? ""), ...lines.slice(2)].join("\n")}\n`);
      const first = await flushSegment(a, dir);
      expect(first).toMatchObject({ appended: 0, foreignVersionAt: 3, foreignVersion: 3 });
      const repaired = readFileSync(segA());

      seed(a, "pending");
      for (const verify of [false, false, true]) {
        const next = await flushSegment(a, dir, { verify });
        expect(next).toMatchObject({ appended: 0, foreignVersionAt: 3, foreignVersion: 3 });
        expect(readFileSync(segA()).equals(repaired)).toBe(true);
      }
    });

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

    it("a caught-up peer is not moved past a v3 line by a repair of an earlier line", async () => {
      seed(a, "t1", "t2");
      await flushSegment(a, dir);
      const before = ingestSegment(b, peerOfA()).watermark;
      seed(a, "blocked", "after-foreign");
      await flushSegment(a, dir);
      const lines = linesOf(segA());
      const mixed = [
        lines[0],
        rot(lines[1] ?? ""),
        lines[2],
        reencode(lines[before] ?? "", 3),
        lines[before + 1],
      ];
      writeFileSync(segA(), `${mixed.join("\n")}\n`);

      const repaired = await flushSegment(a, dir, { verify: true });
      expect(repaired).toMatchObject({ foreignVersionAt: before + 1, foreignVersion: 3 });
      const result = ingestSegment(b, peerOfA(), { verify: true });

      expect(result.defects).toContainEqual(
        expect.objectContaining({ kind: "unknown-version", line: before + 1, version: 3 }),
      );
      expect(result.watermark).toBe(before);
      expect(hasTask(b, "blocked")).toBe(false);
      expect(hasTask(b, "after-foreign")).toBe(false);
    });

    it("a v3 line appended after a peer caught up is not lost when an earlier line is repaired", async () => {
      seed(a, "t1", "t2");
      await flushSegment(a, dir);
      const caughtUp = ingestSegment(b, peerOfA()).watermark;
      expect(versionsOf(segA()).every((v) => v === 2)).toBe(true);
      seed(a, "from-newer-mu");
      await flushSegment(a, dir);
      const lines = linesOf(segA());
      expect(lines).toHaveLength(caughtUp + 1);
      writeFileSync(
        segA(),
        `${[
          lines[0],
          rot(lines[1] ?? ""),
          ...lines.slice(2, caughtUp),
          reencode(lines[caughtUp] ?? "", 3),
        ].join("\n")}\n`,
      );

      await flushSegment(a, dir, { verify: true });
      for (const verify of [true, false]) {
        const result = ingestSegment(b, peerOfA(), { verify });
        expect(result.watermark).toBe(caughtUp);
        expect(result.defects).toContainEqual(
          expect.objectContaining({ kind: "unknown-version", line: caughtUp + 1, version: 3 }),
        );
      }
      expect(hasTask(b, "from-newer-mu")).toBe(false);
    });

    it("a damaged line the DB cannot regenerate becomes a placeholder: counted, never applied, numbers kept", async () => {
      seed(a, "t1", "t2", "t3");
      const lines = await writeMixed(Number.POSITIVE_INFINITY, [1, 1, 1, 3, 2]);
      const lostOp = decodeLine(lines[1] ?? "");
      if (!lostOp.ok) throw new Error("setup");
      a.prepare("DELETE FROM ops WHERE hlc = ?").run(lostOp.line.hlc);
      writeFileSync(segA(), `${[lines[0], rot(lines[1] ?? ""), ...lines.slice(2)].join("\n")}\n`);

      const flushed = await flushSegment(a, dir, { verify: true });

      const after = linesOf(segA());
      expect(after).toHaveLength(lines.length);
      expect(after.slice(2)).toEqual(lines.slice(2));
      expect(decodeLine(after[1] ?? "")).toMatchObject({ ok: true });
      expect(flushed).toMatchObject({ foreignVersionAt: 4, foreignVersion: 3 });
      // Peer: the placeholder is counted and skipped; ingest stops at the v3 line (4).
      const result = ingestSegment(b, peerOfA(), { verify: true });
      expect(result.defects).toEqual([
        expect.objectContaining({ kind: "unknown-version", line: 4, version: 3 }),
      ]);
      expect(result.watermark).toBe(3);
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
