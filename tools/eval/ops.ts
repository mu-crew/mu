// Ops-log end-state helpers shared by judges. The ops log records every write whoever made it (mu
// verb, `mu sql`, retitle, close+reopen). A judge snapshots maxSeq at the end of setup and asserts
// that the ops added since touch only the task keys the scenario allows.
import Database from "better-sqlite3";
import type { Sandbox } from "./types.ts";

export interface OpRow {
  seq: number;
  intent: string | null;
  entity: string;
  key: string;
  op: string;
}

function withDb<T>(sb: Sandbox, fn: (db: Database.Database) => T): T {
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

export function maxSeq(sb: Sandbox): number {
  return withDb(
    sb,
    (db) => (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM ops").get() as { n: number }).n,
  );
}

export function opsSince(sb: Sandbox, seq: number): OpRow[] {
  return withDb(
    sb,
    (db) =>
      db
        .prepare("SELECT seq, intent, entity, key, op FROM ops WHERE seq > ? ORDER BY seq")
        .all(seq) as OpRow[],
  );
}

/** Task key of an op: "eval/g1" and the note key "eval/g1#2" both give "eval/g1". */
export function opTask(o: OpRow): string {
  return o.key.split("#")[0] ?? o.key;
}

/** Ops since `seq` whose task is not in `allowed` (task keys like "eval/g1"). */
export function strayOps(sb: Sandbox, seq: number, allowed: string[]): string[] {
  return opsSince(sb, seq)
    .filter((o) => !allowed.includes(opTask(o)))
    .map((o) => `${o.intent ?? "?"} ${o.entity} ${o.key}`);
}
