// mu — abort: stop an agent's current turn, through its channel.
//
// On ctl: status → abort → wait(afterRuns). The wait keys on the run counter
// the extension bumps on agent_settled, so an abort that settles before the
// wait connects still resolves at once. An agent that is not busy gets no
// abort at all: the verb is idempotent.
//
// interruptAgent (`mu agent send --interrupt`) is abort + send as one
// ctl op with a msgId receipt; an extension without msgId is refused up
// front (AgentExtensionOutdatedError), never half-served. On hooks both
// press the harness's interrupt key, confirmed by its own event where it has
// one (claude has none: `idle?`). A channel that cannot abort (mux) refuses
// both with AgentAbortNeedsCtlError.

import { getAgent } from "../agents.js";
import {
  type AbortOutcome,
  agentChannel,
  channelTarget,
  type DeliveryTarget,
  type InterruptResult,
} from "../channels/index.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { resolveActorIdentity } from "../tasks/claim.js";
import { AgentEmptySendError, AgentNotFoundError } from "./errors.js";
import { recordSend } from "./transport.js";

export type { InterruptResult } from "../channels/index.js";

export const DEFAULT_ABORT_TIMEOUT_MS = 30_000;

export type AbortResult = AbortOutcome & {
  agent: string;
  workstream: string;
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

/** The agent's row as a delivery target (AgentNotFoundError when it has none). */
function targetOf(db: Db, name: string, opts: AbortAgentOptions): DeliveryTarget {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name, opts.workstream);
  return channelTarget(db, agent, opts.socket);
}

export async function abortAgent(
  db: Db,
  name: string,
  opts: AbortAgentOptions,
): Promise<AbortResult> {
  const target = targetOf(db, name, opts);
  const started = Date.now();
  const r = await agentChannel(target).abort(target, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
    // Only a real abort is logged.
    onAbort: async ({ before, pending }) => {
      emitEvent(
        db,
        opts.workstream,
        "agent.abort",
        `agent abort ${name} (state=${before}, pending=${pending})`,
        await resolveActorIdentity(),
      );
    },
  });
  return { agent: name, workstream: opts.workstream, ...r, elapsedMs: Date.now() - started };
}

/**
 * Make an agent act on `text` now: abort a running turn, wait for it to
 * settle (AgentAbortTimeoutError after timeoutMs, text not sent), then
 * send `text` as a new run. On `hooks` the abort is the harness's interrupt
 * key and the text a paste (spec D4); a `mux` agent gets
 * AgentAbortNeedsCtlError.
 */
export async function interruptAgent(
  db: Db,
  name: string,
  text: string,
  opts: AbortAgentOptions,
): Promise<InterruptResult> {
  const target = targetOf(db, name, opts);
  // Refuse before the abort: an empty prompt would kill the running turn
  // and then send nothing. Here, not only in the CLI, so SDK callers get it.
  if (text === "") throw new AgentEmptySendError(name, opts.workstream);
  const r = await agentChannel(target).interrupt(target, text, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
    ...(opts.expectIncarnation !== undefined ? { expectIncarnation: opts.expectIncarnation } : {}),
  });
  recordSend(
    db,
    { name, workstreamName: opts.workstream },
    "interrupt",
    Buffer.byteLength(text),
    {
      transport: r.transport ?? "ctl",
      wasBusy: r.wasBusy,
      ...(r.stopped !== undefined ? { stopped: r.stopped } : {}),
      ...(r.ack !== undefined ? { ack: r.ack } : {}),
    },
    await resolveActorIdentity(),
  );
  return r;
}
