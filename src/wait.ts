// mu — waitForEvents: the one owned-event wait.
//
// Before this there were two poll loops (waitForTasks, waitForAgents) and a
// shell loop above them; none could see a delegate's report or end on any
// event but its own. This is the single loop; both are adapters over it.
//
// One iteration: beforePoll, a bounded sync ingest, the DB reads (tasks,
// delegates, the caller's registration), ONE batched agent read, apply the
// CLOSE blocks of settled pi runs, then pick. Then it races an agent watch
// settling (ctl `wait`, never awaited serially), a poll sleep, the caller's
// abort signal and the deadline. Every await inside an iteration is raced
// with abort and deadline too, so no read can hold the wait past either.
// No database transaction spans an await.
//
// What a wait watches:
//   targets  the explicit refs, a wave's delegate calls (this caller's) and
//            the open transitive blockers of `blockersOf` (re-read each
//            iteration, so graph edits count).
//   owned    what the caller's registration owes it, plus its in-flight
//            delegate calls (registered the first time a wait sees them).
//            Owned refs are observed even while explicit targets are waited
//            on; another caller's work is never seen.
//
// first vs all. `first` returns the best ready event over targets and owned
// refs. `all` returns once every target is done (no targets: every owned
// ref); an urgent event (an owned ref that died, an agent blocked on a
// dialog, a stall, an owned delegate report) ends it early without counting
// toward "all". Order: never-returned events first, then dead, input, stall,
// delegate, then closed/settled; targets before owned refs.
//
// Delivery is durable, never in-memory. Every event has a cursor key
// (src/wait-cursor.ts): a close or settle under the ref's own key, an urgent
// observation under `input|`, `dead|` or `stall|` + the ref key with a token
// that names ITS state (the dialog's `since`, the owner's registry id, the
// stall token), a blockersOf blocker seen open under `open|` + key. An event
// is consumed only when it is the one returned, in ONE short transaction
// guarded by the registration's generation (endWait). A sibling that `first`
// did not return stays owed (a timeout or interrupt delivers nothing), a
// returned event is never delivered again, and an unchanged urgent
// observation is news once per state change: it never outranks a
// never-returned event, so it cannot starve a delegate report. Explicit refs
// ignore the cursor of their completion (waiting on a closed task returns at
// once); owned refs obey it.
//
// The fence. An agent ref the caller registered, explicit or owned, counts
// its runs from the stored UNCONSUMED baseline, maxed with the consumed
// cursor of the same pi process; with neither it counts from the run count
// probed now, stores that as the fence and says `unknownBaseline`: a
// historical run is never mistaken for completion.
//
// CLOSE. A settled pi run's CLOSE block is applied once (applySettledClose)
// before the snapshot returns. The close-block refuses delegate and human
// tasks, so a delegate answer never closes its own task ahead of
// finishDelegate's recorder.
//
// Stalls. The engine detects them (an IN_PROGRESS work task whose owner needs
// input or has a broken control socket, `stuckAfterMs`); `handleStall` (raced,
// once per stallToken) owns the policy and effects. The legacy per-task
// `stuck` warning stays in tasks/wait.ts behind the `inspect` hook.
//
// Not here: the CLI and signal wiring, arming from spawn/send/claim
// (v_wait_cli).

import { agentKey } from "./agent-state.js";
import { AgentNotFoundError, AgentRestartedError } from "./agents/errors.js";
import type { Db } from "./db.js";
import {
  DelegateNotFoundError,
  type DelegateRow,
  getDelegateCall,
  listDelegatesOf,
  TERMINAL_DELEGATE_STATES,
  type VerdictTally,
  verdictTally,
} from "./delegates.js";
import { openHumanNeeds } from "./human-needed.js";
import { emitEvent } from "./logs.js";
import { taskRevision } from "./revision.js";
import { ambientFlush, ambientIngest } from "./sync.js";
import { taskIdFor } from "./tasks/core.js";
import { TaskNotFoundError } from "./tasks/errors.js";
import { getTask, getTaskOwner } from "./tasks/queries.js";
import { DEFAULT_SUBSTATE, type TaskStatus } from "./tasks/status.js";
import {
  type CursorToken,
  closedToken,
  cursorKey,
  DELEGATE_TOKEN,
  isConsumed,
  readCursors,
  recordCursors,
} from "./wait-cursor.js";
import {
  agentExists,
  agentRowId,
  closeSettledRun,
  openBlockers,
  taskOwnerRowId,
} from "./wait-db.js";
import { compileTextMatcher, type TextMatcher } from "./wait-regex.js";
import {
  beginWait,
  checkCaller,
  endWait,
  fenceAgentRef,
  type RefBaseline,
  type RegisteredRef,
  readWaitRegistration,
} from "./wait-registration.js";
import {
  type AgentReading,
  type AgentWatchHandle,
  type CloseOutcome,
  DEFAULT_CTL_STUCK_AFTER_MS,
  DEFAULT_STUCK_AFTER_MS,
  type StallActionResult,
  WAIT_HEARTBEAT_CAP_MS,
  type WaitEventKind,
  WaitNothingError,
  type WaitOptions,
  type WaitRef,
  WaitRefError,
  type WaitResult,
  type WaitSnapshot,
  type WaitStallContext,
} from "./wait-types.js";

let pollCount = 0;
/** Sleeps taken across all waits in this process. */
export function getWaitPollCount(): number {
  return pollCount;
}
export function resetWaitPollCount(): void {
  pollCount = 0;
}

interface Item {
  key: string;
  ref: WaitRef;
  snap: WaitSnapshot;
  /** Counts toward `all`; explicit refs, wave calls and blockers. */
  target: boolean;
  /** An already-consumed event is hidden (owned refs, waves, blockers); explicit refs ignore the cursor. */
  suppressible: boolean;
  order: number;
  /** The event this ref can deliver now, when any. */
  kind?: WaitEventKind;
  token?: CursorToken;
  /** The cursor key `token` is recorded under: the ref's own key, or an urgent observation's (`input|<key>`). */
  ckey?: string;
  /** The event was already returned once (its token is consumed): it never outranks a never-returned one. */
  seen?: boolean;
  /** An owned event that was already returned: hidden until its state changes. */
  hidden?: boolean;
  /** Completed: closed, settled, delegate terminal, dead. */
  done: boolean;
  ready: boolean;
  /** A task whose owner stalled: what the stall hook needs. */
  stall?: {
    token: string;
    owner: AgentReading;
    ownerRef: { name: string; workstreamName: string };
  };
}

interface AgentTrack {
  ref: WaitRef;
  explicit: boolean;
  wasBusy: boolean;
  /** The ctl run count a (re)watch counts past. */
  baseline: number | undefined;
  handle: AgentWatchHandle | undefined;
  needWatch: boolean;
  result: AgentReading | undefined;
  reading: AgentReading | undefined;
  latched: { kind: "settled" | "dead" | "input"; reading: AgentReading } | undefined;
  close: CloseOutcome | undefined;
  /** The dialog already returned once is still open: not news again until it changes. */
  muted: boolean;
  /** Owed with no fence, no cursor: counted from now, said so in the snapshot. */
  unknownBaseline: boolean;
}

const refKey = (r: Pick<WaitRef, "kind" | "workstream" | "id">): string =>
  cursorKey(r.kind, r.workstream, r.id);
const registered = (r: WaitRef): RegisteredRef => ({
  kind: r.kind,
  workstream: r.workstream,
  id: r.id,
});
const URGENCY: Partial<Record<WaitEventKind, number>> = {
  dead: 0,
  input: 1,
  stall: 2,
  delegate: 3,
};
const urgency = (k: WaitEventKind | undefined): number => (k === undefined ? 9 : (URGENCY[k] ?? 4));
const exitFor = (k: WaitEventKind): WaitResult["exit"] =>
  k === "dead" ? 6 : k === "input" || k === "stall" ? 7 : k === "interrupted" ? 130 : 0;

/** Wait for the next owned event (or all targets). See the file comment. */
export async function waitForEvents(
  db: Db,
  input: readonly WaitRef[],
  opts: WaitOptions,
): Promise<WaitResult> {
  const callers = [...new Set(opts.callers ?? [])];
  for (const c of callers) checkCaller(c);
  const all = opts.mode === "all";
  const ownedScope = opts.eventScope !== "refs";
  const stuckExplicit = opts.stuckAfterMs;
  const stuckEnabled =
    stuckExplicit !== 0 && opts.status !== "OPEN" && opts.status !== "IN_PROGRESS";
  const stuckAfter = (viaCtl: boolean): number =>
    stuckExplicit ?? (viaCtl ? DEFAULT_CTL_STUCK_AFTER_MS : DEFAULT_STUCK_AFTER_MS);
  // Owners of watched tasks are read for death (callers) and for stalls.
  const observeOwners =
    ((callers.length > 0 && ownedScope) || stuckEnabled) && opts.readAgents !== undefined;
  /** The callers consume what they are handed (cursors, registration) only for owned-scope waits. */
  const consumes = ownedScope && callers.length > 0;
  const target: TaskStatus = opts.status ?? "CLOSED";
  const matcher: TextMatcher | undefined =
    typeof opts.until === "object" ? compileTextMatcher(opts.until.text) : undefined;
  const applyClose = opts.applyClose !== false;
  const pollMs = opts.pollMs ?? 1000;
  const requested = opts.timeoutMs ?? 0;
  const timeoutMs = opts.uncapped
    ? requested
    : requested === 0
      ? WAIT_HEARTBEAT_CAP_MS
      : Math.min(requested, WAIT_HEARTBEAT_CAP_MS);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  // ─── resolve every ref upfront: typed, exact, nothing ambiguous ───
  for (const ref of input) {
    if (ref.kind === "task") {
      if (getTask(db, ref.id, ref.workstream) === undefined) {
        throw new TaskNotFoundError(`${ref.workstream}/${ref.id}`);
      }
    } else if (ref.kind === "agent") {
      if (!agentExists(db, ref)) throw new AgentNotFoundError(ref.id);
    } else {
      const call = getDelegateCall(db, ref.id);
      if (call === undefined || call.workstream !== ref.workstream) {
        throw new DelegateNotFoundError(ref.id);
      }
      if (callers.length > 0 && !callers.includes(call.caller)) {
        throw new WaitRefError(`delegate call ${ref.id} belongs to another caller`);
      }
    }
  }
  const umbrella =
    opts.blockersOf === undefined
      ? undefined
      : taskIdFor(db, opts.blockersOf.id, opts.blockersOf.workstream);
  if (opts.blockersOf !== undefined && umbrella === null) {
    throw new TaskNotFoundError(`${opts.blockersOf.workstream}/${opts.blockersOf.id}`);
  }
  const explicit = new Map<string, WaitRef>();
  for (const r of input) explicit.set(refKey(r), r);
  if (opts.wave !== undefined && callers.length === 0) {
    throw new WaitRefError("wait: a wave belongs to callers; none given (no all-caller fallback)");
  }
  if (input.length === 0 && !opts.wave && !opts.blockersOf && callers.length === 0) {
    throw new WaitNothingError();
  }

  // ─── one active wait per caller; cursors read before any await ────
  const begun = new Map<string, NonNullable<ReturnType<typeof beginWait>>>();
  if (consumes) {
    for (const c of callers) {
      const b = beginWait(db, c);
      if (b !== undefined) begun.set(c, b);
    }
  }
  const cursorsBy = new Map<string, Map<string, CursorToken>>(
    (consumes ? callers : []).map((c) => [c, readCursors(db, c)]),
  );
  /** Whose registration or delegate call holds `key` (else the first caller: where its token is written). */
  const ownerOfKey = new Map<string, string>();
  /** An urgent observation's cursor key -> the ref key it observes. */
  const baseOfCkey = new Map<string, string>();
  const urgentKey = (kind: string, key: string): string => {
    const k = `${kind}|${key}`;
    baseOfCkey.set(k, key);
    return k;
  };
  const ownerOf = (key: string): string | undefined =>
    ownerOfKey.get(baseOfCkey.get(key) ?? key) ?? callers[0];
  const cursorOf = (key: string): CursorToken | undefined => {
    const o = ownerOf(key);
    return o === undefined ? undefined : cursorsBy.get(o)?.get(key);
  };
  const baselineOf = new Map<string, RefBaseline>();
  /** The agent refs some caller has registered (explicit or not). */
  const ownedKeys = new Set<string>();

  // ─── stop signals: abort and the deadline race every await ────────
  const watchAbort = new AbortController();
  let stopReason: "abort" | "deadline" | undefined;
  let stopNow: (why: "abort" | "deadline") => void = () => {};
  const stopP = new Promise<void>((resolve) => {
    stopNow = (why) => {
      stopReason ??= why;
      resolve();
    };
  });
  const onAbort = (): void => {
    watchAbort.abort();
    stopNow("abort");
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const deadlineTimer =
    deadline === Number.POSITIVE_INFINITY
      ? undefined
      : setTimeout(() => stopNow("deadline"), Math.max(0, deadline - Date.now()));
  type Raced<T> = { lost: false; v: T } | { lost: true };
  const within = <T>(p: Promise<T>): Promise<Raced<T>> =>
    Promise.race([
      p.then((v): Raced<T> => ({ lost: false, v })),
      stopP.then((): Raced<T> => ({ lost: true })),
    ]);

  // A watch settling wakes the loop; a watch that rejected is fatal.
  let fatal: { error: unknown } | undefined;
  let wake: () => void = () => {};
  let woken = new Promise<void>((resolve) => {
    wake = resolve;
  });

  const tracks = new Map<string, AgentTrack>();
  const ownerReadings = new Map<string, AgentReading>();
  /** A wait with no caller owns no durable state: its blockers seen open are remembered for this wait only. */
  const openLocal = new Set<string>();
  const priorTask = new Map<string, { status: string; owner: string | null; ownerId: number }>();
  const reapedOwners = new Set<string>();
  let lastItems: Item[] = [];
  let firstRefresh = true;
  let inspected = false;
  const delivered: Item[] = [];

  /** The callers' registered refs, merged (each ref once); records which caller owes which. */
  const ownedRefs = (): WaitRef[] => {
    if (!consumes) return [];
    const out = new Map<string, WaitRef>();
    ownedKeys.clear();
    for (const c of callers) {
      const reg = readWaitRegistration(db, c);
      if (reg === undefined) continue;
      for (const r of reg.refs) {
        const key = refKey(r);
        ownedKeys.add(key);
        if (!out.has(key)) {
          out.set(key, { ...r });
          ownerOfKey.set(key, c);
        }
        const b = reg.baselines[key];
        if (b !== undefined) {
          const old = baselineOf.get(key);
          if (
            old === undefined ||
            (old.incarnation === b.incarnation && b.afterRuns < old.afterRuns)
          ) {
            baselineOf.set(key, b);
          }
        }
      }
    }
    return [...out.values()];
  };

  const track = (ref: WaitRef, isExplicit: boolean): AgentTrack => {
    const key = refKey(ref);
    let t = tracks.get(key);
    if (t === undefined) {
      t = {
        ref,
        explicit: isExplicit,
        wasBusy: false,
        baseline: ref.afterRuns,
        handle: undefined,
        needWatch: opts.watchAgent !== undefined,
        result: undefined,
        reading: undefined,
        latched: undefined,
        close: undefined,
        muted: false,
        unknownBaseline: false,
      };
      tracks.set(key, t);
    } else if (isExplicit) t.explicit = true;
    return t;
  };

  const setupWatches = async (): Promise<void> => {
    const watch = opts.watchAgent;
    const want = [...tracks.values()].filter((t) => t.needWatch && t.latched === undefined);
    if (watch === undefined || want.length === 0) return;
    for (const t of want) t.needWatch = false;
    const got = await within(
      Promise.all(
        want.map((t) => {
          const key = refKey(t.ref);
          const cur = cursorOf(key);
          const base = baselineOf.get(key);
          return watch(
            { ...t.ref, ...(t.baseline !== undefined ? { afterRuns: t.baseline } : {}) },
            watchAbort.signal,
            {
              owed: ownedKeys.has(key),
              ...(cur !== undefined ? { cursor: cur } : {}),
              ...(base !== undefined ? { baseline: base } : {}),
            },
          );
        }),
      ),
    );
    if (got.lost) return;
    got.v.forEach((h, i) => {
      const t = want[i];
      if (t === undefined || h === undefined) return;
      t.handle = h;
      t.reading = h.initial;
      if (t.baseline === undefined && h.afterRuns !== undefined) t.baseline = h.afterRuns;
      if (h.unknownBaseline !== undefined) {
        // Owed with no fence and no cursor: counted from what the watch probed, and
        // that is stored as the fence so a run settling between waits is still caught.
        t.unknownBaseline = true;
        const key = refKey(t.ref);
        const owner = ownerOf(key);
        if (owner !== undefined && consumes)
          fenceAgentRef(db, owner, registered(t.ref), h.unknownBaseline);
      }
      if (h.initial.status === "busy") t.wasBusy = true;
      void h.settled.then(
        (r) => {
          if (t.handle === h) t.result = r;
          wake();
        },
        (error: unknown) => {
          fatal ??= { error };
          wake();
        },
      );
    });
  };

  const settle = (t: AgentTrack, r: AgentReading): void => {
    const consumed =
      !t.explicit &&
      r.runs !== undefined &&
      isConsumed(cursorOf(refKey(t.ref)), { incarnation: r.incarnation ?? "", runs: r.runs });
    const close = consumed ? undefined : closeSettledRun(db, t.ref, r, applyClose);
    const textOk =
      matcher === undefined ||
      (r.lastError === undefined &&
        (r.lastText ?? "").trim() !== "" &&
        matcher.test(r.lastText ?? ""));
    if (!textOk || consumed) {
      // Not the text asked for, or already delivered: count past this run and wait for the next.
      if (r.runs !== undefined) t.baseline = r.runs;
      t.wasBusy = false;
      t.handle = undefined;
      t.result = undefined;
      t.needWatch = opts.watchAgent !== undefined;
      return;
    }
    t.latched = { kind: "settled", reading: r };
    if (close !== undefined) t.close = close;
  };

  /** Fold a watch result (`fromWatch`) or a poll reading into the track. */
  const inputToken = (r: AgentReading): CursorToken => ({
    incarnation: `input:${r.incarnation ?? ""}`,
    runs: r.blocked?.since ?? 0,
  });

  const advance = (t: AgentTrack, r: AgentReading, fromWatch: boolean): void => {
    if (t.latched !== undefined) return;
    const pinned = t.ref.incarnation;
    if (pinned !== undefined && r.incarnation !== undefined && r.incarnation !== pinned) {
      throw new AgentRestartedError(t.ref.id, t.ref.workstream, pinned, r.incarnation);
    }
    if (r.blocked === undefined && t.muted) {
      // The dialog is gone: the run goes on; count it again from the same baseline.
      t.muted = false;
      if (opts.watchAgent !== undefined && r.status !== null) {
        t.needWatch = true;
        return;
      }
    }
    if (r.status === null) {
      t.latched = { kind: "dead", reading: r };
    } else if (r.blocked !== undefined) {
      if (!t.explicit && isConsumed(cursorOf(urgentKey("input", refKey(t.ref))), inputToken(r))) {
        // This dialog was already returned once and is unchanged: not news. The
        // run is polled (a held watch would return blocked again at once).
        t.muted = true;
        t.wasBusy = true;
        t.handle = undefined;
        t.result = undefined;
        t.needWatch = false;
      } else t.latched = { kind: "input", reading: r };
    } else if (fromWatch) {
      // No settle seen (`unknown`): the watch ends and the agent is polled instead.
      if (r.status === "unknown") t.handle = undefined;
      else settle(t, r);
    } else if (r.status === "busy") {
      t.wasBusy = true;
    } else if (r.status !== "unknown" && t.wasBusy) {
      settle(t, r);
    }
  };

  /** The async half of an iteration: everything that may take time. */
  const refresh = async (): Promise<void> => {
    if (opts.beforePoll) {
      const b = await within(opts.beforePoll());
      if (b.lost) return;
    }
    if (opts.sync !== false) await ambientIngest(db, { quiet: true });
    const owned = ownedRefs();
    for (const r of explicit.values()) if (r.kind === "agent") track(r, true);
    for (const r of owned) if (r.kind === "agent") track(r, explicit.has(refKey(r)));
    await setupWatches();
    if (stopReason !== undefined) return;
    // Owners of watched in-progress tasks ride on the same batched read.
    const reads = new Map<string, WaitRef>();
    for (const t of tracks.values()) {
      if (t.latched === undefined && t.handle === undefined) reads.set(refKey(t.ref), t.ref);
    }
    if (observeOwners) {
      const taskRefs = [...explicit.values(), ...owned].filter((r) => r.kind === "task");
      for (const r of taskRefs) {
        const row = getTask(db, r.id, r.workstream);
        const o = row?.status === "IN_PROGRESS" ? getTaskOwner(db, r.id, r.workstream) : undefined;
        if (o !== undefined) {
          const ref: WaitRef = { kind: "agent", workstream: o.workstreamName, id: o.name };
          reads.set(refKey(ref), ref);
        }
      }
    }
    for (const t of tracks.values()) {
      const r = t.result;
      if (r === undefined || t.handle === undefined) continue;
      t.result = undefined;
      t.reading = r;
      advance(t, r, true);
    }
    if (reads.size > 0) {
      if (opts.readAgents === undefined) throw new Error("wait: an agent reader is required");
      const got = await within(opts.readAgents([...reads.values()], watchAbort.signal));
      if (got.lost) return;
      ownerReadings.clear();
      for (const ref of reads.values()) {
        const key = agentKey({ name: ref.id, workstreamName: ref.workstream });
        let r = got.v.get(key);
        if (r === undefined) {
          // A caller's own refs: an agent that is gone is dead, not unknown.
          r =
            callers.length > 0 && !agentExists(db, ref)
              ? { status: null, reason: "agent is no longer registered" }
              : { status: "unknown", reason: "state reader returned no row" };
        }
        ownerReadings.set(key, r);
        const t = tracks.get(refKey(ref));
        if (t !== undefined && t.latched === undefined && t.handle === undefined) {
          t.reading = r;
          advance(t, r, false);
        }
      }
    }
    if (firstRefresh) {
      firstRefresh = false;
      const watched = [...tracks.values()].filter((t) => t.explicit);
      if (
        watched.length > 0 &&
        watched.every((t) => (t.latched?.reading ?? t.reading)?.status === "unknown")
      ) {
        opts.onInitialUnknown?.(watched.map((t) => agentSnapshot(t)));
      }
    }
  };

  const agentSnapshot = (t: AgentTrack): WaitSnapshot => {
    const r = t.latched?.reading ?? t.reading;
    const status = t.latched?.kind === "dead" ? null : (r?.status ?? "unknown");
    return {
      ref: t.ref,
      status,
      ...(r?.agentId !== undefined ? { agentId: r.agentId } : {}),
      ...(r?.paneId !== undefined ? { paneId: r.paneId } : {}),
      ...(r?.settled !== undefined ? { settled: r.settled } : {}),
      ...(r?.lastTextTruncated !== undefined ? { lastTextTruncated: r.lastTextTruncated } : {}),
      ...(r?.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
      ...(r?.runs !== undefined ? { runs: r.runs } : {}),
      ...(r?.lastText !== undefined ? { lastText: r.lastText } : {}),
      ...(r?.lastError !== undefined ? { lastError: r.lastError } : {}),
      ...(r?.sessionFile !== undefined ? { sessionFile: r.sessionFile } : {}),
      ...(r?.blocked !== undefined ? { blocked: r.blocked } : {}),
      ...(status === "unknown" && r?.reason !== undefined ? { unknownReason: r.reason } : {}),
      ...(t.baseline !== undefined ? { afterRuns: t.baseline } : {}),
      wasBusy: t.wasBusy,
      ...(t.unknownBaseline ? { unknownBaseline: true } : {}),
      fired: t.latched?.kind === "settled",
      dead: t.latched?.kind === "dead",
      ...(t.close !== undefined ? { close: t.close } : {}),
    };
  };

  // ─── stall detection (the engine's; the policy is handleStall's) ───
  /** Owners whose control socket is broken: first-seen time (the age runs from here). */
  const ctlBrokenSince = new Map<string, number>();
  const stallEmitted = new Set<string>();
  const stallStates = new Map<string, { job?: Promise<void>; result?: StallActionResult }>();

  /** How long (ms) the owner has needed attention, or null when it does not. */
  const stallAgeMs = (ownerKey: string, r: AgentReading | undefined): number | null => {
    if (r === undefined || r.status === null) return null;
    const alive = true;
    // A pi owner whose control socket does not answer (pane alive): nothing will report it settling.
    if (alive && (r.ctl === "missing" || r.ctl === "refused")) {
      const first = ctlBrokenSince.get(ownerKey) ?? Date.now();
      ctlBrokenSince.set(ownerKey, first);
      const age = Date.now() - first;
      return age >= stuckAfter(false) ? age : null;
    }
    ctlBrokenSince.delete(ownerKey);
    if (r.status !== "needs_input" || r.since === undefined || r.since === null) return null;
    const viaCtl = r.source === "ctl" && r.ctl === "ok";
    if (viaCtl && r.pending === true) return null;
    const age = Date.now() - r.since;
    return age >= stuckAfter(viaCtl) ? age : null;
  };

  const taskItem = (
    ref: WaitRef,
    want: TaskStatus,
    isTarget: boolean,
    suppressible: boolean,
    order: number,
  ): Item => {
    const row = getTask(db, ref.id, ref.workstream);
    // A task deleted mid-wait reads as OPEN: never reached.
    const status = row?.status ?? "OPEN";
    const ownerRef = row === undefined ? undefined : getTaskOwner(db, ref.id, ref.workstream);
    const ownerName = ownerRef?.name ?? row?.ownerName ?? null;
    const snap: WaitSnapshot = {
      ref,
      status,
      substate: row?.substate ?? DEFAULT_SUBSTATE.OPEN,
      owner: ownerName,
      ...(ownerRef !== undefined ? { ownerWorkstream: ownerRef.workstreamName } : {}),
      fired: false,
      dead: false,
    };
    const item: Item = {
      key: refKey(ref),
      ref,
      snap,
      target: isTarget,
      suppressible,
      order,
      done: false,
      ready: false,
    };
    if (row === undefined) return item;
    // The owner died before the task closed: reaper precedence over closure.
    if (callers.length > 0 && want === "CLOSED" && status !== "CLOSED") {
      const prior = priorTask.get(item.key);
      const ownerKey = ownerRef === undefined ? undefined : agentKey(ownerRef);
      const dead =
        (ownerKey !== undefined && ownerReadings.get(ownerKey)?.status === null) ||
        (prior?.status === "IN_PROGRESS" &&
          status === "OPEN" &&
          prior.owner !== null &&
          reapedOwners.has(prior.owner));
      if (dead) {
        snap.dead = true;
        item.kind = "dead";
        item.done = true;
        item.ckey = urgentKey("dead", item.key);
        item.token = {
          incarnation: `dead:${ownerRef !== undefined ? taskOwnerRowId(db, ref) : (prior?.ownerId ?? 0)}`,
          runs: 1,
        };
        return item;
      }
    }
    // A work task whose owner needs attention: a stall (exit 7), never a close.
    if (
      stuckEnabled &&
      status === "IN_PROGRESS" &&
      row.kind === "work" &&
      ownerRef !== undefined &&
      want === "CLOSED"
    ) {
      const ownerKey = agentKey(ownerRef);
      const r = ownerReadings.get(ownerKey);
      const age = stallAgeMs(ownerKey, r);
      if (age !== null && r !== undefined) {
        const token = [
          row.workstreamId,
          row.name,
          ownerKey,
          r.incarnation ?? "",
          r.runs ?? "",
          r.since ?? "",
        ].join("|");
        snap.stuck = true;
        item.kind = "stall";
        item.ckey = urgentKey("stall", item.key);
        item.token = { incarnation: `stall:${token}`, runs: 1 };
        item.stall = { token, owner: r, ownerRef };
        if (!stallEmitted.has(token)) {
          stallEmitted.add(token);
          emitEvent(
            db,
            ref.workstream,
            "agent.stall",
            `agent stalled ${ownerRef.name} owns ${ref.id} for ${Math.round(age / 1000)}s`,
            ownerRef.name,
          );
        }
        return item;
      }
    }
    if (status !== want) return item;
    if (matcher !== undefined) {
      const rep = db
        .prepare(
          `SELECT n.content FROM task_notes n JOIN tasks t ON t.id = n.task_id
             JOIN workstreams w ON w.id = t.workstream_id
            WHERE w.name = ? AND t.local_id = ? AND n.kind = 'report' ORDER BY n.id DESC LIMIT 1`,
        )
        .get(ref.workstream, ref.id) as { content: string } | undefined;
      if (row.substate !== "done" || rep === undefined || !matcher.test(rep.content)) return item;
    }
    const note = db
      .prepare(
        `SELECT COALESCE(MAX(n.id), 0) AS n FROM task_notes n JOIN tasks t ON t.id = n.task_id
           JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ? AND t.local_id = ?`,
      )
      .get(ref.workstream, ref.id) as { n: number };
    snap.fired = true;
    item.kind = "closed";
    item.done = true;
    item.token = closedToken(note.n);
    return item;
  };

  const delegateItem = (
    call: DelegateRow,
    isTarget: boolean,
    suppressible: boolean,
    order: number,
  ): Item => {
    const ref: WaitRef = { kind: "delegate", workstream: call.workstream, id: call.callId };
    const terminal = TERMINAL_DELEGATE_STATES.includes(call.state);
    const item: Item = {
      key: refKey(ref),
      ref,
      snap: {
        ref,
        status: call.state,
        verdict: call.verdict,
        owner: call.agent,
        fired: terminal,
        dead: false,
      },
      target: isTarget,
      suppressible,
      order,
      done: terminal,
      ready: false,
    };
    if (terminal) {
      item.kind = "delegate";
      item.token = DELEGATE_TOKEN;
    }
    return item;
  };

  const agentItem = (t: AgentTrack, isTarget: boolean, order: number): Item => {
    const l = t.latched;
    const r = l?.reading;
    const key = refKey(t.ref);
    let token: CursorToken | undefined;
    let ckey: string | undefined;
    if (l?.kind === "settled" && r?.runs !== undefined) {
      token = { incarnation: r.incarnation ?? "", runs: r.runs };
    } else if (l?.kind === "input" && r !== undefined) {
      ckey = urgentKey("input", key);
      token = inputToken(r);
    } else if (l?.kind === "dead") {
      ckey = urgentKey("dead", key);
      token = { incarnation: `dead:${agentRowId(db, t.ref)}`, runs: 1 };
    }
    return {
      key,
      ref: t.ref,
      snap: agentSnapshot(t),
      target: isTarget,
      suppressible: !t.explicit,
      order,
      done: l?.kind === "settled" || l?.kind === "dead",
      ready: false,
      ...(l !== undefined ? { kind: l.kind } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(ckey !== undefined ? { ckey } : {}),
    };
  };

  const OPEN_TOKEN: CursorToken = { incarnation: "open", runs: 1 };
  /** Record (once, durably) that this caller has seen the blocker open. */
  const markOpen = (okey: string): void => {
    if (cursorOf(okey) !== undefined) return;
    const owner = ownerOf(okey);
    if (owner === undefined) return;
    recordCursors(db, owner, [{ key: okey, token: OPEN_TOKEN }]);
    cursorsBy.get(owner)?.set(okey, OPEN_TOKEN);
  };

  /** The synchronous half: the current picture, from the DB and what refresh saw. */
  let tally: VerdictTally | undefined;
  const evaluate = (): Item[] => {
    const items: Item[] = [];
    const byKey = new Map<string, Item>();
    let order = 0;
    const push = (it: Item): void => {
      const prev = byKey.get(it.key);
      if (prev !== undefined) {
        prev.target ||= it.target;
        prev.suppressible &&= it.suppressible;
        return;
      }
      byKey.set(it.key, it);
      items.push(it);
    };
    const owned = ownedRefs();
    const calls = new Map<string, { call: DelegateRow; target: boolean; suppressible: boolean }>();
    const addCall = (
      c: DelegateRow | undefined,
      isTarget: boolean,
      suppressible: boolean,
    ): void => {
      if (c === undefined) return;
      const prev = calls.get(c.callId);
      calls.set(c.callId, {
        call: c,
        target: (prev?.target ?? false) || isTarget,
        suppressible: (prev?.suppressible ?? true) && suppressible,
      });
    };
    for (const r of input) {
      if (r.kind === "task") push(taskItem(r, target, true, false, order++));
      else if (r.kind === "agent") push(agentItem(track(r, true), true, order++));
      else addCall(getDelegateCall(db, r.id), true, false);
    }
    if (opts.wave !== undefined) {
      for (const c of listDelegatesOf(db, callers, opts.wave.workstream, {
        wave: opts.wave.name,
      })) {
        addCall(c, true, !all);
      }
      tally = verdictTally(db, opts.wave.workstream, opts.wave.name, callers);
    }
    for (const r of owned)
      if (r.kind === "delegate") addCall(getDelegateCall(db, r.id), false, true);
    // Every call the callers made is owed its report; the cursor hides the consumed ones.
    if (consumes) {
      for (const c of listDelegatesOf(db, callers)) {
        addCall(c, false, true);
        ownerOfKey.set(
          refKey({ kind: "delegate", workstream: c.workstream, id: c.callId }),
          c.caller,
        );
      }
    }
    for (const { call, target: isTarget, suppressible } of calls.values()) {
      push(delegateItem(call, isTarget, suppressible, order++));
    }
    if (opts.blockersOf !== undefined && umbrella !== undefined && umbrella !== null) {
      const rows = openBlockers(db, umbrella);
      let open = false;
      let readyBlocker = false;
      for (const b of rows) {
        const ref: WaitRef = { kind: "task", workstream: b.ws, id: b.id };
        const it = taskItem(ref, "CLOSED", true, !all, order++);
        const okey = urgentKey("open", it.key);
        if (!it.done) {
          open = true;
          // Seen open is durable (the caller's cursor), so a close that a `first`
          // did not return is still owed to the next wait.
          if (consumes) markOpen(okey);
          else openLocal.add(it.key);
        } else if (!all && !(consumes ? cursorOf(okey) !== undefined : openLocal.has(it.key))) {
          // First: a blocker that was never seen open is history, not news.
          it.suppressible = true;
          it.token = undefined;
          it.kind = undefined;
        } else if (it.token === undefined || !isConsumed(cursorOf(it.key), it.token)) {
          readyBlocker = true;
        }
        push(it);
      }
      if (!open && !readyBlocker) {
        const ref: WaitRef = { kind: "task", ...opts.blockersOf };
        push({
          key: `blockers:${refKey(ref)}`,
          ref,
          snap: { ref, status: "CLOSED", fired: true, dead: false },
          target: true,
          suppressible: false,
          order: order++,
          kind: "closed",
          done: true,
          ready: false,
          // A state ("nothing is left to wait on"), never news: behind every real event.
          seen: true,
        });
      }
    }
    for (const r of owned) {
      if (r.kind === "task") push(taskItem(r, target, false, true, order++));
    }
    for (const r of owned) {
      if (r.kind === "agent") push(agentItem(track(r, false), false, order++));
    }
    // Remember each task's owner, to tell a reaper flip from a release.
    for (const it of items) {
      if (it.ref.kind !== "task") continue;
      const owner = it.snap.owner ?? null;
      priorTask.set(it.key, {
        status: it.snap.status ?? "OPEN",
        owner,
        // A reaped owner's row is gone next tick: keep its id so the death token stays one.
        ownerId:
          owner === null ? 0 : taskOwnerRowId(db, it.ref) || (priorTask.get(it.key)?.ownerId ?? 0),
      });
      if (owner !== null && it.snap.ownerWorkstream !== undefined) {
        const gone = !agentExists(db, { workstream: it.snap.ownerWorkstream, id: owner });
        if (gone) reapedOwners.add(owner);
        else reapedOwners.delete(owner);
      }
    }
    const shown: Item[] = [];
    for (const it of items) {
      const consumed = it.token !== undefined && isConsumed(cursorOf(it.ckey ?? it.key), it.token);
      it.seen ||= consumed;
      const hidden = it.suppressible && consumed;
      it.hidden = hidden;
      it.ready = it.kind !== undefined && !hidden;
      const urgent = it.kind === "input" || it.kind === "stall" || it.kind === "dead";
      // An unchanged urgent observation that was returned is not news again, and
      // not "done": the ref is still owed its completion.
      if (hidden && urgent) it.done = false;
      // Consumed owned history is no longer owed: it is not part of the picture.
      if (hidden && !it.target && !urgent) continue;
      shown.push(it);
    }
    return shown;
  };

  /**
   * Hand each stall to `handleStall` (raced: the job runs beside the loop and
   * wakes it), once per stallToken. A stall stays unselectable while its job is
   * out or after a `continue`; `return` (or no handler) makes it the event.
   */
  const driveStalls = (items: Item[]): void => {
    const handler = opts.handleStall;
    for (const it of items) {
      if (it.stall === undefined || it.kind !== "stall" || it.hidden === true) continue;
      const steering = opts.onStall === "steer" || opts.onStall === "release";
      const caller = ownerOf(it.key);
      if (!steering || handler === undefined || caller === undefined) {
        it.ready = true;
        continue;
      }
      const { token, owner, ownerRef } = it.stall;
      let st = stallStates.get(token);
      if (st === undefined) {
        const own = db
          .prepare(
            `SELECT a.id, a.pane_id FROM agents a JOIN workstreams w ON w.id = a.workstream_id
              WHERE a.name = ? AND w.name = ?`,
          )
          .get(ownerRef.name, ownerRef.workstreamName) as
          | { id: number; pane_id: string }
          | undefined;
        const taskId = taskIdFor(db, it.ref.id, it.ref.workstream);
        if (own === undefined || taskId === null) {
          it.ready = true;
          continue;
        }
        const ctx: WaitStallContext = {
          caller,
          generation: begun.get(caller)?.generation ?? null,
          ref: it.ref,
          taskId,
          revision: taskRevision(db, it.ref.workstream, it.ref.id),
          owner: {
            workstream: ownerRef.workstreamName,
            name: ownerRef.name,
            agentId: owner.agentId ?? own.id,
            paneId: owner.paneId ?? own.pane_id,
            status: owner.status,
            source: owner.source ?? "none",
            since: owner.since ?? null,
            settled: false,
            ...(owner.ctl !== undefined ? { ctl: owner.ctl } : {}),
            ...(owner.incarnation !== undefined ? { incarnation: owner.incarnation } : {}),
            ...(owner.runs !== undefined ? { runs: owner.runs } : {}),
            ...(owner.pending !== undefined ? { pending: owner.pending } : {}),
            ...(owner.reason !== undefined ? { reason: owner.reason } : {}),
          },
          stallToken: token,
          deadlineMs: Number.isFinite(deadline)
            ? Math.max(0, deadline - Date.now())
            : Number.MAX_SAFE_INTEGER,
          signal: watchAbort.signal,
        };
        const fresh: { job?: Promise<void>; result?: StallActionResult } = {};
        const action = opts.onStall === "release" ? "release" : "steer";
        fresh.job = Promise.resolve()
          .then(() => handler(ctx))
          .catch(
            (e: unknown): StallActionResult => ({
              disposition: "return",
              action,
              state: "unknown",
              reason: e instanceof Error ? e.message : String(e),
            }),
          )
          .then((res) => {
            fresh.result = res;
            fresh.job = undefined;
            // The owner's next run counts from the actual send baseline.
            const t = tracks.get(
              refKey({
                kind: "agent",
                ...{ workstream: ownerRef.workstreamName, id: ownerRef.name },
              }),
            );
            if (t !== undefined && res.afterRuns !== undefined && t.latched === undefined) {
              t.baseline = res.afterRuns;
              t.wasBusy = false;
            }
            wake();
          });
        st = fresh;
        stallStates.set(token, st);
      }
      it.ready = st.job === undefined && st.result?.disposition === "return";
    }
  };

  const select = (items: Item[]): { event: Item; fired: Item[] } | undefined => {
    const rank = (a: Item, b: Item): number =>
      // Never-returned events first: an event that was already returned once (an
      // unchanged dialog, a dead pane, a stall) never outranks one that was not.
      Number(a.seen === true) - Number(b.seen === true) ||
      urgency(a.kind) - urgency(b.kind) ||
      Number(b.target) - Number(a.target) ||
      a.order - b.order;
    const ready = items.filter((i) => i.ready).sort(rank);
    if (!all) {
      const best = ready[0];
      if (best !== undefined) return { event: best, fired: [best] };
      return undefined;
    }
    const urgent = ready.find(
      (i) =>
        i.kind === "input" ||
        i.kind === "stall" ||
        (!i.target && (i.kind === "dead" || i.kind === "delegate")),
    );
    if (urgent !== undefined) return { event: urgent, fired: [urgent] };
    const targets = items.some((i) => i.target) ? items.filter((i) => i.target) : items;
    if (targets.length === 0 || !targets.every((i) => i.done)) return undefined;
    const sorted = [...targets].sort(rank);
    const best = sorted.find((i) => i.ready) ?? sorted[0];
    return best === undefined ? undefined : { event: best, fired: targets.filter((i) => i.done) };
  };

  const snapshotsOf = (items: Item[], extra: Item[] = []): WaitSnapshot[] => {
    const targets = items.filter((i) => i.target);
    const base = targets.length > 0 ? targets : items;
    const shown = [...base];
    for (const e of extra) if (!shown.includes(e)) shown.push(e);
    return shown.map((i) => i.snap);
  };

  const build = (
    kind: WaitEventKind,
    items: Item[],
    chosen?: { event: Item; fired: Item[] },
    drained = false,
  ): WaitResult => {
    const e = chosen?.event;
    for (const f of chosen?.fired ?? []) delivered.push(f);
    return {
      event: {
        kind,
        ref: e?.ref ?? null,
        ...(e?.snap.incarnation !== undefined ? { incarnation: e.snap.incarnation } : {}),
        ...(e?.snap.runs !== undefined ? { runs: e.snap.runs } : {}),
      },
      refs: snapshotsOf(items, chosen?.fired ?? []),
      timedOut: kind === "heartbeat" && !drained,
      interrupted: kind === "interrupted",
      exit: exitFor(kind),
      cursor: {},
      ...(e?.stall !== undefined && stallStates.get(e.stall.token)?.result !== undefined
        ? { action: stallStates.get(e.stall.token)?.result as StallActionResult }
        : {}),
      humanNeeds: callers.flatMap((c) => openHumanNeeds(db, c)),
      ...(tally !== undefined ? { tally } : {}),
      ...(drained ? { drained: true } : {}),
    };
  };

  const rethrow = (): void => {
    if (fatal === undefined) return;
    watchAbort.abort();
    throw fatal.error;
  };

  let result: WaitResult | undefined;
  try {
    for (;;) {
      if (stopReason === "abort") {
        result = build("interrupted", lastItems.length > 0 ? lastItems : evaluate());
        break;
      }
      if (stopReason === "deadline" || Date.now() >= deadline) {
        const items = evaluate();
        driveStalls(items);
        // The legacy waits always took one full snapshot, stuck check included,
        // before honouring the deadline: a deadline that won the race still does.
        if (opts.inspect && !inspected) {
          inspected = true;
          await opts.inspect(items.filter((i) => i.target).map((i) => i.snap));
        }
        const chosen = select(items);
        result = chosen
          ? build(chosen.event.kind ?? "closed", items, chosen)
          : build("heartbeat", items);
        break;
      }
      await refresh();
      rethrow();
      if (stopReason === "abort") continue;
      const items = evaluate();
      driveStalls(items);
      lastItems = items;
      if (opts.inspect) {
        inspected = true;
        await opts.inspect(items.filter((i) => i.target).map((i) => i.snap));
      }
      if (items.length === 0) throw new WaitNothingError();
      const chosen = select(items);
      if (chosen !== undefined) {
        result = build(chosen.event.kind ?? "closed", items, chosen);
        break;
      }
      if (!all && items.every((i) => i.done)) {
        // Everything is done and already delivered: nothing is owed.
        result = build("heartbeat", items, undefined, true);
        break;
      }
      if (stopReason !== undefined) continue;
      // Poll only what a watch does not cover: DB-backed refs, a caller's
      // registration and polled agents. All agents watched: sleep until a
      // settle, the deadline or an abort.
      const polled =
        callers.length > 0 ||
        observeOwners ||
        items.some((i) => i.ref.kind !== "agent") ||
        [...tracks.values()].some((t) => t.latched === undefined && t.handle === undefined);
      const left = deadline - Date.now();
      const ms = polled ? Math.min(pollMs, left) : left;
      if (ms <= 0) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slept = !polled
        ? new Promise<void>(() => {})
        : opts.sleep
          ? opts.sleep(ms)
          : new Promise<void>((resolve) => {
              timer = setTimeout(resolve, ms);
            });
      await Promise.race([woken, slept, stopP]);
      clearTimeout(timer);
      if (polled) pollCount += 1;
      woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      rethrow();
    }
  } finally {
    clearTimeout(deadlineTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    watchAbort.abort();
    if (consumes) {
      // A returned event is consumed (its token written); a completed one also
      // leaves the registration. An urgent one (input, stall, a dead task) stays owed.
      const completed = delivered.filter(
        (i) =>
          i.kind === "closed" ||
          i.kind === "settled" ||
          i.kind === "delegate" ||
          (i.kind === "dead" && i.ref.kind === "agent"),
      );
      // Each delivered ref is consumed by the caller that owns it, in one
      // transaction guarded by that caller's wait generation.
      let applied = true;
      db.transaction(() => {
        for (const c of callers) {
          const mine = completed.filter((i) => ownerOf(i.key) === c);
          const tokens = delivered
            .filter((i) => i.token !== undefined && ownerOf(i.ckey ?? i.key) === c)
            .flatMap((i) =>
              i.token === undefined ? [] : [{ key: i.ckey ?? i.key, token: i.token }],
            );
          const b = begun.get(c);
          if (b !== undefined) {
            const ended = endWait(
              db,
              c,
              b.generation,
              mine.map((i) => registered(i.ref)),
            );
            if (!ended.applied) {
              applied = false;
              continue;
            }
          }
          recordCursors(db, c, tokens);
        }
      }).immediate();
      if (result !== undefined) {
        result.cursor = Object.fromEntries(callers.flatMap((c) => [...readCursors(db, c)]));
        if (!applied) result.superseded = true;
      }
    } else if (result !== undefined) result.cursor = {};
    if (opts.sync !== false) await ambientFlush(db, { quiet: true });
  }
  return result as WaitResult;
}

export * from "./wait-types.js";
