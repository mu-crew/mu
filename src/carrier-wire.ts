// mu — the wire state machine of a `handle: "file"` job record (ladder placement §10). The
// record's view is its job's dispatcher, so its record and job file are retained until that
// view is PROVEN gone, on every path: spawn, close, rollback, reattach, recovery. Those paths
// run in different processes and await mux probes and plugin calls between deciding and
// acting, so no snapshot is trusted: each decision names the revision it was made on, and the
// transition that acts on it is ONE compare-and-swap on that revision (`wire_rev`, NULL read as 0). A path
// whose revision moved lost the race and retains everything.
//
//   claimed ──start intent──▶ claimed (the job.start effect's intent, `markFileJobLaunch`)
//   claimed ──dispatch──▶ dispatching ──bind──▶ bound(view, mux server)
//      ▲  ▲                                       │  │
//      │  └────────────── dispatch (reattach) ────┘  │ unbind (its view proven gone)
//      │                                             ▼
//      └──────────────────────────────────────── claimed
//   claimed | bound ──release (view proven gone)──▶ released ──finish──▶ (row deleted)
//   any ──abandon (`--abandon-job`)──▶ (row deleted)
//
// `claimed`: no view (never asked for, or proven gone). `dispatching`: a view asked for, its
// pane id not recorded: unknown, so it retains. `bound`: its view is `pane_id` on the mux
// server `view_server`, the only server whose answer proves it gone. `released`: its view
// was proven gone and its stop begun; no view opens again. Released and abandoned are the
// row's deletion (`releaseCarrierJob`, `abandonCarrierJob`), with the same compare-and-swap.
// NULL (a record older than the column) is unknown: no transition starts from it.
//
// The job file is touched only inside the transaction of the transition that owns the
// record's current revision (`claimJobFile`, `removeJobFile`): a spawn whose reservation was
// released never moves its replacement's file. A lease reservation (no plugin) stays
// `claimed`: only its file claim goes through here; its pane is proven by the row rule.

import { renameSync, rmSync } from "node:fs";
import type { CarrierJob, WireState } from "./carrier-jobs.js";
import type { Db } from "./db.js";
import { describeRead, type JobFile, readJobFile } from "./jobs/lease.js";

/** What a transition needs of the record: its token and the revision its caller decided on. */
export type WireRef = Pick<CarrierJob, "token" | "wireRev">;

/**
 * One compare-and-swap: from one of `from` at `r.wireRev` to `to`, the revision bumped, with
 * `set` (extra assignments) applied. The new revision, or undefined when the record is gone,
 * in another state, or at another revision (another path moved it first).
 */
function step(
  db: Db,
  r: WireRef,
  from: readonly WireState[],
  to: WireState,
  set = "",
  args: readonly (string | null)[] = [],
): number | undefined {
  const row = db
    .prepare(
      `UPDATE carrier_jobs SET wire_state = ?, wire_rev = COALESCE(wire_rev, 0) + 1${set}
       WHERE token = ? AND COALESCE(wire_rev, 0) = ? AND wire_state IN (${from.map(() => "?").join(", ")})
       RETURNING wire_rev`,
    )
    .get(to, ...args, r.token, r.wireRev, ...from) as { wire_rev: number } | undefined;
  return row?.wire_rev;
}

/**
 * The spawn's claim of the fixed job path, holding its reservation (`claimed` at the revision it
 * reserved): a file already there can only be an earlier, released or abandoned, reservation's,
 * and is moved aside (never deleted) INSIDE this transition. A reservation released meanwhile
 * (a close of the unlaunched spawn, a replacement reserved since) loses: undefined, nothing
 * moved. Returns the new revision and what was moved aside.
 */
export function claimJobFile(
  db: Db,
  r: WireRef,
  path: string,
): { rev: number; moved?: { read: JobFile; aside: string } } | undefined {
  return db
    .transaction(() => {
      const rev = step(db, r, ["claimed"], "claimed");
      if (rev === undefined) return undefined;
      const read = readJobFile(path);
      if (read.kind === "none") return { rev };
      const aside = `${path}.stale-${Date.now()}`;
      renameSync(path, aside); // throws: the transition rolls back
      return { rev, moved: { read, aside } };
    })
    .immediate();
}

/**
 * A file kind's `job.start` intent (`launch = 'intent'`, the instance the start goes to, an
 * at-start kind's first msgId), written in the effect's transaction as a transition of the
 * record, from `claimed` at the revision the spawn's file claim returned. A close that decided
 * "unlaunched" on the earlier revision then cannot delete the record (its release compares
 * the revision it read), and a close that released it first makes this refuse before any
 * call is sent. Returns the new revision, the one the spawn dispatches its view from.
 */
export function markFileJobLaunch(
  db: Db,
  r: WireRef,
  instance: string,
  firstMsgId?: string,
): number | undefined {
  return step(
    db,
    r,
    ["claimed"],
    "claimed",
    ", launch = 'intent', instance = ?, first_msg_id = COALESCE(?, first_msg_id)",
    [instance, firstMsgId ?? null],
  );
}

/**
 * A view is about to be asked for (`dispatching`), in the agent-locked section of the mux call:
 * a backend may open it and fail before reporting its id. A spawn dispatches from `claimed`; a
 * reattach also from `bound`, once that view is proven gone at `r.wireRev`. Undefined: the
 * record moved (released, or another view) and no view may open for it.
 */
export function dispatchView(
  db: Db,
  r: WireRef,
  from: readonly ("claimed" | "bound")[] = ["claimed"],
): number | undefined {
  return step(db, r, from, "dispatching", ", pane_id = NULL, view_server = NULL");
}

/** The dispatched view reported `paneId` on mux server `server` (null: unknown, so it retains). */
export function bindView(
  db: Db,
  r: WireRef,
  paneId: string,
  server: string | null,
): number | undefined {
  return step(db, r, ["dispatching"], "bound", ", pane_id = ?, view_server = ?", [paneId, server]);
}

/** The bound view `paneId` was proven gone (a recovery's failed view): no view again. */
export function unbindView(db: Db, r: WireRef, paneId: string): number | undefined {
  return db
    .transaction(() => {
      const now = db.prepare("SELECT pane_id FROM carrier_jobs WHERE token = ?").get(r.token) as
        | { pane_id: string | null }
        | undefined;
      if (now?.pane_id !== paneId) return undefined;
      return step(db, r, ["bound"], "claimed", ", pane_id = NULL, view_server = NULL");
    })
    .immediate();
}

/**
 * The release begins (`released`): its caller proved the view gone at `r.wireRev` and is about
 * to stop the job. From then on no view opens for the record and no file is claimed for it. A
 * record already `released` (a rollback's stop that failed, a close resuming it) is returned as
 * it is: its proof was made on entering. Undefined: the record moved since the proof (a
 * reattach dispatched, a spawn bound), and the caller retains everything.
 */
export function beginRelease(db: Db, r: WireRef): number | undefined {
  return db
    .transaction(() => {
      const now = db
        .prepare(
          "SELECT wire_state, COALESCE(wire_rev, 0) AS wire_rev FROM carrier_jobs WHERE token = ?",
        )
        .get(r.token) as { wire_state: WireState | null; wire_rev: number } | undefined;
      if (now?.wire_state === "released") return now.wire_rev;
      return step(db, r, ["claimed", "bound"], "released");
    })
    .immediate();
}

/** What `removeJobFile` found at the path. */
export type JobFileRemoval = "removed" | "absent" | { kept: string };

/**
 * After the stop: the job file goes only while it holds the stopped `handle`, inside a
 * transaction that sees the record still at `r.wireRev` and in a state that owns it (`released`,
 * or a lease's `claimed`). Undefined: the record moved or is gone, and the file is not this
 * caller's to touch. Anything else at the path (another handle, invalid, unreadable) is kept.
 */
export function removeJobFile(
  db: Db,
  r: WireRef,
  path: string,
  handle: string,
): JobFileRemoval | undefined {
  return db
    .transaction((): JobFileRemoval | undefined => {
      const owner = db
        .prepare(
          "SELECT 1 FROM carrier_jobs WHERE token = ? AND COALESCE(wire_rev, 0) = ? AND (wire_state IS NULL OR wire_state IN ('claimed', 'released'))",
        )
        .get(r.token, r.wireRev);
      if (owner === undefined) return undefined;
      const now = readJobFile(path);
      if (now.kind === "none") return "absent";
      if (now.kind === "handle" && now.job === handle) {
        rmSync(path, { force: true });
        return "removed";
      }
      return { kept: describeRead(now) };
    })
    .immediate();
}
