// Tests for src/segments.ts — the transport layer.
//
// The shape that matters is TWO DATABASES and one shared directory,
// because that is the real deployment: two machines, a folder something
// else moves. Single-DB tests would pass while missing the whole point,
// so most tests here open two temp DBs.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { formatHlc, parseHlc } from "../src/hlc.js";
import { withOpContext } from "../src/op-context.js";
import {
  discoverPeers,
  encodeSegmentLine,
  flushSegment,
  getWatermark,
  ingestSegment,
  localMachineId,
  peerWatermarkKey,
  segmentPath,
  syncDir,
  syncPass,
} from "../src/segments.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

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

  /** Ingest every peer once. */
  const ingestAll = (db: Db) => peersFor(db).map((peer) => ingestSegment(db, peer));

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

  // ─── filtering ───────────────────────────────────────────────────────

  describe("filtering", () => {
    it("machine-local ops NEVER appear in a segment", async () => {
      seedTask(a, "visible");
      // An agent op, as capture would record it: pane id + absolute path,
      // both meaningless on another machine.
      withOpContext(a, { intent: "agent.spawn", group: "new" }, () => {
        a.prepare(
          `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
           VALUES (?, ?, 'g-local', 'user', 'agent.spawn', 'agent', 'demo/worker-1', 'put',
                   '{"pane_id":"%17","path":"/home/me/ws"}', ?)`,
        ).run(
          `001999999999999.000000.${localMachineId(a)}`,
          localMachineId(a),
          new Date().toISOString(),
        );
      });

      const result = await flushSegment(a, dir);
      expect(result.skippedLocal).toBe(1);

      const raw = readFileSync(segFor(a), "utf8");
      const entities = linesOf(segFor(a)).map((l) => (JSON.parse(l) as { entity: string }).entity);
      expect(entities).not.toContain("agent");
      // The specific values that would be wrong elsewhere.
      expect(raw).not.toContain("%17");
      expect(raw).not.toContain("/home/me/ws");
    });

    it("a segment holds only THIS machine's ops, never re-flushed peer ops", async () => {
      // Otherwise two machines would echo each other's history under
      // their own names, growing without bound.
      seedTask(a, "mine");
      await flushSegment(a, dir);
      ingestAll(b);
      seedTask(b, "theirs");
      await flushSegment(b, dir);

      const machines = new Set(
        linesOf(segFor(b)).map((l) => (JSON.parse(l) as { machine: string }).machine),
      );
      expect(machines).toEqual(new Set([localMachineId(b)]));
    });

    it("ingest reports a non-synced entity as a bad-peer defect, not a crash", async () => {
      seedTask(a, "ok");
      await flushSegment(a, dir);
      // A malicious/buggy peer appends an entity that must never travel.
      const path = segFor(a);
      const lines = linesOf(path);
      const template = lines[0];
      if (template === undefined) throw new Error("need a line");
      const forged = template
        .replace('"entity":"workstream"', '"entity":"agent"')
        .replace(/"hlc":"[^"]+"/, '"hlc":"001999999999999.000000.forged"');
      writeFileSync(path, `${[...lines, forged].join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      // Must not throw.
      const result = ingestSegment(b, peer);
      expect(result.defects.length).toBeGreaterThan(0);
      // Either the crc guard or the entity guard catches it; both are
      // correct rejections of a line that should not exist.
      expect(
        result.defects.some((d) => d.kind === "entity-not-synced" || d.kind === "crc-mismatch"),
      ).toBe(true);
    });

    // ─── the frozen-watermark incident ──────────────────────────────
    //
    // One well-formed line naming an entity this build does not know
    // (`marker`, written by a peer whose vocabulary included it) used to
    // stop the ingest AT that line and leave the watermark there
    // forever — 87% of a 20,305-line segment never applied, and
    // `mu sync --repair` re-read straight back into the same wall.

    /** Append a line whose entity this build refuses/does not know,
     *  correctly crc'd, hlc just above the file's last line so ops
     *  flushed AFTERWARDS still sort above it (a future-dated hlc would
     *  trip the monotonicity guard instead, which is a different bug). */
    const appendForeignEntityLine = (path: string, entity: string): void => {
      const lines = linesOf(path);
      const last = lines[lines.length - 1];
      if (last === undefined) throw new Error("need a line to sort after");
      const prev = parseHlc((JSON.parse(last) as { hlc: string }).hlc);
      const line = encodeSegmentLine({
        hlc: formatHlc({ ...prev, counter: prev.counter + 1, machineId: localMachineId(a) }),
        machineId: localMachineId(a),
        groupId: "restore-v8-archive-gchatui-df077055",
        intent: "archive.add",
        actor: "v8-archive-import",
        entity,
        key: "gchatui/gchatui",
        op: "put",
        payload: JSON.stringify({ name: "gchatui" }),
      });
      writeFileSync(path, `${[...lines, line].join("\n")}\n`);
    };

    it("an unknown-entity line mid-segment does not block the ops after it", async () => {
      seedTask(a, "before");
      await flushSegment(a, dir);
      const path = segFor(a);
      appendForeignEntityLine(path, "marker");
      // Real ops AFTER the foreign line — the 87% that never arrived.
      seedTask(a, "after");
      await flushSegment(a, dir);

      const results = ingestAll(b);
      expect(task(b, "before")?.local_id).toBe("before");
      expect(task(b, "after")?.local_id).toBe("after");
      // Unknown ≠ machine-local: nothing to report, nothing skipped.
      expect(results.flatMap((r) => r.defects)).toEqual([]);
    });

    it("a machine-local-entity line is skipped, defect reported, tail applied", async () => {
      seedTask(a, "before");
      await flushSegment(a, dir);
      const path = segFor(a);
      appendForeignEntityLine(path, "agent");
      seedTask(a, "after");
      await flushSegment(a, dir);

      const results = ingestAll(b);
      const defects = results.flatMap((r) => r.defects);
      expect(defects.map((d) => d.kind)).toEqual(["entity-not-synced"]);
      // The point of the fix: the watermark moved PAST the refused line.
      expect(results.every((r) => r.truncatedAt === null)).toBe(true);
      expect(task(b, "after")?.local_id).toBe("after");
      // And the refused op was not recorded locally at all.
      const rows = b.prepare("SELECT COUNT(*) AS n FROM ops WHERE entity = 'agent'").get() as {
        n: number;
      };
      expect(rows.n).toBe(0);
    });

    it("the watermark reaches the end of the file despite a refused line", async () => {
      seedTask(a, "before");
      await flushSegment(a, dir);
      appendForeignEntityLine(segFor(a), "agent");
      seedTask(a, "after");
      await flushSegment(a, dir);

      ingestAll(b);
      expect(getWatermark(b, localMachineId(a))).toBe(linesOf(segFor(a)).length);

      // A second ingest is a clean no-op, so the ambient hook does not
      // re-report the same defect on every single mu invocation.
      const again = ingestAll(b);
      expect(again.flatMap((r) => r.defects)).toEqual([]);
      expect(again.every((r) => r.read === 0)).toBe(true);
    });
  });

  // ─── peer discovery ──────────────────────────────────────────────────

  describe("peer discovery", () => {
    it("finds every segment that is not mine, with no membership list", async () => {
      await flushSegment(a, dir);
      await flushSegment(b, dir);
      expect(peersFor(a).map((p) => p.machineId)).toEqual([localMachineId(b)]);
      expect(peersFor(b).map((p) => p.machineId)).toEqual([localMachineId(a)]);
    });

    it("ingests a Syncthing conflict copy", async () => {
      // Still a valid op log, and dedup by (machine, hlc) makes reading it
      // safe. Ignoring it would drop real ops exactly when something has
      // already gone wrong.
      seedTask(a, "conflicted");
      await flushSegment(a, dir);
      const original = segFor(a);
      const conflict = join(
        dir,
        `${localMachineId(a)}.sync-conflict-20260609-123456-ABCDEFG.jsonl`,
      );
      writeFileSync(conflict, readFileSync(original, "utf8"));

      const peers = peersFor(b);
      expect(peers.some((p) => p.conflictCopy)).toBe(true);
      const copy = peers.find((p) => p.conflictCopy);
      if (copy === undefined) throw new Error("expected the conflict copy");
      // Its machine id is recovered from the stem before the marker.
      expect(copy.machineId).toBe(localMachineId(a));

      for (const peer of peers) ingestSegment(b, peer);
      expect(task(b, "conflicted")).toBeDefined();
    });

    it("a DIVERGED conflict copy has its own watermark, so ops only in the copy land", async () => {
      // Original [t1, t2, t3] and copy [t1, t2, t4]: a shared line-count
      // watermark of 3 would skip the copy's t4 without a defect.
      seedTask(a, "t1");
      seedTask(a, "t2");
      await flushSegment(a, dir);
      const original = segFor(a);
      const shared = readFileSync(original, "utf8");
      addTask(a, { workstream: "demo", localId: "t4", title: "T4", impact: 50, effortDays: 1 });
      await flushSegment(a, dir);
      const copyText = readFileSync(original, "utf8");
      // Rewind the original and give it a different third op.
      writeFileSync(original, shared);
      a.prepare("DELETE FROM ops WHERE key LIKE '%/t4'").run();
      addTask(a, { workstream: "demo", localId: "t3", title: "T3", impact: 50, effortDays: 1 });
      await flushSegment(a, dir);
      const conflict = join(
        dir,
        `${localMachineId(a)}.sync-conflict-20260609-123456-ABCDEFG.jsonl`,
      );
      writeFileSync(conflict, copyText);
      expect(linesOf(conflict).length).toBe(linesOf(original).length);

      const results = ingestAll(b);
      expect(results.flatMap((r) => r.defects)).toEqual([]);
      for (const id of ["t1", "t2", "t3", "t4"]) expect(task(b, id)).toBeDefined();
      const copy = peersFor(b).find((p) => p.conflictCopy);
      if (copy === undefined) throw new Error("expected the conflict copy");
      expect(copy.watermarkKey).not.toBe(copy.machineId);
      expect(getWatermark(b, peerWatermarkKey(copy))).toBe(linesOf(conflict).length);
    });

    it("ignores non-segment files in the sync dir", async () => {
      await flushSegment(a, dir);
      writeFileSync(join(dir, "README.md"), "not a segment");
      writeFileSync(join(dir, "notes.txt"), "nor this");
      expect(peersFor(b).map((p) => p.machineId)).toEqual([localMachineId(a)]);
    });

    it("returns nothing when the dir does not exist", () => {
      expect(discoverPeers(join(tempDir, "absent"), localMachineId(a))).toEqual([]);
    });
  });

  // ─── watermarks ──────────────────────────────────────────────────────

  describe("watermarks", () => {
    it("advance with each ingest and persist", async () => {
      seedTask(a, "w1");
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");

      expect(getWatermark(b, localMachineId(a))).toBe(0);
      const first = ingestSegment(b, peer);
      expect(getWatermark(b, localMachineId(a))).toBe(first.watermark);
      expect(first.watermark).toBeGreaterThan(0);

      // A new op on A advances it further, and only by the new lines.
      addTask(a, { workstream: "demo", localId: "w2", title: "W2", impact: 50, effortDays: 1 });
      await flushSegment(a, dir);
      const second = ingestSegment(b, peer);
      expect(second.watermark).toBeGreaterThan(first.watermark);
      expect(second.applied).toBe(1);
    });

    it("one integer per peer, tracked independently", async () => {
      const c = openDb({ path: join(tempDir, "c2.db") });
      try {
        seedTask(a, "from-a");
        ensureWorkstream(c, "demo");
        addTask(c, {
          workstream: "demo",
          localId: "from-c",
          title: "C",
          impact: 50,
          effortDays: 1,
        });
        await flushSegment(a, dir);
        await flushSegment(c, dir);
        ingestAll(b);

        expect(getWatermark(b, localMachineId(a))).toBeGreaterThan(0);
        expect(getWatermark(b, localMachineId(c))).toBeGreaterThan(0);
        const rows = b.prepare("SELECT machine_id FROM sync_peers ORDER BY machine_id").all() as {
          machine_id: string;
        }[];
        expect(rows).toHaveLength(2);
      } finally {
        c.close();
      }
    });

    it("survives a close/reopen (it is DB state, not memory)", async () => {
      seedTask(a, "persist");
      await flushSegment(a, dir);
      ingestAll(b);
      const mark = getWatermark(b, localMachineId(a));
      const path = join(tempDir, "b.db");
      b.close();
      b = openDb({ path });
      expect(getWatermark(b, localMachineId(a))).toBe(mark);
    });
  });

  // ─── receiveHlc on ingest ────────────────────────────────────────────

  describe("clock advance on ingest", () => {
    it("the local clock advances past an ingested op's HLC", async () => {
      // What makes "laptop edits after seeing devserver's op" order
      // correctly rather than losing to it.
      seedTask(a, "clock");
      await flushSegment(a, dir);
      const peerMax = linesOf(segFor(a))
        .map((l) => (JSON.parse(l) as { hlc: string }).hlc)
        .sort()
        .at(-1);
      if (peerMax === undefined) throw new Error("expected an hlc");

      ingestAll(b);

      // An edit B makes NOW must sort above everything it just ingested.
      ensureWorkstream(b, "demo");
      addTask(b, {
        workstream: "demo",
        localId: "after",
        title: "After",
        impact: 50,
        effortDays: 1,
      });
      const localMax = (
        b
          .prepare("SELECT MAX(hlc) AS hlc FROM ops WHERE machine_id = ?")
          .get(localMachineId(b)) as {
          hlc: string;
        }
      ).hlc;
      expect(localMax > peerMax).toBe(true);
    });
  });

  // ─── sync not configured ─────────────────────────────────────────────

  describe("MU_SYNC_DIR unset", () => {
    it("flush, ingest and syncPass are no-ops costing nothing", async () => {
      seedTask(a, "nosync");
      const flushed = await flushSegment(a, null);
      expect(flushed).toEqual({
        segmentPath: null,
        appended: 0,
        total: 0,
        skippedLocal: 0,
        selfRepaired: null,
        foreignVersionAt: null,
        foreignVersion: null,
      });

      const pass = await syncPass(a, null);
      expect(pass.flushed.segmentPath).toBeNull();
      expect(pass.ingested).toEqual([]);
      expect(pass.defective).toBe(false);
    });

    it("syncDir() reads the env var and treats blank as unset", () => {
      const key = "MU_SYNC_DIR";
      delete process.env[key];
      expect(syncDir()).toBeNull();
      process.env[key] = "   ";
      expect(syncDir()).toBeNull();
      process.env[key] = dir;
      expect(syncDir()).toBe(dir);
      delete process.env[key];
    });

    it("syncDir() REFUSES a non-temp dir under a test runner", () => {
      // Sibling of the openDb user-DB guard. Pointing MU_DB_PATH at a
      // temp file does not contain a test: sync is ambient, so the
      // first flush stamps that DB's fresh machine_id onto a segment
      // in whatever MU_SYNC_DIR names — on a dev box, the user's real
      // folder, leaving a phantom peer nothing ever prunes. Eight such
      // phantoms were found in ~/mu, all from the documented
      // `MU_DB_PATH=/tmp/mu-smoke.db mu <verb>` recipe, which
      // overrides the DB and says nothing about the sync dir.
      const key = "MU_SYNC_DIR";
      process.env[key] = join(homedir(), "mu");
      expect(() => syncDir()).toThrow(/syncDir refused/);
      // A per-test temp dir is the supported shape and stays allowed.
      process.env[key] = dir;
      expect(syncDir()).toBe(dir);
      delete process.env[key];
    });
  });

  // ─── syncPass ────────────────────────────────────────────────────────

  describe("syncPass", () => {
    it("flushes then ingests every peer in one call", async () => {
      seedTask(a, "one");
      seedTask(b, "two");
      await flushSegment(a, dir);

      const pass = await syncPass(b, dir);
      expect(pass.flushed.appended).toBeGreaterThan(0);
      expect(pass.ingested).toHaveLength(1);
      expect(pass.defective).toBe(false);
      expect(task(b, "one")).toBeDefined();
    });

    it("reports defective when a peer segment is damaged", async () => {
      seedTask(a, "dmg");
      await flushSegment(a, dir);
      const path = segFor(a);
      writeFileSync(path, `${readFileSync(path, "utf8").slice(0, 30)}`);

      const pass = await syncPass(b, dir);
      expect(pass.defective).toBe(true);
    });

    it("two concurrent flushes do not interleave lines", async () => {
      // The lock's job. Every line must still parse afterwards; an
      // interleave would produce spliced garbage.
      ensureWorkstream(a, "demo");
      for (let i = 0; i < 12; i++) {
        addTask(a, {
          workstream: "demo",
          localId: `c${i}`,
          title: `C${i}`,
          impact: 50,
          effortDays: 1,
        });
      }
      await Promise.all([flushSegment(a, dir), flushSegment(a, dir), flushSegment(a, dir)]);

      const lines = linesOf(segFor(a));
      for (const line of lines) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      // And no op was written twice.
      const hlcs = lines.map((l) => (JSON.parse(l) as { hlc: string }).hlc);
      expect(new Set(hlcs).size).toBe(hlcs.length);
    });
  });
});
