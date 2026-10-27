// mu — abort: stop a pi agent's current turn through its control socket.
//
// status → abort → wait(afterRuns). The wait keys on the run counter the
// extension bumps on agent_settled, so an abort that settles before the
// wait connects still resolves at once. An agent that is not busy gets no
// abort at all: the verb is idempotent.
//
// interruptAgent (`mu agent send --interrupt`) is abort + send as one
// ctl op with a msgId receipt; an extension without msgId is refused up
// front (AgentExtensionOutdatedError), never half-served.

import { getAgent } from "../agents.js";
import { type CtlState, INCARNATION_MISMATCH } from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { say } from "../messages.js";
import { resolveActorIdentity } from "../tasks/claim.js";
import {
  AgentAbortNeedsCtlError,
  AgentAbortTimeoutError,
  AgentEmptySendError,
  AgentNotFoundError,
  AgentReplacedError,
  AgentRestartedError,
} from "./errors.js";
import {
  agentCtlSocket,
  ctlSendWithReceipt,
  expectsCtl,
  fencedHello,
  recordSend,
  ctlRequestFor as request,
} from "./transport.js";

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
  /** interrupt only: the ctl incarnation the caller saw; another pi is refused (AgentReplacedError). */
  expectIncarnation?: string;
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
  if (!st.ok) throw new Error(say("agent.ctl_refused", "status", st.error));
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
  if (!ab.ok) throw new Error(say("agent.ctl_refused", "the abort", ab.error));
  // Only a real abort is logged. wasBusy=false: the run settled between the
  // status probe and the abort, so pi did nothing. Absent: older extension.
  const aborted = ab.wasBusy !== false;
  if (aborted) {
    emitEvent(
      db,
      opts.workstream,
      "agent.abort",
      `agent abort ${name} (state=${before}, pending=${pending})`,
      await resolveActorIdentity(),
    );
  }

  // The incarnation the status named: a pi that restarted since is another
  // process, whose run count means nothing here.
  const w = await request(agent, sock, {
    op: "wait",
    afterRuns: st.runs ?? 0,
    timeoutMs,
    ...(st.incarnation !== undefined ? { incarnation: st.incarnation } : {}),
  });
  if (!w.ok) {
    if (w.error === INCARNATION_MISMATCH && st.incarnation !== undefined) {
      throw new AgentRestartedError(name, opts.workstream, st.incarnation, w.incarnation);
    }
    if (w.error === "timeout") throw new AgentAbortTimeoutError(name, opts.workstream, timeoutMs);
    throw new Error(say("agent.ctl_refused", "the wait", w.error));
  }
  return {
    ...base,
    before,
    after: w.state ?? "idle",
    settled: true,
    aborted,
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
  /** The id the interrupt carried: `mu agent check <agent> <msgId>` asks whether it landed. */
  msgId: string;
  /** pi's incarnation: the `--inc` for `mu agent wait`. */
  incarnation?: string;
  /** Set when the reply never arrived and `status {msgId}` confirmed the interrupt landed. */
  receipt?: "confirmed-after-timeout";
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
  const r = await interruptAgentImpl(db, name, text, opts);
  recordSend(
    db,
    { name, workstreamName: opts.workstream },
    "interrupt",
    Buffer.byteLength(text),
    { transport: "ctl", wasBusy: r.wasBusy },
    await resolveActorIdentity(),
  );
  return r;
}

async function interruptAgentImpl(
  db: Db,
  name: string,
  text: string,
  opts: AbortAgentOptions,
): Promise<InterruptResult> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name, opts.workstream);
  // Refuse before the abort: an empty prompt would kill the running turn
  // and then send nothing. Here, not only in the CLI, so SDK callers get it.
  if (text === "") throw new AgentEmptySendError(name, opts.workstream);
  const sock = opts.socket ?? agentCtlSocket(db, agent);
  if (!expectsCtl(agent, sock)) throw new AgentAbortNeedsCtlError(name, opts.workstream, agent.cli);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  const { inc, bound } = await fencedHello(agent, sock, {
    feature: "msgId",
    needsFence: true,
    ...(opts.expectIncarnation !== undefined ? { expect: opts.expectIncarnation } : {}),
  });
  const sent = await ctlSendWithReceipt(
    agent,
    sock,
    { op: "interrupt", text, timeoutMs, ...bound },
    inc,
  );
  const { reply: r, msgId } = sent;
  if (r === undefined) {
    // Written, no reply, but status {msgId} says pi took it: wasBusy and
    // pending are unknown, so they read false.
    const c = sent.confirmed;
    return {
      wasBusy: false,
      pending: false,
      msgId,
      receipt: "confirmed-after-timeout",
      ...(c?.runs !== undefined ? { runs: c.runs } : {}),
      ...(c?.incarnation !== undefined ? { incarnation: c.incarnation } : {}),
    };
  }
  if (!r.ok) {
    if (r.error === INCARNATION_MISMATCH)
      throw new AgentReplacedError(name, opts.workstream, "sent to");
    if (r.error === "timeout") throw new AgentAbortTimeoutError(name, opts.workstream, timeoutMs);
    throw new Error(say("agent.ctl_refused", "the interrupt", r.error));
  }
  return {
    wasBusy: r.wasBusy ?? false,
    pending: r.pending ?? false,
    msgId,
    ...(r.runs !== undefined ? { runs: r.runs } : {}),
    ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
  };
}
