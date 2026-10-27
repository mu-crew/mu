// mu — the pane env guard (triage_dfh_harness_path).
//
// A local spawn records the DB, state dir and sync dir it gave the pane in
// one variable, MU_PANE_ENV. A harness that runs every tool command through
// the user's interactive shell rc (codex's shell snapshot, cursor-agent) lets
// the rc overwrite PATH and MU_* after mu set them, so the worker's `mu`
// can hit another DB or flush into the real sync folder. A mu run whose own
// resolution differs from its pane's warns once, never syncs, and refuses a
// write (exit 4) unless MU_ALLOW_FOREIGN_DB=1. A 3.x `mu` on PATH ignores the
// variable; for that case see docs/guide/other-agent-clis.md.

import { resolve } from "node:path";
import { defaultStateDir } from "./state-dir.js";

/** The pane variable: JSON `{db,state,sync}`, absolute paths; sync "" when off. */
export const PANE_ENV_VAR = "MU_PANE_ENV";
/** Escape hatch: `1` lets a mismatched run write and sync. */
export const ALLOW_FOREIGN_DB_VAR = "MU_ALLOW_FOREIGN_DB";

export interface PaneEnv {
  db: string;
  state: string;
  sync: string;
}

/** The value spawn puts on a pane. */
export function paneEnvValue(p: PaneEnv): string {
  return JSON.stringify({ db: p.db, state: p.state, sync: p.sync });
}

export interface PaneEnvMismatch {
  field: "MU_DB_PATH" | "MU_STATE_DIR" | "MU_SYNC_DIR";
  pane: string;
  now: string;
}

function parse(raw: string | undefined): PaneEnv | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const v = JSON.parse(raw) as Partial<PaneEnv> | null;
    if (typeof v?.db !== "string" || typeof v.state !== "string" || typeof v.sync !== "string") {
      return null;
    }
    return { db: v.db, state: v.state, sync: v.sync };
  } catch {
    return null;
  }
}

/**
 * How this process's DB, state dir and sync dir differ from what its pane was
 * spawned with. Empty outside a mu pane, or when the value is unreadable. A sync
 * dir the pane had and this run lacks is not a mismatch: sync off writes nothing.
 */
export function paneEnvMismatch(env: NodeJS.ProcessEnv = process.env): PaneEnvMismatch[] {
  const pane = parse(env[PANE_ENV_VAR]);
  if (pane === null) return [];
  const stateNow = resolve(env.MU_STATE_DIR || defaultStateDirFor(env));
  const dbNow = resolve(env.MU_DB_PATH || `${stateNow}/mu.db`);
  const syncRaw = env.MU_SYNC_DIR?.trim() ?? "";
  const syncNow = syncRaw === "" ? "" : resolve(syncRaw);
  const out: PaneEnvMismatch[] = [];
  if (dbNow !== resolve(pane.db)) out.push({ field: "MU_DB_PATH", pane: pane.db, now: dbNow });
  if (stateNow !== resolve(pane.state)) {
    out.push({ field: "MU_STATE_DIR", pane: pane.state, now: stateNow });
  }
  if (syncNow !== "" && (pane.sync === "" || syncNow !== resolve(pane.sync))) {
    out.push({ field: "MU_SYNC_DIR", pane: pane.sync === "" ? "(off)" : pane.sync, now: syncNow });
  }
  return out;
}

/** defaultStateDir() reads process.env; resolve against `env` when it is another object. */
function defaultStateDirFor(env: NodeJS.ProcessEnv): string {
  if (env === process.env) return defaultStateDir();
  const saved = process.env.MU_STATE_DIR;
  const key = "MU_STATE_DIR";
  delete process.env[key];
  try {
    return defaultStateDir();
  } finally {
    if (saved !== undefined) process.env.MU_STATE_DIR = saved;
  }
}

/** True when MU_ALLOW_FOREIGN_DB=1 lifts the guard. */
export function foreignDbAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_FOREIGN_DB_VAR] === "1";
}

/** The one stderr line (and the refusal's message). */
export function paneEnvMessage(m: readonly PaneEnvMismatch[]): string {
  const diffs = m.map((d) => `${d.field} ${d.now} (pane: ${d.pane})`).join("; ");
  return `this mu's env differs from its pane's (${PANE_ENV_VAR}): ${diffs}. A shell rc re-sourced by the agent CLI likely reset it; reads work, writes and sync are refused (set ${ALLOW_FOREIGN_DB_VAR}=1 to override). See docs/guide/other-agent-clis.md`;
}

/** A write in a run whose env differs from its pane's. Exit 4; nothing was written. */
export class PaneEnvMismatchError extends Error {
  override readonly name = "PaneEnvMismatchError";
  constructor(readonly mismatches: readonly PaneEnvMismatch[]) {
    super(paneEnvMessage(mismatches));
  }
}
