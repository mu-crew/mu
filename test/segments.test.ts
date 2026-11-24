// Tests for src/segments.ts — the transport layer.
//
// The shape that matters is TWO DATABASES and one shared directory,
// because that is the real deployment: two machines, a folder something
// else moves. Single-DB tests would pass while missing the whole point,
// so most tests here open two temp DBs.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { appendLog } from "../src/logs.js";
import {
  discoverPeers,
  encodeSegmentLine,
  flushSegment,
  getWatermark,
  ingestSegment,
  localMachineId,
  readManifest,
  resetWatermark,
  SEGMENT_FORMAT_VERSION,
  segmentPath,
  verifyAgainstManifest,
} from "../src/segments.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, deleteTask, updateTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
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

  /** Establish a task on `origin` and sync it to `others`, so every
   *  machine shares ONE creation op.
   *
   *  This matters for the convergence tests. If each machine
   *  independently ran `task add` for the same id, each would emit its own
   *  `task.add` op naming EVERY field (including `status:"OPEN"`), and
   *  whichever creation happened to land a millisecond later would
   *  legitimately win per-field LWW on `status` — reverting a close that
   *  was made before it. That is correct LWW behaviour on an unrealistic
   *  history, not a sync bug: real peers create a task once and receive
   *  it. Sharing the creation op is therefore the honest fixture. */
  const establishShared = async (origin: Db, others: readonly Db[], localId: string) => {
    ensureWorkstream(origin, "demo");
    addTask(origin, {
      workstream: "demo",
      localId,
      title: localId.toUpperCase(),
      impact: 50,
      effortDays: 2,
    });
    await flushSegment(origin, dir);
    for (const other of others) {
      for (const peer of discoverPeers(dir, localMachineId(other))) ingestSegment(other, peer);
    }
  };

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

  // ─── round trip ──────────────────────────────────────────────────────

  describe("round trip between two machines", () => {
    it.each([
      ["REJECTED", "CLOSED"],
      ["DEFERRED", "OPEN"],
    ])("ingests a legacy %s task op as %s", (status, projected) => {
      const machineId = "legacy-v9-peer";
      const payload = JSON.stringify({
        title: "Legacy task",
        status,
        impact: 50,
        effort_days: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      const line = encodeSegmentLine({
        hlc: formatHlc({ wallMs: 2_000_000_000_000, counter: 0, machineId }),
        machineId,
        groupId: "legacy-group",
        actor: "v9-peer",
        intent: "task.defer",
        entity: "task",
        key: "demo/legacy",
        op: "put",
        payload,
      });
      const path = join(dir, `${machineId}.jsonl`);
      writeFileSync(path, `${line}\n`);

      const result = ingestSegment(b, {
        machineId,
        watermarkKey: machineId,
        path,
        conflictCopy: false,
      });
      expect(result.defects).toEqual([]);
      expect(task(b, "legacy")?.status).toBe(projected);
      expect(
        (
          b.prepare("SELECT payload FROM ops WHERE machine_id = ?").get(machineId) as {
            payload: string;
          }
        ).payload,
      ).toBe(payload);
    });

    it("A flushes, B ingests, and B's tables match A's", async () => {
      ensureWorkstream(a, "demo");
      addTask(a, { workstream: "demo", localId: "x", title: "X", impact: 60, effortDays: 1 });
      addTask(a, { workstream: "demo", localId: "y", title: "Y", impact: 40, effortDays: 2 });
      addBlockEdge(a, "demo", "y", "x");
      addNote(a, "x", "context", { workstream: "demo", author: "worker-1" });
      closeTask(a, "x", { workstream: "demo", evidence: "test" });

      const flushed = await flushSegment(a, dir);
      expect(flushed.appended).toBeGreaterThan(4);
      expect(existsSync(flushed.segmentPath ?? "")).toBe(true);

      const results = ingestAll(b);
      expect(results).toHaveLength(1);
      expect(results[0]?.defects).toEqual([]);

      // Row-by-row, not counts: a count-only check passes on garbage.
      const shape = (db: Db) => ({
        workstreams: db.prepare("SELECT name FROM workstreams ORDER BY name").all(),
        tasks: db
          .prepare(
            `SELECT w.name AS ws, t.local_id, t.title, t.status, t.impact, t.effort_days
               FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
              ORDER BY t.local_id`,
          )
          .all(),
        notes: db.prepare("SELECT author, content FROM task_notes ORDER BY content").all(),
        edges: db.prepare("SELECT COUNT(*) AS n FROM task_edges").get(),
      });
      expect(shape(b)).toEqual(shape(a));
    });

    it("carries a deletion across", async () => {
      seedTask(a, "gone");
      seedTask(a, "stays");
      await flushSegment(a, dir);
      ingestAll(b);
      expect(task(b, "gone")).toBeDefined();

      deleteTask(a, "gone", "demo");
      await flushSegment(a, dir);
      ingestAll(b);
      expect(task(b, "gone")).toBeUndefined();
      expect(task(b, "stays")).toBeDefined();
    });

    it("creates the segment even with nothing to say, so peers can discover us", async () => {
      const result = await flushSegment(a, dir);
      expect(result.appended).toBe(0);
      expect(existsSync(result.segmentPath ?? "")).toBe(true);
      // …and B sees A as a peer immediately.
      expect(peersFor(b).map((p) => p.machineId)).toEqual([localMachineId(a)]);
    });
  });

  // ─── THE MONEY TEST ──────────────────────────────────────────────────

  describe("convergence (the sync thesis)", () => {
    it("A and B edit DIFFERENT fields of the SAME task and both keep BOTH", async () => {
      // Proven at the applyOp level in R5; this proves it end-to-end
      // THROUGH FILES, which is the claim that actually matters.
      await establishShared(a, [b], "fix-auth");
      // Concurrent, on two machines, with no coordination.
      closeTask(a, "fix-auth", { workstream: "demo", evidence: "test" });
      updateTask(b, "fix-auth", { impact: 95 }, { workstream: "demo" });

      await flushSegment(a, dir);
      await flushSegment(b, dir);
      ingestAll(a);
      ingestAll(b);

      // BOTH edits survive on BOTH machines. Row-level LWW would have
      // discarded one of them.
      for (const [label, db] of [
        ["A", a],
        ["B", b],
      ] as const) {
        expect(task(db, "fix-auth"), label).toMatchObject({
          status: "CLOSED",
          impact: 95,
          title: "FIX-AUTH",
        });
      }
    });

    it("converges regardless of the order the segments are exchanged", async () => {
      await establishShared(a, [b], "t");
      closeTask(a, "t", { workstream: "demo", evidence: "test" });
      updateTask(b, "t", { impact: 77 }, { workstream: "demo" });

      // B ingests first this time, then A.
      await flushSegment(b, dir);
      ingestAll(a);
      await flushSegment(a, dir);
      ingestAll(b);
      // A must re-flush what it learned for B to see it? No — B already
      // has its own edit, and A's segment carries A's. Both converge.
      await flushSegment(a, dir);
      ingestAll(b);

      expect(task(a, "t")).toMatchObject({ status: "CLOSED", impact: 77 });
      expect(task(b, "t")).toMatchObject({ status: "CLOSED", impact: 77 });
    });

    it("a three-way exchange converges", async () => {
      const c = openDb({ path: join(tempDir, "c.db") });
      try {
        await establishShared(a, [b, c], "shared");
        closeTask(a, "shared", { workstream: "demo", evidence: "test" });
        updateTask(b, "shared", { impact: 88 }, { workstream: "demo" });
        updateTask(c, "shared", { title: "Renamed by C" }, { workstream: "demo" });

        for (const db of [a, b, c]) await flushSegment(db, dir);
        for (const db of [a, b, c]) ingestAll(db);
        // A second pass so each machine's own late edits propagate.
        for (const db of [a, b, c]) await flushSegment(db, dir);
        for (const db of [a, b, c]) ingestAll(db);

        for (const [label, db] of [
          ["A", a],
          ["B", b],
          ["C", c],
        ] as const) {
          expect(task(db, "shared"), label).toMatchObject({
            status: "CLOSED",
            impact: 88,
            title: "Renamed by C",
          });
        }
      } finally {
        c.close();
      }
    });
  });

  // ─── idempotence ─────────────────────────────────────────────────────

  describe("idempotence", () => {
    it("ingesting the same segment 3x gives identical state and no duplicate ops", async () => {
      seedTask(a, "p");
      seedTask(a, "q");
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");

      const first = ingestSegment(b, peer);
      const snapshot = {
        tasks: b.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all(),
        ops: (b.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n,
      };
      expect(first.applied).toBeGreaterThan(0);

      const second = ingestSegment(b, peer);
      const third = ingestSegment(b, peer);
      expect([second.applied, third.applied]).toEqual([0, 0]);
      expect({
        tasks: b.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all(),
        ops: (b.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n,
      }).toEqual(snapshot);
    });

    it("re-reading from zero is safe (the universal repair)", async () => {
      seedTask(a, "r");
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      ingestSegment(b, peer);
      const before = b.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all();
      const ops = (b.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

      resetWatermark(b, localMachineId(a));
      const again = ingestSegment(b, peer);
      // Every line is re-read and re-applied, changing nothing.
      expect(again.applied).toBeGreaterThan(0);
      expect(again.changed).toBe(0);
      expect(b.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all()).toEqual(
        before,
      );
      expect((b.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n).toBe(ops);
    });

    it("a large re-read compiles each SQL statement once, not once per op", async () => {
      for (let i = 0; i < 30; i++) seedTask(a, `bulk-${i}`, 10 + i);
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      ingestSegment(b, peer); // warm the per-connection cache
      resetWatermark(b, localMachineId(a));

      const real = b.prepare.bind(b);
      let compiles = 0;
      b.prepare = ((sql: string) => {
        compiles += 1;
        return real(sql);
      }) as typeof b.prepare;
      const again = ingestSegment(b, peer);
      b.prepare = real;

      expect(again.applied).toBeGreaterThanOrEqual(30);
      // The old path prepared ~10 statements per op (300+ here). What is
      // left is per-ingest setup and the op-context/watermark queries.
      expect(compiles).toBeLessThan(again.applied);
    });

    it("flushing twice appends nothing the second time", async () => {
      seedTask(a, "s");
      const first = await flushSegment(a, dir);
      const second = await flushSegment(a, dir);
      expect(first.appended).toBeGreaterThan(0);
      expect(second.appended).toBe(0);
      expect(second.total).toBe(first.total);
    });

    it("flush is incremental: only NEW ops are appended", async () => {
      seedTask(a, "u");
      const first = await flushSegment(a, dir);
      updateTask(a, "u", { impact: 91 }, { workstream: "demo" });
      const second = await flushSegment(a, dir);
      expect(second.appended).toBe(1);
      expect(second.total).toBe(first.total + 1);
    });
  });

  // ─── the four robustness layers ──────────────────────────────────────

  describe("robustness", () => {
    const seedFour = async (): Promise<string> => {
      ensureWorkstream(a, "demo");
      for (let i = 0; i < 4; i++) {
        addTask(a, {
          workstream: "demo",
          localId: `t${i}`,
          title: `T${i}`,
          impact: 50,
          effortDays: 1,
        });
      }
      await flushSegment(a, dir);
      return segFor(a);
    };

    it("LAYER 1: a torn write stops ingest at the last GOOD record", async () => {
      const path = await seedFour();
      const whole = readFileSync(path, "utf8");
      // Truncate mid-line, as an in-flight transfer would.
      writeFileSync(path, whole.slice(0, whole.length - 40));

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "torn-write")).toBe(true);
      expect(result.truncatedAt).not.toBeNull();
      // The watermark stopped short, so the tail is re-read next time.
      expect(result.watermark).toBeLessThan(linesOf(path).length + 1);
    });

    it("LAYER 1: the completed tail is picked up on the next ingest", async () => {
      const path = await seedFour();
      const whole = readFileSync(path, "utf8");
      writeFileSync(path, whole.slice(0, whole.length - 40));
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const partial = ingestSegment(b, peer);

      // The transfer completes.
      writeFileSync(path, whole);
      const rest = ingestSegment(b, peer);
      expect(rest.applied).toBeGreaterThan(0);
      expect(rest.defects).toEqual([]);
      expect(rest.watermark).toBeGreaterThan(partial.watermark);
    });

    it("LAYER 2: crc catches bit rot that JSON.parse accepts", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      const target = lines[1];
      if (target === undefined) throw new Error("expected a second line");
      // Valid JSON afterwards, but one field's content changed.
      lines[1] = target.replace('"title":"T0"', '"title":"TX"');
      expect(lines[1]).not.toBe(target);
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "crc-mismatch")).toBe(true);
      // Stopped at the bad line, so the good first line still applied.
      expect(result.watermark).toBe(1);
    });

    it("LAYER 3: a reordered segment is detected as non-monotonic", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      const third = lines[2];
      const fourth = lines[3];
      if (third === undefined || fourth === undefined) throw new Error("need 4 lines");
      lines[2] = fourth;
      lines[3] = third;
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "non-monotonic-hlc")).toBe(true);
    });

    it("LAYER 3: a duplicated line is reported but SKIPPED, not fatal", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      const first = lines[0];
      if (first === undefined) throw new Error("need a line");
      writeFileSync(path, `${[first, first, ...lines.slice(1)].join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.map((d) => d.kind)).toContain("duplicate-op");
      // The op is already recorded, so re-applying is a no-op; ingest
      // walks past it and finishes the file rather than wedging.
      expect(result.truncatedAt).toBeNull();
      expect(result.watermark).toBe(lines.length + 1);
      // `read` counts every line consumed, the skipped one included.
      expect(result.read).toBe(lines.length + 1);
      expect(result.applied).toBe(lines.length);
    });

    it("LAYER 3: a re-delivered BLOCK mid-file does not wedge the watermark", async () => {
      // The real incident: a peer's segment had lines 21344-21346
      // appended a second time as 21347-21349, byte-identical. Ingest
      // halted there permanently and `--repair` re-read from zero back
      // into the same three lines, so 1,846 later ops never arrived and
      // the two machines sat in undiagnosable drift.
      const path = await seedFour();
      const lines = linesOf(path);
      const block = lines.slice(1, 3);
      if (block.length !== 2) throw new Error("need 4 lines");
      const damaged = [...lines.slice(0, 3), ...block, ...lines.slice(3)];
      writeFileSync(path, `${damaged.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);

      expect(result.defects.filter((d) => d.kind === "duplicate-op")).toHaveLength(2);
      expect(result.defects.some((d) => d.kind === "non-monotonic-hlc")).toBe(false);
      expect(result.truncatedAt).toBeNull();
      // Everything past the re-delivered block landed.
      expect(result.watermark).toBe(damaged.length);
      const tasks = b.prepare(`SELECT count(*) AS n FROM tasks`).get() as { n: number };
      expect(tasks.n).toBe(4);
    });

    it("LAYER 3: an UNSEEN out-of-order line is still fatal", async () => {
      // Only a byte-identical re-delivery is benign. A line we have
      // never applied arriving out of order is real damage: a gap is
      // indistinguishable from reordering, so ingest must still halt.
      const path = await seedFour();
      const lines = linesOf(path);
      const third = lines[2];
      const fourth = lines[3];
      if (third === undefined || fourth === undefined) throw new Error("need 4 lines");
      writeFileSync(path, `${[lines[0], lines[1], fourth, third].join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "non-monotonic-hlc")).toBe(true);
      expect(result.truncatedAt).toBe(4);
    });

    it("LAYER 4: the manifest catches truncation on a line boundary", async () => {
      // Every remaining line is individually valid, so layers 1-3 see
      // nothing wrong. Only whole-file verification can catch this.
      const path = await seedFour();
      const lines = linesOf(path);
      writeFileSync(path, `${lines.slice(0, 2).join("\n")}\n`);

      const verified = verifyAgainstManifest(path);
      expect(verified.ok).toBe(false);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "manifest-mismatch")).toBe(true);
      // Reported, not a halt: the two remaining lines are valid.
      expect(result.truncatedAt).toBeNull();
      expect(result.applied).toBe(2);
    });

    it("a blank line in OWN segment is self-repaired, so peers do not halt there forever", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      writeFileSync(path, `${[lines[0], "", ...lines.slice(1)].join("\n")}\n`);

      // The owner must see the same defect peers halt on.
      addTask(a, { workstream: "demo", localId: "t4", title: "T4", impact: 50, effortDays: 1 });
      const flushed = await flushSegment(a, dir);
      expect(flushed.selfRepaired).toMatchObject({ kind: "malformed-shape", line: 2 });
      expect(readFileSync(path, "utf8")).not.toMatch(/\n\n/);

      const results = ingestAll(b);
      expect(results.flatMap((r) => r.defects)).toEqual([]);
      expect(task(b, "t4")).toBeDefined();
      expect(getWatermark(b, localMachineId(a))).toBe(flushed.total);
    });

    it("LAYER 4: a GROWN segment is not reported as damage", async () => {
      // The common case: the peer appended after the manifest we hold, or
      // our copy is mid-transfer. Flagging that would cry wolf constantly.
      const path = await seedFour();
      const manifest = readManifest(path);
      expect(manifest).not.toBeNull();
      addTask(a, { workstream: "demo", localId: "extra", title: "E", impact: 50, effortDays: 1 });
      const appended = linesOf(path).length;
      // Simulate a stale manifest by writing the file's new content
      // without refreshing the sidecar.
      const whole = readFileSync(path, "utf8");
      writeFileSync(path, whole);
      expect(linesOf(path).length).toBe(appended);
      expect(verifyAgainstManifest(path).ok).toBe(true);
    });

    it("refuses a segment line from an unknown format version", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      const first = lines[0];
      if (first === undefined) throw new Error("need a line");
      lines[0] = first.replace(`{"v":${SEGMENT_FORMAT_VERSION},`, '{"v":3,');
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "unknown-version")).toBe(true);
      expect(result.watermark).toBe(0);
    });

    it("a damaged segment is recoverable, not fatal: fix it and re-read", async () => {
      const path = await seedFour();
      const whole = readFileSync(path, "utf8");
      const lines = linesOf(path);
      const second = lines[1];
      if (second === undefined) throw new Error("need 2 lines");
      lines[1] = second.replace('"crc":"', '"crc":"0');
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      expect(ingestSegment(b, peer).defects.length).toBeGreaterThan(0);

      // Operator re-fetches the file; the watermark resumes cleanly.
      writeFileSync(path, whole);
      const repaired = ingestSegment(b, peer);
      expect(repaired.defects).toEqual([]);
      expect(task(b, "t3")).toBeDefined();
    });

    it("a mid-file corruption in OWN segment does not regrow the file forever on repeated flushes", async () => {
      // The regression this guards: readSegmentTail() used to report
      // only "stopped early", with no way to tell a genuine EOF apart
      // from a defect. flushLocked() treated both the same and kept
      // appending fresh ops after the wound on every call, so the file
      // grew strictly larger on EVERY subsequent flush, forever, and
      // never healed.
      const path = await seedFour();
      const lines = linesOf(path);
      const second = lines[1];
      if (second === undefined) throw new Error("need 2 lines");
      // Bit rot: valid JSON, bad crc, mid-file (not at EOF, unlike a
      // torn-write truncation).
      lines[1] = second.replace('"crc":"', '"crc":"0');
      writeFileSync(path, `${lines.join("\n")}\n`);

      // First flush after the damage: must be reported AND healed by
      // truncating back to the one good line before re-deriving anything
      // new from canonical `ops` (t1..t3, lost from disk, plus one new
      // op). That re-derivation happens ONCE, on this call — it is safe
      // regeneration from the canonical source, not the bug.
      addTask(a, { workstream: "demo", localId: "extra-a", title: "A", impact: 50, effortDays: 1 });
      const first = await flushSegment(a, dir);
      expect(first.selfRepaired).not.toBeNull();
      expect(first.selfRepaired?.kind).toBe("crc-mismatch");
      const lineCountBeforeCorruption = 4; // seedFour: t0..t3
      const lineCountAfterHeal = linesOf(path).length;
      // 1 surviving good line (t0) + everything canonical after it
      // (t1..t3, lost from disk, plus the new op) — regenerated once.
      expect(lineCountAfterHeal).toBeGreaterThan(lineCountBeforeCorruption - 3);
      expect(lineCountAfterHeal).toBeGreaterThanOrEqual(lineCountBeforeCorruption);

      // Every flush AFTER the heal is a normal, already-healthy flush:
      // nothing left to repair, and growth is exactly one line per new
      // op — never a repeat of the whole tail.
      for (let i = 0; i < 5; i++) {
        const before = linesOf(path).length;
        addTask(a, {
          workstream: "demo",
          localId: `extra-b${i}`,
          title: `B${i}`,
          impact: 50,
          effortDays: 1,
        });
        const result = await flushSegment(a, dir);
        expect(result.selfRepaired).toBeNull();
        expect(linesOf(path).length).toBe(before + 1);
      }

      // Total: the healed baseline plus exactly one line per subsequent
      // flush — bounded, linear, no repeated regrowth of the tail.
      expect(linesOf(path).length).toBe(lineCountAfterHeal + 5);

      // PEER RECOVERY: a peer discovering this segment from zero gets a
      // clean read all the way through — not a permanent stall on line 1
      // forever, which is what the unbounded-regrowth bug produced (a
      // corrupted first line that never moves, blocking every later,
      // perfectly good op behind it).
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects).toEqual([]);
      expect(result.applied).toBe(lineCountAfterHeal + 5);
      expect(task(b, "t0")).toBeDefined();
      expect(task(b, "t3")).toBeDefined();
      expect(task(b, "extra-b4")).toBeDefined();
    });

    // ─── bare-prose payloads ────────────────────────────────────────

    /** A `mu log "text"` line: entity 'message', payload is prose, not
     *  JSON. `appendLog` has always allowed this. */
    const seedProseMessage = (db: Db, text: string): void => {
      ensureWorkstream(db, "demo");
      appendLog(db, { workstream: "demo", source: "user", payload: text });
    };

    it("a bare-prose payload is encoded, not interpolated raw", async () => {
      // The regression: `encodeSegmentLine` concatenated ops.payload
      // straight into the JSON, so prose containing a comma or a quote
      // produced `"payload":Added 5 tasks, ...` — a line that is not
      // JSON. Every later read then flagged it, the self-repair
      // regenerated the SAME bad bytes from `ops`, and mu printed a
      // torn-write warning on EVERY invocation, forever.
      seedProseMessage(a, 'Added 5 tasks, one "quoted", and a }brace{');
      await flushSegment(a, dir);

      const lines = linesOf(segFor(a));
      expect(lines.length).toBe(2); // workstream put + the message
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    });

    it("a bare-prose payload round-trips to a peer byte-for-byte", async () => {
      const prose = 'Added 5 tasks, one "quoted", and a }brace{';
      seedProseMessage(a, prose);
      await flushSegment(a, dir);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects).toEqual([]);

      const row = b.prepare("SELECT payload FROM ops WHERE entity = 'message'").get() as
        | { payload: string }
        | undefined;
      expect(row?.payload).toBe(prose);
    });

    it("a prose payload does not put the segment in a permanent warning loop", async () => {
      seedProseMessage(a, "Added 5 tasks, see notes");
      const first = await flushSegment(a, dir);
      expect(first.selfRepaired).toBeNull();
      // The loop showed up on the SECOND flush: the first wrote the bad
      // line, the next re-read it and "repaired" it into itself.
      const second = await flushSegment(a, dir);
      expect(second.selfRepaired).toBeNull();
      expect(second.appended).toBe(0);
    });

    // ─── multiline JSON payloads ─────────────────────────────────────

    it("a pretty-printed JSON log line occupies one segment line and reaches a peer", async () => {
      // The regression: payloadTextFor passed valid JSON through
      // verbatim, raw LF included, so `mu log '{\n  "x": 1\n}'` wrote one
      // op as three physical lines and every peer halted at torn-write.
      seedProseMessage(a, '{\r\n  "x": 1,\n  "y": [\n    "a b"\n  ]\n}');
      await flushSegment(a, dir);

      const lines = linesOf(segFor(a));
      expect(lines.length).toBe(2); // workstream put + the message

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects).toEqual([]);
      expect(result.applied).toBe(2);

      const read = (db: Db) =>
        (
          db.prepare("SELECT payload FROM ops WHERE entity = 'message'").get() as {
            payload: string;
          }
        ).payload;
      expect(read(b)).toBe(read(a));
      expect(JSON.parse(read(b))).toEqual({ x: 1, y: ["a b"] });

      const second = await flushSegment(a, dir);
      expect(second.selfRepaired).toBeNull();
      expect(second.appended).toBe(0);
    });

    it("a multi-line JSON payload stored before the appendLog fix still flushes and reaches a peer", async () => {
      // rr_fix_r1_segments_legacy: appendLog only normalises NEW appends.
      // A row stored by an older build keeps its raw LF, and the encoder
      // threw on it, so flush could never get past that row.
      seedProseMessage(a, "placeholder");
      const legacy = '{\r\n  "x": 1,\n  "y": [\n    "a b"\n  ]\n}';
      a.prepare("UPDATE ops SET payload = ? WHERE entity = 'message'").run(legacy);
      appendLog(a, { workstream: "demo", source: "user", payload: "after the legacy row" });

      const first = await flushSegment(a, dir);
      expect(first.appended).toBe(3); // workstream put + legacy + ordinary
      expect(linesOf(segFor(a)).length).toBe(3);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects).toEqual([]);
      expect(result.applied).toBe(3);
      const payloads = (
        b.prepare("SELECT payload FROM ops WHERE entity = 'message' ORDER BY hlc").all() as Array<{
          payload: string;
        }>
      ).map((r) => r.payload);
      expect(payloads.length).toBe(2);
      expect(JSON.parse(payloads[0] ?? "")).toEqual({ x: 1, y: ["a b"] });
      expect(payloads[1]).toBe("after the legacy row");

      const second = await flushSegment(a, dir);
      expect(second.selfRepaired).toBeNull();
      expect(second.appended).toBe(0);
    });

    it("a log text that is a JSON string scalar round-trips byte-identical", async () => {
      // rr_r1_string_scalar_unwrap: '"hello"' is valid JSON, so it went
      // out verbatim, and the decoder unwrapped every JSON string whose
      // contents are not JSON, storing `hello` on the peer.
      const texts = ['"hello"', '"{\\"x\\":1}"', "hello", '""', "123", '{"a":"b"}'];
      for (const text of texts) seedProseMessage(a, text);
      await flushSegment(a, dir);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      expect(ingestSegment(b, peer).defects).toEqual([]);
      const read = (db: Db) =>
        (
          db
            .prepare("SELECT payload FROM ops WHERE entity = 'message' ORDER BY hlc")
            .all() as Array<{
            payload: string;
          }>
        ).map((r) => r.payload);
      expect(read(b)).toEqual(texts);
      expect(read(a)).toEqual(texts);
    });

    it("encodeSegmentLine never emits a payload that spans physical lines", () => {
      const op = {
        hlc: formatHlc({ wallMs: 1, counter: 0, machineId: "m" }),
        machineId: "m",
        groupId: "g",
        intent: null,
        actor: null,
        entity: "message",
        key: "demo",
        op: "put" as const,
      };
      // JSON is stripped of its line breaks (value-preserving).
      expect(encodeSegmentLine({ ...op, payload: '{\n"x":1}' })).toContain('"payload":{"x":1}');
      expect(encodeSegmentLine({ ...op, payload: '{\r"x":1}' })).toContain('"payload":{"x":1}');
      // Prose is JSON-string-encoded, so its newlines are escaped: fine.
      expect(encodeSegmentLine({ ...op, payload: "two\nlines" })).not.toMatch(/[\r\n]/);
    });

    it("a COMPLETE line that will not parse is malformed-shape, not torn-write", async () => {
      // Cause and remediation differ: a torn write means a transfer was
      // caught in flight (refetch the tail), a malformed complete line
      // means a writer bug or a hand edit (go read the writer).
      const path = await seedFour();
      const lines = linesOf(path);
      const second = lines[1];
      if (second === undefined) throw new Error("need 2 lines");
      lines[1] = second.replace('"payload":{', '"payload":oops{');
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.map((d) => d.kind)).toContain("malformed-shape");
      expect(result.defects.map((d) => d.kind)).not.toContain("torn-write");
    });
  });
});
