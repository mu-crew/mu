// The `scratch` session outlives its last agent.
//
// scratch is never `workstream init`-ed, so its first spawn used to
// create `mu-scratch` with the agent's own window as the only one;
// closing that agent killed the last window and tmux destroyed the
// session, so every next delegate paid for creating it again
// (fix_scratch_keepalive). Spawn now gives scratch the same placeholder
// `_mu` window `workstream init` creates, repairing it when missing,
// and `teardown --empty` no longer sweeps the kept-alive idle session.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent, spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { muxByName, setMuxForTests } from "../src/mux.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream, listEmptyWorkstreams } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { previewRevision } from "./_teardown.js";
import { fail, freshMockState, type MockState, mockTmux, ok } from "./_verbs-mock.js";

let tempDir: string;
let dbPath: string;
let db: Db;
let state: MockState;
let mux: MuxHarness | undefined;

beforeEach(() => {
  // Pin tmux: with TMUX/TMUX_PANE unset, detection would probe the real box.
  setMuxForTests(muxByName("tmux"));
  tempDir = mkdtempSync(join(tmpdir(), "mu-scratch-keepalive-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  state = freshMockState();
  resetTmuxExecutor();
  setSleepForTests(async () => {});
  process.env.MU_SPAWN_LIVENESS_MS = "0";
});

afterEach(() => {
  mux?.restore();
  mux = undefined;
  setMuxForTests(undefined);
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
  const key = "MU_SPAWN_LIVENESS_MS";
  delete process.env[key];
});

/** Window names of `session` in the mock, in creation order. */
const windowNames = (session: string): string[] =>
  (state.windows.get(session) ?? []).map((w) => w.name);

/** Panes still alive in the `_mu` window of `session`. */
function muPanes(session: string): number {
  const mu = state.windows.get(session)?.find((w) => w.name === "_mu");
  return [...state.panes.values()].filter((p) => p.windowId === mu?.id).length;
}

describe("spawn into scratch keeps the session alive (tmux)", () => {
  it("first spawn creates mu-scratch with `_mu`, then a window for the agent", async () => {
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);

    await spawnAgent(db, { name: "helper-1", workstream: "scratch" });

    const create = calls.find((c) => c[0] === "new-session");
    expect(create).toEqual([
      "new-session",
      "-d",
      "-x",
      "200",
      "-y",
      "50",
      "-s",
      "mu-scratch",
      "-n",
      "_mu",
    ]);
    expect(calls.filter((c) => c[0] === "new-session")).toHaveLength(1);
    expect(calls.some((c) => c[0] === "new-window" && c.includes("helper-1"))).toBe(true);
    expect(windowNames("mu-scratch")).toEqual(["_mu", "helper-1"]);
  });

  it("closing the only agent leaves the `_mu` pane, so the session survives", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, { name: "helper-1", workstream: "scratch" });

    await closeAgent(db, "helper-1", { workstream: "scratch" });

    expect(state.panes.has(agent.paneId)).toBe(false);
    expect(state.sessions.has("mu-scratch")).toBe(true);
    // tmux destroys a session only when its last pane goes.
    expect(muPanes("mu-scratch")).toBe(1);
  });

  it("repairs a missing `_mu` window when mu-scratch already exists without it", async () => {
    // Today's live mu-scratch: created by an older spawn, delegate windows only.
    state.sessions.add("mu-scratch");
    state.windows.set("mu-scratch", [{ id: "@1", name: "old-delegate" }]);
    state.panes.set("%1", { windowId: "@1", paneId: "%1", command: "pi" });
    state.nextWindowId = 2;
    state.nextPaneId = 2;
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);

    await spawnAgent(db, { name: "helper-1", workstream: "scratch" });

    expect(calls.some((c) => c[0] === "new-session")).toBe(false);
    expect(windowNames("mu-scratch")).toEqual(["old-delegate", "_mu", "helper-1"]);
  });

  it("a second scratch spawn does not add another `_mu`", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    await spawnAgent(db, { name: "helper-1", workstream: "scratch" });
    await spawnAgent(db, { name: "helper-2", workstream: "scratch" });
    expect(windowNames("mu-scratch")).toEqual(["_mu", "helper-1", "helper-2"]);
  });

  it("a non-scratch first spawn keeps creating the session with the agent's window", async () => {
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);

    await spawnAgent(db, { name: "worker-1", workstream: "auth" });

    const create = calls.find((c) => c[0] === "new-session");
    expect(create?.slice(0, 9)).toEqual([
      "new-session",
      "-d",
      "-x",
      "200",
      "-y",
      "50",
      "-s",
      "mu-auth",
      "-n",
    ]);
    expect(create).toContain("-P");
    expect(windowNames("mu-auth")).toEqual(["worker-1"]);
  });
});

describe("teardown --empty leaves the kept-alive scratch session", () => {
  /** tmux fake: sessions that exist, recording kill-session targets. */
  function sessionsFake(sessions: Set<string>, killed: string[]) {
    return async (args: readonly string[]) => {
      const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=(.*):$/, "$1");
      switch (args[0]) {
        case "list-sessions":
          return ok([...sessions].join("\n"));
        case "has-session":
          return sessions.has(target) ? ok() : fail(`can't find session: ${target}`);
        case "list-panes":
          return sessions.has(target) ? ok("@1|%1|zsh") : fail(`can't find session: ${target}`);
        case "kill-session":
          sessions.delete(target);
          killed.push(target);
          return ok();
        default:
          return fail(`unmocked: ${args.join(" ")}`);
      }
    };
  }

  it("the sweep skips scratch; neither path kills a tmux session without proof", async () => {
    ensureWorkstream(db, "scratch");
    ensureWorkstream(db, "bare");
    const sessions = new Set(["mu-scratch", "mu-bare"]);
    const killed: string[] = [];
    mux = installMux("tmux", sessionsFake(sessions, killed));

    expect((await listEmptyWorkstreams(db)).map((w) => w.name)).toEqual(["bare"]);
    db.close();

    const sweepRev = await previewRevision(dbPath, ["--empty"]);
    const sweep = await runCliJson(
      ["workstream", "teardown", "--empty", "--if", String(sweepRev), "--json"],
      dbPath,
    );
    expect(sweep.error).toBeUndefined();
    expect(sweep.data).toMatchObject({ tornDown: 1, failed: [] });
    expect(killed).toEqual([]);
    expect(sessions.has("mu-scratch")).toBe(true);

    const namedRev = await previewRevision(dbPath, ["scratch"]);
    const named = await runCliJson(
      ["workstream", "teardown", "scratch", "--if", String(namedRev), "--json"],
      dbPath,
    );
    expect(named.error).toBeUndefined();
    expect(named.data).toMatchObject({ killedMux: false });
    expect(killed).toEqual([]);
    expect(sessions.has("mu-scratch")).toBe(true);
  });
});
