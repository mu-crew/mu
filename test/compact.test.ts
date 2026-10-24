// `mu db compact` / `mu db forget` (src/compact.ts) and the slimmer note
// tombstone capture writes (src/capture.ts noteTombstonePayload).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdDbForget } from "../src/cli/db.js";
import { compact, forget, listForgetCandidates, planCompact, planForget } from "../src/compact.js";
import { type Db, openDb } from "../src/db.js";
import { checkDrift } from "../src/drift.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { envelopeData } from "./_envelope.js";
import { rmFixtureDir } from "./_fs.js";
import { legacyHardTeardown } from "./_teardown.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-compact-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

function seed(ws: string, notes: string[]): void {
  ensureWorkstream(db, ws);
  addTask(db, { workstream: ws, localId: "a", title: "A", impact: 50, effortDays: 1 });
  for (const n of notes) addNote(db, "a", n, { workstream: ws, author: "w" });
}

const noteTombstones = () =>
  db
    .prepare("SELECT key, payload FROM ops WHERE entity = 'note' AND op = 'del' ORDER BY seq")
    .all() as {
    key: string;
    payload: string;
  }[];

const notesIn = (ws: string) =>
  (
    db
      .prepare(
        `SELECT n.content FROM task_notes n JOIN tasks t ON t.id = n.task_id
           JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ? ORDER BY n.content`,
      )
      .all(ws) as { content: string }[]
  ).map((r) => r.content);

describe("note tombstones", () => {
  it("capture writes {} when a put under the key is in the log", async () => {
    seed("demo", ["first", "second"]);
    legacyHardTeardown(db, "demo");
    const tombs = noteTombstones();
    expect(tombs).toHaveLength(2);
    expect(tombs.every((t) => t.payload === "{}")).toBe(true);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("capture keeps the full row when no put shares the key (drift-641)", async () => {
    seed("demo", ["only"]);
    // A reprojection moved the note's put to another key.
    db.prepare("UPDATE ops SET key = key || '-old' WHERE entity = 'note' AND op = 'put'").run();
    legacyHardTeardown(db, "demo");
    const [t] = noteTombstones();
    expect(JSON.parse(t?.payload ?? "{}")).toMatchObject({ content: "only" });
  });
});

describe("compact", () => {
  it("blanks only tombstones a put already explains; drift unaffected", async () => {
    seed("demo", ["first", "second"]);
    legacyHardTeardown(db, "demo");
    // Simulate history written before capture slimmed tombstones.
    db.prepare(
      `UPDATE ops SET payload = json_object('content', 'x', 'author', 'w', 'created_at', 'z')
        WHERE entity = 'note' AND op = 'del'`,
    ).run();
    const plan = planCompact(db);
    expect(plan.tombstones).toBe(2);
    expect(plan.bytes).toBeGreaterThan(0);
    compact(db);
    expect(planCompact(db).tombstones).toBe(0);
    expect(noteTombstones().every((t) => t.payload === "{}")).toBe(true);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("leaves a self-describing tombstone with no matching put alone", async () => {
    seed("demo", ["only"]);
    db.prepare("UPDATE ops SET key = key || '-old' WHERE entity = 'note' AND op = 'put'").run();
    legacyHardTeardown(db, "demo");
    expect(planCompact(db).tombstones).toBe(0);
  });
});

describe("forget", () => {
  it("lists torn-down workstreams largest first, never live ones", async () => {
    seed("small", ["x"]);
    seed("big", ["a".repeat(500), "b".repeat(500)]);
    seed("kept", ["live"]);
    legacyHardTeardown(db, "small");
    legacyHardTeardown(db, "big");
    expect(listForgetCandidates(db).map((c) => c.name)).toEqual(["big", "small"]);
  });

  it("refuses live and never-torn-down names", async () => {
    seed("kept", ["live"]);
    const plan = planForget(db, ["kept", "ghost"]);
    expect(plan.candidates).toEqual([]);
    expect(plan.refused).toEqual([
      { name: "kept", why: "live" },
      { name: "ghost", why: "never-torn-down" },
    ]);
  });

  it("a torn-down then recreated workstream is live, not a candidate", async () => {
    seed("again", ["x"]);
    legacyHardTeardown(db, "again");
    ensureWorkstream(db, "again");
    expect(planForget(db, ["again"]).refused).toEqual([{ name: "again", why: "live" }]);
  });

  it("deletes every op of the named workstream only; drift stays clean", async () => {
    seed("gone", ["x"]);
    seed("gone-too", ["y"]); // a prefix sibling: must survive
    seed("kept", ["z"]);
    legacyHardTeardown(db, "gone");
    legacyHardTeardown(db, "gone-too");
    const r = forget(db, planForget(db, ["gone"]));
    expect(r.ops).toBeGreaterThan(0);
    const keys = (db.prepare("SELECT DISTINCT key FROM ops").all() as { key: string }[]).map(
      (k) => k.key,
    );
    expect(keys.some((k) => k === "gone" || k.startsWith("gone/"))).toBe(false);
    expect(keys.some((k) => k === "gone-too" || k.startsWith("gone-too/"))).toBe(true);
    expect(notesIn("kept")).toEqual(["z"]);
    expect(checkDrift(db).clean).toBe(true);
    expect(listForgetCandidates(db).map((c) => c.name)).toEqual(["gone-too"]);
  });

  it("counts only its own key range: '0', '-' and '_' siblings are not swept in", async () => {
    for (const ws of ["a", "a0", "a-b", "a_b", "ab"]) {
      seed(ws, ["x"]);
      legacyHardTeardown(db, ws);
    }
    const count = (ws: string) =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM ops WHERE key = ? OR key LIKE ? ESCAPE '\\'")
          .get(ws, `${ws.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`) as { n: number }
      ).n;
    for (const c of listForgetCandidates(db)) expect(c.ops).toBe(count(c.name));
    expect(listForgetCandidates(db)).toHaveLength(5);
    const before = count("a");
    expect(forget(db, planForget(db, ["a"])).ops).toBe(before);
    expect(count("a")).toBe(0);
    for (const ws of ["a0", "a-b", "a_b", "ab"]) expect(count(ws)).toBeGreaterThan(0);
  });

  it("cmdDbForget --yes reports the shrunk main file, not the pre-checkpoint size", async () => {
    seed(
      "big",
      Array.from({ length: 40 }, (_, i) => `${i}${"x".repeat(20_000)}`),
    );
    legacyHardTeardown(db, "big");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      cmdDbForget(db, ["big"], { yes: true, json: true });
      const out = envelopeData<{ before: number; after: number }>(log.mock.calls[0]?.[0]);
      expect(out.after).toBeLessThan(out.before / 2);
    } finally {
      log.mockRestore();
    }
  });

  it("cmdDbForget --yes reports the shrunk size even when a reader blocks the checkpoint", async () => {
    seed(
      "big",
      Array.from({ length: 40 }, (_, i) => `${i}${"x".repeat(20_000)}`),
    );
    legacyHardTeardown(db, "big");
    db.pragma("wal_checkpoint(TRUNCATE)");
    // Fail the checkpoint fast instead of waiting out openDb's 5s busy_timeout.
    db.pragma("busy_timeout = 0");
    const reader = new Database(db.name, { readonly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM ops").get();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      cmdDbForget(db, ["big"], { yes: true, json: true });
      const out = envelopeData<{ before: number; after: number; checkpointed: boolean }>(
        log.mock.calls[0]?.[0],
      );
      expect(out.checkpointed).toBe(false);
      expect(out.after).toBeLessThan(out.before / 2);
    } finally {
      log.mockRestore();
      reader.exec("COMMIT");
      reader.close();
    }
  });
});
