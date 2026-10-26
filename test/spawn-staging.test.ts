// deadStagings: which placeholder rows count as a dead --worktree spawn.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deadStagings } from "../src/agents/staging.js";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { registerWorktree } from "../src/worktree.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-staging-"));
  db = openDb({ path: join(dir, "mu.db") });
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const age = (name: string, iso: string) =>
  db.prepare("UPDATE agents SET updated_at = ? WHERE name = ?").run(iso, name);

describe("deadStagings", () => {
  it("lists only local placeholders past the window, measured from the latest of row and registration", () => {
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    const old = "2026-01-01T00:00:00.000Z";
    insertAgent(db, { name: "dead", workstream: "w", paneId: "%pending-dead", cwd: "/x/dead" });
    insertAgent(db, { name: "fresh", workstream: "w", paneId: "%pending-fresh", cwd: "/x/fresh" });
    insertAgent(db, { name: "slow", workstream: "w", paneId: "%pending-slow", cwd: "/x/slow" });
    insertAgent(db, { name: "remote", workstream: "w", paneId: "%pending-remote", host: "h" });
    insertAgent(db, { name: "live", workstream: "w", paneId: "%7" });
    for (const n of ["dead", "slow", "remote", "live"]) age(n, old);
    age("fresh", "2026-01-01T00:09:30.000Z");
    // A create that finished 20 s ago is still a live staging.
    registerWorktree(db, {
      path: "/x/slow",
      agent: "slow",
      workstream: "w",
      root: "/r",
      base: "b",
      createdAt: "2026-01-01T00:09:40.000Z",
    });
    expect(deadStagings(db, "w", now).map((a) => a.name)).toEqual(["dead"]);
    expect(deadStagings(db, "other", now)).toEqual([]);
  });
});
