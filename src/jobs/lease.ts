// mu — the `lease` job kind (spec 2026-11-09-mu-plugins.md, D8; spec
// 2026-10-28-lease-transport.md): a carrier pane holding a job on a host. The
// view is the carrier; the handle comes from a file the carrier writes beside
// the agent's ctl socket (`handle: "file"`).
//
// The kind owns the job's effects and reads: the job handshake that fills the
// handle (`awaitLeaseJob`; reads fail closed), the stop (`runStop`, fenced on
// the recorded `host_stop` bytes), the attach command a reattach's new carrier
// runs, liveness (the carrier pane still runs), and its `host check` steps: the
// `template` phase (shell, stop and attach, expanded, never run) and the `agent`
// phase (the recorded job handle). The reservation around it
// (the name fence, the rollback, the close steps) is mu's own, in
// src/agents/lease-carrier.ts.

import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { AgentDiedOnSpawnError } from "../agents/errors.js";
import { fillCarrierJob, getCarrierJobByName } from "../carrier-jobs.js";
import { runStop } from "../carrier-stop.js";
import type { Db } from "../db.js";
import type { CheckContext } from "../host-link.js";
import { requireProfile } from "../host-provider.js";
import {
  type ChannelOpts,
  expandHostTemplate,
  type HostCheckStep,
  type HostProfile,
  HostTemplateError,
  JOB_HANDLE_RE,
  leaseShellProblems,
  placeholderUses,
} from "../hosts.js";
import { say } from "../messages.js";
import { activeMux } from "../mux.js";
import { attachCommand } from "../remote-agent.js";
import type { JobKind, JobLiveness, JobRef } from "./types.js";
import { viewPresent, viewRunning } from "./view.js";

/** The carrier's pane stayed alive and wrote no handle within MU_SPAWN_JOB_MS. Exit 1 (rolled back). */
export class LeaseJobTimeoutError extends Error {
  override readonly name = "LeaseJobTimeoutError";
  constructor(
    public readonly agentName: string,
    public readonly host: string,
    public readonly budgetMs: number,
    public readonly jobFile: string,
  ) {
    super(say("carrier.job_timeout", agentName, host, budgetMs, jobFile));
  }
}

/** The job file held something that is not a handle (empty included). Exit 1 (rolled back; reservation and tree kept). */
export class LeaseJobInvalidError extends Error {
  override readonly name = "LeaseJobInvalidError";
  constructor(
    public readonly agentName: string,
    public readonly jobFile: string,
    public readonly line: string,
  ) {
    super(say("carrier.job_invalid", agentName, jobFile, line));
  }
}

/** The job file exists but cannot be read: not proof of no job. Exit 1 (rolled back; reservation and tree kept). */
export class LeaseJobUnreadableError extends Error {
  override readonly name = "LeaseJobUnreadableError";
  constructor(
    public readonly agentName: string,
    public readonly jobFile: string,
    public readonly detail: string,
  ) {
    super(say("carrier.job_unreadable", agentName, jobFile, detail));
  }
}

const DEFAULT_SPAWN_JOB_MS = 30_000;

type LeaseClock = { now(): number; delay(ms: number): Promise<void> };
const realClock: LeaseClock = { now: () => Date.now(), delay: (ms) => delay(ms) };
let clock = realClock;

/** TEST SEAM: drive the job handshake on a virtual clock (deadlines counted, not elapsed). */
export function setLeaseClockForTests(c: LeaseClock | undefined): void {
  clock = c ?? realClock;
}

/** Cadence of the job-file stat (no fork). */
const JOB_STAT_INTERVAL_MS = 50;
/** Cadence of the pane check (capture + liveness: ~2 forks). */
const JOB_PANE_INTERVAL_MS = 250;

/** The job handshake's budget: `MU_SPAWN_JOB_MS`, default 30 s. Never 0: a lease always waits for its handle. */
export function defaultSpawnJobMs(): number {
  const parsed = Number.parseInt(process.env.MU_SPAWN_JOB_MS ?? "", 10);
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_SPAWN_JOB_MS : parsed;
}

export type JobFile =
  | { kind: "none" }
  | { kind: "handle"; job: string }
  | { kind: "invalid"; line: string }
  | { kind: "unreadable"; detail: string };

/**
 * One line, an opaque handle; mu parses nothing further. FAIL CLOSED: only ENOENT is
 * "no file". Any other read error is `unreadable`, and an empty file is `invalid` (the
 * carrier renames the file in whole, so a reader never sees it half-written).
 */
export function readJobFile(path: string): JobFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable", detail: code ?? (e instanceof Error ? e.message : String(e)) };
  }
  const line = text.split("\n")[0]?.trim() ?? "";
  return JOB_HANDLE_RE.test(line) ? { kind: "handle", job: line } : { kind: "invalid", line };
}

export const describeRead = (r: JobFile): string =>
  r.kind === "handle"
    ? `handle ${r.job}`
    : r.kind === "invalid"
      ? `${JSON.stringify(r.line.slice(0, 80))}, not a handle`
      : r.kind === "unreadable"
        ? `unreadable: ${r.detail}`
        : "absent";

/**
 * The job handshake: mandatory for a lease, independent of ctl, `--no-ctl` and
 * MU_SPAWN_CTL_MS. Waits for the job file and fills the handle into the reservation
 * (guarded by its token). A pane that dies first is AgentDiedOnSpawnError with its
 * scrollback; a live pane with no file by the deadline is LeaseJobTimeoutError; an
 * invalid or empty file is LeaseJobInvalidError and an unreadable one
 * LeaseJobUnreadableError (the rollback keeps the reservation and the tree for both).
 */
export async function awaitLeaseJob(
  db: Db,
  a: {
    name: string;
    token: string;
    paneId: string;
    profile: HostProfile;
    jobFile: string;
    command: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const budget = defaultSpawnJobMs();
  const deadline = clock.now() + budget;
  let lastPaneCheck = Number.NEGATIVE_INFINITY;
  let scrollback: string | undefined;
  for (;;) {
    a.signal?.throwIfAborted();
    const read = readJobFile(a.jobFile);
    if (read.kind === "invalid") throw new LeaseJobInvalidError(a.name, a.jobFile, read.line);
    if (read.kind === "unreadable") {
      throw new LeaseJobUnreadableError(a.name, a.jobFile, read.detail);
    }
    if (read.kind === "handle") {
      if (!fillCarrierJob(db, a.token, read.job)) {
        throw new Error(say("carrier.job_unrecorded", a.name, read.job));
      }
      return read.job;
    }
    const atDeadline = clock.now() >= deadline;
    if (atDeadline || clock.now() - lastPaneCheck >= JOB_PANE_INTERVAL_MS) {
      lastPaneCheck = clock.now();
      const mux = await activeMux();
      // Capture every check and keep the last good buffer: a gone pane cannot be captured.
      scrollback =
        (await mux.capture(a.paneId, { lines: 50 }).catch(() => undefined)) ?? scrollback;
      // A file written just before the pane ended still wins: re-read before calling it dead.
      if (!(await viewPresent(a.paneId, mux)) && readJobFile(a.jobFile).kind === "none") {
        throw new AgentDiedOnSpawnError(
          a.name,
          a.paneId,
          scrollback,
          a.command,
          `before writing its job handle (up to ${budget}ms after spawn)`,
          a.profile.name,
        );
      }
    }
    if (atDeadline) throw new LeaseJobTimeoutError(a.name, a.profile.name, budget, a.jobFile);
    await clock.delay(Math.min(JOB_STAT_INTERVAL_MS, Math.max(1, deadline - clock.now())));
  }
}

/** The `JobRef` of a recorded lease job: its handle, host and `host_stop` fence. */
export const leaseJobRef = (r: {
  host: string;
  job: string;
  hostStop: string;
  paneId: string | null;
}): JobRef => ({
  kind: "lease",
  viewPaneId: r.paneId ?? "",
  handle: r.job,
  host: { name: r.host },
  identity: r.hostStop,
});

/** The dummy handle `host check` expands a lease profile's `stop` with. Never run. */
const DUMMY_JOB = "check-job";

/**
 * A lease profile's template structure (the `template` phase): the shell's three placeholders,
 * and `stop` (and `attach`, when set) expanded with a dummy handle (never run).
 */
function leaseTemplateSteps(profile: HostProfile): HostCheckStep[] {
  const problems = (() => {
    try {
      // A lease profile always has its shell (addHost): a `--plugin` profile is a session one.
      return leaseShellProblems(profile.shell ?? "");
    } catch (e) {
      if (e instanceof HostTemplateError) return [e.message];
      throw e;
    }
  })();
  const shell: HostCheckStep =
    problems.length === 0
      ? {
          step: "shell",
          ok: true,
          detail: "lease shell has {job_file}, {local_sock} and {remote_sock}",
        }
      : { step: "shell", ok: false, detail: problems.join("; ") };
  let stop: HostCheckStep;
  try {
    if (profile.stop === null) throw new HostTemplateError("a lease profile has no stop template");
    if (placeholderUses(profile.stop, "stop").job === 0) {
      throw new HostTemplateError("a stop template must contain {job}");
    }
    const line = expandHostTemplate(profile.stop, { job: DUMMY_JOB, cwd: "." }, "stop");
    stop = { step: "stop", ok: true, detail: `expands (not run) to: ${line}` };
  } catch (e) {
    if (!(e instanceof HostTemplateError)) throw e;
    stop = { step: "stop", ok: false, detail: e.message };
  }
  if (profile.attach === null) return [shell, stop];
  let attach: HostCheckStep;
  try {
    const problems = leaseShellProblems(profile.attach, "attach");
    if (problems.length > 0) throw new HostTemplateError(problems.join("; "));
    const line = expandHostTemplate(
      profile.attach,
      {
        job: DUMMY_JOB,
        job_file: "/tmp/check.job",
        local_sock: "/tmp/check.sock",
        remote_sock: "/tmp/check-remote.sock",
        cwd: ".",
      },
      "attach",
    );
    attach = { step: "attach", ok: true, detail: `expands (not run) to: ${line}` };
  } catch (e) {
    if (!(e instanceof HostTemplateError)) throw e;
    attach = { step: "attach", ok: false, detail: e.message };
  }
  return [shell, stop, attach];
}

/** `check --agent` on a lease agent (the `agent` phase): the job handle recorded for it. */
function leaseJobStep(
  db: Db,
  profile: HostProfile,
  agent: { name: string; workstream: string },
): HostCheckStep {
  const who = `${agent.workstream}/${agent.name}`;
  const job = getCarrierJobByName(db, agent.workstream, agent.name);
  if (job === undefined || job.host !== profile.name || job.job === null) {
    return { step: "job", ok: false, detail: `${who}: no job handle recorded on ${profile.name}` };
  }
  const drift =
    job.hostStop === profile.stop
      ? ""
      : "; the stop template changed since it was recorded: a close will refuse and name the handle";
  return { step: "job", ok: true, detail: `${who}: job ${job.job}${drift}` };
}

export interface LeaseJobKind extends JobKind {
  /**
   * Stop the job by its handle (`runStop`): only while the profile's `stop` still
   * equals the recorded `identity`. Resolves on proof the job is stopped; a hand-back
   * throws `HostHandbackError`, a failure `CarrierStopFailedError`, a changed or gone
   * profile `CarrierStopRefusedError`. Never deletes the reservation.
   */
  stop(
    db: Db,
    job: JobRef,
    opts?: ChannelOpts & { timeoutMs?: number; agent?: { name: string; ws: string } },
  ): Promise<void>;
  /** The command a reattach's new carrier pane runs to hold the job (the `attach` template). */
  attach(
    profile: HostProfile,
    a: { job: string; jobFile: string; localSock: string; remoteSock: string },
  ): string;
}

export const leaseKind: LeaseJobKind = {
  name: "lease",
  caps: { view: "bound", handle: "file", checks: ["template", "agent"] },
  answer: "running",
  /** The carrier pane still runs (a retained pane whose command ended does not). */
  async status(_db, job): Promise<JobLiveness> {
    try {
      return (await viewRunning(job.viewPaneId))
        ? { state: "running" }
        : { state: "lost", reason: "carrier pane not running" };
    } catch (e) {
      return { state: "unknown", reason: `mux: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  async stop(db, job, opts = {}) {
    await runStop(db, job.host?.name ?? "", job.handle ?? "", job.identity ?? "", opts);
  },
  attach: attachCommand,
  async checkSteps(ctx: CheckContext): Promise<HostCheckStep[]> {
    const profile = requireProfile(ctx.host);
    if (ctx.phase === "template") return leaseTemplateSteps(profile);
    if (ctx.phase === "agent" && ctx.agent !== undefined) {
      return [leaseJobStep(ctx.db, profile, ctx.agent)];
    }
    return [];
  },
};
