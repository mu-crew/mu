// mu — the job kinds and the liveness read (spec 2026-11-09-mu-plugins.md, D1
// "Two reads", D8). `jobLiveness` asks the job's kind whether the job runs;
// view presence (does the pane exist) is `viewPresent` in ./view.ts, and the
// row rule and teardown use only that.

import type { AgentRow } from "../agents.js";
import type { Db } from "../db.js";
import { gateKind } from "./gate.js";
import { leaseKind } from "./lease.js";
import { paneKind } from "./pane.js";
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

/** Liveness: whether the job runs, answered by its kind. */
export function jobLiveness(db: Db, job: JobRef): Promise<JobLiveness> {
  return jobKind(job.kind).status(db, job);
}

/**
 * Whether an answer from the job's own process stands in for its liveness:
 * the kind's word (`JobKind.answer`), never the channel's. True for the pane
 * and lease kinds: the socket that answered is served by the agent in the
 * pane, or forwarded from the job on its host.
 */
export function answerProvesRunning(job: Pick<JobRef, "kind">): boolean {
  return jobKind(job.kind).answer === "running";
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
 * Liveness as the boolean the lease sites read: running is true, ended or lost
 * false; unknown throws, as a probe that could not answer always has.
 */
export async function jobRunning(db: Db, job: JobRef): Promise<boolean> {
  const l = await jobLiveness(db, job);
  if (l.state === "unknown") throw new Error(l.reason);
  return l.state === "running";
}
