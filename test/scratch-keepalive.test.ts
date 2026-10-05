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
import { herdrBackend, newSession } from "../src/mux/herdr.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import {
  ensureWorkstream,
  ensureWorkstreamSession,
  listEmptyWorkstreams,
} from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";
import { fail, freshMockState, type MockState, mockTmux, ok } from "./_verbs-mock.js";

let tempDir: string;
let dbPath: string;
let db: Db;
let state: MockState;
let mux: MuxHarness | undefined;

beforeEach(() => {
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
    expect(create).toEqual(["new-session", "-d", "-s", "mu-scratch", "-n", "_mu"]);
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
    state.panes.set("%1", { windowId: "@1", paneId: "%1", title: "old-delegate", command: "pi" });
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
    expect(create?.slice(0, 6)).toEqual(["new-session", "-d", "-s", "mu-auth", "-n", "worker-1"]);
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
          return sessions.has(target) ? ok("@1\t%1\t\tzsh") : fail(`can't find session: ${target}`);
        case "kill-session":
          sessions.delete(target);
          killed.push(target);
          return ok();
        default:
          return fail(`unmocked: ${args.join(" ")}`);
      }
    };
  }

  it("the sweep skips an agentless scratch; a named teardown still removes it", async () => {
    ensureWorkstream(db, "scratch");
    ensureWorkstream(db, "bare");
    const sessions = new Set(["mu-scratch", "mu-bare"]);
    const killed: string[] = [];
    mux = installMux("tmux", sessionsFake(sessions, killed));

    expect((await listEmptyWorkstreams(db)).map((w) => w.name)).toEqual(["bare"]);
    db.close();

    const sweep = await runCli(["workstream", "teardown", "--empty", "--yes", "--json"], dbPath);
    expect(sweep.error).toBeUndefined();
    expect(JSON.parse(sweep.stdout)).toMatchObject({ tornDown: 1, failed: [] });
    expect(killed).toEqual(["mu-bare"]);
    expect(sessions.has("mu-scratch")).toBe(true);

    const named = await runCli(["workstream", "teardown", "scratch", "--yes", "--json"], dbPath);
    expect(named.error).toBeUndefined();
    expect(killed).toEqual(["mu-bare", "mu-scratch"]);
    expect(sessions.has("mu-scratch")).toBe(false);
  });
});

describe("herdr: the placeholder window is found by name", () => {
  const WORKSPACE_CREATED = JSON.stringify({
    result: {
      root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
      tab: { label: "1", number: 1, tab_id: "w1:t1", workspace_id: "w1" },
      type: "workspace_created",
      workspace: { label: "mu-scratch", number: 1, workspace_id: "w1" },
    },
  });

  it("newSession labels the first tab with windowName", async () => {
    mux = installMux("herdr", [
      ["workspace create", WORKSPACE_CREATED],
      ["tab rename", JSON.stringify({ result: { type: "ok" } })],
    ]);
    await newSession("mu-scratch", { detached: true, windowName: "_mu" });
    expect(mux.calls.map((c) => c.join(" "))).toEqual([
      "workspace create --label mu-scratch --no-focus",
      "tab rename w1:t1 _mu",
    ]);
  });

  it("newSession without windowName leaves herdr's tab label alone", async () => {
    mux = installMux("herdr", [["workspace create", WORKSPACE_CREATED]]);
    await newSession("mu-scratch");
    expect(mux.calls).toHaveLength(1);
  });

  it("repairing `_mu` on herdr creates a bare tab (no command)", async () => {
    mux = installMux("herdr", [
      [
        "workspace list",
        JSON.stringify({ result: { workspaces: [{ label: "mu-scratch", workspace_id: "w1" }] } }),
      ],
      [
        "tab list",
        JSON.stringify({ result: { tabs: [{ label: "delegate-x", tab_id: "w1:t1" }] } }),
      ],
      [
        "tab create",
        JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } } }),
      ],
    ]);
    expect(herdrBackend.startAgentInPane).toBeDefined();
    expect(await ensureWorkstreamSession("mu-scratch")).toEqual({
      created: false,
      muWindowRepaired: true,
    });
    expect(mux.calls.at(-1)).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--label",
      "_mu",
      "--no-focus",
    ]);
  });
});
