// mu — the one JSON result of `mu wait` (and its `task wait` alias): the typed
// ref spelling, the snapshot records, the per-wave tally line, the resume
// command, and the wait-specific bound.
//
// Pure: no DB, no I/O. cmdWait (src/cli/wait.ts) builds a WaitResult and hands
// it here. The shape (docs/VOCABULARY.md, "wait event"): `firing` (alias `event`), `exit`,
// `timedOut`, `snapshots`, `cursor`, `resume` (the stored handle, see
// src/wait-resume.ts; null with `resumeWhy` when nothing is left to wait for).

import type { VerdictTally } from "../delegates.js";
import type { HumanNeeded } from "../human-needed.js";
import { renderArgv, resumeArgv } from "../next-hints.js";
import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../output-contract.js";
import type { WaitEvent, WaitRef, WaitResult, WaitSnapshot } from "../wait-types.js";
import { pageRecords } from "./tasks/records.js";

/** `task:<ws>/<id>`, `agent:<ws>/<name>`, `delegate:<call id>`: a ref a later `mu wait` can take as is. */
export function refString(ref: WaitRef): string {
  return ref.kind === "delegate" ? `delegate:${ref.id}` : `${ref.kind}:${ref.workstream}/${ref.id}`;
}

/**
 * The explicit refs a resume must still wait on, each with the run baseline and pi
 * incarnation it was last SEEN at (the observed one wins over the ref as typed, so a
 * pi that restarted meanwhile is refused on resume, never miscounted). A real event
 * leaves out what it delivered; a timeout or an interrupt delivered nothing, so every
 * ref stays. Refs the wait discovered itself (a caller's owned work, a wave, the
 * blockers) are not listed: the stored callers and filters find them again. Never
 * truncated: they live in the stored handle, not in the printed line.
 */
export function owedRefs(result: WaitResult, explicit: readonly WaitRef[]): WaitRef[] {
  // What the engine handed over as completed: an input or stall is never delivered, and an
  // early urgent return of --all names only itself (a closed target stays owed).
  const delivered = new Set(result.delivered.map(refString));
  const seen = new Set<string>();
  const out: WaitRef[] = [];
  for (const ref of explicit) {
    const key = refString(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = result.refs.find((s) => refString(s.ref) === key);
    if (delivered.has(key)) continue;
    if (ref.kind !== "agent") {
      out.push({ kind: ref.kind, workstream: ref.workstream, id: ref.id });
      continue;
    }
    const runs = snap?.afterRuns ?? ref.afterRuns;
    const inc = snap?.incarnation ?? ref.incarnation;
    out.push({
      kind: "agent",
      workstream: ref.workstream,
      id: ref.id,
      ...(runs !== undefined ? { afterRuns: runs } : {}),
      ...(inc !== undefined ? { incarnation: inc } : {}),
    });
  }
  return out;
}

/** The one-line resume a result prints: the stored handle (the condition set lives in `wait_resumes`). */
export function resumeCommand(id: string, scope: string | undefined): string {
  return renderArgv(resumeArgv(id, scope));
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
  if (s.exit !== undefined) out.exit = s.exit;
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

/** The event record (docs/VOCABULARY.md, "wait event"): kind, typed ref, incarnation, runs. */
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
  /** The one-line handle (`mu wait --resume <id>`), or null when nothing is left to wait for. */
  resume: string | null;
  /** Why `resume` is null. */
  resumeWhy?: string;
  signal?: string;
  /** One-line notices beside `next` (`noticesField`: a course check due). Never cut. */
  notices?: string[];
  /** The words for a non-routine event: why it ended the wait. */
  reason?: string;
  warning?: string;
  /**
   * Fields the verb that entered the wait adds (`sent` for `send --wait`, `claimed` for
   * `claim --and-wait`: the producer's receipt). Small by contract; they count against the
   * bound and are never cut.
   */
  extra?: Record<string, unknown>;
}

/** What one shrink step keeps. */
interface Shape {
  /** Each snapshot's `lastText` is clipped to this many characters (0 = dropped). */
  text: number;
  humanNeeds: number;
  /** Each human need's reason is clipped to NEED_CHARS. */
  clipNeeds: boolean;
  /** The wave's per-finding rows in full. */
  findings: boolean;
}

/** A human need's reason is clipped to this once the result is shrinking. */
const NEED_CHARS = 200;
/** The tally keeps this many refused names once its rows are cut. */
const REFUSED_KEPT = 3;

/**
 * The result document, bounded to RESULT_BYTES on its FINAL bytes (envelope, `next`,
 * `humanNeeds` and `resume` included; the measure of the shared pager,
 * src/cli/page-records.ts). The firing event, exit, timedOut, interrupted, resume and
 * the open count are never cut. What is cut, in order: each snapshot's `lastText` (tail
 * kept), the human needs, the tally's per-finding rows, then the least
 * important snapshots (`pageRecords`); every cut says how many it took, and `retrieve`
 * names how to read the rest.
 */
export function waitData(input: WaitDataInput): Record<string, unknown> {
  const { result, exit } = input;
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
  const tallyFull =
    result.tally === undefined
      ? undefined
      : { summary: tallySummary(result.tally), ...result.tally };
  const needs: readonly HumanNeeded[] = result.humanNeeds;
  const build = (shape: Shape, shown: number): Record<string, unknown> => {
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
    const keptNeeds = needs
      .slice(0, shape.humanNeeds)
      .map((n) =>
        !shape.clipNeeds || n.reason.length <= NEED_CHARS
          ? n
          : { ...n, reason: `${n.reason.slice(0, NEED_CHARS)}…` },
      );
    return {
      firing: event,
      event,
      exit,
      timedOut: result.timedOut,
      interrupted: result.interrupted,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      open,
      snapshots: snaps.map((s) => snapshotRecord(s, shape.text)),
      ...(cut > 0
        ? {
            snapshotsCut: cut,
            retrieve: "mu task show <id> -w <ws> | mu agent read <name> -w <ws>; or resume",
          }
        : {}),
      ...(tallyFull === undefined
        ? {}
        : shape.findings
          ? { tally: tallyFull }
          : {
              tally: {
                summary: tallyFull.summary,
                queued: tallyFull.queued,
                running: tallyFull.running,
                refused: tallyFull.refused.slice(0, REFUSED_KEPT),
                ...(tallyFull.refused.length > REFUSED_KEPT
                  ? { refusedCut: tallyFull.refused.length - REFUSED_KEPT }
                  : {}),
                findingsCut: tallyFull.findings.length,
              },
            }),
      ...(keptNeeds.length > 0 ? { humanNeeds: keptNeeds } : {}),
      ...(needs.length > keptNeeds.length
        ? { humanNeedsCut: needs.length - keptNeeds.length }
        : {}),
      cursor,
      ...(cursorCut > 0 ? { cursorCut } : {}),
      resume: input.resume,
      ...(input.resumeWhy !== undefined ? { resumeWhy: input.resumeWhy } : {}),
      ...(result.drained === true ? { drained: true } : {}),
      ...(result.superseded === true ? { superseded: true } : {}),
      ...(result.action !== undefined ? { action: result.action } : {}),
      ...(input.warning !== undefined ? { warning: input.warning } : {}),
      ...(input.notices !== undefined && input.notices.length > 0
        ? { notices: input.notices }
        : {}),
      ...(input.extra ?? {}),
    };
  };
  const fits = (d: Record<string, unknown>): boolean =>
    Buffer.byteLength(encodeEnvelope(okEnvelope(d))) <= RESULT_BYTES;
  const every = Number.POSITIVE_INFINITY;
  // The texts shrink first (a CLOSE block and its report end a message, so the tail stays).
  for (const text of [1500, 800, 300, 120, 0]) {
    const d = build({ text, humanNeeds: every, clipNeeds: false, findings: true }, ordered.length);
    if (fits(d)) return d;
  }
  // Then the hints; the snapshots are paged on final bytes, the findings kept while they can be.
  for (const findings of [true, false]) {
    const shape: Shape = { text: 0, humanNeeds: 3, clipNeeds: true, findings };
    const page = pageRecords(
      ordered,
      (p) => Buffer.byteLength(encodeEnvelope(okEnvelope(build(shape, p.shown.length)))),
      RESULT_BYTES,
      1,
    );
    const d = build(shape, page.shown.length);
    if (fits(d)) return d;
  }
  return build(
    { text: 0, humanNeeds: 1, clipNeeds: true, findings: false },
    Math.min(1, ordered.length),
  );
}
