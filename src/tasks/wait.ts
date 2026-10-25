// mu — waitForTasks: block until tasks reach a target status.
//
// The orchestrator pattern: dispatch N workers via mu task claim --for,
// then wait until they're all done before reviewing/merging.
//
// Pre-existing alternatives + why this verb exists:
//
//   awk pipe over `mu log --tail`: works for ONE event but the
//     awk script becomes stateful (tracking 'which of N have closed?')
//     for multi-task waits. Bad shape for SKILL examples.
//
// Implementation: an ADAPTER over the one loop, waitForEvents (src/wait.ts).
// The engine does the polling, the deadline clamp and the target check; what
// stays here is this verb's own policy, run on each iteration through the
// engine's `inspect` hook: the per-owner stuck detection, its stderr warning,
// the `agent.stall` event and the `--on-stall exit` throw. Slice C of
// v_wait_core replaces that with stall events and actions; until then the
// output of `mu task wait` does not change.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { StateReading } from "../agent-state.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { isJsonMode } from "../output.js";
import { type WaitSnapshot, waitForEvents } from "../wait.js";
import { StallDetectedDuringWaitError, stallWaitHint } from "./errors.js";
import type { TaskStatus, TaskSubstate } from "./status.js";

// ─── Test seams: poll-sleep + poll counter + stuck-warn writer ─────────
//
// Mirror src/tmux.ts's setSleepForTests pattern. Default sleep is a real
// setTimeout; tests can swap in an instant + counted version to assert
// poll cadence (the bug fixed alongside this hook silently sleeps a full
// pollMs past the deadline when pollMs > timeoutMs — see
// test/tasks-wait.integration.test.ts 'clamped sleep' regression case).
//
// The stuck-warn writer is the second seam: agent_attention_required
// (named agent_close_discipline_gap until it was found to presume one
// of three causes) added a per-poll "this task is IN_PROGRESS but its
// owner is needs_input for too long" warning emitted to stderr; tests
// intercept it via setWaitStuckWarnForTests so they can assert
// exactly-once dedupe without scraping process.stderr.

let currentWaitSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export { DEFAULT_CTL_STUCK_AFTER_MS, DEFAULT_STUCK_AFTER_MS } from "../wait-types.js";

import { DEFAULT_CTL_STUCK_AFTER_MS, DEFAULT_STUCK_AFTER_MS } from "../wait-types.js";

const defaultStuckWarn: (msg: string) => void = (msg) => {
  // --json: the stall is in the document (`stuck`, nextSteps); stderr stays empty.
  if (isJsonMode()) return;
  process.stderr.write(msg);
};
let currentStuckWarn: (msg: string) => void = defaultStuckWarn;

export function setWaitSleepForTests(
  impl: ((ms: number) => Promise<void>) | undefined,
): (ms: number) => Promise<void> {
  const previous = currentWaitSleep;
  currentWaitSleep = impl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return previous;
}

/** Test seam: swap the stderr writer used by the stuck-task warning so
 *  unit tests can capture warnings without spying on process.stderr. */
export function setWaitStuckWarnForTests(
  impl: ((msg: string) => void) | undefined,
): (msg: string) => void {
  const previous = currentStuckWarn;
  currentStuckWarn = impl ?? defaultStuckWarn;
  return previous;
}

export { getWaitPollCount, resetWaitPollCount } from "../wait.js";

/**
 * Human-readable age for the attention warning: `45s`, `5m`, `2h`.
 *
 * Deliberately NOT `relTime` from src/cli/format.ts — that module
 * pulls picocolors and cli-table3, and this one stays dep-free so the
 * SDK can be imported without the CLI's render layer. The duplication
 * is three lines of arithmetic against a shared import that would
 * invert the layering.
 *
 * Raw milliseconds were the old wording and read badly: a worker five
 * minutes into a question got "(>= 1000ms ...)" because the message
 * quoted the THRESHOLD, not the age.
 */
export function formatStallAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

/** A single task ref the wait verb is watching. Cross-workstream
 *  waits arrive as a heterogeneous list of (workstream, name) pairs;
 *  the legacy single-workstream call passes the same workstream on
 *  every ref. task_wait_cross_workstream. */
export interface TaskWaitRef {
  /** The workstream the task lives in. Each ref carries its own so
   *  the SDK doesn't need a single "the workstream" — cross-ws waits
   *  pass refs from multiple workstreams in one call. */
  workstreamName: string;
  /** The task's per-workstream-unique local id. */
  name: string;
}

export interface TaskWaitOptions {
  /** Target status. Default 'CLOSED'. */
  status?: TaskStatus;
  /** When true, succeed as soon as ONE listed task reaches the target.
   *  Default false: every listed task must reach the target. */
  any?: boolean;
  /** Maximum time to wait, in milliseconds. Default 600_000 (10 min).
   *  Pass 0 to wait forever. */
  timeoutMs?: number;
  /** Polling interval. Default 1000ms; overridable for tests. */
  pollMs?: number;
  /** Workstream context applied to bare-string ids. Required when the
   *  caller passes `string[]`; ignored when the caller passes
   *  `TaskWaitRef[]` (each ref carries its own ws). The legacy
   *  single-ws SDK call site keeps its today's shape; the cross-ws
   *  callers (CLI verb) pass `TaskWaitRef[]` and omit `workstream`.
   *  task_wait_cross_workstream. */
  workstream?: string;
  /** Emit a yellow STUCK warning to stderr (once per task per wait call)
   *  when an IN_PROGRESS task's owner has been in `needs_input` for at
   *  least this many milliseconds since the agent row's last update.
   *  Default `DEFAULT_STUCK_AFTER_MS` (2 min). Pass 0 to disable.
   *
   *  Surfaced by agent_attention_required: a worker sitting in
   *  needs_input leaves wait blocked indefinitely. The cause may be a
   *  finish-without-close, a question awaiting an answer, or a prompt
   *  — the predicate cannot tell them apart, so the warning reports
   *  the observation and points at `mu agent read`. Default action is
   *  observation-only (wait keeps polling); `onStall: 'exit'` makes it
   *  terminal. */
  stuckAfterMs?: number;
  /** `stuckAfterMs` for an owner whose reading came from a working
   *  control socket (source ctl, ctl ok). Default
   *  `DEFAULT_CTL_STUCK_AFTER_MS`. `stuckAfterMs: 0` disables both. */
  ctlStuckAfterMs?: number;
  /** What to do when the `--stuck-after` predicate fires on a watched
   *  task. `'warn'` (default) = today's behaviour: yellow STUCK line
   *  to stderr (deduped per task per wait call) + corroborating
   *  `kind='event'` agent_logs row; wait keeps polling. `'exit'` =
   *  same emit + persist, but THEN throw `StallDetectedDuringWaitError`
   *  so the CLI wrapper exits 7 (STALL_DETECTED). The exit-action is
   *  the unattended-orchestrator escape: a wrapping policy can branch
   *  on 7 (idle, ambiguous — operator decides poke vs release) vs 6
   *  (dead pane, unambiguous — re-dispatch).
   *
   *  Carve-out (lives at the call site, not here): the CLI passes
   *  `'exit'` only when the wait target is CLOSED — mirrors exit-6's
   *  reaper-flip suppression. With `--status OPEN` the worker reaching
   *  needs_input might BE the success path. See
   *  task_wait_stall_action_flag. */
  onStall?: "warn" | "exit";
  /** Read an owner's current runtime state for attention detection.
   *  Without this hook, SDK waits never infer a stall from stored data. */
  readOwnerState?: (owner: {
    name: string;
    workstreamName: string;
  }) => Promise<StateReading | null>;
  /** Optional async hook run BEFORE every snapshot (initial + each
   *  poll iteration). The CLI uses this to reconcile the workstream
   *  each tick (reaper flips IN_PROGRESS → OPEN for dead-pane
   *  workers) and to throw a typed error when a reaper-flip on a
   *  watched task should abandon the wait — see
   *  task_wait_reconcile_dead_panes. Throwing from `beforePoll`
   *  propagates out of `waitForTasks` unchanged.
   *
   *  Kept as a generic seam (not a `--reconcile`-shaped option) so
   *  the SDK module stays free of tmux/reconcile imports — that
   *  layering belongs above the SDK in the CLI wrapper. */
  beforePoll?: () => Promise<void>;
}

export interface TaskWaitTaskState {
  /** The workstream this task lives in. Cross-workstream waits
   *  return a mixed list; the workstream is part of identity.
   *  task_wait_cross_workstream. */
  workstreamName: string;
  /** The task's per-workstream-unique name. */
  name: string;
  /** Current status (at the moment we exit). */
  status: TaskStatus;
  /** Current substate. A CLOSED ref that is not `done` has no deliverable. */
  substate: TaskSubstate;
  /** Owner at exit time (NULL when unowned, after release, or after
   *  the reaper flipped IN_PROGRESS → OPEN due to a dead pane). */
  owner: string | null;
  /** True when this task's status equals the target. */
  reachedTarget: boolean;
  /** True when the task is IN_PROGRESS, owned by a registered agent
   *  whose detected status is `needs_input` for >= `stuckAfterMs`.
   *  Surfaces agent_attention_required: the worker may have finished
   *  without closing, be waiting on an answer, or be sitting at a
   *  prompt — this flag does not distinguish them, so a consumer
   *  should read the pane. Backwards-compatible signal — callers
   *  ignoring it see no behaviour change. */
  stuck: boolean;
}

export interface TaskWaitResult {
  /** Per-task state at exit time. Same length and order as the input
   *  list. The caller derives all-reached / any-reached / elapsed
   *  from this list (count `r.reachedTarget`) and from its own
   *  startedAt clock — keeping the SDK return minimal. */
  refs: TaskWaitTaskState[];
  /** True when we exited because of the timeout, not because the wait
   *  condition was met. Refs that did reach the target are still
   *  reflected in `refs[i].reachedTarget` on partial-progress timeout. */
  timedOut: boolean;
}

/**
 * Block until a set of tasks reaches `opts.status` (default CLOSED).
 * Returns a result describing the final state — the caller decides
 * whether to treat partial-progress timeouts as success or failure
 * (the CLI maps a clean exit to 0, a timeout to 5).
 *
 * Pre-flight: every task in `localIds` MUST exist; missing ones throw
 * TaskNotFoundError before any waiting begins. This is loud-fail by
 * design — a typo'd id silently waiting forever is the worst-case UX.
 */
export async function waitForTasks(
  db: Db,
  input: readonly TaskWaitRef[] | readonly string[],
  opts: TaskWaitOptions,
): Promise<TaskWaitResult> {
  if (input.length === 0) {
    throw new Error("waitForTasks: refs must be non-empty");
  }
  // Normalise to TaskWaitRef[]. The string[] shape preserves today's
  // single-workstream SDK contract (callers pass `workstream` on
  // opts); the TaskWaitRef[] shape carries its own ws per ref so
  // cross-workstream waits don't need a sentinel.
  const refs: readonly TaskWaitRef[] = input.map((entry) => {
    if (typeof entry === "string") {
      if (opts.workstream === undefined)
        throw new Error(
          "waitForTasks: string ids require opts.workstream; pass TaskWaitRef[] for cross-workstream waits",
        );
      return { workstreamName: opts.workstream, name: entry };
    }
    return entry;
  });
  const target: TaskStatus = opts.status ?? "CLOSED";
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const ctlStuckAfterMs = opts.ctlStuckAfterMs ?? DEFAULT_CTL_STUCK_AFTER_MS;
  const onStall: "warn" | "exit" = opts.onStall ?? "warn";

  // Per-(ws,name) dedupe: emit the STUCK warning at most ONCE per wait
  // call, not once per poll cycle. Operators don't want their stderr
  // filled with the same yellow line every second; one nudge is enough.
  const stuckWarned = new Set<string>();
  const refKey = (ref: TaskWaitRef): string => `${ref.workstreamName}/${ref.name}`;
  // Owners whose control socket is broken: first-seen time + reason.
  const ctlBrokenSince = new Map<string, number>();
  const stuckLabel = new Map<string, string>();
  // Owners whose reading carried a ctl link: they run pi, so the stall
  // error can point at `mu agent abort`.
  const ctlOwners = new Set<string>();
  // The latest ctl run count per owner, for the stall hints.
  const ownerRuns = new Map<string, number>();
  const stuckNow = new Set<string>();

  const stuckAgeMs = async (
    status: string | null,
    owner: { name: string; workstreamName: string } | undefined,
  ): Promise<number | null> => {
    if (
      stuckAfterMs <= 0 ||
      status !== "IN_PROGRESS" ||
      owner === undefined ||
      opts.readOwnerState === undefined
    )
      return null;
    const reading = await opts.readOwnerState(owner);
    const ownerKey = `${owner.workstreamName}/${owner.name}`;
    if (reading?.ctl !== undefined) ctlOwners.add(ownerKey);
    if (reading?.runs !== undefined) ownerRuns.set(ownerKey, reading.runs);
    else ownerRuns.delete(ownerKey);
    // A pi owner whose control socket does not answer (pane still
    // alive) needs attention too: nothing will report it settling.
    // Its age runs from when this wait first saw the socket broken.
    if (reading?.alive === true && (reading.ctl === "missing" || reading.ctl === "refused")) {
      const firstSeen = ctlBrokenSince.get(ownerKey) ?? Date.now();
      ctlBrokenSince.set(ownerKey, firstSeen);
      stuckLabel.set(ownerKey, reading.reason ?? `ctl ${reading.ctl}`);
      const ageMs = Date.now() - firstSeen;
      return ageMs >= stuckAfterMs ? ageMs : null;
    }
    ctlBrokenSince.delete(ownerKey);
    stuckLabel.delete(ownerKey);
    if (reading?.state !== "needs_input" || reading.since === null) return null;
    const viaCtl = reading.source === "ctl" && reading.ctl === "ok";
    if (viaCtl && reading.pending === true) return null;
    const ageMs = Date.now() - reading.since;
    return ageMs >= (viaCtl ? ctlStuckAfterMs : stuckAfterMs) ? ageMs : null;
  };

  /** One iteration's stuck pass over the watched tasks (the engine's `inspect`). */
  const inspect = async (snaps: readonly WaitSnapshot[]): Promise<void> => {
    stuckNow.clear();
    for (const snap of snaps) {
      const ref = { workstreamName: snap.ref.workstream, name: snap.ref.id };
      const status = snap.status;
      const owner = snap.owner ?? null;
      // The owner's own workstream, not the task's: a cross-workstream
      // owner (`task claim --for <ws>/<agent>`) is read, keyed and
      // named under the workstream it lives in.
      const ownerRef =
        owner === null
          ? undefined
          : { name: owner, workstreamName: snap.ownerWorkstream ?? ref.workstreamName };
      const ownerWs = ownerRef?.workstreamName ?? ref.workstreamName;
      const ageMs = await stuckAgeMs(status, ownerRef);
      const key = refKey(ref);
      if (ageMs === null) continue;
      stuckNow.add(key);
      if (stuckWarned.has(key)) continue;
      stuckWarned.add(key);
      const ageSecs = Math.round(ageMs / 1000);
      // State the OBSERVATION, not a cause. The predicate above only
      // knows "needs_input for >= N" — it cannot tell a worker that
      // finished without closing from one waiting on an answer from
      // one sitting at a prompt, and those need opposite responses.
      // The old text asserted the first ("likely committed but
      // skipped mu task close"), which sent at least one operator
      // hunting for a commit to merge while the worker was waiting
      // on a design decision. Workers asking questions is DESIRABLE;
      // the tooling must not frame it as negligence.
      //
      // The indented lines are the remedy: a pi owner's last answer
      // (wait --after-runs) when its socket reported runs, then
      // `mu agent read`, the next move in all three cases, because a
      // question, dialog, or crash is in the pane, not in the task row.
      //
      // Yellow ANSI escape inline (no picocolors import — keeps the
      // SDK module dep-free; the CLI layer already pulls picocolors).
      // Prefixed `mu task wait:` so log greppers can target it, and
      // cross-ws waits carry the qualified `<ws>/<name>`.
      const ownerBit = owner ?? "<none>";
      const runs = ownerRuns.get(`${ownerWs}/${ownerBit}`);
      const stateBit = stuckLabel.get(`${ownerWs}/${ownerBit}`) ?? "needs_input";
      const waitLine = stallWaitHint(ownerBit, ownerWs, runs)
        .map((s) => `  ${s.command}\n`)
        .join("");
      currentStuckWarn(
        `\x1b[33mmu task wait: ${key} needs attention — owner=${ownerBit} has been in ` +
          `${stateBit} for ${formatStallAge(ageMs)}. It may have finished without closing, ` +
          `be waiting on an answer, or be sitting at a prompt.\x1b[0m\n` +
          waitLine +
          `  mu agent read ${ownerBit} -w ${ownerWs} --lines 60\n`,
      );
      // Persist a corroborating kind='event' row so other consumers
      // (mu state, mu log --kind event, dashboards) see the same
      // signal that the new derived `idle` flag surfaces in the
      // agents table. The stderr warning stays — observation-only,
      // operator decides recovery. See idle_assigned_agent_detection.
      // Pure OBSERVATION: nothing is mutated, so no trigger could
      // ever see this. The emit is the only record.
      emitEvent(
        db,
        ref.workstreamName,
        "agent.stall",
        `agent stalled ${owner ?? "<none>"} owns ${ref.name} for ${ageSecs}s`,
        owner ?? "system",
      );
      // task_wait_stall_action_flag: with `--on-stall exit` (the
      // unattended-orchestrator escape), the same emit + persist
      // happens but we then throw — the CLI's classifyError maps
      // this to exit code 7 (STALL_DETECTED). The carve-out
      // (target=CLOSED only) lives at the call site: the CLI
      // wrapper passes `onStall: 'exit'` only when target=CLOSED.
      // Precedence vs exit-6 (dead pane): the reaper-flip check
      // throws inside `beforePoll` BEFORE this runs, so a watched
      // task that's both reaper-flipped AND stale never reaches this
      // branch (status would already be OPEN).
      if (onStall === "exit") {
        throw new StallDetectedDuringWaitError(
          ref.name,
          owner,
          ref.workstreamName,
          ageSecs,
          ctlOwners.has(`${ownerWs}/${owner ?? ""}`),
          runs,
          ownerWs,
        );
      }
    }
  };

  const res = await waitForEvents(
    db,
    refs.map((r) => ({ kind: "task" as const, workstream: r.workstreamName, id: r.name })),
    {
      callers: [],
      mode: opts.any === true ? "first" : "all",
      eventScope: "refs",
      stuckAfterMs: 0,
      uncapped: true,
      status: target,
      timeoutMs: opts.timeoutMs ?? 600_000,
      pollMs: opts.pollMs ?? 1000,
      sync: false,
      sleep: (ms) => currentWaitSleep(ms),
      inspect,
      ...(opts.beforePoll !== undefined ? { beforePoll: opts.beforePoll } : {}),
    },
  );
  const byKey = new Map(res.refs.map((s) => [`${s.ref.workstream}/${s.ref.id}`, s]));
  return {
    refs: refs.map((ref): TaskWaitTaskState => {
      const snap = byKey.get(refKey(ref));
      const status = (snap?.status ?? "OPEN") as TaskStatus;
      return {
        workstreamName: ref.workstreamName,
        name: ref.name,
        status,
        substate: (snap?.substate ?? "todo") as TaskSubstate,
        owner: snap?.owner ?? null,
        reachedTarget: snap?.fired === true,
        stuck: stuckNow.has(refKey(ref)),
      };
    }),
    timedOut: res.timedOut,
  };
}
