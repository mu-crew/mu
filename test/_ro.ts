// Shared test helper: read a mu DB WITHOUT going through the CLI.
//
// `mu sql` (like every other verb) ingests peer segments before it runs
// and flushes after, so using it as a probe changes the thing probed.
// Tests that count ops or compare tables across machines read the file
// directly through a read-only connection instead: no ingest, no flush.

import Database from "better-sqlite3";

export function readRows<T = Record<string, unknown>>(dbPath: string, sql: string): T[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/** `SELECT COUNT(*) FROM ops` without ingesting anything. */
export function opCount(dbPath: string): number {
  return readRows<{ n: number }>(dbPath, "SELECT COUNT(*) AS n FROM ops")[0]?.n ?? 0;
}
