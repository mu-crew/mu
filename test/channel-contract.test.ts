// The AgentChannel contract (spec D4): one suite, run against every channel.
// Each channel declares what it can do (the D4 table); the suite holds it to
// exactly that, through the channel, through the wait seam that reads it, and
// through the delivery verbs (send, fresh, command, interrupt, abort). A real
// unix socket stands in for the mu pi extension; tmux is a stub whose murmur
// pane option reports the non-pi pane. The channel is the one the agents row
// recorded: neither its cli nor the env moves an agent to another channel.

import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import {
  AgentAbortNeedsCtlError,
  AgentCtlUnreachableError,
  AgentFreshNeedsCtlError,
  AgentSendUnsupportedError,
} from "../src/agents/errors.js";
import { type AgentRow, getAgent, insertAgent, sendToAgent } from "../src/agents.js";
import {
  type AgentChannel,
  agentChannel,
  type ChannelName,
  type ChannelTarget,
  channelTarget,
  ctlChannel,
  type DeliveryTarget,
  deliver,
  muxChannel,
  readAgentStates,
} from "../src/channels/index.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { type MuxBackend, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { withEnv } from "./_env.js";
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
  },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mch-"));
  db = openDb({ path: join(dir, "mu.db") });
  servers = [];
  ctlReqs = [];
  pasted = [];
  setMuxForTests(tmuxBackend);
  // %1 holds pi (no murmur option: ctl is its source); %2 a non-pi pane murmur reports working.
  setTmuxExecutor(async (args) =>
    args[0] === "list-panes"
      ? { stdout: "%1\t\t\n%2\tworking\t1000\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 },
  );
  setMurmurRunnerForTests(async () => null);
  resetAgentStateCacheForTests();
});
afterEach(() => {
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
    if (c.lastText) {
      expect(run).toMatchObject({ settled: true, runs: 3, lastText: "the last text" });
    } else {
      expect(run).toBeUndefined();
    }
  });

  it("the wait seam reads and watches through the channel", async () => {
    const hooks = ctlAgentHooks(db);
    const ref = { kind: "agent" as const, workstream: WS, id: agent.name };
    const read = await hooks.readAgents([ref], signal());
    expect(read.get(`${WS}/${agent.name}`)).toMatchObject({ status: c.liveState });
    // An owed ref with no fence counts from the channel's baseline; no baseline, no watch.
    const handle = await hooks.watchAgent(ref, signal(), { owed: true });
    if (!c.baseline) {
      expect(handle).toBeUndefined();
      return;
    }
    expect(handle?.afterRuns).toBe(3);
    expect(handle?.unknownBaseline).toMatchObject({ afterRuns: 3, incarnation: INC });
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

/** What each channel's delivery verbs do (the D4 table, `ctl` and `mux` columns). */
interface DeliveryContract {
  name: ChannelName;
  live: () => Promise<AgentRow>;
  /** True when a delivery writes a ctl op; false when it goes to the backend's `sendToPane`. */
  ctlOp: boolean;
  /** Without a backend `sendToPane` (tmux): a send is refused. */
  needsSendToPane: boolean;
  fresh: "delivers" | typeof AgentFreshNeedsCtlError;
  interrupt: "delivers" | typeof AgentAbortNeedsCtlError;
  abort: "delivers" | typeof AgentAbortNeedsCtlError;
}

const DELIVERY: DeliveryContract[] = [
  {
    name: "ctl",
    live: liveCtl,
    ctlOp: true,
    needsSendToPane: false,
    fresh: "delivers",
    interrupt: "delivers",
    abort: "delivers",
  },
  {
    name: "mux",
    live: liveMux,
    ctlOp: false,
    needsSendToPane: true,
    fresh: AgentFreshNeedsCtlError,
    interrupt: AgentAbortNeedsCtlError,
    abort: AgentAbortNeedsCtlError,
  },
];

const writes = () => ctlReqs.filter((r) => r.op !== "hello" && r.op !== "status");

describe.each(DELIVERY)("AgentChannel delivery contract: $name", (c) => {
  let target: DeliveryTarget;
  beforeEach(async () => {
    target = channelTarget(db, await c.live());
  });

  it("send: delivered on this channel, or refused where the backend cannot send", async () => {
    if (c.needsSendToPane) {
      await expect(deliver(target, "hello", {})).rejects.toBeInstanceOf(AgentSendUnsupportedError);
      expect(pasted).toEqual([]);
      sendingMux();
    }
    const sent = await deliver(target, "hello", {});
    expect(sent.transport).toBe(c.name);
    if (c.ctlOp) {
      expect(sent).toMatchObject({ runs: 3, incarnation: INC });
      expect(sent.msgId).toBeTypeOf("string");
      expect(writes()).toMatchObject([{ op: "send", text: "hello", mode: "followUp" }]);
      expect(pasted).toEqual([]);
    } else {
      expect(writes()).toEqual([]);
      expect(pasted).toEqual([{ paneId: target.agent.paneId, text: "hello" }]);
    }
  });

  it("command: a session command runs as the channel's command, else is typed as text", async () => {
    sendingMux();
    const sent = await deliver(target, "/compact keep it short", {});
    expect(sent.transport).toBe(c.name);
    if (c.ctlOp) {
      expect(sent.command).toBe("compact");
      expect(writes()).toMatchObject([
        { op: "command", name: "compact", instructions: "keep it short" },
      ]);
    } else {
      expect(pasted.map((p) => p.text)).toEqual(["/compact keep it short"]);
    }
    const direct = await agentChannel(target).command(target, { name: "reload" }, {});
    expect(direct.transport).toBe(c.name);
    if (c.ctlOp) expect(writes().at(-1)).toMatchObject({ op: "command", name: "reload" });
    else expect(pasted.at(-1)?.text).toBe("/reload");
  });

  it("fresh: a new session with the text, or the typed refusal", async () => {
    sendingMux();
    if (c.fresh !== "delivers") {
      await expect(deliver(target, "start", { fresh: true })).rejects.toBeInstanceOf(c.fresh);
      expect(pasted).toEqual([]);
      return;
    }
    const sent = await deliver(target, "start", { fresh: true });
    expect(sent.transport).toBe(c.name);
    expect(writes()).toMatchObject([{ op: "fresh", text: "start" }]);
  });

  it("interrupt: abort and send as one step, or the typed refusal", async () => {
    sendingMux();
    const run = agentChannel(target).interrupt(target, "now", { timeoutMs: 1000 });
    if (c.interrupt !== "delivers") {
      await expect(run).rejects.toBeInstanceOf(c.interrupt);
      expect(pasted).toEqual([]);
      return;
    }
    const r = await run;
    expect(r).toMatchObject({ wasBusy: false, runs: 3, incarnation: INC });
    expect(writes()).toMatchObject([{ op: "interrupt", text: "now", timeoutMs: 1000 }]);
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

  it("a write fence it cannot honour is refused, never skipped", async () => {
    sendingMux();
    let fenced = 0;
    const ctlGuard = {
      beforeWrite: () => {
        fenced += 1;
        return true;
      },
    };
    if (c.ctlOp) {
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
    }
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
    await withEnv("MU_HELPER_COMMAND", "pi --flag", async () => {
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
