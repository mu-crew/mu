// Fast-tier unit tests for `listTornDownWorkstreams` — the reader
// behind `mu workstream list --torn-down`.
//
// The list exists so a teardown from last month is reachable (its group
// id feeds `mu log --group`) without hand-written SQL over `ops`.
//
// It reads the ops log rather than a side table, so the cases that
// matter are the ones where the log holds more than "one name, one
// row": a name torn down twice, and a name recreated
// after its teardown.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask } from "../src/tasks.js";
import {
  ensureWorkstream,
  listTornDownWorkstreams,
  teardownWorkstream,
} from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("listTornDownWorkstreams", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-torndown-test-"));
    db = openDb({ path: join(dir, "mu.db") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(dir);
  });

  const seed = (name: string): void => {
    ensureWorkstream(db, name);
    addTask(db, { workstream: name, localId: "a", title: "A", impact: 60, effortDays: 1 });
    addTask(db, { workstream: name, localId: "b", title: "B", impact: 40, effortDays: 2 });
    addBlockEdge(db, name, "b", "a");
    addNote(db, "a", "context", { workstream: name, author: "worker-1" });
  };

  const tearDown = async (name: string): Promise<void> => {
    await teardownWorkstream(db, { workstream: name, muxSession: "mu-absent-for-test" });
  };

  it("is empty on a fresh DB, and stays empty for a live workstream", async () => {
    expect(listTornDownWorkstreams(db)).toEqual([]);
    seed("demo");
    expect(listTornDownWorkstreams(db)).toEqual([]);
  });

  it("reports the group id and what the teardown removed", async () => {
    seed("demo");
    await tearDown("demo");

    const gone = listTornDownWorkstreams(db);
    expect(gone).toHaveLength(1);
    const [entry] = gone;
    if (entry === undefined) throw new Error("expected one entry");
    expect(entry.name).toBe("demo");
    // The counts are the point of the row: they say what is at stake
    // without a second query per line.
    expect(entry).toMatchObject({ tasks: 2, notes: 1, edges: 1, recreated: false });
    expect(entry.group).toMatch(/^[0-9a-f-]{36}$/);
    // The group id resolves to the teardown's ops.
    const ops = db.prepare("SELECT COUNT(*) AS n FROM ops WHERE group_id = ?").get(entry.group) as {
      n: number;
    };
    expect(ops.n).toBeGreaterThan(0);
  });

  it("marks an entry recreated once the name is back", async () => {
    seed("demo");
    await tearDown("demo");
    const [before] = listTornDownWorkstreams(db);
    if (before === undefined) throw new Error("expected one entry");
    expect(before.recreated).toBe(false);

    ensureWorkstream(db, "demo");

    // The teardown op is still in the log — history does not change —
    // but the entry now says the name came back.
    const [after] = listTornDownWorkstreams(db);
    if (after === undefined) throw new Error("expected the entry to persist");
    expect(after.group).toBe(before.group);
    expect(after.recreated).toBe(true);
  });

  it("keeps one entry per teardown when a name is reused, newest first", async () => {
    // The identity of an entry is the GROUP, not the name: tearing down
    // 'demo', recreating it and tearing it down again is two distinct
    // recoverable points, and collapsing them by name would hide one.
    seed("demo");
    await tearDown("demo");
    seed("demo");
    addNote(db, "b", "second life", { workstream: "demo", author: "worker-2" });
    await tearDown("demo");

    const gone = listTornDownWorkstreams(db);
    expect(gone).toHaveLength(2);
    expect(gone.map((g) => g.name)).toEqual(["demo", "demo"]);
    expect(new Set(gone.map((g) => g.group)).size).toBe(2);
    // Newest first, and the newest teardown removed the extra note.
    const [newest, oldest] = gone;
    if (newest === undefined || oldest === undefined) throw new Error("expected two entries");
    expect(newest.notes).toBe(2);
    expect(oldest.notes).toBe(1);
    // The older one reads 'recreated' because the second seed() put the
    // name back after it.
    expect(oldest.recreated).toBe(true);
    expect(newest.recreated).toBe(false);
  });

  it("ignores teardowns recorded under the cut pre-1.2.0 intent spelling", async () => {
    seed("demo");
    await tearDown("demo");
    db.prepare(
      "UPDATE ops SET intent = 'workstream.destroy' WHERE intent = 'workstream.teardown'",
    ).run();

    expect(listTornDownWorkstreams(db)).toEqual([]);
  });
});
