// mu — the job kinds and the liveness read (spec 2026-11-09-mu-plugins.md, D1
// "Two reads", D8). `jobLiveness` asks the job's kind whether the job runs;
// view presence (does the pane exist) is `viewPresent` in ./view.ts, and the
// row rule and teardown use only that.

import type { StateAgentRef, StateReading } from "../agent-state.js";
import type { AgentObservation } from "../agents/observe.js";
import type { AgentRow } from "../agents.js";
import { getCarrierJobByAgent } from "../carrier-jobs.js";
import type { ChannelObservation, ChannelReading } from "../channels/types.js";
import type { Db } from "../db.js";
import { pluginJobKind, pluginJobRef } from "../plugins/job.js";
import { gateKind } from "./gate.js";
import { leaseKind } from "./lease.js";
import { paneKind, paneUp } from "./pane.js";
import type { JobKind, JobKindName, JobLiveness, JobRef } from "./types.js";

/**
 * The kind named `name`. A switch, not a module-level map: resolveHost (src/host-provider.ts)
 * imports this module from inside the lease kind's import cycle (./lease.ts → carrier-stop),
 * where a map built at load would read `leaseKind` before it is defined.
 */
export function jobKind(name: JobKindName): JobKind {
  switch (name) {
    case "pane":
      return paneKind;
    case "lease":
      return leaseKind;
    case "gate":
      return gateKind;
  }
}

const isBuiltin = (name: string): name is JobKindName =>
  name === "pane" || name === "lease" || name === "gate";

/** Liveness: whether the job runs, answered by its kind (a plugin's through the job adapter). */
export function jobLiveness(db: Db, job: JobRef): Promise<JobLiveness> {
  if (job.plugin !== undefined) {
    const kind = pluginJobKind(db, job.plugin);
    if (kind !== undefined) return kind.status(db, job);
    return Promise.resolve({ state: "unknown", reason: `plugin ${job.plugin} has no job seam` });
  }
  if (!isBuiltin(job.kind)) {
    return Promise.resolve({ state: "unknown", reason: `job kind ${job.kind} names no plugin` });
  }
  return jobKind(job.kind).status(db, job);
}

/**
 * Whether an answer from the job's own process stands in for its liveness:
 * the kind's word (`JobKind.answer`), never the channel's. True for the pane
 * and lease kinds: the socket that answered is served by the agent in the
 * pane, or forwarded from the job on its host.
 */
export function answerProvesRunning(job: Pick<JobRef, "kind">): boolean {
  return isBuiltin(job.kind) && jobKind(job.kind).answer === "running";
}

/** The job a state ref names: the one its caller listed, else its pane's (a gate's, by its token). */
export function stateRefJob(a: StateAgentRef): Pick<JobRef, "kind" | "viewPaneId"> {
  return a.job ?? { kind: a.gateToken != null ? "gate" : "pane", viewPaneId: a.paneId };
}

/**
 * A channel's reading made a state reading: `alive` is decided here, and only
 * here (plugins spec D9, the P1 ruling). A channel reports turn state and its
 * link to the agent's process (`ctl`: `ok` when the process answered); its
 * reading has no `alive` (`ChannelReading`). An answer stands in for
 * liveness only where the job's kind says so (`answerProvesRunning`); else
 * the job's view decides, where an unknown is never a death. No answer is no
 * death either: with `view`, the batched view read of the pane, its verdict
 * stands (gone: the view's reading, with the channel's link); without one,
 * the reading stays alive.
 */
export async function withJobLiveness(
  reading: ChannelReading,
  job: Pick<JobRef, "kind" | "viewPaneId">,
  view?: StateReading,
): Promise<StateReading> {
  if (reading.ctl === "ok") {
    if (answerProvesRunning(job)) return { ...reading, alive: true };
    return { ...reading, alive: (await paneUp(job.viewPaneId)) !== false };
  }
  if (view === undefined || view.alive) return { ...reading, alive: true };
  return { ...view, ...(reading.ctl !== undefined ? { ctl: reading.ctl } : {}) };
}

/** Why the job's liveness says it is gone (ended or lost); undefined: it runs, or unknown (never a death). */
function goneWhy(l: JobLiveness): string | undefined {
  if (l.state === "ended") return `the job ended${l.exit === null ? "" : ` (exit ${l.exit})`}`;
  return l.state === "lost" ? `the job is lost: ${l.reason}` : undefined;
}

/**
 * A plugin channel's reading with its job's liveness (plugins spec D9): `alive` is the job's
 * word, unconditionally; the plugin reports turn state only and never decides it.
 */
export function readingWithLiveness(turn: ChannelReading, l: JobLiveness): StateReading {
  const why = goneWhy(l);
  if (why === undefined) return { ...turn, alive: true };
  return { ...turn, state: "unknown", alive: false, reason: why };
}

/**
 * A plugin channel's observation as the requested target's (plugins spec D9, P6e1 review ruling
 * 3): its identity is the target's, a foreign observation or a gone verdict the channel carried
 * is an unknown turn, and only the target's job liveness makes it dead.
 */
export function targetObservation(
  o: ChannelObservation,
  target: Pick<AgentRow, "workstreamName" | "name" | "incarnation" | "paneId">,
  l: JobLiveness,
): AgentObservation {
  const foreign =
    o.workstream !== target.workstreamName ||
    o.name !== target.name ||
    o.agentId !== target.incarnation;
  const id = {
    workstream: target.workstreamName,
    name: target.name,
    agentId: target.incarnation,
    paneId: target.paneId,
  };
  const obs: AgentObservation = foreign
    ? {
        ...id,
        source: o.source,
        status: "unknown",
        since: null,
        settled: false,
        reason: "an observation of another agent",
      }
    : { ...o, ...id, status: isJobGone(o.status) ? "unknown" : o.status };
  const why = goneWhy(l);
  return why === undefined ? obs : { ...obs, status: null, settled: false, reason: why };
}

declare const JOB_GONE: unique symbol;
/**
 * The job's word that it is gone. Only `jobUp` mints one, so a channel's
 * watch can report a dead agent (`ChannelObservation.status`) only on it.
 */
export interface JobGone {
  readonly [JOB_GONE]: true;
}
const GONE = Object.freeze({}) as JobGone;

export function isJobGone(x: unknown): x is JobGone {
  return x === GONE;
}

/**
 * Whether the job still runs, as a watch asks mid-turn: `up`, `unknown` (the
 * multiplexer cannot say: never a death), or gone. Every built-in kind is
 * bound, so its view's command decides (`paneUp`).
 */
export async function jobUp(
  job: Pick<JobRef, "kind" | "viewPaneId">,
): Promise<"up" | "unknown" | JobGone> {
  const up = await paneUp(job.viewPaneId);
  return up === undefined ? "unknown" : up ? "up" : GONE;
}

/** A channel's observation as the wait reads it: the job's gone verdict is a dead agent (`status` null). */
export function jobObservation(o: ChannelObservation): AgentObservation {
  const { status } = o;
  return isJobGone(status) ? { ...o, status: null } : { ...o, status };
}

/**
 * The job an agents row records, as a channel target carries it: a command
 * gate's (its token), a lease carrier's (its host; the handle lives in the
 * carrier's job file, so it is absent), else the pane's.
 */
export function agentJobRef(agent: {
  workstreamName: string;
  name: string;
  incarnation: number;
  paneId: string;
  gateToken: string | null;
  host: string | null;
  hostTransport: string | null;
}): JobRef {
  if (agent.gateToken !== null) return gateJobRef(agent);
  return {
    kind: agent.hostTransport === "lease" ? "lease" : "pane",
    viewPaneId: agent.paneId,
    agentId: agent.incarnation,
    agent: { workstream: agent.workstreamName, name: agent.name },
    ...(agent.host === null ? {} : { host: { name: agent.host } }),
  };
}

/** A gate agent's job: the row is its record, the pane id and token its handle. */
export function gateJobRef(
  agent: Pick<
    AgentRow,
    "workstreamName" | "name" | "incarnation" | "paneId" | "gateToken" | "host"
  >,
): JobRef {
  return {
    kind: "gate",
    viewPaneId: agent.paneId,
    agentId: agent.incarnation,
    agent: { workstream: agent.workstreamName, name: agent.name },
    ...(agent.gateToken === null ? {} : { gateToken: agent.gateToken }),
    ...(agent.host === null ? {} : { host: { name: agent.host } }),
  };
}

/**
 * Whether agent `agentId`'s job outlives its gone view (plugins spec D3): a detached plugin
 * kind whose job reads running or unknown. Reconcile keeps such a row; any other is a ghost.
 */
export async function detachedJobLives(db: Db, agentId: number): Promise<boolean> {
  const r = getCarrierJobByAgent(db, agentId);
  if (r?.plugin == null || pluginJobKind(db, r.plugin)?.caps.view !== "detached") return false;
  const ref = pluginJobRef(db, r.token);
  if (ref === undefined) return false;
  const l = await jobLiveness(db, ref);
  return l.state === "running" || l.state === "unknown";
}

/**
 * Liveness as the boolean the lease sites read: running is true, ended or lost
 * false; unknown throws, as a probe that could not answer always has.
 */
export async function jobRunning(db: Db, job: JobRef): Promise<boolean> {
  const l = await jobLiveness(db, job);
  if (l.state === "unknown") throw new Error(l.reason);
  return l.state === "running";
}
