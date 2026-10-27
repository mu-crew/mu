// k_soft_teardown round 3: the reviewer's real-tmux repros, on the suite's
// PRIVATE tmux socket (MU_TMUX_SOCKET, set by test/_global-teardown.ts):
//   move_during_kill   a pane moved out of mu-<ws> between list-panes and
//                      kill-session survives the kill; teardown must keep its row
//   peer_close         a torn-down workstream (a peer's put) with a live moved
//                      pane: `agent close` must refuse, never silently no-op
// Skipped without $TMUX, like the other real-tmux tests.

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPaneStillAliveError, closeAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { resetTmuxExecutor, setTmuxExecutor, type TmuxExecutor, tmux } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { freshWorkstream } from "./_fixture.js";
import { rmFixtureDir } from "./_fs.js";
import { tmuxIntegrationAvailable } from "./_mux.js";
import { softTeardown } from "./_teardown.js";

const run = promisify(execFile);
const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;
const SLEEP = "sh -c 'while true; do sleep 60; done'";

/** The real tmux, through the same private-socket flags mu uses. */
async function rawTmux(
  args: readonly string[],
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const socket = process.env.MU_TMUX_SOCKET;
  const flags = socket ? ["-L", socket, "-f", "/dev/null"] : [];
  try {
    const r = await run("tmux", [...flags, ...args]);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", exitCode: x.code ?? 1 };
  }
}

describeIfTmux("moved panes (real tmux, private socket)", () => {
  let dir: string;
  let db: Db;
  let ws: string;
  let session: string;
  let holding: string;
  let pane: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mu-moved-"));
    process.env.MU_STATE_DIR = dir;
    db = openDb({ path: join(dir, "mu.db") });
    resetTmuxExecutor();
    ws = freshWorkstream("mv");
    session = `mu-${ws}`;
    holding = `hold-${ws}`;
    ensureWorkstream(db, ws);
    addTask(db, { workstream: ws, localId: "a", title: "A", impact: 50, effortDays: 1 });
    await tmux(["new-session", "-d", "-s", session, "-n", "_mu"]);
    await tmux(["new-window", "-t", `=${session}:`, "-n", "w", SLEEP]);
    await tmux(["new-session", "-d", "-s", holding]);
    pane = (await tmux(["list-panes", "-t", `=${session}:w`, "-F", "#{pane_id}"])).trim();
    insertAgent(db, { name: "mw", workstream: ws, paneId: pane });
  });

  afterEach(async () => {
    resetTmuxExecutor();
    for (const s of [session, holding]) await rawTmux(["kill-session", "-t", `=${s}`]);
    try {
      db.close();
    } catch {
      // already closed
    }
    const key = "MU_STATE_DIR";
    delete process.env[key];
    rmFixtureDir(dir);
  });

  const alive = async (): Promise<boolean> =>
    (await rawTmux(["display-message", "-p", "-t", pane, "#{pane_id}"])).stdout.trim() === pane;

  it("move_during_kill: the pane moves right before kill-session; its row survives, the pane is alive", async () => {
    setTmuxExecutor(async (args) => {
      if (args[0] === "kill-session") {
        await rawTmux(["move-window", "-s", pane, "-t", `${holding}:`]);
      }
      return rawTmux(args);
    });
    const r = await softTeardown(db, ws);
    expect(await alive()).toBe(true);
    expect(r.orphanedAgents).toEqual([{ name: "mw", paneId: pane, reason: "alive" }]);
    expect(
      (db.prepare("SELECT name FROM agents").all() as { name: string }[]).map((a) => a.name),
    ).toEqual(["mw"]);
  });

  it("peer_close: a peer-torn workstream with a live moved pane: close refuses, then succeeds once it is gone", async () => {
    await rawTmux(["move-window", "-s", pane, "-t", `${holding}:`]);
    await rawTmux(["kill-session", "-t", `=${session}`]);
    db.prepare(
      "UPDATE workstreams SET torn_down_at = '2026-01-01T00:00:00.000Z' WHERE name = ?",
    ).run(ws);
    // A kill-pane that does not stop it (the mux refuses): the pane stays alive.
    const real: TmuxExecutor = async (args) => rawTmux(args);
    setTmuxExecutor(async (args) =>
      args[0] === "kill-pane" ? { stdout: "", stderr: "", exitCode: 0 } : real(args),
    );
    await expect(closeAgent(db, "mw", { workstream: ws })).rejects.toBeInstanceOf(
      AgentPaneStillAliveError,
    );
    expect(await alive()).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual({ n: 1 });
    // The real kill: the pane dies, the row goes.
    setTmuxExecutor(real);
    const r = await closeAgent(db, "mw", { workstream: ws });
    expect(r.deletedRow).toBe(true);
    expect(await alive()).toBe(false);
  });
});
