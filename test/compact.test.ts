// `mu db compact` / `mu db forget` (src/compact.ts) and the slimmer note
// tombstone capture writes (src/capture.ts noteTombstonePayload).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compact, forget, listForgetCandidates, planCompact, planForget } from "../src/compact.js";
import { type Db, openDb } from "../src/db.js";
import { checkDrift } from "../src/drift.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { listRecentGroups, undoGroup } from "../src/undo.js";
import { ensureWorkstream, teardownWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

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

const teardownGroup = () => {
  const g = listRecentGroups(db, 50).find((x) => x.intents.includes("workstream.teardown"));
  if (!g) throw new Error("no teardown group");
  return g.groupId;
};

describe("note tombstones", () => {
  it("capture writes {} when a put under the key is in the log, and undo still restores", async () => {
    seed("demo", ["first", "second"]);
    await teardownWorkstream(db, { workstream: "demo", muxSession: "mu-absent-for-test" });
    const tombs = noteTombstones();
    expect(tombs).toHaveLength(2);
    expect(tombs.every((t) => t.payload === "{}")).toBe(true);
    undoGroup(db, teardownGroup());
    expect(notesIn("demo")).toEqual(["first", "second"]);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("capture keeps the full row when no put shares the key (drift-641)", async () => {
    seed("demo", ["only"]);
    // A reprojection moved the note's put to another key.
    db.prepare("UPDATE ops SET key = key || '-old' WHERE entity = 'note' AND op = 'put'").run();
    await teardownWorkstream(db, { workstream: "demo", muxSession: "mu-absent-for-test" });
    const [t] = noteTombstones();
    expect(JSON.parse(t?.payload ?? "{}")).toMatchObject({ content: "only" });
  });
});

describe("compact", () => {
  it("blanks only tombstones a put already explains; undo and drift unaffected", async () => {
    seed("demo", ["first", "second"]);
    await teardownWorkstream(db, { workstream: "demo", muxSession: "mu-absent-for-test" });
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
    undoGroup(db, teardownGroup());
    expect(notesIn("demo")).toEqual(["first", "second"]);
    expect(checkDrift(db).clean).toBe(true);
  });

  it("leaves a self-describing tombstone with no matching put alone", async () => {
    seed("demo", ["only"]);
    db.prepare("UPDATE ops SET key = key || '-old' WHERE entity = 'note' AND op = 'put'").run();
    await teardownWorkstream(db, { workstream: "demo", muxSession: "mu-absent-for-test" });
    expect(planCompact(db).tombstones).toBe(0);
  });
});

describe("forget", () => {
  it("lists torn-down workstreams largest first, never live ones", async () => {
    seed("small", ["x"]);
    seed("big", ["a".repeat(500), "b".repeat(500)]);
    seed("kept", ["live"]);
    await teardownWorkstream(db, { workstream: "small", muxSession: "mu-absent-for-test" });
    await teardownWorkstream(db, { workstream: "big", muxSession: "mu-absent-for-test" });
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
    await teardownWorkstream(db, { workstream: "again", muxSession: "mu-absent-for-test" });
    ensureWorkstream(db, "again");
    expect(planForget(db, ["again"]).refused).toEqual([{ name: "again", why: "live" }]);
  });

  it("deletes every op of the named workstream only; drift stays clean", async () => {
    seed("gone", ["x"]);
    seed("gone-too", ["y"]); // a prefix sibling: must survive
    seed("kept", ["z"]);
    await teardownWorkstream(db, { workstream: "gone", muxSession: "mu-absent-for-test" });
    await teardownWorkstream(db, { workstream: "gone-too", muxSession: "mu-absent-for-test" });
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
});
