// spawnAgent's split path (session and --tab window both exist) must
// target the window it listed, never one tmux resolves by prefix.
//
// Review gap g_fix_tmux_split_prefix_race: createOrReusePane split
// `-t mu-auth:Backend`. If `mu-auth` vanished between list-windows and
// split-window, tmux's session prefix fallback resolved it to
// `mu-auth-refactor` and the agent's pane landed in another workstream
// (probed on tmux 3.7c with a private socket). The mock in
// test/_verbs-mock.ts emulates that fallback for split-window.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  resetSleep,
  resetTmuxExecutor,
  setSleepForTests,
  setTmuxExecutor,
  type TmuxExecutor,
} from "../src/tmux.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

let tempDir: string;
let db: Db;
let state: MockState;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-spawn-split-target-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  state = freshMockState();
  resetTmuxExecutor();
  setSleepForTests(async () => {});
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  // The workstream under spawn, and a sibling whose name it prefixes.
  for (const [session, windowId] of [
    ["mu-auth", "@1"],
    ["mu-auth-refactor", "@2"],
  ] as const) {
    state.sessions.add(session);
    state.windows.set(session, [{ id: windowId, name: "Backend" }]);
  }
  state.nextWindowId = 3;
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
  const key = "MU_SPAWN_LIVENESS_MS";
  delete process.env[key];
});

function splitCall(calls: string[][]): string[] | undefined {
  return calls.find((c) => c[0] === "split-window");
}

describe("spawnAgent split target", () => {
  it("splits the listed window by exact session and window id", async () => {
    const { executor, calls } = mockTmux(state);
    setTmuxExecutor(executor);
    await spawnAgent(db, { name: "worker-1", workstream: "auth", tab: "Backend" });
    const args = splitCall(calls);
    expect(args?.[args.indexOf("-t") + 1]).toBe("=mu-auth:@1");
    const pane = [...state.panes.values()].at(-1);
    expect(pane?.windowId).toBe("@1");
  });

  it("fails instead of splitting a prefix-matched session when the session vanishes mid-spawn", async () => {
    const { executor: inner, calls } = mockTmux(state);
    // The race: mu-auth exists for has-session and list-windows, then
    // dies before split-window runs.
    const executor: TmuxExecutor = async (args) => {
      const result = await inner(args);
      if (args[0] === "list-windows" && args.includes("=mu-auth:")) {
        state.sessions.delete("mu-auth");
        state.windows.delete("mu-auth");
      }
      return result;
    };
    setTmuxExecutor(executor);

    await expect(
      spawnAgent(db, { name: "worker-1", workstream: "auth", tab: "Backend" }),
    ).rejects.toThrow(/can't find session/);

    expect(splitCall(calls)).toBeDefined();
    // Nothing landed in the sibling workstream's window.
    expect([...state.panes.values()].filter((p) => p.windowId === "@2")).toEqual([]);
  });
});
