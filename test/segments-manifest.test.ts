// Tests for src/segments.ts — the transport layer.
//
// The shape that matters is TWO DATABASES and one shared directory,
// because that is the real deployment: two machines, a folder something
// else moves. Single-DB tests would pass while missing the whole point,
// so most tests here open two temp DBs.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { withFileLock } from "../src/file-lock.js";
import { formatHlc } from "../src/hlc.js";
import {
  decodeFingerprint,
  encodeFingerprint,
  type ResumePoint,
  readAppended,
} from "../src/segment-resume.js";
import {
  discoverPeers,
  flushSegment,
  getWatermark,
  ingestSegment,
  localMachineId,
  manifestSeal,
  readManifest,
  segmentLockPath,
  segmentPath,
  setWatermark,
  syncPass,
  verifyAgainstManifest,
} from "../src/segments.js";
import { sha256Initial, sha256Update } from "../src/sha256-resumable.js";
import { ambientFlush, ambientIngest } from "../src/sync.js";
import { SyncDirMovedError } from "../src/sync-dir-guard.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { cachedDeadPid } from "./_dead-pid.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

const deadPid = cachedDeadPid();

vi.mock("../src/file-lock.js", { spy: true });

describe("segments", () => {
  let tempDir: string;
  let dir: string;
  let a: Db;
  let b: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-seg-test-"));
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
    const key = "MU_SYNC_DIR";
    delete process.env[key];
    rmFixtureDir(tempDir);
  });

  const seedTask = (db: Db, localId: string, impact = 50): void => {
    ensureWorkstream(db, "demo");
    addTask(db, {
      workstream: "demo",
      localId,
      title: localId.toUpperCase(),
      impact,
      effortDays: 1,
    });
  };

  const task = (db: Db, localId: string) =>
    db
      .prepare("SELECT local_id, title, status, impact FROM tasks WHERE local_id = ?")
      .get(localId) as
      | { local_id: string; title: string; status: string; impact: number }
      | undefined;

  /** Every peer segment `db` can see. */
  const peersFor = (db: Db) => discoverPeers(dir, localMachineId(db));

  const segFor = (db: Db): string => segmentPath(dir, localMachineId(db));

  const linesOf = (path: string): string[] =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");

  it("ingestSegment accepts the pre-watermarkKey PeerSegment shape (SDK compat)", async () => {
    // PeerSegment / ingestSegment are exported from src/index.ts. A
    // caller written before watermarkKey existed must still persist a
    // watermark keyed by the machine id, not a NULL sync_peers row.
    seedTask(a, "compat");
    await flushSegment(a, dir);
    const machineId = localMachineId(a);
    const path = segFor(a);
    const oldShape = { machineId, path, conflictCopy: false };
    ingestSegment(b, oldShape);
    ingestSegment(b, oldShape);

    expect(task(b, "compat")).toBeDefined();
    expect(getWatermark(b, machineId)).toBe(linesOf(path).length);
    expect(b.prepare("SELECT machine_id FROM sync_peers WHERE machine_id IS NULL").all()).toEqual(
      [],
    );
  });

  // ─── flush cost: O(appended), not O(file) ────────────────────────────

  describe("flush trusts its own manifest", () => {
    const seedFour = async (): Promise<string> => {
      ensureWorkstream(a, "demo");
      for (let i = 0; i < 4; i++) seedTask(a, `t${i}`);
      await flushSegment(a, dir);
      return segFor(a);
    };

    /** Rot line 2 in place: same byte length, mtime restored, so only a
     *  reader that decodes line 2 can tell. */
    const rotLineTwoInvisibly = (path: string): void => {
      const before = statSync(path);
      const lines = linesOf(path);
      const second = lines[1];
      if (second === undefined) throw new Error("need 2 lines");
      lines[1] = second.replace(/"crc":"(.)/, (_m, c: string) => `"crc":"${c === "0" ? "1" : "0"}`);
      writeFileSync(path, `${lines.join("\n")}\n`);
      expect(statSync(path).size).toBe(before.size);
      restampManifestMtime(path);
    };

    /** Point the manifest at the file's current mtime, as if the rewrite
     *  had kept it: the stat check then passes and only decoding a line
     *  could reveal the change. */
    const restampManifestMtime = (path: string): void => {
      const manifestFile = path.replace(/\.jsonl$/, ".manifest");
      const m = JSON.parse(readFileSync(manifestFile, "utf8")) as Parameters<
        typeof manifestSeal
      >[0] & { seal: string };
      m.mtimeMs = statSync(path).mtimeMs;
      m.seal = manifestSeal(m);
      writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
    };

    it("a no-op flush decodes no existing line and leaves the manifest untouched", async () => {
      const path = await seedFour();
      const manifestFile = path.replace(/\.jsonl$/, ".manifest");
      rotLineTwoInvisibly(path);
      const manifestBefore = readFileSync(manifestFile, "utf8");
      const rotted = readFileSync(path, "utf8");

      // The old path decoded every line, so it saw the rot and
      // "repaired" it. The new one reads the manifest and the last line.
      const result = await flushSegment(a, dir);
      expect(result.selfRepaired).toBeNull();
      expect(result.appended).toBe(0);
      expect(result.total).toBe(4 + 1); // workstream + four tasks
      expect(readFileSync(path, "utf8")).toBe(rotted);
      expect(readFileSync(manifestFile, "utf8")).toBe(manifestBefore);
    });

    it("an append reads only the tail and hashes incrementally", async () => {
      const path = await seedFour();
      const original = readFileSync(path);
      rotLineTwoInvisibly(path);
      const rotted = readFileSync(path, "utf8");
      seedTask(a, "t4");
      const result = await flushSegment(a, dir);
      // Line 2 was not decoded (no repair), the new op was appended.
      expect(result.selfRepaired).toBeNull();
      expect(result.appended).toBe(1);
      expect(result.total).toBe(6);
      const now = readFileSync(path);
      expect(now.toString("utf8").startsWith(rotted)).toBe(true);
      // The hash resumed from the manifest's state (the ORIGINAL bytes)
      // and covered only the appended bytes; it never re-read the file.
      const appended = now.subarray(original.length);
      const manifest = readManifest(path);
      expect(manifest?.sha256).toBe(
        createHash("sha256")
          .update(Buffer.concat([original, appended]))
          .digest("hex"),
      );
      expect(manifest?.count).toBe(6);
    });

    it("explicit mu sync (syncPass) still decodes every line and repairs hidden rot", async () => {
      const path = await seedFour();
      rotLineTwoInvisibly(path);
      const pass = await syncPass(a, dir);
      expect(pass.flushed.selfRepaired).toMatchObject({ kind: "crc-mismatch", line: 2 });
      expect(pass.defective).toBe(true);
      expect(linesOf(path)).toHaveLength(5);
      expect(verifyAgainstManifest(path).ok).toBe(true);
    });

    it("incremental hashes stay equal to a full hash across many appends", async () => {
      await seedFour();
      for (let i = 0; i < 20; i++) {
        seedTask(a, `many-${i}`);
        await flushSegment(a, dir);
        const path = segFor(a);
        expect(readManifest(path)?.sha256).toBe(
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        );
      }
      expect(verifyAgainstManifest(segFor(a)).ok).toBe(true);
    });

    it("a no-op flush reads none of a long trailing run of machine-local ops", async () => {
      const path = await seedFour();
      const manifestFile = path.replace(/\.jsonl$/, ".manifest");
      const manifestBefore = readFileSync(manifestFile, "utf8");
      const machineId = localMachineId(a);
      const insert = a.prepare(
        `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
         VALUES (?, ?, 'g', 'user', 'agent.update', 'agent', 'demo/w', 'put', '{"pane_id":"%1"}', '')`,
      );
      a.transaction(() => {
        for (let i = 0; i < 100_000; i++) {
          insert.run(
            formatHlc({ wallMs: 3_000_000_000_000 + i, counter: 0, machineId }),
            machineId,
          );
        }
        // As capture would have: the clock now sits past the run.
        a.prepare("UPDATE machine_identity SET last_wall = ? WHERE id = 1").run(
          3_000_000_000_000 + 100_000,
        );
      })();

      // Count every row any statement hands to JS during the flush. The
      // old query returned all 100k agent rows and filtered them in JS,
      // on every invocation.
      const proto = Object.getPrototypeOf(a.prepare("SELECT 1")) as {
        all: (...args: unknown[]) => unknown[];
      };
      const realAll = proto.all;
      let rowsRead = 0;
      proto.all = function (this: unknown, ...args: unknown[]) {
        const rows = realAll.apply(this, args);
        rowsRead += rows.length;
        return rows;
      };
      try {
        for (let i = 0; i < 3; i++) {
          const result = await flushSegment(a, dir);
          expect(result).toMatchObject({ appended: 0, total: 5, skippedLocal: 0 });
        }
        // One synced op after the run: only it is read and appended.
        seedTask(a, "after-run");
        const appended = await flushSegment(a, dir);
        expect(appended.appended).toBe(1);
        expect(appended.total).toBe(6);
        // The covered range includes the 100k agent ops, counted once.
        expect(appended.skippedLocal).toBe(100_000);
        expect(await flushSegment(a, dir)).toMatchObject({ appended: 0, skippedLocal: 0 });
      } finally {
        proto.all = realAll;
      }
      expect(rowsRead).toBeLessThan(10);
      expect(readFileSync(path, "utf8")).not.toContain("pane_id");
      expect(readFileSync(manifestFile, "utf8")).not.toBe(manifestBefore);
      expect(verifyAgainstManifest(path).ok).toBe(true);
    });

    /** Edit one manifest field in place, leaving the seal as it was. */
    const editManifest = (path: string, edit: (m: Record<string, unknown>) => void): void => {
      const manifestFile = path.replace(/\.jsonl$/, ".manifest");
      const m = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
      edit(m);
      writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
    };
    const fullSha = (path: string): string =>
      createHash("sha256").update(readFileSync(path)).digest("hex");

    it("a wrong manifest count is not trusted, persisted, or able to mask truncation", async () => {
      const path = await seedFour();
      for (let i = 0; i < 6; i++) seedTask(a, `more-${i}`);
      await flushSegment(a, dir);
      editManifest(path, (m) => {
        m.count = 1;
      });

      // The no-op falls back to the full scan and reports the real count.
      expect((await flushSegment(a, dir)).total).toBe(11);
      seedTask(a, "one-more");
      expect((await flushSegment(a, dir)).total).toBe(12);
      expect(readManifest(path)?.count).toBe(12);
      expect(readManifest(path)?.sha256).toBe(fullSha(path));

      // Truncation on a line boundary is still reported to a peer.
      writeFileSync(path, `${linesOf(path).slice(0, 10).join("\n")}\n`);
      expect(verifyAgainstManifest(path).ok).toBe(false);
    });

    it("a corrupt hash state is not resumed, so the manifest sha stays the file's", async () => {
      const path = await seedFour();
      editManifest(path, (m) => {
        const state = m.shaState as { h: string };
        state.h = `${state.h.slice(0, -1)}${state.h.endsWith("0") ? "1" : "0"}`;
      });
      seedTask(a, "t4");
      expect((await flushSegment(a, dir)).appended).toBe(1);
      expect(readManifest(path)?.sha256).toBe(fullSha(path));
      expect(verifyAgainstManifest(path).ok).toBe(true);
    });

    it.each([
      ["size and count disagree", (m: Record<string, unknown>) => (m.count = 0)],
      [
        "shaState.n is not size",
        (m: Record<string, unknown>) => ((m.shaState as { n: number }).n += 1),
      ],
      [
        "shaState.tail has the wrong length",
        (m: Record<string, unknown>) => ((m.shaState as { tail: string }).tail = ""),
      ],
      ["sha256 is not hex", (m: Record<string, unknown>) => (m.sha256 = "zz")],
      ["the seal is missing", (m: Record<string, unknown>) => delete m.seal],
      ["lastHlc is a number", (m: Record<string, unknown>) => (m.lastHlc = 7)],
    ])("a manifest where %s falls back to the full scan and is rewritten", async (_name, edit) => {
      const path = await seedFour();
      editManifest(path, edit);
      seedTask(a, "t4");
      const result = await flushSegment(a, dir);
      expect(result).toMatchObject({ appended: 1, total: 6 });
      const m = readManifest(path);
      expect(m?.count).toBe(6);
      expect(m?.sha256).toBe(fullSha(path));
      expect(m?.seal).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a torn tail is still detected and self-repaired", async () => {
      const path = await seedFour();
      const whole = readFileSync(path, "utf8");
      writeFileSync(path, `${whole}{"v":1,"hlc":"0019`);
      const result = await flushSegment(a, dir);
      expect(result.selfRepaired?.kind).toBe("torn-write");
      expect(readFileSync(path, "utf8")).toBe(whole);
      expect(result.total).toBe(5);
    });

    it("a corrupt last line is still detected even when size and mtime match", async () => {
      const path = await seedFour();
      const before = statSync(path);
      const lines = linesOf(path);
      const last = lines[lines.length - 1];
      if (last === undefined) throw new Error("need a line");
      lines[lines.length - 1] = last.replace(
        /"crc":"(.)/,
        (_m, c: string) => `"crc":"${c === "0" ? "1" : "0"}`,
      );
      writeFileSync(path, `${lines.join("\n")}\n`);
      expect(statSync(path).size).toBe(before.size);
      restampManifestMtime(path);
      const result = await flushSegment(a, dir);
      expect(result.selfRepaired?.kind).toBe("crc-mismatch");
      // Truncated to the good prefix and regenerated from `ops`.
      expect(linesOf(path)).toHaveLength(5);
      expect(result.appended).toBe(1);
    });

    it("a segment truncated on a line boundary is regenerated from ops", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      writeFileSync(path, `${lines.slice(0, 2).join("\n")}\n`);
      const result = await flushSegment(a, dir);
      expect(result.appended).toBe(3);
      expect(linesOf(path)).toEqual(lines);
    });

    it("a no-op flush never attempts to acquire the held segment lock", async () => {
      await seedFour();
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        holdSegmentLock();
        vi.mocked(withFileLock).mockClear();
        const result = await flushSegment(a, dir, { lockWaitMs: 0 });
        expect(result.appended).toBe(0);
        expect(withFileLock).not.toHaveBeenCalled();
      });
    });

    /** Create the segment lock as another holder would: a lock dir whose
     *  meta names `pid` (default: this live process), `ageMs` old. */
    const holdSegmentLock = (ageMs = 0, pid = process.pid): string => {
      const lockPath = segmentLockPath(dir, localMachineId(a));
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(
        join(lockPath, "meta.json"),
        JSON.stringify({ pid, label: "other", acquiredAt: "", token: "other" }),
      );
      if (ageMs > 0) {
        const t = new Date(Date.now() - ageMs);
        utimesSync(lockPath, t, t);
      }
      return lockPath;
    };

    it("a pending flush never appends while another process holds the lock", async () => {
      const path = await seedFour();
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        const lockPath = holdSegmentLock();
        const bytes = readFileSync(path);
        const before = linesOf(path).length;
        const manifestFile = path.replace(/\.jsonl$/, ".manifest");
        const manifest = readFileSync(manifestFile, "utf8");
        seedTask(a, "pending");

        const busy = await flushSegment(a, dir, { lockWaitMs: 30 });
        expect(busy.lockBusy).toBe(true);
        expect(busy.appended).toBe(0);
        // Neither the segment nor its manifest was touched, and the
        // foreign lock is still in place.
        expect(readFileSync(path).equals(bytes)).toBe(true);
        expect(readFileSync(manifestFile, "utf8")).toBe(manifest);
        expect(existsSync(lockPath)).toBe(true);

        // The holder releases; the next flush appends the op once.
        rmFixtureDir(lockPath);
        const later = await flushSegment(a, dir);
        expect(later.lockBusy).toBeUndefined();
        expect(later.appended).toBe(1);
        expect(await flushSegment(a, dir)).toMatchObject({ appended: 0 });
        const hlcs = linesOf(path).map((l) => (JSON.parse(l) as { hlc: string }).hlc);
        expect(hlcs).toHaveLength(before + 1);
        expect(new Set(hlcs).size).toBe(before + 1);
      });
    });

    it("ambientFlush lockWaitMs: 0 tries the held lock without a retry budget", async () => {
      await seedFour();
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        await withEnv("MU_SYNC_DIR", dir, async () => {
          const lockPath = holdSegmentLock();
          seedTask(a, "pending");
          vi.mocked(withFileLock).mockClear();
          const busy = await ambientFlush(a, { lockWaitMs: 0 });
          expect(busy?.lockBusy).toBe(true);
          expect(withFileLock).toHaveBeenCalledExactlyOnceWith(
            lockPath,
            expect.any(String),
            expect.any(Function),
            expect.objectContaining({ acquireTimeoutMs: 0 }),
          );
        });
      });
    });

    it("a writer through a symlinked spelling of the sync dir waits on the same lock", async () => {
      const path = await seedFour();
      const alias = join(tempDir, "alias");
      symlinkSync(dir, alias);
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        holdSegmentLock();
        const bytes = readFileSync(path);
        seedTask(a, "pending");
        const busy = await flushSegment(a, alias, { lockWaitMs: 30 });
        expect(busy.lockBusy).toBe(true);
        expect(readFileSync(path).equals(bytes)).toBe(true);
      });
    });

    // realpath keeps the caller's case, so only the folder's identity
    // makes `SYNC` and `sync` one lock. Needs a case-insensitive volume
    // (the macOS default); a case-sensitive one has no second spelling.
    const caseFolds = (): boolean => existsSync(dir.toUpperCase());
    it("a writer through another case of the sync dir waits on the same lock", async (ctx) => {
      if (!caseFolds()) ctx.skip();
      const path = await seedFour();
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        holdSegmentLock();
        const bytes = readFileSync(path);
        seedTask(a, "pending");
        const busy = await flushSegment(a, join(tempDir, "SYNC"), { lockWaitMs: 30 });
        expect(busy.lockBusy).toBe(true);
        expect(readFileSync(path).equals(bytes)).toBe(true);
      });
    });

    it("a symlink retargeted while the flush queues writes where it locked", async () => {
      const path = await seedFour();
      const other = join(tempDir, "other");
      mkdirSync(other);
      const alias = join(tempDir, "alias");
      symlinkSync(dir, alias);
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        // A live holder of `other`'s lock: nothing may append there.
        const held = segmentLockPath(other, localMachineId(a));
        mkdirSync(held, { recursive: true });
        writeFileSync(
          join(held, "meta.json"),
          JSON.stringify({ pid: process.pid, label: "other", acquiredAt: "", token: "other" }),
        );
        const before = linesOf(path).length;
        seedTask(a, "pending");
        const flushing = flushSegment(a, alias, { lockWaitMs: 30 });
        // Retarget before the flush's lock acquisition completes.
        rmSync(alias);
        symlinkSync(other, alias);
        const result = await flushing;
        expect(result.appended).toBe(1);
        expect(linesOf(path)).toHaveLength(before + 1);
        expect(readdirSync(other)).toEqual([]);
      });
    });

    it("a sync dir replaced while the flush queues aborts instead of writing", async () => {
      const path = await seedFour();
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        seedTask(a, "pending");
        const flushing = flushSegment(a, dir, { lockWaitMs: 30 });
        // The folder moves away and a new one takes its path: the lock
        // taken is the old folder's, not the new one's.
        renameSync(dir, join(tempDir, "moved"));
        mkdirSync(dir);
        await expect(flushing).rejects.toBeInstanceOf(SyncDirMovedError);
        expect(readdirSync(dir)).toEqual([]);
        expect(existsSync(path)).toBe(false);
      });
    });

    it("a live holder keeps the lock however old it is", async () => {
      const path = await seedFour();
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        // A verify scan that has held the lock for over the 30 s age
        // threshold, and is still running.
        const lockPath = holdSegmentLock(31_000);
        const bytes = readFileSync(path);
        seedTask(a, "pending");
        const busy = await flushSegment(a, dir, { lockWaitMs: 30 });
        expect(busy.lockBusy).toBe(true);
        expect(readFileSync(path).equals(bytes)).toBe(true);
        expect(existsSync(lockPath)).toBe(true);
      });
    });

    it("a dead holder's aged lock is reclaimed and the flush appends", async () => {
      const path = await seedFour();
      const stateDir = join(tempDir, "state");
      await withEnv("MU_STATE_DIR", stateDir, async () => {
        const lockPath = holdSegmentLock(60_000, deadPid());
        const before = linesOf(path).length;
        seedTask(a, "pending");
        const result = await flushSegment(a, dir, { lockWaitMs: 30 });
        expect(result.lockBusy).toBeUndefined();
        expect(result.appended).toBe(1);
        expect(linesOf(path)).toHaveLength(before + 1);
        // Released after the flush, not left behind.
        expect(existsSync(lockPath)).toBe(false);
      });
    });
  });

  // ─── ingest cost: nothing new means nothing read ─────────────────────

  describe("ingest skips a caught-up peer", () => {
    const caughtUpPeer = async () => {
      for (let i = 0; i < 4; i++) seedTask(a, `c${i}`);
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      expect(ingestSegment(b, peer).applied).toBeGreaterThan(0);
      return peer;
    };

    /** Flip a crc digit on line 2, keeping the byte length, so only a
     *  reader that hashes or decodes line 2 can tell. */
    const rotLineTwo = (path: string): void => {
      const lines = linesOf(path);
      const second = lines[1];
      if (second === undefined) throw new Error("need 2 lines");
      lines[1] = second.replace(/"crc":"(.)/, (_m, c: string) => `"crc":"${c === "0" ? "1" : "0"}`);
      writeFileSync(path, `${lines.join("\n")}\n`);
    };

    /** Rewrite, then date the segment before its manifest, as a rewrite
     *  that preserved its mtime would leave it: then no stat can tell.
     *  (A full second back: restoring the exact old mtime through a
     *  float can land a few hundred ns later, past the manifest.) */
    const keepMtime = (path: string, rewrite: () => void): void => {
      rewrite();
      const earlier = new Date(statSync(path.replace(/\.jsonl$/, ".manifest")).mtimeMs - 1000);
      utimesSync(path, earlier, earlier);
    };

    it("an unchanged file at the watermark is not read", async () => {
      const peer = await caughtUpPeer();
      // Unreadable: a full read would throw EACCES. The caught-up path
      // only stats the segment.
      chmodSync(peer.path, 0o000);
      try {
        expect(ingestSegment(b, peer)).toMatchObject({ read: 0, applied: 0, defects: [] });
      } finally {
        chmodSync(peer.path, 0o644);
      }
    });

    it("keeps last_seen_at a timestamp; the fingerprint lives in sync_fingerprints", async () => {
      await caughtUpPeer();
      const key = localMachineId(a);
      const seen = b
        .prepare("SELECT datetime(last_seen_at) AS t FROM sync_peers WHERE machine_id = ?")
        .get(key) as { t: string | null };
      expect(seen.t).not.toBeNull();
      const fp = () =>
        b.prepare("SELECT fingerprint FROM sync_fingerprints WHERE machine_id = ?").get(key);
      expect(fp()).toBeDefined();
      // A watermark write without a clean read drops the fingerprint.
      setWatermark(b, key, getWatermark(b, key));
      expect(fp()).toBeUndefined();
    });

    // ─── resume: only appended bytes are read and hashed ──────────────

    const resumeOf = (db: Db, key: string): ResumePoint | null => {
      const row = db
        .prepare("SELECT fingerprint FROM sync_fingerprints WHERE machine_id = ?")
        .get(key) as { fingerprint: string } | undefined;
      return row === undefined ? null : decodeFingerprint(row.fingerprint).resume;
    };

    it("records a resume point after a clean read and advances it on append", async () => {
      const peer = await caughtUpPeer();
      const key = localMachineId(a);
      const first = resumeOf(b, key);
      expect(first).toMatchObject({
        lines: linesOf(peer.path).length,
        size: statSync(peer.path).size,
      });
      const n = linesOf(peer.path).length;
      for (let i = 4; i < 7; i++) seedTask(a, `c${i}`);
      await flushSegment(a, dir);
      const result = ingestSegment(b, peer);
      expect(result).toMatchObject({
        read: 3,
        applied: 3,
        defects: [],
        watermark: n + 3,
        truncatedAt: null,
      });
      expect(task(b, "c6")?.title).toBe("C6");
      // The saved hash state is the hash of the whole file, so the next
      // append resumes from it too.
      const second = resumeOf(b, key);
      expect(second).toMatchObject({ lines: n + 3, size: statSync(peer.path).size });
      expect(second?.state).toEqual(sha256Update(sha256Initial(), readFileSync(peer.path)));
      seedTask(a, "c7");
      await flushSegment(a, dir);
      expect(ingestSegment(b, peer)).toMatchObject({ applied: 1, defects: [], watermark: n + 4 });
      expect(task(b, "c7")).toBeDefined();
    });

    it("a resumed ingest ends in the same state as a full read", async () => {
      const peer = await caughtUpPeer();
      const n = linesOf(peer.path).length;
      for (let i = 4; i < 9; i++) seedTask(a, `c${i}`);
      await flushSegment(a, dir);
      const c = openDb({ path: join(tempDir, "c.db") });
      try {
        expect(ingestSegment(c, peer)).toMatchObject({ read: n + 5, defects: [] });
        expect(ingestSegment(b, peer)).toMatchObject({ read: 5, defects: [] });
        const dump = (db: Db) =>
          db.prepare("SELECT hlc, entity, key, payload FROM ops ORDER BY hlc").all();
        expect(dump(b)).toEqual(dump(c));
        expect(getWatermark(b, localMachineId(a))).toBe(getWatermark(c, localMachineId(a)));
      } finally {
        c.close();
      }
    });

    it("a rewritten prefix under a refreshed manifest takes the full read", async () => {
      const peer = await caughtUpPeer();
      const key = localMachineId(a);
      const old = resumeOf(b, key);
      // Same-size rewrite of line 2, then an append: the owner's flush
      // rehashes the whole file, so the manifest is valid for the new
      // bytes but the resumed hash (over the OLD prefix) cannot match it.
      rotLineTwo(peer.path);
      seedTask(a, "c4");
      await flushSegment(a, dir);
      const result = ingestSegment(b, peer);
      expect(result).toMatchObject({ read: 1, applied: 1, defects: [] });
      // The full read re-recorded a resume point over the NEW bytes.
      const now = resumeOf(b, key);
      expect(now?.state).toEqual(sha256Update(sha256Initial(), readFileSync(peer.path)));
      expect(now?.state).not.toEqual(old?.state);
    });

    it("a stale manifest takes the full read and still applies the appended lines", async () => {
      const peer = await caughtUpPeer();
      const key = localMachineId(a);
      const manifest = readFileSync(peer.path.replace(/\.jsonl$/, ".manifest"));
      seedTask(a, "c4");
      await flushSegment(a, dir);
      // The peer's manifest has not arrived yet.
      writeFileSync(peer.path.replace(/\.jsonl$/, ".manifest"), manifest);
      const result = ingestSegment(b, peer);
      expect(result).toMatchObject({ read: 1, applied: 1, defects: [] });
      expect(task(b, "c4")).toBeDefined();
      // Not vouched: the file is not what the (stale) manifest covers.
      expect(resumeOf(b, key)).toBeNull();
    });

    it("a segment shorter than the recorded size takes the full read", async () => {
      const peer = await caughtUpPeer();
      const lines = linesOf(peer.path);
      const before = getWatermark(b, localMachineId(a));
      writeFileSync(peer.path, `${lines.slice(0, 3).join("\n")}\n`);
      const result = ingestSegment(b, peer);
      expect(result.defects.map((d) => d.kind)).toEqual(["manifest-mismatch"]);
      expect(result.defects[0]?.detail).toContain("truncated");
      expect(result.watermark).toBe(before);
    });

    it("a prefix damaged locally while the segment grows is caught by verify, not by the ambient resume", async () => {
      // The documented limit of the resume: it trusts the bytes it already
      // read. Append + fresh manifest, then damage line 2 only in our copy.
      const peer = await caughtUpPeer();
      seedTask(a, "grow");
      await flushSegment(a, dir);
      rotLineTwo(peer.path);
      const verified = ingestSegment(b, peer, { verify: true });
      expect(verified.defects.map((d) => d.kind)).toContain("manifest-mismatch");
    });

    it("an explicit verify reads the whole file even with a resume point", async () => {
      const peer = await caughtUpPeer();
      seedTask(a, "c4");
      await flushSegment(a, dir);
      rotLineTwo(peer.path);
      // Same size, prefix damaged, manifest now wrong for it: the
      // resumed hash would fail anyway, but verify must report.
      const result = ingestSegment(b, peer, { verify: true });
      expect(result.defects.map((d) => d.kind)).toContain("manifest-mismatch");
    });

    it.each([
      ["null", () => null],
      ["a number", () => 7],
      ["an array", () => []],
      ["a tail of the wrong type", (st: { tail: string }) => ({ ...st, tail: 123 })],
      ["a tail that is not the right length", (st: { tail: string }) => ({ ...st, tail: "AA==" })],
      ["h of the wrong type", (st: { h: string }) => ({ ...st, h: 5 })],
      ["n beyond the segment length", (st: { n: number }) => ({ ...st, n: st.n + 1000 })],
      ["n below zero", (st: { n: number }) => ({ ...st, n: -1 })],
      ["n not a number", (st: { n: number }) => ({ ...st, n: "x" })],
    ])("a peer manifest with shaState %s is ingested via the full read", async (_name, bad) => {
      for (let i = 0; i < 4; i++) seedTask(a, `c${i}`);
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const manifestFile = peer.path.replace(/\.jsonl$/, ".manifest");
      const m = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
      m.shaState = (bad as (st: never) => unknown)(m.shaState as never);
      writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
      const result = ingestSegment(b, peer);
      expect(result.defects).toEqual([]);
      expect(result.applied).toBeGreaterThan(0);
      expect(task(b, "c3")).toBeDefined();
    });

    it("a defect leaves no resume point", async () => {
      const peer = await caughtUpPeer();
      const key = localMachineId(a);
      appendFileSync(peer.path, "not json\n");
      const result = ingestSegment(b, peer);
      expect(result.truncatedAt).toBe(linesOf(peer.path).length);
      expect(resumeOf(b, key)).toBeNull();
    });

    it("readAppended returns the new bytes and the running hash, or null", async () => {
      const path = join(tempDir, "plain.jsonl");
      const head = Buffer.from("alpha\nbeta\n");
      writeFileSync(path, head);
      const state = sha256Update(sha256Initial(), head);
      const resume: ResumePoint = { lines: 2, size: head.length, lastHlc: "h", state };
      const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
      // Not longer than the recorded size.
      expect(readAppended(path, resume, sha(head))).toBeNull();
      const tail = Buffer.from("gamma\n");
      appendFileSync(path, tail);
      const grown = readAppended(path, resume, sha(Buffer.concat([head, tail])));
      expect(grown?.bytes.toString()).toBe("gamma\n");
      expect(grown?.state.n).toBe(head.length + tail.length);
      // Manifest hash does not match the grown file.
      expect(readAppended(path, resume, sha(head))).toBeNull();
      expect(readAppended(join(tempDir, "missing"), resume, sha(head))).toBeNull();
    });

    it("fingerprint encoding round-trips and degrades to no resume point", () => {
      const state = sha256Update(sha256Initial(), Buffer.from("x\n"));
      const resume: ResumePoint = { lines: 1, size: 2, lastHlc: "0001-0000-m", state };
      expect(decodeFingerprint(encodeFingerprint("k", resume))).toEqual({ key: "k", resume });
      expect(decodeFingerprint(encodeFingerprint("k", null))).toEqual({ key: "k", resume: null });
      expect(decodeFingerprint("k\t1\t2\th\tzz").resume).toBeNull();
    });

    it("a same-size rewrite with a backdated mtime is read and reported", async () => {
      const peer = await caughtUpPeer();
      const recordedMtime = statSync(peer.path).mtimeMs;
      keepMtime(peer.path, () => rotLineTwo(peer.path));
      expect(statSync(peer.path).mtimeMs).not.toBe(recordedMtime);
      await withEnv("MU_SYNC_DIR", dir, async () => {
        for (let i = 0; i < 2; i++) {
          const result = await ambientIngest(b, { quiet: true });
          expect(result.ingested[0]?.defects.map((d) => d.kind)).toContain("manifest-mismatch");
          expect(result.warnings.join("\n")).toContain("copy it from the peer again");
        }
      });
    });

    it("a same-size rewrite restamped to the recorded mtime is caught by the manifest", async () => {
      const peer = await caughtUpPeer();
      const { mtime } = statSync(peer.path);
      const manifestFile = peer.path.replace(/\.jsonl$/, ".manifest");
      // A new manifest (another flush, a hand edit) with the same count:
      // the recorded manifest hash no longer matches.
      const m = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
      m.updatedAt = "2000-01-01T00:00:00.000Z";
      writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
      rotLineTwo(peer.path);
      utimesSync(peer.path, mtime, mtime);
      expect(ingestSegment(b, peer).defects.map((d) => d.kind)).toContain("manifest-mismatch");
    });

    it("a reset watermark is never vouched for by an old fingerprint", async () => {
      const peer = await caughtUpPeer();
      const key = localMachineId(a);
      const w = getWatermark(b, key);
      setWatermark(b, key, 0);
      setWatermark(b, key, w);
      rotLineTwo(peer.path);
      const st = statSync(peer.path);
      utimesSync(peer.path, st.atime, st.mtime);
      expect(ingestSegment(b, peer).defects.map((d) => d.kind)).toContain("manifest-mismatch");
    });

    it("a segment rewritten after its manifest is read and reported, every time", async () => {
      const peer = await caughtUpPeer();
      rotLineTwo(peer.path);
      // The rewrite lands after the peer wrote its manifest.
      const later = new Date(statSync(peer.path).mtimeMs + 2000);
      utimesSync(peer.path, later, later);
      await withEnv("MU_SYNC_DIR", dir, async () => {
        for (let i = 0; i < 2; i++) {
          const result = await ambientIngest(b, { quiet: true });
          expect(result.ingested[0]?.defects.map((d) => d.kind)).toContain("manifest-mismatch");
          expect(result.warnings.join("\n")).toContain("copy it from the peer again");
        }
      });
    });

    it("explicit verification still reads the whole file", async () => {
      const peer = await caughtUpPeer();
      rotLineTwo(peer.path);
      const verified = ingestSegment(b, peer, { verify: true });
      expect(verified.defects.map((d) => d.kind)).toContain("manifest-mismatch");
      const pass = await syncPass(b, dir);
      expect(pass.defective).toBe(true);
    });

    it("lines appended past a stale manifest are still applied", async () => {
      const peer = await caughtUpPeer();
      const manifestFile = peer.path.replace(/\.jsonl$/, ".manifest");
      const staleManifest = readFileSync(manifestFile, "utf8");
      seedTask(a, "late");
      await flushSegment(a, dir);
      // The transport delivered the grown segment but not its manifest.
      writeFileSync(manifestFile, staleManifest);
      const again = ingestSegment(b, peer);
      expect(again.applied).toBe(1);
      expect(task(b, "late")).toBeDefined();
    });

    it("a stale manifest from an older build (no size) still lets new lines through", async () => {
      const peer = await caughtUpPeer();
      const manifestFile = peer.path.replace(/\.jsonl$/, ".manifest");
      const m = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
      for (const k of ["size", "mtimeMs", "shaState"]) delete m[k];
      seedTask(a, "late");
      await flushSegment(a, dir);
      writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
      expect(ingestSegment(b, peer).applied).toBe(1);
    });

    it("a torn tail at the watermark is still reported", async () => {
      const peer = await caughtUpPeer();
      writeFileSync(peer.path, `${readFileSync(peer.path, "utf8")}{"v":1,"hlc":"0`);
      const again = ingestSegment(b, peer);
      expect(again.defects.map((d) => d.kind)).toContain("torn-write");
    });
  });
});
