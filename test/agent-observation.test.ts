// AgentObservation: the ONE typed result of reading or watching an agent,
// extracted from the existing readAgentStates / ctl-wait seam. A real unix
// socket stands in for the mu pi extension; tmux is a stub.

import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAgentStateCacheForTests, setMurmurRunnerForTests } from "../src/agent-state.js";
import { AgentRestartedError } from "../src/agents/errors.js";
import {
  type AgentObservation,
  observationFromReading,
  observeAgentStates,
  settledCloseInput,
  toStatusSnapshot,
  watchAgentRun,
} from "../src/agents/observe.js";
import { agentCtlSocket } from "../src/agents/transport.js";
import { type AgentRow, insertAgent } from "../src/agents.js";
import { applySettledClose } from "../src/close-block.js";
import { encode, INCARNATION_MISMATCH, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { claimTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { pollUntil } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";

const WS = "obs";
let dir: string;
let db: Db;
let servers: Server[];
let pia: AgentRow;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mso-"));
  db = openDb({ path: join(dir, "mu.db") });
  servers = [];
  setMuxForTests(tmuxBackend);
  setTmuxExecutor(async (args) =>
    args[0] === "list-panes"
      ? { stdout: "%1\t\t\n%2\tworking\t1000\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 },
  );
  setMurmurRunnerForTests(async () => null);
  resetAgentStateCacheForTests();
  pia = insertAgent(db, { name: "pia", workstream: WS, paneId: "%1", cli: "pi" });
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

type Reply = Record<string, unknown>;
interface Fake {
  /** Requests received, by op. */
  ops: string[];
  /** Once the `wait` request has arrived, answer every held one with `reply`. */
  release: (reply: Reply) => Promise<void>;
  /** Resolves once a `wait` request is held. */
  held: () => Promise<void>;
  /** Once the `wait` request has arrived, drop every held wait connection; keep serving. */
  drop: () => Promise<void>;
}

/** A fake extension. status: what `status` answers (merged over a base); wait: held until release. */
async function fake(status: Reply, agent: AgentRow = pia): Promise<Fake> {
  const path = agentCtlSocket(db, agent);
  mkdirSync(dirname(path), { recursive: true });
  const ops: string[] = [];
  const held: import("node:net").Socket[] = [];
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; incarnation?: string };
        ops.push(req.op);
        if (req.op === "hello") sock.end(encode(helloReply()));
        else if (req.op === "wait" && req.incarnation !== undefined && req.incarnation !== INC) {
          sock.end(encode({ v: 1, ok: false, error: INCARNATION_MISMATCH, incarnation: INC }));
        } else if (req.op === "wait") held.push(sock);
        else
          sock.end(
            encode({
              v: 1,
              ok: true,
              incarnation: INC,
              state: "busy",
              since: 10,
              runs: 3,
              pending: false,
              ...status,
            }),
          );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return {
    ops,
    release: async (reply) => {
      await pollUntil(() => held.length > 0, { description: "ctl wait request" });
      for (const s of held.splice(0)) s.end(encode({ v: 1, ok: true, incarnation: INC, ...reply }));
    },
    held: () => pollUntil(() => held.length > 0, { description: "ctl wait request" }),
    drop: async () => {
      await pollUntil(() => held.length > 0, { description: "ctl wait request" });
      for (const s of held.splice(0)) s.destroy();
    },
  };
}

const ctl = (a: AgentRow = pia) => ({ signal: new AbortController().signal, agent: a });

describe("observeAgentStates / observationFromReading", () => {
  it("a ctl status read carries registry id + pane, ctl incarnation, runs, pending, source, since", async () => {
    await fake({ state: "busy", since: 1_790_000_000_000, runs: 3, pending: true });
    const obs = (await observeAgentStates(db, [pia])).get(`${WS}/pia`);
    expect(obs).toEqual({
      workstream: WS,
      name: "pia",
      agentId: pia.incarnation,
      paneId: "%1",
      status: "busy",
      source: "ctl",
      since: 1_790_000_000_000,
      ctl: "ok",
      incarnation: INC,
      runs: 3,
      pending: true,
      settled: false,
    });
    // The registry id is a number; pi's incarnation is the string.
    expect(typeof obs?.agentId).toBe("number");
    expect(typeof obs?.incarnation).toBe("string");
  });

  it("an idle status read is NOT a settle: needs_input, settled false, nothing to close", async () => {
    await fake({ state: "idle", since: 5, runs: 4 });
    const obs = (await observeAgentStates(db, [pia])).get(`${WS}/pia`);
    expect(obs).toMatchObject({ status: "needs_input", runs: 4, settled: false });
    expect(obs === undefined ? undefined : settledCloseInput(obs)).toBeUndefined();
  });

  it("an open dialog reads needs_permission with the blocked dialog and its reason", async () => {
    await fake({
      state: "busy",
      since: 1,
      runs: 0,
      blocked: { kind: "confirm", title: "Allow?", since: 42 },
    });
    expect((await observeAgentStates(db, [pia])).get(`${WS}/pia`)).toMatchObject({
      status: "needs_permission",
      since: 42,
      blocked: { kind: "confirm", title: "Allow?", since: 42 },
      reason: "dialog confirm: Allow?",
      settled: false,
    });
  });

  it("a missing socket is unknown with the reason and ctl link, no incarnation or runs", async () => {
    const obs = (await observeAgentStates(db, [pia])).get(`${WS}/pia`);
    expect(obs).toMatchObject({ status: "unknown", ctl: "missing", reason: "ctl missing" });
    expect(obs).not.toHaveProperty("incarnation");
    expect(obs).not.toHaveProperty("runs");
  });

  it("a gone pane is status null (dead)", () => {
    const obs = observationFromReading(pia, {
      state: "unknown",
      source: "none",
      since: null,
      alive: false,
      reason: "pane gone",
    });
    expect(obs).toMatchObject({ status: null, reason: "pane gone", settled: false });
  });

  it("a non-pi agent keeps murmur's reading: no ctl, incarnation or runs", async () => {
    const sh = insertAgent(db, { name: "shx", workstream: WS, paneId: "%2", cli: "sh" });
    const obs = (await observeAgentStates(db, [sh])).get(`${WS}/shx`);
    expect(obs).toMatchObject({
      status: "busy",
      source: "murmur",
      since: 1000,
      agentId: sh.incarnation,
    });
    expect(obs).not.toHaveProperty("ctl");
    expect(obs).not.toHaveProperty("incarnation");
  });
});

describe("watchAgentRun", () => {
  it("settles with the run's own incarnation, runs, text, truncation flag and session file", async () => {
    const ext = await fake({ state: "busy", since: 1, runs: 3 });
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, {});
    expect(w).toBeDefined();
    // The baseline came from a status read taken BEFORE the wait.
    expect(w?.afterRuns).toBe(3);
    expect(w?.initial).toMatchObject({ status: "busy", runs: 3, incarnation: INC, settled: false });
    await ext.release({
      ended: "settled",
      state: "idle",
      since: 20,
      runs: 4,
      pending: false,
      lastText: "all done",
      lastTextTruncated: true,
      sessionFile: "/s/x.jsonl",
    });
    const done = await w?.settled;
    expect(done).toEqual({
      workstream: WS,
      name: "pia",
      agentId: pia.incarnation,
      paneId: "%1",
      status: "needs_input",
      source: "ctl",
      since: 20,
      incarnation: INC,
      runs: 4, // the SETTLED run, not the baseline 3
      pending: false,
      settled: true,
      lastText: "all done",
      lastTextTruncated: true,
      sessionFile: "/s/x.jsonl",
    });
  });

  it("an explicit afterRuns needs no status probe and is the baseline reported", async () => {
    const ext = await fake({ state: "busy", since: 1, runs: 9 });
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, { afterRuns: 1 });
    expect(w?.afterRuns).toBe(1);
    expect(w?.initial).toMatchObject({ status: "busy", settled: false });
    expect(ext.ops).not.toContain("status");
  });

  it("a dialog ends the wait unsettled: needs_permission, blocked, no settled facts", async () => {
    const ext = await fake({ state: "busy", since: 1, runs: 3 });
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, {});
    await ext.release({
      ended: "blocked",
      state: "busy",
      since: 1,
      runs: 3,
      pending: false,
      blocked: { kind: "select", since: 77 },
    });
    const done = await w?.settled;
    expect(done).toMatchObject({
      status: "needs_permission",
      settled: false,
      runs: 3,
      incarnation: INC,
      blocked: { kind: "select", since: 77 },
    });
    expect(done).not.toHaveProperty("lastText");
    expect(done === undefined ? undefined : settledCloseInput(done)).toBeUndefined();
  });

  it("a reply with no `ended` (older extension) is not a settle for closing", async () => {
    const ext = await fake({ state: "busy", since: 1, runs: 3 });
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, {});
    await ext.release({ state: "idle", since: 2, runs: 4, pending: false, lastText: "x" });
    const done = await w?.settled;
    expect(done).toMatchObject({ status: "needs_input", settled: false, lastText: "x" });
    expect(done === undefined ? undefined : settledCloseInput(done)).toBeUndefined();
  });

  it("pinning the wrong incarnation rejects with AgentRestartedError (never unknown)", async () => {
    await fake({ state: "busy", since: 1, runs: 3 });
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, {
      afterRuns: 0,
      inc: "other-process",
    });
    await expect(w?.settled).rejects.toBeInstanceOf(AgentRestartedError);
  });

  it("a dropped connection to a socket that still answers is unknown 'ctl wait interrupted'", async () => {
    const ext = await fake({ state: "busy", since: 1, runs: 3 });
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, {});
    await ext.drop();
    expect(await w?.settled).toMatchObject({
      status: "unknown",
      reason: "ctl wait interrupted",
      settled: false,
    });
  });

  it("a dropped connection to a dead socket is status null (the pi is gone)", async () => {
    const ext = await fake({ state: "busy", since: 1, runs: 3 });
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, {});
    await ext.held();
    for (const s of servers) s.close();
    servers = [];
    // Unlink so the probe sees ENOENT, as after a pi exit.
    (await import("node:fs")).rmSync(agentCtlSocket(db, pia), { force: true });
    await ext.drop();
    expect(await w?.settled).toMatchObject({ status: null, settled: false });
  });

  it("aborting the signal cancels the watch: unknown, not a death and not a settle", async () => {
    await fake({ state: "busy", since: 1, runs: 3 });
    const abort = new AbortController();
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), abort.signal, {});
    abort.abort();
    expect(await w?.settled).toMatchObject({ status: "unknown", settled: false });
  });

  it("a non-ctl agent has no watch (stays polled)", async () => {
    const sh = insertAgent(db, { name: "shy", workstream: WS, paneId: "%2", cli: "sh" });
    expect(await watchAgentRun(sh, agentCtlSocket(db, sh), ctl().signal, {})).toBeUndefined();
  });

  it("a pi agent whose socket does not answer has no watch", async () => {
    expect(await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, {})).toBeUndefined();
  });
});

describe("settledCloseInput", () => {
  const settled = (over: Partial<AgentObservation> = {}): AgentObservation => ({
    workstream: WS,
    name: "pia",
    agentId: 7,
    paneId: "%1",
    status: "needs_input",
    source: "ctl",
    since: 1,
    incarnation: "inc-1",
    runs: 4,
    settled: true,
    lastText: "done",
    ...over,
  });

  it("maps a settled observation to applySettledClose's input", () => {
    expect(settledCloseInput(settled())).toEqual({
      workstream: WS,
      agent: "pia",
      agentId: 7,
      incarnation: "inc-1",
      runs: 4,
      lastText: "done",
      settled: true,
    });
  });

  it("carries truncation and the run's error; a missing text is empty, never invented", () => {
    expect(
      settledCloseInput(settled({ lastTextTruncated: true, lastError: "boom" })),
    ).toMatchObject({
      lastTextTruncated: true,
      lastError: "boom",
    });
    expect(settledCloseInput(settled({ lastText: undefined }))?.lastText).toBe("");
  });

  it.each([
    ["not settled", { settled: false }],
    ["no ctl incarnation", { incarnation: undefined }],
    ["no settled run count", { runs: undefined }],
    ["a dead pane", { status: null }],
  ] as const)("is undefined for %s", (_why, over) => {
    expect(settledCloseInput(settled(over as Partial<AgentObservation>))).toBeUndefined();
  });

  it("feeds applySettledClose: the CLOSE applies once, replaying the same observation does not", async () => {
    ensureWorkstream(db, WS);
    addTask(db, { workstream: WS, localId: "t1", title: "t1" });
    await claimTask(db, "t1", { workstream: WS, agentName: "pia" });
    const ext = await fake({ state: "busy", since: 1, runs: 0 });
    const w = await watchAgentRun(pia, agentCtlSocket(db, pia), ctl().signal, {});
    await ext.release({
      ended: "settled",
      state: "idle",
      since: 2,
      runs: 1,
      pending: false,
      lastText: 'ok\n\nCLOSE: task=t1 evidence="npm test: 3 passed"\nREPORT:\nDONE',
    });
    const obs = await w?.settled;
    const input = obs === undefined ? undefined : settledCloseInput(obs);
    expect(input).toBeDefined();
    if (input === undefined) return;
    expect(applySettledClose(db, input)).toMatchObject({ applied: true, task: "t1" });
    expect(getTask(db, "t1", WS)).toMatchObject({ status: "CLOSED" });
    expect(applySettledClose(db, input)).toMatchObject({
      applied: false,
      reason: "already applied",
    });
  });
});

describe("toStatusSnapshot", () => {
  it("maps to the legacy snapshot: only the fields waitForAgents reads, none invented", () => {
    const obs: AgentObservation = {
      workstream: WS,
      name: "pia",
      agentId: 1,
      paneId: "%1",
      status: "needs_input",
      source: "ctl",
      since: 1,
      incarnation: "i",
      runs: 2,
      pending: false,
      settled: true,
      lastText: "t",
      lastTextTruncated: true,
      lastError: "e",
      sessionFile: "/f",
    };
    expect(toStatusSnapshot(obs)).toEqual({
      status: "needs_input",
      lastText: "t",
      lastError: "e",
      sessionFile: "/f",
    });
    expect(
      toStatusSnapshot({
        ...obs,
        status: "unknown",
        reason: "why",
        lastText: undefined,
        lastError: undefined,
        sessionFile: undefined,
      }),
    ).toEqual({ status: "unknown", unknownReason: "why" });
    const blocked = { kind: "confirm", since: 1 };
    expect(toStatusSnapshot({ ...obs, status: "needs_permission", blocked })).toMatchObject({
      status: "needs_permission",
      blocked,
    });
  });
});
