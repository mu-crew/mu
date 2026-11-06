// `mu hook stop` (spec D7, U10): the process-chain guards and the Stop
// decision, in-process. Process tables are the shapes U0 recorded (a launcher
// and its binary under a pane shell, a nested `claude -p` behind a shell); the
// consuming wait, the holder check and murmur are injected. The real
// subprocess path is test/hook-stop.integration.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  type AnchorReader,
  type HookAnchor,
  harnessFromArgs,
  hookAgent,
  oneShot,
  type ProcessRow,
  parseHookAnchor,
  parseProcessTable,
} from "../src/hook-chain.js";
import {
  KEEP_DRIVING_MAX_DEFAULT,
  keepDrivingMax,
  parseStopWait,
  readKeepDriving,
  runStopHook,
  type StopHookDeps,
  type StopWaitOutcome,
  stopHookOutput,
  stopWaitSeconds,
} from "../src/hook-stop.js";
import { claimTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { installMux, type MuxHarness } from "./_mux.js";

const STARTED = 1_793_875_600;

/** A table from `[pid, ppid, args]` rows, all started at STARTED. */
function table(rows: [number, number, string][]): Map<number, ProcessRow> {
  return new Map(rows.map(([pid, ppid, args]) => [pid, { pid, ppid, started: STARTED, args }]));
}

/** Anchors by pid. */
function anchors(by: Record<number, Partial<HookAnchor>>): AnchorReader {
  return (row) => {
    const a = by[row.pid];
    if (a === undefined) return null;
    return {
      agent_name: "orch",
      workstream: "auth",
      cli: "claude",
      orchestrator: true,
      remote_key: null,
      ...a,
    };
  };
}

// tmux server 100 > zsh 200 > claude launcher 300 (anchored) > claude 301 > sh 400 > hook 500
const CLAUDE_PANE: [number, number, string][] = [
  [100, 1, "tmux new-session -d -s mu-auth"],
  [200, 100, "-zsh"],
  [300, 200, "/usr/local/bin/claude --permission-mode auto"],
  [301, 300, "/opt/claude/versions/2.1/claude --permission-mode auto"],
  [400, 301, "/bin/sh -c mu hook stop claude"],
  [500, 400, "node /usr/local/lib/mu/dist/cli.js hook stop claude"],
];

describe("hook-chain: argv matching and the table", () => {
  it("matches a harness by its executable or an interpreter's script, never by later args", () => {
    expect(harnessFromArgs("/usr/local/bin/claude --model x")).toBe("claude");
    expect(harnessFromArgs("/opt/codex/bin/codex.real -s workspace-write")).toBe("codex");
    expect(harnessFromArgs("node /home/u/.local/cursor-agent/index.js")).toBe("cursor-agent");
    expect(harnessFromArgs("bun /x/node_modules/pi-coding-agent/dist/cli.js")).toBe("pi");
    expect(harnessFromArgs("/bin/sh -c claude -p hi")).toBeNull();
    expect(harnessFromArgs("node /usr/local/lib/mu/dist/cli.js hook stop claude")).toBeNull();
  });

  it("parses ps output with lstart into seconds", () => {
    const t = parseProcessTable(
      "  300   200 Wed Nov  5 10:00:00 2026 /usr/local/bin/claude --x\nnot a row\n",
    );
    const row = t.get(300);
    expect(row?.ppid).toBe(200);
    expect(row?.args).toBe("/usr/local/bin/claude --x");
    expect(row?.started).toBe(Math.floor(Date.parse("Wed Nov 5 10:00:00 2026") / 1000));
    expect(t.size).toBe(1);
  });

  it("an anchor counts only when its start time matches the process", () => {
    const row: ProcessRow = { pid: 7, ppid: 1, started: STARTED, args: "claude" };
    const raw = (start: number) =>
      JSON.stringify({
        agent_name: "w",
        workstream: "auth",
        role: "worker",
        cli: "claude",
        orchestrator: false,
        remote_key: null,
        start_time: start,
      });
    expect(parseHookAnchor(raw(STARTED + 1), row)?.agent_name).toBe("w");
    expect(parseHookAnchor(raw(STARTED + 5), row)).toBeNull();
    expect(parseHookAnchor("{", row)).toBeNull();
  });
});

describe("hook-chain: the D7 guards", () => {
  it("a launcher and its binary are one harness; the anchor names the agent", () => {
    const r = hookAgent("claude", {
      table: table(CLAUDE_PANE),
      self: 500,
      anchor: anchors({ 300: {} }),
      env: {},
    });
    expect(r).toEqual({
      ok: true,
      agent: { name: "orch", workstream: "auth", orchestrator: true, source: "anchor" },
    });
  });

  it("a claude -p run by a managed claude is nested, whatever its env says", () => {
    // ... claude 301 > sh 600 > claude -p 700 > sh 800 > hook 900
    const t = table([
      ...CLAUDE_PANE.slice(0, 4),
      [600, 301, "/bin/zsh -c claude -p check"],
      [700, 600, "/usr/local/bin/claude -p check"],
      [800, 700, "/bin/sh -c mu hook stop claude"],
      [900, 800, "node /usr/local/lib/mu/dist/cli.js hook stop claude"],
    ]);
    const env = {
      MU_MANAGED_AGENT: "1",
      MU_AGENT_NAME: "orch",
      MU_WORKSTREAM: "auth",
      MU_AGENT_CLI: "claude",
    };
    expect(hookAgent("claude", { table: t, self: 900, anchor: anchors({ 300: {} }), env })).toEqual(
      {
        ok: false,
        reason: "nested",
      },
    );
  });

  it("a claude -p run by a managed pi is refused, from the chain or from MU_AGENT_CLI", () => {
    const env = {
      MU_MANAGED_AGENT: "1",
      MU_AGENT_NAME: "orch",
      MU_WORKSTREAM: "auth",
      MU_AGENT_CLI: "pi",
      MU_ORCHESTRATOR: "1",
    };
    const chain = (pi: string, claude = "/usr/local/bin/claude -p review") =>
      table([
        [100, 1, "tmux new-session -d"],
        [200, 100, "-zsh"],
        [300, 200, pi],
        [400, 300, "/bin/bash -c claude -p review"],
        [500, 400, claude],
        [600, 500, "/bin/sh -c mu hook stop claude"],
        [700, 600, "node /usr/local/lib/mu/dist/cli.js hook stop claude"],
      ]);
    // pi is not anchored: the walk sees it as a second harness.
    expect(
      hookAgent("claude", {
        table: chain("/usr/local/bin/pi"),
        self: 700,
        anchor: anchors({}),
        env,
      }),
    ).toEqual({
      ok: false,
      reason: "nested",
    });
    // A pi the argv match misses, and an interactive claude: the env fallback still names pi, not claude.
    expect(
      hookAgent("claude", {
        table: chain("/opt/x/agent-build", "/usr/local/bin/claude review"),
        self: 700,
        anchor: anchors({}),
        env,
      }),
    ).toEqual({
      ok: false,
      reason: "other-harness",
    });
  });

  it("codex: a three-process launcher run is one harness, a codex exec right under it is nested", () => {
    // U0: codex < /usr/local/bin/codex < codex.real, and `codex exec` exec'd in place under codex.real.
    const pane: [number, number, string][] = [
      [100, 1, "tmux new-session -d"],
      [200, 100, "-zsh"],
      [300, 200, "codex -c projects.x.trust_level=trusted"],
      [301, 300, "/usr/local/bin/codex __wrapper-session /usr/local/bin/codex_cli/codex.real"],
      [302, 301, "/usr/local/bin/codex_cli/codex.real -c key=value"],
    ];
    const anchor = anchors({ 300: { cli: "codex" } });
    const own = table([...pane, [500, 302, "node /usr/local/lib/mu/dist/cli.js hook stop codex"]]);
    expect(hookAgent("codex", { table: own, self: 500, anchor, env: {} }).ok).toBe(true);
    const nested = table([
      ...pane,
      [600, 302, "codex exec Reply with exactly NESTED"],
      [601, 600, "/usr/local/bin/codex_cli/codex.real -c key=value exec"],
      [700, 601, "node /usr/local/lib/mu/dist/cli.js hook stop codex"],
    ]);
    expect(hookAgent("codex", { table: nested, self: 700, anchor, env: {} })).toEqual({
      ok: false,
      reason: "nested",
    });
    expect(oneShot("claude", "/usr/local/bin/claude --print hi")).toBe(true);
    expect(oneShot("claude", "/usr/local/bin/claude --permission-mode auto")).toBe(false);
    expect(oneShot("muse", "muse exec x")).toBe(true);
    expect(oneShot("pi", "pi -p x")).toBe(false);
  });

  it("one-shot is murmur's rule: codex e and review nest, a prompt holding the word exec does not", () => {
    // The pane's codex run as above, its agent anchored at the launcher.
    const pane: [number, number, string][] = [
      [100, 1, "tmux new-session -d"],
      [200, 100, "-zsh"],
      [300, 200, "codex -m gpt-5 fix the exec path"],
      [302, 300, "/usr/local/bin/codex_cli/codex.real -m gpt-5 fix the exec path"],
    ];
    const anchor = anchors({ 300: { cli: "codex" } });
    const hook: [number, number, string] = [
      700,
      600,
      "node /usr/local/lib/mu/dist/cli.js hook stop codex",
    ];
    // The interactive agent's own Stop: its prompt's `exec` is no subcommand.
    const own = table([...pane, [600, 302, "node /usr/local/lib/mu/dist/cli.js hook stop codex"]]);
    expect(hookAgent("codex", { table: own, self: 600, anchor, env: {} }).ok).toBe(true);
    // `codex e` and `codex review`, exec'd in place under the agent's binary: nested.
    for (const run of ["codex e Reply NESTED", "codex -c k=v review --uncommitted"]) {
      const nested = table([...pane, [600, 302, run], hook]);
      expect(hookAgent("codex", { table: nested, self: 700, anchor, env: {} })).toEqual({
        ok: false,
        reason: "nested",
      });
    }
    expect(oneShot("codex", "codex -m exec")).toBe(false);
    expect(oneShot("codex", "codex -- exec this")).toBe(false);
    expect(oneShot("codex", "codex --unknown-flag exec")).toBe(true);
    expect(oneShot("muse", "node /opt/muse/cli.js -p work exec hi")).toBe(true);
    expect(oneShot("muse", "node /opt/muse/cli.js resume")).toBe(false);
    expect(oneShot("cursor-agent", "cursor-agent --print=text hi")).toBe(true);
  });

  it("refuses an anchor of another harness and a remote anchor", () => {
    const t = table(CLAUDE_PANE);
    expect(
      hookAgent("claude", {
        table: t,
        self: 500,
        anchor: anchors({ 300: { cli: "codex" } }),
        env: {},
      }),
    ).toEqual({
      ok: false,
      reason: "other-harness",
    });
    expect(
      hookAgent("claude", {
        table: t,
        self: 500,
        anchor: anchors({ 300: { remote_key: "mac/%3" } }),
        env: {},
      }),
    ).toEqual({
      ok: false,
      reason: "remote",
    });
  });

  it("falls back to the env only without an anchor, and needs MU_AGENT_CLI to name the harness", () => {
    const env = {
      MU_MANAGED_AGENT: "1",
      MU_AGENT_NAME: "w1",
      MU_WORKSTREAM: "auth",
      MU_AGENT_CLI: "claude",
    };
    expect(
      hookAgent("claude", { table: table(CLAUDE_PANE), self: 500, anchor: anchors({}), env }),
    ).toEqual({
      ok: true,
      agent: { name: "w1", workstream: "auth", orchestrator: false, source: "env" },
    });
    expect(hookAgent("claude", { table: null, env: { ...env, MU_AGENT_CLI: "codex" } })).toEqual({
      ok: false,
      reason: "other-harness",
    });
    expect(hookAgent("claude", { table: null, env: { ...env, MU_REMOTE: "1" } })).toEqual({
      ok: false,
      reason: "remote",
    });
    expect(hookAgent("claude", { table: null, env: {} })).toEqual({
      ok: false,
      reason: "unmanaged",
    });
  });

  it("the walk stops at the tmux server: an anchor above it is not this pane's", () => {
    const t = table([
      [50, 1, "/usr/local/bin/claude"],
      ...CLAUDE_PANE.map(([p, pp, a]) => [p, p === 100 ? 50 : pp, a] as [number, number, string]),
    ]);
    expect(
      hookAgent("claude", { table: t, self: 500, anchor: anchors({ 50: {} }), env: {} }),
    ).toEqual({
      ok: false,
      reason: "unmanaged",
    });
  });
});

describe("hook-stop: helpers", () => {
  it("reads a wait's one document", () => {
    expect(parseStopWait(JSON.stringify({ ok: false, error: "WaitNothingError" }))).toEqual({
      kind: "nothing",
    });
    expect(parseStopWait(JSON.stringify({ ok: false, error: "CallerBusyError" }))).toEqual({
      kind: "busy",
    });
    expect(parseStopWait(JSON.stringify({ ok: true, data: { timedOut: true } }))).toEqual({
      kind: "timeout",
    });
    expect(
      parseStopWait(JSON.stringify({ ok: true, data: { timedOut: true, drained: true } })),
    ).toEqual({
      kind: "nothing",
    });
    expect(
      parseStopWait(JSON.stringify({ ok: true, data: { firing: { kind: "closed" } } })),
    ).toEqual({
      kind: "events",
      data: { firing: { kind: "closed" } },
    });
    expect(parseStopWait("boom").kind).toBe("failed");
  });

  it("the wait ends 10 s before the hook; the cap reads MU_KEEP_DRIVING_MAX", () => {
    expect(stopWaitSeconds(600)).toBe(590);
    expect(stopWaitSeconds(5)).toBe(0.1);
    expect(keepDrivingMax({})).toBe(KEEP_DRIVING_MAX_DEFAULT);
    expect(keepDrivingMax({ MU_KEEP_DRIVING_MAX: "3" })).toBe(3);
    expect(keepDrivingMax({ MU_KEEP_DRIVING_MAX: "x" })).toBe(KEEP_DRIVING_MAX_DEFAULT);
  });

  it("answers in each harness's block shape, and nothing to allow", () => {
    const block = { decision: "block" as const, why: "owed" as const, reason: "go on" };
    expect(JSON.parse(stopHookOutput("claude", block))).toEqual({
      decision: "block",
      reason: "go on",
    });
    expect(JSON.parse(stopHookOutput("codex", block))).toEqual({
      decision: "block",
      reason: "go on",
    });
    expect(JSON.parse(stopHookOutput("cursor-agent", block))).toEqual({
      followup_message: "go on",
    });
    expect(stopHookOutput("claude", { decision: "allow", why: "x" })).toBe("");
  });
});

describe("hook-stop: runStopHook", () => {
  let dir: string;
  let db: Db;
  let mux: MuxHarness;
  let waits: { caller: string; timeoutS: number }[];
  let outcomes: StopWaitOutcome[];
  let events: { pane: string; event: Record<string, unknown> }[];
  let holder: boolean;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-hook-stop-"));
    db = openDb({ path: join(dir, "mu.db") });
    ensureWorkstream(db, "auth");
    setSleepForTests(async () => {});
    mux = installMux("tmux", async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    waits = [];
    outcomes = [];
    events = [];
    holder = false;
  });
  afterEach(() => {
    mux.restore();
    resetSleep();
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  /** Deps for a claude pane whose launcher (300) carries `anchor`. */
  function deps(anchor: Partial<HookAnchor> = {}, env: NodeJS.ProcessEnv = {}): StopHookDeps {
    return {
      table: () => table(CLAUDE_PANE),
      self: 500,
      anchor: anchors({ 300: anchor }),
      env: { TMUX_PANE: "%9", ...env },
      holder: () => holder,
      wait: async (caller, timeoutS) => {
        waits.push({ caller, timeoutS });
        const next = outcomes.shift();
        if (next === undefined) throw new Error("unexpected wait");
        return next;
      },
      writeEvent: async (pane, event) => {
        events.push({ pane, event });
        return true;
      },
      skillMd: () => "<!-- mu:keep-driving -->\nKeep driving.\n<!-- /mu:keep-driving -->",
    };
  }
  const stop = (sid = "s1", extra: Record<string, unknown> = {}) => ({
    session_id: sid,
    hook_event_name: "Stop",
    stop_hook_active: false,
    ...extra,
  });

  it("an event blocks with the consumed result, records continued, and resets the empty count", async () => {
    outcomes.push(
      { kind: "timeout" },
      { kind: "events", data: { firing: { kind: "closed", ref: "task:auth/t1" } } },
    );
    const first = await runStopHook(db, "claude", stop(), { timeoutS: 600 }, deps());
    expect(first).toMatchObject({ decision: "block", why: "owed" });
    expect(readKeepDriving(db, "s1").emptyBlocks).toBe(1);
    const d = await runStopHook(
      db,
      "claude",
      stop("s1", { stop_hook_active: true }),
      { timeoutS: 600 },
      deps(),
    );
    expect(d.decision).toBe("block");
    if (d.decision !== "block") return;
    expect(d.why).toBe("events");
    expect(d.reason).toContain("[mu] Keep driving.");
    expect(d.reason).toContain('"ref":"task:auth/t1"');
    expect(d.reason).toContain("--as auth/orch");
    expect(waits).toEqual([
      { caller: "auth/orch", timeoutS: 590 },
      { caller: "auth/orch", timeoutS: 590 },
    ]);
    expect(events).toEqual([
      { pane: "%9", event: { event: "continued", session_id: "s1" } },
      { pane: "%9", event: { event: "continued", session_id: "s1" } },
    ]);
    expect(readKeepDriving(db, "s1").emptyBlocks).toBe(0);
  });

  it("a live wait holding the caller lets the turn end without waiting", async () => {
    holder = true;
    const d = await runStopHook(db, "claude", stop(), {}, deps());
    expect(d).toMatchObject({ decision: "allow" });
    expect(waits).toEqual([]);
    expect(events).toEqual([]);
  });

  it("nothing owed, a busy caller and a failed wait each let the turn end", async () => {
    outcomes.push({ kind: "nothing" }, { kind: "busy" }, { kind: "failed", detail: "x" });
    for (let i = 0; i < 3; i++) {
      expect((await runStopHook(db, "claude", stop(), {}, deps())).decision).toBe("allow");
    }
    expect(events).toEqual([]);
  });

  it("empty blocks stop at MU_KEEP_DRIVING_MAX in a row; a turn the user starts resets the count", async () => {
    const env = { MU_KEEP_DRIVING_MAX: "2" };
    outcomes.push(...Array.from({ length: 5 }, () => ({ kind: "timeout" }) as const));
    const resumed = stop("s1", { stop_hook_active: true });
    expect((await runStopHook(db, "claude", stop(), {}, deps({}, env))).decision).toBe("block");
    expect((await runStopHook(db, "claude", resumed, {}, deps({}, env))).decision).toBe("block");
    const capped = await runStopHook(db, "claude", resumed, {}, deps({}, env));
    expect(capped).toMatchObject({ decision: "allow" });
    expect(capped.decision === "allow" && capped.why).toContain("cap 2");
    expect(events).toHaveLength(2);
    // The user types again: a fresh turn (stop_hook_active false) may block again.
    expect((await runStopHook(db, "claude", stop(), {}, deps({}, env))).decision).toBe("block");
    expect(readKeepDriving(db, "s1").emptyBlocks).toBe(1);
  });

  it("a worker that owns an IN_PROGRESS task is nudged once per session", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%41", cli: "claude" });
    addTask(db, { localId: "t1", workstream: "auth", title: "t1", impact: 50, effortDays: 1 });
    await claimTask(db, "t1", { workstream: "auth", agentName: "w1" });
    const worker = { agent_name: "w1", orchestrator: false };
    const d = await runStopHook(db, "claude", stop("w-s1"), {}, deps(worker));
    expect(d.decision).toBe("block");
    if (d.decision !== "block") return;
    expect(d.why).toBe("close");
    expect(d.reason).toContain("mu task close t1 -w auth");
    // continued goes to the agent row's pane, not the env's.
    expect(events).toEqual([{ pane: "%41", event: { event: "continued", session_id: "w-s1" } }]);
    expect((await runStopHook(db, "claude", stop("w-s1"), {}, deps(worker))).decision).toBe(
      "allow",
    );
    expect((await runStopHook(db, "claude", stop("w-s2"), {}, deps(worker))).decision).toBe(
      "block",
    );
    expect(waits).toEqual([]);
  });

  it("a worker whose turn ends with a CLOSE block for its task is let go, its report kept", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%41", cli: "claude" });
    addTask(db, { localId: "t1", workstream: "auth", title: "t1", impact: 50, effortDays: 1 });
    await claimTask(db, "t1", { workstream: "auth", agentName: "w1" });
    const worker = { agent_name: "w1", orchestrator: false };
    const report = 'CLOSE: task=t1 evidence="gate.sh exit 0"\nREPORT:\nVERDICT: REFUTED';
    const d = await runStopHook(
      db,
      "claude",
      stop("w-s1", { last_assistant_message: report }),
      {},
      deps(worker),
    );
    expect(d).toMatchObject({ decision: "allow" });
    expect(d.decision === "allow" && d.why).toContain("CLOSE block for t1");
    expect(events).toEqual([]);
    // A CLOSE block for a task it does not own is no report: the nudge still fires.
    const other = 'CLOSE: task=t9 evidence="x"\nREPORT:\nVERDICT: REFUTED';
    const n = await runStopHook(
      db,
      "claude",
      stop("w-s2", { last_assistant_message: other }),
      {},
      deps(worker),
    );
    expect(n).toMatchObject({ decision: "block", why: "close" });
  });

  it("a worker with no IN_PROGRESS task, or in scratch, is let go", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%41", cli: "claude" });
    expect(
      (await runStopHook(db, "claude", stop(), {}, deps({ agent_name: "w1", orchestrator: false })))
        .decision,
    ).toBe("allow");
    expect(
      (
        await runStopHook(
          db,
          "claude",
          stop(),
          {},
          deps({ agent_name: "w1", workstream: "scratch", orchestrator: false }),
        )
      ).decision,
    ).toBe("allow");
  });

  it("never acts for muse, pi, an unknown harness, MU_NUDGE=0 or a nested agent", async () => {
    // muse and pi each get their own anchored chain, so only the harness guard lets them go.
    const own = (cli: string, launcher: string, binary: string): StopHookDeps => ({
      ...deps({ cli }),
      table: () =>
        table([
          [100, 1, "tmux new-session -d"],
          [200, 100, "-zsh"],
          [300, 200, launcher],
          [301, 300, binary],
          [500, 301, `node /usr/local/lib/mu/dist/cli.js hook stop ${cli}`],
        ]),
    });
    outcomes.push({ kind: "events", data: { firing: { kind: "closed" } } });
    const muse = await runStopHook(
      db,
      "muse",
      stop(),
      {},
      own("muse", "muse --yolo", "/usr/local/bin/muse.real --yolo"),
    );
    expect(muse).toEqual({
      decision: "allow",
      why: "Muse Code cannot block a stop with a reason",
    });
    const pi = await runStopHook(
      db,
      "pi",
      stop(),
      {},
      own("pi", "/usr/local/bin/pi", "bun /x/node_modules/pi-coding-agent/dist/cli.js"),
    );
    expect(pi).toEqual({ decision: "allow", why: "pi keeps its settle nudge" });
    expect((await runStopHook(db, "opencode", stop(), {}, deps())).decision).toBe("allow");
    expect(
      (await runStopHook(db, "claude", stop(), {}, deps({}, { MU_NUDGE: "0" }))).decision,
    ).toBe("allow");
    const nested: StopHookDeps = {
      ...deps(),
      table: () =>
        table([
          ...CLAUDE_PANE.slice(0, 4),
          [600, 301, "/bin/zsh -c claude -p x"],
          [700, 600, "/usr/local/bin/claude -p x"],
          [800, 700, "node /usr/local/lib/mu/dist/cli.js hook stop claude"],
        ]),
      self: 800,
    };
    expect((await runStopHook(db, "claude", stop(), {}, nested)).decision).toBe("allow");
    expect(waits).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a consumed event still blocks when the bookkeeping after the wait fails", async () => {
    // The wait commits its cursor in its own process; then the DB goes away
    // (busy, replaced, ...): neither the keep_driving write nor the pane
    // lookup may turn the block into an allow that drops the event.
    const failing: StopHookDeps = {
      ...deps(),
      wait: async (caller, timeoutS) => {
        waits.push({ caller, timeoutS });
        db.close();
        return { kind: "events", data: { firing: { kind: "closed", ref: "task:auth/t1" } } };
      },
    };
    const d = await runStopHook(db, "claude", stop(), {}, failing);
    expect(d).toMatchObject({ decision: "block", why: "events" });
    expect(d.decision === "block" && d.reason).toContain('"ref":"task:auth/t1"');
    // continued falls back to the env's pane.
    expect(events).toEqual([{ pane: "%9", event: { event: "continued", session_id: "s1" } }]);
  });

  it("a failing murmur does not undo a block", async () => {
    outcomes.push({ kind: "events", data: { firing: { kind: "closed" } } });
    const d = await runStopHook(
      db,
      "claude",
      stop(),
      {},
      {
        ...deps(),
        writeEvent: async () => {
          throw new Error("murmur gone");
        },
      },
    );
    expect(d).toMatchObject({ decision: "block", why: "events" });
  });

  it("drops codex's title-generation Stop", async () => {
    const codex = deps({ cli: "codex" });
    const codexTable = () =>
      table([
        [100, 1, "tmux new-session -d"],
        [200, 100, "-zsh"],
        [300, 200, "/usr/local/bin/codex"],
        [301, 300, "/usr/local/lib/codex/codex.real"],
        [500, 301, "node /usr/local/lib/mu/dist/cli.js hook stop codex"],
      ]);
    expect(
      (
        await runStopHook(
          db,
          "codex",
          stop("t", { transcript_path: null }),
          {},
          { ...codex, table: codexTable },
        )
      ).decision,
    ).toBe("allow");
    expect(waits).toEqual([]);
  });

  /** Deps for a cursor-agent pane: its node process (300) carries the anchor. */
  function cursorDeps(env: NodeJS.ProcessEnv = {}): StopHookDeps {
    return {
      ...deps({ cli: "cursor-agent" }, env),
      table: () =>
        table([
          [100, 1, "tmux new-session -d"],
          [200, 100, "-zsh"],
          [300, 200, "node /home/u/.local/share/cursor-agent/versions/1/index.js"],
          [500, 300, "node /usr/local/lib/mu/dist/cli.js hook stop cursor-agent"],
        ]),
    };
  }

  it("cursor-agent: the anchored node process keeps driving, answered as a followup", async () => {
    outcomes.push({ kind: "events", data: { firing: { kind: "closed" } } });
    const d = await runStopHook(
      db,
      "cursor-agent",
      { session_id: "c1", status: "completed", loop_count: 0 },
      {},
      cursorDeps(),
    );
    expect(d.decision).toBe("block");
    expect(Object.keys(JSON.parse(stopHookOutput("cursor-agent", d)))).toEqual([
      "followup_message",
    ]);
  });

  it("cursor-agent: an aborted or failed stop is let go without a wait", async () => {
    outcomes.push({ kind: "events", data: { firing: { kind: "closed" } } });
    for (const status of ["aborted", "error"]) {
      expect(
        await runStopHook(
          db,
          "cursor-agent",
          { session_id: "c1", status, loop_count: 0 },
          {},
          cursorDeps(),
        ),
      ).toEqual({ decision: "allow", why: `turn ${status}` });
    }
    expect(waits).toEqual([]);
    expect(events).toEqual([]);
  });

  it("cursor-agent: loop_count 0 is a turn the user started and resets the empty count", async () => {
    const env = { MU_KEEP_DRIVING_MAX: "1" };
    outcomes.push(...Array.from({ length: 3 }, () => ({ kind: "timeout" }) as const));
    const at = (loop_count: number) => ({ session_id: "c1", status: "completed", loop_count });
    expect((await runStopHook(db, "cursor-agent", at(0), {}, cursorDeps(env))).decision).toBe(
      "block",
    );
    const capped = await runStopHook(db, "cursor-agent", at(1), {}, cursorDeps(env));
    expect(capped).toMatchObject({ decision: "allow" });
    expect(capped.decision === "allow" && capped.why).toContain("cap 1");
    expect((await runStopHook(db, "cursor-agent", at(0), {}, cursorDeps(env))).decision).toBe(
      "block",
    );
    expect(readKeepDriving(db, "c1").emptyBlocks).toBe(1);
    expect(waits).toHaveLength(3);
  });
});
