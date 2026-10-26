// Unit tests for src/mux/tmux.ts. Uses a mocked executor so we can verify
// exactly which tmux args each function emits, without needing a real
// tmux server. Integration tests against real tmux live in
// test/tmux.integration.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertValidPaneId,
  attachCommands,
  capture,
  ensureSession,
  isValidPaneId,
  killPane,
  killSession,
  listPanes,
  PANE_ID_RE,
  paneAlive,
  paneResult,
  resetSleep,
  resetTmuxExecutor,
  setSleepForTests,
  setTmuxExecutor,
  spawnAgent,
  TmuxError,
  type TmuxExecResult,
  type TmuxExecutor,
  tmux,
} from "../src/tmux.js";

// ─── Mock executor harness ────────────────────────────────────────────

interface RecordedCall {
  args: string[];
}

function harness(responder: (args: string[]) => TmuxExecResult): {
  calls: RecordedCall[];
  executor: TmuxExecutor;
} {
  const calls: RecordedCall[] = [];
  const executor: TmuxExecutor = async (args) => {
    calls.push({ args: [...args] });
    return responder([...args]);
  };
  return { calls, executor };
}

const ok = (stdout = ""): TmuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1, stdout = ""): TmuxExecResult => ({
  stdout,
  stderr,
  exitCode,
});

beforeEach(() => {
  resetTmuxExecutor();
  // Replace sleep with no-op so send tests don't actually wait.
  setSleepForTests(async () => {});
});

afterEach(() => {
  resetTmuxExecutor();
  resetSleep();
});

// ─── Pane ID validation ────────────────────────────────────────────────

describe("pane id validation", () => {
  it("accepts %0, %15, %999", () => {
    expect(isValidPaneId("%0")).toBe(true);
    expect(isValidPaneId("%15")).toBe(true);
    expect(isValidPaneId("%999")).toBe(true);
    expect(PANE_ID_RE.test("%42")).toBe(true);
  });

  it("rejects pane indexes (0, 1, 2)", () => {
    expect(isValidPaneId("0")).toBe(false);
    expect(isValidPaneId("1")).toBe(false);
  });

  it("rejects window ids (@1)", () => {
    expect(isValidPaneId("@1")).toBe(false);
  });

  it("rejects session ids ($1)", () => {
    expect(isValidPaneId("$1")).toBe(false);
  });

  it("rejects empty/garbage", () => {
    expect(isValidPaneId("")).toBe(false);
    expect(isValidPaneId("%")).toBe(false);
    expect(isValidPaneId("%abc")).toBe(false);
    expect(isValidPaneId("%15;rm -rf")).toBe(false);
    expect(isValidPaneId(" %15")).toBe(false);
  });

  it("assertValidPaneId throws on bad input", () => {
    expect(() => assertValidPaneId("0")).toThrow(TypeError);
    expect(() => assertValidPaneId("%abc")).toThrow(/invalid tmux pane id/);
  });

  it("assertValidPaneId returns void on good input", () => {
    expect(() => assertValidPaneId("%15")).not.toThrow();
  });
});

// ─── Low-level tmux() wrapper ─────────────────────────────────────────

describe("tmux() wrapper", () => {
  it("returns stdout on success", async () => {
    const { executor } = harness(() => ok("hello\n"));
    setTmuxExecutor(executor);
    expect(await tmux(["foo"])).toBe("hello\n");
  });

  it("throws TmuxError on non-zero exit", async () => {
    const { executor } = harness(() => fail("bad arg"));
    setTmuxExecutor(executor);
    await expect(tmux(["bad"])).rejects.toBeInstanceOf(TmuxError);
  });

  it("TmuxError carries args, stderr, stdout, exitCode", async () => {
    const { executor } = harness(() => fail("nope", 2, "partial"));
    setTmuxExecutor(executor);
    try {
      await tmux(["x", "y"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TmuxError);
      const e = err as TmuxError;
      expect(e.args).toEqual(["x", "y"]);
      expect(e.stderr).toBe("nope");
      expect(e.stdout).toBe("partial");
      expect(e.exitCode).toBe(2);
      expect(e.message).toContain("tmux x y failed (exit 2)");
      expect(e.message).toContain("nope");
    }
  });

  it("records exact args passed to executor", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await tmux(["a", "b", "c"]);
    expect(calls).toEqual([{ args: ["a", "b", "c"] }]);
  });
});

// ─── Sessions ──────────────────────────────────────────────────────────

// ─── Sessions ──────────────────────────────────────────────────────────

describe("killSession", () => {
  it("succeeds on normal kill", async () => {
    const { executor } = harness(() => ok());
    setTmuxExecutor(executor);
    await expect(killSession("foo")).resolves.toBeUndefined();
  });

  it("succeeds idempotently when session is already gone", async () => {
    const { executor } = harness(() => fail("can't find session: foo"));
    setTmuxExecutor(executor);
    await expect(killSession("foo")).resolves.toBeUndefined();
  });

  it("succeeds idempotently when the server is up with zero sessions", async () => {
    // tmux says "no current target" — not "can't find session" — when the
    // server is running but has no sessions at all, because `-t <name>`
    // has no session list to resolve against. Reachable whenever the
    // server outlives its last session: the suite's private server
    // (`exit-empty off`, test/_global-teardown.ts) and any user config
    // that sets `exit-empty off`.
    const { executor } = harness(() => fail("no current target"));
    setTmuxExecutor(executor);
    await expect(killSession("foo")).resolves.toBeUndefined();
  });

  it("succeeds idempotently when the socket file does not exist", async () => {
    const { executor } = harness(() =>
      fail("error connecting to /tmp/tmux-1000/default (No such file or directory)"),
    );
    setTmuxExecutor(executor);
    await expect(killSession("foo")).resolves.toBeUndefined();
  });

  it("targets the session exactly (=<name>:), never by prefix", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await killSession("mu-auth");
    expect(calls).toEqual([{ args: ["kill-session", "-t", "=mu-auth:"] }]);
  });

  it("propagates other errors", async () => {
    const { executor } = harness(() => fail("server unreachable"));
    setTmuxExecutor(executor);
    await expect(killSession("foo")).rejects.toBeInstanceOf(TmuxError);
  });
});

// ─── Windows ───────────────────────────────────────────────────────────

describe("listPanes", () => {
  it("calls list-panes -s -t <session> with the session-scoped format", async () => {
    const { executor, calls } = harness(() => ok("@1\t%5\tpi\n@2\t%6\tclaude\n"));
    setTmuxExecutor(executor);
    const panes = await listPanes("mu-auth");
    // `=mu-auth:`, not `mu-auth` or `=mu-auth`: both of those still
    // prefix-match `mu-auth-refactor` for list-panes.
    expect(calls[0]?.args.slice(0, 4)).toEqual(["list-panes", "-s", "-t", "=mu-auth:"]);
    expect(panes).toEqual([
      { paneId: "%5", command: "pi", windowId: "@1" },
      { paneId: "%6", command: "claude", windowId: "@2" },
    ]);
  });

  it("returns empty array when session has no panes", async () => {
    const { executor } = harness(() => ok(""));
    setTmuxExecutor(executor);
    expect(await listPanes("mu-empty")).toEqual([]);
  });

  it("returns [] when the session does not exist (tmux destroys it on last pane close)", async () => {
    const { executor } = harness(() => fail("can't find session: mu-ghost"));
    setTmuxExecutor(executor);
    expect(await listPanes("mu-ghost")).toEqual([]);
  });

  it("returns [] when tmux reports 'can't find window' for the session target (tmux quirk)", async () => {
    // Some tmux versions report the missing-session case with a 'window' wording.
    const { executor } = harness(() => fail("can't find window: mu-ghost"));
    setTmuxExecutor(executor);
    expect(await listPanes("mu-ghost")).toEqual([]);
  });

  it("returns [] when the server is up with zero sessions ('no current target')", async () => {
    const { executor } = harness(() => fail("no current target"));
    setTmuxExecutor(executor);
    expect(await listPanes("mu-ghost")).toEqual([]);
  });

  it("returns [] when the socket file does not exist (no server)", async () => {
    const { executor } = harness(() =>
      fail("error connecting to /tmp/tmux-1000/default (No such file or directory)"),
    );
    setTmuxExecutor(executor);
    expect(await listPanes("mu-ghost")).toEqual([]);
  });

  it("propagates TmuxError on unexpected failures", async () => {
    const { executor } = harness(() => fail("server crashed"));
    setTmuxExecutor(executor);
    await expect(listPanes("mu-ghost")).rejects.toBeInstanceOf(TmuxError);
  });
});

describe("killPane", () => {
  it("invokes kill-pane -t <pane>", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await killPane("%15");
    expect(calls[0]?.args).toEqual(["kill-pane", "-t", "%15"]);
  });

  it("idempotent on already-gone pane", async () => {
    const { executor } = harness(() => fail("can't find pane: %15"));
    setTmuxExecutor(executor);
    await expect(killPane("%15")).resolves.toBeUndefined();
  });

  it("propagates other errors", async () => {
    const { executor } = harness(() => fail("server gone"));
    setTmuxExecutor(executor);
    await expect(killPane("%15")).rejects.toBeInstanceOf(TmuxError);
  });

  it("idempotent when the tmux socket does not exist", async () => {
    const { executor } = harness(() =>
      fail("error connecting to /tmp/tmux-1000/default (No such file or directory)"),
    );
    setTmuxExecutor(executor);
    await expect(killPane("%15")).resolves.toBeUndefined();
  });

  it("rejects invalid pane ids before calling tmux", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await expect(killPane("0")).rejects.toThrow(/invalid tmux pane id/);
    expect(calls).toEqual([]);
  });
});

describe("paneAlive", () => {
  it("true when display-message echoes the pane id", async () => {
    const { executor } = harness(() => ok("%15\n"));
    setTmuxExecutor(executor);
    expect(await paneAlive("%15")).toBe(true);
  });

  it("false on non-zero exit", async () => {
    const { executor } = harness(() => fail("can't find pane"));
    setTmuxExecutor(executor);
    expect(await paneAlive("%15")).toBe(false);
  });

  it("false when display-message exits 0 but echoes empty (tmux quirk for bogus targets)", async () => {
    const { executor } = harness(() => ok("\n"));
    setTmuxExecutor(executor);
    expect(await paneAlive("%15")).toBe(false);
  });

  it("false when display-message echoes a different pane id", async () => {
    const { executor } = harness(() => ok("%99\n"));
    setTmuxExecutor(executor);
    expect(await paneAlive("%15")).toBe(false);
  });

  it("false (no tmux call) on invalid pane id", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    expect(await paneAlive("garbage")).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("spawnAgent with retainOnExit", () => {
  const run = async (responder: (a: string[]) => TmuxExecResult, over = {}) => {
    const { executor, calls } = harness(responder);
    setTmuxExecutor(executor);
    const seen: string[] = [];
    const id = await spawnAgent({
      ...SPAWN,
      command: "REAL",
      env: { A: "1" },
      cwd: "/w",
      retainOnExit: true,
      onPaneCreated: (p) => seen.push(p),
      ...over,
    });
    return { id, seen, calls: calls.map((c) => c.args) };
  };
  const create = (a: string[]) =>
    a.includes("new-session") || a.includes("new-window") || a.includes("split-window");

  it.each([
    [
      "new-session",
      (a: string[]) => (a[0] === "has-session" ? fail("can't find session") : ok("%7\n")),
    ],
    [
      "new-window",
      (a: string[]) =>
        a[0] === "has-session" ? ok() : a[0] === "list-windows" ? ok("@1\t_mu\n") : ok("%7\n"),
    ],
    [
      "split-window",
      (a: string[]) =>
        a[0] === "has-session" ? ok() : a[0] === "list-windows" ? ok("@1\tworker-1\n") : ok("%7\n"),
    ],
  ])(
    "%s: a placeholder, remain-on-exit on THAT pane, then the real command (never before)",
    async (verb, responder) => {
      const { id, seen, calls } = await run(responder);
      expect(id).toBe("%7");
      const made = calls.findIndex(create);
      expect(calls[made]?.[0]).toBe(verb);
      // The creating call never carries the real command, cwd or env: only the placeholder.
      expect(calls[made]).not.toContain("REAL");
      expect(calls[made]).not.toContain("-e");
      expect(calls[made + 1]).toEqual(["set-option", "-p", "-t", "%7", "remain-on-exit", "on"]);
      expect(calls[made + 2]).toEqual([
        "respawn-pane",
        "-k",
        "-t",
        "%7",
        "-c",
        "/w",
        "-e",
        "A=1",
        "REAL",
      ]);
      // The pane is reported only once the real command runs; no global or session option is set.
      expect(seen).toEqual(["%7"]);
      expect(calls.flat()).not.toContain("-g");
    },
  );

  it("a failing arm kills the pane and reports nothing", async () => {
    const { executor, calls } = harness((a) =>
      a[0] === "has-session"
        ? fail("can't find session")
        : a[0] === "set-option"
          ? fail("nope")
          : ok("%7\n"),
    );
    setTmuxExecutor(executor);
    const seen: string[] = [];
    await expect(
      spawnAgent({ ...SPAWN, retainOnExit: true, onPaneCreated: (p) => seen.push(p) }),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
    expect(calls.map((c) => c.args[0])).toContain("kill-pane");
  });

  it("without retainOnExit nothing changes: one call, no set-option, no respawn", async () => {
    const { calls } = await run(
      (a) => (a[0] === "has-session" ? fail("can't find session") : ok("%7\n")),
      { retainOnExit: false },
    );
    expect(calls.map((c) => c[0])).toEqual(["has-session", "new-session"]);
  });
});

describe("paneResult", () => {
  const probe = (r: TmuxExecResult) => {
    const { executor, calls } = harness(() => r);
    setTmuxExecutor(executor);
    return calls;
  };

  it("running, exited with a code, exited by a signal", async () => {
    probe(ok("%3|0||\n"));
    expect(await paneResult("%3")).toEqual({ state: "running" });
    probe(ok("%3|1|23|\n"));
    expect(await paneResult("%3")).toEqual({ state: "exited", code: 23, signal: null });
    probe(ok("%3|1||9\n"));
    expect(await paneResult("%3")).toEqual({ state: "exited", code: null, signal: 9 });
    const calls = probe(ok("%3|1|0|\n"));
    await paneResult("%3");
    expect(calls[0]?.args).toEqual([
      "display-message",
      "-t",
      "%3",
      "-p",
      "#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}",
    ]);
  });

  it("absent only when the pane or server is gone; any other failure throws (unknown)", async () => {
    probe(fail("can't find pane: %3"));
    expect(await paneResult("%3")).toEqual({ state: "absent" });
    probe(fail("no server running on /tmp/tmux-1/default"));
    expect(await paneResult("%3")).toEqual({ state: "absent" });
    probe(ok("\n"));
    expect(await paneResult("%3")).toEqual({ state: "absent" });
    expect(await paneResult("bogus")).toEqual({ state: "absent" });
    probe(fail("error connecting to socket (Permission denied)"));
    await expect(paneResult("%3")).rejects.toBeInstanceOf(TmuxError);
  });
});

describe("capture", () => {
  it("captures full scrollback by default (-S - -E -)", async () => {
    const { executor, calls } = harness(() => ok("scrollback contents"));
    setTmuxExecutor(executor);
    expect(await capture("%15")).toBe("scrollback contents");
    expect(calls[0]?.args).toEqual(["capture-pane", "-t", "%15", "-p", "-S", "-", "-E", "-"]);
  });

  it("captures last N lines when lines provided", async () => {
    const { executor, calls } = harness(() => ok("last 50"));
    setTmuxExecutor(executor);
    await capture("%15", { lines: 50 });
    expect(calls[0]?.args).toEqual(["capture-pane", "-t", "%15", "-p", "-S", "-50"]);
  });

  it("returns exactly the last N non-blank-ended lines, not screen + N", async () => {
    // `-S -3` starts 3 rows above the TOP of the screen, so tmux prints
    // those 3 rows plus the whole visible screen, blank rows included.
    // Shape of a real 6-row pane after `seq 1 9` and a prompt.
    const tmuxOut = "line1\nline2\nline3\nline4\nline5\nline6\n$ \n\n\n";
    const { executor } = harness(() => ok(tmuxOut));
    setTmuxExecutor(executor);
    expect(await capture("%15", { lines: 3 })).toBe("line5\nline6\n$ \n");
  });

  it("returns '' when the last N lines are all blank", async () => {
    const { executor } = harness(() => ok("\n\n\n"));
    setTmuxExecutor(executor);
    expect(await capture("%15", { lines: 3 })).toBe("");
  });

  it("captures only visible pane when lines is 0", async () => {
    const { executor, calls } = harness(() => ok("visible"));
    setTmuxExecutor(executor);
    await capture("%15", { lines: 0 });
    expect(calls[0]?.args).toEqual(["capture-pane", "-t", "%15", "-p"]);
  });

  it("rejects invalid pane id before tmux call", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await expect(capture("garbage")).rejects.toThrow(/invalid tmux pane id/);
    expect(calls).toEqual([]);
  });
});

// ─── parseAgentNameFromTitle (back-compat with adopted/legacy panes) ──

// ─── ensureSession ─────────────────────────────────────────────────────

describe("ensureSession", () => {
  it("creates a missing session with its placeholder _mu window", async () => {
    const { executor, calls } = harness((args) =>
      args[0] === "has-session" ? fail("can't find session") : ok(),
    );
    setTmuxExecutor(executor);
    expect(await ensureSession("mu-auth")).toEqual({ created: true, repaired: false });
    expect(calls[1]?.args).toEqual([
      "new-session",
      "-d",
      "-x",
      "200",
      "-y",
      "50",
      "-s",
      "mu-auth",
      "-n",
      "_mu",
    ]);
  });

  it("does nothing when the session already holds _mu", async () => {
    const { executor, calls } = harness((args) =>
      args[0] === "list-windows" ? ok("@1\t_mu\n@2\tworker-1\n") : ok(),
    );
    setTmuxExecutor(executor);
    expect(await ensureSession("mu-auth")).toEqual({ created: false, repaired: false });
    expect(calls.map((c) => c.args[0])).toEqual(["has-session", "list-windows"]);
  });

  it("re-adds a missing _mu window to an existing session", async () => {
    const { executor, calls } = harness((args) =>
      args[0] === "list-windows" ? ok("@2\tworker-1\n") : ok(),
    );
    setTmuxExecutor(executor);
    expect(await ensureSession("mu-auth")).toEqual({ created: false, repaired: true });
    const add = calls[2]?.args ?? [];
    expect(add.slice(0, 6)).toEqual(["new-window", "-d", "-t", "=mu-auth:", "-n", "_mu"]);
  });

  it("targets the session exactly (=<name>:), never by prefix", async () => {
    const { executor, calls } = harness(() => ok("@1\t_mu\n"));
    setTmuxExecutor(executor);
    await ensureSession("mu-auth");
    expect(calls[0]).toEqual({ args: ["has-session", "-t", "=mu-auth:"] });
    expect(calls[1]?.args.slice(0, 3)).toEqual(["list-windows", "-t", "=mu-auth:"]);
  });
});

// ─── spawnAgent ────────────────────────────────────────────────────────

const SPAWN = {
  session: "mu-auth",
  window: "worker-1",
  name: "worker-1",
  cli: "pi",
  command: "pi",
  commandSource: "cli-key" as const,
  env: {},
};

describe("spawnAgent", () => {
  it("creates session, window and pane in one new-session when the session is missing", async () => {
    const { executor, calls } = harness((args) =>
      args[0] === "has-session" ? fail("can't find session") : ok("%7\n"),
    );
    setTmuxExecutor(executor);
    const seen: string[] = [];
    const id = await spawnAgent({
      ...SPAWN,
      cwd: "/work/tree",
      env: { MU_AGENT_NAME: "worker-1" },
      onPaneCreated: (p) => seen.push(p),
    });
    expect(id).toBe("%7");
    expect(seen).toEqual(["%7"]);
    expect(calls[1]?.args).toEqual([
      "new-session",
      "-d",
      "-x",
      "200",
      "-y",
      "50",
      "-s",
      "mu-auth",
      "-n",
      "worker-1",
      "-c",
      "/work/tree",
      "-e",
      "MU_AGENT_NAME=worker-1",
      "-P",
      "-F",
      "#{pane_id}",
      "pi",
    ]);
  });

  it("adds a new window when the session exists without that window", async () => {
    const { executor, calls } = harness((args) =>
      args[0] === "list-windows" ? ok("@1\t_mu\n") : args[0] === "new-window" ? ok("%8\n") : ok(),
    );
    setTmuxExecutor(executor);
    expect(await spawnAgent({ ...SPAWN, env: { FOO: "bar" } })).toBe("%8");
    expect(calls[2]?.args).toEqual([
      "new-window",
      "-d",
      "-t",
      "=mu-auth:",
      "-n",
      "worker-1",
      "-e",
      "FOO=bar",
      "-P",
      "-F",
      "#{pane_id}",
      "pi",
    ]);
  });

  it("splits the existing window, targeting its id inside the exact session", async () => {
    const { executor, calls } = harness((args) =>
      args[0] === "list-windows"
        ? ok("@1\t_mu\n@4\tworker-1\n")
        : args[0] === "split-window"
          ? ok("%9\n")
          : ok(),
    );
    setTmuxExecutor(executor);
    expect(await spawnAgent({ ...SPAWN, cwd: "/w", env: { A: "1", B: "2" } })).toBe("%9");
    const args = calls[2]?.args ?? [];
    expect(args.slice(0, 5)).toEqual(["split-window", "-h", "-d", "-t", "=mu-auth:@4"]);
    expectEnvFlag(args, "A", "1");
    expectEnvFlag(args, "B", "2");
    // -e flags precede the command, which is the last positional.
    expect(args.indexOf("-e")).toBeLessThan(args.length - 1);
    expect(args[args.length - 1]).toBe("pi");
  });

  it("emits no -e flags for an empty env", async () => {
    const { executor, calls } = harness((args) =>
      args[0] === "has-session" ? fail("can't find session") : ok("%10\n"),
    );
    setTmuxExecutor(executor);
    await spawnAgent(SPAWN);
    expect(calls[1]?.args).not.toContain("-e");
  });

  it("throws TypeError on an empty env key or a key containing '='", async () => {
    const { executor } = harness((args) =>
      args[0] === "has-session" ? fail("can't find session") : ok("%11\n"),
    );
    setTmuxExecutor(executor);
    await expect(spawnAgent({ ...SPAWN, env: { "": "x" } })).rejects.toThrow(TypeError);
    await expect(spawnAgent({ ...SPAWN, env: { "A=B": "x" } })).rejects.toThrow(TypeError);
  });

  it("rejects non-pane-id output and never reports a pane", async () => {
    const { executor } = harness((args) =>
      args[0] === "has-session" ? fail("can't find session") : ok("garbage\n"),
    );
    setTmuxExecutor(executor);
    const seen: string[] = [];
    await expect(spawnAgent({ ...SPAWN, onPaneCreated: (p) => seen.push(p) })).rejects.toThrow(
      TypeError,
    );
    expect(seen).toEqual([]);
  });
});

/** Assert that args contains the pair `-e`, `KEY=VALUE` adjacent. */
function expectEnvFlag(args: string[], key: string, value: string): void {
  const expected = `${key}=${value}`;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e" && args[i + 1] === expected) return;
  }
  throw new Error(`expected -e ${expected} in args, got: ${args.join(" ")}`);
}

// ─── attachCommands ────────────────────────────────────────────────────

describe("attachCommands", () => {
  // The suite runs on a private socket; the default-socket cases clear it.
  let savedSocket: string | undefined;
  beforeEach(() => {
    savedSocket = process.env.MU_TMUX_SOCKET;
    const key = "MU_TMUX_SOCKET";
    delete process.env[key];
  });
  afterEach(() => {
    if (savedSocket !== undefined) process.env.MU_TMUX_SOCKET = savedSocket;
  });

  it("inside a client: one switch-client step", async () => {
    expect(await attachCommands({ session: "mu-a", window: "w", inside: true })).toEqual([
      { command: "tmux", args: ["switch-client", "-t", "mu-a:w"] },
    ]);
  });

  it("outside: ONE attach-session whose target names the window (nothing after the blocking attach)", async () => {
    expect(await attachCommands({ session: "mu-a", window: "w" })).toEqual([
      { command: "tmux", args: ["attach-session", "-t", "mu-a:w"] },
    ]);
  });

  describe("with a private socket (MU_TMUX_SOCKET)", () => {
    beforeEach(() => {
      process.env.MU_TMUX_SOCKET = "mu-private";
    });

    it("every step is routed with -L, outside and inside", async () => {
      const outside = await attachCommands({ session: "mu-a", window: "w" });
      expect(outside.map((s) => s.args)).toEqual([
        ["-L", "mu-private", "attach-session", "-t", "mu-a:w"],
      ]);
      expect(await attachCommands({ session: "mu-a", window: "w", inside: true })).toEqual([
        { command: "tmux", args: ["-L", "mu-private", "switch-client", "-t", "mu-a:w"] },
      ]);
    });
  });

  it("outside with no window: the session alone", async () => {
    expect(await attachCommands({ session: "mu-a" })).toEqual([
      { command: "tmux", args: ["attach-session", "-t", "mu-a"] },
    ]);
  });
});
