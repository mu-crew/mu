// Dashboard lifecycle, outside render. TWO connections, by design:
//
//   - `ro`: a `readonly: true` connection. Every projection (`loadDashboard`)
//     runs here, so the UI can never write.
//   - `syncDb`: a WRITABLE connection owned by the caller (the launcher's
//     `handle()`, which also ran the DB-inside-MU_SYNC_DIR / sync/v1 refusals).
//     A read-only connection cannot ingest peer ops ("attempt to write a
//     readonly database"), so ambient sync runs here and only here.
//
// Sync is bounded: at most one refresh in flight (callers share its promise),
// ingest at most every `syncEveryMs` (never on each repaint), always `quiet`
// (a stderr write would paint over the alternate screen; warnings come back in
// the result), no reconcile, no reap. `close()` waits for the in-flight
// refresh and closes `ro`. The final flush is not here: the launcher's single
// idempotent shutdown (`src/cli/dashboard-shutdown.ts`) runs it after every
// step, on q/Esc, signals and boot errors alike.

import type { StateReading } from "../../agent-state.js";
import {
  type DashboardOptions,
  type DashboardSnapshot,
  loadDashboard,
} from "../../dashboard-data.js";
import { type Db, openDb } from "../../db.js";
import { ambientIngest, syncEnabled } from "../../sync.js";
import { getTask, type SelectedNotes, selectTaskNotes, type TaskRow } from "../../tasks.js";
import { currentCallers } from "../../wait-callers.js";

/** One refresh: the projection plus whatever sync said while producing it. */
export interface RefreshResult {
  snapshot: DashboardSnapshot;
  /** Non-fatal sync problems from this refresh's ingest (empty when none ran). */
  warnings: readonly string[];
}

export type DashboardQuery = Omit<DashboardOptions, "caller">;

export interface RefreshOptions {
  /**
   * The slow tier: re-probe every agent's state (control socket, gate pane). Without it
   * the read is SQL only, agent states coming from the last slow read (an agent never
   * probed yet is probed once). 3.x's fast/slow tiers, merged by this cache.
   */
  slow?: boolean;
}

export interface DashboardRuntime {
  /** Ingest if due, then project. Concurrent calls with the same query and tier share one run. */
  refresh(query?: DashboardQuery, opts?: RefreshOptions): Promise<RefreshResult>;
  /** A task's notes (the CLI's default selection, or all of them), read on `ro`. */
  notes(workstream: string, id: string, all: boolean): SelectedNotes;
  /** A task's row (the notes drill's live header), read on `ro`; undefined when gone. */
  task(workstream: string, id: string): TaskRow | undefined;
  /** Drain the in-flight refresh, close `ro`. Idempotent. */
  close(): Promise<void>;
}

export interface RuntimeOptions {
  dbPath: string;
  /** The caller's writable connection; used for sync only, never closed here. */
  syncDb: Db;
  /** `spawnerFromEnv()`; null for a human shell. */
  caller: string | null;
  /** Who `next` is computed for; default `currentCallers()`. */
  callers?: readonly string[];
  /** Minimum gap between ingests (default 10 s). */
  syncEveryMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

const DEFAULT_SYNC_EVERY_MS = 10_000;

export function createRuntime(opts: RuntimeOptions): DashboardRuntime {
  const ro = openDb({ path: opts.dbPath, readonly: true });
  const now = opts.now ?? Date.now;
  const every = opts.syncEveryMs ?? DEFAULT_SYNC_EVERY_MS;
  let inflight: Promise<RefreshResult> | null = null;
  let inflightQuery = "";
  let lastSync = Number.NEGATIVE_INFINITY;
  let closed = false;
  // The slow tier's agent readings, merged into every fast read.
  const agentStates = new Map<string, StateReading>();

  async function run(query: DashboardQuery, slow: boolean): Promise<RefreshResult> {
    let warnings: readonly string[] = [];
    if (syncEnabled() && now() - lastSync >= every) {
      lastSync = now();
      warnings = (await ambientIngest(opts.syncDb, { quiet: true })).warnings;
    }
    const snapshot = await loadDashboard(ro, {
      ...query,
      caller: opts.caller,
      callers: opts.callers ?? currentCallers(),
      agentStates: { cache: agentStates, probe: slow },
    });
    return { snapshot, warnings };
  }

  return {
    refresh(query = {}, { slow = false } = {}) {
      if (closed) return Promise.reject(new Error("dashboard runtime is closed"));
      const key = `${slow ? "slow" : "fast"}:${JSON.stringify(query)}`;
      // Same query: share the run. A different one (the user changed a filter)
      // waits for the in-flight run, then runs: never two at once, never a
      // result for the wrong query.
      if (inflight !== null && inflightQuery === key) return inflight;
      const prior = inflight?.catch(() => undefined) ?? Promise.resolve();
      inflightQuery = key;
      const mine: Promise<RefreshResult> = prior
        .then(() => run(query, slow))
        .finally(() => {
          if (inflight === mine) inflight = null;
        });
      inflight = mine;
      return mine;
    },
    notes(workstream, id, all) {
      if (closed) throw new Error("dashboard runtime is closed");
      return selectTaskNotes(ro, id, { workstream, all });
    },
    task(workstream, id) {
      if (closed) throw new Error("dashboard runtime is closed");
      return getTask(ro, id, workstream);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await inflight?.catch(() => undefined);
      } finally {
        ro.close();
      }
    },
  };
}
