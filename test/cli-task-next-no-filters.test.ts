// `task next` reads the `ready` view (OPEN, not parked/triage, no open blocker), so a --status
// or --substate filter could only ever narrow it to nothing. The flags are gone; `task list
// --status` is the filter (rr_r4_next_status_filter_noop).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliWire } from "./_runCli.js";

describe("mu task next has no --status / --substate", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-next-nofilter-"));
    dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "ws");
    addTask(db, { localId: "a", workstream: "ws", title: "a", impact: 10, effortDays: 1 });
    db.close();
  });
  afterEach(() => rmFixtureDir(dir));

  it.each(["--status", "--substate"])("%s is an unknown option (exit 2)", async (flag) => {
    const r = await runCli(["task", "next", "-w", "ws", flag, "CLOSED"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`unknown option '${flag}'`));
  });

  it("--help no longer advertises values that can never match", async () => {
    const r = await runCliWire(["task", "next", "--help"], dbPath);
    expect(r.stdout).not.toMatch(/--status|--substate/);
  });

  it("the plain verb still lists the ready task", async () => {
    const r = await runCli(["task", "next", "-w", "ws"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("a");
  });
});
