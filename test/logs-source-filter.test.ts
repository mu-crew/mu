// `mu log --source` filters on what the listing shows: ops captured with
// no actor (CLI edits by a non-agent, `mu sql` writes) render as
// "system", so `--source system` must match them too.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendLog, listLogs } from "../src/logs.js";
import { ensureWorkstream } from "../src/workstream.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-log-source-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "demo");
  appendLog(db, { workstream: "demo", source: "worker-1", kind: "message", payload: "hi" });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("listLogs source filter", () => {
  it("--source system matches NULL-actor ops shown as system", () => {
    const nullActor = db.prepare("SELECT COUNT(*) AS n FROM ops WHERE actor IS NULL").get() as {
      n: number;
    };
    expect(nullActor.n).toBeGreaterThan(0);
    const rows = listLogs(db, { workstream: "demo", source: "system" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === "system")).toBe(true);
  });

  it("any other source matches the actor exactly", () => {
    const rows = listLogs(db, { workstream: "demo", source: "worker-1" });
    expect(rows.map((r) => r.payload)).toEqual(["hi"]);
  });
});
