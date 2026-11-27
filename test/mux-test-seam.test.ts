// Tests for the mux TEST SEAM itself (test/_mux.ts).
//
// Test infrastructure that silently does the wrong thing is worse than
// none: a harness that stubs Rex while running tmux makes assertions
// pass for the wrong reason. So the seam gets the same treatment as
// production code.

import { afterEach, describe, expect, it } from "vitest";
import { rex } from "../src/mux/rex.js";
import { NoMultiplexerError } from "../src/mux/types.js";
import { activeMux } from "../src/mux.js";
import { tmux } from "../src/tmux.js";
import { withEnv } from "./_env.js";
import {
  installMux,
  installUnreachableMux,
  type MuxHarness,
  tmuxIntegrationAvailable,
} from "./_mux.js";

const SESSIONS = "mu-topotest\n";

/** One raw call through the Rex executor seam (the thing under test). */
async function listSessions(): Promise<{ name: string }[]> {
  const out = await rex(["session", "list"]);
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((name) => ({ name }));
}

async function tmuxListSessions(): Promise<{ name: string }[]> {
  const out = await tmux(["list-sessions", "-F", "#{session_name}"]);
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((name) => ({ name }));
}

let harness: MuxHarness | undefined;

afterEach(() => {
  harness?.restore();
  harness = undefined;
});

// ─── One call installs backend + executor ──────────────────────────────

describe("installMux wires the backend and its executor together", () => {
  it("selects Rex AND stubs the Rex executor in one call", async () => {
    harness = installMux("rex", [["session list", SESSIONS]]);
    // Backend selection took effect...
    expect((await activeMux()).name).toBe("rex");
    // ...and the executor the backend actually uses is the stub.
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });

  it("selects tmux AND stubs the tmux executor in one call", async () => {
    harness = installMux("tmux", [["list-sessions", "mu-alpha\nmu-beta\n"]]);
    expect((await activeMux()).name).toBe("tmux");
    expect(await tmuxListSessions()).toEqual([{ name: "mu-alpha" }, { name: "mu-beta" }]);
  });

  it("records every call in order, with argsOf() sugar", async () => {
    harness = installMux("rex", [["session list", SESSIONS]]);
    await listSessions();
    await listSessions();
    expect(harness.calls).toHaveLength(2);
    expect(harness.argsOf(0)).toEqual(["session", "list"]);
    expect(harness.argsOf(5)).toBeUndefined();
  });

  it("an unrouted call fails like a substrate error and names the command", async () => {
    // Not a throw: the code under test must see what a real failure
    // looks like. The stderr names the route the test forgot.
    harness = installMux("rex", []);
    await expect(listSessions()).rejects.toThrow(/unrouted: session list/);
  });

  it("takes a function for stateful or must-not-be-called stubs", async () => {
    let hits = 0;
    harness = installMux("rex", async () => {
      hits++;
      return { stdout: SESSIONS, stderr: "", exitCode: 0 };
    });
    await listSessions();
    expect(hits).toBe(1);
  });

  it("longest-prefix-first ordering lets a narrow route beat a broad one", async () => {
    harness = installMux("rex", [
      ["session list --foo", ""],
      ["session list", SESSIONS],
    ]);
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });
});

// ─── Teardown is a single, idempotent call ─────────────────────────────

describe("restore() is one teardown for both seams", () => {
  it("restores the backend so the next test re-detects", async () => {
    const h = installMux("rex", [["session list", SESSIONS]]);
    expect((await activeMux()).name).toBe("rex");
    h.restore();
    // restore() re-armed detection (setMuxForTests(previous)), so
    // activeMux() is no longer pinned to Rex.
    // MU_MUX drives detection deterministically without a real mux.
    await withEnv("MU_MUX", "tmux", async () => {
      expect((await activeMux()).name).toBe("tmux");
    });
  });

  it("nested installs unwind LIFO — inner restore() puts the outer backend and executor back", async () => {
    harness = installMux("rex", [["session list", SESSIONS]]);
    const inner = installMux("tmux", [["list-sessions", "mu-inner\n"]]);
    expect((await activeMux()).name).toBe("tmux");
    inner.restore();
    expect((await activeMux()).name).toBe("rex");
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);

    const innerRex = installMux("rex", [["session list", ""]]);
    expect(await listSessions()).toEqual([]);
    innerRex.restore();
    // Same-backend nesting: the outer stub executor is back, not the real one.
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });

  it("installUnreachableMux restore() puts the outer backend back", async () => {
    harness = installMux("rex", [["session list", SESSIONS]]);
    const unreachable = installUnreachableMux("tmux", () => new NoMultiplexerError(["tmux"]));
    unreachable.restore();
    expect((await activeMux()).name).toBe("rex");
  });

  it("is idempotent — a double restore cannot clobber the next harness", async () => {
    const h = installMux("rex", [["session list", SESSIONS]]);
    h.restore();
    harness = installMux("rex", [["session list", SESSIONS]]);
    // The stale handle's second restore() must be a no-op, or it would
    // reset the executor the CURRENT test just installed.
    h.restore();
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });
});

// ─── Unreachable-mux stub ──────────────────────────────────────────────

describe("installUnreachableMux models a box with no multiplexer", () => {
  it("every method rejects with the supplied error", async () => {
    const unreachable = installUnreachableMux("tmux", () => new NoMultiplexerError(["tmux"]));
    try {
      const mux = await activeMux();
      await expect(mux.listPanes("mu-x")).rejects.toBeInstanceOf(NoMultiplexerError);
      await expect(mux.paneAlive("%1")).rejects.toBeInstanceOf(NoMultiplexerError);
    } finally {
      unreachable.restore();
    }
  });

  it("keeps the backend NAME, so name-dependent branches still work", async () => {
    const unreachable = installUnreachableMux("rex", () => new NoMultiplexerError(["rex"]));
    try {
      expect((await activeMux()).name).toBe("rex");
    } finally {
      unreachable.restore();
    }
  });
});

describe("integration-tier gates", () => {
  it("tmux gate requires the run's private socket, not the caller's $TMUX", async () => {
    await withEnv("MU_TMUX_SOCKET", "mu-test-x", async () => {
      await withEnv("TMUX", undefined, async () => {
        expect(tmuxIntegrationAvailable()).toBe(true);
      });
    });
    await withEnv("MU_TMUX_SOCKET", undefined, async () => {
      await withEnv("TMUX", undefined, async () => {
        expect(tmuxIntegrationAvailable()).toBe(false);
      });
      await withEnv("TMUX", "/tmp/tmux-1000/default,123,0", async () => {
        expect(tmuxIntegrationAvailable()).toBe(false);
      });
    });
  });
});
