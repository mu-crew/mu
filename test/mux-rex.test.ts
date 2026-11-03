// The Rex mux backend. Fast tier: every reply is shaped like a real Rex
// 0.0.1793645657 server's (`rex api call …`), no subprocess, no server.

import { afterEach, describe, expect, it } from "vitest";
import {
  attachCommands,
  capture,
  ensureSession,
  isValidPaneId,
  killPane,
  killSession,
  listPanes,
  paneAlive,
  paneResult,
  paneStatus,
  RexError,
  rexBackend,
  sendToPane,
  spawnAgent,
} from "../src/mux/rex.js";
import { withEnv } from "./_env.js";
import { installMux, type MuxHarness } from "./_mux.js";

const SID = "session:01a1a0d3-ec66-7aa6-9558-c70476578a93";
const WID = "window:01a1a0d4-b5a8-7c1d-97a3-87bb9c0ba316";
const BID = "block:01a1a0d4-b59b-7416-9cdb-67e9cd36dd6b";
const BID2 = "block:01a1a0d5-ddc6-77e3-96ce-0c7397785c36";

const json = (v: unknown): string => JSON.stringify(v);
const SESSIONS = json({ sessions: [{ session_id: SID, label: "mu-auth" }] });
const NO_SESSIONS = json({ sessions: [] });
const RESOLVED = json({
  results: [
    {
      query: BID,
      status: "resolved",
      target: { kind: "block", session_id: SID, window_id: WID, block_id: BID },
    },
  ],
});
const UNRESOLVED = json({ results: [{ query: BID, status: "not_found" }] });
const VIEW = (labels: string[]) =>
  json({
    session_id: SID,
    label: "mu-auth",
    windows: labels.map((label, i) => ({ window_id: i === 0 ? WID : `${WID}x`, label })),
  });
const NOT_FOUND = {
  stdout: "",
  stderr: `Error: stream response "control-2" failed: block not found: ${BID} (status=404 code=not_found)`,
  exitCode: 3,
};

/** The parsed JSON input of the n-th `api call <method>`. */
function apiInput(mux: MuxHarness, method: string, n = 0): Record<string, unknown> {
  const call = mux.calls.filter((c) => c[0] === "api" && c[2] === method)[n];
  if (call === undefined) throw new Error(`no api call ${method} #${n}`);
  return JSON.parse(call[3] ?? "{}") as Record<string, unknown>;
}

let mux: MuxHarness | undefined;
afterEach(() => mux?.restore());

describe("rex pane ids", () => {
  it("accepts block uuids only", () => {
    expect(isValidPaneId(BID)).toBe(true);
    expect(isValidPaneId("%15")).toBe(false);
    expect(isValidPaneId("w1:p1")).toBe(false);
    expect(isValidPaneId("block:shell")).toBe(false);
  });
});

describe("rex reply shapes", () => {
  it("a reply missing its required list throws instead of reading as empty", async () => {
    mux = installMux("rex", [["api call session.list", "{}"]]);
    await expect(listPanes("mu-auth")).rejects.toBeInstanceOf(RexError);
  });

  it("an empty target.resolve result throws: a liveness probe fails closed", async () => {
    mux = installMux("rex", [["api call target.resolve", json({ results: [] })]]);
    await expect(paneAlive(BID)).rejects.toBeInstanceOf(RexError);
  });

  it("an empty reply is an error, not an empty object", async () => {
    mux = installMux("rex", [["api call session.list", ""]]);
    await expect(ensureSession("mu-auth")).rejects.toBeInstanceOf(RexError);
  });

  it("listPanes propagates a block failure that is not 'gone'", async () => {
    mux = installMux("rex", [
      ["api call session.list_blocks", json({ blocks: [{ block_id: BID, window_id: WID }] })],
      ["api call session.list", SESSIONS],
      ["api call block.method", { stdout: "", stderr: "timeout", exitCode: 1 }],
    ]);
    await expect(listPanes("mu-auth")).rejects.toBeInstanceOf(RexError);
  });
});

describe("rex sessions", () => {
  it("creates a missing session with its _mu window in one call", async () => {
    mux = installMux("rex", [
      ["api call session.list", NO_SESSIONS],
      ["api call session.create", json({ session_id: SID })],
    ]);
    expect(await ensureSession("mu-auth")).toEqual({ created: true, repaired: false });
    const input = apiInput(mux, "session.create");
    expect(input.label).toBe("mu-auth");
    expect(input.initial_windows).toEqual([
      { window_label: "_mu", layout: { block: expect.objectContaining({ label: "_mu" }) } },
    ]);
  });

  it("re-adds a missing _mu window without stealing focus", async () => {
    mux = installMux("rex", [
      ["api call session.list", SESSIONS],
      ["api call session.view", VIEW(["agents"])],
      ["api call session.new_window", json({ window_id: WID, block_ids: [BID] })],
    ]);
    expect(await ensureSession("mu-auth")).toEqual({ created: false, repaired: true });
    expect(apiInput(mux, "session.new_window")).toMatchObject({
      focus: false,
      window_label: "_mu",
    });
  });

  it("kill is idempotent and closes every session with the label", async () => {
    mux = installMux("rex", [["api call session.list", NO_SESSIONS]]);
    await killSession("mu-auth");
    expect(mux.calls).toHaveLength(1);
    mux.restore();
    const two = json({
      sessions: [
        { session_id: SID, label: "mu-auth" },
        { session_id: `${SID}2`, label: "mu-auth" },
      ],
    });
    mux = installMux("rex", [
      ["api call session.list", two],
      ["api call session.destroy", "{}"],
    ]);
    await killSession("mu-auth");
    expect(mux.calls.filter((c) => c[2] === "session.destroy")).toHaveLength(2);
  });

  it("a racing create converges on the first session and destroys its own copy", async () => {
    let lists = 0;
    mux = installMux("rex", async (args) => {
      if (args[2] === "session.list") {
        lists += 1;
        return {
          stdout:
            lists === 1
              ? NO_SESSIONS
              : json({
                  sessions: [
                    { session_id: SID, label: "mu-auth" },
                    { session_id: `${SID}2`, label: "mu-auth" },
                  ],
                }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[2] === "session.create") {
        return { stdout: json({ session_id: `${SID}2` }), stderr: "", exitCode: 0 };
      }
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });
    expect(await ensureSession("mu-auth")).toEqual({ created: false, repaired: false });
    expect(apiInput(mux, "session.destroy")).toEqual({ session_id: `${SID}2` });
  });
});

describe("rex spawnAgent", () => {
  const opts = {
    session: "mu-auth",
    window: "agents",
    name: "alice",
    cli: "pi",
    command: "pi --model x",
    commandSource: "cli-key" as const,
    cwd: "/repo",
    env: { MU_AGENT_NAME: "alice" },
  };

  it("opens a background window running the command in the user's interactive shell", async () => {
    mux = installMux("rex", [
      ["api call session.list", SESSIONS],
      ["api call session.view", VIEW(["_mu"])],
      ["api call session.new_window", json({ window_id: WID, block_ids: [BID] })],
    ]);
    const created: string[] = [];
    let id: string | undefined;
    await withEnv("SHELL", "/bin/zsh", async () => {
      id = await spawnAgent({ ...opts, onPaneCreated: (p) => created.push(p) });
    });
    expect(id).toBe(BID);
    expect(created).toEqual([BID]);
    const input = apiInput(mux, "session.new_window");
    expect(input).toMatchObject({ session_id: SID, window_label: "agents", focus: false });
    expect(input.layout).toEqual({
      block: {
        flavor: "com.superlogical.terminal.shell",
        label: "alice",
        options: {
          command: ["env", "MU_AGENT_NAME=alice", "/bin/zsh", "-ic", "pi --model x"],
          cwd: "/repo",
          size: { columns: 200, rows: 50 },
          exit: { quick_exit_threshold_ms: 0 },
        },
      },
    });
  });

  it("splits an existing window, and arms retention at creation", async () => {
    mux = installMux("rex", [
      ["api call session.list", SESSIONS],
      ["api call session.view", VIEW(["agents", "_mu"])],
      ["api call session.new_split", json({ block_ids: [BID2] })],
    ]);
    expect(await spawnAgent({ ...opts, retainOnExit: true })).toBe(BID2);
    const input = apiInput(mux, "session.new_split");
    expect(input).toMatchObject({ window_id: WID, direction: "horizontal", focus: false });
    expect(input.layout).toMatchObject({
      block: { options: { exit: { on_completion: false } } },
    });
  });
});

describe("rex panes", () => {
  it("lists blocks with the foreground program's argv0", async () => {
    mux = installMux("rex", [
      ["api call session.list_blocks", json({ blocks: [{ block_id: BID, window_id: WID }] })],
      ["api call session.list", SESSIONS],
      [
        "api call block.method",
        json({ child: { pid: 7 }, foreground: { name: "node", argv0: "pi" } }),
      ],
    ]);
    expect(await listPanes("mu-auth")).toEqual([{ paneId: BID, command: "pi", windowId: WID }]);
  });

  it("lists nothing for a missing session", async () => {
    mux = installMux("rex", [["api call session.list", NO_SESSIONS]]);
    expect(await listPanes("mu-auth")).toEqual([]);
  });

  it("alive is false only for a block Rex reports gone", async () => {
    mux = installMux("rex", [["api call target.resolve", UNRESOLVED]]);
    expect(await paneAlive(BID)).toBe(false);
    mux.restore();
    mux = installMux("rex", [
      ["api call target.resolve", { stdout: "", stderr: "boom", exitCode: 4 }],
    ]);
    await expect(paneAlive(BID)).rejects.toBeInstanceOf(RexError);
  });

  it("kill is idempotent", async () => {
    mux = installMux("rex", [["api call target.resolve", UNRESOLVED]]);
    await killPane(BID);
    expect(mux.calls.some((c) => c[2] === "block.close")).toBe(false);
  });

  it.each([
    [{ child: { pid: 7 }, last_exit: null }, { state: "running" }],
    [
      { last_exit: { exit_code: 7, error: "exit status 7" } },
      { state: "exited", code: 7, signal: null },
    ],
    [
      { last_exit: { exit_code: -1, error: "signal: killed" } },
      { state: "exited", code: null, signal: 9 },
    ],
    [
      { last_exit: { exit_code: -1, error: "signal: segmentation fault" } },
      { state: "exited", code: null, signal: 11 },
    ],
    [
      { last_exit: { exit_code: -1, error: "something new" } },
      { state: "exited", code: 1, signal: null },
    ],
  ])("paneResult reads %j", async (process, expected) => {
    mux = installMux("rex", [
      ["api call target.resolve", RESOLVED],
      ["api call block.method", json(process)],
    ]);
    expect(await paneResult(BID)).toEqual(expected);
  });

  it("paneResult is absent when the block is gone between lookup and call", async () => {
    mux = installMux("rex", [
      ["api call target.resolve", RESOLVED],
      ["api call block.method", NOT_FOUND],
    ]);
    expect(await paneResult(BID)).toEqual({ state: "absent" });
  });
});

describe("rex paneStatus (OSC 7501 records)", () => {
  const AGENT = { pid: 7, name: "pi" };
  const status = async (records: unknown[]) => {
    mux?.restore();
    mux = installMux("rex", async (args) => {
      const input = JSON.parse(args[3] ?? "{}") as { method?: string };
      if (args[2] === "target.resolve") return { stdout: RESOLVED, stderr: "", exitCode: 0 };
      const reply = input.method === "process" ? { child: AGENT, foreground: AGENT } : { records };
      return { stdout: json(reply), stderr: "", exitCode: 0 };
    });
    return paneStatus(BID);
  };

  it("maps the root record and blocked kinds", async () => {
    expect(await status([{ state: "working", app: "pi" }])).toBe("busy");
    expect(await status([{ state: "done", app: "pi" }])).toBe("needs_input");
    expect(await status([{ state: "blocked", kind: "permission" }])).toBe("needs_permission");
    expect(await status([{ state: "blocked", kind: "question" }])).toBe("needs_input");
    expect(await status([])).toBeUndefined();
  });

  it("a blocked child record outranks a working root", async () => {
    expect(
      await status([
        { state: "working", app: "deploy" },
        { id: "eu-west", state: "blocked", kind: "permission" },
      ]),
    ).toBe("needs_permission");
  });

  it("ignores reports from tools the agent runs", async () => {
    expect(
      await status([{ state: "idle", app: "cargo", owner: { pid: 99, name: "cargo" } }]),
    ).toBeUndefined();
    expect(
      await status([
        { state: "working", app: "pi", owner: AGENT },
        { id: "x", state: "blocked", kind: "permission", owner: { pid: 99, name: "cargo" } },
      ]),
    ).toBe("busy");
  });

  it("asks the terminal for program_status in the block's own session", async () => {
    await status([]);
    const calls = (mux as MuxHarness).calls
      .filter((c) => c[2] === "block.method")
      .map((c) => JSON.parse(c[3] ?? "{}") as Record<string, unknown>);
    expect(calls).toContainEqual({
      session_id: SID,
      block_id: BID,
      method: "program_status",
      args: {},
    });
  });
});

describe("rex send, capture, attach", () => {
  const sendRoutes = (bracketed: boolean) => async (args: readonly string[]) => {
    const input = JSON.parse(args[3] ?? "{}") as { method?: string };
    if (args[2] === "target.resolve") return { stdout: RESOLVED, stderr: "", exitCode: 0 };
    const reply =
      input.method === "modes"
        ? { modes: [{ name: "bracketed_paste", number: 2004, set: bracketed }] }
        : input.method === "write"
          ? { bytes_written: 1 }
          : {};
    return { stdout: json(reply), stderr: "", exitCode: 0 };
  };

  it("sends one paste, then a written carriage return", async () => {
    mux = installMux("rex", sendRoutes(true));
    await sendToPane(BID, "line one\nline two");
    expect(apiInput(mux, "block.event").event).toEqual({
      type: "paste",
      payload: { text: "line one\nline two" },
    });
    const write = mux.calls
      .map((c) => JSON.parse(c[3] ?? "{}") as Record<string, unknown>)
      .find((i) => i.method === "write");
    expect(write?.args).toEqual({ data: "\r" });
  });

  it("refuses a multi-line send when the program has no bracketed paste", async () => {
    mux = installMux("rex", sendRoutes(false));
    await expect(sendToPane(BID, "a\nb")).rejects.toThrow(/bracketed paste/);
    expect(mux.calls.some((c) => c[2] === "block.event")).toBe(false);
  });

  it("a send to a gone block throws", async () => {
    mux = installMux("rex", [["api call target.resolve", UNRESOLVED]]);
    await expect(sendToPane(BID, "hi")).rejects.toBeInstanceOf(RexError);
  });

  it("captures like tmux: all, last n ending at the last non-blank line, or the screen", async () => {
    const routes = (text: string) =>
      installMux("rex", [
        ["api call target.resolve", RESOLVED],
        ["api call block.method", json({ rows: 2, columns: 80 })],
        ["capture", text],
      ]);
    mux = routes("a\nb\nc\n\n");
    expect(await capture(BID)).toBe("a\nb\nc\n\n");
    expect(await capture(BID, { lines: 2 })).toBe("b\nc\n");
    expect(mux.calls.at(-1)).toEqual(["capture", "-s", SID, "-b", BID]);
    mux.restore();
    mux = routes("a\nb\nc");
    expect(await capture(BID, { lines: 0 })).toBe("b\nc");
  });

  it("attaches by asking the app to select the session and window", async () => {
    mux = installMux("rex", [
      ["api call session.list", SESSIONS],
      ["api call session.view", VIEW(["agents"])],
    ]);
    expect(await attachCommands({ session: "mu-auth", window: "agents" })).toEqual([
      {
        command: "rex",
        args: ["do", "session.select", `session_id=${SID}`, `window_id=${WID}`],
      },
    ]);
  });

  it("routes every call to MU_REX_SERVER when set", async () => {
    mux = installMux("rex", [["api call session.list", SESSIONS]]);
    let steps: readonly { args: readonly string[] }[] = [];
    await withEnv("MU_REX_SERVER", "unix:///tmp/r.sock", async () => {
      steps = await attachCommands({ session: "mu-auth" });
    });
    expect(steps[0]?.args.slice(0, 2)).toEqual(["-S", "unix:///tmp/r.sock"]);
  });

  it("is a full backend record", () => {
    expect(rexBackend.name).toBe("rex");
    expect(rexBackend.runsShellCommand).toBe(true);
    expect(rexBackend.paneStatus).toBeDefined();
    expect(rexBackend.sendToPane).toBeDefined();
  });
});
