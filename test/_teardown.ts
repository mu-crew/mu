// Test helpers for the two teardown shapes.
//
// `softTeardown`: what `workstream teardown <ws> --if <rev>` does today,
// with the revision read right before (a preview and its apply, no gap).
// `legacyHardTeardown`: the op shape a pre-cut-over build wrote (a
// `workstream` DELETE under intent workstream.teardown, cascading
// tombstones for every row). Old teardowns stay final, so the reader,
// compact/forget and sync paths still have to handle it.

import type { Db } from "../src/db.js";
import { withOpContext } from "../src/op-context.js";
import { type TeardownResult, teardownWorkstream, workstreamRevision } from "../src/workstream.js";

export async function softTeardown(
  db: Db,
  workstream: string,
  opts: { muxSession?: string } = {},
): Promise<TeardownResult> {
  return teardownWorkstream(db, {
    workstream,
    ifRevision: workstreamRevision(db, workstream),
    muxSession: opts.muxSession ?? `mu-${workstream}`,
  });
}

export function legacyHardTeardown(db: Db, workstream: string): void {
  withOpContext(db, { intent: "workstream.teardown", group: "new" }, () =>
    db.prepare("DELETE FROM workstreams WHERE name = ?").run(workstream),
  );
}

/** The `revision` a CLI preview (`teardown <args…> --json`) prints. */
export async function previewRevision(dbPath: string, args: readonly string[]): Promise<number> {
  const { runCliJson } = await import("./_runCli.js");
  const r = await runCliJson<{ revision: number }>(
    ["workstream", "teardown", ...args, "--json"],
    dbPath,
  );
  if (r.error !== undefined) throw r.error;
  return r.data.revision;
}
