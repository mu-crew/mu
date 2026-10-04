// Teardown must reap its agents' control socket files. The FK cascade
// deletes agent rows without going through deleteAgent, so before this
// the ssh -L forward sockets and <state>/sock/<ws>/ outlived the
// workstream. Hashed long-path sockets share sock/h/ across workstreams,
// so a workstream literally named "h" must only remove its own files.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { teardownWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const LONG = "a".repeat(100);

describe("teardownWorkstream control sockets", () => {
  let dir: string;
  let dbPath: string;
  let db: Db;
  let mux: MuxHarness;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-teardown-sock-"));
    dbPath = join(dir, "mu.db");
    db = openDb({ path: dbPath });
    mux = installMux("tmux", [
      ["has-session", { stdout: "", exitCode: 1, stderr: "can't find session" }],
    ]);
  });

  afterEach(() => {
    mux.restore();
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(dir);
  });

  const touchSock = (ws: string, agent: string): string => {
    insertAgent(db, { name: agent, workstream: ws, paneId: `%${agent.length}` });
    const p = ctlSocketPath(ws, agent, dir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "");
    return p;
  };

  it("removes short-path and hashed long-path sockets, then the empty sock/<ws>/ dir", async () => {
    const short = touchSock("ws", "w1");
    const long = touchSock("ws", LONG);
    expect(long).toContain(join("sock", "h"));

    await teardownWorkstream(db, { workstream: "ws" });

    expect(existsSync(short)).toBe(false);
    expect(existsSync(long)).toBe(false);
    expect(existsSync(join(dir, "sock", "ws"))).toBe(false);
  });

  it("unlinks sockets before the cascade DELETE, while agent rows still exist", async () => {
    const short = touchSock("ws", "w1");
    const long = touchSock("ws", LONG);
    // Interrupt teardown at the DELETE. Sockets must already be gone:
    // if the unlink came after the DELETE, an interruption there would
    // leave files with no agent rows for a retry to find them by.
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("DELETE FROM workstreams")) throw new Error("interrupted");
      return realPrepare(sql);
    });

    await expect(teardownWorkstream(db, { workstream: "ws" })).rejects.toThrow("interrupted");
    spy.mockRestore();

    expect(existsSync(short)).toBe(false);
    expect(existsSync(long)).toBe(false);
    const rows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE w.name = ?",
      )
      .get("ws") as { n: number };
    expect(rows.n).toBe(2);
  });

  it('tearing down workstream "h" leaves other workstreams\' hashed sockets in sock/h/', async () => {
    const other = touchSock("other", LONG);
    const own = touchSock("h", "w1");
    expect(dirname(own)).toBe(dirname(other));

    await teardownWorkstream(db, { workstream: "h" });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("dry run (no --yes) removes nothing", async () => {
    const short = touchSock("ws", "w1");
    const long = touchSock("ws", LONG);

    const r = await runCli(["workstream", "teardown", "ws"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("dry-run");

    expect(existsSync(short)).toBe(true);
    expect(existsSync(long)).toBe(true);
  });
});
