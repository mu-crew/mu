// "A close needs its reason" is ONE guard on three paths (CLI done w/o evidence, CLI --as w/o
// --why, mu sql --write). They share one error class lane and one exit code: 2, a missing flag
// is usage (rr_r4_close_reason_exit_split).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCliJson } from "./_runCli.js";

describe("a close with no reason", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-close-lane-"));
    dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "ws");
    for (const id of ["b1", "x"]) {
      addTask(db, { localId: id, workstream: "ws", title: id, impact: 10, effortDays: 1 });
    }
    db.close();
  });
  afterEach(() => rmFixtureDir(dir));

  it("done without evidence: exit 2, CloseNeedsEvidenceError, one line with the command", async () => {
    const r = await runCliJson(["task", "close", "b1", "-w", "ws", "--json"], dbPath);
    expect(r.doc).toMatchObject({ ok: false, error: "CloseNeedsEvidenceError", exit: 2 });
    expect(r.exitCode).toBe(2);
    expect(r.doc.message).toBe(
      'closing b1 needs evidence: mu task close b1 -w ws --evidence "<command + result>"',
    );
  });

  it("--as rejected without --why: exit 2, SubstateReasonRequiredError", async () => {
    const r = await runCliJson(
      ["task", "close", "x", "--as", "rejected", "-w", "ws", "--json"],
      dbPath,
    );
    expect(r.doc).toMatchObject({ ok: false, error: "SubstateReasonRequiredError", exit: 2 });
    expect(r.exitCode).toBe(2);
  });

  it("mu sql --write closing with no close note: the same lane", async () => {
    const r = await runCliJson(
      ["sql", "--write", "UPDATE tasks SET status='CLOSED', substate='done' WHERE local_id='b1'"],
      dbPath,
    );
    expect(r.doc).toMatchObject({ ok: false, error: "CloseNeedsEvidenceError", exit: 2 });
    expect(r.exitCode).toBe(2);
  });
});
