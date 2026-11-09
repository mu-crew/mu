// mu — the `gate` job kind (spec 2026-11-09-mu-plugins.md, D8): a command gate
// on a `session` profile. The view is the foreground command; its answer is the
// host's completion record, read once the pane proves the command exited
// (`readGate`, src/agents/gate.ts). It needs `db`: the read checks the row
// still names the gate and admits its exec like any other.

import { type GateReading, readGate } from "../agents/gate.js";
import type { JobKind, JobLiveness, JobRef } from "./types.js";

/** A gate reading as liveness: one to one (dead is lost, exited is ended). */
export function gateLiveness(r: GateReading): JobLiveness {
  switch (r.kind) {
    case "running":
      return { state: "running" };
    case "exited":
      return { state: "ended", exit: r.code };
    case "dead":
      return { state: "lost", reason: r.reason };
    case "unknown":
      return { state: "unknown", reason: r.reason };
  }
}

export const gateKind: JobKind = {
  name: "gate",
  caps: { view: "bound", handle: "pane" },
  async status(db, job: JobRef): Promise<JobLiveness> {
    if (job.agent === undefined || job.agentId === undefined) {
      return { state: "unknown", reason: "not a remote command gate" };
    }
    return gateLiveness(
      await readGate(db, {
        workstreamName: job.agent.workstream,
        name: job.agent.name,
        incarnation: job.agentId,
        paneId: job.viewPaneId,
        gateToken: job.gateToken ?? null,
        host: job.host?.name ?? null,
      }),
    );
  },
};
