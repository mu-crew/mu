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
  HerdrNotImplementedError,
  HerdrSyntaxError,
  HerdrWorkspaceGroupCloseError,
  herdrBackend,
  isHerdrStatusUsable,
  isValidPaneId,
  listPanesInSession,
  listSessions,
  listWindows,
  newSession,
  newWindow,
  paneExists,
  sessionExists,
  setPaneTitle,
  splitWindow,
} from "../src/mux/herdr.js";
import { PaneNotFoundError } from "../src/mux/types.js";
import { withEnv } from "./_env.js";
import { installMux, type MuxExecResult, type MuxExecutor, type MuxHarness } from "./_mux.js";
import {
  OK,
  PANE_GET,
  PANE_LIST,
  PANE_NOT_FOUND,
  PANE_SPLIT,
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
    const err = await listSessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrSyntaxError);
    expect(err).not.toBeInstanceOf(MuxError);
    expect(err).not.toBeInstanceOf(HerdrError);
  });

  it("the exit-2 message says it is a bug in mu and echoes the command", async () => {
    mockHerdr([["", { stdout: "usage: ...", stderr: "", exitCode: 2 }]]);
    await expect(listSessions()).rejects.toThrow(/bug in mu, not a herdr outage/);
    await expect(listSessions()).rejects.toThrow(/herdr workspace list/);
  });

  it("exit 1 with a JSON error envelope is a HerdrError carrying the code", async () => {
    mockHerdr([["workspace list", serverError(WORKSPACE_NOT_FOUND)]]);
    const err = await listSessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    if (!(err instanceof HerdrError)) throw new Error("unreachable");
    expect(err.code).toBe("workspace_not_found");
    // The human-readable half of the envelope, not the raw JSON.
    expect(err.message).toContain("workspace w99 not found");
  });

  it("HerdrError is a MuxError, so handle() maps it to exit 5 for free", async () => {
    const { MuxError } = await import("../src/mux/types.js");
    mockHerdr([["workspace list", serverError(WORKSPACE_NOT_FOUND)]]);
    await expect(listSessions()).rejects.toBeInstanceOf(MuxError);
  });

  it("a zero exit with unparseable stdout is a substrate error, not a crash", async () => {
    mockHerdr([
      ["workspace list", { stdout: "<html>proxy error</html>", stderr: "", exitCode: 0 }],
    ]);
    await expect(listSessions()).rejects.toBeInstanceOf(HerdrError);
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
  it("listSessions maps workspace labels to session names", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST]]);
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });

  it("listSessions returns [] when no workspaces exist", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    expect(await listSessions()).toEqual([]);
  });

  it("sessionExists matches on label, not on the opaque workspace id", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST]]);
    expect(await sessionExists("mu-topotest")).toBe(true);
    expect(await sessionExists("w1")).toBe(false);
    expect(await sessionExists("mu-other")).toBe(false);
  });

  it("newSession labels the workspace and never steals focus", async () => {
    const calls = mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await newSession("mu-auth", { cwd: "/repo" });
    expect(calls.argsOf(0)).toEqual([
      "workspace",
      "create",
      "--label",
      "mu-auth",
      "--no-focus",
      "--cwd",
      "/repo",
    ]);
  });

  it("newSession passes --no-focus even when the caller asks for attached", async () => {
    // mu must never move the user's focus, so `detached: false` is not
    // honoured on herdr. Regression guard for a plausible "map detached
    // to --focus" refactor.
    const calls = mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await newSession("mu-auth", { detached: false });
    expect(calls.argsOf(0)).toContain("--no-focus");
    expect(calls.argsOf(0)).not.toContain("--focus");
  });

  it("newSession forwards env as --env KEY=VALUE", async () => {
    const calls = mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await newSession("mu-auth", { env: { MU_AGENT_NAME: "w1" } });
    expect(calls.argsOf(0)).toEqual([
      "workspace",
      "create",
      "--label",
      "mu-auth",
      "--no-focus",
      "--env",
      "MU_AGENT_NAME=w1",
    ]);
  });

  it("newSession rejects an env key containing '=' at the call site", async () => {
    mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await expect(newSession("mu-auth", { env: { "A=B": "c" } })).rejects.toBeInstanceOf(TypeError);
  });

  it("newSessionWithPane READS the pane id from the response", async () => {
    // Never predict an id: herdr does not reuse closed ids.
    mockHerdr([
      ["workspace create", WORKSPACE_CREATED],
      ["tab rename", OK],
    ]);
    expect(
      await herdrBackend.newSessionWithPane("mu-topotest", { windowName: "x", command: "" }),
    ).toBe("w1:p1");
  });

  it("labels the implicit first tab with windowName (herdr calls it '1')", async () => {
    // mu finds tabs by window name: attach, `--tab` reuse, init's `_mu`.
    const calls = mockHerdr([
      ["workspace create", WORKSPACE_CREATED],
      ["tab rename", OK],
    ]);
    await herdrBackend.newSessionWithPane("mu-topotest", { windowName: "worker-1", command: "" });
    expect(calls.argsOf(1)).toEqual(["tab", "rename", "w1:t1", "worker-1"]);
    await newSession("mu-topotest", { windowName: "_mu" });
    expect(calls.argsOf(3)).toEqual(["tab", "rename", "w1:t1", "_mu"]);
  });

  it("closes the new workspace when the first-tab rename fails, then rethrows", async () => {
    // Spawn's rollback never sees a pane id here, so the backend must not
    // leave a bare-shell workspace behind.
    for (const create of [
      () => herdrBackend.newSessionWithPane("mu-topotest", { windowName: "worker-1", command: "" }),
      () => newSession("mu-topotest", { windowName: "_mu" }),
    ]) {
      const calls = mockHerdr([
        ["workspace create", WORKSPACE_CREATED],
        ["tab rename", serverError('{"error":{"code":"server_error","message":"boom"}}')],
        ["workspace close", OK],
      ]);
      await expect(create()).rejects.toThrow(/tab rename/);
      expect(calls.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
        "workspace create",
        "tab rename",
        "workspace close",
      ]);
      expect(calls.argsOf(2)).toEqual(["workspace", "close", "w1"]);
      harness?.restore();
      harness = undefined;
    }
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
    const commands = err.errorNextSteps().map((s) => s.command);
    expect(commands.some((c) => c.includes("workspace close w1 --group"))).toBe(true);
  });

  it("the group-close refusal exits 2 (usage), not 5 (mux down)", () => {
    // The substrate is healthy and answered precisely; only the
    // operator can decide whether the sibling workspaces may die.
    expect(
      classifyError(new HerdrWorkspaceGroupCloseError("mu-alpha", "w1", "linked")).exitCode,
    ).toBe(2);
  });
});

// ─── Tabs = mu windows ─────────────────────────────────────────────────

describe("herdr windows (= tabs)", () => {
  it("listWindows resolves the session label and reads tab ids + labels", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["tab list", TAB_LIST],
    ]);
    expect(await listWindows("mu-topotest")).toEqual([
      { id: "w1:t1", name: "1" },
      { id: "w1:t2", name: "mytab" },
    ]);
    expect(calls.argsOf(1)).toEqual(["tab", "list", "--workspace", "w1"]);
  });

  it("listWindows returns [] for a workspace that no longer exists", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    expect(await listWindows("mu-gone")).toEqual([]);
  });

  it("listWindows with no session fans out and tags rows with the label", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["tab list", TAB_LIST],
    ]);
    const windows = await listWindows();
    expect(windows).toHaveLength(2);
    expect(windows[0]?.sessionName).toBe("mu-topotest");
  });

  it("newWindow creates a labelled tab in the resolved workspace", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["tab create", TAB_CREATED],
    ]);
    expect(await newWindow({ session: "mu-topotest", name: "mytab", command: "" })).toBe("w1:p2");
    expect(calls.argsOf(1)).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--label",
      "mytab",
      "--no-focus",
    ]);
  });

  it("newWindow with a command is refused instead of dropped", async () => {
    // Silently ignoring the command would produce an empty shell pane
    // that mu believes is running an agent — the worst failure mode.
    mockHerdr([["workspace list", WORKSPACE_LIST]]);
    await expect(
      newWindow({ session: "mu-topotest", name: "t", command: "pi --yolo" }),
    ).rejects.toBeInstanceOf(HerdrNotImplementedError);
  });

  it("selectLayout is a no-op: herdr splits are explicit", async () => {
    // No executor installed on purpose — a no-op must not shell out.
    mockHerdrWith(async () => {
      throw new Error("selectLayout must not call herdr");
    });
    await expect(herdrBackend.selectLayout("w1:t1", "tiled")).resolves.toBeUndefined();
  });
});

// ─── Panes = mu agents ─────────────────────────────────────────────────

describe("herdr panes", () => {
  it("listPanesInSession resolves the label and tags rows with it", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["pane list", PANE_LIST],
    ]);
    const panes = await listPanesInSession("mu-topotest");
    expect(panes).toEqual([
      {
        paneId: "w1:p1",
        title: "worker-1",
        command: "",
        windowId: "w1:t1",
        sessionName: "mu-topotest",
      },
      { paneId: "w1:p2", title: "", command: "", windowId: "w1:t2", sessionName: "mu-topotest" },
    ]);
  });

  it("listPanesInSession returns [] for a vanished workspace, like tmux does", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    expect(await listPanesInSession("mu-gone")).toEqual([]);
  });

  it("listPanes filters by tab when given a tab id", async () => {
    const calls = mockHerdr([["pane list", PANE_LIST]]);
    expect(await herdrBackend.listPanes("w1:t2")).toEqual([
      { paneId: "w1:p2", title: "", command: "", windowId: "w1:t2" },
    ]);
    // Filtering is client-side: herdr's pane list is workspace-scoped.
    expect(calls.argsOf(0)).toEqual(["pane", "list", "--workspace", "w1"]);
  });

  it("listPanes('*') fans out across every workspace", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["pane list", PANE_LIST],
    ]);
    const panes = await herdrBackend.listPanes("*");
    expect(panes).toHaveLength(2);
    expect(panes[0]?.sessionName).toBe("mu-topotest");
  });

  it("splitWindow defaults to a right split and never steals focus", async () => {
    const calls = mockHerdr([["pane split", PANE_SPLIT]]);
    expect(await splitWindow({ target: "w1:p1", command: "", cwd: "/tmp" })).toBe("w1:p3");
    expect(calls.argsOf(0)).toEqual([
      "pane",
      "split",
      "w1:p1",
      "--direction",
      "right",
      "--no-focus",
      "--cwd",
      "/tmp",
    ]);
  });

  it("splitWindow maps horizontal:false to --direction down", async () => {
    const calls = mockHerdr([["pane split", PANE_SPLIT]]);
    await splitWindow({ target: "w1:p1", command: "", horizontal: false });
    expect(calls.argsOf(0)).toContain("down");
    expect(calls.argsOf(0)).not.toContain("right");
  });

  it("splitWindow rejects a tmux target before it ever reaches herdr", async () => {
    const calls = mockHerdr([["pane split", PANE_SPLIT]]);
    await expect(splitWindow({ target: "%15", command: "" })).rejects.toBeInstanceOf(TypeError);
    expect(calls.calls).toHaveLength(0);
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

  it("paneExists is true for a live pane and false for a missing one", async () => {
    mockHerdr([["pane get w1:p1", PANE_GET]]);
    expect(await paneExists("w1:p1")).toBe(true);
    mockHerdr([["pane get", serverError(PANE_NOT_FOUND)]]);
    expect(await paneExists("w1:p9")).toBe(false);
  });

  it("paneExists is false for a tmux id without shelling out", async () => {
    const calls = mockHerdr([["", OK]]);
    expect(await paneExists("%15")).toBe(false);
    expect(calls.calls).toHaveLength(0);
  });

  it("paneTTY throws PaneNotFoundError when the pane is gone", async () => {
    mockHerdr([["pane process-info", serverError(PANE_NOT_FOUND)]]);
    await expect(herdrBackend.paneTTY("w1:p9")).rejects.toBeInstanceOf(PaneNotFoundError);
    // Named by the backend, with herdr's remediation, not "mux pane not found".
    const err = await herdrBackend.paneTTY("w1:p9").catch((e: unknown) => e);
    expect((err as Error).message).toBe("herdr pane not found: w1:p9");
    expect((err as PaneNotFoundError).errorNextSteps()[0]?.command).toBe("herdr pane get w1:p9");
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
    const panes = await listPanesInSession("mu-topotest");
    expect(panes.map((p) => p.command)).toEqual(["claude", ""]);
  });
});

// ─── Identity ──────────────────────────────────────────────────────────

describe("herdr identity", () => {
  it("setPaneTitle writes herdr's pane label", async () => {
    const calls = mockHerdr([["pane rename", PANE_GET]]);
    await setPaneTitle("w1:p1", "worker-2 · ⏳ · t-17");
    expect(calls.argsOf(0)).toEqual(["pane", "rename", "w1:p1", "worker-2 · ⏳ · t-17"]);
  });

  it("getPaneTitle reads the label back", async () => {
    mockHerdr([["pane get", PANE_GET]]);
    expect(await herdrBackend.getPaneTitle("w1:p1")).toBe("mylabel");
  });

  it("getPaneTitle returns undefined for an unlabelled or missing pane", async () => {
    mockHerdr([["pane get", serverError(PANE_NOT_FOUND)]]);
    expect(await herdrBackend.getPaneTitle("w1:p9")).toBeUndefined();
    expect(await herdrBackend.getPaneTitle("%15")).toBeUndefined();
  });

  it("currentAgentName parses the name token out of a composed title", async () => {
    mockHerdr([
      [
        "pane get",
        JSON.stringify({
          result: { pane: { pane_id: "w1:p1", label: "worker-2 · ⏳ · t-17", tab_id: "w1:t1" } },
        }),
      ],
    ]);
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      expect(await herdrBackend.currentAgentName()).toBe("worker-2");
    } finally {
      const key = "HERDR_PANE_ID";
      delete process.env[key];
    }
  });

  it("currentAgentName is undefined outside a herdr-managed pane", async () => {
    const key = "HERDR_PANE_ID";
    delete process.env[key];
    mockHerdrWith(async () => {
      throw new Error("must not shell out without $HERDR_PANE_ID");
    });
    expect(await herdrBackend.currentAgentName()).toBeUndefined();
  });
});

// ─── Availability ──────────────────────────────────────────────────────

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

// ─── Refused / no-op surfaces ──────────────────────────────────────────

describe("refused and no-op surfaces", () => {
  it("a creation verb carrying a command is refused and names the two-step path", async () => {
    // Spawn is two steps on herdr (bare pane, then startAgentInPane); a
    // command here is a caller bug, not an unimplemented feature.
    await expect(herdrBackend.newSession("mu-x", { command: "pi" })).rejects.toBeInstanceOf(
      HerdrNotImplementedError,
    );
    await expect(herdrBackend.newSession("mu-x", { command: "pi" })).rejects.toThrow(
      /startAgentInPane/,
    );
    await expect(herdrBackend.newSession("mu-x", { command: "pi" })).rejects.not.toThrow(
      /not implemented yet/,
    );
  });

  it("pane borders are a no-op: herdr owns its own chrome", async () => {
    mockHerdrWith(async () => {
      throw new Error("chrome no-ops must not shell out");
    });
    expect(await herdrBackend.enableMuPaneBordersForSession("mu-x")).toBe(0);
    await expect(herdrBackend.enableMuPaneBordersForPane("w1:p1")).resolves.toBeUndefined();
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
      expect(await herdrBackend.attachHint(target)).toBe("herdr tab focus w1:t2 && herdr");
      expect(await herdrBackend.attachCommands(target)).toEqual([
        { command: "herdr", args: ["tab", "focus", "w1:t2"] },
        { command: "herdr", args: [] },
      ]);
    });
  });

  it("inside a herdr pane, only focuses: the caller's client already shows it", async () => {
    await withEnv(HERDR_ENV, "1", async () => {
      mockHerdr([["workspace list", WORKSPACE_LIST]]);
      expect(await herdrBackend.attachHint({ session: "mu-topotest" })).toBe(
        "herdr workspace focus w1",
      );
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
      expect(await herdrBackend.attachHint({ session: "mu-topotest", window: "nope" })).toBe(
        "herdr workspace focus w1",
      );
    });
  });

  it("targets the MU_HERDR_SESSION server mu drives", async () => {
    await withEnv(HERDR_ENV, undefined, async () => {
      await withEnv(HERDR_SESSION, "work", async () => {
        mockHerdr([["workspace list", WORKSPACE_LIST]]);
        expect(await herdrBackend.attachHint({ session: "mu-topotest" })).toBe(
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
    const res = (stdout: string): MuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
    mockHerdrWith(async (args) => {
      const key = args.join(" ");
      if (key.startsWith("workspace create")) return res(WORKSPACE_CREATED);
      if (key.startsWith("tab rename")) {
        const tab = tabs.find((t) => t.tab_id === args[2]);
        if (tab !== undefined) tab.label = args[3] ?? "";
        return res(OK);
      }
      if (key.startsWith("workspace list")) return res(WORKSPACE_LIST);
      if (key.startsWith("tab list")) {
        const all = [...tabs, { tab_id: "w1:t2", label: "worker-2", focused: true }];
        return res(JSON.stringify({ result: { tabs: all, type: "tab_list" } }));
      }
      return serverError(`unrouted: ${key}`);
    });
    await herdrBackend.newSessionWithPane("mu-topotest", { windowName: "worker-1", command: "" });
    await withEnv(HERDR_ENV, "1", async () => {
      expect(
        await herdrBackend.attachCommands({ session: "mu-topotest", window: "worker-1" }),
      ).toEqual([{ command: "herdr", args: ["tab", "focus", "w1:t1"] }]);
    });
  });

  it("an unknown label: the hint degrades to a recipe, the TUI steps throw", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    const hint = await herdrBackend.attachHint({ session: "mu-gone" });
    expect(hint).toContain("workspace list");
    expect(hint).not.toContain("session attach");
    await expect(herdrBackend.attachCommands({ session: "mu-gone" })).rejects.toBeInstanceOf(
      HerdrError,
    );
  });
});
