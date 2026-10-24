// Disk↔DB reconciliation checks (src/disk-recon.ts).
//
// Every test points MU_STATE_DIR at a per-test temp dir and builds the
// on-disk shape by hand, because the whole module's job is disagreement
// between disk and DB — which cannot be produced through the normal
// verbs, since those keep the two in step.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  checkEmptyWorkstreamDirs,
  checkMissingWorktreeDirs,
  checkRemovedExportsDir,
  checkStaleLocks,
  checkStrayDbFiles,
  findMissingWorktreeDirs,
  findStrayDbFiles,
  formatBytes,
  measureWorktreeUsage,
  STALE_LOCK_REPORT_MS,
} from "../src/disk-recon.js";
import { ensureWorkstream } from "../src/workstream.js";

let stateDir: string;
let db: Db;

/** Register a worktrees row directly: these tests only care about its `path`. */
function insertWorktreeRow(workstream: string, agent: string, path: string): void {
  db.prepare(
    `INSERT INTO worktrees (path, agent, workstream, root, base, created_at)
     VALUES (?, ?, ?, '/repo', 'abc', datetime('now'))`,
  ).run(path, agent, workstream);
}

const wsDir = (workstream: string, agent: string): string =>
  join(stateDir, "worktrees", workstream, agent);

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mu-disk-recon-"));
  process.env.MU_STATE_DIR = stateDir;
  db = openDb({ path: join(stateDir, "mu.db") });
  ensureWorkstream(db, "alpha");
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  const key = "MU_STATE_DIR";
  delete process.env[key];
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {}
});

describe("DB → disk: rows pointing at nothing", () => {
  it("reports a worktree row whose dir was removed by hand", () => {
    const path = wsDir("alpha", "worker-1");
    mkdirSync(path, { recursive: true });
    insertWorktreeRow("alpha", "worker-1", path);
    expect(checkMissingWorktreeDirs(db).severity).toBe("ok");

    // The failure mode: rm -rf instead of `mu agent close`.
    rmSync(path, { recursive: true });

    const missing = findMissingWorktreeDirs(db);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.agentName).toBe("worker-1");
    const check = checkMissingWorktreeDirs(db);
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("1 worktree row");
    // Remediation must name the verb that unregisters it, per worktree.
    expect(check.remediation?.join("\n")).toContain("mu agent close worker-1 -w alpha");
  });

  it("is ok when there are no worktree rows at all", () => {
    expect(checkMissingWorktreeDirs(db).severity).toBe("ok");
  });
});

describe("empty workstream dirs", () => {
  it("reports an empty parent as ok-severity housekeeping", () => {
    mkdirSync(join(stateDir, "worktrees", "alpha"), { recursive: true });
    const check = checkEmptyWorkstreamDirs();
    // Deliberately ok: closing the last worktree leaves this and it harms nothing.
    expect(check.severity).toBe("ok");
    expect(check.detail).toContain("1 empty workstream dir");
    expect(check.detail).toContain("alpha");
  });

  it("does not count a parent that still holds a worktree", () => {
    mkdirSync(wsDir("alpha", "worker-1"), { recursive: true });
    expect(checkEmptyWorkstreamDirs().detail).toBe("no empty workstream dirs");
  });
});

describe("stray DB copies", () => {
  it("finds mu.db* files that are not the live triple, largest first", () => {
    writeFileSync(join(stateDir, "mu.db-wal"), "x");
    writeFileSync(join(stateDir, "mu.db-shm"), "x");
    writeFileSync(join(stateDir, "mu.db.old"), "x".repeat(4096));
    writeFileSync(join(stateDir, "mu.db.v9-20260827"), "x".repeat(8192));

    const stray = findStrayDbFiles(stateDir);
    expect(stray.map((f) => f.name)).toEqual(["mu.db.v9-20260827", "mu.db.old"]);

    const check = checkStrayDbFiles();
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("2 stray DB file(s)");
    // Points at the ops log rather than at a copy for real DR.
    expect(check.remediation?.join("\n")).toContain("mu rebuild");
  });

  it("names mu's own pre-compact / pre-forget backups instead of calling them hand-made", () => {
    // f_doctor_stray_db_backups: `mu db compact|forget` write these.
    writeFileSync(join(stateDir, "mu.db.pre-forget-2026-01-01T00-00-00-000Z"), "x");
    const check = checkStrayDbFiles();
    expect(check.severity).toBe("warn");
    const text = check.remediation?.join("\n") ?? "";
    expect(text).toContain("mu db forget");
    expect(text).toContain("mu.db.pre-<verb>-<time>");
  });

  it("never counts the live WAL triple", () => {
    writeFileSync(join(stateDir, "mu.db-wal"), "x");
    writeFileSync(join(stateDir, "mu.db-shm"), "x");
    expect(findStrayDbFiles(stateDir)).toEqual([]);
    expect(checkStrayDbFiles().severity).toBe("ok");
  });

  it("ignores unrelated files in the state dir", () => {
    writeFileSync(join(stateDir, "notes.txt"), "x");
    expect(findStrayDbFiles(stateDir)).toEqual([]);
  });
});

describe("removed-verb residue", () => {
  it("reports leftover exports/ dirs", () => {
    mkdirSync(join(stateDir, "exports", "alpha-2026-05-09T17-11-55-918Z"), { recursive: true });
    const check = checkRemovedExportsDir();
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("1 export dir(s)");
    expect(check.remediation?.join("\n")).toContain("removed in 1.1.0");
  });

  it("is ok with no exports dir at all", () => {
    expect(checkRemovedExportsDir().severity).toBe("ok");
  });
});

describe("stale locks", () => {
  it("reports a lock dir older than the report threshold", () => {
    const lock = join(stateDir, "locks", "spawn-alpha");
    mkdirSync(lock, { recursive: true });
    const old = (Date.now() - STALE_LOCK_REPORT_MS - 60_000) / 1000;
    utimesSync(lock, old, old);

    const check = checkStaleLocks();
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("1 lock dir(s)");
    expect(check.remediation?.join("\n")).toContain("spawn-alpha");
  });

  it("leaves a fresh lock alone (mid-spawn is routine)", () => {
    mkdirSync(join(stateDir, "locks", "spawn-alpha"), { recursive: true });
    expect(checkStaleLocks().severity).toBe("ok");
  });
});

describe("--disk tier: byte accounting", () => {
  it("sums bytes per worktree and flags the orphan ones", () => {
    const tracked = wsDir("alpha", "worker-1");
    mkdirSync(join(tracked, "nested"), { recursive: true });
    writeFileSync(join(tracked, "nested", "big"), "x".repeat(2048));
    insertWorktreeRow("alpha", "worker-1", tracked);

    const orphan = wsDir("alpha", "worker-2");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "small"), "x".repeat(512));

    const usage = measureWorktreeUsage(db);
    expect(usage).toHaveLength(2);
    // Sorted largest-first, and recursion reached the nested file.
    expect(usage[0]?.agentName).toBe("worker-1");
    expect(usage[0]?.bytes).toBe(2048);
    expect(usage[0]?.orphan).toBe(false);
    expect(usage[1]?.agentName).toBe("worker-2");
    expect(usage[1]?.orphan).toBe(true);
  });
});

describe("--disk tier: symlinks", () => {
  it("skips symlinks (0 bytes) instead of following them", () => {
    // f_doctor_walkbytes_symlink: a link into a big tree is not mu's bytes.
    const outside = join(stateDir, "outside");
    mkdirSync(join(outside, "tree"), { recursive: true });
    writeFileSync(join(outside, "big"), "x".repeat(100_000));
    writeFileSync(join(outside, "tree", "big"), "x".repeat(100_000));
    const ws = wsDir("alpha", "worker-1");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "own"), "x".repeat(100));
    symlinkSync(join(outside, "big"), join(ws, "file-link"));
    symlinkSync(join(outside, "tree"), join(ws, "dir-link"));
    insertWorktreeRow("alpha", "worker-1", ws);

    expect(measureWorktreeUsage(db)[0]?.bytes).toBe(100);
  });
});

describe("formatBytes", () => {
  it("scales without decimals below the GB mark", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2K");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5M");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0G");
  });
});
