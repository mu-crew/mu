// The AgentChannel contract (spec D4): one suite, run against every channel.
// Each channel declares what it can do (the D4 table); the suite holds it to
// exactly that, through the channel and through the wait seam that reads it.
// A real unix socket stands in for the mu pi extension; tmux is a stub whose
// murmur pane option reports the non-pi pane.

import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import { type AgentRow, insertAgent } from "../src/agents.js";
import {
  type AgentChannel,
  agentChannel,
  type ChannelName,
  type ChannelTarget,
  channelTarget,
  ctlChannel,
  muxChannel,
  readAgentStates,
} from "../src/channels/index.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { rmFixtureDir } from "./_fs.js";

const WS = "chan";
const KNOWN_MSG = "msg-known";
let dir: string;
let db: Db;
let servers: Server[];

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
        const base = { v: 1, ok: true, incarnation: INC };
        if (req.op === "hello") sock.end(encode(helloReply()));
        else if (req.op === "wait") {
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

const CONTRACTS: Contract[] = [
  {
    name: "ctl",
    channel: ctlChannel,
    live: async () => {
      const a = insertAgent(db, { name: "pia", workstream: WS, paneId: "%1", cli: "pi" });
      await serveCtl(a);
      return a;
    },
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
    live: async () => insertAgent(db, { name: "cla", workstream: WS, paneId: "%2", cli: "claude" }),
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
