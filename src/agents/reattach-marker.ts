// mu — `agent reattach`'s pending-carrier marker (spec docs/specs/2026-11-04-lease-adopt.md
// § mu_adopt, Apply 3): a file beside the name's agent lock, published before the pane is
// requested and removed only once the new pane is durably named (installed, or fenced on the
// reservation) or proven gone. A reattach that fails or dies in between leaves it, and the
// next preflight refuses while the pane it names may run. Unlike the lock it outlives its
// process: an unproven carrier is not released by a crash. Unreadable or malformed refuses.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Db } from "../db.js";
import { activeMux } from "../mux.js";
import { localPaneAlive } from "../remote-agent.js";
import { shellQuote } from "../shell-quote.js";
import { agentLockPath } from "./lock.js";

export const markerPath = (db: Db, ws: string, name: string): string =>
  agentLockPath(db, ws, name).replace(/\.lock$/, ".reattach-pending");

/** `none`, `stale` (its pane proven gone), or the refusal's detail while a carrier may run. */
export async function readMarker(
  db: Db,
  ws: string,
  name: string,
): Promise<string | "none" | "stale"> {
  const path = markerPath(db, ws, name);
  let m: { job?: unknown; pane?: unknown } | undefined;
  try {
    m = JSON.parse(readFileSync(path, "utf8")) ?? undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "none";
  }
  const left = `an unfinished reattach left ${path}`;
  // The DB directory is the operator's and may hold a space or a quote: paste-safe.
  const rm = `once no carrier of its job runs: rm -- ${shellQuote(path)}`;
  if (typeof m?.job !== "string") return `${left}, unreadable or malformed; ${rm}`;
  const pane = m.pane;
  if (typeof pane !== "string" || !(await activeMux()).isValidPaneId(pane)) {
    return `${left}: its pane request for job ${m.job} may have opened a pane it never named; ${rm}`;
  }
  const alive = await localPaneAlive(pane).catch(() => undefined);
  if (alive === false) return "stale";
  const state = alive ? "alive" : "unknown";
  return `${left}: its pane ${pane} (${state}) may run job ${m.job}; close that pane, or ${rm}`;
}

/** Before the pane request; throws (no pane may open) when it cannot be written exclusively. */
export function publishMarker(db: Db, ws: string, name: string, job: string, stale: boolean): void {
  const path = markerPath(db, ws, name);
  if (stale) rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify({ job, pid: process.pid }), { flag: "wx" });
}

/** Name the pane once known. A failed write keeps the pending marker: it still refuses. */
export function markerPane(db: Db, ws: string, name: string, job: string, pane: string): void {
  try {
    writeFileSync(markerPath(db, ws, name), JSON.stringify({ job, pid: process.pid, pane }));
  } catch {}
}

/** After a durable install or fence, or the pane proven gone. A failed remove stays fail-closed. */
export function clearMarker(db: Db, ws: string, name: string): void {
  try {
    rmSync(markerPath(db, ws, name), { force: true });
  } catch {}
}
