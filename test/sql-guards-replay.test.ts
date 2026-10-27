// rr_fix_r1_sqlguards: local `mu sql --write` edits that the log cannot
// replay. Notes are append-only (author/content/created_at/kind are set
// at INSERT) and an edge's created_at is set once; a note tombstone must
// name WHICH note died even when a rebuild reassigned note ids.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { rebuildInto } from "../src/rebuild.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-sqlguards-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "demo");
  for (const id of ["a", "b"]) addTask(db, { workstream: "demo", localId: id, title: id });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const notes = (conn: Db): unknown[] =>
  conn.prepare("SELECT author, content, created_at FROM task_notes ORDER BY content").all();

/** Rebuild `conn` into a fresh file and read it with `fn`. */
function rebuilt<T>(conn: Db, fn: (r: Db) => T): T {
  const path = join(dir, `r${++n}.db`);
  rebuildInto(conn, { targetPath: path });
  const r = openDb({ path });
  try {
    return fn(r);
  } finally {
    r.close();
  }
}

describe("notes are append-only for local writes", () => {
  const seed = (): void => {
    addNote(db, "a", "before", { workstream: "demo", author: "u" });
  };

  it.each(["author = 'x'", "content = 'after'", "created_at = 'z'"])(
    "UPDATE task_notes SET %s is refused and leaves the note and log alone",
    (set) => {
      seed();
      const ops = db.prepare("SELECT COUNT(*) AS n FROM ops").get();
      expect(() => db.prepare(`UPDATE task_notes SET ${set}`).run()).toThrow(
        /append-only|set once/,
      );
      expect(db.prepare("SELECT COUNT(*) AS n FROM ops").get()).toEqual(ops);
      expect(notes(db)).toMatchObject([{ author: "u", content: "before" }]);
    },
  );

  it("a no-op rewrite and other columns still pass; ingest (applying) may rewrite", () => {
    seed();
    expect(() => db.prepare("UPDATE task_notes SET content = content").run()).not.toThrow();
    expect(() =>
      withCaptureSuppressed(db, () => db.prepare("UPDATE task_notes SET content = 'y'").run()),
    ).not.toThrow();
  });
});

describe("a note delete after a rebuild reassigned ids", () => {
  it("deleting B (whose id was reused from deleted A) stays deleted on the next rebuild", () => {
    for (const c of ["A", "B"])
      db.prepare(
        "INSERT INTO task_notes (task_id, author, content, created_at) SELECT id, 'u', ?, 'z' FROM tasks WHERE local_id = 'a'",
      ).run(c);
    db.prepare("DELETE FROM task_notes WHERE content = 'A'").run();
    const path = join(dir, "first.db");
    rebuildInto(db, { targetPath: path });
    const r = openDb({ path });
    try {
      // After the rebuild B holds id 1, but its put is under #2 and A's under #1.
      r.prepare("DELETE FROM task_notes WHERE content = 'B'").run();
      expect(notes(r)).toEqual([]);
      expect(rebuilt(r, notes)).toEqual([]);
    } finally {
      r.close();
    }
  });
});

describe("an edge's created_at is set once for local writes", () => {
  it("UPDATE task_edges SET created_at is refused; a no-op rewrite and ingest pass", () => {
    addBlockEdge(db, "demo", "b", "a");
    const before = db.prepare("SELECT created_at FROM task_edges").get();
    expect(() => db.prepare("UPDATE task_edges SET created_at = 'after'").run()).toThrow(
      /set once/,
    );
    expect(db.prepare("SELECT created_at FROM task_edges").get()).toEqual(before);
    expect(() => db.prepare("UPDATE task_edges SET created_at = created_at").run()).not.toThrow();
    expect(() =>
      withCaptureSuppressed(db, () =>
        db.prepare("UPDATE task_edges SET created_at = 'ingested'").run(),
      ),
    ).not.toThrow();
  });
});
