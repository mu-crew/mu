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

export interface OpAt extends OpRow {
  ms: number;
  actor: string | null;
  payload: string;
}

/** Every op written at or after `ms` (epoch), whoever wrote it. */
export function opsAfter(sb: Sandbox, ms: number): OpAt[] {
  return withDb(sb, (db) =>
    (
      db
        .prepare(
          "SELECT seq, intent, entity, key, op, actor, payload, created_at AS at FROM ops ORDER BY seq",
        )
        .all() as (OpRow & { actor: string | null; payload: string; at: string })[]
    )
      .map((o) => ({ ...o, ms: Date.parse(o.at) }))
      .filter((o) => o.ms >= ms),
  );
}

/** When a task op handed a task to an owner (a claim, however it was spelled): payload owner_id set. */
export function ownerOpMs(ops: OpAt[]): number[] {
  return ops
    .filter((o) => o.entity === "task" && o.op === "put")
    .filter((o) => {
      try {
        const v = (JSON.parse(o.payload) as { owner_id?: unknown }).owner_id;
        return v !== null && v !== undefined;
      } catch {
        return false;
      }
    })
    .map((o) => o.ms);
}
