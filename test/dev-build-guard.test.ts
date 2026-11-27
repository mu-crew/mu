// The dev-build migration guard (src/dev-build.ts): a mu running from a git
// checkout refuses to upgrade the user's live DB, however the path was
// reached, and to publish its ops to MU_SYNC_DIR, unless MU_ALLOW_MIGRATE=1.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPTURE_VERSION } from "../src/capture.js";
import { classifyError } from "../src/cli/handle.js";
import { openDb } from "../src/db.js";
import {
  DevBuildMigrationError,
  DevBuildSyncError,
  devBuildRoot,
  setDevBuildGuardForTests,
} from "../src/dev-build.js";
import { flushSegment } from "../src/segments.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let dbPath: string;
let checkout: string;
let installed: string;

function captureOf(path: string): number {
  const raw = new Database(path, { readonly: true });
  try {
    return (raw.prepare("SELECT capture_version AS v FROM schema_version").get() as { v: number })
      .v;
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-devguard-"));
  dbPath = join(dir, "state", "mu.db");
  mkdirSync(join(dir, "state"));
  // A current DB, then aged to an older capture stamp.
  openDb({ path: dbPath }).close();
  const raw = new Database(dbPath);
  raw.prepare("UPDATE schema_version SET capture_version = 0").run();
  raw.close();
  // A worktree checkout (.git file) and an installed package with a .git above node_modules.
  checkout = join(dir, "wt");
  mkdirSync(join(checkout, "dist"), { recursive: true });
  writeFileSync(join(checkout, ".git"), "gitdir: /elsewhere\n");
  installed = join(dir, "home", "node_modules", "@mu-crew", "mu", "dist");
  mkdirSync(installed, { recursive: true });
  mkdirSync(join(dir, "home", ".git"));
});

afterEach(() => {
  setDevBuildGuardForTests({});
  rmFixtureDir(dir);
});

describe("devBuildRoot", () => {
  it("finds the checkout holding .git, and stops at node_modules", () => {
    expect(devBuildRoot(join(checkout, "dist", "cli.js"))).toBe(checkout);
    expect(devBuildRoot(join(installed, "cli.js"))).toBeNull();
  });
});

describe("openDb on the default DB", () => {
  it("a dev build refuses the upgrade and writes nothing", () => {
    setDevBuildGuardForTests({ moduleFile: join(checkout, "dist", "cli.js"), defaultDb: dbPath });
    const before = readFileSync(dbPath);
    let err: unknown;
    try {
      openDb({ path: dbPath });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DevBuildMigrationError);
    expect((err as Error).message).toContain(`development build (${checkout})`);
    expect((err as Error).message).toContain(`capture 0 to schema`);
    expect((err as Error).message).toContain(`capture ${CAPTURE_VERSION}`);
    expect((err as Error).message).toContain("MU_STATE_DIR");
    expect(classifyError(err).exitCode).toBe(4);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(captureOf(dbPath)).toBe(0);
  });

  it("MU_DEV_BUILD=1 marks any layout a dev build", async () => {
    setDevBuildGuardForTests({ moduleFile: join(installed, "cli.js"), defaultDb: dbPath });
    await withEnv("MU_DEV_BUILD", "1", async () => {
      expect(() => openDb({ path: dbPath })).toThrow(DevBuildMigrationError);
    });
  });

  it("an up-to-date DB still opens from a dev build", () => {
    openDb({ path: dbPath }).close(); // upgraded by the unguarded open
    setDevBuildGuardForTests({ moduleFile: join(checkout, "dist", "cli.js"), defaultDb: dbPath });
    openDb({ path: dbPath }).close();
  });

  it("the incident: MU_STATE_DIR=<tmp> but MU_DB_PATH pinned to the live DB is refused", async () => {
    setDevBuildGuardForTests({ moduleFile: join(checkout, "dist", "cli.js"), defaultDb: dbPath });
    await withEnv("MU_STATE_DIR", join(dir, "scratch"), async () => {
      await withEnv("MU_DB_PATH", dbPath, async () => {
        expect(() => openDb()).toThrow(DevBuildMigrationError);
      });
    });
    expect(captureOf(dbPath)).toBe(0);
  });

  it("MU_STATE_DIR pointing at the live state dir is refused too", async () => {
    setDevBuildGuardForTests({ moduleFile: join(checkout, "dist", "cli.js"), defaultDb: dbPath });
    await withEnv("MU_STATE_DIR", join(dir, "state"), async () => {
      expect(() => openDb()).toThrow(DevBuildMigrationError);
    });
  });

  it("a dev build migrates a DB that is not the live one", async () => {
    setDevBuildGuardForTests({
      moduleFile: join(checkout, "dist", "cli.js"),
      defaultDb: join(dir, "live", "mu.db"),
    });
    await withEnv("MU_STATE_DIR", join(dir, "state"), async () => {
      openDb().close();
    });
    expect(captureOf(dbPath)).toBe(CAPTURE_VERSION);
  });

  it("MU_ALLOW_MIGRATE=1: a dev build migrates", async () => {
    setDevBuildGuardForTests({ moduleFile: join(checkout, "dist", "cli.js"), defaultDb: dbPath });
    await withEnv("MU_ALLOW_MIGRATE", "1", async () => {
      openDb({ path: dbPath }).close();
    });
    expect(captureOf(dbPath)).toBe(CAPTURE_VERSION);
  });

  it("the installed layout migrates", () => {
    setDevBuildGuardForTests({ moduleFile: join(installed, "cli.js"), defaultDb: dbPath });
    openDb({ path: dbPath }).close();
    expect(captureOf(dbPath)).toBe(CAPTURE_VERSION);
  });
});

describe("sync flush of the live DB", () => {
  async function liveDbWithOp(): Promise<ReturnType<typeof openDb>> {
    const db = openDb({ path: dbPath }); // unguarded: upgrades
    ensureWorkstream(db, "ws1");
    return db;
  }

  it("a dev build does not publish the live DB's ops", async () => {
    const db = await liveDbWithOp();
    try {
      setDevBuildGuardForTests({ moduleFile: join(checkout, "dist", "cli.js"), defaultDb: dbPath });
      const sync = join(dir, "sync");
      await expect(flushSegment(db, sync)).rejects.toBeInstanceOf(DevBuildSyncError);
      expect(existsSync(sync) ? readdirSync(sync).filter((f) => f.endsWith(".jsonl")) : []).toEqual(
        [],
      );
    } finally {
      db.close();
    }
  });

  it("the installed layout publishes them", async () => {
    const db = await liveDbWithOp();
    try {
      setDevBuildGuardForTests({ moduleFile: join(installed, "cli.js"), defaultDb: dbPath });
      const result = await flushSegment(db, join(dir, "sync"));
      expect(result.appended).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
