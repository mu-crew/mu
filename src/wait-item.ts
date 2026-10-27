// mu — the wait loop's items: what one watched ref can deliver now (`Item`), and the pure helpers
// that build and rank items and snapshots without the loop's state. Moved out of src/wait.ts
// (the loop itself) under the file cap; see that file's comment for the semantics.

import { type DelegateRow, TERMINAL_DELEGATE_STATES } from "./delegates.js";
import { type CursorToken, cursorKey, DELEGATE_TOKEN } from "./wait-cursor.js";
import type { AgentTrack } from "./wait-latch.js";
import type { RegisteredRef } from "./wait-registration.js";
import type {
  AgentReading,
  CloseOutcome,
  StallActionResult,
  WaitEventKind,
  WaitRef,
  WaitSnapshot,
} from "./wait-types.js";

export interface Item {
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
  /**
   * Who died, on a `dead` item: the registry row (0 when it is gone and unknown) and, when known,
   * its name and workstream. A task's is its owner's; an agent ref's is its own.
   */
  death?: { rowId: number; name?: string; workstream?: string };
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
    /** How long the owner had been stalled when seen (the snapshot's `stuckSecs`). */
    ageSecs: number;
    /** The owner's settled run was refused its CLOSE (a malformed block): the snapshot's `close`. */
    close?: CloseOutcome;
  };
}

/** One handled stall: the job, its result, and what to report if the handler removed the condition. */
export interface StallState {
  job?: Promise<void>;
  result?: StallActionResult;
  carry?: { key: string; stall: Item["stall"] };
}

export const refKey = (r: Pick<WaitRef, "kind" | "workstream" | "id">): string =>
  cursorKey(r.kind, r.workstream, r.id);
export const registered = (r: WaitRef): RegisteredRef => ({
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
export const urgency = (k: WaitEventKind | undefined): number =>
  k === undefined ? 9 : (URGENCY[k] ?? 4);
/** A delivered item that finishes its ref (urgent input, stall and a dead task stay owed). */
export const isCompletion = (i: Item): boolean =>
  i.kind === "closed" ||
  i.kind === "settled" ||
  i.kind === "pane-text" ||
  i.kind === "exited" ||
  i.kind === "delegate" ||
  (i.kind === "dead" && i.ref.kind === "agent");
export const exitFor = (k: WaitEventKind): number =>
  k === "dead" ? 6 : k === "input" || k === "stall" ? 7 : k === "interrupted" ? 130 : 0;

export const inputToken = (r: AgentReading): CursorToken => ({
  incarnation: `input:${r.incarnation ?? ""}`,
  runs: r.blocked?.since ?? 0,
});

export const agentSnapshot = (t: AgentTrack): WaitSnapshot => {
  const r = t.latched?.reading ?? t.reading;
  const status =
    t.latched?.kind === "dead" || t.latched?.kind === "exited" ? null : (r?.status ?? "unknown");
  return {
    ref: t.ref,
    status,
    ...(r?.agentId !== undefined ? { agentId: r.agentId } : {}),
    ...(r?.paneId !== undefined ? { paneId: r.paneId } : {}),
    ...(r?.settled !== undefined ? { settled: r.settled } : {}),
    ...(r?.lastTextTruncated !== undefined ? { lastTextTruncated: r.lastTextTruncated } : {}),
    ...(r?.textSource !== undefined ? { textSource: r.textSource } : {}),
    ...(r?.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
    ...(r?.runs !== undefined ? { runs: r.runs } : {}),
    ...(r?.lastText !== undefined ? { lastText: r.lastText } : {}),
    ...(r?.lastError !== undefined ? { lastError: r.lastError } : {}),
    ...(r?.sessionFile !== undefined ? { sessionFile: r.sessionFile } : {}),
    ...(r?.blocked !== undefined ? { blocked: r.blocked } : {}),
    ...(t.latched?.kind === "exited" && r?.exit !== undefined ? { exit: r.exit } : {}),
    ...(status === "unknown" && r?.reason !== undefined ? { unknownReason: r.reason } : {}),
    ...(t.baseline !== undefined ? { afterRuns: t.baseline } : {}),
    wasBusy: t.wasBusy,
    ...(t.unknownBaseline ? { unknownBaseline: true } : {}),
    fired:
      t.latched?.kind === "settled" ||
      t.latched?.kind === "pane-text" ||
      t.latched?.kind === "exited",
    dead: t.latched?.kind === "dead",
    ...(t.close !== undefined ? { close: t.close } : {}),
  };
};

export const delegateItem = (
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
      // Which finding this is: the delegate's own task, the task it judges, its wave.
      callTask: call.task,
      ...(call.record !== null ? { record: `${call.record.workstream}/${call.record.task}` } : {}),
      ...(call.wave !== null ? { wave: call.wave } : {}),
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

/**
 * One death, one event: a dead task and a dead agent ref name the same death when the agent is the
 * task's owner that died. The same registry row; or, the agent's row being gone (reaped), the
 * owner the task names by name (and workstream, when the task knows it). A respawn under the name
 * is another row: its death is its own.
 */
export const sameDeath = (a: Item, b: Item): boolean => {
  const task = a.ref.kind === "task" ? a : b;
  const agent = task === a ? b : a;
  const t = task.death;
  const g = agent.death;
  if (a.kind !== "dead" || b.kind !== "dead" || t === undefined || g === undefined) return false;
  if (task.ref.kind !== "task" || agent.ref.kind !== "agent") return false;
  if (g.rowId !== 0) return g.rowId === t.rowId;
  return (
    t.name === agent.ref.id && (t.workstream === undefined || t.workstream === agent.ref.workstream)
  );
};

export const failedGate = (i: Item): boolean =>
  i.kind === "exited" && i.snap.exit !== undefined && i.snap.exit !== 0;

export const snapshotsOf = (items: Item[], extra: Item[] = []): WaitSnapshot[] => {
  const targets = items.filter((i) => i.target);
  const base = targets.length > 0 ? targets : items;
  const shown = [...base];
  for (const e of extra) if (!shown.includes(e)) shown.push(e);
  return shown.map((i) => i.snap);
};
