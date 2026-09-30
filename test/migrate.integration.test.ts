// scripts/migrate.ts — the 0.4.x → 1.0 data escape hatch.
//
// Integration tier: it writes several real DB files per test and runs
// `mu doctor --deep` (a full rebuild) over them.
//
// The script is a SIDECAR run via `npx tsx`, and `tsx` is deliberately
// NOT a dependency of this repo — so this drives `runImporter`, the
// script's exported seam, in-process. Same code path the shebang takes;
// `main()` is only the try/catch + process.exitCode shell around it.
//
// The acceptance run that matters was against a COPY of the user's live
// pre-1.0 DB (857 tasks / 1601 edges / 2295 notes / 7430 log rows); see the
// task note on v2-data-escape-hatch. This file pins the CONTRACT so a
// later refactor cannot quietly break it:
//
//   * read-only on the source (byte-identical after the run),
//   * refuses to write in place / over an existing target,
//   * ops, not rows: `mu doctor --deep` reports NO drift,
//   * every task/edge/note field survives,
//   * duplicate notes merge (grow-only note identity) and are REPORTED,
//   * archives restore as live workstreams (ops, not rows); --drop-archives opts out,
//   * v7 archive-only DBs are accepted,
//   * idempotent.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverLegacySubstates, runImporter, UsageError } from "../scripts/migrate.js";
import { openDb } from "../src/db.js";
import { checkDrift } from "../src/drift.js";
import { withOpContext } from "../src/op-context.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

/** The v8 (final pre-1.0) schema, trimmed to the tables the importer reads
 *  or counts. Inlined because src/db.ts no longer knows v8 exists —
 *  that is the whole point of the clean break. */
const V8_SCHEMA = `
CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
CREATE TABLE machine_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1), machine_id TEXT NOT NULL,
  hostname TEXT, created_at TEXT NOT NULL);
CREATE TABLE workstreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workstream_sync (
  workstream_id INTEGER PRIMARY KEY REFERENCES workstreams (id) ON DELETE CASCADE,
  last_known_peer_seqs TEXT NOT NULL DEFAULT '{}');
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  name TEXT NOT NULL, cli TEXT NOT NULL DEFAULT 'pi', pane_id TEXT NOT NULL,
  status TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'full-access', tab TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (workstream_id, name));
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  local_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
  impact INTEGER NOT NULL, effort_days REAL NOT NULL,
  owner_id INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (workstream_id, local_id));
CREATE TABLE task_edges (
  from_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  to_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (from_task_id, to_task_id));
CREATE TABLE task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE agent_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER REFERENCES workstreams (id) ON DELETE CASCADE,
  source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
  payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE vcs_workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  backend TEXT NOT NULL, path TEXT NOT NULL UNIQUE, parent_ref TEXT, created_at TEXT NOT NULL);
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workstream TEXT, label TEXT NOT NULL,
  db_path TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT UNIQUE NOT NULL, description TEXT,
  created_at TEXT NOT NULL, last_added_at TEXT NOT NULL);
CREATE TABLE archived_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  source_workstream TEXT NOT NULL, original_local_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, impact INTEGER NOT NULL, effort_days REAL NOT NULL,
  owner_name TEXT, archived_at_status TEXT NOT NULL, archived_at TEXT NOT NULL,
  original_created_at TEXT NOT NULL, original_updated_at TEXT NOT NULL);
CREATE TABLE archived_edges (
  archive_id INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  from_archived_id INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  to_archived_id INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  PRIMARY KEY (archive_id, from_archived_id, to_archived_id));
CREATE TABLE archived_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  archived_task_id INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  author TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE archived_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  source_workstream TEXT NOT NULL, seq INTEGER NOT NULL, source TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL);
`;

/** v7 is the same portable shape as v8 for the tables this importer reads,
 *  minus machine_identity / workstream_sync (which arrived later). */
const V7_SCHEMA = V8_SCHEMA.replace(
  `CREATE TABLE machine_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1), machine_id TEXT NOT NULL,
  hostname TEXT, created_at TEXT NOT NULL);
`,
  "",
).replace(
  `CREATE TABLE workstream_sync (
  workstream_id INTEGER PRIMARY KEY REFERENCES workstreams (id) ON DELETE CASCADE,
  last_known_peer_seqs TEXT NOT NULL DEFAULT '{}');
`,
  "",
);

const V9_SCHEMA = `
CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
CREATE TABLE machine_identity (id INTEGER PRIMARY KEY CHECK (id = 1), machine_id TEXT NOT NULL, hostname TEXT, created_at TEXT NOT NULL, last_wall INTEGER NOT NULL DEFAULT 0, last_counter INTEGER NOT NULL DEFAULT 0);
CREATE TABLE workstreams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, name TEXT NOT NULL, cli TEXT NOT NULL, pane_id TEXT NOT NULL, status TEXT NOT NULL, role TEXT NOT NULL, tab TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workstream_id, name));
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, local_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, impact INTEGER NOT NULL, effort_days REAL NOT NULL, owner_id INTEGER REFERENCES agents(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workstream_id, local_id));
CREATE TABLE task_edges (from_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, to_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(from_task_id, to_task_id));
CREATE TABLE task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, author TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, hlc TEXT NOT NULL, machine_id TEXT NOT NULL, group_id TEXT NOT NULL, actor TEXT, intent TEXT, entity TEXT NOT NULL, key TEXT NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(machine_id, hlc));
CREATE TABLE sync_peers (machine_id TEXT PRIMARY KEY, last_applied_seq INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT);
CREATE TABLE vcs_workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE, workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, backend TEXT NOT NULL, path TEXT NOT NULL UNIQUE, parent_ref TEXT, created_at TEXT NOT NULL);
`;

/** The released v10 schema (mu 2.0.0, `git show 74bac54:src/db.ts`),
 *  comments stripped. Inlined for the same reason as V9_SCHEMA: src/db.ts
 *  only knows v11. */
const V10_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS machine_identity (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  machine_id   TEXT NOT NULL,
  hostname     TEXT,
  created_at   TEXT NOT NULL,
  last_wall    INTEGER NOT NULL DEFAULT 0,
  last_counter INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workstreams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  cli           TEXT NOT NULL DEFAULT 'pi',
  pane_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'full-access',
  tab           TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, name),
  CHECK (status IN (
    'spawning', 'busy', 'needs_input', 'needs_permission',
    'free', 'unreachable', 'terminated'
  )),
  CHECK (role IN ('full-access', 'read-only'))
);
CREATE INDEX IF NOT EXISTS idx_agents_workstream ON agents (workstream_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  local_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN',
  impact        INTEGER NOT NULL,
  effort_days   REAL NOT NULL,
  owner_id      INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, local_id),
  CHECK (impact BETWEEN 1 AND 100),
  CHECK (effort_days > 0),
  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks (workstream_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks (owner_id);
CREATE TABLE IF NOT EXISTS task_edges (
  from_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  to_task_id   INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (from_task_id, to_task_id),
  CHECK (from_task_id <> to_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_edges_to ON task_edges (to_task_id);
CREATE TABLE IF NOT EXISTS task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes (task_id);
CREATE TABLE IF NOT EXISTS ops (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  hlc        TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  actor      TEXT,
  intent     TEXT,
  entity     TEXT NOT NULL,
  key        TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('put','del')),
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (machine_id, hlc)
);
CREATE INDEX IF NOT EXISTS idx_ops_hlc ON ops (hlc);
CREATE INDEX IF NOT EXISTS idx_ops_entity_key ON ops (entity, key);
CREATE INDEX IF NOT EXISTS idx_ops_group ON ops (group_id);
CREATE TABLE IF NOT EXISTS sync_peers (
  machine_id       TEXT PRIMARY KEY,
  last_applied_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_at     TEXT
);
CREATE TABLE IF NOT EXISTS vcs_workspaces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  backend       TEXT NOT NULL CHECK (backend IN ('jj', 'sl', 'git', 'none')),
  path          TEXT NOT NULL UNIQUE,
  parent_ref    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vcs_workspaces_workstream ON vcs_workspaces (workstream_id);
DROP VIEW IF EXISTS ready;
CREATE VIEW ready AS
  SELECT t.*
    FROM tasks t
   WHERE t.status = 'OPEN'
     AND NOT EXISTS (
       SELECT 1
         FROM task_edges e
         JOIN tasks      b ON e.from_task_id = b.id
        WHERE e.to_task_id = t.id
          AND b.status <> 'CLOSED'
     );
DROP VIEW IF EXISTS blocked;
CREATE VIEW blocked AS
  SELECT t.*
    FROM tasks t
   WHERE t.status = 'OPEN'
     AND EXISTS (
       SELECT 1
         FROM task_edges e
         JOIN tasks      b ON e.from_task_id = b.id
        WHERE e.to_task_id = t.id
          AND b.status <> 'CLOSED'
     );
DROP VIEW IF EXISTS goals;
CREATE VIEW goals AS
  SELECT t.*
    FROM tasks t
   WHERE t.status <> 'CLOSED'
     AND NOT EXISTS (
       SELECT 1 FROM task_edges WHERE from_task_id = t.id
     );

`;

const T = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

interface Fixture {
  path: string;
  sha: string;
}

/** A small but SHAPE-COMPLETE v8 DB: two workstreams, a blocked-by
 *  edge, notes including a byte-identical duplicate pair, an owned
 *  task, an agent + its workspace + a snapshot row (all of which must
 *  be reported as NOT carried), and log rows. */
function makeV8Db(path: string, opts: { archives?: boolean } = {}): Fixture {
  const db = new Database(path);
  db.exec(V8_SCHEMA);
  db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 8)").run();
  db.prepare(
    "INSERT INTO machine_identity (id, machine_id, hostname, created_at) VALUES (1, 'old-machine', 'box', ?)",
  ).run(T(0));

  db.prepare("INSERT INTO workstreams (id, name, created_at) VALUES (1, 'demo', ?)").run(T(0));
  db.prepare("INSERT INTO workstreams (id, name, created_at) VALUES (2, 'other', ?)").run(T(1));
  db.prepare(
    `INSERT INTO agents (id, workstream_id, name, cli, pane_id, status, created_at, updated_at)
     VALUES (1, 1, 'worker-1', 'pi', '%17', 'free', ?, ?)`,
  ).run(T(2), T(2));
  db.prepare(
    `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, created_at)
     VALUES (1, 1, 'git', '/tmp/ws-worker-1', ?)`,
  ).run(T(2));
  db.prepare(
    `INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at)
     VALUES ('demo', 'pre-refactor', '/tmp/snap.db', 8, ?)`,
  ).run(T(2));

  const task = db.prepare(
    `INSERT INTO tasks (id, workstream_id, local_id, title, status, impact, effort_days,
                        owner_id, created_at, updated_at)
     VALUES (@id, @ws, @localId, @title, @status, @impact, @effort, @owner, @created, @updated)`,
  );
  task.run({
    id: 1,
    ws: 1,
    localId: "alpha",
    title: "Alpha task",
    status: "REJECTED",
    impact: 80,
    effort: 1.5,
    owner: null,
    created: T(3),
    updated: T(20),
  });
  task.run({
    id: 2,
    ws: 1,
    localId: "beta",
    title: "Beta task",
    status: "IN_PROGRESS",
    impact: 45,
    effort: 0.5,
    // Owned: ownership must NOT come across (owner_id FKs into agents).
    owner: 1,
    created: T(4),
    updated: T(21),
  });
  task.run({
    id: 3,
    ws: 2,
    localId: "alpha",
    title: "Same local id, other workstream",
    status: "OPEN",
    impact: 10,
    effort: 3,
    owner: null,
    created: T(5),
    updated: T(5),
  });

  db.prepare("INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (1, 2, ?)").run(
    T(6),
  );

  const note = db.prepare(
    "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
  );
  note.run(1, "worker-1", "first note", T(7));
  note.run(1, null, "anonymous note", T(8));
  // Same author and text, written at different times: two notes, as
  // they were in the source. (Before 3.1.1 the grow-only identity was
  // (task, author, content) and collapsed them to one row.)
  note.run(2, "worker-1", "dup", T(9));
  note.run(2, "worker-1", "dup", T(10));

  const log = db.prepare(
    "INSERT INTO agent_logs (workstream_id, source, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  log.run(1, "system", "event", "task add alpha (impact=80, effort=1.5)", T(11));
  log.run(null, "system", "event", "workstream teardown gone", T(12));

  if (opts.archives === true) {
    seedArchive(db, {
      label: "v0-3",
      workstream: "oldws",
      at: T(13),
      // Deliberately distinct from live demo/alpha so restore can coexist.
      localId: "archived_alpha",
      title: "Archived alpha",
      status: "DEFERRED",
      note: "from archive",
      event: "archive add v0-3 -w oldws",
    });
  }
  db.close();
  return { path, sha: sha256(path) };
}

/** Populate one archive with a single task + note + event (+ optional edge). */
function seedArchive(
  db: Database.Database,
  opts: {
    label: string;
    workstream: string;
    at: string;
    localId: string;
    title: string;
    status: string;
    note: string;
    event: string;
    edgeToLocalId?: string;
  },
): void {
  const archiveId = Number(
    db
      .prepare(
        "INSERT INTO archives (label, description, created_at, last_added_at) VALUES (?, null, ?, ?)",
      )
      .run(opts.label, opts.at, opts.at).lastInsertRowid,
  );
  const taskId = Number(
    db
      .prepare(
        `INSERT INTO archived_tasks (
           archive_id, source_workstream, original_local_id, title, status,
           impact, effort_days, owner_name, archived_at_status, archived_at,
           original_created_at, original_updated_at)
         VALUES (?, ?, ?, ?, ?, 40, 1, null, ?, ?, ?, ?)`,
      )
      .run(
        archiveId,
        opts.workstream,
        opts.localId,
        opts.title,
        opts.status,
        opts.status,
        opts.at,
        opts.at,
        opts.at,
      ).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO archived_notes (archive_id, archived_task_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(archiveId, taskId, "archiver", opts.note, opts.at);
  db.prepare(
    `INSERT INTO archived_events (archive_id, source_workstream, seq, source, payload, created_at)
     VALUES (?, ?, 1, 'system', ?, ?)`,
  ).run(archiveId, opts.workstream, opts.event, opts.at);
  if (opts.edgeToLocalId !== undefined) {
    const toId = Number(
      db
        .prepare(
          `INSERT INTO archived_tasks (
             archive_id, source_workstream, original_local_id, title, status,
             impact, effort_days, owner_name, archived_at_status, archived_at,
             original_created_at, original_updated_at)
           VALUES (?, ?, ?, ?, 'CLOSED', 30, 1, null, 'CLOSED', ?, ?, ?)`,
        )
        .run(
          archiveId,
          opts.workstream,
          opts.edgeToLocalId,
          `${opts.edgeToLocalId} title`,
          opts.at,
          opts.at,
          opts.at,
        ).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO archived_edges (archive_id, from_archived_id, to_archived_id) VALUES (?, ?, ?)",
    ).run(archiveId, taskId, toId);
  }
}

/** Archive-only v7 DB — the common upgrade case where live tables were
 *  emptied by `workstream destroy` and the real history sits in archives. */
function makeV7ArchiveDb(path: string): Fixture {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(V7_SCHEMA);
  db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 7)").run();
  seedArchive(db, {
    label: "feedback",
    workstream: "review",
    at: T(20),
    localId: "finding_1",
    title: "Finding one",
    status: "CLOSED",
    note: "fixed",
    event: "workstream init review",
    edgeToLocalId: "finding_2",
  });
  db.close();
  return { path, sha: sha256(path) };
}

function makeV9Db(path: string): Fixture {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(V9_SCHEMA);
  db.prepare("INSERT INTO schema_version VALUES (1, 9)").run();
  db.prepare(
    "INSERT INTO machine_identity VALUES (1, 'v9-machine', 'box', ?, 2000000000000, 7)",
  ).run(T(0));
  db.prepare("INSERT INTO workstreams VALUES (1, 'demo', ?)").run(T(0));
  db.prepare(
    "INSERT INTO agents VALUES (1, 1, 'worker-1', 'pi', '%17', 'free', 'full-access', NULL, ?, ?)",
  ).run(T(1), T(1));
  const task = db.prepare("INSERT INTO tasks VALUES (?, 1, ?, ?, ?, 50, 1, ?, ?, ?)");
  task.run(1, "rejected", "Rejected task", "REJECTED", 1, T(2), T(4));
  task.run(2, "deferred", "Deferred task", "DEFERRED", null, T(3), T(5));
  db.prepare("INSERT INTO task_edges VALUES (1, 2, ?)").run(T(6));
  db.prepare("INSERT INTO task_notes VALUES (1, 1, 'worker-1', 'existing note', ?)").run(T(7));
  db.prepare("INSERT INTO sync_peers VALUES ('peer-machine', 12, ?)").run(T(8));
  db.prepare(
    "INSERT INTO vcs_workspaces VALUES (1, 1, 1, 'git', '/tmp/ws-worker-1', 'main', ?)",
  ).run(T(9));

  const op = db.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (?, 'v9-machine', ?, 'worker-1', ?, ?, ?, 'put', ?, ?)`,
  );
  const rows = [
    [
      "0001767225600000.000000.v9-machine",
      "g1",
      "workstream.init",
      "workstream",
      "demo",
      JSON.stringify({ name: "demo", created_at: T(0) }),
      T(0),
    ],
    [
      "0001767225660000.000000.v9-machine",
      "g2",
      "task.add",
      "task",
      "demo/rejected",
      JSON.stringify({
        local_id: "rejected",
        title: "Rejected task",
        status: "REJECTED",
        impact: 50,
        effort_days: 1,
        created_at: T(2),
        updated_at: T(4),
      }),
      T(2),
    ],
    [
      "0001767225720000.000000.v9-machine",
      "g3",
      "task.add",
      "task",
      "demo/deferred",
      JSON.stringify({
        local_id: "deferred",
        title: "Deferred task",
        status: "DEFERRED",
        impact: 50,
        effort_days: 1,
        created_at: T(3),
        updated_at: T(5),
      }),
      T(3),
    ],
    [
      "0001767225780000.000000.v9-machine",
      "g4",
      "task.block",
      "edge",
      "demo/rejected->demo/deferred",
      JSON.stringify({ created_at: T(6) }),
      T(6),
    ],
    [
      "0001767225840000.000000.v9-machine",
      "g5",
      "task.note",
      "note",
      "demo/rejected#1",
      JSON.stringify({ author: "worker-1", content: "existing note", created_at: T(7) }),
      T(7),
    ],
    // Real v9 databases can contain historical tombstones while their
    // live projection has since been restored outside the retained op
    // set. Migration must preserve both the history and current rows.
  ] as const;
  for (const row of rows) op.run(...row);
  // Real v9 databases can contain historical tombstones while their
  // live projection has since been restored outside the retained op
  // set. Migration must preserve both the history and current rows.
  db.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES ('0001767225900000.000000.v9-machine', 'v9-machine', 'g6', 'worker-1',
             'workstream.destroy', 'workstream', 'demo', 'del', '{}', ?)`,
  ).run(T(8));
  db.close();
  return { path, sha: sha256(path) };
}

/** HLC for a v10 fixture op minted at T(minutes). */
const H = (minutes: number, counter = 0): string =>
  `${String(Date.parse(T(minutes))).padStart(16, "0")}.${String(counter).padStart(6, "0")}.v10-machine`;

/** A v10 DB shaped like a real one: legacy REJECTED/DEFERRED statuses
 *  survive only in the ops log, and the projected rows hold OPEN, which
 *  is what v10's apply path folded them to.
 *
 *    demo/d  legacy DEFERRED op, nothing newer
 *    demo/r  legacy REJECTED op; demo/b is blocked by it
 *    demo/o  legacy DEFERRED, then a later task.open  -> a decision
 *    demo/n  no legacy op; migrate.* OPEN put + MIGRATION: note
 *    demo/u  legacy DEFERRED, deleted, then restored by a v10 undo (OPEN)
 *    gone/t  legacy DEFERRED, deleted + undone (OPEN), then torn down
 *            with its workstream under group 'g-teardown' */
function makeV10Db(path: string): Fixture {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(V10_SCHEMA);
  db.prepare("INSERT INTO schema_version VALUES (1, 10)").run();
  db.prepare("INSERT INTO machine_identity VALUES (1, 'v10-machine', 'box', ?, 0, 0)").run(T(0));

  const op = db.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (@hlc, 'v10-machine', @group, 'worker-1', @intent, @entity, @key, @op, @payload, @created)`,
  );
  let n = 0;
  let seq = 0;
  const put = (
    minute: number,
    intent: string,
    entity: string,
    key: string,
    payload: Record<string, unknown>,
    group = `g${++n}`,
  ): void => {
    op.run({
      hlc: H(minute, ++seq),
      group,
      intent,
      entity,
      key,
      op: "put",
      payload: JSON.stringify(payload),
      created: T(minute),
    });
  };
  const del = (minute: number, intent: string, entity: string, key: string, group = `g${++n}`) => {
    op.run({
      hlc: H(minute, ++seq),
      group,
      intent,
      entity,
      key,
      op: "del",
      payload: "{}",
      created: T(minute),
    });
  };
  const task = (localId: string, status: string, minute: number) => ({
    local_id: localId,
    title: `Task ${localId}`,
    status,
    impact: 50,
    effort_days: 1,
    created_at: T(minute),
    updated_at: T(minute),
  });

  put(0, "workstream.init", "workstream", "demo", { name: "demo", created_at: T(0) });
  put(0, "workstream.init", "workstream", "gone", { name: "gone", created_at: T(0) });
  put(1, "migrate.v9-projection", "task", "demo/d", task("d", "DEFERRED", 1));
  put(1, "migrate.v9-projection", "task", "demo/r", task("r", "REJECTED", 1));
  put(1, "task.add", "task", "demo/b", task("b", "OPEN", 1));
  put(2, "task.block", "edge", "demo/r->demo/b", { created_at: T(2) });
  put(1, "migrate.v9-projection", "task", "demo/o", task("o", "DEFERRED", 1));
  put(5, "task.open", "task", "demo/o", { status: "OPEN", updated_at: T(5) });
  put(1, "migrate.v9-projection", "task", "demo/n", task("n", "OPEN", 1));
  put(2, "migrate.status", "note", "demo/n#migration-deferred", {
    author: "migration",
    content: "MIGRATION: previous status was DEFERRED",
    created_at: T(2),
  });
  put(1, "migrate.v9-projection", "task", "demo/u", task("u", "DEFERRED", 1));
  del(3, "task.delete", "task", "demo/u");
  put(4, "undo", "task", "demo/u", task("u", "OPEN", 1));
  put(1, "migrate.v9-projection", "task", "gone/t", task("t", "DEFERRED", 1));
  del(3, "task.delete", "task", "gone/t");
  put(4, "undo", "task", "gone/t", task("t", "OPEN", 1));
  del(6, "workstream.teardown", "task", "gone/t", "g-teardown");
  del(6, "workstream.teardown", "workstream", "gone", "g-teardown");

  // The v10 projection: every legacy status folded to OPEN; gone/ absent.
  db.prepare("INSERT INTO workstreams VALUES (1, 'demo', ?)").run(T(0));
  const row = db.prepare("INSERT INTO tasks VALUES (?, 1, ?, ?, 'OPEN', 50, 1, NULL, ?, ?)");
  const ids: Record<string, number> = {};
  for (const [i, id] of ["d", "r", "b", "o", "n", "u"].entries()) {
    ids[id] = i + 1;
    row.run(i + 1, id, `Task ${id}`, T(1), id === "o" ? T(5) : T(1));
  }
  db.prepare("INSERT INTO task_edges VALUES (?, ?, ?)").run(ids.r, ids.b, T(2));
  db.prepare("INSERT INTO task_notes VALUES (1, ?, 'migration', ?, ?)").run(
    ids.n,
    "MIGRATION: previous status was DEFERRED",
    T(2),
  );
  db.close();
  return { path, sha: sha256(path) };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface Run {
  stdout: string;
  /** The `UsageError` message, or '' when the run succeeded. Mirrors
   *  what `main()` writes to the real stderr. */
  stderr: string;
  /** 0 on success, 2 on a refusal — same mapping `main()` applies. */
  exitCode: number;
}

function runScript(args: readonly string[]): Run {
  const lines: string[] = [];
  try {
    const code = runImporter(args, (text) => lines.push(text));
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: code };
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return { stdout: lines.join("\n"), stderr: err.message, exitCode: 2 };
  }
}

describe("scripts/migrate.ts", () => {
  let dir: string;
  let source: Fixture;
  let out: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-migrate-"));
    source = makeV8Db(join(dir, "old.db"));
    out = join(dir, "new.db");
  });

  afterEach(() => {
    rmFixtureDir(dir);
  });

  it("migrates v9 history, legacy statuses, relationships, and valid machine-local rows", async () => {
    const v9 = makeV9Db(join(dir, "v9.db"));
    const target = join(dir, "v11.db");
    const run = runScript([v9.path, "--out", target]);
    expect(run.exitCode).toBe(0);
    expect(sha256(v9.path)).toBe(v9.sha);

    const sourceDb = new Database(v9.path, { readonly: true });
    const sourceOps = sourceDb
      .prepare(
        "SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at FROM ops ORDER BY seq",
      )
      .all();
    sourceDb.close();

    const db = new Database(target, { readonly: true });
    try {
      expect(
        db.prepare("SELECT local_id, status, substate, owner_id FROM tasks ORDER BY id").all(),
      ).toEqual([
        { local_id: "rejected", status: "CLOSED", substate: "rejected", owner_id: 1 },
        { local_id: "deferred", status: "OPEN", substate: "parked", owner_id: null },
      ]);
      expect(
        db
          .prepare(
            `SELECT t.local_id, n.content FROM task_notes n
             JOIN tasks t ON t.id = n.task_id ORDER BY t.local_id, n.content`,
          )
          .all(),
      ).toEqual([{ local_id: "rejected", content: "existing note" }]);
      // The substate carries the legacy fact; no MIGRATION: note is minted.
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM ops WHERE intent = 'migrate.status'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(1);
      expect(db.prepare("SELECT name, pane_id FROM agents").all()).toEqual([
        { name: "worker-1", pane_id: "%17" },
      ]);
      expect(db.prepare("SELECT path FROM vcs_workspaces").all()).toEqual([
        { path: "/tmp/ws-worker-1" },
      ]);
      expect(
        db
          .prepare("SELECT last_applied_seq FROM sync_peers WHERE machine_id = 'peer-machine'")
          .get(),
      ).toEqual({ last_applied_seq: 12 });
      expect(db.prepare("SELECT machine_id, last_wall FROM machine_identity").get()).toEqual({
        machine_id: "v9-machine",
        last_wall: 2000000000000,
      });
      expect(
        (db.prepare("SELECT last_counter FROM machine_identity").get() as { last_counter: number })
          .last_counter,
      ).toBeGreaterThanOrEqual(7);
      expect(
        db
          .prepare(
            `SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at
               FROM ops WHERE group_id IN ('g1','g2','g3','g4','g5','g6') ORDER BY seq`,
          )
          .all(),
      ).toEqual(sourceOps);
    } finally {
      db.close();
    }

    const doctor = await runCli(["doctor", "--deep", "--json"], target);
    expect(doctor.exitCode).toBeNull();
    expect((JSON.parse(doctor.stdout) as { drift: { ok: boolean } }).drift.ok).toBe(true);
  });

  it("imports every portable row and leaves the source byte-identical", async () => {
    const run = runScript([source.path, "--out", out]);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);

    // THE read-only contract. Not "we did not mean to write" — proof.
    expect(sha256(source.path)).toBe(source.sha);
    expect(run.stdout).toContain("source unchanged YES");

    const db = new Database(out, { readonly: true });
    try {
      const tasks = db
        .prepare(
          `SELECT w.name || '/' || t.local_id AS key, t.title, t.status, t.impact,
                  t.effort_days AS effort, t.created_at, t.updated_at, t.owner_id
             FROM tasks t JOIN workstreams w ON w.id = t.workstream_id ORDER BY key`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(tasks).toEqual([
        {
          key: "demo/alpha",
          title: "Alpha task",
          // Seeded REJECTED: the shared legacy mapping makes it CLOSED/rejected.
          status: "CLOSED",
          impact: 80,
          effort: 1.5,
          created_at: T(3),
          updated_at: T(20),
          owner_id: null,
        },
        {
          key: "demo/beta",
          title: "Beta task",
          status: "IN_PROGRESS",
          impact: 45,
          effort: 0.5,
          created_at: T(4),
          updated_at: T(21),
          // Ownership does NOT come across: owner_id FKs into the
          // machine-local agents table, which is not imported.
          owner_id: null,
        },
        {
          key: "other/alpha",
          title: "Same local id, other workstream",
          status: "OPEN",
          impact: 10,
          effort: 3,
          created_at: T(5),
          updated_at: T(5),
          owner_id: null,
        },
      ]);

      const edges = db
        .prepare(
          `SELECT wf.name || '/' || f.local_id || '->' || wt.name || '/' || t.local_id AS key,
                  e.created_at
             FROM task_edges e
             JOIN tasks f ON f.id = e.from_task_id
             JOIN tasks t ON t.id = e.to_task_id
             JOIN workstreams wf ON wf.id = f.workstream_id
             JOIN workstreams wt ON wt.id = t.workstream_id`,
        )
        .all();
      expect(edges).toEqual([{ key: "demo/alpha->demo/beta", created_at: T(6) }]);

      // All 4 source notes, including the repeated text.
      const notes = db
        .prepare("SELECT author, content, created_at FROM task_notes ORDER BY created_at")
        .all();
      expect(notes).toEqual([
        { author: "worker-1", content: "first note", created_at: T(7) },
        { author: null, content: "anonymous note", created_at: T(8) },
        { author: "worker-1", content: "dup", created_at: T(9) },
        { author: "worker-1", content: "dup", created_at: T(10) },
      ]);

      // Machine-local tables stay EMPTY. Resurrecting them would produce
      // rows that lie about reality (pane_id / absolute paths).
      for (const table of ["agents", "vcs_workspaces"]) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("synthesizes OPS, not rows — one group, honest intents, source-ordered HLCs", async () => {
    runScript([source.path, "--out", out]);
    const db = new Database(out, { readonly: true });
    try {
      const groups = db
        .prepare("SELECT DISTINCT group_id AS g FROM ops WHERE intent LIKE 'migrate.v8%'")
        .all();
      expect(groups).toHaveLength(1);

      const intents = db
        .prepare("SELECT intent, COUNT(*) AS n FROM ops GROUP BY intent ORDER BY intent")
        .all();
      // Synthetic imports never pretend to be live edits.
      expect(intents).toEqual([
        // 2 ws + 3 tasks + 1 edge + 4 notes
        { intent: "migrate.v8", n: 10 },
        { intent: "migrate.v8-log", n: 2 },
      ]);

      // Log ops use the log-only 'event' entity, so they never ship to a
      // peer (not in SYNCED_ENTITIES) and are never projected.
      expect(
        db.prepare("SELECT DISTINCT entity AS e FROM ops WHERE intent = 'migrate.v8-log'").all(),
      ).toEqual([{ e: "event" }]);

      // HLC order === source causality: the workstream op precedes its
      // tasks, which precede the edge and notes that reference them.
      const order = (
        db.prepare("SELECT entity, key FROM ops ORDER BY hlc").all() as Array<{
          entity: string;
          key: string;
        }>
      ).map((r) => `${r.entity}:${r.key}`);
      expect(order.indexOf("workstream:demo")).toBeLessThan(order.indexOf("task:demo/alpha"));
      expect(order.indexOf("task:demo/alpha")).toBeLessThan(
        order.indexOf("edge:demo/alpha->demo/beta"),
      );
      expect(order.indexOf("task:demo/alpha")).toBeLessThan(order.indexOf("note:demo/alpha#1"));

      // The HLC wall time is minted FROM the source timestamp, so the
      // log reads like the history actually happened.
      const first = db
        .prepare("SELECT hlc FROM ops WHERE entity = 'workstream' AND key = 'demo'")
        .get() as { hlc: string };
      expect(Number(first.hlc.slice(0, 15))).toBe(Date.parse(T(0)));
    } finally {
      db.close();
    }
  });

  it("produces a DB with NO drift — the ops-not-rows proof", async () => {
    runScript([source.path, "--out", out]);
    const { stdout, exitCode } = await runCli(["doctor", "--deep", "--json"], out);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as {
      drift?: {
        mode: string;
        ok: boolean;
        totalDrift: number;
        rowsCompared: Record<string, number>;
      };
    };
    expect(parsed.drift?.mode).toBe("deep");
    expect(parsed.drift?.ok).toBe(true);
    expect(parsed.drift?.totalDrift).toBe(0);
    // A clean report on an empty DB proves nothing; assert it compared
    // the rows the import claimed to write.
    expect(parsed.drift?.rowsCompared).toEqual({
      workstreams: 2,
      tasks: 3,
      task_notes: 4,
      task_edges: 1,
    });
  });

  it("rebuilds from its own log to the same state", async () => {
    runScript([source.path, "--out", out]);
    const rebuilt = join(dir, "rebuilt.db");
    const r = await runCli(["rebuild", rebuilt], out);
    expect(r.exitCode).toBeNull();

    const sql = `SELECT w.name || '/' || t.local_id AS k, t.title, t.status, t.impact,
                        t.effort_days, t.created_at, t.updated_at
                   FROM tasks t JOIN workstreams w ON w.id = t.workstream_id ORDER BY k`;
    const read = (path: string): unknown => {
      const db = new Database(path, { readonly: true });
      try {
        return db.prepare(sql).all();
      } finally {
        db.close();
      }
    };
    expect(read(rebuilt)).toEqual(read(out));
  });

  it("is idempotent: two runs produce identical portable content", async () => {
    const a = join(dir, "a.db");
    const b = join(dir, "b.db");
    const runA = runScript([source.path, "--out", a]);
    const runB = runScript([source.path, "--out", b]);
    // Same summary table modulo the target path and timing.
    const scrub = (s: string): string =>
      s
        .replace(/\/[^\s]*\/(a|b)\.db/g, "<target>")
        .replace(/elapsed\s+\d+ms/, "elapsed")
        .replace(/machine id\s+\S+/, "machine id");
    expect(scrub(runA.stdout)).toBe(scrub(runB.stdout));

    const content = (path: string): string => {
      const db = new Database(path, { readonly: true });
      try {
        return JSON.stringify([
          db.prepare("SELECT name, created_at FROM workstreams ORDER BY 1").all(),
          db.prepare("SELECT local_id, title, status FROM tasks ORDER BY 1, 2").all(),
          db.prepare("SELECT author, content FROM task_notes ORDER BY 1, 2").all(),
          db.prepare("SELECT entity, key, op, payload, intent FROM ops ORDER BY 1, 2, 4").all(),
        ]);
      } finally {
        db.close();
      }
    };
    expect(content(a)).toBe(content(b));
  });

  it("names everything that did NOT come across, with counts", async () => {
    const { stdout } = runScript([source.path, "--out", out]);
    expect(stdout).toContain("NOT CARRIED ACROSS");
    // Each line carries the count, so "0 rows lost" and "100 rows lost"
    // are distinguishable at a glance.
    expect(stdout).toMatch(/agents\s+1\s/);
    expect(stdout).toMatch(/vcs_workspaces\s+1\s/);
    expect(stdout).toMatch(/snapshots\s+1\s/);
    expect(stdout).toMatch(/task owners\s+1\s/);
    expect(stdout).toContain("duplicate(s) merged");
  });

  it("--drop-logs skips agent_logs and says so", async () => {
    const { stdout } = runScript([source.path, "--out", out, "--drop-logs"]);
    expect(stdout).toContain("DROPPED (--drop-logs)");
    const db = new Database(out, { readonly: true });
    try {
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM ops WHERE intent = 'migrate.v8-log'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("restores pre-1.0 archives as live workstreams (ops, not rows)", async () => {
    const archived = makeV8Db(join(dir, "arch.db"), { archives: true });
    const target = join(dir, "arch-out.db");
    const run = runScript([archived.path, "--out", target]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/archives\s+1\s+RESTORED/);

    const db = new Database(target, { readonly: true });
    try {
      expect(
        (db.prepare("SELECT name FROM workstreams WHERE name = 'oldws'").get() as { name: string })
          .name,
      ).toBe("oldws");
      const task = db
        .prepare(
          `SELECT t.title AS title, t.status AS status, t.substate AS substate
             FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
            WHERE w.name = 'oldws' AND t.local_id = 'archived_alpha'`,
        )
        .get() as { title: string; status: string; substate: string };
      // DEFERRED maps onto OPEN/parked; no MIGRATION note is written.
      expect(task.title).toBe("Archived alpha");
      expect(task).toMatchObject({ status: "OPEN", substate: "parked" });
      expect(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM task_notes n
                 JOIN tasks t ON t.id = n.task_id
                 JOIN workstreams w ON w.id = t.workstream_id
                WHERE w.name = 'oldws' AND n.content LIKE 'MIGRATION:%DEFERRED%'`,
            )
            .get() as { n: number }
        ).n,
      ).toBe(0);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM ops WHERE intent = 'migrate.archive'").get() as {
            n: number;
          }
        ).n,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    const doctor = await runCli(["doctor", "--deep", "--json"], target);
    expect(doctor.exitCode).toBeNull();
    const parsed = JSON.parse(doctor.stdout) as { drift?: { ok: boolean; mode: string } };
    expect(parsed.drift?.mode).toBe("deep");
    expect(parsed.drift?.ok).toBe(true);

    // --drop-archives still opts out of the restore.
    const droppedTarget = join(dir, "arch-dropped.db");
    const forced = runScript([archived.path, "--out", droppedTarget, "--drop-archives"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toMatch(/archives\s+1\s+DROPPED \(--drop-archives\)/);
    const dropped = new Database(droppedTarget, { readonly: true });
    try {
      expect(
        (
          dropped.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name = 'oldws'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      dropped.close();
    }
  });

  it("imports a v7 archive-only DB into a drift-free v10 target", async () => {
    const source = makeV7ArchiveDb(join(dir, "v7.db"));
    const target = join(dir, "v7-out.db");
    const run = runScript([source.path, "--out", target]);
    expect(run.exitCode).toBe(0);
    expect(sha256(source.path)).toBe(source.sha);
    expect(run.stdout).toContain("v7");
    expect(run.stdout).toMatch(/archives\s+1\s+RESTORED/);

    const db = new Database(target, { readonly: true });
    try {
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name = 'review'").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
      expect(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM tasks t
                 JOIN workstreams w ON w.id = t.workstream_id
                WHERE w.name = 'review'`,
            )
            .get() as { n: number }
        ).n,
      ).toBe(2);
      expect((db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(1);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }

    const doctor = await runCli(["doctor", "--deep", "--json"], target);
    expect(doctor.exitCode).toBeNull();
    const parsed = JSON.parse(doctor.stdout) as { drift?: { ok: boolean; mode: string } };
    expect(parsed.drift?.mode).toBe("deep");
    expect(parsed.drift?.ok).toBe(true);
  });

  it("refuses to write in place, over an existing target, or from an unsupported source", async () => {
    const inPlace = runScript([source.path, "--out", source.path]);
    expect(inPlace.exitCode).toBe(2);
    expect(inPlace.stderr).toContain("same path");
    expect(sha256(source.path)).toBe(source.sha);

    runScript([source.path, "--out", out]);
    const clobber = runScript([source.path, "--out", out]);
    expect(clobber.exitCode).toBe(2);
    expect(clobber.stderr).toContain("--force");
    // --force is the explicit opt-in, and it works.
    expect(runScript([source.path, "--out", out, "--force"]).exitCode).toBe(0);

    const unsupported = join(dir, "unsupported.db");
    const db = new Database(unsupported);
    db.exec(
      "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1, 6)",
    );
    db.close();
    const wrongVersion = runScript([unsupported, "--out", join(dir, "nope.db")]);
    expect(wrongVersion.exitCode).toBe(2);
    expect(wrongVersion.stderr).toContain("only understands v7, v8, v9, v10 and v11");
  });

  describe("v10 → v11 with legacy substate recovery", () => {
    let v10: Fixture;
    let target: string;
    let run: Run;

    const pairs = (path: string): Record<string, string> => {
      const db = new Database(path, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT w.name || '/' || t.local_id AS key, t.status || '/' || t.substate AS pair
               FROM tasks t JOIN workstreams w ON w.id = t.workstream_id`,
          )
          .all() as { key: string; pair: string }[];
        return Object.fromEntries(rows.map((r) => [r.key, r.pair]));
      } finally {
        db.close();
      }
    };
    const recoveryOps = (path: string): string[] => {
      const db = new Database(path, { readonly: true });
      try {
        return (
          db
            .prepare("SELECT key FROM ops WHERE intent = 'migrate.substate' ORDER BY key")
            .all() as { key: string }[]
        ).map((r) => r.key);
      } finally {
        db.close();
      }
    };

    beforeEach(() => {
      v10 = makeV10Db(join(dir, "v10.db"));
      target = join(dir, "v10-out.db");
      run = runScript([v10.path, "--out", target]);
    });

    it("maps legacy ops, keeps later decisions, and recovers past undo and notes", () => {
      expect(run.stderr).toBe("");
      expect(run.exitCode).toBe(0);
      expect(pairs(target)).toEqual({
        "demo/d": "OPEN/parked", // legacy op is the newest writer: the replay maps it
        "demo/r": "CLOSED/rejected",
        "demo/b": "OPEN/todo",
        "demo/o": "OPEN/todo", // a later task.open is a decision and wins
        "demo/n": "OPEN/parked", // recovered from the MIGRATION: note
        "demo/u": "OPEN/parked", // the undo restore is not a decision
      });
      // Captured recovery ops only where the replay could not derive it.
      expect(recoveryOps(target)).toEqual(["demo/n", "demo/u"]);
      expect(run.stdout).toMatch(/demo\s+d\s+OPEN -> OPEN\/parked\s+\(replay\)/);
      expect(run.stdout).toMatch(/demo\s+r\s+OPEN -> CLOSED\/rejected\s+\(replay\)/);
      expect(run.stdout).toMatch(/demo\s+n\s+OPEN -> OPEN\/parked\s+\(note\)/);
      expect(run.stdout).toMatch(/demo\s+u\s+OPEN -> OPEN\/parked\s+\(ops\)/);
      expect(run.stdout).toMatch(/unblocked by recovery:\n\s+demo\/b/);
    });

    it("leaves the source byte-identical and the target drift-free", async () => {
      expect(sha256(v10.path)).toBe(v10.sha);
      expect(run.stdout).toContain("source unchanged YES");
      const db = openDb({ path: target });
      try {
        const report = checkDrift(db);
        expect(report.records).toEqual([]);
        expect(report.clean).toBe(true);
      } finally {
        db.close();
      }
    });

    it("--recover restores a legacy pair after an undo-restore, then finds nothing", async () => {
      const undo = await runCli(["undo", "g-teardown", "--yes"], target);
      expect(undo.exitCode).toBeNull();
      expect(pairs(target)["gone/t"]).toBe("OPEN/todo");

      const first = runScript(["--recover", target]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toMatch(/gone\s+t\s+OPEN -> OPEN\/parked\s+\(ops\)/);
      expect(pairs(target)["gone/t"]).toBe("OPEN/parked");

      const second = runScript(["--recover", target]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("LEGACY SUBSTATE RECOVERY  0 task(s)");

      const db = openDb({ path: target });
      try {
        expect(checkDrift(db).clean).toBe(true);
      } finally {
        db.close();
      }
    });

    it("--recover refuses a non-v11 DB and -w scopes it", () => {
      const refused = runScript(["--recover", v10.path]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain("needs a v11 DB");
      expect(sha256(v10.path)).toBe(v10.sha);
      const scoped = runScript(["--recover", target, "-w", "nope"]);
      expect(scoped.exitCode).toBe(0);
      expect(scoped.stdout).toContain("0 task(s)");
    });

    it("v11 -> v11: re-maps a legacy REJECTED projected as wontfix, keeps a chosen wontfix", async () => {
      // A mu 3.0.0 DB: legacy REJECTED ops projected as CLOSED/wontfix
      // (the old mapping), next to a deliberate `close --as wontfix`.
      // Simulate the 3.0.0 projection by writing the old pair directly.
      const v11 = join(dir, "v11.db");
      runScript([v10.path, "--out", v11]);
      const db = openDb({ path: v11 });
      try {
        const set = db.prepare(
          `UPDATE tasks SET substate = 'wontfix'
            WHERE local_id = 'r' AND workstream_id = (SELECT id FROM workstreams WHERE name = 'demo')`,
        );
        withOpContext(db, { intent: "undo", group: "g-v300-undo" }, () => set.run());
        const { closeTask } = await import("../src/tasks.js");
        closeTask(db, "b", { workstream: "demo", as: "wontfix", why: "chosen" });
      } finally {
        db.close();
      }
      expect(pairs(v11)["demo/r"]).toBe("CLOSED/wontfix");

      // --recover in place re-maps only the legacy one.
      const copy = join(dir, "v11-copy.db");
      runScript([v11, "--out", copy]);
      const rec = runScript(["--recover", v11]);
      expect(rec.exitCode).toBe(0);
      expect(rec.stdout).toMatch(/demo\s+r\s+CLOSED\/wontfix -> CLOSED\/rejected\s+\(ops\)/);
      expect(pairs(v11)["demo/r"]).toBe("CLOSED/rejected");
      expect(pairs(v11)["demo/b"]).toBe("CLOSED/wontfix");
      expect(runScript(["--recover", v11]).stdout).toContain("0 task(s)");

      // Migrating a v11 source writes a fresh v11 with the same result.
      expect(pairs(copy)["demo/r"]).toBe("CLOSED/rejected");
      expect(pairs(copy)["demo/b"]).toBe("CLOSED/wontfix");
      const after = openDb({ path: copy });
      try {
        expect(checkDrift(after).clean).toBe(true);
      } finally {
        after.close();
      }
    });

    it("recoverLegacySubstates is idempotent on the migrated target", () => {
      const db = openDb({ path: target });
      try {
        expect(recoverLegacySubstates(db)).toEqual([]);
      } finally {
        db.close();
      }
    });
  });
});
