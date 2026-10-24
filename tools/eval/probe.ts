// Read-only end-state queries on the sandbox DB. Core columns only, so one probe reads 3.x and
// mu-next DBs alike. Every call opens the DB read-only and closes it again: no lock is held
// between a judge's queries and the AUT's writes.
import Database from "better-sqlite3";
import type { Sandbox } from "./types.ts";

export interface TaskRow {
  id: string;
  status: string;
  substate: string;
  owner: string | null;
}

export interface Probe {
  task(ws: string, id: string): Omit<TaskRow, "id"> | null;
  tasks(ws: string): TaskRow[];
  notes(ws: string, id: string): string[];
  /** [blocker, blocked] pairs. */
  edges(ws: string): [string, string][];
  agents(ws: string): string[];
  /** agent name -> its tmux pane id (agents.pane_id). */
  agentPanes(ws: string): Map<string, string>;
  workstreams(): string[];
  opsCount(where: { entity?: string; op?: "put" | "del"; intentLike?: string }): number;
  close(): void;
}

export function openProbe(sb: Sandbox): Probe {
  const withDb = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma("busy_timeout = 5000");
      return fn(db);
    } finally {
      db.close();
    }
  };
  const tasks = (ws: string): TaskRow[] =>
    withDb(
      (db) =>
        db
          .prepare(
            `SELECT t.local_id AS id, t.status AS status, t.substate AS substate, a.name AS owner
               FROM tasks t
               JOIN workstreams w ON w.id = t.workstream_id
               LEFT JOIN agents a ON a.id = t.owner_id
              WHERE w.name = ? ORDER BY t.local_id`,
          )
          .all(ws) as TaskRow[],
    );
  return {
    task(ws, id) {
      const row = tasks(ws).find((t) => t.id === id);
      return row ? { status: row.status, substate: row.substate, owner: row.owner } : null;
    },
    tasks,
    notes(ws, id) {
      return withDb((db) =>
        (
          db
            .prepare(
              `SELECT n.content AS content
                 FROM task_notes n
                 JOIN tasks t ON t.id = n.task_id
                 JOIN workstreams w ON w.id = t.workstream_id
                WHERE w.name = ? AND t.local_id = ? ORDER BY n.id`,
            )
            .all(ws, id) as { content: string }[]
        ).map((r) => r.content),
      );
    },
    edges(ws) {
      return withDb((db) =>
        (
          db
            .prepare(
              `SELECT f.local_id AS blocker, t.local_id AS blocked
                 FROM task_edges e
                 JOIN tasks f ON f.id = e.from_task_id
                 JOIN tasks t ON t.id = e.to_task_id
                 JOIN workstreams w ON w.id = f.workstream_id
                WHERE w.name = ? ORDER BY f.local_id, t.local_id`,
            )
            .all(ws) as { blocker: string; blocked: string }[]
        ).map((r): [string, string] => [r.blocker, r.blocked]),
      );
    },
    agents(ws) {
      return withDb((db) =>
        (
          db
            .prepare(
              `SELECT a.name AS name FROM agents a
                 JOIN workstreams w ON w.id = a.workstream_id
                WHERE w.name = ? ORDER BY a.name`,
            )
            .all(ws) as { name: string }[]
        ).map((r) => r.name),
      );
    },
    agentPanes(ws) {
      return withDb(
        (db) =>
          new Map(
            (
              db
                .prepare(
                  `SELECT a.name AS name, a.pane_id AS pane FROM agents a
                     JOIN workstreams w ON w.id = a.workstream_id WHERE w.name = ?`,
                )
                .all(ws) as { name: string; pane: string }[]
            ).map((r): [string, string] => [r.name, r.pane]),
          ),
      );
    },
    workstreams() {
      return withDb((db) =>
        (db.prepare("SELECT name FROM workstreams ORDER BY name").all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );
    },
    opsCount(where) {
      const conds: string[] = [];
      const args: string[] = [];
      if (where.entity !== undefined) {
        conds.push("entity = ?");
        args.push(where.entity);
      }
      if (where.op !== undefined) {
        conds.push("op = ?");
        args.push(where.op);
      }
      if (where.intentLike !== undefined) {
        conds.push("intent LIKE ?");
        args.push(where.intentLike);
      }
      const sql = `SELECT COUNT(*) AS n FROM ops${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`;
      return withDb((db) => (db.prepare(sql).get(...args) as { n: number }).n);
    },
    close() {},
  };
}
