// A MU_SYNC_DIR holding a 3.x (non-v2) segment is refused for write AND read:
// exit 4, nothing written, one line. The 18:04 incident: a 4.0 dev run with an
// inherited MU_SYNC_DIR appended a v2 segment into the real 3.x folder and
// 3.x warned "unknown-version" on every command after.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import {
  discoverPeers,
  encodeSegmentLine,
  flushSegment,
  ingestSegment,
  localMachineId,
  type PeerSegment,
  syncPass,
} from "../src/segments.js";
import { ambientFlush, ambientIngest } from "../src/sync.js";
import { assertSyncDirV2, SyncDirForeignError } from "../src/sync-dir-guard.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliWire } from "./_runCli.js";

const SYNC_KEY = "MU_SYNC_DIR";
const MESSAGE = "MU_SYNC_DIR holds 3.x segments; give mu 4 its own dir";

let tempDir: string;
let dir: string;
let dbPath: string;

const op = (machineId: string) => ({
  hlc: formatHlc({ wallMs: 1, counter: 0, machineId }),
  machineId,
  groupId: "g1",
  intent: null,
  actor: null,
  entity: "workstream",
  key: "w",
  op: "put" as const,
  payload: "{}",
});

/** A v1 line: v2's bytes with the version rewritten (the guard reads only `v`). */
const v1Line = (o: ReturnType<typeof op>): string =>
  encodeSegmentLine(o).replace('{"v":2,', '{"v":1,');

/** A 3.x peer's segment: v1 lines. */
const writeV1 = (name = "3xpeer.jsonl"): void =>
  writeFileSync(join(dir, name), `${v1Line(op("3xpeer"))}\n`);
const writeV2 = (name = "mu-next-peer.jsonl"): void =>
  writeFileSync(join(dir, name), `${encodeSegmentLine(op("mu-next-peer"))}\n`);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-sync-guard-"));
  dir = join(tempDir, "sync");
  mkdirSync(dir);
  dbPath = join(tempDir, "mu.db");
  process.env[SYNC_KEY] = dir;
  process.env.MU_STATE_DIR = tempDir;
});

afterEach(() => {
  delete process.env[SYNC_KEY];
  delete process.env.MU_STATE_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SDK: the env-driven entry points refuse a dir with a non-v2 first line", () => {
  it("syncPass (mu sync) throws and writes nothing", async () => {
    writeV1();
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: "t", title: "t", impact: 50, effortDays: 1 });
    const before = readdirSync(dir).sort();
    await expect(syncPass(db, dir)).rejects.toThrow(SyncDirForeignError);
    await expect(syncPass(db, dir)).rejects.toThrow(MESSAGE);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(existsSync(join(dir, `${localMachineId(db)}.jsonl`))).toBe(false);
    db.close();
  });

  it("the ambient halves (TUI tick) stay total: warn, ingest nothing, write nothing", async () => {
    writeV1();
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "demo");
    const before = readdirSync(dir).sort();
    const got = await ambientIngest(db, { quiet: true });
    expect(got.ingested).toEqual([]);
    expect(got.warnings.join("\n")).toContain(MESSAGE);
    await expect(ambientFlush(db, { quiet: true })).resolves.toBeNull();
    expect(readdirSync(dir).sort()).toEqual(before);
    db.close();
  });

  it("assertSyncDirV2: a conflict copy of a v1 segment counts too", () => {
    writeV1("3xpeer.sync-conflict-20260101-000000-ABCDEFG.jsonl");
    expect(() => assertSyncDirV2(dir)).toThrow(SyncDirForeignError);
  });

  it("only the FIRST line decides: a v2 first line passes, a v1 first line refuses", () => {
    writeFileSync(join(dir, "mixed.jsonl"), `${v1Line(op("m"))}\n${encodeSegmentLine(op("m"))}\n`);
    expect(() => assertSyncDirV2(dir)).toThrow(SyncDirForeignError);
    writeFileSync(join(dir, "mixed.jsonl"), `${encodeSegmentLine(op("m"))}\n${v1Line(op("m"))}\n`);
    expect(() => assertSyncDirV2(dir)).not.toThrow();
  });

  it("garbage, torn and newer-version first lines are NOT a 3.x peer: left to the defect reporting", () => {
    writeFileSync(join(dir, "garbage.jsonl"), "}}}not json\n");
    writeFileSync(join(dir, "torn.jsonl"), '{"v":');
    writeFileSync(join(dir, "newer.jsonl"), '{"v":3,"hlc":"x"}\n');
    expect(() => assertSyncDirV2(dir)).not.toThrow();
  });

  it("passes: a missing dir, an empty dir, empty files, v2 peers, non-segment files", async () => {
    expect(() => assertSyncDirV2(join(tempDir, "nope"))).not.toThrow();
    expect(() => assertSyncDirV2(dir)).not.toThrow();
    writeFileSync(join(dir, "empty.jsonl"), "");
    writeFileSync(join(dir, "notes.txt"), '{"v":1}\n');
    writeV2();
    expect(() => assertSyncDirV2(dir)).not.toThrow();
    const db = openDb({ path: dbPath });
    await expect(syncPass(db, dir)).resolves.toBeDefined();
    db.close();
  });
});

/** A 3.x peer with no ops yet: an EMPTY segment and a v1 manifest. */
const writeEmptyV1Peer = (id = "3xempty"): void => {
  writeFileSync(join(dir, `${id}.jsonl`), "");
  writeFileSync(
    join(dir, `${id}.manifest`),
    JSON.stringify({ v: 1, machine: id, count: 0, lastHlc: null, sha256: "0", updatedAt: "x" }),
  );
};

describe("SDK: the guard is inside flushSegment, discoverPeers and ingestSegment (every caller covered)", () => {
  it("flushSegment refuses a 3.x dir and writes nothing", async () => {
    writeV1();
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "demo");
    const before = readdirSync(dir).sort();
    await expect(flushSegment(db, dir)).rejects.toThrow(SyncDirForeignError);
    await expect(flushSegment(db, dir, { verify: true })).rejects.toThrow(MESSAGE);
    expect(readdirSync(dir).sort()).toEqual(before);
    db.close();
  });

  it("discoverPeers refuses a 3.x dir", () => {
    writeV1();
    expect(() => discoverPeers(dir, "me")).toThrow(SyncDirForeignError);
  });

  it("ingestSegment refuses a hand-built peer in a 3.x dir and applies nothing", () => {
    writeV1();
    const db = openDb({ path: dbPath });
    const peer: PeerSegment = {
      machineId: "3xpeer",
      watermarkKey: "3xpeer",
      path: join(dir, "3xpeer.jsonl"),
      conflictCopy: false,
    };
    expect(() => ingestSegment(db, peer)).toThrow(SyncDirForeignError);
    expect(() => ingestSegment(db, peer, { verify: true })).toThrow(SyncDirForeignError);
    db.close();
  });

  it("a v2-only dir still flushes, discovers and ingests", async () => {
    writeV2();
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "demo");
    await expect(flushSegment(db, dir)).resolves.toBeDefined();
    const peers = discoverPeers(dir, localMachineId(db));
    expect(peers.map((p) => p.machineId)).toEqual(["mu-next-peer"]);
    expect(() => ingestSegment(db, peers[0] as PeerSegment)).not.toThrow();
    db.close();
  });
});

describe("assertSyncDirV2 scans every file", () => {
  it("a v1 segment sorting AFTER a v2 one still refuses", () => {
    writeV2("0000-v2peer.jsonl");
    writeV1("zzzz-3x.jsonl");
    expect(() => assertSyncDirV2(dir)).toThrow(SyncDirForeignError);
  });

  it('a bare {"v":1} first line is 3.x evidence', () => {
    writeFileSync(join(dir, "bare.jsonl"), '{"v":1}\n');
    expect(() => assertSyncDirV2(dir)).toThrow(SyncDirForeignError);
  });

  it("an empty segment with a v1 manifest is a 3.x peer (flush refuses too)", async () => {
    writeEmptyV1Peer();
    expect(() => assertSyncDirV2(dir)).toThrow(SyncDirForeignError);
    const db = openDb({ path: dbPath });
    const before = readdirSync(dir).sort();
    await expect(flushSegment(db, dir)).rejects.toThrow(SyncDirForeignError);
    expect(readdirSync(dir).sort()).toEqual(before);
    db.close();
    const r = await runCli(["workstream", "init", "demo"], dbPath);
    expect(r.exitCode).toBe(4);
  });

  it("a v1 manifest alone (no segment) refuses; v2, torn and unreadable manifests do not", () => {
    writeFileSync(join(dir, "a.manifest"), JSON.stringify({ v: 2 }));
    writeFileSync(join(dir, "b.manifest"), '{"v":');
    writeFileSync(join(dir, "c.manifest"), "null");
    writeFileSync(join(dir, "d.manifest"), JSON.stringify({ v: 3 }));
    expect(() => assertSyncDirV2(dir)).not.toThrow();
    writeFileSync(join(dir, "e.manifest"), JSON.stringify({ v: 1 }));
    expect(() => assertSyncDirV2(dir)).toThrow(SyncDirForeignError);
  });
});

describe("CLI: handle() refuses before opening the DB", () => {
  it("exit 4, one line, no DB created, nothing written, for a read verb and a write verb", async () => {
    writeV1();
    const before = readdirSync(dir).sort();
    for (const argv of [["workstream", "list"], ["workstream", "init", "demo"], ["sync"]]) {
      const r = await runCli(argv, dbPath);
      expect(r.exitCode, argv.join(" ")).toBe(4);
      expect(r.stderr).toContain(MESSAGE);
      expect(
        r.stderr
          .trim()
          .split("\n")
          .filter((l) => l.includes(MESSAGE)),
      ).toHaveLength(1);
    }
    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("--json: an error envelope naming SyncDirForeignError, exit 4", async () => {
    writeV1();
    const r = await runCliWire(["workstream", "list", "--json"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      ok: false,
      error: "SyncDirForeignError",
      exit: 4,
    });
  });

  it("a v2-only dir works as before", async () => {
    writeV2();
    const r = await runCli(["workstream", "list"], dbPath);
    expect(r.exitCode, r.stderr).toBeNull();
  });
});
