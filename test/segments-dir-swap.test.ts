// A sync dir swapped AFTER the flush takes its lock: renamed away, another
// folder renamed onto its path, between the locked read and the append.
// The lock held is the old folder's, so nothing may be written through the
// path, which now names a folder whose lock someone else holds.
//
// The swap is injected inside the flush's own read of its segment (a
// wrapped `readFileSync`), so it lands deterministically under the lock.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One-shot hooks run right after the real call returns: `afterRead` on a
// segment read, `afterStat` on the next stat of the sync dir.
let afterRead: (() => void) | null = null;
let afterStat: { dir: string; fn: () => void } | null = null;
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const out = real.readFileSync(...args);
    if (afterRead !== null && String(args[0]).endsWith(".jsonl")) {
      const fn = afterRead;
      afterRead = null;
      fn();
    }
    return out;
  }) as typeof real.readFileSync;
  const statSync = ((...args: Parameters<typeof real.statSync>) => {
    const out = real.statSync(...args);
    if (afterStat !== null && args[0] === afterStat.dir) {
      const { fn } = afterStat;
      afterStat = null;
      fn();
    }
    return out;
  }) as typeof real.statSync;
  const mocked = { ...real, readFileSync, statSync };
  return { ...mocked, default: mocked };
});

const { openDb } = await import("../src/db.js");
const { flushSegment, localMachineId, segmentLockPath, segmentPath } = await import(
  "../src/segments.js"
);
const { manifestPath } = await import("../src/segment-manifest.js");
const { SyncDirMovedError } = await import("../src/sync-dir-guard.js");
const { addTask } = await import("../src/tasks/edit.js");
const { ensureWorkstream } = await import("../src/workstream.js");
const { withEnv } = await import("./_env.js");
const { rmFixtureDir } = await import("./_fs.js");

describe("flushSegment: sync dir swapped under the lock", () => {
  let tempDir: string;
  let dir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), "mu-seg-swap-"));
    dir = join(tempDir, "sync");
    fs.mkdirSync(dir);
    db = openDb({ path: join(tempDir, "a.db") });
  });

  afterEach(() => {
    afterRead = null;
    afterStat = null;
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(tempDir);
  });

  const seed = (id: string): void => {
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
  };

  /** A synced segment of two tasks, a third task pending, and B: an empty
   *  folder whose lock a live process holds. */
  const setup = async () => {
    seed("one");
    seed("two");
    await flushSegment(db, dir);
    const machine = localMachineId(db);
    const path = segmentPath(dir, machine);
    const other = join(tempDir, "other");
    fs.mkdirSync(other);
    const heldB = segmentLockPath(other, machine);
    fs.mkdirSync(heldB, { recursive: true });
    const metaB = JSON.stringify({ pid: process.pid, label: "B", acquiredAt: "", token: "B" });
    fs.writeFileSync(join(heldB, "meta.json"), metaB);
    seed("three");
    const moved = join(tempDir, "moved");
    const swap = (): void => {
      fs.renameSync(dir, moved);
      fs.renameSync(other, dir);
      // The path now names B, whose lock this flush does not hold.
      expect(segmentLockPath(dir, machine)).toBe(heldB);
    };
    return {
      bytes: fs.readFileSync(path),
      manifest: fs.readFileSync(manifestPath(path)),
      movedPath: join(moved, basename(path)),
      heldB,
      metaB,
      swap,
    };
  };

  it("a swap after the locked read aborts before the append", async () => {
    await withEnv("MU_STATE_DIR", join(tempDir, "state"), async () => {
      const t = await setup();
      afterRead = t.swap;
      await expect(flushSegment(db, dir, { verify: true })).rejects.toBeInstanceOf(
        SyncDirMovedError,
      );
      expect(afterRead).toBeNull();
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(fs.readFileSync(join(t.heldB, "meta.json"), "utf8")).toBe(t.metaB);
      expect(fs.readFileSync(t.movedPath).equals(t.bytes)).toBe(true);
      expect(fs.readFileSync(manifestPath(t.movedPath)).equals(t.manifest)).toBe(true);
    });
  });

  it("a swap after the pre-append check still appends only into the locked folder", async () => {
    await withEnv("MU_STATE_DIR", join(tempDir, "state"), async () => {
      const t = await setup();
      // The locked read arms the swap for the next stat of the dir: the
      // check right before the append. It passes, then the folder moves.
      afterRead = () => {
        afterStat = { dir: fs.realpathSync(dir), fn: t.swap };
      };
      await expect(flushSegment(db, dir, { verify: true })).rejects.toBeInstanceOf(
        SyncDirMovedError,
      );
      expect(afterStat).toBeNull();
      // B gained nothing; the line went into the folder whose lock was held,
      // and the manifest write after it aborted.
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(fs.readFileSync(join(t.heldB, "meta.json"), "utf8")).toBe(t.metaB);
      const grown = fs.readFileSync(t.movedPath);
      expect(grown.subarray(0, t.bytes.length).equals(t.bytes)).toBe(true);
      const lines = (b: Buffer): number => b.toString("utf8").trimEnd().split("\n").length;
      expect(lines(grown)).toBe(lines(t.bytes) + 1);
      expect(fs.readFileSync(manifestPath(t.movedPath)).equals(t.manifest)).toBe(true);
    });
  });
});
