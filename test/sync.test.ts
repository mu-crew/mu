// Fast-tier tests for src/sync.ts — the DECISION LOGIC of sync.
//
// What belongs here: peer discovery/staleness arithmetic, peer-ref
// resolution, the "sync is off" single-if, the ambient hook's
// never-throw contract, and the `--from <peer.db>` reader. All in-process
// with per-test temp DBs and a per-test temp dir — no subprocesses.
//
// What does NOT belong here: the CLI paths. Those live in
// test/cli-sync.integration.test.ts, driven through the VERB.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Op } from "../src/apply.js";
import { type Db, openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import {
  applyIncomingOp,
  discoverPeers,
  flushSegment,
  ingestSegment,
  localMachineId,
  segmentPath,
  syncPass,
} from "../src/segments.js";
import {
  ambientFlush,
  ambientIngest,
  ambientSyncPass,
  ingestFromDb,
  PEER_STALE_MS,
  type PeerStatus,
  peerStatuses,
  repairPeer,
  resolvePeerRef,
  SyncPeerNotFoundError,
  SyncPeerRefAmbiguousError,
  SyncSourceNotFoundError,
  syncEnabled,
  transportNextSteps,
} from "../src/sync.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, updateTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

const SYNC_DIR_KEY = "MU_SYNC_DIR";

describe("sync", () => {
  let tempDir: string;
  let dir: string;
  let a: Db;
  let b: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-sync-test-"));
    dir = join(tempDir, "shared");
    mkdirSync(dir, { recursive: true });
    a = openDb({ path: join(tempDir, "a.db") });
    b = openDb({ path: join(tempDir, "b.db") });
    process.env[SYNC_DIR_KEY] = dir;
  });

  afterEach(() => {
    for (const db of [a, b]) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    delete process.env[SYNC_DIR_KEY];
    rmFixtureDir(tempDir);
  });

  const seed = (db: Db, localId: string, impact = 50): void => {
    ensureWorkstream(db, "demo");
    addTask(db, {
      workstream: "demo",
      localId,
      title: localId.toUpperCase(),
      impact,
      effortDays: 1,
    });
  };

  const taskRow = (db: Db, localId: string) =>
    db.prepare("SELECT local_id, status, impact FROM tasks WHERE local_id = ?").get(localId) as
      | { local_id: string; status: string; impact: number }
      | undefined;

  const opCount = (db: Db): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

  // ─── the single `if` ───────────────────────────────────────────────

  describe("MU_SYNC_DIR unset", () => {
    it("reports sync disabled and invents no op", async () => {
      delete process.env[SYNC_DIR_KEY];
      seed(a, "t1");
      const before = opCount(a);

      expect(syncEnabled()).toBe(false);
      const ingested = await ambientIngest(a);
      const flushed = await ambientFlush(a);
      const pass = await ambientSyncPass(a);

      expect(ingested.ingested).toEqual([]);
      expect(ingested.warnings).toEqual([]);
      expect(flushed).toBeNull();
      expect(pass.flushed).toBeNull();
      expect(pass.ingested).toEqual([]);
      expect(opCount(a)).toBe(before);
    });

    it("writes no file into a dir that happens to exist", async () => {
      delete process.env[SYNC_DIR_KEY];
      seed(a, "t1");
      await ambientSyncPass(a);
      // The shared dir stays empty: sync-off means sync-off, not
      // "sync to the last configured place".
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  // ─── peer status ───────────────────────────────────────────────────

  describe("peerStatuses", () => {
    it("discovers a peer implicitly, with no configuration", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);

      const peers = peerStatuses(b, dir);
      expect(peers).toHaveLength(1);
      const peer = peers[0];
      if (peer === undefined) throw new Error("expected one peer");
      expect(peer.machineId).toBe(localMachineId(a));
      expect(peer.short).toBe(localMachineId(a).slice(0, 8));
      expect(peer.stale).toBe(false);
    });

    it("counts `behind` as segment-lines-not-yet-applied", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      const before = peerStatuses(b, dir)[0];
      if (before === undefined) throw new Error("expected one peer");
      expect(before.watermark).toBe(0);
      expect(before.behind).toBe(before.total);
      expect(before.total).toBeGreaterThan(0);

      await syncPass(b, dir);
      const after = peerStatuses(b, dir)[0];
      if (after === undefined) throw new Error("expected one peer");
      expect(after.behind).toBe(0);
      expect(after.watermark).toBe(after.total);
    });

    it("marks a peer stale once its segment stops moving", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      const path = segmentPath(dir, localMachineId(a));
      // Backdate past the threshold. utimesSync takes seconds.
      const old = (Date.now() - PEER_STALE_MS - 60_000) / 1000;
      utimesSync(path, old, old);

      const peer = peerStatuses(b, dir)[0];
      if (peer === undefined) throw new Error("expected one peer");
      expect(peer.stale).toBe(true);
      expect(peer.ageMs).toBeGreaterThan(PEER_STALE_MS);
    });

    it("a THIRD segment dropped in the dir becomes a third peer, no config", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      seed(b, "t2");
      await flushSegment(b, dir);
      // A machine we have never heard of: copy an existing segment under
      // a new machine id, exactly as a file-mover would deliver it.
      const third = "33333333-3333-4333-8333-333333333333";
      writeFileSync(segmentPath(dir, third), "", "utf8");

      const c = openDb({ path: join(tempDir, "c.db") });
      try {
        const shorts = peerStatuses(c, dir).map((p) => p.short);
        expect(shorts).toContain(localMachineId(a).slice(0, 8));
        expect(shorts).toContain(localMachineId(b).slice(0, 8));
        expect(shorts).toContain(third.slice(0, 8));
      } finally {
        c.close();
      }
    });

    it("a slim note tombstone ({}) deletes the note on the peer", async () => {
      seed(a, "t1");
      addNote(a, "t1", "to be removed", { workstream: "demo", author: "w" });
      addNote(a, "t1", "kept", { workstream: "demo", author: "w" });
      await flushSegment(a, dir);
      await syncPass(b, dir);
      const notes = (db: Db) =>
        (
          db.prepare("SELECT content FROM task_notes ORDER BY content").all() as {
            content: string;
          }[]
        ).map((r) => r.content);
      expect(notes(b)).toEqual(["kept", "to be removed"]);
      a.prepare("DELETE FROM task_notes WHERE content = 'to be removed'").run();
      const tomb = a
        .prepare("SELECT payload FROM ops WHERE entity = 'note' AND op = 'del'")
        .get() as { payload: string };
      expect(tomb.payload).toBe("{}");
      await flushSegment(a, dir);
      await syncPass(b, dir);
      expect(notes(b)).toEqual(["kept"]);
    });

    it("never lists this machine as its own peer", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      expect(peerStatuses(a, dir)).toEqual([]);
    });
  });

  // ─── peer refs ─────────────────────────────────────────────────────

  describe("resolvePeerRef", () => {
    const peer = (machineId: string) => ({
      machineId,
      short: machineId.slice(0, 8),
      path: `/tmp/${machineId}.jsonl`,
      conflictCopy: false,
      watermarkKey: machineId,
      watermark: 0,
      total: 0,
      behind: 0,
      lastSeenMs: 0,
      ageMs: 0,
      stale: false,
    });

    it("accepts a full id and any unique prefix", () => {
      const peers = [peer("aaaa1111-x"), peer("bbbb2222-y")];
      expect(resolvePeerRef(peers, "aaaa1111-x").machineId).toBe("aaaa1111-x");
      expect(resolvePeerRef(peers, "aa").machineId).toBe("aaaa1111-x");
    });

    it("refuses an ambiguous prefix rather than guessing", () => {
      const peers = [peer("aaaa1111-x"), peer("aaaa2222-y")];
      expect(() => resolvePeerRef(peers, "aaaa")).toThrow(SyncPeerRefAmbiguousError);
    });

    it("treats a segment and its conflict copy as ONE machine", () => {
      const copy = {
        ...peer("aaaa1111-x"),
        conflictCopy: true,
        watermarkKey: "aaaa1111-x.sync-conflict-1",
      };
      const peers = [copy, peer("aaaa1111-x"), peer("bbbb2222-y")];
      const hit = resolvePeerRef(peers, "aaaa1111");
      expect(hit.conflictCopy).toBe(false);
      expect(resolvePeerRef(peers, "aaaa1111-x").conflictCopy).toBe(false);
      // Two different machines are still ambiguous, each named once.
      const two = [copy, peer("aaaa1111-x"), peer("aaaa2222-y")];
      expect(() => resolvePeerRef(two, "aaaa")).toThrow(/matches 2 peers \(aaaa1111, aaaa2222\)/);
    });

    it("accepts the pre-watermarkKey PeerStatus shape (SDK compat)", () => {
      // PeerStatus is exported from src/index.ts. A caller that builds
      // it without watermarkKey must still compile (npm run typecheck
      // covers test/) and resolve / produce transport hints.
      const oldShape: PeerStatus = {
        machineId: "aaaa1111-x",
        short: "aaaa1111",
        path: "/tmp/aaaa1111-x.jsonl",
        conflictCopy: false,
        watermark: 0,
        total: 0,
        behind: 0,
        lastSeenMs: 0,
        ageMs: PEER_STALE_MS + 1,
        stale: true,
      };
      expect(resolvePeerRef([oldShape], "aaaa").machineId).toBe("aaaa1111-x");
      expect(transportNextSteps("/mnt/sync", [oldShape]).length).toBeGreaterThan(0);
    });

    it("names the known peers when nothing matches", () => {
      const peers = [peer("aaaa1111-x")];
      expect(() => resolvePeerRef(peers, "zz")).toThrow(SyncPeerNotFoundError);
      expect(() => resolvePeerRef(peers, "zz")).toThrow(/aaaa1111/);
    });
  });

  describe("repairPeer", () => {
    it("resets the watermark so the next ingest re-reads from zero", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      await syncPass(b, dir);
      const applied = peerStatuses(b, dir)[0];
      if (applied === undefined) throw new Error("expected one peer");
      expect(applied.watermark).toBeGreaterThan(0);

      repairPeer(b, applied.short, dir);
      const reset = peerStatuses(b, dir)[0];
      if (reset === undefined) throw new Error("expected one peer");
      expect(reset.watermark).toBe(0);
      expect(reset.behind).toBe(reset.total);

      // Re-reading converges to the same state: idempotence is what makes
      // this repair safe rather than destructive.
      const opsBefore = opCount(b);
      await syncPass(b, dir);
      expect(opCount(b)).toBe(opsBefore);
      expect(taskRow(b, "t1")?.status).toBe("OPEN");
    });

    it("resets the conflict copy's watermark too, by its short id", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      const path = segmentPath(dir, localMachineId(a));
      writeFileSync(
        join(dir, `${localMachineId(a)}.sync-conflict-20260609-123456-ABCDEFG.jsonl`),
        readFileSync(path, "utf8"),
      );
      await syncPass(b, dir);
      const before = peerStatuses(b, dir);
      expect(before).toHaveLength(2);
      expect(before.every((p) => p.watermark > 0)).toBe(true);

      const short = before[0]?.short ?? "";
      repairPeer(b, short, dir);
      expect(peerStatuses(b, dir).map((p) => p.watermark)).toEqual([0, 0]);
    });
  });

  // ─── never fail a command ──────────────────────────────────────────

  describe("ambient sync never throws", () => {
    it("survives a truncated segment and reports it as a warning", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      const path = segmentPath(dir, localMachineId(a));
      const raw = readFileSync(path, "utf8");
      writeFileSync(path, `${raw.slice(0, raw.length - 20)}`, "utf8");

      const result = await ambientIngest(b);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.join(" ")).toMatch(/--repair/);
      // b is still perfectly usable: the local write path is untouched.
      seed(b, "t2");
      expect(taskRow(b, "t2")).toBeDefined();
    });

    it("does not suggest --repair for a manifest mismatch it cannot clear", async () => {
      seed(a, "t1");
      seed(a, "t2");
      await flushSegment(a, dir);
      const path = segmentPath(dir, localMachineId(a));
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      // Truncated exactly on a line boundary, manifest kept.
      writeFileSync(path, `${lines.slice(0, 2).join("\n")}\n`, "utf8");

      const result = await ambientIngest(b, { quiet: true });
      expect(result.warnings.join(" ")).toMatch(/manifest-mismatch/);
      expect(result.warnings.join(" ")).not.toMatch(/--repair/);
      expect(result.warnings.join(" ")).toMatch(/copy it from the peer again/);
    });

    it("survives a sync dir that is a FILE, not a directory", async () => {
      const bogus = join(tempDir, "not-a-dir");
      writeFileSync(bogus, "nope", "utf8");
      process.env[SYNC_DIR_KEY] = bogus;
      seed(a, "t1");
      await expect(ambientIngest(a)).resolves.toBeDefined();
      await expect(ambientFlush(a)).resolves.toBeDefined();
    });

    it("survives a sync dir that vanished mid-session", async () => {
      seed(a, "t1");
      await flushSegment(a, dir);
      rmSync(dir, { recursive: true, force: true });
      await expect(ambientSyncPass(a)).resolves.toBeDefined();
    });

    it("survives a segment full of garbage", async () => {
      writeFileSync(join(dir, "99999999-9999-4999-8999-999999999999.jsonl"), "{{{not json\n");
      const result = await ambientIngest(b);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  // ─── ordering: ingest before, flush after ──────────────────────────

  describe("deferred-op repair on ambient ingest", () => {
    const edgeCount = (db: Db): number =>
      (db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n;

    it("projects an edge whose parent task arrives in a LATER pass", async () => {
      const c = openDb({ path: join(tempDir, "c.db") });
      try {
        seed(a, "parent");
        await flushSegment(a, dir);
        await ambientIngest(c);
        seed(c, "child");
        addBlockEdge(c, "demo", "child", "parent");
        await flushSegment(c, dir);

        // b sees only c's segment first: the edge names a parent b lacks.
        const aSeg = segmentPath(dir, localMachineId(a));
        renameSync(aSeg, `${aSeg}.hidden`);
        await ambientIngest(b);
        expect(edgeCount(b)).toBe(0);

        renameSync(`${aSeg}.hidden`, aSeg);
        await ambientIngest(b);
        expect(edgeCount(b)).toBe(1);
      } finally {
        c.close();
      }
    });

    it("a pass that died before the repair is repaired by the next ambient pass", async () => {
      const c = openDb({ path: join(tempDir, "c.db") });
      try {
        seed(a, "parent");
        await flushSegment(a, dir);
        await ambientIngest(c);
        seed(c, "child");
        addBlockEdge(c, "demo", "child", "parent");
        await flushSegment(c, dir);

        // b holds the edge, deferred: its parent has not arrived.
        const aSeg = segmentPath(dir, localMachineId(a));
        renameSync(aSeg, `${aSeg}.hidden`);
        await ambientIngest(b);
        expect(edgeCount(b)).toBe(0);
        renameSync(`${aSeg}.hidden`, aSeg);

        // A process ingests the parent's segment and exits before the
        // pass-wide repair runs.
        const parentPeer = discoverPeers(dir, localMachineId(b)).find(
          (p) => p.machineId === localMachineId(a),
        );
        if (parentPeer === undefined) throw new Error("expected a's segment");
        expect(ingestSegment(b, parentPeer).applied).toBeGreaterThan(0);

        // The next ordinary invocation applies nothing new.
        const next = await ambientIngest(b);
        expect(next.ingested.every((r) => r.applied === 0)).toBe(true);
        expect(edgeCount(b)).toBe(1);
      } finally {
        c.close();
      }
    });

    it("repairs an edge an SDK caller applied before its parent", async () => {
      seed(a, "parent");
      seed(a, "child");
      addBlockEdge(a, "demo", "child", "parent");
      const ops = (
        a
          .prepare(
            `SELECT hlc, machine_id AS machineId, group_id AS groupId, actor, intent,
                    entity, key, op, payload FROM ops ORDER BY seq`,
          )
          .all() as Op[]
      ).sort((x, y) => (x.entity === "edge" ? -1 : y.entity === "edge" ? 1 : 0));
      expect(ops[0]?.entity).toBe("edge");
      // Edge first (deferred: neither task is here), then its parents,
      // straight through the exported incoming-op seam.
      for (const op of ops) applyIncomingOp(b, op);
      expect(edgeCount(b)).toBe(0);

      // An ambient pass over an empty sync dir applies nothing, yet runs
      // the repair the direct calls left pending.
      const empty = join(tempDir, "empty-sync");
      mkdirSync(empty);
      process.env[SYNC_DIR_KEY] = empty;
      const pass = await ambientIngest(b);
      expect(pass.ingested).toEqual([]);
      expect(edgeCount(b)).toBe(1);
      expect(b.pragma("user_version", { simple: true })).toBe(0);
    });

    it("does no repair scan when the pass applied nothing", async () => {
      seed(a, "parent");
      seed(a, "child");
      addBlockEdge(a, "demo", "child", "parent");
      await flushSegment(a, dir);
      await ambientIngest(b);
      expect(edgeCount(b)).toBe(1);

      // Drop the projected edge behind capture's back, so only the
      // repair scan could restore it.
      withCaptureSuppressed(b, () => b.prepare("DELETE FROM task_edges").run());
      await ambientIngest(b);
      expect(edgeCount(b)).toBe(0);

      // Explicit `mu sync` always runs the repair.
      await syncPass(b, dir);
      expect(edgeCount(b)).toBe(1);
    });
  });

  describe("hook ordering", () => {
    it("flush AFTER the body publishes ops the same invocation wrote", async () => {
      // The no-hands claim depends on this: if flush ran before the verb
      // body, `mu task add` on one machine would publish nothing until
      // the NEXT invocation.
      await ambientIngest(a);
      seed(a, "t1");
      await ambientFlush(a);

      await ambientIngest(b);
      expect(taskRow(b, "t1")).toBeDefined();
    });
  });

  // ─── the different reader: --from <peer.db> ────────────────────────

  describe("ingestFromDb", () => {
    it("ingests a peer's ops table straight out of a DB file", async () => {
      seed(a, "t1", 50);
      updateTask(a, "t1", { impact: 95 }, { workstream: "demo" });

      const result = ingestFromDb(b, join(tempDir, "a.db"));
      expect(result.read).toBeGreaterThan(0);
      expect(result.changed).toBeGreaterThan(0);
      expect(taskRow(b, "t1")?.impact).toBe(95);
    });

    it("is idempotent: a second read changes nothing", async () => {
      seed(a, "t1");
      ingestFromDb(b, join(tempDir, "a.db"));
      const ops = opCount(b);
      const again = ingestFromDb(b, join(tempDir, "a.db"));
      expect(opCount(b)).toBe(ops);
      expect(again.changed).toBe(0);
    });

    it("never ships machine-local ops", async () => {
      seed(a, "t1");
      // agents / workspaces have no capture triggers, so the honest
      // assertion is that only synced entities arrive.
      ingestFromDb(b, join(tempDir, "a.db"));
      const entities = (db: Db): string[] =>
        (
          db.prepare("SELECT DISTINCT entity FROM ops ORDER BY entity").all() as {
            entity: string;
          }[]
        ).map((r) => r.entity);
      for (const entity of entities(b)) {
        expect(["workstream", "task", "edge", "note", "message"]).toContain(entity);
      }
    });

    it("does not write to the source DB (opened readonly)", async () => {
      seed(a, "t1");
      const sourcePath = join(tempDir, "a.db");
      const beforeOps = opCount(a);
      seed(b, "t2");
      ingestFromDb(b, sourcePath);
      expect(opCount(a)).toBe(beforeOps);
      expect(taskRow(a, "t2")).toBeUndefined();
    });

    it("is a typed not-found for a path that does not exist", () => {
      expect(() => ingestFromDb(b, join(tempDir, "nope.db"))).toThrow(SyncSourceNotFoundError);
    });

    it("skips a historical prose workstream.export op instead of throwing", () => {
      const machineId = localMachineId(a);
      a.prepare(
        `INSERT INTO ops
           (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
         VALUES (?, ?, 'legacy-export', 'system', 'workstream.export', 'workstream',
                 'demo', 'put', 'workstream export demo (out=/tmp/x)', ?)`,
      ).run(
        formatHlc({ wallMs: 2_000_000_000_000, counter: 0, machineId }),
        machineId,
        new Date().toISOString(),
      );

      const result = ingestFromDb(b, join(tempDir, "a.db"));
      expect(result.changed).toBe(0);
      expect(result.skippedLocal).toBe(1);
    });

    it("converges two machines that diverged on different fields", async () => {
      seed(a, "t1", 50);
      // b learns about t1 the segment way — ONE shared creation op — then
      // closes it. (Two independent `task add`s for the same id would
      // make the later creation legitimately win per-field LWW on every
      // field it names, including status: correct LWW on an unrealistic
      // history. See test/segments.test.ts's establishShared.)
      await flushSegment(a, dir);
      await syncPass(b, dir);
      closeTask(b, "t1", { workstream: "demo" });
      // a re-prices it.
      updateTask(a, "t1", { impact: 95 }, { workstream: "demo" });

      // Exchange in BOTH directions, one via DB read, one via segment.
      ingestFromDb(a, join(tempDir, "b.db"));
      ingestFromDb(b, join(tempDir, "a.db"));

      for (const db of [a, b]) {
        const row = taskRow(db, "t1");
        expect(row?.impact).toBe(95);
        expect(row?.status).toBe("CLOSED");
      }
    });
  });

  // ─── transport hints ───────────────────────────────────────────────

  describe("transportNextSteps", () => {
    const stalePeer = {
      machineId: "aaaa1111",
      short: "aaaa1111",
      path: "/tmp/aaaa1111.jsonl",
      conflictCopy: false,
      watermarkKey: "aaaa1111",
      watermark: 0,
      total: 0,
      behind: 0,
      lastSeenMs: 0,
      ageMs: PEER_STALE_MS + 1,
      stale: true,
    };

    it("prints a copy-pasteable rsync line for a stale peer", () => {
      const steps = transportNextSteps("/mnt/sync", [stalePeer]);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]?.command).toContain("rsync");
      expect(steps[0]?.command).toContain("/mnt/sync");
    });

    it("says nothing when every peer is fresh", () => {
      expect(transportNextSteps("/mnt/sync", [{ ...stalePeer, stale: false }])).toEqual([]);
    });

    it("never shells out: the hint is a STRING, not an invocation", () => {
      // The pledge, as a test: mu prints transport, it does not run it.
      const steps = transportNextSteps("/mnt/sync", [stalePeer]);
      for (const step of steps) {
        expect(typeof step.command).toBe("string");
      }
    });
  });
});
