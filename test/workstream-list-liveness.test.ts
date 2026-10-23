// listWorkstreams decorates each DB workstream with mux liveness (panes
// listed in its session) and degrades to "not alive" when the mux fails.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream, listWorkstreams } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";

describe("listWorkstreams liveness", () => {
  let dir: string;
  let db: Db;
  let mux: MuxHarness | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-wslist-live-"));
    db = openDb({ path: join(dir, "mu.db") });
    ensureWorkstream(db, "alive");
    ensureWorkstream(db, "dead");
  });

  afterEach(() => {
    mux?.restore();
    mux = undefined;
    try {
      db.close();
    } catch {}
    rmFixtureDir(dir);
  });

  it("liveness is one list-panes per registered workstream: panes present = alive", async () => {
    mux = installMux("tmux", (args) => {
      const alive = args.join(" ").includes("=mu-alive:");
      return Promise.resolve(
        args[0] === "list-panes" && alive
          ? { stdout: "@1\t%1\t_mu\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "can't find session", exitCode: 1 },
      );
    });
    const rows = await listWorkstreams(db);
    expect(rows.map((r) => [r.name, r.muxAlive])).toEqual([
      ["alive", true],
      ["dead", false],
    ]);
    expect(mux.calls.map((c) => c[0])).toEqual(["list-panes", "list-panes"]);
  });

  it("an unregistered mu-* session is not discovered: the DB owns the list", async () => {
    mux = installMux("tmux", [["list-panes", "@1\t%1\t_mu\n"]]);
    const rows = await listWorkstreams(db);
    expect(rows.map((r) => r.name)).toEqual(["alive", "dead"]);
  });

  it("an unreachable mux degrades to not alive instead of failing the listing", async () => {
    mux = installMux("tmux", () =>
      Promise.resolve({ stdout: "", stderr: "permission denied", exitCode: 1 }),
    );
    const rows = await listWorkstreams(db);
    expect(rows.map((r) => [r.name, r.muxAlive])).toEqual([
      ["alive", false],
      ["dead", false],
    ]);
  });
});
