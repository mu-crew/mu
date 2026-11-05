// The AgentChannel contract (spec D4): one suite, run against every channel.
// Each channel declares what it can do (the D4 table); the suite holds it to
// exactly that, through the channel, through the wait seam that reads it, and
// through the delivery verbs (send, fresh, command, interrupt, abort, answer).
// A real unix socket stands in for the mu pi extension; tmux is a stub whose
// murmur pane option reports the non-pi panes; a fake hook harness
// (test/_fake-harness.ts) writes murmur inbox events for the `hooks` pane and
// answers the keys mu types into it (Escape, the fresh command, a dialog's
// choice) as a harness's hooks would. The channel is the one the agents row
// recorded: neither its cli nor the env moves an agent to another channel.

import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import {
  AgentAbortNeedsCtlError,
  AgentAnswerUnsupportedError,
  AgentCtlUnreachableError,
  AgentFreshNeedsCtlError,
  AgentNotBlockedError,
  AgentSendGateError,
  AgentSendUnsupportedError,
  AgentSteerUnsupportedError,
} from "../src/agents/errors.js";
import { type AgentRow, getAgent, insertAgent, sendToAgent } from "../src/agents.js";
import {
  setMurmurHookRunnerForTests,
  setMurmurPaneRunnerForTests,
} from "../src/channels/hooks-pane.js";
import {
  type AgentChannel,
  agentChannel,
  type ChannelName,
  type ChannelTarget,
  channelTarget,
  ctlChannel,
  type DeliveryTarget,
  deliver,
  hooksChannel,
  muxChannel,
  readAgentStates,
} from "../src/channels/index.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { type MuxBackend, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { withEnv } from "./_env.js";
import { type FakeHarness, fakeHarness } from "./_fake-harness.js";
import { rmFixtureDir } from "./_fs.js";

const WS = "chan";
const KNOWN_MSG = "msg-known";
let dir: string;
let db: Db;
let servers: Server[];
/** Every request the fake extension received, in order. */
let ctlReqs: Record<string, unknown>[];
/** Every `sendToPane` a sending backend received. */
let pasted: { paneId: string; text: string }[];
/** The hook harness in pane %3 (the `hooks` agent's pane). */
let fake: FakeHarness;

/** A fake extension: status (and `status {msgId}`), and a `wait` answered at once with a settled run. */
async function serveCtl(agent: AgentRow): Promise<void> {
  const path = ctlSocketPath(agent.workstreamName, agent.name, dirname(db.name));
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; msgId?: string; afterRuns?: number };
        ctlReqs.push(req);
        const base = { v: 1, ok: true, incarnation: INC };
        if (req.op === "hello") sock.end(encode(helloReply()));
        else if (["send", "fresh", "command", "interrupt"].includes(req.op)) {
          sock.end(encode({ ...base, state: "busy", since: 30, runs: 3, wasBusy: false }));
        } else if (req.op === "wait") {
          sock.end(
            encode({
              ...base,
              ended: "settled",
              state: "idle",
              since: 20,
              runs: (req.afterRuns ?? 3) + 1,
              pending: false,
              lastText: "the last text",
            }),
          );
        } else {
          const msg =
            req.msgId === undefined
              ? {}
              : {
                  msg: req.msgId === KNOWN_MSG ? { accepted: true, runs: 3 } : { accepted: false },
                };
          sock.end(encode({ ...base, state: "idle", since: 10, runs: 3, pending: false, ...msg }));
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

/** What each channel promises (the D4 table). */
interface Contract {
  name: ChannelName;
  channel: AgentChannel;
  /** A live agent on this channel, ready to read. */
  live: () => Promise<AgentRow>;
  /** An agent on this channel whose pane is gone. */
  gone: () => AgentRow;
  source: string;
  /** The live agent's runtime state. */
  liveState: string;
  fence: boolean;
  watches: boolean;
  baseline: boolean;
  receipts: boolean;
  lastText: boolean;
  /**
   * A run already over when read still gives its text. false: only a watch that saw the run
   * unsettled can tie the text to it (hooks: murmur does not say which turn wrote it).
   */
  endedText: boolean;
  /** Run the live agent's next turn to its end, where the channel reads it from the agent's own events. */
  drive?: () => void;
}

/** A live pi agent, its fake extension serving. */
async function liveCtl(): Promise<AgentRow> {
  const a = insertAgent(db, { name: "pia", workstream: WS, paneId: "%1", cli: "pi" });
  await serveCtl(a);
  return a;
}

/** A live non-pi pane that murmur reports working. */
async function liveMux(): Promise<AgentRow> {
  return insertAgent(db, { name: "cla", workstream: WS, paneId: "%2", cli: "claude" });
}

/**
 * A live hook harness on `hooks`: started, three runs settled, idle. Codex by
 * default (its new session starts on the first prompt); `cli` names another
 * harness on the same pane.
 */
async function liveHooks(cli = "codex"): Promise<AgentRow> {
  const a = insertAgent(db, {
    name: cli === "codex" ? "cdx" : cli.slice(0, 3),
    workstream: WS,
    paneId: "%3",
    cli,
    channel: "hooks",
  });
  fake.freshCommand = cli === "claude" ? "/clear" : "/new";
  fake.freshMode = cli === "claude" ? "immediate" : "first-prompt";
  fake.onEscape = cli === "claude" ? "silent" : "event";
  fake.emit("session_start", { source: "startup" });
  for (let i = 0; i < 3; i++) {
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: i === 2 ? "the last text" : `run ${i + 1}` });
  }
  return a;
}

const CONTRACTS: Contract[] = [
  {
    name: "ctl",
    channel: ctlChannel,
    live: liveCtl,
    gone: () => insertAgent(db, { name: "pig", workstream: WS, paneId: "%9", cli: "pi" }),
    source: "ctl",
    liveState: "needs_input",
    fence: true,
    watches: true,
    baseline: true,
    receipts: true,
    lastText: true,
    endedText: true,
  },
  {
    name: "mux",
    channel: muxChannel,
    live: liveMux,
    gone: () => insertAgent(db, { name: "clg", workstream: WS, paneId: "%9", cli: "claude" }),
    source: "murmur",
    liveState: "busy",
    fence: false,
    watches: false,
    baseline: false,
    receipts: false,
    lastText: false,
    endedText: false,
  },
  {
    name: "hooks",
    channel: hooksChannel,
    live: liveHooks,
    gone: () =>
      insertAgent(db, {
        name: "cdg",
        workstream: WS,
        paneId: "%9",
        cli: "codex",
        channel: "hooks",
      }),
    source: "murmur",
    liveState: "needs_input",
    fence: false,
    // Settle is the pane's `turn_stopped`, polled from murmur (D4).
    watches: true,
    // Settled turns and `session_id` stand in for pi's runs and incarnation (D4).
    baseline: true,
    receipts: false,
    lastText: true,
    endedText: false,
    drive: () => {
      fake.emit("prompt_submitted");
      fake.emit("turn_stopped", { text: "run 4" });
    },
  },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mch-"));
  db = openDb({ path: join(dir, "mu.db") });
  servers = [];
  ctlReqs = [];
  pasted = [];
  fake = fakeHarness(dir, "%3", INC);
  setMuxForTests(tmuxBackend);
  // %1 holds pi (no murmur option: ctl is its source); %2 a non-pi pane murmur reports working;
  // %3 the hook harness, whose option is what murmur's drain of its inbox published.
  setTmuxExecutor(
    async (args) =>
      fake.tmux(args) ??
      (args[0] === "list-panes"
        ? {
            stdout: `%1\t\t\n%2\tworking\t1000\n%3\t${fake.option()}\t2000\n`,
            stderr: "",
            exitCode: 0,
          }
        : { stdout: "", stderr: "", exitCode: 0 }),
  );
  setMurmurRunnerForTests(async () => null);
  setMurmurPaneRunnerForTests(fake.pane);
  setMurmurHookRunnerForTests(fake.hook);
  setSleepForTests(async () => {});
  resetAgentStateCacheForTests();
});
afterEach(() => {
  setMurmurPaneRunnerForTests(async () => null);
  setMurmurHookRunnerForTests(async () => false);
  resetSleep();
  resetTmuxExecutor();
  setMuxForTests(undefined);
  setMurmurRunnerForTests(null);
  resetAgentStateCacheForTests();
  for (const s of servers) s.close();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const signal = () => new AbortController().signal;

describe.each(CONTRACTS)("AgentChannel contract: $name", (c) => {
  let agent: AgentRow;
  let target: ChannelTarget;
  beforeEach(async () => {
    agent = await c.live();
    target = channelTarget(db, agent);
  });

  it("the agent routes to this channel, which declares its name and fence", () => {
    const ch = agentChannel(target);
    expect(ch).toBe(c.channel);
    expect(ch.name).toBe(c.name);
    expect(ch.fence).toBe(c.fence);
  });

  it("state: a live agent reads alive, from this channel's source", async () => {
    const r = (await readAgentStates([agent], { stateDir: target.stateDir })).get(
      `${WS}/${agent.name}`,
    );
    expect(r).toMatchObject({ alive: true, source: c.source, state: c.liveState });
    const own = (await c.channel.readStates([agent], { stateDir: target.stateDir })).get(
      `${WS}/${agent.name}`,
    );
    expect(own).toMatchObject({ alive: true, source: c.source });
  });

  it("state: a gone pane reads dead, never a guess", async () => {
    const g = c.gone();
    const r = (await readAgentStates([g], { stateDir: target.stateDir })).get(`${WS}/${g.name}`);
    expect(r?.alive).toBe(false);
  });

  it("watch: a run end is watched where the channel can, else the caller polls", async () => {
    const w = await c.channel.watch(target, signal(), { afterRuns: 3 });
    if (!c.watches) {
      expect(w).toBeUndefined();
      return;
    }
    expect(w?.afterRuns).toBe(3);
    c.drive?.();
    const settled = await w?.settled;
    expect(settled).toMatchObject({ settled: true, runs: 4, incarnation: INC });
  });

  it("baseline: the run count a wait counts from, or none", async () => {
    const b = await c.channel.baseline(target);
    if (c.baseline) expect(b).toEqual({ runs: 3, incarnation: INC });
    else expect(b).toBeUndefined();
  });

  it("receipt: accepted and not-accepted only where receipts exist; never throws", async () => {
    const known = await c.channel.receipt(target, KNOWN_MSG, 1000);
    const other = await c.channel.receipt(target, "msg-other", 1000);
    if (c.receipts) {
      expect(known).toMatchObject({ state: "accepted", id: KNOWN_MSG, runs: 3, incarnation: INC });
      expect(other).toEqual({ state: "not-accepted", id: "msg-other" });
    } else {
      expect(known.state).toBe("unreachable");
      expect(other.state).toBe("unreachable");
    }
  });

  it("last text: the settled run's text where the channel has one", async () => {
    const run = await c.channel.lastRun(target, { afterRuns: 2, ms: 1000 });
    if (!c.lastText) {
      expect(run).toBeUndefined();
      return;
    }
    if (c.endedText) {
      expect(run).toMatchObject({ settled: true, runs: 3, lastText: "the last text" });
      return;
    }
    // Over before the read: settled, but its text cannot be told from an earlier turn's.
    expect(run).toMatchObject({ settled: true, runs: 3 });
    expect(run?.lastText).toBeUndefined();
    const w = await c.channel.watch(target, signal(), { afterRuns: 3 });
    c.drive?.();
    expect(await w?.settled).toMatchObject({ settled: true, runs: 4, lastText: "run 4" });
  });

  it("the wait seam reads and watches through the channel", async () => {
    const hooks = ctlAgentHooks(db);
    const ref = { kind: "agent" as const, workstream: WS, id: agent.name };
    const read = await hooks.readAgents([ref], signal());
    expect(read.get(`${WS}/${agent.name}`)).toMatchObject({ status: c.liveState });
    // An owed ref with no fence counts from the channel's baseline; no baseline (or no
    // watch), no handle: the wait polls.
    const stop = new AbortController();
    const handle = await hooks.watchAgent(ref, stop.signal, { owed: true });
    if (!c.baseline || !c.watches) {
      expect(handle).toBeUndefined();
      return;
    }
    expect(handle?.afterRuns).toBe(3);
    expect(handle?.unknownBaseline).toMatchObject({ afterRuns: 3, incarnation: INC });
    // The watch ends with the wait that held it.
    stop.abort();
    await handle?.settled;
  });
});

/** The tmux stub plus a backend `sendToPane` (herdr's and Rex's delivery). */
function sendingMux(): void {
  const backend: MuxBackend = {
    ...tmuxBackend,
    sendToPane: async (paneId: string, text: string) => {
      pasted.push({ paneId, text });
    },
  };
  setMuxForTests(backend);
}

/** What each channel's delivery verbs do (the D4 table). */
interface DeliveryContract {
  name: ChannelName;
  live: () => Promise<AgentRow>;
  /**
   * How a send reaches the agent: a ctl op; the backend's `sendToPane` (refused
   * on a backend without one: tmux); or tmux's paste after clearing the input
   * line, confirmed by the harness's run count.
   */
  via: "ctl" | "sendToPane" | "paste";
  fresh: "delivers" | typeof AgentFreshNeedsCtlError;
  interrupt: "delivers" | typeof AgentAbortNeedsCtlError;
  abort: "delivers" | typeof AgentAbortNeedsCtlError;
  /** A mid-turn steer: queued over ctl, or the typed refusal. */
  steer: "delivers" | typeof AgentSteerUnsupportedError;
  /**
   * A dialog answer: refused (pi answers in its pane), typed as keys with no
   * event to confirm it (mux on tmux), or confirmed by the next event (hooks).
   */
  answer: "refused" | "unconfirmed" | "confirmed";
}

const DELIVERY: DeliveryContract[] = [
  {
    name: "ctl",
    live: liveCtl,
    via: "ctl",
    fresh: "delivers",
    interrupt: "delivers",
    abort: "delivers",
    steer: "delivers",
    answer: "refused",
  },
  {
    name: "mux",
    live: liveMux,
    via: "sendToPane",
    fresh: AgentFreshNeedsCtlError,
    interrupt: AgentAbortNeedsCtlError,
    abort: AgentAbortNeedsCtlError,
    steer: "delivers",
    answer: "unconfirmed",
  },
  {
    name: "hooks",
    live: liveHooks,
    via: "paste",
    fresh: "delivers",
    interrupt: "delivers",
    abort: "delivers",
    steer: AgentSteerUnsupportedError,
    answer: "confirmed",
  },
];

const writes = () => ctlReqs.filter((r) => r.op !== "hello" && r.op !== "status");
/** The tmux verbs mu sent the hook harness's pane, in order. */
const typed = () => fake.calls.map((c) => [c[0], ...c.filter((a) => a === "C-u" || a === "Enter")]);

describe.each(DELIVERY)("AgentChannel delivery contract: $name", (c) => {
  let target: DeliveryTarget;
  beforeEach(async () => {
    target = channelTarget(db, await c.live());
  });

  it("send: delivered on this channel, or refused where the backend cannot send", async () => {
    if (c.via === "sendToPane") {
      await expect(deliver(target, "hello", {})).rejects.toBeInstanceOf(AgentSendUnsupportedError);
      expect(pasted).toEqual([]);
      sendingMux();
    }
    const sent = await deliver(target, "hello", {});
    expect(sent.transport).toBe(c.name);
    if (c.via === "ctl") {
      expect(sent).toMatchObject({ runs: 3, incarnation: INC });
      expect(sent.msgId).toBeTypeOf("string");
      expect(writes()).toMatchObject([{ op: "send", text: "hello", mode: "followUp" }]);
      expect(pasted).toEqual([]);
    } else if (c.via === "sendToPane") {
      expect(writes()).toEqual([]);
      expect(pasted).toEqual([{ paneId: target.agent.paneId, text: "hello" }]);
    } else {
      // Cleared, pasted once, submitted; confirmed by the run count rising from 3.
      expect(sent).toEqual({ transport: "hooks", ack: "confirmed", runCount: 4, sessionId: INC });
      expect(typed()).toEqual([
        ["send-keys", "C-u"],
        ["set-buffer"],
        ["paste-buffer"],
        ["send-keys", "Enter"],
      ]);
      expect(fake.submitted).toEqual(["hello"]);
      expect(writes()).toEqual([]);
      expect(pasted).toEqual([]);
    }
  });

  it("steer: queued mid-turn where the channel can, else the typed refusal and nothing sent", async () => {
    sendingMux();
    const run = deliver(target, "steer me", { mode: "steer" });
    if (c.steer !== "delivers") {
      await expect(run).rejects.toBeInstanceOf(c.steer);
      expect(fake.calls).toEqual([]);
      expect(pasted).toEqual([]);
      return;
    }
    expect((await run).transport).toBe(c.name);
  });

  it("command: a session command runs as the channel's command, else is typed as text", async () => {
    sendingMux();
    const sent = await deliver(target, "/compact keep it short", {});
    expect(sent.transport).toBe(c.name);
    if (c.via === "ctl") {
      expect(sent.command).toBe("compact");
      expect(writes()).toMatchObject([
        { op: "command", name: "compact", instructions: "keep it short" },
      ]);
    } else if (c.via === "sendToPane") {
      expect(pasted.map((p) => p.text)).toEqual(["/compact keep it short"]);
    } else {
      expect(fake.submitted).toEqual(["/compact keep it short"]);
      // The paste started a run; the harness settles it before the next one.
      fake.emit("turn_stopped");
    }
    const direct = await agentChannel(target).command(target, { name: "reload" }, {});
    expect(direct.transport).toBe(c.name);
    if (c.via === "ctl") expect(writes().at(-1)).toMatchObject({ op: "command", name: "reload" });
    else if (c.via === "sendToPane") expect(pasted.at(-1)?.text).toBe("/reload");
    else expect(fake.submitted.at(-1)).toBe("/reload");
  });

  it("fresh: a new session with the text, or the typed refusal", async () => {
    sendingMux();
    if (c.fresh !== "delivers") {
      await expect(deliver(target, "start", { fresh: true })).rejects.toBeInstanceOf(c.fresh);
      expect(pasted).toEqual([]);
      expect(fake.calls).toEqual([]);
      return;
    }
    const sent = await deliver(target, "start", { fresh: true });
    expect(sent.transport).toBe(c.name);
    if (c.via === "ctl") {
      expect(writes()).toMatchObject([{ op: "fresh", text: "start" }]);
      return;
    }
    // codex's fresh command, then the text, confirmed by its run in the new session.
    expect(fake.submitted).toEqual(["/new", "start"]);
    expect(sent).toEqual({
      transport: "hooks",
      ack: "confirmed",
      runCount: 1,
      sessionId: `${INC}-2`,
    });
    expect(writes()).toEqual([]);
  });

  it("interrupt: abort and send as one step, or the typed refusal", async () => {
    sendingMux();
    const run = agentChannel(target).interrupt(target, "now", { timeoutMs: 1000 });
    if (c.interrupt !== "delivers") {
      await expect(run).rejects.toBeInstanceOf(c.interrupt);
      expect(pasted).toEqual([]);
      expect(fake.calls).toEqual([]);
      return;
    }
    const r = await run;
    expect(r).toMatchObject({ wasBusy: false, runs: 3, incarnation: INC });
    if (c.via === "ctl") {
      expect(writes()).toMatchObject([{ op: "interrupt", text: "now", timeoutMs: 1000 }]);
      return;
    }
    // Idle: no key, just the paste, confirmed by run 4 (the fence is the 3 settled before it).
    expect(r).toEqual({
      transport: "hooks",
      wasBusy: false,
      pending: false,
      runs: 3,
      incarnation: INC,
      ack: "confirmed",
      runCount: 4,
      sessionId: INC,
    });
    expect(typed().map((c) => c.join(" "))).not.toContain("send-keys Escape");
    expect(fake.submitted).toEqual(["now"]);
    expect(writes()).toEqual([]);
  });

  it("abort: an idle agent gets no abort, or the typed refusal", async () => {
    const run = agentChannel(target).abort(target, { timeoutMs: 1000 });
    if (c.abort !== "delivers") {
      await expect(run).rejects.toBeInstanceOf(c.abort);
      return;
    }
    expect(await run).toEqual({
      before: "idle",
      after: "idle",
      settled: true,
      aborted: false,
      pending: false,
    });
    expect(writes()).toEqual([]);
  });

  it("answer: keys for a pending dialog, refused while none is pending, or the typed refusal", async () => {
    const ch = agentChannel(target);
    if (c.answer === "refused") {
      await expect(ch.answer(target, ["1"], {})).rejects.toBeInstanceOf(
        AgentAnswerUnsupportedError,
      );
      expect(writes()).toEqual([]);
      return;
    }
    // No dialog is pending (murmur reads it working or idle): nothing is typed.
    await expect(ch.answer(target, ["1"], {})).rejects.toBeInstanceOf(AgentNotBlockedError);
    expect(fake.calls).toEqual([]);
    if (c.answer === "unconfirmed") {
      // --force types it anyway; nothing reports the dialog, so it stays unconfirmed.
      const keys: string[][] = [];
      setTmuxExecutor(async (args) => {
        if (args[0] === "send-keys") keys.push([...args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      expect(await ch.answer(target, ["1"], { force: true })).toEqual({
        transport: "mux",
        keys: ["1"],
        ack: "unknown",
      });
      expect(keys).toEqual([["send-keys", "-t", "%2", "-l", "--", "1"]]);
      return;
    }
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    const r = await ch.answer(target, ["1"], {});
    expect(r).toEqual({ transport: "hooks", keys: ["1"], ack: "confirmed" });
    expect(fake.calls).toEqual([["send-keys", "-t", "%3", "-l", "--", "1"]]);
    // A named key goes as a key, not as its letters.
    fake.emit("permission_requested", { message: "Edit" });
    await ch.answer(target, ["Enter"], {});
    expect(fake.calls.at(-1)).toEqual(["send-keys", "-t", "%3", "--", "Enter"]);
  });

  it("a write fence it cannot honour is refused, never skipped", async () => {
    sendingMux();
    let fenced = 0;
    const ctlGuard = {
      beforeWrite: () => {
        fenced += 1;
        return true;
      },
    };
    if (c.via === "ctl") {
      await deliver(target, "fenced", { ctlGuard });
      expect(fenced).toBe(1);
      // A session command has no fence on ctl: refused rather than run unfenced.
      await expect(deliver(target, "/new", { ctlGuard })).rejects.toBeInstanceOf(
        AgentSendUnsupportedError,
      );
      expect(writes().map((w) => w.op)).toEqual(["send"]);
    } else {
      await expect(deliver(target, "fenced", { ctlGuard })).rejects.toBeInstanceOf(
        AgentSendUnsupportedError,
      );
      expect(fenced).toBe(0);
      expect(pasted).toEqual([]);
      expect(fake.calls).toEqual([]);
    }
  });
});

// The hooks send gate and its ack (D4): what `murmur pane` reads before the
// paste decides whether it happens; the run count after it decides whether it
// is confirmed. Nothing is ever pasted twice.
/** Run `fn` with `key` set, and return what it returned. */
async function underEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  let out: { v: T } | undefined;
  await withEnv(key, value, async () => {
    out = { v: await fn() };
  });
  if (out === undefined) throw new Error("unreachable");
  return out.v;
}

describe("the hooks channel: send gate, ack, never resent", () => {
  let target: DeliveryTarget;
  beforeEach(async () => {
    target = channelTarget(db, await liveHooks());
  });
  const pastes = () => fake.calls.filter((c) => c[0] === "paste-buffer").length;

  it("no ack within MU_SEND_ACK_MS: unknown, reported as unconfirmed, pasted exactly once", async () => {
    fake.acks = false;
    const warnings: { reason: string; message: string }[] = [];
    const sent = await underEnv("MU_SEND_ACK_MS", "1000", () =>
      deliver(target, "anyone there?", { onUndelivered: (w) => warnings.push(w) }),
    );
    expect(sent).toEqual({ transport: "hooks", ack: "unknown", runCount: 3, sessionId: INC });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ reason: "unconfirmed" });
    expect(warnings[0]?.message).toContain("not resent");
    expect(pastes()).toBe(1);
    expect(fake.submitted).toEqual(["anyone there?"]);
  });

  it("an ack that arrives late, within the window, still confirms it", async () => {
    fake.acks = false;
    let reads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      reads += 1;
      // The harness's hook lands between the second and third read.
      if (reads === 3) fake.emit("prompt_submitted");
      return fake.pane(pane);
    });
    const sent = await underEnv("MU_SEND_ACK_MS", "1000", () => deliver(target, "slow", {}));
    expect(sent).toMatchObject({ ack: "confirmed", runCount: 4 });
    expect(pastes()).toBe(1);
  });

  it("a new session that started a run confirms it too", async () => {
    fake.acks = false;
    setMurmurPaneRunnerForTests(async (pane) => {
      if (fake.calls.some((c) => c[0] === "paste-buffer") && fake.pending() === 0) {
        fake.emit("session_start", { source: "clear", session_id: "s2" });
        fake.emit("prompt_submitted", { session_id: "s2" });
      }
      return fake.pane(pane);
    });
    const sent = await deliver(target, "after a clear", {});
    expect(sent).toMatchObject({ ack: "confirmed", runCount: 1, sessionId: "s2" });
  });

  it("blocked: refused, --force or not, and nothing typed: answer it instead", async () => {
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    for (const force of [false, true]) {
      const err = await deliver(target, "hello", { force }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentSendGateError);
      expect(err).toMatchObject({ state: "blocked", reason: "Bash" });
      expect((err as Error).message).toContain("mu agent answer cdx");
    }
    expect(fake.calls).toEqual([]);
  });

  it("running: refused without --force; --force pastes", async () => {
    fake.emit("prompt_submitted");
    await expect(deliver(target, "hello", {})).rejects.toMatchObject({
      name: "AgentSendGateError",
      state: "running",
    });
    expect(fake.calls).toEqual([]);
    expect(await deliver(target, "hello", { force: true })).toMatchObject({ ack: "confirmed" });
    expect(pastes()).toBe(1);
  });

  it("running with no event for MU_STALE_MS reads unknown and needs --force", async () => {
    fake.emit("prompt_submitted", { now: Date.now() - 60_000 });
    const err = await underEnv("MU_STALE_MS", "30000", () =>
      deliver(target, "hello", {}).catch((e: unknown) => e),
    );
    expect(err).toMatchObject({ name: "AgentSendGateError", state: "unknown" });
    expect((err as AgentSendGateError).reason).toMatch(/no event for 60s/);
    expect(fake.calls).toEqual([]);
  });

  it("idle? (an interrupt mu wrote, unconfirmed) is sendable", async () => {
    fake.emit("prompt_submitted");
    fake.emit("interrupted", { by: "mu" });
    expect(await deliver(target, "go on", {})).toMatchObject({ ack: "confirmed" });
  });

  it("a crashed harness, or a pane murmur cannot report, is unknown: --force pastes, unconfirmed", async () => {
    fake.emit("crashed");
    await expect(deliver(target, "hello", {})).rejects.toMatchObject({ state: "unknown" });
    setMurmurPaneRunnerForTests(async () => null);
    await expect(deliver(target, "hello", {})).rejects.toMatchObject({
      state: "unknown",
      reason: "murmur pane did not answer",
    });
    expect(fake.calls).toEqual([]);
    const sent = await underEnv("MU_SEND_ACK_MS", "500", () =>
      deliver(target, "hello", { force: true }),
    );
    expect(sent).toEqual({ transport: "hooks", ack: "unknown" });
    expect(pastes()).toBe(1);
  });

  it("a forced send whose gate read failed is never confirmed by the row's old run count", async () => {
    fake.acks = false;
    let reads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      reads += 1;
      // The gate's read times out; every later read is the existing row, run_count 3.
      return reads === 1 ? null : fake.pane(pane);
    });
    const sent = await underEnv("MU_SEND_ACK_MS", "500", () =>
      deliver(target, "hello", { force: true }),
    );
    expect(sent).toMatchObject({ transport: "hooks", ack: "unknown" });
    expect(pastes()).toBe(1);
  });

  it("an old error outranks a running turn in murmur's word: the gate still reads it running", async () => {
    fake.emit("prompt_submitted");
    fake.emit("turn_failed", { message: "overloaded" });
    fake.emit("prompt_submitted");
    expect(JSON.parse((await fake.pane("%3")) ?? "{}")).toMatchObject({ state: "error" });
    await expect(deliver(target, "hello", {})).rejects.toMatchObject({
      name: "AgentSendGateError",
      state: "running",
    });
    // A dialog under the same old error: blocked, --force or not, and answer still answers it.
    fake.emit("permission_requested", { message: "Bash" });
    expect(JSON.parse((await fake.pane("%3")) ?? "{}")).toMatchObject({ state: "error" });
    for (const force of [false, true]) {
      await expect(deliver(target, "hello", { force })).rejects.toMatchObject({
        state: "blocked",
        reason: "Bash",
      });
    }
    expect(fake.calls).toEqual([]);
    expect(await hooksChannel.answer(target, ["1"], {})).toMatchObject({ ack: "confirmed" });
  });

  it("a pane whose session ended keeps its attention but has no agent row: unknown", async () => {
    fake.emit("prompt_submitted");
    fake.emit("turn_failed", { message: "overloaded" });
    fake.emit("session_end", { reason: "logout" });
    expect(JSON.parse((await fake.pane("%3")) ?? "{}")).toMatchObject({
      state: "error",
      agent: null,
    });
    await expect(deliver(target, "hello", {})).rejects.toMatchObject({
      state: "unknown",
      reason: "murmur has no harness row for the pane",
    });
    expect(fake.calls).toEqual([]);
  });

  it("a text ending in ; or \\; reaches the input box as written", async () => {
    for (const text of ["fix the bug;", "a\\;", ";"]) {
      expect(await deliver(target, text, {})).toMatchObject({ ack: "confirmed" });
      fake.emit("turn_stopped");
    }
    expect(fake.submitted).toEqual(["fix the bug;", "a\\;", ";"]);
  });

  it("an empty send is refused before anything is read", async () => {
    let reads = 0;
    setMurmurPaneRunnerForTests(async (pane) => {
      reads += 1;
      return fake.pane(pane);
    });
    await expect(deliver(target, "", {})).rejects.toMatchObject({ name: "AgentEmptySendError" });
    await expect(deliver(target, "x", { mode: "steer" })).rejects.toBeInstanceOf(
      AgentSteerUnsupportedError,
    );
    expect(reads).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("a long multi-line text goes through one buffer in chunks, pasted once", async () => {
    const text = `${"line of a long brief\n".repeat(400)}end`;
    await deliver(target, text, {});
    const sets = fake.calls.filter((c) => c[0] === "set-buffer");
    expect(sets.length).toBeGreaterThan(1);
    expect(sets.slice(1).every((c) => c.includes("-a"))).toBe(true);
    expect(pastes()).toBe(1);
    expect(fake.submitted).toEqual([text]);
  });

  it("an unanswered dialog answer reads unknown, typed once", async () => {
    fake.answers = false;
    fake.emit("permission_requested", { message: "Bash" });
    const r = await underEnv("MU_SEND_ACK_MS", "500", () => hooksChannel.answer(target, ["n"], {}));
    expect(r).toEqual({ transport: "hooks", keys: ["n"], ack: "unknown" });
    expect(fake.calls).toHaveLength(1);
  });

  it("an answered dialog no harness event follows: mu writes `continued`, so a send is not refused as blocked", async () => {
    fake.answers = false;
    fake.emit("prompt_submitted");
    fake.emit("permission_requested", { message: "Bash" });
    await underEnv("MU_SEND_ACK_MS", "500", () => hooksChannel.answer(target, ["1"], {}));
    expect(fake.muEvents).toEqual([{ event: "continued", session_id: INC }]);
    // The turn runs on (a long tool call): running, which --force overrides; never blocked.
    await expect(deliver(target, "hello", {})).rejects.toMatchObject({ state: "running" });
    expect(await deliver(target, "hello", { force: true })).toMatchObject({ ack: "confirmed" });
  });

  it("a dialog answer the harness confirms writes nothing of mu's own", async () => {
    fake.emit("permission_requested", { message: "Bash" });
    expect(await hooksChannel.answer(target, ["1"], {})).toMatchObject({ ack: "confirmed" });
    expect(fake.muEvents).toEqual([]);
  });

  it("no verb on a hooks agent falls back to ctl, even with a socket at its derived path", async () => {
    await serveCtl(target.agent);
    expect(agentChannel(target)).toBe(hooksChannel);
    await deliver(target, "hello", {});
    fake.emit("turn_stopped");
    await agentChannel(target).command(target, { name: "compact" }, {});
    fake.emit("turn_stopped");
    await agentChannel(target).baseline(target);
    await agentChannel(target).receipt(target, KNOWN_MSG);
    expect(await deliver(target, "x", { fresh: true })).toMatchObject({ transport: "hooks" });
    const fresh = await agentChannel(target).watch(target, signal(), { afterRuns: 0 });
    fake.emit("turn_stopped", { text: "fresh done" });
    expect(await fresh?.settled).toMatchObject({ settled: true, lastText: "fresh done" });
    fake.emit("prompt_submitted");
    expect(await agentChannel(target).interrupt(target, "y", { timeoutMs: 1000 })).toMatchObject({
      transport: "hooks",
      wasBusy: true,
      stopped: "confirmed",
    });
    fake.emit("prompt_submitted");
    expect(await agentChannel(target).abort(target, { timeoutMs: 1000 })).toMatchObject({
      aborted: true,
    });
    await expect(agentChannel(target).answer(target, ["1"], {})).rejects.toThrow();
    const w = await agentChannel(target).watch(target, signal(), {});
    fake.emit("prompt_submitted");
    fake.emit("turn_stopped", { text: "watched" });
    expect(await w?.settled).toMatchObject({ settled: true, lastText: "watched" });
    await readAgentStates([target.agent], { stateDir: target.stateDir });
    expect(ctlReqs).toEqual([]);
  });
});

// D4: mu records each agent's channel on its row, and every verb reads the
// row, never the cli key or the env. A row older than the column (channel
// NULL) keeps the derived rule; each case below shows the two disagree.
describe("the agents row decides the channel", () => {
  const rowWith = (name: string, cli: string, channel: ChannelName | null): AgentRow =>
    insertAgent(db, { name, workstream: WS, paneId: "%2", cli, channel });
  // %2 answers display-message too, so a silent socket on it is unreachable, not a dead pane.
  beforeEach(() => {
    setTmuxExecutor(async (args) =>
      args[0] === "list-panes"
        ? { stdout: "%1\t\t\n%2\tworking\t1000\n", stderr: "", exitCode: 0 }
        : args[0] === "display-message"
          ? { stdout: `${args[2] ?? ""}\n`, stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 0 },
    );
  });

  it("insertAgent stores the channel, and getAgent reads it back", () => {
    rowWith("rc", "helper", "ctl");
    rowWith("rn", "helper", null);
    expect(getAgent(db, "rc", WS)?.channel).toBe("ctl");
    expect(getAgent(db, "rn", WS)?.channel).toBeNull();
    const raw = db.prepare("SELECT channel FROM agents WHERE name = 'rc'").get() as {
      channel: string | null;
    };
    expect(raw.channel).toBe("ctl");
  });

  it("an unknown stored value reads null, so the row is derived", () => {
    rowWith("rx", "pi", null);
    db.prepare("UPDATE agents SET channel = 'later' WHERE name = 'rx'").run();
    expect(getAgent(db, "rx", WS)?.channel).toBeNull();
  });

  it("a `ctl` row of a non-pi cli key is on ctl: its silent socket is unreachable, not a send-unsupported", async () => {
    const legacy = channelTarget(db, rowWith("hn", "helper", null));
    expect(agentChannel(legacy)).toBe(muxChannel);
    await expect(deliver(legacy, "hi", {})).rejects.toBeInstanceOf(AgentSendUnsupportedError);

    const recorded = channelTarget(db, rowWith("hc", "helper", "ctl"));
    expect(agentChannel(recorded)).toBe(ctlChannel);
    await expect(deliver(recorded, "hi", {})).rejects.toBeInstanceOf(AgentCtlUnreachableError);
    await expect(sendToAgent(db, "hc", "hi", { workstream: WS })).rejects.toBeInstanceOf(
      AgentCtlUnreachableError,
    );
  });

  it("a `mux` row is never on ctl because its cli key names pi", async () => {
    const legacy = channelTarget(db, rowWith("pn", "pi", null));
    expect(agentChannel(legacy)).toBe(ctlChannel);

    const recorded = channelTarget(db, rowWith("pm", "pi", "mux"));
    expect(agentChannel(recorded)).toBe(muxChannel);
    await expect(deliver(recorded, "hi", {})).rejects.toBeInstanceOf(AgentSendUnsupportedError);
    await expect(
      agentChannel(recorded).interrupt(recorded, "now", { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(AgentAbortNeedsCtlError);
    expect(ctlReqs).toEqual([]);
  });

  it("the env does not move a recorded row: MU_<KEY>_COMMAND naming pi leaves a `mux` row on mux", async () => {
    await underEnv("MU_HELPER_COMMAND", "pi --flag", async () => {
      expect(agentChannel(channelTarget(db, rowWith("en", "helper", null)))).toBe(ctlChannel);
      expect(agentChannel(channelTarget(db, rowWith("em", "helper", "mux")))).toBe(muxChannel);
    });
  });

  it("a `mux` row stays on mux when a socket answers at its derived path: a remote non-pi worker's ssh forward", async () => {
    const a = rowWith("wr", "helper", "mux");
    await serveCtl(a);
    const target = channelTarget(db, a);
    expect(agentChannel(target)).toBe(muxChannel);
    await expect(deliver(target, "hi", {})).rejects.toBeInstanceOf(AgentSendUnsupportedError);
    expect(ctlReqs).toEqual([]);
  });

  it("a row older than the column still falls back to its socket file", async () => {
    const a = rowWith("wl", "helper", null);
    await serveCtl(a);
    const target = channelTarget(db, a);
    expect(agentChannel(target)).toBe(ctlChannel);
    expect((await deliver(target, "hi", {})).transport).toBe("ctl");
  });

  it("a gate is on mux whatever its row says", () => {
    const g = insertAgent(db, {
      name: "gt",
      workstream: WS,
      paneId: "%2",
      cli: "pi",
      channel: "ctl",
      gateToken: "tok",
    });
    expect(agentChannel(channelTarget(db, g))).toBe(muxChannel);
  });
});
