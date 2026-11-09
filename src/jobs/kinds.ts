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

const KINDS: Readonly<Record<JobKindName, JobKind>> = {
  pane: paneKind,
  lease: leaseKind,
  gate: gateKind,
};

export function jobKind(name: JobKindName): JobKind {
  return KINDS[name];
}

/** Liveness: whether the job runs, answered by its kind. */
export function jobLiveness(db: Db, job: JobRef): Promise<JobLiveness> {
  return jobKind(job.kind).status(db, job);
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
