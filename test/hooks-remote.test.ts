// The `hooks` channel's remote path (spec D11, U12): a hook harness worker on
// a host. The host is a fake node (test/_fake-remote-node.ts): the profile's
// exec template runs each remote command here with a fake `murmur` that keeps
// the worker's remote area. The local pane is the fake harness
// (test/_fake-harness.ts) standing in for the ssh pane: mu pastes into it, and
// the events mu relays land in its inbox. Nothing here reaches a real host;
// the live check on one is owed (see the CHANGELOG).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, insertAgent } from "../src/agents.js";
import { newRemoteKey, remoteAnchorWrapper } from "../src/anchors.js";
import {
  type HooksPane,
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import {
  parseRemoteOutput,
  reconcileEvents,
  relayPayload,
  remotePaneScript,
  type TextTurn,
  textTied,
  textTurnAfter,
} from "../src/channels/hooks-remote.js";
import { channelTarget, hooksChannel } from "../src/channels/index.js";
import type { RemoteSnapshot } from "../src/channels/types.js";
import { type Db, openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { remoteClose } from "../src/remote-collect.js";
import { claimTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { ensureWorkstream } from "../src/workstream.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { type FakeRemoteNode, fakeRemoteNode } from "./_fake-remote-node.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";

const KEY = "origin/auth.cw.0123456789ab";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let fake: FakeHarness;
let node: FakeRemoteNode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhr-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  node = fakeRemoteNode(dir);
  addHost(db, {
    name: "dev",
    shell: "echo {env} -- {cmd}",
    exec: node.exec,
    fetch: "true",
    repo: "/srv/repo",
    max_sessions: null,
  });
  insertAgent(db, {
    name: "cw",
    workstream: "auth",
    paneId: "%3",
    cli: "claude",
    channel: "hooks",
    host: "dev",
    cwd: "/srv/repo",
    remoteKey: KEY,
  });
  // The local pane is the transport: the harness runs on the node, so a paste
  // fires nothing here; each test says what the remote harness does with it.
  fake = fakeHarness(dir, "%3", "sess-1");
  fake.acks = false;
  fake.onEscape = "silent";
  fake.onSubmit = () => node.emit("prompt_submitted");
  node.emit("session_start", { source: "startup" });
  setSleepForTests(async () => {});
  setMurmurPaneRunnerForTests(fake.pane);
  setMurmurHookRunnerForTests(fake.hook);
  mux = installMux(
    "tmux",
    async (args) =>
      fake.tmux(args) ?? {
        stdout:
          args[0] === "display-message"
            ? `${(args.at(-1) ?? "")
                .replace("#{pane_id}", args[args.indexOf("-t") + 1] ?? "")
                .replace("#{pane_dead}", "0")
                .replace(/#\{[^}]+\}/g, "")}\n`
            : args[0] !== "list-panes"
              ? ""
              : args.includes("-s")
                ? "@1\t%3\tssh\n"
                : `%3\t${fake.option()}\t1\n`,
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

const reads = (): string[] => node.execCalls().filter((c) => c.includes("murmur pane --remote"));
const pasted = (): number => fake.calls.filter((c) => c[0] === "paste-buffer").length;

describe("the remote read", () => {
  it("one exec reads the key through the profile's template; its events are relayed in order, harness and agent named", async () => {
    node.emit("prompt_submitted");
    node.emit("turn_stopped", { text: "done" });
    const target = channelTarget(db, getAgent(db, "cw", "auth") ?? expect.fail("no row"));
    expect(target.remote?.key).toBe(KEY);
    const r = await target.remote?.read();
    expect(r).toMatchObject({
      ok: true,
      snapshot: {
        activity: "stopped",
        sessionId: "sess-1",
        runCount: 1,
        lastText: "done",
        events: 3,
        harnessEvents: 3,
      },
    });
    expect(node.execCalls()).toHaveLength(1);
    expect(node.pending()).toBe(0);
    expect(fake.muEvents.map((e) => e.event)).toEqual([
      "session_start",
      "prompt_submitted",
      "turn_stopped",
    ]);
    // The harness's own events stay the harness's on the origin pane (`--by harness`).
    expect(fake.muOrigins).toEqual(["harness", "harness", "harness"]);
    expect(fake.muEvents[2]).toMatchObject({
      event: "turn_stopped",
      harness: "claude",
      session_id: "sess-1",
      text: "done",
      agent: { agent_name: "cw", workstream: "auth", cli: "claude", driver: "orchestrated" },
    });
    // The local pane now reads the turn the node reported.
    const local = JSON.parse((await fake.pane("%3")) ?? "{}") as { agent: { run_count: number } };
    expect(local.agent.run_count).toBe(1);
  });

  it("a local agent's target has no remote reader", () => {
    insertAgent(db, {
      name: "lc",
      workstream: "auth",
      paneId: "%4",
      cli: "claude",
      channel: "hooks",
    });
    expect(channelTarget(db, getAgent(db, "lc", "auth") ?? expect.fail("no row")).remote).toBe(
      undefined,
    );
  });

  it("the script records mu's event before the read and says whether it was taken", () => {
    const script = remotePaneScript("h/k'ey", { event: "interrupted" });
    expect(script.startsWith("sh -c ")).toBe(true);
    const out = parseRemoteOutput(
      `motd noise\nMU_REMOTE_WRITE ok\nMU_REMOTE_PANE\n${JSON.stringify({ remote: "h/k'ey", state: "idle", agent: null, attention: [], events: [] })}\n`,
      "h/k'ey",
    );
    expect(out).toMatchObject({ written: "ok", events: [] });
    expect(parseRemoteOutput('MU_REMOTE_PANE\n{"remote":"other","events":[]}', "h/k'ey")).toMatch(
      /another key/,
    );
    expect(parseRemoteOutput("no marker", "k")).toMatch(/no murmur report/);
  });

  it("a relay names the row's harness when the event carries none, and drops placement fields", () => {
    const p = relayPayload(
      { event: "interrupted", harness: null, by: "mu", at: 1, session_id: "s", text: null },
      { name: "cw", workstreamName: "auth", paneId: "%3", harness: "codex", host: "dev", key: KEY },
    );
    expect(p).toEqual({
      event: "interrupted",
      harness: "codex",
      session_id: "s",
      agent: {
        agent_name: "cw",
        workstream: "auth",
        role: "worker",
        cli: "codex",
        driver: "orchestrated",
      },
    });
  });
});

describe("a read whose events never reached the pane", () => {
  const snap = (over: Partial<RemoteSnapshot> = {}): RemoteSnapshot => ({
    state: "idle",
    harness: "claude",
    sessionId: "s",
    runCount: 1,
    activity: "stopped",
    lastText: "t1",
    confirmed: true,
    claimed: true,
    attention: [],
    blocked: null,
    error: null,
    textTied: true,
    events: 0,
    harnessEvents: 0,
    ...over,
  });
  const pane = (over: Partial<HooksPane> = {}): HooksPane => ({
    state: "working",
    activity: "running",
    attention: [],
    sessionId: "s",
    runCount: 1,
    updatedAt: 1,
    blocked: null,
    error: null,
    errorAt: null,
    lastText: null,
    confirmed: true,
    ...over,
  });

  it("the next read brings the local pane back in line with the node: a lost turn_stopped is not lost for good", async () => {
    node.emit("prompt_submitted");
    node.emit("turn_stopped", { text: "done" });
    let refuse = true;
    setMurmurHookRunnerForTests(async (p, ev) => {
      if (refuse && ev.event === "turn_stopped") return false;
      return fake.hook(p, ev);
    });
    const target = channelTarget(db, getAgent(db, "cw", "auth") ?? expect.fail("no row"));
    const lostRead = await target.remote?.read();
    expect(lostRead).toMatchObject({ ok: false });
    expect(JSON.stringify(lostRead)).toContain("2 of 3 relayed");
    // The node applied (and deleted) all three: no read will relay the stop again.
    expect(node.pending()).toBe(0);
    const stuck = JSON.parse((await fake.pane("%3")) ?? "{}") as { agent: { activity: string } };
    expect(stuck.agent.activity).toBe("running");
    refuse = false;
    expect(await target.remote?.read()).toMatchObject({ ok: true, snapshot: { events: 0 } });
    const local = JSON.parse((await fake.pane("%3")) ?? "{}") as {
      agent: { activity: string; run_count: number; last_text: string };
    };
    expect(local.agent).toMatchObject({ activity: "stopped", run_count: 1, last_text: "done" });
    // In line now: a third read corrects nothing.
    const before = fake.muEvents.length;
    await target.remote?.read();
    expect(fake.muEvents.length).toBe(before);
  });

  it("a pane in line with its node needs nothing; one behind gets its session, runs and turn end replayed", () => {
    const fields = { session_id: "s" };
    expect(reconcileEvents(pane({ activity: "stopped", lastText: "t1" }), snap())).toEqual([]);
    expect(
      reconcileEvents(pane({ activity: null, sessionId: null, runCount: null }), snap()),
    ).toEqual([
      { event: "session_start", source: "startup", ...fields },
      { event: "prompt_submitted", ...fields },
      { event: "turn_stopped", text: "t1", ...fields },
    ]);
    // An interrupt mu wrote, a new failure, a turn running again, a dialog.
    expect(reconcileEvents(pane(), snap({ confirmed: false }))).toEqual([
      { event: "interrupted", ...fields },
    ]);
    expect(reconcileEvents(pane(), snap({ error: "rate limit" }))).toEqual([
      { event: "turn_failed", message: "rate limit", ...fields },
    ]);
    expect(
      reconcileEvents(
        pane({ activity: "stopped" }),
        snap({ activity: "running", blocked: "Bash", runCount: 1 }),
      ),
    ).toEqual([
      { event: "continued", ...fields },
      { event: "permission_requested", message: "Bash", ...fields },
    ]);
    // A released key, or a pane murmur does not answer for, is left alone.
    expect(reconcileEvents(pane(), snap({ claimed: false }))).toEqual([]);
    expect(reconcileEvents(undefined, snap())).toEqual([]);
  });

  it("a node that names an earlier turn as its text's: the corrected turn ends without that text", () => {
    const fields = { session_id: "s" };
    // Run 2 ended without text on the node, which kept run 1's; the local pane missed it.
    const kept = snap({ runCount: 2, lastText: "t1", lastTextRun: 1 });
    expect(reconcileEvents(pane({ runCount: 1, lastText: null }), kept)).toEqual([
      { event: "prompt_submitted", ...fields },
      { event: "turn_stopped", ...fields },
    ]);
    // Nor is it pushed into a stopped pane whose text differs.
    expect(reconcileEvents(pane({ activity: "stopped", runCount: 2 }), kept)).toEqual([]);
    // The last turn's own text still is.
    expect(
      reconcileEvents(pane({ runCount: 1 }), snap({ runCount: 2, lastText: "t2", lastTextRun: 2 })),
    ).toEqual([
      { event: "prompt_submitted", ...fields },
      { event: "turn_stopped", text: "t2", ...fields },
    ]);
  });

  it("an old node under a new local murmur: only a text mu's record ties is carried into the corrected turn", () => {
    const fields = { session_id: "s" };
    // Run 3 was the harness's own interrupt on a node too old to name its text's
    // run; the relay was lost and the local pane still runs run 3 holding run 2's text.
    const local = pane({ runCount: 3, lastText: "t2", lastTextRun: 2 });
    const kept = snap({ runCount: 3, lastText: "t2", textTied: false });
    // The local murmur would stamp a carried text with run 3: the turn ends without it.
    expect(reconcileEvents(local, kept)).toEqual([{ event: "turn_stopped", ...fields }]);
    // A text the record ties to run 3 is carried.
    expect(reconcileEvents(local, snap({ runCount: 3, lastText: "t3", textTied: true }))).toEqual([
      { event: "turn_stopped", text: "t3", ...fields },
    ]);
    // An older local murmur names no run: the text goes, and ownText's witness rule judges it.
    const { lastTextRun: _, ...old } = local;
    expect(reconcileEvents(old, kept)).toEqual([{ event: "turn_stopped", text: "t2", ...fields }]);
  });
});

describe("which turn the node's text belongs to", () => {
  const ev = (event: string, fields: Record<string, unknown> = {}) => ({ event, ...fields });
  const at = (runCount: number, sessionId = "s") => ({ sessionId, runCount });

  it("a turn's own text is tied to it; a later turn that ended without text (a failure, an interrupt) is not", () => {
    const t1 = textTurnAfter(
      undefined,
      [
        ev("session_start", { source: "startup", session_id: "s" }),
        ev("prompt_submitted"),
        ev("turn_stopped", { text: "a" }),
      ],
      at(1),
    );
    expect(t1).toMatchObject({ session: "s", runs: 1, textRuns: 1 });
    // Read again with nothing new: still tied.
    expect(textTurnAfter(t1, [], at(1)).textRuns).toBe(1);
    const failed = textTurnAfter(t1, [ev("prompt_submitted"), ev("turn_failed")], at(2));
    expect(failed).toMatchObject({ runs: 2, textRuns: 1 });
    const interrupted = textTurnAfter(t1, [ev("prompt_submitted"), ev("interrupted")], at(2));
    expect(interrupted.textRuns).toBe(1);
  });

  it("cursor-agent's text after its stop is its turn's, across reads; during the next turn it is still the earlier turn's", () => {
    const stopped = textTurnAfter(
      { session: "s", runs: 0, generation: null, generationRuns: null, textRuns: null },
      [ev("prompt_submitted"), ev("turn_stopped", { generation_id: "g1" })],
      at(1),
    );
    expect(stopped).toMatchObject({ generation: "g1", generationRuns: 1, textRuns: null });
    expect(
      textTurnAfter(stopped, [ev("turn_stopped", { generation_id: "g1", text: "x" })], at(1))
        .textRuns,
    ).toBe(1);
    const late = textTurnAfter(
      stopped,
      [
        ev("prompt_submitted"),
        ev("turn_stopped", { generation_id: "g1", text: "x" }),
        ev("turn_failed", { generation_id: "g2" }),
      ],
      at(2),
    );
    expect(late.textRuns).toBe(1);
  });

  it("a node whose murmur names the text's run is read by it, whatever mu's record says", () => {
    const none: TextTurn = {
      session: null,
      runs: null,
      generation: null,
      generationRuns: null,
      textRuns: null,
    };
    const tied: TextTurn = { ...none, session: "s", runs: 2, textRuns: 2 };
    const base = {
      state: "idle",
      harness: "codex",
      sessionId: "s",
      runCount: 2,
      activity: "stopped",
      lastText: "x",
      confirmed: true,
      claimed: true,
      attention: [],
      blocked: null,
      error: null,
      textTied: false,
      events: 0,
      harnessEvents: 0,
    };
    // No record (a read mu never received): the node's run still ties it.
    expect(textTied(none, { ...base, lastTextRun: 2 })).toBe(true);
    // The record says tied, the node says an earlier turn wrote it: not tied.
    expect(textTied(tied, { ...base, lastTextRun: 1 })).toBe(false);
    expect(textTied(tied, { ...base, lastTextRun: null })).toBe(false);
    // An older murmur names none: the record decides.
    expect(textTied(tied, base)).toBe(true);
    expect(textTied(none, base)).toBe(false);
  });

  it("a count that does not end at the node's (a read mu never received) ties nothing", () => {
    const prev: TextTurn = {
      session: "s",
      runs: 1,
      generation: null,
      generationRuns: null,
      textRuns: 1,
    };
    // The read with run 2's prompt and stop was lost; this one shows run 2 and nothing else.
    expect(textTurnAfter(prev, [], at(2))).toMatchObject({ runs: 2, textRuns: null });
    expect(textTurnAfter(prev, [], at(1, "other")).textRuns).toBe(null);
  });
});

describe("mu agent send to a remote hooks worker", () => {
  it("reads the node at the gate, pastes once and returns sent without polling it", async () => {
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cw", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      transport: "hooks",
      ack: "sent",
      runCount: 0,
      delivered: true,
    });
    expect(fake.submitted).toEqual(["hello"]);
    // One exec: the gate's. The run the paste started waits on the node for the next read.
    expect(reads()).toHaveLength(1);
    expect(node.pending()).toBe(1);
  });

  it("send --wait: the next read confirms the run and its CLOSE block closes the task", async () => {
    addTask(db, { workstream: "auth", localId: "t1", title: "t1" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "cw" });
    const text = 'Done.\n\nCLOSE: task=t1 evidence="npm test: 3 passed"\nREPORT:\nall done';
    fake.onSubmit = () => {
      node.emit("prompt_submitted");
      node.emit("turn_stopped", { text });
    };
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cw", "do t1", "-w", "auth", "--wait", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      firing: { kind: "settled", ref: "agent:auth/cw", incarnation: "sess-1", runs: 1 },
      sent: { transport: "hooks", ack: "sent", delivered: true },
      snapshots: [{ settled: true, lastText: text, close: { applied: true, task: "t1" } }],
    });
    expect(getTask(db, "t1", "auth")?.status).toBe("CLOSED");
    // The gate's read and the wait's: never one per ack poll.
    expect(reads()).toHaveLength(2);
  });

  it("a node that cannot be read refuses as unknown, nothing pasted; --force pastes anyway", async () => {
    node.failReads(true);
    const refused = await runCliJson(["agent", "send", "cw", "hi", "-w", "auth", "--json"], dbPath);
    expect(refused.exitCode).toBe(4);
    expect(refused.doc).toMatchObject({ error: "AgentSendGateError" });
    expect(JSON.stringify(refused.doc)).toContain("its host was not read");
    expect(pasted()).toBe(0);
    const forced = await runCliJson(
      ["agent", "send", "cw", "hi", "-w", "auth", "--force", "--json"],
      dbPath,
    );
    expect(forced.exitCode).toBeNull();
    expect(forced.data).toMatchObject({ transport: "hooks", ack: "sent" });
    expect(pasted()).toBe(1);
  });

  it("a node still running a turn refuses as running", async () => {
    node.emit("prompt_submitted");
    const { doc, exitCode } = await runCliJson(
      ["agent", "send", "cw", "hi", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(4);
    expect(JSON.stringify(doc)).toContain("running a turn");
    expect(pasted()).toBe(0);
  });

  it("--fresh is refused before any read or paste", async () => {
    const { doc, exitCode } = await runCliJson(
      ["agent", "send", "cw", "hi", "-w", "auth", "--fresh", "--json"],
      dbPath,
    );
    expect(exitCode).not.toBeNull();
    expect(doc).toMatchObject({ error: "AgentSendUnsupportedError" });
    expect(JSON.stringify(doc)).toContain("/clear");
    expect(node.execCalls()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("interrupt and answer on a remote hooks worker", () => {
  it("--interrupt: Escape in the pane, mu's interrupted recorded on the node in the same exec, then the paste", async () => {
    node.emit("prompt_submitted");
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cw", "stop that", "-w", "auth", "--interrupt", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({
      transport: "hooks",
      wasBusy: true,
      stopped: "unconfirmed",
      ack: "sent",
      runs: 1,
      incarnation: "sess-1",
      delivered: true,
    });
    expect(fake.calls[0]).toEqual(["send-keys", "-t", "%3", "--", "Escape"]);
    expect(node.muWrites()).toEqual([{ event: "interrupted", session_id: "sess-1" }]);
    // The gate's read, then the write with its read; the send reuses that one.
    expect(reads()).toHaveLength(2);
    expect(fake.submitted).toEqual(["stop that"]);
  });

  it("--interrupt on codex: its own Interrupt, relayed as the harness's, confirms the stop; mu writes nothing", async () => {
    insertAgent(db, {
      name: "cx",
      workstream: "auth",
      paneId: "%3",
      cli: "codex",
      channel: "hooks",
      host: "dev",
      cwd: "/srv/repo",
      remoteKey: KEY,
    });
    node.emit("prompt_submitted");
    // Escape reaches codex on the node, which reports its own interrupt.
    const tmux = fake.tmux.bind(fake);
    fake.tmux = (args) => {
      if (args[0] === "send-keys" && args.includes("Escape")) node.emit("interrupted");
      return tmux(args);
    };
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cx", "stop that", "-w", "auth", "--interrupt", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({ wasBusy: true, stopped: "confirmed", ack: "sent" });
    expect(node.muWrites()).toEqual([]);
    expect(fake.muOrigins.at(-1)).toBe("harness");
    expect(fake.submitted).toEqual(["stop that"]);
  });

  it("--interrupt on codex whose Interrupt has not reached the node yet: mu's is recorded, unconfirmed", async () => {
    insertAgent(db, {
      name: "cx",
      workstream: "auth",
      paneId: "%3",
      cli: "codex",
      channel: "hooks",
      host: "dev",
      cwd: "/srv/repo",
      remoteKey: KEY,
    });
    node.emit("prompt_submitted");
    const { data, exitCode } = await runCliJson(
      ["agent", "send", "cx", "stop that", "-w", "auth", "--interrupt", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({ wasBusy: true, stopped: "unconfirmed", ack: "sent" });
    expect(node.muWrites()).toEqual([{ event: "interrupted", session_id: "sess-1" }]);
  });

  it("a node that will not record the interrupt: AgentInterruptUnrecordedError, the text not sent", async () => {
    node.emit("prompt_submitted");
    node.failWrites(true);
    const { doc, exitCode } = await runCliJson(
      ["agent", "send", "cw", "stop that", "-w", "auth", "--interrupt", "--json"],
      dbPath,
    );
    expect(exitCode).toBe(5);
    expect(doc).toMatchObject({ error: "AgentInterruptUnrecordedError" });
    expect(fake.submitted).toEqual([]);
  });

  it("answer: continued is recorded on the node before the keys are typed", async () => {
    node.emit("prompt_submitted");
    node.emit("permission_requested", { message: "Bash" });
    let writesAtKeys = -1;
    const tmux = fake.tmux.bind(fake);
    fake.tmux = (args) => {
      if (args[0] === "send-keys" && writesAtKeys < 0) writesAtKeys = node.muWrites().length;
      return tmux(args);
    };
    const { data, exitCode } = await runCliJson(
      ["agent", "answer", "cw", "1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(data).toMatchObject({ transport: "hooks", keys: ["1"], ack: "unknown" });
    expect(node.muWrites()).toEqual([{ event: "continued", session_id: "sess-1" }]);
    expect(writesAtKeys).toBe(1);
  });
});

describe("an answer whose keys never reached the pane", () => {
  it("puts the dialog back on the node, so it still reads blocked", async () => {
    node.emit("prompt_submitted");
    node.emit("permission_requested", { message: "Bash" });
    const tmux = fake.tmux.bind(fake);
    fake.tmux = (args) =>
      args[0] === "send-keys" && args.includes("-l")
        ? { stdout: "", stderr: "can't find pane: %3", exitCode: 1 }
        : tmux(args);
    const { doc, exitCode } = await runCliJson(
      ["agent", "answer", "cw", "1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(exitCode).not.toBeNull();
    expect(doc).toHaveProperty("error");
    expect(node.muWrites()).toEqual([
      { event: "continued", session_id: "sess-1" },
      { event: "permission_requested", message: "Bash", session_id: "sess-1" },
    ]);
    const target = channelTarget(db, getAgent(db, "cw", "auth") ?? expect.fail("no row"));
    expect(await target.remote?.read()).toMatchObject({
      ok: true,
      snapshot: { state: "blocked", blocked: "Bash" },
    });
    const local = JSON.parse((await fake.pane("%3")) ?? "{}") as { state: string };
    expect(local.state).toBe("blocked");
  });
});

describe("a watch on a remote hooks worker", () => {
  it("reads the node every few polls, not every poll, and settles the turn past its baseline with its text", async () => {
    let localReads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      // The remote turn starts and ends while the watch runs.
      localReads += 1;
      if (localReads === 4) node.emit("prompt_submitted");
      if (localReads === 9) node.emit("turn_stopped", { text: "remote answer" });
      return fake.pane(pane);
    });
    const target = channelTarget(db, getAgent(db, "cw", "auth") ?? expect.fail("no row"));
    const watch = await hooksChannel.watch(target, new AbortController().signal, { afterRuns: 0 });
    const obs = await watch?.settled;
    expect(obs).toMatchObject({ settled: true, runs: 1, lastText: "remote answer" });
    expect(reads().length).toBeGreaterThan(1);
    expect(reads().length).toBeLessThan(localReads / 2);
  });
});

describe("a wait on a remote hooks worker whose pane has no row yet", () => {
  it("an owed wait from a spawn's baseline reads the node and settles its first turn with its text", async () => {
    // Just spawned: nothing relayed yet, the node already holds a finished turn.
    node.emit("prompt_submitted");
    node.emit("turn_stopped", { text: "first turn" });
    expect(JSON.parse((await fake.pane("%3")) ?? "{}")).toMatchObject({ agent: null });
    const agent = getAgent(db, "cw", "auth") ?? expect.fail("no row");
    const h = await ctlAgentHooks(db).watchAgent(
      { kind: "agent", workstream: "auth", id: "cw" },
      new AbortController().signal,
      { owed: true, baseline: { afterRuns: 0, agentId: agent.incarnation } },
    );
    expect(h).toBeDefined();
    expect(h?.afterRuns).toBe(0);
    expect(await h?.settled).toMatchObject({ settled: true, runs: 1, lastText: "first turn" });
    expect(reads().length).toBeGreaterThan(0);
  });

  it("a watch that starts before the node has a session reads it every few polls until one appears", async () => {
    // The harness has not started on the node yet: drop the session_start the setup wrote.
    for (const f of readdirSync(join(node.dir, "events"))) rmSync(join(node.dir, "events", f));
    let localReads = 0;
    setMurmurPaneRunnerForTests(async (p) => {
      localReads += 1;
      if (localReads === 6) node.emit("session_start", { source: "startup" });
      if (localReads === 8) node.emit("prompt_submitted");
      if (localReads === 14) node.emit("turn_stopped", { text: "booted" });
      return fake.pane(p);
    });
    const target = channelTarget(db, getAgent(db, "cw", "auth") ?? expect.fail("no row"));
    const watch = await hooksChannel.watch(target, new AbortController().signal, {});
    expect(watch).toBeDefined();
    expect(watch?.initial.status).toBe("busy");
    expect(watch?.afterRuns).toBe(undefined);
    expect(await watch?.settled).toMatchObject({ settled: true, runs: 1, lastText: "booted" });
  });

  it("a node that cannot be read at the start is retried, not given up", async () => {
    node.failReads(true);
    const target = channelTarget(db, getAgent(db, "cw", "auth") ?? expect.fail("no row"));
    const stop = new AbortController();
    const watch = await hooksChannel.watch(target, stop.signal, { afterRuns: 0 });
    expect(watch).toBeDefined();
    node.failReads(false);
    node.emit("prompt_submitted");
    node.emit("turn_stopped", { text: "late" });
    expect(await watch?.settled).toMatchObject({ settled: true, runs: 1, lastText: "late" });
  });
});

describe("collect's CLOSE on a remote hooks worker", () => {
  it("applies the last ended turn's CLOSE block from the node once", async () => {
    addTask(db, { workstream: "auth", localId: "t2", title: "t2" });
    await claimTask(db, "t2", { workstream: "auth", agentName: "cw" });
    node.emit("prompt_submitted");
    node.emit("turn_stopped", {
      text: 'ok\nCLOSE: task=t2 evidence="make check: green"\nREPORT:\nshipped',
    });
    const agent = getAgent(db, "cw", "auth") ?? expect.fail("no row");
    expect(await remoteClose(db, agent)).toEqual({ applied: true, task: "t2", reason: "closed" });
    expect(getTask(db, "t2", "auth")?.status).toBe("CLOSED");
    expect(await remoteClose(db, agent)).toMatchObject({
      applied: false,
      reason: "already applied",
    });
  });

  it("a turn still running, an unreadable node and a local agent apply nothing", async () => {
    const agent = getAgent(db, "cw", "auth") ?? expect.fail("no row");
    node.emit("prompt_submitted");
    expect(await remoteClose(db, agent)).toMatchObject({
      applied: false,
      reason: "its last turn has not ended",
    });
    node.failReads(true);
    expect((await remoteClose(db, agent))?.reason).toMatch(/its host was not read/);
    insertAgent(db, {
      name: "lc",
      workstream: "auth",
      paneId: "%4",
      cli: "claude",
      channel: "hooks",
    });
    expect(await remoteClose(db, getAgent(db, "lc", "auth") ?? expect.fail("no row"))).toBe(
      undefined,
    );
  });
});

describe("collect never applies an earlier turn's CLOSE block", () => {
  it("a later turn that ended without text, or failed, applies nothing", async () => {
    addTask(db, { workstream: "auth", localId: "t9", title: "t9" });
    const agent = getAgent(db, "cw", "auth") ?? expect.fail("no row");
    // Turn 1 names t9 while nobody holds it: nothing to close yet.
    node.emit("prompt_submitted");
    node.emit("turn_stopped", { text: 'CLOSE: task=t9 evidence="old"\nREPORT:\nx' });
    expect(await remoteClose(db, agent)).toMatchObject({ applied: false });
    await claimTask(db, "t9", { workstream: "auth", agentName: "cw" });
    // Turn 2 ends without text: murmur keeps turn 1's.
    node.emit("prompt_submitted");
    node.emit("turn_stopped");
    expect(await remoteClose(db, agent)).toEqual({
      applied: false,
      task: null,
      reason: "its last turn's text cannot be tied to that turn",
    });
    // Turn 3 fails (a claude StopFailure).
    node.emit("prompt_submitted");
    node.emit("turn_failed", { message: "rate limit" });
    expect((await remoteClose(db, agent))?.reason).toMatch(/cannot be tied/);
    expect(getTask(db, "t9", "auth")?.status).toBe("IN_PROGRESS");
  });

  it("a turn whose text arrived in a read collect did not make is still its own", async () => {
    addTask(db, { workstream: "auth", localId: "t3", title: "t3" });
    await claimTask(db, "t3", { workstream: "auth", agentName: "cw" });
    node.emit("prompt_submitted");
    node.emit("turn_stopped", { text: 'CLOSE: task=t3 evidence="ok"\nREPORT:\ny' });
    const agent = getAgent(db, "cw", "auth") ?? expect.fail("no row");
    // A send gate's read relays the turn first (a refused answer, say).
    await channelTarget(db, agent).remote?.read();
    expect(await remoteClose(db, agent)).toEqual({ applied: true, task: "t3", reason: "closed" });
  });
});

describe("the remote anchor", () => {
  it("is written under the remote HOME alone with the worker's key, then the command runs in place", () => {
    const home = join(dir, "remote-home");
    mkdirSync(home);
    const key = newRemoteKey("auth", "cw");
    expect(key).toMatch(/^[^/]+\/auth\.cw\.[0-9a-f]{12}$/);
    const out = execFileSync(
      "/bin/sh",
      [
        "-c",
        remoteAnchorWrapper("echo ran:$$", {
          agent_name: "cw",
          workstream: "auth",
          role: "worker",
          cli: "claude",
          orchestrator: false,
          remote_key: key,
        }),
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          SHELL: "/bin/sh",
          // murmur reads the home dir first, so the XDG state home gets nothing.
          XDG_STATE_HOME: join(dir, "remote-xdg"),
        },
      },
    );
    const pid = /^ran:(\d+)$/m.exec(out)?.[1];
    const anchors = join(home, ".local", "state", "mu-next", "anchors");
    expect(readdirSync(anchors)).toEqual([`${pid}.json`]);
    expect(existsSync(join(dir, "remote-xdg"))).toBe(false);
    expect(JSON.parse(readFileSync(join(anchors, `${pid}.json`), "utf8"))).toMatchObject({
      agent_name: "cw",
      cli: "claude",
      remote_key: key,
      start_time: expect.any(Number),
    });
  });
});
