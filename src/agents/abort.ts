// mu — abort: stop a pi agent's current turn through its control socket.
//
// status → abort → wait(afterRuns). The wait keys on the run counter the
// extension bumps on agent_settled, so an abort that settles before the
// wait connects still resolves at once. An agent that is not busy gets no
// abort at all: the verb is idempotent.
//
// interruptAgent (`mu agent send --interrupt`) is abort + send as one
// ctl op; against an extension that predates it, abortAgent then send.

import { getAgent } from "../agents.js";
import { CtlUnknownOpError, ctlRequest } from "../ctl/client.js";
import type { CtlState } from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { AgentAbortNeedsCtlError, AgentAbortTimeoutError, AgentNotFoundError } from "./errors.js";
import { agentCtlSocket, ctlFailure, expectsCtl, ctlRequestFor as request } from "./transport.js";

export const DEFAULT_ABORT_TIMEOUT_MS = 30_000;

export type AbortResult = {
  agent: string;
  workstream: string;
  before: CtlState;
  after: CtlState;
  /** True when pi settled (or was never busy). */
  settled: boolean;
  /** False when the agent was not busy, so no abort was sent. */
  aborted: boolean;
  /** pi had queued messages before the abort (pi returns them to the editor). */
  pending: boolean;
  elapsedMs: number;
};

export type AbortAgentOptions = {
  workstream: string;
  timeoutMs?: number;
  /** Control socket path. Default: derived from the agent's identity. */
  socket?: string;
};

export async function abortAgent(
  db: Db,
  name: string,
  opts: AbortAgentOptions,
): Promise<AbortResult> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name, opts.workstream);
  const sock = opts.socket ?? agentCtlSocket(db, agent);
  if (!expectsCtl(agent, sock)) throw new AgentAbortNeedsCtlError(name, opts.workstream, agent.cli);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  const started = Date.now();
  const base = { agent: name, workstream: opts.workstream };

  const st = await request(agent, sock, { op: "status" });
  if (!st.ok) throw new Error(`control socket refused status: ${st.error}`);
  const before = st.state ?? "idle";
  const pending = st.pending ?? false;
  if (before !== "busy") {
    return {
      ...base,
      before,
      after: before,
      settled: true,
      aborted: false,
      pending,
      elapsedMs: Date.now() - started,
    };
  }

  const ab = await request(agent, sock, { op: "abort" });
  if (!ab.ok) throw new Error(`control socket refused the abort: ${ab.error}`);

  const w = await request(agent, sock, { op: "wait", afterRuns: st.runs ?? 0, timeoutMs });
  if (!w.ok) {
    if (w.error === "timeout") throw new AgentAbortTimeoutError(name, opts.workstream, timeoutMs);
    throw new Error(`control socket refused the wait: ${w.error}`);
  }
  return {
    ...base,
    before,
    after: w.state ?? "idle",
    settled: true,
    aborted: true,
    pending,
    elapsedMs: Date.now() - started,
  };
}

export type InterruptResult = {
  /** pi was busy, so its turn was aborted before the send. */
  wasBusy: boolean;
  /** pi had queued messages before the abort; pi put them back in the pane's editor. */
  pending: boolean;
  /**
   * pi's run count after the aborted run settled and before the send: the
   * `mu agent wait --after-runs` baseline for the run the text starts.
   */
  runs?: number;
  /** The extension predates the interrupt op: mu ran abort, then send. */
  fallback: boolean;
};

/**
 * Make a pi agent act on `text` now: abort a running turn, wait for pi to
 * settle (AgentAbortTimeoutError after timeoutMs, text not sent), then
 * send `text` as a new run. Never pastes: non-pi agents get
 * AgentAbortNeedsCtlError.
 */
export async function interruptAgent(
  db: Db,
  name: string,
  text: string,
  opts: AbortAgentOptions,
): Promise<InterruptResult> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name, opts.workstream);
  const sock = opts.socket ?? agentCtlSocket(db, agent);
  if (!expectsCtl(agent, sock)) throw new AgentAbortNeedsCtlError(name, opts.workstream, agent.cli);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  let r: Awaited<ReturnType<typeof ctlRequest>>;
  try {
    r = await ctlRequest(sock, { op: "interrupt", text, timeoutMs });
  } catch (e) {
    if (!(e instanceof CtlUnknownOpError)) throw await ctlFailure(agent, sock, e);
    // An extension loaded before the op: same steps, composed here.
    const ab = await abortAgent(db, name, { ...opts, socket: sock });
    const sent = await request(agent, sock, { op: "send", text });
    if (!sent.ok) throw new Error(`control socket refused the send: ${sent.error}`);
    return {
      wasBusy: ab.aborted,
      pending: ab.pending,
      ...(sent.runs !== undefined ? { runs: sent.runs } : {}),
      fallback: true,
    };
  }
  if (!r.ok) {
    if (r.error === "timeout") throw new AgentAbortTimeoutError(name, opts.workstream, timeoutMs);
    throw new Error(`control socket refused the interrupt: ${r.error}`);
  }
  return {
    wasBusy: r.wasBusy ?? false,
    pending: r.pending ?? false,
    ...(r.runs !== undefined ? { runs: r.runs } : {}),
    fallback: false,
  };
}
