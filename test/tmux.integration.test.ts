// Integration tests for src/mux/tmux.ts. Hits a real tmux server.
//
// Skipped when not running inside tmux. Each test creates a unique
// throwaway session so we never disturb the user's panes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capture,
  ensureSession,
  killPane,
  killSession,
  listPanes,
  paneAlive,
  resetTmuxExecutor,
  spawnAgent,
  tmux,
} from "../src/tmux.js";
import { pollUntil } from "./_env.js";
import { freshWorkstream } from "./_fixture.js";

const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";

const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

const SLEEP = "sh -c 'while true; do sleep 60; done'";

describeIfTmux("tmux integration (real tmux server)", () => {
  let session: string;

  /** Spawn into `session` (window `window`) running `command`. */
  const spawn = (window: string, command = SLEEP, env: Record<string, string> = {}) =>
    spawnAgent({
      session,
      window,
      name: window,
      cli: "pi",
      command,
      commandSource: "cli-key",
      env,
    });

  beforeEach(async () => {
    resetTmuxExecutor();
    // Unique session name per test so parallel test runs don't collide.
    // freshWorkstream() encodes pid + monotonic timestamp + random — fits
    // inside tmux's session-name limits (no '.' or ':' chars).
    session = `mu-${freshWorkstream("t")}`;
  });

  afterEach(async () => {
    await killSession(session); // idempotent
  });

  it("ensureSession creates the session with `_mu`, is idempotent, and repairs a missing `_mu`", async () => {
    expect(await ensureSession(session)).toEqual({ created: true, repaired: false });
    expect(await ensureSession(session)).toEqual({ created: false, repaired: false });
    // Keep the session alive while `_mu` is removed.
    await spawn("worker-1");
    await tmux(["kill-window", "-t", `=${session}:_mu`]);
    expect(await ensureSession(session)).toEqual({ created: false, repaired: true });
  });

  it("killSession is idempotent", async () => {
    await ensureSession(session);
    await killSession(session);
    expect(await listPanes(session)).toEqual([]);
    await expect(killSession(session)).resolves.toBeUndefined();
  });

  it("spawnAgent into a missing session creates it and returns a live pane id", async () => {
    const paneId = await spawn("worker-1");
    expect(paneId).toMatch(/^%\d+$/);
    expect(await paneAlive(paneId)).toBe(true);
  });

  it("spawnAgent into an existing window splits it; a new window name adds a window", async () => {
    await ensureSession(session);
    const first = await spawn("Backend");
    const split = await spawn("Backend");
    const other = await spawn("Frontend");
    expect(new Set([first, split, other]).size).toBe(3);
    const panes = await listPanes(session);
    const win = (id: string) => panes.find((p) => p.paneId === id)?.windowId;
    expect(win(first)).toBe(win(split));
    expect(win(other)).not.toBe(win(first));
    // `_mu` pane + Backend's two + Frontend's one, each carrying a window id.
    expect(panes).toHaveLength(4);
    for (const p of panes) expect(p.windowId).toMatch(/^@\d+$/);
  });

  it("spawnAgent passes env to the pane", async () => {
    const paneId = await spawn(
      "envy",
      "sh -c 'echo MU_ENV=$MU_AGENT_NAME; while true; do sleep 60; done'",
      { MU_AGENT_NAME: "envy" },
    );
    await pollUntil(() => capture(paneId).then((c) => c.includes("MU_ENV=envy")), {
      description: "env var visible in the pane",
    });
  });

  it("paneAlive is false for a never-existed pane id", async () => {
    expect(await paneAlive("%999999")).toBe(false);
  });

  it("paneAlive transitions true → false after killPane", async () => {
    const paneId = await spawn("ephemeral");
    expect(await paneAlive(paneId)).toBe(true);
    await killPane(paneId);
    await pollUntil(async () => !(await paneAlive(paneId)), {
      description: "killed pane disappears",
    });
    expect(await paneAlive(paneId)).toBe(false);
  });

  it("capture returns pane scrollback as text", async () => {
    const paneId = await spawn(
      "echo",
      // Print known text and stay alive.
      "sh -c 'echo MU_INTEGRATION_MARKER; while true; do sleep 60; done'",
    );
    await pollUntil(
      () => capture(paneId).then((content) => content.includes("MU_INTEGRATION_MARKER")),
      { description: "echo marker lands in pane scrollback" },
    );
    const content = await capture(paneId);
    expect(content).toContain("MU_INTEGRATION_MARKER");
  });
});

if (!TMUX_AVAILABLE) {
  describe("tmux integration", () => {
    it.skip("skipped — set $TMUX (run inside tmux) to enable", () => {});
  });
}
