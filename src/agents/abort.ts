// mu — abort: stop a pi agent's current turn through its control socket.
//
// status → abort → wait(afterRuns). The wait keys on the run counter the
// extension bumps on agent_settled, so an abort that settles before the
// wait connects still resolves at once. An agent that is not busy gets no
// abort at all: the verb is idempotent.

import { type AgentRow, getAgent } from "../agents.js";
import { CtlUnknownOpError, CtlVersionError, ctlRequest } from "../ctl/client.js";
import type { CtlReply, CtlRequest, CtlState } from "../ctl/protocol.js";
import type { Db } from "../db.js";
import {
  AgentAbortNeedsCtlError,
  AgentAbortTimeoutError,
  AgentCtlUnreachableError,
  AgentNotFoundError,
} from "./errors.js";
import { agentCtlSocket, expectsCtl, extensionOutdated } from "./transport.js";

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
  elapsedMs: number;
};

export type AbortAgentOptions = {
  workstream: string;
  timeoutMs?: number;
  /** Control socket path. Default: derived from the agent's identity. */
  socket?: string;
};

function errCode(e: unknown): string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

async function request(agent: AgentRow, sock: string, req: CtlRequest): Promise<CtlReply> {
  try {
    return await ctlRequest(sock, req);
  } catch (e) {
    if (e instanceof CtlVersionError) throw e;
    if (e instanceof CtlUnknownOpError) throw await extensionOutdated(agent, sock, e);
    throw new AgentCtlUnreachableError(
      agent.name,
      agent.workstreamName,
      sock,
      errCode(e) === "ENOENT" ? "missing" : "refused",
    );
  }
}

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
  if (before !== "busy") {
    return {
      ...base,
      before,
      after: before,
      settled: true,
      aborted: false,
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
    elapsedMs: Date.now() - started,
  };
}
