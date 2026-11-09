// Liveness at the channel seam (plugins spec D9, the P1 ruling; review of P4,
// round 2). A channel implementation (`ChannelImpl`) reports turn state and
// its link: its readings cannot carry `alive`, and its watch cannot report a
// dead agent except on the job's verdict (`JobGone`). Both are type errors
// below (`@ts-expect-error`: if the seam ever admits them, typecheck fails).
// At run time the composed channel and `readAgentStates` take `alive` from the
// job alone, whatever a channel (forced past the types) claims, and the
// composed reads cannot be replaced.

import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentKey, type StateAgentRef, type StateReading } from "../src/agent-state.js";
import { composedStates } from "../src/channels/compose.js";
import {
  type AgentChannel,
  type ChannelImpl,
  type ChannelObservation,
  type ChannelReading,
  composeChannel,
  ctlChannel,
  muxChannel,
  readAgentStates,
} from "../src/channels/index.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { answerProvesRunning, isJobGone, jobUp } from "../src/jobs/kinds.js";
import type { JobKindName } from "../src/jobs/types.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { rmFixtureDir } from "./_fs.js";

type TurnRead = Exclude<ChannelImpl["readTurns"], "base">;

/** The reviewer's reading: the socket answered, and the channel says alive (round 2). */
const claimsAlive = {
  state: "needs_input",
  source: "ctl",
  since: 1,
  ctl: "ok",
  alive: true,
} satisfies StateReading;

describe("the seam's types refuse a channel's liveness", () => {
  it("a channel's reading cannot carry `alive`", () => {
    // @ts-expect-error a ChannelReading has no `alive` (it is `never`)
    const reading: ChannelReading = claimsAlive;
    const planted: TurnRead = async (agents) =>
      // @ts-expect-error the reviewer's replacement reader: its readings set `alive`
      new Map(agents.map((a) => [agentKey(a), claimsAlive]));
    // A reading with no `alive` is a channel's to give.
    const turn: ChannelReading = { state: "needs_input", source: "ctl", since: 1, ctl: "ok" };
    expect([reading, planted, turn]).toHaveLength(3);
  });

  it("a channel's watch cannot write a dead agent; only the job's verdict is one", () => {
    const base = {
      workstream: "w",
      name: "a",
      agentId: 1,
      paneId: "%1",
      source: "ctl",
      since: null,
      settled: false,
    } as const;
    // @ts-expect-error status null (dead) is not a channel's to write
    const dead: ChannelObservation = { ...base, status: null };
    const unknown: ChannelObservation = { ...base, status: "unknown" };
    expect([dead, unknown]).toHaveLength(2);
  });

  it("the composed reads are read-only", () => {
    const read: AgentChannel["readStates"] = async (agents) =>
      new Map(agents.map((a) => [agentKey(a), claimsAlive]));
    // @ts-expect-error the reviewer's swap of the composed read
    expect(() => (ctlChannel.readStates = read)).toThrow(TypeError);
    // @ts-expect-error the watch is the channel layer's too
    expect(() => (ctlChannel.watch = muxChannel.watch)).toThrow(TypeError);
    expect(Object.isFrozen(ctlChannel)).toBe(true);
  });
});

describe("at run time, `alive` is the job's alone", () => {
  let dir: string;
  let servers: Server[];
  /** The view's command: runs, or ended. */
  let paneRuns: boolean;
  let probes: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcs-"));
    servers = [];
    paneRuns = true;
    probes = 0;
    setMuxForTests({
      ...tmuxBackend,
      paneResult: async () => {
        probes += 1;
        return paneRuns ? { state: "running" } : { state: "exited", code: 0, signal: null };
      },
    });
    // The batched view read: %1 present while it runs, else gone.
    setTmuxExecutor(async () => ({
      stdout: paneRuns ? "%1\t\t\n" : "",
      stderr: "",
      exitCode: 0,
    }));
  });
  afterEach(() => {
    for (const s of servers) s.close();
    setMuxForTests(undefined);
    resetTmuxExecutor();
    rmFixtureDir(dir);
  });

  /** A channel whose own read reports `link`, and (forced past the types) the `alive` it claims. */
  const lyingChannel = (
    link: "ok" | "missing" | "refused",
    claim: boolean | undefined,
  ): ChannelImpl => ({
    ...ctlChannel,
    name: "liar",
    readTurns: async (agents) =>
      new Map(
        agents.map((a) => [
          agentKey(a),
          {
            state: link === "ok" ? "needs_input" : "unknown",
            source: link === "ok" ? "ctl" : "none",
            since: null,
            ctl: link,
            ...(claim !== undefined ? { alive: claim } : {}),
          } as ChannelReading,
        ]),
      ),
    watch: async () => undefined,
    lastRun: async () => undefined,
  });

  const ref = (kind: JobKindName): StateAgentRef => ({
    name: "a",
    workstreamName: "w",
    paneId: "%1",
    cli: "pi",
    channel: "ctl",
    job: { kind, viewPaneId: "%1" },
  });

  it("the reviewer's reader (ok, alive:true) for an ended gate reads dead, after asking the view", async () => {
    paneRuns = false;
    const liar = composeChannel(lyingChannel("ok", true));
    const own = (await liar.readStates([ref("gate")], { stateDir: dir })).get("w/a");
    expect(own).toMatchObject({ ctl: "ok", alive: false });
    expect(probes).toBeGreaterThan(0);
    const all = (await composedStates([ref("gate")], () => liar, { stateDir: dir }, true)).get(
      "w/a",
    );
    expect(all).toMatchObject({ ctl: "ok", alive: false });
  });

  it("whatever the channel claims, alive is f(kind's answer, link, view)", async () => {
    for (const kind of ["pane", "lease", "gate"] as const)
      for (const link of ["ok", "missing", "refused"] as const)
        for (const view of [true, false])
          for (const claim of [true, false, undefined]) {
            paneRuns = view;
            const expected = link === "ok" ? answerProvesRunning({ kind }) || view : view; // no answer: the view's verdict
            const got = (
              await composedStates(
                [ref(kind)],
                () => lyingChannel(link, claim),
                { stateDir: dir },
                true,
              )
            ).get("w/a");
            expect(got?.alive, `${kind} ${link} view=${view} claim=${claim}`).toBe(expected);
          }
  });

  it("the built-in ctl channel goes through the same composition", async () => {
    const path = ctlSocketPath("w", "a", dir);
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
    paneRuns = false;
    const read = async (kind: JobKindName) =>
      (await readAgentStates([ref(kind)], { stateDir: dir })).get("w/a")?.alive;
    expect(await read("gate")).toBe(false);
    expect(await read("pane")).toBe(true);
    expect(await read("lease")).toBe(true);
  });

  it("jobUp: the only source of a gone verdict", async () => {
    paneRuns = false;
    expect(isJobGone(await jobUp({ kind: "pane", viewPaneId: "%1" }))).toBe(true);
    paneRuns = true;
    expect(await jobUp({ kind: "pane", viewPaneId: "%1" })).toBe("up");
    expect(isJobGone(null)).toBe(false);
    expect(isJobGone({})).toBe(false);
  });
});
