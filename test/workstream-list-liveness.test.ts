// listWorkstreams reads mux liveness from ONE list-sessions call rather
// than a has-session spawn per workstream, and falls back to the
// per-workstream probe when the list itself fails (an empty answer from
// a failed list would mark every session dead).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream, listWorkstreams } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxExecutor, type MuxHarness } from "./_mux.js";

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

  it("uses a single list-sessions call and no has-session", async () => {
    mux = installMux("tmux", [["list-sessions", "mu-alive\nmu-extern\nother\n"]]);
    const rows = await listWorkstreams(db);
    expect(rows.map((r) => [r.name, r.muxAlive])).toEqual([
      ["alive", true],
      ["dead", false],
      ["extern", true],
    ]);
    expect(mux.calls.map((c) => c[0])).toEqual(["list-sessions"]);
  });

  it("falls back to has-session per workstream when list-sessions fails", async () => {
    const exec: MuxExecutor = async (args) => {
      if (args[0] === "list-sessions") return { stdout: "", stderr: "boom", exitCode: 1 };
      if (args[0] === "has-session") {
        const alive = args.join(" ").includes("mu-alive");
        return { stdout: "", stderr: "", exitCode: alive ? 0 : 1 };
      }
      return { stdout: "", stderr: "unrouted", exitCode: 1 };
    };
    mux = installMux("tmux", exec);
    const rows = await listWorkstreams(db);
    expect(rows.map((r) => [r.name, r.muxAlive])).toEqual([
      ["alive", true],
      ["dead", false],
    ]);
    expect(mux.calls.filter((c) => c[0] === "has-session")).toHaveLength(2);
  });
});
