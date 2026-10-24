// A mux probe that FAILS (permission denied, server unreachable) is not
// "the session is dead". Teardown must abort before freeing worktrees,
// unlinking ctl sockets or changing any DB state, and surface the typed mux
// error. Only a probe that answers "no panes" lets teardown proceed.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { MuxError } from "../src/mux.js";
import { addTask } from "../src/tasks.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { softTeardown } from "./_teardown.js";

const DENIED = { stdout: "", stderr: "permission denied", exitCode: 1 };

describe.each(["tmux", "herdr"] as const)("teardownWorkstream probe failure (%s)", (backend) => {
  let dir: string;
  let db: Db;
  let mux: MuxHarness | undefined;
  const prevState = process.env.MU_STATE_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-teardown-probe-"));
    process.env.MU_STATE_DIR = dir;
    db = openDb({ path: join(dir, "mu.db") });
  });

  afterEach(() => {
    mux?.restore();
    mux = undefined;
    if (prevState === undefined) {
      const key = "MU_STATE_DIR";
      delete process.env[key];
    } else {
      process.env.MU_STATE_DIR = prevState;
    }
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(dir);
  });

  const seed = (): { sock: string; tasks: () => number; tornDownAt: () => string | null } => {
    addTask(db, { workstream: "ws", localId: "t1", title: "T", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    const sock = ctlSocketPath("ws", "w1", dir);
    mkdirSync(dirname(sock), { recursive: true });
    writeFileSync(sock, "");
    return {
      sock,
      tasks: () => (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n,
      tornDownAt: () =>
        (
          db.prepare("SELECT torn_down_at AS t FROM workstreams WHERE name = 'ws'").get() as {
            t: string | null;
          }
        ).t,
    };
  };

  it("aborts with the typed mux error and deletes nothing", async () => {
    const s = seed();
    mux = installMux(backend, async () => DENIED);

    await expect(softTeardown(db, "ws")).rejects.toBeInstanceOf(MuxError);

    expect(s.tasks()).toBe(1);
    expect(s.tornDownAt()).toBeNull();
    expect(existsSync(s.sock)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(1);
    // Nothing was killed either: the only calls were probes.
    expect(mux.calls.some((c) => c.includes("kill-session") || c.includes("close"))).toBe(false);
  });

  it("a probe that answers 'no panes' still lets teardown proceed", async () => {
    const s = seed();
    mux =
      backend === "tmux"
        ? installMux("tmux", [
            ["list-panes", { stdout: "", exitCode: 1, stderr: "can't find session" }],
          ])
        : installMux("herdr", [["workspace list", JSON.stringify({ result: { workspaces: [] } })]]);

    const r = await softTeardown(db, "ws");

    expect(r.killedMux).toBe(false);
    // Soft: the task stays, the workstream is marked, the agent row is gone.
    expect(s.tasks()).toBe(1);
    expect(s.tornDownAt()).not.toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(0);
    expect(existsSync(s.sock)).toBe(false);
  });
});
