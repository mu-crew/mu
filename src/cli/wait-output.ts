// mu — the one JSON result of `mu wait` (and its `task wait` alias): the typed
// ref spelling, the snapshot records, the per-wave tally line, the resume
// command, and the wait-specific bound.
//
// Pure: no DB, no I/O. cmdWait (src/cli/wait.ts) builds a WaitResult and hands
// it here. The shape is the README's: `firing` (alias `event`), `exit`,
// `timedOut`, `snapshots`, `cursor`, `resume`.

import type { VerdictTally } from "../delegates.js";
import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../output-contract.js";
import { shellWord } from "../shell-quote.js";
import type { WaitEvent, WaitRef, WaitResult, WaitSnapshot } from "../wait-types.js";

/** `task:<ws>/<id>`, `agent:<ws>/<name>`, `delegate:<call id>`: a ref a later `mu wait` can take as is. */
export function refString(ref: WaitRef): string {
  return ref.kind === "delegate" ? `delegate:${ref.id}` : `${ref.kind}:${ref.workstream}/${ref.id}`;
}

/** One ref of a resume command: typed, qualified, shell-quoted; an agent keeps its run baseline. */
function resumeRef(ref: WaitRef, afterRuns: number | undefined): string {
  const base = refString(ref);
  const runs = ref.kind === "agent" && afterRuns !== undefined ? `@${afterRuns}` : "";
  const inc = ref.kind === "agent" && ref.incarnation !== undefined ? `#${ref.incarnation}` : "";
  return shellWord(`${base}${runs}${inc}`);
}

/** What a `mu wait` call asked for, kept so its resume command repeats every condition. */
export interface WaitConditions {
  /** The verb a resume runs (`mu wait`). */
  mode: "first" | "all";
  scope?: string;
  status?: string;
  untilText?: string;
  stuckAfter?: number;
  onStall?: string;
  wave?: string;
  blockersOf?: string;
  /** Seconds the caller asked for; absent = the default. */
  timeout?: number;
}

/** At most this many refs are spelled in a resume; the rest are owed implicitly. */
const RESUME_REFS_MAX = 24;

/**
 * The command that continues this wait: every condition repeated with its real
 * value, the refs still owed typed and qualified, POSIX-quoted. A real event
 * leaves out what it delivered; a timeout or an interrupt delivered nothing,
 * so every watched ref is named.
 */
export function resumeCommand(
  result: WaitResult,
  conditions: WaitConditions,
  explicit: readonly WaitRef[],
): string {
  const delivered = (s: WaitSnapshot): boolean => {
    if (result.event.kind === "heartbeat" || result.event.kind === "interrupted") return false;
    if (conditions.mode === "all") return s.fired;
    const e = result.event.ref;
    return (
      e !== null && e.kind === s.ref.kind && e.workstream === s.ref.workstream && e.id === s.ref.id
    );
  };
  const seen = new Set<string>();
  const refs: string[] = [];
  const add = (ref: WaitRef, runs: number | undefined): void => {
    const key = refString(ref);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(resumeRef(ref, runs));
  };
  for (const s of result.refs) {
    if (delivered(s)) continue;
    add(s.ref, s.afterRuns ?? s.ref.afterRuns);
  }
  for (const r of explicit) {
    const snap = result.refs.find((s) => refString(s.ref) === refString(r));
    if (snap !== undefined && delivered(snap)) continue;
    add(r, r.afterRuns);
  }
  const shown = refs.slice(0, RESUME_REFS_MAX);
  const parts = ["mu wait", ...shown];
  if (conditions.mode === "all") parts.push("--all");
  if (conditions.scope !== undefined) parts.push("-w", shellWord(conditions.scope));
  if (conditions.status !== undefined) parts.push("--status", shellWord(conditions.status));
  if (conditions.untilText !== undefined)
    parts.push("--until-text", shellWord(conditions.untilText));
  if (conditions.stuckAfter !== undefined)
    parts.push("--stuck-after", String(conditions.stuckAfter));
  if (conditions.onStall !== undefined && conditions.onStall !== "exit") {
    parts.push("--on-stall", conditions.onStall);
  }
  if (conditions.wave !== undefined) parts.push("--wave", shellWord(conditions.wave));
  if (conditions.blockersOf !== undefined)
    parts.push("--blockers-of", shellWord(conditions.blockersOf));
  if (conditions.timeout !== undefined) parts.push("--timeout", String(conditions.timeout));
  return parts.join(" ");
}

/** `6/12 CONFIRMED, 2 REFUTED, 1 UNVERIFIED, 3 pending`: the wave in one line. */
export function tallySummary(t: VerdictTally): string {
  const sum = (k: "confirmed" | "refuted" | "unverified" | "pending"): number =>
    t.findings.reduce((n, f) => n + f[k], 0);
  const confirmed = sum("confirmed");
  const refuted = sum("refuted");
  const unverified = sum("unverified");
  const pending = sum("pending");
  const total = confirmed + refuted + unverified + pending;
  const bits = [`${confirmed}/${total} CONFIRMED`];
  if (refuted > 0) bits.push(`${refuted} REFUTED`);
  if (unverified > 0) bits.push(`${unverified} UNVERIFIED`);
  if (pending > 0) bits.push(`${pending} pending`);
  if (t.refused.length > 0) bits.push(`${t.refused.length} refused`);
  return bits.join(", ");
}

/** A snapshot as one flat record: id and status first, so a reader finds them together. */
export function snapshotRecord(s: WaitSnapshot, textCap: number): Record<string, unknown> {
  // A delegate's ref already is its (global) call id: no second copy of it, no workstream.
  const out: Record<string, unknown> =
    s.ref.kind === "delegate"
      ? { kind: s.ref.kind, ref: refString(s.ref), status: s.status }
      : {
          kind: s.ref.kind,
          ref: refString(s.ref),
          id: s.ref.id,
          workstream: s.ref.workstream,
          status: s.status,
        };
  const put = (k: string, v: unknown): void => {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  };
  put("substate", s.substate);
  put("owner", s.owner);
  put("ownerWorkstream", s.ownerWorkstream);
  out.fired = s.fired;
  out.dead = s.dead;
  if (s.stuck === true) {
    out.stuck = true;
    put("stuckWhy", s.stuckWhy);
    put("stuckSecs", s.stuckSecs);
    put("ownerRuns", s.ownerRuns);
  }
  put("verdict", s.verdict);
  put("callTask", s.callTask);
  put("record", s.record);
  put("wave", s.wave);
  put("incarnation", s.incarnation);
  put("runs", s.runs);
  put("afterRuns", s.afterRuns);
  if (s.settled !== undefined) out.settled = s.settled;
  if (s.close !== undefined) out.close = s.close;
  if (s.blocked !== undefined) {
    out.blocked = {
      kind: s.blocked.kind,
      ...(s.blocked.title !== undefined ? { title: s.blocked.title } : {}),
    };
  }
  put("unknownReason", s.unknownReason);
  if (s.unknownBaseline === true) out.unknownBaseline = true;
  put("lastError", s.lastError);
  put("sessionFile", s.sessionFile);
  put("textSource", s.textSource);
  if (s.lastText !== undefined && s.lastText !== "") {
    // The tail is what matters: a CLOSE block and its report end the message.
    if (textCap > 0 && s.lastText.length > textCap) {
      out.lastText = s.lastText.slice(-textCap);
      out.lastTextCut = s.lastText.length - textCap;
    } else if (textCap > 0) {
      out.lastText = s.lastText;
    } else {
      out.lastTextCut = s.lastText.length;
    }
  }
  return out;
}

/** The event as the README names it: kind, typed ref, incarnation, runs. */
export function eventRecord(e: WaitEvent): Record<string, unknown> {
  return {
    kind: e.kind,
    ref: e.ref === null ? null : refString(e.ref),
    ...(e.incarnation !== undefined ? { incarnation: e.incarnation } : {}),
    ...(e.runs !== undefined ? { runs: e.runs } : {}),
  };
}

export interface WaitDataInput {
  result: WaitResult;
  /** The exit the process returns (a signal exit replaces the engine's 130). */
  exit: number;
  conditions: WaitConditions;
  explicit: readonly WaitRef[];
  signal?: string;
  /** The words for a non-routine event: why it ended the wait. */
  reason?: string;
  /** Legacy hints (`nextSteps`) the verb still carries. */
  nextSteps?: readonly { intent: string; command: string }[];
  warning?: string;
}

/**
 * The result document, bounded to RESULT_BYTES. The firing event, exit,
 * timedOut, interrupted, resume and open count are never cut. What is cut, in
 * order: each snapshot's `lastText` (tail kept), the tally's per-finding rows,
 * the cursor to the refs shown, then the least important snapshots; every cut
 * says how many it took and `retrieve` names how to read the rest.
 */
export function waitData(input: WaitDataInput): Record<string, unknown> {
  const { result, exit, conditions, explicit } = input;
  const event = eventRecord(result.event);
  const fired = (s: WaitSnapshot): boolean => {
    const e = result.event.ref;
    return e !== null && refString(e) === refString(s.ref);
  };
  // Importance: the firing ref, then what is still open, then the rest.
  const ordered = [...result.refs].sort(
    (a, b) =>
      Number(fired(b)) - Number(fired(a)) || Number(a.fired || a.dead) - Number(b.fired || b.dead),
  );
  const open = result.refs.filter((s) => !s.fired && !s.dead).length;
  const resume = resumeCommand(result, conditions, explicit);
  const tallyFull =
    result.tally === undefined
      ? undefined
      : { summary: tallySummary(result.tally), ...result.tally };
  const build = (
    textCap: number,
    shown: number,
    withFindings: boolean,
  ): Record<string, unknown> => {
    const snaps = ordered.slice(0, shown);
    const keys = new Set(snaps.map((s) => `${s.ref.kind}:${s.ref.workstream}/${s.ref.id}`));
    const cursor = Object.fromEntries(
      Object.entries(result.cursor).filter(([k]) => {
        // cursor keys are `<kind>:<ws>/<id>` (an urgent one `input|<kind>:<ws>/<id>`): keep a ref we show.
        const bar = k.indexOf("|");
        return keys.has(bar === -1 ? k : k.slice(bar + 1));
      }),
    );
    const cut = ordered.length - snaps.length;
    const cursorCut = Object.keys(result.cursor).length - Object.keys(cursor).length;
    return {
      firing: event,
      event,
      exit,
      timedOut: result.timedOut,
      interrupted: result.interrupted,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      open,
      snapshots: snaps.map((s) => snapshotRecord(s, textCap)),
      ...(cut > 0
        ? {
            snapshotsCut: cut,
            retrieve: "mu task show <id> -w <ws> | mu agent read <name> -w <ws>; or resume",
          }
        : {}),
      ...(tallyFull === undefined
        ? {}
        : withFindings
          ? { tally: tallyFull }
          : {
              tally: {
                summary: tallyFull.summary,
                queued: tallyFull.queued,
                running: tallyFull.running,
                refused: tallyFull.refused,
                findingsCut: tallyFull.findings.length,
              },
            }),
      ...(result.humanNeeds.length > 0 ? { humanNeeds: result.humanNeeds } : {}),
      cursor,
      ...(cursorCut > 0 ? { cursorCut } : {}),
      resume,
      ...(result.drained === true ? { drained: true } : {}),
      ...(result.superseded === true ? { superseded: true } : {}),
      ...(result.action !== undefined ? { action: result.action } : {}),
      ...(input.nextSteps !== undefined && input.nextSteps.length > 0
        ? { nextSteps: input.nextSteps }
        : {}),
      ...(input.warning !== undefined ? { warning: input.warning } : {}),
    };
  };
  const fits = (d: Record<string, unknown>): boolean =>
    Buffer.byteLength(encodeEnvelope(okEnvelope(d))) <= RESULT_BYTES;
  const n = ordered.length;
  // What shrinks first: the texts, then the least important snapshots (the tally's findings
  // are what a wave is read for), and only then the findings themselves.
  for (const cap of [1500, 800, 300, 120, 0]) {
    const d = build(cap, n, true);
    if (fits(d)) return d;
  }
  for (let shown = n - 1; shown >= 1; shown--) {
    const d = build(0, shown, true);
    if (fits(d)) return d;
  }
  for (const cap of [300, 120, 0]) {
    const d = build(cap, n, false);
    if (fits(d)) return d;
  }
  for (let shown = n - 1; shown >= 1; shown--) {
    const d = build(0, shown, false);
    if (fits(d)) return d;
  }
  return build(0, Math.min(1, n), false);
}
