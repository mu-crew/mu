// mu — the FOLD: what the ops log says a portable row is.
//
// One pure function per kind of row, from the ops of ONE natural key (plus
// the tombstone horizon that covers it) to the row's state. Nothing here
// touches a database. Both write paths call these through src/apply.ts:
// `mu rebuild` folds every key once, and a live apply (ingest, `--from`,
// an SDK caller) folds the keys an op touches. So live state for a key is,
// by construction, rebuild-of-that-key, whatever order its ops arrived in.
//
// THE RULES (docs/architecture/sync.md § Order-independent apply)
//   horizon   a put older than the newest `del` of its own key or of an
//             ancestor (task -> workstream) is dead; the `del` wiped it.
//   task      per-field LWW by HLC over the live puts. A field absent from
//             every live put takes its default, and a default that is a
//             timestamp is the ISO time of the HLC that began the life,
//             never "now": the same log folds to the same row on any
//             machine, at any time.
//   kind/wave  per-field LWW like the rest; kind is one of TASK_KINDS (an
//             unknown value is dropped, default 'work'), wave is nullable.
//   substate  not LWW: the newest live op that writes one, resolved
//             against the folded status (a concurrent close and park fall
//             back to the status default).
//   workstream  exists from its first live put (its own, or a task's under
//             it: a task put creates its parent) until the next `del`.
//   note      grow-only set by content identity (author, content,
//             created_at). A `del` kills the puts of that identity older
//             than itself; a later put brings it back.
//   edge      LWW element: present iff a put is newer than its own `del`
//             and both endpoints' horizons; created_at is the first live
//             put's.
//
// A payload is decoded leniently: a field with a value the schema would
// refuse (CHECK, NOT NULL) or of an unsupported type is dropped like an
// unknown field. A RAISE during ingest would roll back the segment and
// stall sync forever; the log is accepted as it is.

import {
  DEFAULT_EFFORT_DAYS,
  DEFAULT_IMPACT,
  NOTE_KINDS,
  TASK_KINDS,
  type TaskKind,
} from "./db.js";
import { compareHlc, parseHlc } from "./hlc.js";
import {
  DEFAULT_SUBSTATE,
  isTaskStatus,
  mapLegacyStatus,
  resolvePair,
  type TaskStatus,
} from "./tasks/status.js";

/** The part of an op a fold reads. */
export interface LogOp {
  hlc: string;
  op: "put" | "del";
  /** The natural key; a note fold reads it to pair a `del` with its put. */
  key: string;
  payload: string;
}

type Scalar = string | number | null;

/** The scalar members of a payload; anything else (nested value, bad JSON,
 *  a non-object) is dropped. Booleans become 0/1 like SQLite stores them. */
function fieldsOf(payload: string): Record<string, Scalar> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, Scalar> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (value === null || typeof value === "string" || typeof value === "number") {
      out[field] = value;
    } else if (typeof value === "boolean") {
      out[field] = value ? 1 : 0;
    }
  }
  return out;
}

/** The ISO time of an HLC's wall clock: the deterministic stand-in for
 *  "now" wherever a row's timestamp is not in any op. */
export function isoOfHlc(hlc: string): string {
  try {
    return new Date(parseHlc(hlc).wallMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

const ascending = (ops: readonly LogOp[]): LogOp[] =>
  [...ops].sort((a, b) => compareHlc(a.hlc, b.hlc));

/** The newest `del` among `ops`, or null. */
export function newestDel(ops: readonly LogOp[]): string | null {
  let newest: string | null = null;
  for (const o of ops) {
    if (o.op === "del" && (newest === null || compareHlc(o.hlc, newest) > 0)) newest = o.hlc;
  }
  return newest;
}

/** The later of two horizons; null is "none". */
export function laterHlc(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareHlc(a, b) >= 0 ? a : b;
}

/** Puts strictly newer than `horizon`, oldest first. */
function livePuts(ops: readonly LogOp[], horizon: string | null): LogOp[] {
  return ascending(ops).filter(
    (o) => o.op === "put" && (horizon === null || compareHlc(o.hlc, horizon) > 0),
  );
}

/** The newest value of `field` that `accept` takes, in HLC order. */
function lww<T>(
  puts: readonly { fields: Record<string, Scalar> }[],
  field: string,
  accept: (v: Scalar) => T | undefined,
): { value: T } | undefined {
  let found: { value: T } | undefined;
  for (const p of puts) {
    if (!(field in p.fields)) continue;
    const v = accept(p.fields[field] ?? null);
    if (v !== undefined) found = { value: v };
  }
  return found;
}

const str = (v: Scalar): string | undefined => (typeof v === "string" ? v : undefined);
const strOrNull = (v: Scalar): string | null | undefined =>
  v === null || typeof v === "string" ? v : undefined;

// ─── workstream ───────────────────────────────────────────────────────

export interface WorkstreamState {
  createdAt: string;
  tornDownAt: string | null;
}

/**
 * The workstream's row, or null when it does not exist. `ops` are its own
 * puts and dels; `firstTaskPutAfter(h)` is the oldest put of any task
 * under it newer than `h` (null: none), because a task put creates the
 * parent. Its life starts at the oldest of those and its own first live
 * put, and a restart after a `del` forgets the dead life's fields.
 */
export function foldWorkstream(
  ops: readonly LogOp[],
  firstTaskPutAfter: (after: string | null) => string | null,
): WorkstreamState | null {
  const horizon = newestDel(ops);
  const puts = livePuts(ops, horizon).map((o) => ({ hlc: o.hlc, fields: fieldsOf(o.payload) }));
  const created = lww(puts, "created_at", str);
  const torn = lww(puts, "torn_down_at", strOrNull);
  // The scan for a task put is the expensive input, so it runs only when
  // the answer needs it: existence with no live put of its own, or the
  // creation default with no created_at in any of them.
  const own = puts[0]?.hlc ?? null;
  if (own === null && firstTaskPutAfter(horizon) === null) return null;
  let createdAt = created?.value;
  if (createdAt === undefined) {
    const task = firstTaskPutAfter(horizon);
    const start = own === null ? task : task === null ? own : earlierHlc(own, task);
    createdAt = isoOfHlc(start ?? "");
  }
  return { createdAt, tornDownAt: torn?.value ?? null };
}

function earlierHlc(a: string, b: string): string {
  return compareHlc(a, b) <= 0 ? a : b;
}

// ─── task ─────────────────────────────────────────────────────────────

export interface TaskState {
  title: string;
  status: TaskStatus;
  substate: string;
  impact: number;
  effortDays: number;
  scored: number;
  dispatchHost: string | null;
  kind: TaskKind;
  wave: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The substate a payload writes, or null if it writes none.
 *
 *  - A legacy status writes the substate it maps to, overriding any
 *    substate beside it (mirrors resolvePair).
 *  - A known status with no substate writes the status's default. Capture
 *    records only changed columns and the substate sets are disjoint, so a
 *    v11 status change always carries its substate: a status-only op comes
 *    from a v10 peer or pre-v11 history, where every status had exactly
 *    its default.
 *  - Otherwise the explicit substate, or null. */
function carriedSubstate(fields: Record<string, Scalar>): string | null {
  const { status, substate } = fields;
  if (typeof status === "string") {
    const legacy = mapLegacyStatus(status);
    if (legacy) return legacy.substate;
    if (typeof substate !== "string" && isTaskStatus(status)) return DEFAULT_SUBSTATE[status];
  }
  return typeof substate === "string" ? substate : null;
}

/** A status this build knows, a legacy one mapped onto its pair's status. */
function knownStatus(v: Scalar): TaskStatus | undefined {
  if (typeof v !== "string") return undefined;
  const legacy = mapLegacyStatus(v);
  if (legacy) return legacy.status;
  return isTaskStatus(v) ? v : undefined;
}

const impactOf = (v: Scalar): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 100 ? v : undefined;
const effortOf = (v: Scalar): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
const scoredOf = (v: Scalar): number | undefined => (v === 0 || v === 1 ? v : undefined);
/** A task kind this build knows; any other value is dropped like an
 *  unknown field, so a newer peer's kind never trips the CHECK in ingest. */
const kindOf = (v: Scalar): TaskKind | undefined =>
  typeof v === "string" && (TASK_KINDS as readonly string[]).includes(v)
    ? (v as TaskKind)
    : undefined;

/**
 * The task's row, or null when it is dead (no put newer than `horizon`,
 * the newest `del` of the task or of its workstream).
 */
export function foldTask(
  ops: readonly LogOp[],
  horizon: string | null,
  localId: string,
): TaskState | null {
  const puts = livePuts(ops, horizon).map((o) => ({ hlc: o.hlc, fields: fieldsOf(o.payload) }));
  const began = puts[0]?.hlc;
  if (began === undefined) return null;
  const born = isoOfHlc(began);
  const status = lww(puts, "status", knownStatus)?.value ?? "OPEN";
  let winner: string | null = null;
  for (const p of puts) winner = carriedSubstate(p.fields) ?? winner;
  const pair = resolvePair(status, winner ?? DEFAULT_SUBSTATE[status]);
  return {
    title: lww(puts, "title", str)?.value ?? localId,
    status,
    substate: pair?.substate ?? DEFAULT_SUBSTATE[status],
    impact: lww(puts, "impact", impactOf)?.value ?? DEFAULT_IMPACT,
    effortDays: lww(puts, "effort_days", effortOf)?.value ?? DEFAULT_EFFORT_DAYS,
    scored: lww(puts, "scored", scoredOf)?.value ?? 0,
    dispatchHost: lww(puts, "dispatch_host", strOrNull)?.value ?? null,
    kind: lww(puts, "kind", kindOf)?.value ?? "work",
    wave: lww(puts, "wave", strOrNull)?.value ?? null,
    createdAt: lww(puts, "created_at", str)?.value ?? born,
    updatedAt: lww(puts, "updated_at", str)?.value ?? born,
  };
}

// ─── note ─────────────────────────────────────────────────────────────

export interface NoteState {
  author: string | null;
  content: string;
  createdAt: string;
  kind: string;
}

/** A note's identity: the text is not unique (a machine repeats its lines),
 *  so created_at is part of it. The origin id in the key is not: it names
 *  the row on its origin machine only. */
export function noteIdentity(author: string | null, content: string, createdAt: string): string {
  return JSON.stringify([author ?? "", content, createdAt]);
}

interface NotePut extends NoteState {
  hlc: string;
  key: string;
}

function notePut(o: LogOp): NotePut {
  const f = fieldsOf(o.payload);
  const author =
    typeof f.author === "string" ? f.author : f.author == null ? null : String(f.author);
  const sentKind = f.kind;
  return {
    hlc: o.hlc,
    key: o.key,
    author,
    content: f.content == null ? "" : String(f.content),
    createdAt: typeof f.created_at === "string" ? f.created_at : isoOfHlc(o.hlc),
    kind: (NOTE_KINDS as readonly unknown[]).includes(sentKind) ? (sentKind as string) : "note",
  };
}

/**
 * The notes of one task, keyed by identity. `ops` are every note op under
 * the task. A `del` names its note either by carrying the identity itself
 * (capture writes the full row when no put shares its key) or, bare, by
 * the newest put under its key that is older than it; created_at may be
 * absent from a hand-written one, which then matches every copy of the
 * text. `kind` is set once: the first put's.
 */
export function foldNotes(ops: readonly LogOp[], horizon: string | null): Map<string, NoteState> {
  const sorted = ascending(ops);
  const puts = sorted.filter((o) => o.op === "put").map(notePut);
  const kills: { hlc: string; author: string | null; content: string; createdAt: string | null }[] =
    [];
  for (const d of sorted) {
    if (d.op !== "del") continue;
    const f = fieldsOf(d.payload);
    if (f.content != null) {
      kills.push({
        hlc: d.hlc,
        author: f.author == null ? null : String(f.author),
        content: String(f.content),
        createdAt: typeof f.created_at === "string" ? f.created_at : null,
      });
      continue;
    }
    const src = puts.filter((p) => p.key === d.key && compareHlc(p.hlc, d.hlc) < 0).pop();
    if (src)
      kills.push({
        hlc: d.hlc,
        author: src.author,
        content: src.content,
        createdAt: src.createdAt,
      });
  }
  const out = new Map<string, NoteState>();
  for (const p of puts) {
    if (horizon !== null && compareHlc(p.hlc, horizon) <= 0) continue;
    const killed = kills.some(
      (k) =>
        compareHlc(k.hlc, p.hlc) > 0 &&
        k.content === p.content &&
        (k.author ?? "") === (p.author ?? "") &&
        (k.createdAt === null || k.createdAt === p.createdAt),
    );
    if (killed) continue;
    const id = noteIdentity(p.author, p.content, p.createdAt);
    if (!out.has(id))
      out.set(id, { author: p.author, content: p.content, createdAt: p.createdAt, kind: p.kind });
  }
  return out;
}

// ─── edge ─────────────────────────────────────────────────────────────

/**
 * The edge's created_at, or null when it is absent: no put newer than its
 * own `del` and than the horizons of both endpoints.
 */
export function foldEdge(
  ops: readonly LogOp[],
  endpointHorizons: readonly (string | null)[],
): { createdAt: string } | null {
  let horizon = newestDel(ops);
  for (const h of endpointHorizons) horizon = laterHlc(horizon, h);
  const first = livePuts(ops, horizon)[0];
  if (first === undefined) return null;
  const stamped = fieldsOf(first.payload).created_at;
  return { createdAt: typeof stamped === "string" ? stamped : isoOfHlc(first.hlc) };
}
