// mu — the job kind seam's types (spec 2026-11-09-mu-plugins.md, D1 Job, D8).
//
// A job is one agent's process. Its kind says how mu asks whether it runs:
// `pane` (a local or `session` pane: the pane is the job), `lease` (a carrier
// pane holding a job on a host) and `gate` (a command gate, whose answer is the
// host's completion record). The view is the pane mu opened for the job
// (spec D3); every built-in view is bound: its death ends the job or starts
// its stop.
//
// P1 holds the reads. `start`, `lookup` and the generic `stop`/`attach` join
// this interface with `HostView` and `EffectKey` (P3, P6c); until then the
// lease kind's effects are its own methods (src/jobs/lease.ts).

import type { Db } from "../db.js";
import type { CheckContext, CheckPhase } from "../host-link.js";
import type { HostCheckStep } from "../hosts.js";

/** The built-in job kinds. A plugin kind joins in P6. */
export type JobKindName = "pane" | "lease" | "gate";

/** Liveness (spec D1): whether the job runs. `unknown` is an honest answer, never a death. */
export type JobLiveness =
  | { state: "running" }
  | { state: "ended"; exit: number | null }
  | { state: "lost"; reason: string }
  | { state: "unknown"; reason: string };

/** What mu records about one job: enough for its kind to answer about it. */
export interface JobRef {
  kind: JobKindName;
  /** The view's pane: for a pane or gate job, also the handle. */
  viewPaneId: string;
  /** The agent row (its registry incarnation), when one exists. */
  agentId?: number;
  /** The agent's (workstream, name): a gate's result read checks the row still names it. */
  agent?: { workstream: string; name: string };
  /** The job's own handle (a lease job's, from its job file). */
  handle?: string;
  host?: { name: string };
  /** A gate's spawn-unique token: the key of its completion record. */
  gateToken?: string;
  /** The recorded stop fence: a lease job's `host_stop` bytes. */
  identity?: string;
}

export interface JobCaps {
  /** Bound: the view's death ends the job or starts its stop. Every built-in is bound. */
  view: "bound" | "detached";
  /** Where the handle comes from: the view's pane id, a file the carrier writes, or the start reply. */
  handle: "pane" | "file" | "reply";
  /** The `checkHost` phases this kind contributes steps for (spec D11). */
  checks?: CheckPhase[];
}

export interface JobKind {
  readonly name: JobKindName;
  readonly caps: JobCaps;
  /**
   * `running`: an answer from the job's own process (its channel's control
   * socket, which the process serves or forwards) proves the job runs, so a
   * channel that got one needs no liveness probe (plugins spec D9, the P1
   * ruling). Absent: only the kind's `status` or the view read decides.
   */
  readonly answer?: "running";
  /** Liveness. Never throws for "cannot tell" (that is `unknown`); a host's hand-back throws. */
  status(db: Db, job: JobRef): Promise<JobLiveness>;
  /** Its `host check` steps for `ctx.phase` (one of `caps.checks`); reads only, runs no template. */
  checkSteps?(ctx: CheckContext): Promise<HostCheckStep[]>;
}
