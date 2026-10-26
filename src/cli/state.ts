// mu — `mu state` and `mu me` (the canonical state read).
//
//   mu state -w <ws>[,<ws>…] | --all      tasks, agents, the caller's delegate queue
//                                         and waves, its open human needs
//   mu state --me                         the same, from the caller's own identity
//   mu me                                 exactly `mu state --me`
//
// The output is ONE JSON document (envelope included) by default: SQL column
// names, at most RESULT_BYTES. A cut says `more=N` records left out and `cut=N`
// characters clipped, and names the one way back: the same read with `--full`.
// `mu state -w` reconciles first (reaps panes that are gone, lists orphans);
// `--me` and the snapshot itself never touch the mux. Identity is
// src/cli/me-identity.ts: the injected `<ws>/<name>` or a pi session, never a pane.

import type { Command } from "commander";
import { spawnerFromEnv } from "../agents/spawn.js";
import {
  emitJson,
  handle,
  injectedWorkstream,
  JSON_OPT,
  missingWorkstreamError,
  parseWorkstreamList,
  UsageError,
} from "../cli.js";
import { type Db, tryResolveLiveWorkstreamId, WorkstreamNotFoundError } from "../db.js";
import { RESULT_BYTES } from "../output-contract.js";
import { reconcile } from "../reconcile.js";
import { shellWord } from "../shell-quote.js";
import {
  callerWorkstreams,
  type StateSnapshot,
  stateSnapshot,
  type WorkstreamState,
} from "../state.js";
import { listWorkstreams } from "../workstream.js";
import { resolveMe } from "./me-identity.js";
import { clipEscaped, jsonDocument } from "./tasks/records.js";

export interface StateOpts {
  /** Variadic: `-w a b`, `-w a,b`, `-w a -w b`. */
  workstream?: string[];
  all?: boolean;
  me?: boolean;
  /** No cap: the whole snapshot. */
  full?: boolean;
  json?: boolean;
}

/** Longest string any field of a state read keeps (code points); a clipped one counts into `cut`. */
const FIELD_CHARS = 160;
/** Largest per-list length tried; the loop shrinks it until the document fits. */
const LIST_STEPS = [20, 10, 5, 3, 2, 1, 0];
/** Field lengths the zero-item fallback tries, longest first (the identity block's fields shrink). */
const FALLBACK_CHARS = [FIELD_CHARS, 80, 40, 20, 10, 5];

// ─── Scope ─────────────────────────────────────────────────────────

async function resolveScope(db: Db, opts: StateOpts): Promise<string[]> {
  const explicitW = opts.workstream !== undefined && opts.workstream.length > 0;
  if (opts.all === true && explicitW) {
    throw new UsageError("--all and -w/--workstream are mutually exclusive", { showHelp: false });
  }
  if (opts.all === true) return (await listWorkstreams(db)).map((w) => w.name);
  if (explicitW) {
    // Repeat / comma / mixed forms become one flat list; blank or padded names are a usage error.
    const names = Array.from(new Set(parseWorkstreamList(opts.workstream ?? [])));
    for (const n of names) {
      if (tryResolveLiveWorkstreamId(db, n) === null) throw new WorkstreamNotFoundError(n);
    }
    if (names.length > 0) return names;
  }
  if (opts.me === true) {
    // Own scope: a managed agent's workstream, or where a pi session has work.
    const me = resolveMe(db);
    return me.agent !== null ? [me.agent.workstreamName] : callerWorkstreams(db, me.caller);
  }
  const injected = injectedWorkstream();
  if (injected !== undefined) return [injected];
  const first = (await listWorkstreams(db))[0]?.name;
  throw await missingWorkstreamError({
    orAll: true,
    ...(first ? { extra: `e.g. -w ${first}` } : {}),
  });
}

/** The same read, uncapped: what a cut result names. `short` drops the scope names for `--all` (a superset, but a fixed-size command). */
function fullCommand(opts: StateOpts, scope: readonly string[], short = false): string {
  const parts = ["mu", "state"];
  if (opts.me === true) parts.push("--me");
  if (opts.all === true || short) parts.push("--all");
  else if ((opts.workstream?.length ?? 0) > 0) parts.push("-w", scope.map(shellWord).join(","));
  parts.push("--full");
  return parts.join(" ");
}

// ─── Bounding ──────────────────────────────────────────────────────

interface Bounded {
  data: Record<string, unknown>;
  more: number;
  cut: number;
}

/** Every string of `value` as one inert, escaped line of at most `chars` characters (`…` ends a clipped one); `n.cut` counts the code points dropped. */
function clipStrings(value: unknown, n: { cut: number }, chars: number): unknown {
  if (typeof value === "string") {
    const whole = clipEscaped(value, chars);
    if (whole.cut === 0) return whole.text;
    const room = clipEscaped(value, chars - 1);
    n.cut += room.cut;
    return `${room.text}…`;
  }
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, n, chars));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, n, chars)]));
  }
  return value;
}

const LISTS = [
  "ready",
  "in_progress",
  "blocked",
  "triage",
  "recent_closed",
  "agents",
  "orphans",
  "delegates",
  "waves",
  "human_needs",
] as const;

/** `snap` with every list cut to `k` records, workstreams cut to `wsCount`, strings clipped to `chars`. */
function bound(snap: StateSnapshot, k: number, wsCount: number, chars = FIELD_CHARS): Bounded {
  let more = Math.max(0, snap.workstreams.length - wsCount);
  const limit = <T>(list: readonly T[]): T[] => {
    more += Math.max(0, list.length - k);
    return list.slice(0, k);
  };
  const workstreams = snap.workstreams.slice(0, wsCount).map((w) => {
    const out: Record<string, unknown> = { ...w };
    for (const key of LISTS) {
      const list = (w as unknown as Record<string, unknown[] | undefined>)[key];
      if (list !== undefined) out[key] = limit(list);
    }
    return out;
  });
  const me = snap.me === null ? null : { ...snap.me, owned_tasks: limit(snap.me.owned_tasks) };
  const n = { cut: 0 };
  const data = clipStrings({ caller: snap.caller, me, workstreams }, n, chars) as Record<
    string,
    unknown
  >;
  return { data, more, cut: n.cut };
}

const sizeOf = (data: unknown): number => Buffer.byteLength(jsonDocument(data)) + 1;

/**
 * The largest read (lists, then workstreams) whose FINAL document fits
 * RESULT_BYTES, with its cut counts and way back. When even bare counts
 * overflow, the last resorts are zero-item envelopes (no workstream) whose
 * `retrieve` is `short` if the named one is too long, and whose strings (the
 * identity block's) shrink until the document fits: the fallback is validated
 * like every other candidate, never returned unchecked.
 */
export function boundState(
  snap: StateSnapshot,
  retrieve: string,
  full: boolean,
  short = retrieve,
): unknown {
  if (full) return { caller: snap.caller, me: snap.me, workstreams: snap.workstreams };
  const finish = (b: Bounded, way: string): Record<string, unknown> => ({
    ...b.data,
    ...(b.more > 0 ? { more: b.more } : {}),
    ...(b.cut > 0 ? { cut: b.cut } : {}),
    ...(b.more > 0 || b.cut > 0 ? { retrieve: way } : {}),
  });
  const count = snap.workstreams.length;
  const ways = retrieve === short ? [retrieve] : [retrieve, short];
  const fit = (b: Bounded): Record<string, unknown> | null => {
    for (const way of ways) {
      const doc = finish(b, way);
      if (sizeOf(doc) <= RESULT_BYTES) return doc;
    }
    return null;
  };
  for (const k of LIST_STEPS) {
    const doc = fit(bound(snap, k, count));
    if (doc !== null) return doc;
  }
  // Even bare counts overflow: page the workstreams themselves (none is allowed).
  for (let w = count - 1; w >= 1; w--) {
    const doc = fit(bound(snap, 0, w));
    if (doc !== null) return doc;
  }
  for (const chars of FALLBACK_CHARS) {
    const doc = fit(bound(snap, 0, 0, chars));
    if (doc !== null) return doc;
  }
  return finish(bound(snap, 0, 0, 1), short);
}

// ─── cmdState ──────────────────────────────────────────────────────

export async function cmdState(db: Db, opts: StateOpts): Promise<void> {
  const me = opts.me === true ? resolveMe(db) : null;
  const caller = me?.caller ?? spawnerFromEnv();
  const scope = await resolveScope(db, opts);

  // Explicit reconciliation is the CLI's (it reaps panes that are gone and
  // finds orphans); `--me` reads no mux, and the snapshot never writes.
  const orphans = new Map<string, WorkstreamState["orphans"]>();
  if (me === null) {
    for (const ws of scope) {
      const report = await reconcile(db, { workstream: ws });
      orphans.set(
        ws,
        report.orphans.map((p) => ({ pane_id: p.paneId, command: p.command })),
      );
    }
  }

  const snap = await stateSnapshot(db, {
    workstreams: scope,
    caller,
    ...(me !== null ? { me: { agent: me.agent } } : {}),
  });
  for (const w of snap.workstreams) {
    const found = orphans.get(w.workstream);
    if (found !== undefined) w.orphans = found;
  }
  emitJson(
    boundState(snap, fullCommand(opts, scope), opts.full === true, fullCommand(opts, scope, true)),
  );
}

// ─── commander wiring ──────────────────────────────────────────────

export function wireStateCommands(program: Command): void {
  program
    .command("state")
    .description(
      "The canonical state read, as one JSON document: per workstream the counts, ready / in-progress / blocked / triage / recent-closed tasks (SQL column names), registered agents (host, cwd, base, collected_head included) with their runtime state, orphan panes, and THE CALLER'S OWN delegate queue, waves and open human needs. -w accepts repeat or comma-separate (or both); --all is every workstream; --me reads from the caller's own identity ($MU_AGENT_NAME in $MU_WORKSTREAM, or pi:$PI_SESSION_ID; never a pane). Capped at 4 KB: a cut names `mu state ... --full`. `mu state -w` reconciles first; --me does not.",
    )
    .option(
      "-w, --workstream <names...>",
      "workstream(s) to read (repeat or comma-separate; or both). Required unless --all, --me or run as a spawned worker",
    )
    .option("--all", "include every workstream on this machine")
    .option(
      "--me",
      "the caller's own identity and owned tasks, with its delegate queue and human needs",
    )
    .option("--full", "no cap: the whole read (a cut result names this command)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as StateOpts;
      return handle((db) => cmdState(db, opts), this as Command)();
    });
}
