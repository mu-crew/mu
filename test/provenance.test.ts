// Provenance: resolveProvenance, its stamping on every op, and the legacy task_notes rebuild.

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendLog, listLogs } from "../src/logs.js";
import { withOpContext } from "../src/op-context.js";
import { resolveProvenance } from "../src/provenance.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-prov-"));
});
afterEach(() => rmFixtureDir(dir));

const entry = (id: string, role: string, content: unknown[] = []): string =>
  `${JSON.stringify({ type: "message", id, message: { role, content } })}\n`;

describe("resolveProvenance", () => {
  it("is null without any env", () => {
    expect(resolveProvenance({})).toEqual({ actorSession: null, actorAnchor: null });
  });

  it("prefers MU_ACTOR_* over the pi session", () => {
    expect(
      resolveProvenance({
        MU_ACTOR_SESSION: "x:1",
        MU_ACTOR_ANCHOR: "a1",
        PI_SESSION_ID: "p",
        PI_SESSION_FILE: join(dir, "nope.jsonl"),
      }),
    ).toEqual({ actorSession: "x:1", actorAnchor: "a1" });
  });

  it("takes the latest assistant entry, with its sole tool call", () => {
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      entry("u1", "user") +
        entry("a1", "assistant") +
        entry("a2", "assistant", [{ type: "text" }, { type: "toolCall", id: "tc9" }]) +
        entry("u2", "user"),
    );
    expect(resolveProvenance({ PI_SESSION_ID: "p", PI_SESSION_FILE: f })).toEqual({
      actorSession: "pi:p",
      actorAnchor: "a2:tc9",
    });
  });

  it("uses the bare id for zero or several tool calls", () => {
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      entry("a1", "assistant", [
        { type: "toolCall", id: "x" },
        { type: "toolCall", id: "y" },
      ]),
    );
    expect(resolveProvenance({ PI_SESSION_FILE: f }).actorAnchor).toBe("a1");
  });

  it("reads only the 64KB tail and skips the cut first line", () => {
    const f = join(dir, "s.jsonl");
    writeFileSync(f, entry("old", "assistant"));
    appendFileSync(f, entry("pad", "user", ["x".repeat(70 * 1024)]));
    appendFileSync(f, entry("tail", "assistant"));
    expect(resolveProvenance({ PI_SESSION_FILE: f }).actorAnchor).toBe("tail");
    writeFileSync(f, entry("old", "assistant") + entry("pad", "user", ["x".repeat(70 * 1024)]));
    expect(resolveProvenance({ PI_SESSION_FILE: f }).actorAnchor).toBeNull();
  });

  it("is null on a missing file", () => {
    expect(resolveProvenance({ PI_SESSION_FILE: join(dir, "missing") }).actorAnchor).toBeNull();
  });
});

describe("op stamping", () => {
  it("stamps captured ops and log lines, and listLogs exposes them", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      await withEnv("MU_ACTOR_SESSION", "pi:s1", async () => {
        await withEnv("MU_ACTOR_ANCHOR", "e1:t1", async () => {
          ensureWorkstream(db, "w");
          addTask(db, { workstream: "w", localId: "t", title: "T" });
          appendLog(db, { workstream: "w", source: "me", payload: "hi" });
        });
      });
      const rows = listLogs(db, {});
      expect(rows.length).toBeGreaterThan(2);
      for (const r of rows)
        expect(r).toMatchObject({ actorSession: "pi:s1", actorAnchor: "e1:t1" });
      expect(rows.some((r) => r.key === "w/t")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("leaves provenance null without env, and an explicit scope wins", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      await withEnv("MU_ACTOR_SESSION", undefined, async () => {
        await withEnv("PI_SESSION_ID", undefined, async () => {
          ensureWorkstream(db, "w");
          withOpContext(db, { intent: "x", actorSession: "pi:explicit" }, () =>
            addTask(db, { workstream: "w", localId: "t", title: "T" }),
          );
        });
      });
      const rows = listLogs(db, {});
      expect(rows.find((r) => r.key === "w")?.actorSession).toBeNull();
      expect(rows.find((r) => r.key === "w")?.actorAnchor).toBeNull();
      expect(process.env.PI_SESSION_FILE).toBeUndefined(); // test/_setup.ts scrubs it
      expect(rows.find((r) => r.key === "w/t")?.actorSession).toBe("pi:explicit");
    } finally {
      db.close();
    }
  });
});

describe("legacy task_notes", () => {
  it("is rebuilt with the review kind, keeping its notes", () => {
    const path = join(dir, "mu.db");
    const db = openDb({ path });
    ensureWorkstream(db, "w");
    addTask(db, { workstream: "w", localId: "t", title: "T" });
    db.prepare(
      "INSERT INTO task_notes (task_id, author, content, created_at, kind) SELECT id, 'a', 'kept', 'now', 'report' FROM tasks",
    ).run();
    // Put the old shape and capture stamp back, as a release before `review` left them.
    db.exec("DROP TABLE task_notes");
    db.exec(`CREATE TABLE task_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
      author TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('brief', 'report', 'verdict', 'close', 'note')))`);
    db.exec(
      "INSERT INTO task_notes (task_id, author, content, created_at, kind) SELECT id, 'a', 'kept', 'now', 'report' FROM tasks",
    );
    db.exec("UPDATE schema_version SET capture_version = 6");
    db.close();

    const again = openDb({ path });
    try {
      again
        .prepare(
          "INSERT INTO task_notes (task_id, author, content, created_at, kind) SELECT id, 'a', 'r', 'now', 'review' FROM tasks",
        )
        .run();
      expect(again.prepare("SELECT kind, content FROM task_notes ORDER BY id").all()).toEqual([
        { kind: "report", content: "kept" },
        { kind: "review", content: "r" },
      ]);
      // The capture triggers are back: the review note minted an op.
      expect(
        again
          .prepare(
            "SELECT COUNT(*) AS n FROM ops WHERE entity = 'note' AND payload LIKE '%review%'",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      again.close();
    }
  });
});
