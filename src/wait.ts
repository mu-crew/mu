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
// dialog, an owned delegate report) ends it early without counting toward
// "all". Priority: dead, input, delegate, then closed/settled; targets
// before owned refs.
//
// Delivery. Only the DELIVERED refs are written: their typed cursor tokens
// (src/wait-cursor.ts) and their removal from the registration, in ONE
// short transaction guarded by the registration's generation (endWait). A
// sibling that `first` did not return stays owed, an owned event already
// delivered is never delivered again, and a timeout or interrupt delivers
// nothing. Explicit refs ignore the cursor (waiting on a closed task returns
// at once); owned refs obey it.
//
// CLOSE. A settled pi run's CLOSE block is applied once (applySettledClose)
// before the snapshot returns. The close-block refuses delegate and human
// tasks, so a delegate answer never closes its own task ahead of
// finishDelegate's recorder.
//
// Not here: stall actions (steer, release; slice C of v_wait_core), the CLI
// and signal wiring, arming from spawn/send/claim (v_wait_cli). The `stall`
// event kind is reserved for them; this engine never emits it, and the
// legacy `stuck` warning stays in tasks/wait.ts behind the `inspect` hook.

import { agentKey } from "./agent-state.js";
import { AgentNotFoundError, AgentRestartedError } from "./agents/errors.js";
import type { Db } from "./db.js";
import {
  DelegateNotFoundError,
  type DelegateRow,
  getDelegateCall,
  listDelegates,
  TERMINAL_DELEGATE_STATES,
  type VerdictTally,
  verdictTally,
} from "./delegates.js";
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
import { agentExists, closeSettledRun, openBlockers } from "./wait-db.js";
import { compileTextMatcher, type TextMatcher } from "./wait-regex.js";
import {
  beginWait,
  endWait,
  type RegisteredRef,
  readWaitRegistration,
} from "./wait-registration.js";
import {
  type AgentReading,
  type AgentWatchHandle,
  type CloseOutcome,
  WAIT_HEARTBEAT_CAP_MS,
  type WaitEventKind,
  WaitNothingError,
  type WaitOptions,
  type WaitRef,
  WaitRefError,
  type WaitResult,
  type WaitSnapshot,
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
  /** Completed: closed, settled, delegate terminal, dead. */
  done: boolean;
  ready: boolean;
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
}

const refKey = (r: Pick<WaitRef, "kind" | "workstream" | "id">): string =>
  cursorKey(r.kind, r.workstream, r.id);
const registered = (r: WaitRef): RegisteredRef => ({
  kind: r.kind,
  workstream: r.workstream,
  id: r.id,
});
const URGENCY: Partial<Record<WaitEventKind, number>> = { dead: 0, input: 1, delegate: 2 };
const urgency = (k: WaitEventKind | undefined): number => (k === undefined ? 9 : (URGENCY[k] ?? 3));
const exitFor = (k: WaitEventKind): WaitResult["exit"] =>
  k === "dead" ? 6 : k === "input" || k === "stall" ? 7 : k === "interrupted" ? 130 : 0;

/** Wait for the next owned event (or all targets). See the file comment. */
export async function waitForEvents(
  db: Db,
  input: readonly WaitRef[],
  opts: WaitOptions = {},
): Promise<WaitResult> {
  const { caller } = opts;
  const all = opts.all === true;
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
      if (caller !== undefined && call.caller !== caller) {
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
  if (input.length === 0 && !opts.wave && !opts.blockersOf && caller === undefined) {
    throw new WaitNothingError();
  }

  // ─── one active wait per caller; cursors read before any await ────
  const begun = caller === undefined ? undefined : beginWait(db, caller);
  const cursors = caller === undefined ? new Map<string, CursorToken>() : readCursors(db, caller);

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
  const openSeen = new Set<string>();
  const priorTask = new Map<string, { status: string; owner: string | null }>();
  const reapedOwners = new Set<string>();
  let lastItems: Item[] = [];
  let firstRefresh = true;
  const delivered: Item[] = [];

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
          const cur = cursors.get(refKey(t.ref));
          return watch(
            { ...t.ref, ...(t.baseline !== undefined ? { afterRuns: t.baseline } : {}) },
            watchAbort.signal,
            { owed: !t.explicit, ...(cur !== undefined ? { cursor: cur } : {}) },
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
      isConsumed(cursors.get(refKey(t.ref)), { incarnation: r.incarnation ?? "", runs: r.runs });
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
  const advance = (t: AgentTrack, r: AgentReading, fromWatch: boolean): void => {
    if (t.latched !== undefined) return;
    const pinned = t.ref.incarnation;
    if (pinned !== undefined && r.incarnation !== undefined && r.incarnation !== pinned) {
      throw new AgentRestartedError(t.ref.id, t.ref.workstream, pinned, r.incarnation);
    }
    if (r.status === null) {
      t.latched = { kind: "dead", reading: r };
    } else if (r.blocked !== undefined) {
      t.latched = { kind: "input", reading: r };
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
    const reg = caller === undefined ? undefined : readWaitRegistration(db, caller);
    for (const r of explicit.values()) if (r.kind === "agent") track(r, true);
    for (const r of reg?.refs ?? [])
      if (r.kind === "agent") track({ ...r }, explicit.has(refKey(r)));
    await setupWatches();
    if (stopReason !== undefined) return;
    // Owners of watched in-progress tasks ride on the same batched read.
    const reads = new Map<string, WaitRef>();
    for (const t of tracks.values()) {
      if (t.latched === undefined && t.handle === undefined) reads.set(refKey(t.ref), t.ref);
    }
    if (caller !== undefined) {
      const taskRefs = [...explicit.values(), ...(reg?.refs ?? [])].filter(
        (r) => r.kind === "task",
      );
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
            caller !== undefined && !agentExists(db, ref)
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
      ...(r?.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
      ...(r?.runs !== undefined ? { runs: r.runs } : {}),
      ...(r?.lastText !== undefined ? { lastText: r.lastText } : {}),
      ...(r?.lastError !== undefined ? { lastError: r.lastError } : {}),
      ...(r?.sessionFile !== undefined ? { sessionFile: r.sessionFile } : {}),
      ...(r?.blocked !== undefined ? { blocked: r.blocked } : {}),
      ...(status === "unknown" && r?.reason !== undefined ? { unknownReason: r.reason } : {}),
      ...(t.baseline !== undefined ? { afterRuns: t.baseline } : {}),
      wasBusy: t.wasBusy,
      fired: t.latched?.kind === "settled",
      dead: t.latched?.kind === "dead",
      ...(t.close !== undefined ? { close: t.close } : {}),
    };
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
    if (caller !== undefined && want === "CLOSED" && status !== "CLOSED") {
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
    return {
      key: refKey(t.ref),
      ref: t.ref,
      snap: agentSnapshot(t),
      target: isTarget,
      suppressible: !t.explicit,
      order,
      done: l?.kind === "settled" || l?.kind === "dead",
      ready: false,
      ...(l !== undefined ? { kind: l.kind } : {}),
      ...(l?.kind === "settled" && r?.runs !== undefined
        ? { token: { incarnation: r.incarnation ?? "", runs: r.runs } }
        : {}),
    };
  };

  /** The synchronous half: the current picture, from the DB and what refresh saw. */
  let wave: VerdictTally | undefined;
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
    const reg = caller === undefined ? undefined : readWaitRegistration(db, caller);
    const owned = (reg?.refs ?? []).map((r) => ({ ...r }) as WaitRef);
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
      for (const c of listDelegates(db, caller, opts.wave.workstream, { wave: opts.wave.name })) {
        addCall(c, true, !all);
      }
      wave = verdictTally(db, opts.wave.workstream, opts.wave.name, caller);
    }
    for (const r of owned)
      if (r.kind === "delegate") addCall(getDelegateCall(db, r.id), false, true);
    // Every call this caller made is owed its report; the cursor hides the consumed ones.
    if (caller !== undefined) for (const c of listDelegates(db, caller)) addCall(c, false, true);
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
        if (!it.done) {
          open = true;
          openSeen.add(it.key);
        } else if (!all && !openSeen.has(it.key)) {
          // First: a blocker that was never seen open is history, not news.
          it.suppressible = true;
          it.token = undefined;
          it.kind = undefined;
        } else readyBlocker = true;
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
      priorTask.set(it.key, { status: it.snap.status ?? "OPEN", owner });
      if (owner !== null && it.snap.ownerWorkstream !== undefined) {
        const gone = !agentExists(db, { workstream: it.snap.ownerWorkstream, id: owner });
        if (gone) reapedOwners.add(owner);
        else reapedOwners.delete(owner);
      }
    }
    const shown: Item[] = [];
    for (const it of items) {
      const hidden =
        it.suppressible && it.token !== undefined && isConsumed(cursors.get(it.key), it.token);
      it.ready = it.kind !== undefined && !hidden;
      // Consumed owned history is no longer owed: it is not part of the picture.
      if (hidden && !it.target) continue;
      shown.push(it);
    }
    return shown;
  };

  const select = (items: Item[]): { event: Item; fired: Item[] } | undefined => {
    const rank = (a: Item, b: Item): number =>
      urgency(a.kind) - urgency(b.kind) || Number(b.target) - Number(a.target) || a.order - b.order;
    const ready = items.filter((i) => i.ready).sort(rank);
    if (!all) {
      const best = ready[0];
      if (best !== undefined) return { event: best, fired: [best] };
      return undefined;
    }
    const urgent = ready.find(
      (i) => i.kind === "input" || (!i.target && (i.kind === "dead" || i.kind === "delegate")),
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
      ...(wave !== undefined ? { wave } : {}),
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
      lastItems = items;
      if (opts.inspect) await opts.inspect(items.filter((i) => i.target).map((i) => i.snap));
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
        caller !== undefined ||
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
    if (caller !== undefined) {
      const mine = delivered; // only an event pushes here: a timeout or interrupt delivers nothing
      const completed = mine.filter(
        (i) =>
          i.kind === "closed" ||
          i.kind === "settled" ||
          i.kind === "delegate" ||
          (i.kind === "dead" && i.ref.kind === "agent"),
      );
      const tokens = completed.flatMap((i) =>
        i.token === undefined ? [] : [{ key: i.key, token: i.token }],
      );
      let applied = true;
      db.transaction(() => {
        if (begun !== undefined) {
          applied = endWait(
            db,
            caller,
            begun.generation,
            completed.map((i) => registered(i.ref)),
          ).applied;
        }
        if (applied) recordCursors(db, caller, tokens);
      }).immediate();
      if (result !== undefined) {
        result.cursor = Object.fromEntries(readCursors(db, caller));
        if (!applied) result.superseded = true;
      }
    }
    if (opts.sync !== false) await ambientFlush(db, { quiet: true });
  }
  return result as WaitResult;
}

export * from "./wait-types.js";
