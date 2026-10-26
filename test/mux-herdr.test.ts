// The herdr mux backend, topology half.
//
// Fast tier: every response is a recorded fixture from test/_mux-fixtures.ts
// (verbatim captures from a real herdr 0.8.0 server, protocol 19). No
// subprocess, no server, no sleeps. The backend + executor pair is
// installed through the shared seam in test/_mux.ts, so this file never
// has to know that "testing herdr" means calling two setters.

import { afterEach, describe, expect, it } from "vitest";
import { classifyError } from "../src/cli/handle.js";
import {
  HerdrError,
  HerdrSyntaxError,
  HerdrWorkspaceGroupCloseError,
  herdrBackend,
  isHerdrStatusUsable,
  isValidPaneId,
  listPanes,
} from "../src/mux/herdr.js";
import { attachShellLine } from "../src/mux/types.js";
import { withEnv } from "./_env.js";
import { installMux, type MuxExecResult, type MuxExecutor, type MuxHarness } from "./_mux.js";
import {
  OK,
  PANE_GET,
  PANE_LIST,
  PANE_NOT_FOUND,
  STATUS_INCOMPATIBLE,
  STATUS_LEGACY_INCOMPATIBLE,
  STATUS_PRIVATE_PROTOCOL_SKEW,
  STATUS_RUNNING,
  STATUS_STOPPED,
  TAB_CREATED,
  TAB_LIST,
  WORKSPACE_CREATED,
  WORKSPACE_GROUP_CLOSE_REQUIRED,
  WORKSPACE_LIST,
  WORKSPACE_LIST_EMPTY,
  WORKSPACE_NOT_FOUND,
} from "./_mux-fixtures.js";

// ─── Executor harness ──────────────────────────────────────────────────

let harness: MuxHarness | undefined;

/** Install the herdr backend with a prefix-routed executor. */
function mockHerdr(routes: Array<[string, MuxExecResult | string]>): MuxHarness {
  harness = installMux("herdr", routes);
  return harness;
}

/** Install an executor with arbitrary behaviour (throwing, counting). */
function mockHerdrWith(executor: MuxExecutor): MuxHarness {
  harness = installMux("herdr", executor);
  return harness;
}

const serverError = (payload: string): MuxExecResult => ({
  stdout: "",
  stderr: payload,
  exitCode: 1,
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
});

// ─── Pane id validation ────────────────────────────────────────────────

describe("herdr pane-id validation", () => {
  it("accepts herdr's workspace-qualified pane ids", () => {
    expect(isValidPaneId("w1:p1")).toBe(true);
    expect(isValidPaneId("w12:p345")).toBe(true);
  });

  it("REJECTS tmux pane ids", () => {
    // The mirror of the tmux backend's `isValidPaneId("w1:p1") === false`
    // assertion in mux-detect.test.ts. This pair is the whole reason
    // pane-id validation is a backend method and not a global regex:
    // a %15 leaking into a herdr call must fail at the call site.
    expect(herdrBackend.isValidPaneId("%15")).toBe(false);
    expect(herdrBackend.isValidPaneId("%0")).toBe(false);
  });

  it("rejects near-misses: bare ordinals, tab ids, workspace ids", () => {
    expect(isValidPaneId("0")).toBe(false);
    expect(isValidPaneId("w1")).toBe(false);
    expect(isValidPaneId("w1:t1")).toBe(false);
    expect(isValidPaneId("p1")).toBe(false);
    expect(isValidPaneId("w1:p1 ")).toBe(false);
    expect(isValidPaneId("")).toBe(false);
  });

  it("assertValidPaneId throws a TypeError naming the expected shape", () => {
    expect(() => herdrBackend.assertValidPaneId("%15")).toThrow(/invalid herdr pane id/);
  });
});

// ─── Exit codes ────────────────────────────────────────────────────────

describe("herdr exit-code mapping", () => {
  it("exit 2 (syntax) is a PROGRAMMING error, not a substrate failure", async () => {
    // If CLI drift after a herdr upgrade were bucketed as MuxError, it
    // would render as "herdr is down" and send the operator chasing a
    // healthy server. It must read as a bug in mu instead.
    const { MuxError } = await import("../src/mux/types.js");
    mockHerdr([
      ["", { stdout: "herdr pane commands:\n  herdr pane list", stderr: "", exitCode: 2 }],
    ]);
    const err = await listPanes("mu-topotest").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrSyntaxError);
    expect(err).not.toBeInstanceOf(MuxError);
    expect(err).not.toBeInstanceOf(HerdrError);
  });

  it("the exit-2 message says it is a bug in mu and echoes the command", async () => {
    mockHerdr([["", { stdout: "usage: ...", stderr: "", exitCode: 2 }]]);
    await expect(listPanes("mu-topotest")).rejects.toThrow(/bug in mu, not a herdr outage/);
    await expect(listPanes("mu-topotest")).rejects.toThrow(/herdr workspace list/);
  });

  it("exit 1 with a JSON error envelope is a HerdrError carrying the code", async () => {
    mockHerdr([["workspace list", serverError(WORKSPACE_NOT_FOUND)]]);
    const err = await listPanes("mu-topotest").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    if (!(err instanceof HerdrError)) throw new Error("unreachable");
    expect(err.code).toBe("workspace_not_found");
    // The human-readable half of the envelope, not the raw JSON.
    expect(err.message).toContain("workspace w99 not found");
  });

  it("HerdrError is a MuxError, so handle() maps it to exit 5 for free", async () => {
    const { MuxError } = await import("../src/mux/types.js");
    mockHerdr([["workspace list", serverError(WORKSPACE_NOT_FOUND)]]);
    await expect(listPanes("mu-topotest")).rejects.toBeInstanceOf(MuxError);
  });

  it("a zero exit with unparseable stdout is a substrate error, not a crash", async () => {
    mockHerdr([
      ["workspace list", { stdout: "<html>proxy error</html>", stderr: "", exitCode: 0 }],
    ]);
    await expect(listPanes("mu-topotest")).rejects.toBeInstanceOf(HerdrError);
  });
});

describe("HerdrError message", () => {
  it("falls back to stdout when stderr is empty (zero-exit, non-JSON stdout)", () => {
    const err = new HerdrError(["workspace", "list"], "", "<html>proxy error</html>", 0);
    expect(err.message).toBe("herdr workspace list failed (exit 0): <html>proxy error</html>");
  });

  it("prefers the JSON envelope message, then raw stderr", () => {
    expect(new HerdrError(["pane", "get"], PANE_NOT_FOUND, "out", 1).message).toContain(
      "pane w9:p9 not found",
    );
    expect(new HerdrError(["x"], "boom\n", "out", 1).message).toBe("herdr x failed (exit 1): boom");
    expect(new HerdrError(["x"], "", "", 1).message).toBe("herdr x failed (exit 1): no output");
  });
});

// ─── Workspaces = mu sessions ──────────────────────────────────────────

describe("herdr sessions (= workspaces, addressed by label)", () => {
  it("ensureSession creates a missing workspace and labels its first tab _mu", async () => {
    // mu finds tabs by window name: attach, `--tab` reuse, init's `_mu`.
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST_EMPTY],
      ["workspace create", WORKSPACE_CREATED],
      ["tab rename", OK],
    ]);
    expect(await herdrBackend.ensureSession("mu-topotest")).toEqual({
      created: true,
      repaired: false,
    });
    // Never steals focus.
    expect(calls.argsOf(1)).toEqual([
      "workspace",
      "create",
      "--label",
      "mu-topotest",
      "--no-focus",
    ]);
    expect(calls.argsOf(2)).toEqual(["tab", "rename", "w1:t1", "_mu"]);
  });

  it("ensureSession closes the new workspace when the first-tab rename fails, then rethrows", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST_EMPTY],
      ["workspace create", WORKSPACE_CREATED],
      ["tab rename", serverError('{"error":{"code":"server_error","message":"boom"}}')],
      ["workspace close", OK],
    ]);
    await expect(herdrBackend.ensureSession("mu-topotest")).rejects.toThrow(/tab rename/);
    expect(calls.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "workspace list",
      "workspace create",
      "tab rename",
      "workspace close",
    ]);
    expect(calls.argsOf(3)).toEqual(["workspace", "close", "w1"]);
  });

  it("ensureSession leaves a workspace that already holds _mu alone", async () => {
    const withMu = TAB_LIST.replace('"label":"1"', '"label":"_mu"');
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["tab list", withMu],
    ]);
    expect(await herdrBackend.ensureSession("mu-topotest")).toEqual({
      created: false,
      repaired: false,
    });
    expect(calls.calls).toHaveLength(2);
  });

  it("ensureSession re-adds a missing _mu tab", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["tab list", TAB_LIST],
      ["tab create", TAB_CREATED],
    ]);
    expect(await herdrBackend.ensureSession("mu-topotest")).toEqual({
      created: false,
      repaired: true,
    });
    expect(calls.argsOf(2)).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--label",
      "_mu",
      "--no-focus",
    ]);
  });

  it("killSession resolves the label to an id, then closes it", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["workspace close", OK],
    ]);
    await herdrBackend.killSession("mu-topotest");
    expect(calls.argsOf(1)).toEqual(["workspace", "close", "w1"]);
  });

  it("killSession is idempotent for a workspace that is already gone", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    await expect(herdrBackend.killSession("mu-vanished")).resolves.toBeUndefined();
  });

  it("killSession tolerates a workspace closing between list and close", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["workspace close", serverError(WORKSPACE_NOT_FOUND)],
    ]);
    await expect(herdrBackend.killSession("mu-topotest")).resolves.toBeUndefined();
  });

  // herdr 0.9.0: closing a workspace that has linked worktree
  // workspaces needs explicit group intent. Those siblings are not
  // mu's, so mu refuses instead of retrying with --group.
  it("killSession refuses a group close rather than retrying with --group", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["workspace close", serverError(WORKSPACE_GROUP_CLOSE_REQUIRED)],
    ]);
    await expect(herdrBackend.killSession("mu-topotest")).rejects.toBeInstanceOf(
      HerdrWorkspaceGroupCloseError,
    );
    // Exactly two calls: the list and the ONE refused close. No retry.
    expect(calls.calls.length).toBe(2);
    expect(calls.argsOf(1)).toEqual(["workspace", "close", "w1"]);
  });

  it("the group-close refusal names the workspace and offers next steps", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["workspace close", serverError(WORKSPACE_GROUP_CLOSE_REQUIRED)],
    ]);
    const err = await herdrBackend.killSession("mu-topotest").catch((e: unknown) => e);
    if (!(err instanceof HerdrWorkspaceGroupCloseError)) throw new Error("expected the refusal");
    expect(err.workspaceId).toBe("w1");
    expect(err.session).toBe("mu-topotest");
  });

  it("the group-close refusal exits 2 (usage), not 5 (mux down)", () => {
    // The substrate is healthy and answered precisely; only the
    // operator can decide whether the sibling workspaces may die.
    expect(
      classifyError(new HerdrWorkspaceGroupCloseError("mu-alpha", "w1", "linked")).exitCode,
    ).toBe(2);
  });
});

// ─── Panes = mu agents ─────────────────────────────────────────────────

describe("herdr panes", () => {
  it("listPanes resolves the label and reads pane ids, window ids and commands", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["pane list", PANE_LIST],
    ]);
    expect(await listPanes("mu-topotest")).toEqual([
      { paneId: "w1:p1", command: "", windowId: "w1:t1" },
      { paneId: "w1:p2", command: "", windowId: "w1:t2" },
    ]);
  });

  it("listPanes returns [] for a vanished workspace, like tmux does", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    expect(await listPanes("mu-gone")).toEqual([]);
  });

  it("listPanes propagates a server failure: reconcile must not read it as zero panes", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      [
        "pane list",
        serverError(JSON.stringify({ error: { code: "server_busy", message: "try later" } })),
      ],
    ]);
    await expect(listPanes("mu-topotest")).rejects.toBeInstanceOf(HerdrError);
  });

  it("killPane is idempotent when the pane is already gone", async () => {
    mockHerdr([["pane close", serverError(PANE_NOT_FOUND)]]);
    await expect(herdrBackend.killPane("w1:p9")).resolves.toBeUndefined();
  });

  it("killPane still propagates unexpected server errors", async () => {
    mockHerdr([
      [
        "pane close",
        serverError(JSON.stringify({ error: { code: "server_busy", message: "try later" } })),
      ],
    ]);
    await expect(herdrBackend.killPane("w1:p1")).rejects.toBeInstanceOf(HerdrError);
  });

  it("paneAlive is true for a live pane and false for a missing one", async () => {
    mockHerdr([["pane get w1:p1", PANE_GET]]);
    expect(await herdrBackend.paneAlive("w1:p1")).toBe(true);
    mockHerdr([["pane get", serverError(PANE_NOT_FOUND)]]);
    expect(await herdrBackend.paneAlive("w1:p9")).toBe(false);
  });

  it("paneAlive is false for a tmux id without shelling out", async () => {
    const calls = mockHerdr([["", OK]]);
    expect(await herdrBackend.paneAlive("%15")).toBe(false);
    expect(calls.calls).toHaveLength(0);
  });

  it("a pane's detected agent kind is its command, so reconcile can spot herdr orphans", async () => {
    const withAgent = JSON.stringify({
      id: "cli:pane:list",
      result: {
        panes: [
          { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "claude" },
          { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" },
        ],
        type: "pane_list",
      },
    });
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["pane list", withAgent],
    ]);
    const panes = await listPanes("mu-topotest");
    expect(panes.map((p) => p.command)).toEqual(["claude", ""]);
  });
});

describe("herdrBackend.available", () => {
  it("is true when the server reports running and compatible", async () => {
    mockHerdr([["status", { stdout: STATUS_RUNNING, stderr: "", exitCode: 0 }]]);
    expect(await herdrBackend.available()).toBe(true);
  });

  it("is false when the binary exists but no server is running", async () => {
    // A herdr with a dead server cannot drive a single pane, so it is
    // not an available backend — the same rule tmux -V encodes.
    mockHerdr([["status", { stdout: STATUS_STOPPED, stderr: "", exitCode: 0 }]]);
    expect(await herdrBackend.available()).toBe(false);
  });

  it("is false when the server predates the stable endpoint generation", async () => {
    mockHerdr([
      [
        "status",
        {
          stdout: STATUS_INCOMPATIBLE,
          stderr: "",
          exitCode: 0,
        },
      ],
    ]);
    expect(await herdrBackend.available()).toBe(false);
  });

  // herdr ≤0.8.x printed one `compatible:` line. Still honoured, so an
  // old incompatible server does not become "available" by omission.
  it("is false for a pre-0.9 server reporting compatible: no", async () => {
    mockHerdr([["status", { stdout: STATUS_LEGACY_INCOMPATIBLE, stderr: "", exitCode: 0 }]]);
    expect(await herdrBackend.available()).toBe(false);
  });

  // Since 0.9.0 private-protocol skew disables individual ACTIONS and
  // leaves running agents alone, so it must not gate the backend: a
  // client one release ahead of its server still drives panes.
  it("is true when only the private protocol is incompatible", async () => {
    mockHerdr([["status", { stdout: STATUS_PRIVATE_PROTOCOL_SKEW, stderr: "", exitCode: 0 }]]);
    expect(await herdrBackend.available()).toBe(true);
  });

  it("isHerdrStatusUsable ignores the client block's own compatibility lines", () => {
    // The client block has no compatibility lines at all, and the
    // `endpoint_` / `private_protocol_` prefixes must not be mistaken
    // for the legacy bare `compatible:` key.
    expect(isHerdrStatusUsable(STATUS_RUNNING)).toBe(true);
    expect(isHerdrStatusUsable(STATUS_STOPPED)).toBe(false);
    expect(isHerdrStatusUsable("")).toBe(false);
    // A running server that reports no compatibility at all is fine:
    // absence of evidence is not incompatibility.
    expect(isHerdrStatusUsable("server:\n  status: running")).toBe(true);
  });

  it("is false when the binary is not installed", async () => {
    mockHerdrWith(async () => {
      throw new Error("ENOENT");
    });
    expect(await herdrBackend.available()).toBe(false);
  });
});

// ─── Attach ────────────────────────────────────────────────────────────

describe("herdr attach (focus a workspace or tab, never `session attach <label>`)", () => {
  // `mu-<ws>` is a workspace LABEL. `herdr session attach mu-<ws>` would
  // start a new, empty herdr SERVER under that name.
  const HERDR_ENV = "HERDR_ENV";
  const HERDR_SESSION = "MU_HERDR_SESSION";

  it("from outside herdr, focuses the agent's tab and then opens a client", async () => {
    await withEnv(HERDR_ENV, undefined, async () => {
      mockHerdr([
        ["workspace list", WORKSPACE_LIST],
        ["tab list --workspace w1", TAB_LIST],
      ]);
      const target = { session: "mu-topotest", window: "mytab" };
      expect(attachShellLine(await herdrBackend.attachCommands(target))).toBe(
        "herdr tab focus w1:t2 && herdr",
      );
      expect(await herdrBackend.attachCommands(target)).toEqual([
        { command: "herdr", args: ["tab", "focus", "w1:t2"] },
        { command: "herdr", args: [] },
      ]);
    });
  });

  it("inside a herdr pane, only focuses: the caller's client already shows it", async () => {
    await withEnv(HERDR_ENV, "1", async () => {
      mockHerdr([["workspace list", WORKSPACE_LIST]]);
      expect(await herdrBackend.attachCommands({ session: "mu-topotest" })).toEqual([
        { command: "herdr", args: ["workspace", "focus", "w1"] },
      ]);
    });
  });

  it("falls back to the workspace when no tab carries the window label", async () => {
    await withEnv(HERDR_ENV, "1", async () => {
      mockHerdr([
        ["workspace list", WORKSPACE_LIST],
        ["tab list", TAB_LIST],
      ]);
      expect(await herdrBackend.attachCommands({ session: "mu-topotest", window: "nope" })).toEqual(
        [{ command: "herdr", args: ["workspace", "focus", "w1"] }],
      );
    });
  });

  it("targets the MU_HERDR_SESSION server mu drives", async () => {
    await withEnv(HERDR_ENV, undefined, async () => {
      await withEnv(HERDR_SESSION, "work", async () => {
        mockHerdr([["workspace list", WORKSPACE_LIST]]);
        expect(attachShellLine(await herdrBackend.attachCommands({ session: "mu-topotest" }))).toBe(
          "herdr --session work workspace focus w1 && herdr --session work",
        );
        expect(await herdrBackend.attachCommands({ session: "mu-topotest" })).toEqual([
          { command: "herdr", args: ["--session", "work", "workspace", "focus", "w1"] },
          { command: "herdr", args: ["--session", "work"] },
        ]);
      });
    });
  });

  it("lands on a first-spawn agent's tab after another tab became active", async () => {
    // Stateful server: the workspace's root tab is created as "1"; a later
    // agent's tab "worker-2" is the active one. Attaching to worker-1 must
    // focus ITS tab, not fall back to `workspace focus` (which keeps
    // worker-2 on screen).
    const tabs = [{ tab_id: "w1:t1", label: "1", focused: false }];
    let created = false;
    const res = (stdout: string): MuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
    mockHerdrWith(async (args) => {
      const key = args.join(" ");
      if (key.startsWith("workspace create")) {
        created = true;
        return res(WORKSPACE_CREATED);
      }
      if (key.startsWith("agent start")) return res(OK);
      if (key.startsWith("tab rename")) {
        const tab = tabs.find((t) => t.tab_id === args[2]);
        if (tab !== undefined) tab.label = args[3] ?? "";
        return res(OK);
      }
      if (key.startsWith("workspace list"))
        return res(created ? WORKSPACE_LIST : WORKSPACE_LIST_EMPTY);
      if (key.startsWith("tab list")) {
        const all = [...tabs, { tab_id: "w1:t2", label: "worker-2", focused: true }];
        return res(JSON.stringify({ result: { tabs: all, type: "tab_list" } }));
      }
      return serverError(`unrouted: ${key}`);
    });
    await herdrBackend.spawnAgent({
      session: "mu-topotest",
      window: "worker-1",
      name: "worker-1",
      cli: "pi",
      command: "pi",
      commandSource: "cli-key",
      env: {},
    });
    await withEnv(HERDR_ENV, "1", async () => {
      expect(
        await herdrBackend.attachCommands({ session: "mu-topotest", window: "worker-1" }),
      ).toEqual([{ command: "herdr", args: ["tab", "focus", "w1:t1"] }]);
    });
  });

  it("an unknown label: attachCommands throws, callers omit the line", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    await expect(herdrBackend.attachCommands({ session: "mu-gone" })).rejects.toBeInstanceOf(
      HerdrError,
    );
  });
});

describe("sendToPane empty text", () => {
  it("refuses an empty send without calling herdr", async () => {
    const { sendToPane } = await import("../src/mux/herdr.js");
    await expect(sendToPane("w1:p1", "")).rejects.toThrow(/empty message/);
  });
});
