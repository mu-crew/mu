// Upgrade of a file whose tasks table lacks `finding` (rev 8): the column is
// added AND the task rows are re-folded from their ops, so a triage task a
// peer synced while we were on rev 8 reads finding=1, as `mu rebuild` says.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { rebuildInto } from "../src/rebuild.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-finding-refold-"));
});
afterEach(() => rmFixtureDir(dir));

function findings(path: string): Record<string, number> {
  const r = new Database(path, { readonly: true });
  try {
    const rows = r.prepare("SELECT local_id AS id, finding FROM tasks").all() as {
      id: string;
      finding: number;
    }[];
    return Object.fromEntries(rows.map((x) => [x.id, x.finding]));
  } finally {
    r.close();
  }
}

/** A populated file holding triage + work task ops, with tasks.finding dropped (rev 8). */
function rev8(): string {
  const p = join(dir, "rev8.db");
  const db = openDb({ path: p });
  ensureWorkstream(db, "demo");
  addTask(db, {
    workstream: "demo",
    localId: "f",
    title: "F",
    impact: 50,
    effortDays: 1,
    triage: true,
  });
  addTask(db, { workstream: "demo", localId: "w", title: "W", impact: 50, effortDays: 1 });
  db.close();
  const r = new Database(p);
  try {
    r.pragma("legacy_alter_table = ON");
    for (const t of r.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
      name: string;
    }[])
      r.exec(`DROP TRIGGER "${t.name}"`);
    r.exec("ALTER TABLE tasks DROP COLUMN finding");
    r.exec("UPDATE schema_version SET capture_version = 3");
  } finally {
    r.close();
  }
  return p;
}

describe("tasks.finding upgrade", () => {
  it("refolds task rows from their ops, equal to mu rebuild", () => {
    const p = rev8();
    openDb({ path: p }).close();
    expect(findings(p)).toEqual({ f: 1, w: 0 });
    const src = openDb({ path: p });
    const target = join(dir, "rebuilt.db");
    rebuildInto(src, { targetPath: target });
    src.close();
    expect(findings(target)).toEqual(findings(p));
  });

  it("is idempotent: a second open changes nothing and logs no ops", () => {
    const p = rev8();
    openDb({ path: p }).close();
    const count = () => {
      const r = new Database(p, { readonly: true });
      try {
        return (r.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
      } finally {
        r.close();
      }
    };
    const before = count();
    openDb({ path: p }).close();
    expect(findings(p)).toEqual({ f: 1, w: 0 });
    expect(count()).toBe(before);
  });
});
