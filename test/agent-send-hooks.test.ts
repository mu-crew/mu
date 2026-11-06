// `mu agent send` and `mu agent answer` on the `hooks` channel (spec D4, U8),
// and its `--interrupt`, `--fresh`, `--wait` (settle and last text) and `mu
// agent abort` (U9), through the CLI: a fake hook harness
// (test/_fake-harness.ts) writes murmur inbox events for pane %3 and answers
// the keys mu types into it.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import {
  parseHooksPane,
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import { type Db, openDb } from "../src/db.js";
import { runStopHook, type StopDecision, type StopHookDeps } from "../src/hook-stop.js";
import { claimTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask, listNotes } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { rmFixtureDir } from "./_fs.js";
import { installMurmurHooks } from "./_murmur-hooks.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let fake: FakeHarness;
/** What `paneResult` reads of the agent's pane: running, exited (a retained pane), or gone. */
let paneState: "live" | "dead" | "gone";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mash-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, {
    name: "cdx",
    workstream: "auth",
    paneId: "%3",
    cli: "codex",
    channel: "hooks",
  });
  insertAgent(db, { name: "pia", workstream: "auth", paneId: "%1", cli: "pi", channel: "ctl" });
  fake = fakeHarness(dir, "%3", "sess-1");
  paneState = "live";
  fake.emit("session_start", { source: "startup" });
  setSleepForTests(async () => {});
  setMurmurPaneRunnerForTests(fake.pane);
  setMurmurHookRunnerForTests(fake.hook);
  mux = installMux(
    "tmux",
    async (args) =>
      fake.tmux(args) ??
      (args[0] === "display-message" && paneState === "gone"
        ? { stdout: "", stderr: `can't find pane: ${args[args.indexOf("-t") + 1]}`, exitCode: 1 }
        : undefined) ?? {
        stdout:
          args[0] === "display-message"
            ? // A live pane, for a held watch's liveness check.
              `${(args.at(-1) ?? "")
                .replace("#{pane_id}", args[args.indexOf("-t") + 1] ?? "")
                .replace("#{pane_dead}", paneState === "dead" ? "1" : "0")
                .replace(/#\{[^}]+\}/g, "")}\n`
            : args[0] !== "list-panes"
              ? ""
              : args.includes("-s")
                ? // The session's panes, as the reconcile before a wait lists them.
                  "@1\t%1\tpi\n@1\t%3\tcodex\n"
                : `%1\t\t\n%3\t${fake.option()}\t1\n`,
        stderr: "",
        exitCode: 0,
      },
  );
});

afterEach(() => {
  mux.restore();
  setMurmurPaneRunnerForTests(async () => null);
  setMurmurHookRunnerForTests(async () => false);
  resetSleep();
  db.close();
  rmFixtureDir(dir);
});

const sendOps = () =>
  (
    db.prepare("SELECT payload FROM ops WHERE intent = 'agent.send' ORDER BY rowid").all() as {
      payload: string;
    }[]
  ).map((r) => r.payload);

describe("mu agent send to a hooks agent", () => {
  it("pastes once and reports the confirming run count", async () => {
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "hello there", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      agentName: "cdx",
      transport: "hooks",
      ack: "confirmed",
      runCount: 1,
      delivered: true,
    });
    expect(fake.submitted).toEqual(["hello there"]);
    expect(sendOps()).toEqual([
      expect.stringMatching(/^agent send cdx \(mode=plain transport=hooks.*, 11 bytes\)$/),
    ]);
  });

  it("no ack: delivered false with the unconfirmed reason, exit 0, never resent", async () => {
    fake.acks = false;
    let r: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      r = await runCliJson(["agent", "send", "cdx", "hi", "-w", "auth", "--json"], dbPath);
    });
    expect(r?.exitCode).toBeNull();
    expect(r?.data).toMatchObject({
      transport: "hooks",
      ack: "unknown",
      delivered: false,
      undelivered: { reason: "unconfirmed" },
    });
    expect(fake.calls.filter((c) => c[0] === "paste-buffer")).toHaveLength(1);
  });

  it("a blocked agent is refused with exit 4 and the answer hint; nothing is typed", async () => {
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    const { doc, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "hi", "-w", "auth", "--force", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(4);
    expect(doc).toMatchObject({ error: "AgentSendGateError" });
    expect(JSON.stringify(doc)).toContain("mu agent answer cdx");
    expect(fake.calls).toEqual([]);
  });

  it("--force is the gate's override on hooks, and still a usage error on a pi plain send", async () => {
    fake.emit("prompt_submitted");
    const refused = await runCliJson(
      ["agent", "send", "cdx", "hi", "-w", "auth", "--json"],
      dbPath,
    );
    expect(refused.exitCode).toBe(4);
    const forced = await runCliJson(
      ["agent", "send", "cdx", "hi", "-w", "auth", "--force", "--json"],
      dbPath,
    );
    expect(forced.exitCode).toBeNull();
    expect(forced.data).toMatchObject({ transport: "hooks", ack: "confirmed", runCount: 2 });
    const pi = await runCliJson(
      ["agent", "send", "pia", "hi", "-w", "auth", "--force", "--json"],
      dbPath,
    );
    expect(pi.exitCode).toBe(2);
    expect(pi.doc).toMatchObject({ error: "UsageError" });
  });

  it("--steer is refused with exit 2, naming the channel; nothing is typed", async () => {
    const { doc, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "hi", "-w", "auth", "--steer", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(2);
    expect(doc).toMatchObject({ error: "AgentSteerUnsupportedError" });
    expect(JSON.stringify(doc)).toContain("hooks channel");
    expect(fake.calls).toEqual([]);
  });

  it("human output names the channel and the run", async () => {
    const r = await runCli(["agent", "send", "cdx", "hello", "-w", "auth"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("via hooks, confirmed: run 1");
  });
});

describe("a check sent to a just-spawned codex pane (tasks-or-calls: another family)", () => {
  /** A codex pane before its first prompt: murmur has no row for it, as codex's session starts with that prompt. */
  const beforeFirstPrompt = (): void => {
    for (const f of readdirSync(fake.inbox)) rmSync(join(fake.inbox, f));
    fake.onSubmit = () => {
      fake.emit("session_start", { source: "startup" });
      fake.emit("prompt_submitted");
    };
  };
  /** murmur on PATH with codex's hooks installed: the exemption needs them for a local worker. */
  let restoreHooks: () => void;
  beforeEach(() => {
    restoreHooks = installMurmurHooks(dir, ["codex"]);
  });
  afterEach(() => restoreHooks());

  it("--fresh --wait is refused (its state reads unknown) and types nothing", async () => {
    beforeFirstPrompt();
    const { doc, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "refute F1", "-w", "auth", "--fresh", "--wait", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(4);
    expect(doc).toMatchObject({ error: "AgentSendGateError" });
    expect(JSON.stringify(doc)).toContain("no row for the pane");
    expect(fake.calls).toEqual([]);
  });

  it("a plain send passes the gate (no row, live pane): pasted once, confirmed by run 1", async () => {
    beforeFirstPrompt();
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "refute F1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({ transport: "hooks", ack: "confirmed", runCount: 1 });
    expect(fake.submitted).toEqual(["refute F1"]);
  });

  it("no ack: unknown, delivered false, never resent", async () => {
    beforeFirstPrompt();
    fake.onSubmit = null;
    fake.acks = false;
    let r: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      r = await runCliJson(["agent", "send", "cdx", "hi", "-w", "auth", "--json"], dbPath);
    });
    expect(r?.data).toMatchObject({ ack: "unknown", delivered: false });
    expect(fake.calls.filter((c) => c[0] === "paste-buffer")).toHaveLength(1);
    // mu has sent to it since its spawn: no row no longer means no turn (it may be running).
    const again = await runCliJson(["agent", "send", "cdx", "hi", "-w", "auth", "--json"], dbPath);
    expect(again.exitCode).toBe(4);
    expect(JSON.stringify(again.doc)).toContain("no row for the pane");
    expect(fake.calls.filter((c) => c[0] === "paste-buffer")).toHaveLength(1);
  });

  it("an agent mu has sent to since its spawn (a rebuilt murmur store lost its row) is refused unless --force", async () => {
    beforeFirstPrompt();
    const op = db.prepare(
      `INSERT INTO ops (hlc, machine_id, group_id, intent, entity, key, op, payload, created_at)
       VALUES (?, 'm', ?, 'agent.send', 'agent', 'auth', 'put', 'agent send cdx (mode=plain, 2 bytes)', ?)`,
    );
    db.prepare(
      "UPDATE agents SET created_at = '2026-01-02T00:00:00.000Z' WHERE name = 'cdx'",
    ).run();
    op.run("1", "g1", "2026-01-03T00:00:00.000Z");
    const refused = await runCliJson(["agent", "send", "cdx", "x", "-w", "auth", "--json"], dbPath);
    expect(refused.exitCode).toBe(4);
    expect(JSON.stringify(refused.doc)).toContain("no row for the pane");
    expect(fake.calls).toEqual([]);
    // A send to an earlier incarnation of the name does not count.
    db.prepare("DELETE FROM ops WHERE group_id = 'g1'").run();
    op.run("0", "g0", "2026-01-01T00:00:00.000Z");
    const first = await runCliJson(["agent", "send", "cdx", "hi", "-w", "auth", "--json"], dbPath);
    expect(first.exitCode).toBeNull();
    expect(first.data).toMatchObject({ ack: "confirmed", runCount: 1 });
  });

  it("murmur's codex hooks not installed: refused unless --force (no event will ever come)", async () => {
    beforeFirstPrompt();
    restoreHooks();
    restoreHooks = installMurmurHooks(dir, ["claude"]);
    const r = await runCliJson(["agent", "send", "cdx", "hi", "-w", "auth", "--json"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(JSON.stringify(r.doc)).toContain("no row for the pane");
    expect(fake.calls).toEqual([]);
  });

  it("a dead or gone pane, or a harness whose session starts at once (claude), is still refused unless --force", async () => {
    beforeFirstPrompt();
    for (const state of ["dead", "gone"] as const) {
      paneState = state;
      const r = await runCliJson(["agent", "send", "cdx", "hi", "-w", "auth", "--json"], dbPath);
      expect(r.exitCode, state).toBe(4);
      expect(JSON.stringify(r.doc), state).toContain("no row for the pane");
    }
    paneState = "live";
    db.prepare("UPDATE agents SET cli = 'claude' WHERE name = 'cdx'").run();
    const claude = await runCliJson(["agent", "send", "cdx", "hi", "-w", "auth", "--json"], dbPath);
    expect(claude.exitCode).toBe(4);
    expect(JSON.stringify(claude.doc)).toContain("no row for the pane");
    expect(fake.calls).toEqual([]);
  });

  it("--wait, as the recipe says: pasted, confirmed by the first run, and its last text answers", async () => {
    beforeFirstPrompt();
    const text = "VERDICT: F1 REFUTED the guard runs first\nEVIDENCE: src/x.ts:12";
    let reads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      if (fake.submitted.length > 0 && ++reads === 3) fake.emit("turn_stopped", { text });
      return fake.pane(pane);
    });
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "refute F1", "-w", "auth", "--wait", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(fake.submitted).toEqual(["refute F1"]);
    expect(data).toMatchObject({
      firing: { kind: "settled", ref: "agent:auth/cdx", incarnation: "sess-1", runs: 1 },
      sent: { transport: "hooks", ack: "confirmed", delivered: true },
      snapshots: [{ settled: true, lastText: text }],
    });
  });
});

describe("mu agent answer", () => {
  it("types the choice into a blocked agent's dialog, confirmed by the next event, and records it", async () => {
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    const { data, exitCode } = await runCliJson(
      ["agent", "answer", "cdx", "1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toEqual({ agentName: "cdx", transport: "hooks", keys: ["1"], ack: "confirmed" });
    expect(fake.calls).toEqual([["send-keys", "-t", "%3", "-l", "--", "1"]]);
    expect(sendOps()).toEqual([
      expect.stringContaining("mode=answer transport=hooks ack=confirmed"),
    ]);
  });

  it("refuses an agent with no pending dialog (exit 4), unless --force", async () => {
    const refused = await runCliJson(
      ["agent", "answer", "cdx", "y", "-w", "auth", "--json"],
      dbPath,
    );
    expect(refused.exitCode).toBe(4);
    expect(refused.doc).toMatchObject({ error: "AgentNotBlockedError" });
    expect(fake.calls).toEqual([]);
    let forced: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      forced = await runCliJson(
        ["agent", "answer", "cdx", "y", "-w", "auth", "--force", "--json"],
        dbPath,
      );
    });
    expect(forced?.data).toMatchObject({ keys: ["y"], ack: "unknown" });
  });

  it("a pi agent's dialog is answered in its pane (exit 2); a multi-line choice is a usage error", async () => {
    const pi = await runCliJson(["agent", "answer", "pia", "1", "-w", "auth", "--json"], dbPath);
    expect(pi.exitCode).toBe(2);
    expect(pi.doc).toMatchObject({ error: "AgentAnswerUnsupportedError" });
    const bad = await runCliJson(
      ["agent", "answer", "cdx", "1\nrm -rf x", "-w", "auth", "--json"],
      dbPath,
    );
    expect(bad.exitCode).toBe(2);
    expect(bad.doc).toMatchObject({ error: "UsageError" });
    expect(fake.calls).toEqual([]);
  });
});

describe("mu agent send --interrupt, --fresh, --wait and mu agent abort on hooks (U9)", () => {
  const asClaude = (): void => {
    db.prepare("UPDATE agents SET cli = 'claude' WHERE name = 'cdx'").run();
    fake.onEscape = "silent";
    fake.freshCommand = "/clear";
  };

  it("--interrupt a running codex: Escape, its Interrupt, the paste; the run is fenced for the next wait", async () => {
    fake.emit("prompt_submitted");
    const { data, doc, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "stop that", "-w", "auth", "--interrupt", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      transport: "hooks",
      interrupt: true,
      wasBusy: true,
      stopped: "confirmed",
      ack: "confirmed",
      runCount: 2,
      runs: 1,
      incarnation: "sess-1",
      delivered: true,
    });
    expect(fake.calls[0]).toEqual(["send-keys", "-t", "%3", "--", "Escape"]);
    expect(fake.submitted).toEqual(["stop that"]);
    expect(JSON.stringify(doc)).toContain("agent:auth/cdx@1#sess-1");
    expect(sendOps()).toEqual([
      expect.stringContaining("mode=interrupt transport=hooks wasBusy=true stopped=confirmed"),
    ]);
  });

  it("--interrupt a running claude: mu records idle?, says so, and the send still lands", async () => {
    asClaude();
    fake.emit("prompt_submitted");
    const r = await runCli(
      ["agent", "send", "cdx", "stop that", "-w", "auth", "--interrupt"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain(
      "via hooks, interrupted a busy run, unconfirmed: idle?, confirmed: run 2",
    );
    expect(r.stderr).toContain("idle? (unconfirmed)");
    expect(fake.muEvents).toEqual([{ event: "interrupted", session_id: "sess-1" }]);
  });

  it("--interrupt whose paste is not acknowledged: delivered false, unconfirmed, nothing armed", async () => {
    asClaude();
    fake.emit("prompt_submitted");
    fake.acks = false;
    let r: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      r = await runCliJson(
        ["agent", "send", "cdx", "stop that", "-w", "auth", "--interrupt", "--json"],
        dbPath,
      );
    });
    expect(r?.exitCode).toBeNull();
    expect(r?.data).toMatchObject({
      stopped: "unconfirmed",
      ack: "unknown",
      delivered: false,
      undelivered: { reason: "unconfirmed" },
    });
    expect(r?.data).not.toHaveProperty("runs");
    expect(fake.calls.filter((c) => c[0] === "paste-buffer")).toHaveLength(1);
  });

  it("mu agent abort: codex confirmed and settled; claude reads idle?, unsettled", async () => {
    fake.emit("prompt_submitted");
    const codex = await runCliJson(["agent", "abort", "cdx", "-w", "auth", "--json"], dbPath);
    expect(codex.exitCode).toBeNull();
    expect(codex.data).toMatchObject({
      before: "busy",
      after: "idle",
      aborted: true,
      settled: true,
      stopped: "confirmed",
    });
    expect(fake.submitted).toEqual([]);
    asClaude();
    fake.emit("prompt_submitted");
    const claude = await runCli(["agent", "abort", "cdx", "-w", "auth"], dbPath);
    expect(claude.exitCode).toBeNull();
    expect(claude.stdout).toContain("busy → idle?");
    const idle = await runCli(["agent", "abort", "cdx", "-w", "auth"], dbPath);
    expect(idle.stdout).toContain("nothing to abort");
  });

  it("--fresh: the harness's fresh command, then the text, confirmed by a run in the new session", async () => {
    fake.freshMode = "first-prompt";
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "start over", "-w", "auth", "--fresh", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      transport: "hooks",
      fresh: true,
      ack: "confirmed",
      runCount: 1,
      delivered: true,
    });
    expect(fake.submitted).toEqual(["/new", "start over"]);
  });

  it("--fresh to claude with no new session after /clear: exit 5, the text not sent", async () => {
    asClaude();
    fake.freshMode = "ignored";
    let r: Awaited<ReturnType<typeof runCliJson>> | undefined;
    await withEnv("MU_SEND_ACK_MS", "500", async () => {
      r = await runCliJson(
        ["agent", "send", "cdx", "start over", "-w", "auth", "--fresh", "--json"],
        dbPath,
      );
    });
    expect(r?.exitCode).toBe(5);
    expect(r?.doc).toMatchObject({ error: "AgentFreshUnconfirmedError" });
    expect(fake.submitted).toEqual(["/clear"]);
  });

  it("send --wait: settle returns the turn's last text, and its CLOSE block closes the task", async () => {
    addTask(db, { workstream: "auth", localId: "t1", title: "t1" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "cdx" });
    const text = 'Done.\n\nCLOSE: task=t1 evidence="npm test: 3 passed"\nREPORT:\nall done';
    let reads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      // The harness ends the turn after the paste's ack and the wait's first read saw it running:
      // a text read only once the turn is over cannot be told from an earlier turn's.
      if (fake.submitted.length > 0 && ++reads === 3) fake.emit("turn_stopped", { text });
      return fake.pane(pane);
    });
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "do t1", "-w", "auth", "--wait", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      firing: { kind: "settled", ref: "agent:auth/cdx", incarnation: "sess-1", runs: 1 },
      sent: { transport: "hooks", ack: "confirmed", delivered: true },
      snapshots: [{ settled: true, lastText: text, close: { applied: true, task: "t1" } }],
    });
    expect(getTask(db, "t1", "auth")?.status).toBe("CLOSED");
  });

  it("send --wait: the worker's Stop hook applied its CLOSE block first; the wait reads it already applied", async () => {
    addTask(db, { workstream: "auth", localId: "t1", title: "t1" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "cdx" });
    const text = 'Done.\n\nCLOSE: task=t1 evidence="npm test: 3 passed"\nREPORT:\nall done';
    // tmux 100 > zsh 200 > codex launcher 300 (anchored as cdx) > codex.real 301 > sh 400 > hook 500
    const rows: [number, number, string][] = [
      [100, 1, "tmux new-session -d -s mu-auth"],
      [200, 100, "-zsh"],
      [300, 200, "/usr/local/bin/codex --dangerously-bypass-approvals-and-sandbox"],
      [301, 300, "/opt/codex/bin/codex.real --dangerously-bypass-approvals-and-sandbox"],
      [400, 301, "/bin/sh -c mu hook stop codex"],
      [500, 400, "node /usr/local/lib/mu/dist/cli.js hook stop codex"],
    ];
    const deps: StopHookDeps = {
      table: () => new Map(rows.map(([pid, ppid, args]) => [pid, { pid, ppid, started: 1, args }])),
      self: 500,
      anchor: (row) =>
        row.pid === 300
          ? {
              agent_name: "cdx",
              workstream: "auth",
              cli: "codex",
              orchestrator: false,
              remote_key: null,
            }
          : null,
      env: {},
      readPane: async (pane) => parseHooksPane((await fake.pane(pane)) ?? ""),
    };
    let decision: StopDecision | undefined;
    let reads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      if (fake.submitted.length > 0 && ++reads === 3) {
        // codex runs its Stop hooks (mu's, murmur's) as the turn ends: mu's applies the block.
        decision = await runStopHook(
          db,
          "codex",
          {
            hook_event_name: "Stop",
            session_id: "sess-1",
            transcript_path: "/tmp/rollout.jsonl",
            stop_hook_active: false,
            last_assistant_message: text,
          },
          {},
          deps,
        );
        fake.emit("turn_stopped", { text });
      }
      return fake.pane(pane);
    });
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "do t1", "-w", "auth", "--wait", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(decision).toMatchObject({ decision: "allow" });
    expect(decision?.decision === "allow" && decision.why).toContain("applied (t1 closed)");
    expect(data).toMatchObject({
      firing: { kind: "settled", ref: "agent:auth/cdx", incarnation: "sess-1", runs: 1 },
      snapshots: [
        {
          settled: true,
          lastText: text,
          close: { applied: false, task: "t1", reason: "already applied", replayedClose: true },
        },
      ],
    });
    expect(getTask(db, "t1", "auth")?.status).toBe("CLOSED");
    const closes = db
      .prepare("SELECT COUNT(*) AS n FROM ops WHERE entity = 'task' AND intent = 'close.apply'")
      .get() as { n: number };
    expect(closes.n).toBe(1);
    expect(listNotes(db, "t1", "auth").map((n) => n.kind)).toEqual(["report", "close"]);
  });

  it("send --wait: a dialog the turn opens ends the wait as input, never as a finished run", async () => {
    let reads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      if (fake.submitted.length > 0 && ++reads === 2) {
        fake.emit("permission_requested", { message: "Bash" });
      }
      return fake.pane(pane);
    });
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cdx", "do t1", "-w", "auth", "--wait", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(7);
    expect(data).toMatchObject({
      firing: { kind: "input", ref: "agent:auth/cdx" },
      snapshots: [{ blocked: { kind: "permission", title: "Bash" } }],
    });
  });
});
