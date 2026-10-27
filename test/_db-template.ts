// Template DB for tests: build the v13 schema once per run, copy it per test.
//
// A fresh `openDb` runs the whole DDL plus the capture triggers (~44 ms an
// idle core); 6000 of them were 48% of the fast tier's file time
// (docs/test-health/2026-10-23-surface.md). Copying a checkpointed file and
// opening it takes the cheap "already current" path of `openDb` (~5 ms).
//
// The template is built by the real `openDb` in vitest's globalSetup
// (test/_global-teardown.ts) and handed to every fork with `provide`;
// test/_setup-db.ts installs the interposition. This file must not import
// src/db.js at runtime, because that module is the one being mocked.
//
// No check is weakened: the copy still opens through the real `openDb`,
// which verifies schema, capture stamp and stored triggers (and upgrades a
// stale template). Each copy gets its own `machine_identity`, since sync
// tests compare machine ids. A path under the user's real mu dirs never
// gets a copy: test/_real-dir-guard.ts throws on the copy, and the real
// `openDb` then refuses the path. Files that pin `openDb` on a fresh file
// (db.test.ts, capture-persistent.test.ts) call `vi.unmock("../src/db.js")`.

import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Db, OpenDbOptions } from "../src/db.js";

/** `provide`/`inject` key the template path travels under. */
export const DB_TEMPLATE_KEY = "muDbTemplate";

/**
 * `open` is the real `openDb`. For a new, writable, on-disk path, copy the
 * template there first, open it, and give the copy a fresh machine identity.
 * Anything else (existing file, `:memory:`, readonly, a refused path, a copy
 * that fails) is exactly the real `openDb` call.
 */
export function openDbFromTemplate(
  template: string,
  open: (options?: OpenDbOptions) => Db,
  options: OpenDbOptions = {},
): Db {
  const path = options.path;
  if (path !== undefined && path !== ":memory:" && options.readonly !== true) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(template, path, 1 /* COPYFILE_EXCL: never overwrite */);
    } catch {
      return open(options);
    }
    const db = open(options);
    db.prepare("UPDATE machine_identity SET machine_id = ?, hostname = ?, created_at = ?").run(
      randomUUID(),
      hostname(),
      new Date().toISOString(),
    );
    return db;
  }
  return open(options);
}
