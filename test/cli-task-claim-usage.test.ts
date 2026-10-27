// A claim with no claimer is a usage mistake (exit 2, one line naming the fix), not a generic
// exit 1 with an SDK function name in it (rr_r4_claim_no_agent_plain_error).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("mu task claim with no claimer", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-claim-usage-"));
    dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "ws");
    addTask(db, { localId: "t1", workstream: "ws", title: "t", impact: 10, effortDays: 1 });
    db.close();
  });
  afterEach(() => rmFixtureDir(dir));

  it("is a one-line usage error (exit 2) naming --for, --self and the spawned pane", async () => {
    const r = await runCli(["task", "claim", "t1", "-w", "ws"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no claimer: pass --for <worker>.*--self.*mu-spawned pane/);
    expect(r.stderr).not.toMatch(/claimTask|opts\./);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  });

  it("--self with --for drops the SDK name too", async () => {
    const r = await runCli(["task", "claim", "t1", "-w", "ws", "--self", "--for", "w1"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--self and --for are mutually exclusive/);
    expect(r.stderr).not.toMatch(/claimTask/);
  });
});
