// The channel registry and each built-in's capabilities (plugins spec D9, P4).
// The registry resolves an agent's channel by name; each built-in declares its
// row of the D9 matrix, and the run a delivery started is the channel's word
// (`sendRun`), equal to the rule the call sites computed by name before P4.

import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import {
  agentChannel,
  type ChannelCaps,
  type ChannelImpl,
  channelNamed,
  channelTarget,
  ctlChannel,
  hooksChannel,
  muxChannel,
  registerChannel,
  registeredChannels,
  sentRun,
  toSendResult,
} from "../src/channels/index.js";
import { unregisterChannelForTests } from "../src/channels/registry.js";
import { sentRunBaseline } from "../src/cli/wait-arm.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { answerProvesRunning, withJobLiveness } from "../src/jobs/kinds.js";
import type { JobKindName } from "../src/jobs/types.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { rmFixtureDir } from "./_fs.js";

/** The D9 matrix, as the spec states it. */
const MATRIX: Readonly<Record<"ctl" | "hooks" | "mux", ChannelCaps>> = {
  ctl: {
    fence: "sync",
    receipt: "exact",
    steer: "mid-turn",
    interrupt: "exact",
    fresh: "in-place",
    answer: false,
    command: true,
    watch: "stream",
    settleText: "tied",
  },
  hooks: {
    fence: "none",
    receipt: "acknowledged",
    steer: "none",
    interrupt: "unconfirmed",
    fresh: "in-place",
    answer: true,
    command: true,
    watch: "stream",
    settleText: "tied",
  },
  mux: {
    fence: "none",
    receipt: "none",
    steer: "as-send",
    interrupt: "none",
    fresh: "none",
    answer: true,
    command: true,
    watch: "poll",
    settleText: "none",
  },
};

/** A channel implementation: the mux channel's delivery and caps under another name. */
const fakeChannel = (name: string): ChannelImpl => ({
  ...muxChannel,
  name,
  readTurns: "base",
  watch: async () => undefined,
  lastRun: async () => undefined,
});

describe("the channel registry", () => {
  afterEach(() => {
    try {
      unregisterChannelForTests("fake");
    } catch {}
  });

  it("holds the built-ins by name; a null, absent or unknown name has none", () => {
    expect(channelNamed("ctl")).toBe(ctlChannel);
    expect(channelNamed("hooks")).toBe(hooksChannel);
    expect(channelNamed("mux")).toBe(muxChannel);
    expect(channelNamed(null)).toBeUndefined();
    expect(channelNamed(undefined)).toBeUndefined();
    expect(channelNamed("later")).toBeUndefined();
    expect(registeredChannels().slice(0, 3)).toEqual([ctlChannel, hooksChannel, muxChannel]);
  });

  it("registers a channel under its name, and refuses a taken name", () => {
    const fake = registerChannel(fakeChannel("fake"));
    expect(channelNamed("fake")).toBe(fake);
    expect(fake.name).toBe("fake");
    expect(() => registerChannel(fakeChannel("fake"))).toThrow(/already registered/);
    expect(() => registerChannel(fakeChannel("ctl"))).toThrow(/already registered/);
    expect(() => unregisterChannelForTests("ctl")).toThrow(/built in/);
    expect(channelNamed("ctl")).toBe(ctlChannel);
  });
});

describe("the D9 matrix", () => {
  it.each(["ctl", "hooks", "mux"] as const)("%s declares its row", (name) => {
    const channel = channelNamed(name);
    expect(channel?.caps).toEqual(MATRIX[name]);
    // The boolean fence is the capability's alias, never a second source.
    expect(channel?.fence).toBe(MATRIX[name].fence === "sync");
  });
});

describe("the run a delivery started (sendRun), as the call sites computed it", () => {
  it("ctl: the runs measured before it, with the incarnation; no runs: no run started", () => {
    expect(sentRun({ transport: "ctl", runs: 3, incarnation: "inc" })).toEqual({
      baseline: { runs: 3, incarnation: "inc" },
    });
    expect(sentRun({ transport: "ctl", runs: 0 })).toEqual({ baseline: { runs: 0 } });
    expect(sentRun({ transport: "ctl" })).toBeNull();
    expect(sentRun({ transport: "ctl", incarnation: "inc" })).toBeNull();
  });

  it("hooks: a confirmed paste's run less one, a remote `sent` its count, an unknown none", () => {
    const at = { transport: "hooks", runCount: 4, sessionId: "s1" } as const;
    expect(sentRun({ ...at, ack: "confirmed" })).toEqual({
      baseline: { runs: 3, incarnation: "s1" },
    });
    expect(sentRun({ ...at, ack: "confirmed", runCount: 0 })).toEqual({
      baseline: { runs: 0, incarnation: "s1" },
    });
    expect(sentRun({ ...at, ack: "sent" })).toEqual({ baseline: { runs: 4, incarnation: "s1" } });
    expect(sentRun({ ...at, ack: "unknown" })).toEqual({});
    expect(sentRun({ transport: "hooks", ack: "confirmed" })).toEqual({});
    expect(sentRun({ transport: "hooks" })).toEqual({});
    // An interrupt already carries its baseline as `runs`.
    expect(sentRun({ ...at, ack: "confirmed", runs: 7, incarnation: "s2" })).toEqual({
      baseline: { runs: 7, incarnation: "s2" },
    });
  });

  it("mux: owed with no baseline, whatever it carries", () => {
    expect(sentRun({ transport: "mux" })).toEqual({});
    expect(sentRun({ transport: "mux", runs: 2 })).toEqual({});
  });

  it("no transport or an unregistered one: its own runs, when present", () => {
    expect(sentRun({ runs: 2, incarnation: "i" })).toEqual({
      baseline: { runs: 2, incarnation: "i" },
    });
    expect(sentRun({})).toEqual({});
    expect(sentRun({ transport: "later" })).toEqual({});
  });

  it("each channel describes its own send and interrupt", () => {
    expect(muxChannel.describeSend({ transport: "mux" }, {})).toBe("via mux");
    expect(ctlChannel.describeSend({ transport: "ctl", state: "idle", runs: 2 }, {})).toBe(
      "via ctl, pi was idle, runs 2",
    );
    expect(ctlChannel.describeSend({ transport: "ctl", command: "new" }, {})).toBe(
      "via ctl, pi ran /new",
    );
    expect(ctlChannel.describeSend({ transport: "ctl" }, { fresh: true })).toBe(
      "via ctl, fresh session",
    );
    expect(ctlChannel.describeSend({ transport: "ctl", state: "busy" }, {})).toBe(
      "via ctl, pi busy",
    );
    expect(
      hooksChannel.describeSend({ transport: "hooks", ack: "confirmed", runCount: 4 }, {}),
    ).toBe("via hooks, confirmed: run 4");
    expect(
      hooksChannel.describeSend({ transport: "hooks", ack: "confirmed" }, { fresh: true }),
    ).toBe("via hooks, fresh session, confirmed");
    expect(hooksChannel.describeSend({ transport: "hooks", ack: "sent" }, {})).toBe(
      "via hooks to its host, sent: the next wait confirms it",
    );
    expect(ctlChannel.describeInterrupt({ wasBusy: true, pending: false, runs: 4 })).toBe(
      "via ctl, interrupted a busy run, runs 4",
    );
    expect(ctlChannel.describeInterrupt({ wasBusy: false, pending: false })).toBe(
      "via ctl, pi was idle",
    );
    expect(
      hooksChannel.describeInterrupt({
        wasBusy: true,
        pending: false,
        stopped: "unconfirmed",
        ack: "confirmed",
        runCount: 5,
      }),
    ).toBe("via hooks, interrupted a busy run, unconfirmed: idle?, confirmed: run 5");
    expect(hooksChannel.describeInterrupt({ wasBusy: false, pending: false, ack: "sent" })).toBe(
      "via hooks, it was idle, sent: the next wait confirms it",
    );
  });
});

describe("a channel target carries the row's job (ChannelTarget.job)", () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcr-"));
    db = openDb({ path: join(dir, "mu.db") });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmFixtureDir(dir);
  });

  it("a local pane's, a lease carrier's (its host), a command gate's (its token)", () => {
    const local = insertAgent(db, { name: "a", workstream: "w", paneId: "%1", cli: "pi" });
    expect(channelTarget(db, local).job).toEqual({
      kind: "pane",
      viewPaneId: "%1",
      agentId: local.incarnation,
      agent: { workstream: "w", name: "a" },
    });
    const lease = insertAgent(db, {
      name: "b",
      workstream: "w",
      paneId: "%2",
      cli: "pi",
      host: "box",
      hostTransport: "lease",
    });
    expect(channelTarget(db, lease).job).toMatchObject({
      kind: "lease",
      viewPaneId: "%2",
      host: { name: "box" },
    });
    const gate = insertAgent(db, {
      name: "c",
      workstream: "w",
      paneId: "%3",
      cli: "sh",
      host: "box",
      gateToken: "tok",
    });
    expect(channelTarget(db, gate).job).toMatchObject({
      kind: "gate",
      gateToken: "tok",
      host: { name: "box" },
    });
  });

  it("an answer stands in for liveness only where the job's kind says so", () => {
    expect(answerProvesRunning({ kind: "pane" })).toBe(true);
    expect(answerProvesRunning({ kind: "lease" })).toBe(true);
    expect(answerProvesRunning({ kind: "gate" })).toBe(false);
  });

  it("agentChannel resolves through the registry by the row's channel", () => {
    const hooks = insertAgent(db, {
      name: "h",
      workstream: "w",
      paneId: "%4",
      cli: "claude",
      channel: "hooks",
    });
    expect(agentChannel(channelTarget(db, hooks))).toBe(channelNamed("hooks"));
  });
});

describe("the normalized send reply (ChannelSendReply, D9/D13)", () => {
  const cloud = {
    channel: "cloud",
    ack: "exact",
    baseline: { runs: 7, incarnation: "s" },
  } as const;

  it("a plugin channel's reply gives its wait the reply's baseline", () => {
    expect(sentRun(cloud)).toEqual({ baseline: { runs: 7, incarnation: "s" } });
    expect(sentRunBaseline(cloud)).toEqual({ runs: 7, incarnation: "s" });
    expect(sentRun({ channel: "cloud", ack: "none" })).toEqual({});
  });

  it("converts to today's SendResult, whose wait baseline is the same", () => {
    const result = toSendResult({ ...cloud, msgId: "m1" });
    expect(result).toEqual({ transport: "cloud", runs: 7, incarnation: "s", msgId: "m1" });
    expect(sentRunBaseline(result)).toEqual({ runs: 7, incarnation: "s" });
    expect(toSendResult({ channel: "cloud", ack: "none" })).toEqual({ transport: "cloud" });
  });

  it("each built-in's result reads as the normalized reply", () => {
    expect(ctlChannel.sendRun({ transport: "ctl", runs: 3, incarnation: "i", msgId: "m" })).toEqual(
      { channel: "ctl", ack: "exact", msgId: "m", baseline: { runs: 3, incarnation: "i" } },
    );
    expect(ctlChannel.sendRun({ transport: "ctl", msgId: "m" })).toBeNull();
    expect(
      hooksChannel.sendRun({ transport: "hooks", ack: "confirmed", runCount: 4, sessionId: "s" }),
    ).toEqual({ channel: "hooks", ack: "acknowledged", baseline: { runs: 3, incarnation: "s" } });
    expect(hooksChannel.sendRun({ transport: "hooks", ack: "unknown", runCount: 4 })).toEqual({
      channel: "hooks",
      ack: "none",
    });
    expect(muxChannel.sendRun({ transport: "mux" })).toEqual({ channel: "mux", ack: "none" });
  });
});

describe("liveness by construction: the job kind decides, never the channel", () => {
  let dir: string;
  let servers: Server[];
  /** What the pane's view reports: its command runs, or ended. */
  let paneRuns: boolean;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcl-"));
    servers = [];
    paneRuns = true;
    setMuxForTests({
      ...tmuxBackend,
      paneResult: async () =>
        paneRuns ? { state: "running" } : { state: "exited", code: 0, signal: null },
    });
  });
  afterEach(() => {
    for (const s of servers) s.close();
    setMuxForTests(undefined);
    rmFixtureDir(dir);
  });

  /** A pi extension whose status always answers: the channel reports `ctl: ok`. */
  async function answering(name: string): Promise<void> {
    const path = ctlSocketPath("w", name, dir);
    mkdirSync(dirname(path), { recursive: true });
    const server = createServer((sock) => {
      sock.on("error", () => {});
      const dec = new LineDecoder();
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        for (const _line of dec.push(chunk)) {
          sock.end(encode({ v: 1, ok: true, state: "idle", since: 1, runs: 2, pending: false }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
  }

  const read = async (name: string, kind: JobKindName) =>
    (
      await ctlChannel.readStates(
        [{ name, workstreamName: "w", paneId: "%1", cli: "pi", job: { kind, viewPaneId: "%1" } }],
        { stateDir: dir },
      )
    ).get(`w/${name}`);

  it("a channel that answers while the job's kind says ended reads dead", async () => {
    await answering("g");
    paneRuns = false;
    // gate: an answer is not its liveness, so its ended view decides.
    expect(await read("g", "gate")).toMatchObject({
      ctl: "ok",
      alive: false,
      state: "needs_input",
    });
    paneRuns = true;
    expect(await read("g", "gate")).toMatchObject({ ctl: "ok", alive: true });
  });

  it("where the kind says an answer proves it runs, the answer stands", async () => {
    await answering("p");
    paneRuns = false;
    expect(await read("p", "pane")).toMatchObject({ ctl: "ok", alive: true });
    expect(await read("p", "lease")).toMatchObject({ ctl: "ok", alive: true });
  });

  it("withJobLiveness: no answer is never a death; an answer is the kind's to weigh", async () => {
    const turn = { state: "unknown", source: "none", since: null } as const;
    paneRuns = false;
    for (const ctl of ["missing", "refused", undefined] as const) {
      const r = await withJobLiveness(
        { ...turn, ...(ctl !== undefined ? { ctl } : {}) },
        { kind: "gate", viewPaneId: "%1" },
      );
      expect(r.alive, String(ctl)).toBe(true);
    }
    const answered = { ...turn, state: "busy", source: "ctl", ctl: "ok" } as const;
    expect((await withJobLiveness(answered, { kind: "gate", viewPaneId: "%1" })).alive).toBe(false);
    expect((await withJobLiveness(answered, { kind: "pane", viewPaneId: "%1" })).alive).toBe(true);
  });
});
