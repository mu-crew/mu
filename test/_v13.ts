// A mu 4 (v13) file converted the way the state import converts its copy
// (spec D5 steps 5.2 and 5.3, src/state-import.ts) minus the copy, the new
// machine_id and the refusals: for tests whose fixtures are v13 files, now
// that openDb refuses one.

import Database from "better-sqlite3";
import { upgradeSchema } from "../src/db.js";
import { step13To14 } from "../src/state-import.js";

/** Convert the v13 file at `path` in place to the current schema. */
export function convertV13(path: string): string {
  const r = new Database(path);
  try {
    r.pragma("foreign_keys = ON");
    upgradeSchema(r, { v13: true });
    r.transaction(() => step13To14(r)).immediate();
  } finally {
    r.close();
  }
  return path;
}
