// mu — the job kind seam's types (spec 2026-11-09-mu-plugins.md, D1 Job, D8).
//
// A job is one agent's process. Its kind says how mu asks whether it runs:
// `pane` (a local or `session` pane: the pane is the job), `lease` (a carrier
// pane holding a job on a host) and `gate` (a command gate, whose answer is the
// host's completion record). The view is the pane mu opened for the job
// (spec D3); every built-in view is bound: its death ends the job or starts
// its stop.
//
// The built-ins' effects stay their own: the pane and gate kinds start with
// the spawn's pane, and the lease kind's stop, handshake and attach are its
// methods (src/jobs/lease.ts). A plugin kind's `start`, `lookup`, `stop` and
// `attach` are wire calls behind the job adapter (src/plugins/job.ts), each
// effect written ahead (src/effects.ts).

import type { RunBaseline } from "../channels/types.js";
import type { Db } from "../db.js";
import type { CheckContext, CheckPhase } from "../host-link.js";
import type { KeyCaps } from "../host-provider.js";
import type { HostCheckStep } from "../hosts.js";
import type { CommandSource } from "../mux/types.js";

/** The built-in job kinds. A plugin kind is named by its plugin's job seam. */
export type JobKindName = "pane" | "lease" | "gate";

export type JobRole = "full-access" | "read-only";

/** The `JobSpec` fields a kind enforces (D8 honour or refuse). */
export interface JobHonours {
  /** A command other than the harness's default (`commandSource` other than `cli-key`). */
  command: boolean;
  env: boolean;
  sockets: boolean;
  roles: JobRole[];
}

/** Every built-in enforces every field. */
export const HONOURS_ALL: JobHonours = {
  command: true,
  env: true,
  sockets: true,
  roles: ["full-access", "read-only"],
};

/** A plugin kind that declares no `honours`: `env` only, and only full-access. */
export const HONOURS_DEFAULT: JobHonours = {
  command: false,
  env: true,
  sockets: false,
  roles: ["full-access"],
};

/** What a view pane runs: the fields `MuxBackend.spawnAgent` takes. */
export interface PaneCommand {
  command: string;
  env: Record<string, string>;
  cwd?: string;
}

/** What a plugin kind's `job.start` gets (D8). */
export interface JobSpec {
  workstream: string;
  name: string;
  harness: string;
  role: JobRole;
  model?: string;
  cmd: string;
  /** Where `cmd` came from: only `cli-key` is the harness's default. */
  commandSource: CommandSource;
  cwd: string;
  /** mu's identity map (HOST_ENV_KEYS); `{}` for a kind without `honours.env`. */
  env: Record<string, string>;
  sockets?: { local: string; remote: string };
  /** Exactly for a `firstTurn: "at-start"` kind: the prompt whose turn the start begins. */
  firstPrompt?: { text: string; msgId: string };
}

/** A plugin kind's `job.start` reply, and its `job.lookup`'s `found`. */
export interface JobStart {
  view: PaneCommand;
  /** Present when the kind's handle is `reply`. */
  handle?: string;
  /** An `at-start` kind's first turn's baseline (`runs: 0`, the incarnation). */
  baseline?: RunBaseline;
}

/** Liveness (spec D1): whether the job runs. `unknown` is an honest answer, never a death. */
export type JobLiveness =
  | { state: "running" }
  | { state: "ended"; exit: number | null }
  | { state: "lost"; reason: string }
  | { state: "unknown"; reason: string };

/** What mu records about one job: enough for its kind to answer about it. */
export interface JobRef {
  /** A built-in's name, or a plugin kind's (then `plugin` names its plugin). */
  kind: string;
  plugin?: string;
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
  /** The recorded stop fence: a lease job's `host_stop` bytes, a plugin job's instance. */
  identity?: string;
  /** A plugin job's key: its job record's token. */
  key?: string;
}

export interface JobCaps {
  /** Bound: the view's death ends the job or starts its stop. Every built-in is bound. */
  view: "bound" | "detached";
  /** Where the handle comes from: the view's pane id, a file the carrier writes, or the start reply. */
  handle: "pane" | "file" | "reply";
  /** The `checkHost` phases this kind contributes steps for (spec D11). */
  checks?: CheckPhase[];
  /** A plugin kind's `job.start` key capabilities (D6): required for `handle: "reply"`. */
  start?: KeyCaps;
  /** The channel the kind's agents use (a plugin's channel seam); absent: the harness's own. */
  channel?: string;
  /** `at-start`: `job.start` carries the first prompt and begins its turn. Absent: `on-send`. */
  firstTurn?: "on-send" | "at-start";
  /** The job may outlive its host's machine: `gone` does not prove it gone (D1, D6). */
  outlivesHost?: boolean;
  /** The JobSpec fields it enforces. Absent on a built-in: all (HONOURS_ALL); the job adapter fills a plugin's declaration, or HONOURS_DEFAULT. */
  honours?: JobHonours;
}

export interface JobKind {
  readonly name: string;
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
