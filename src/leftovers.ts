// mu — leftovers: the work of agents whose rows are gone, as `mu agent list` shows it (spec
// docs/specs/2026-11-04-lease-adopt.md § G4 mu_list). A `lease-job` is a reservation whose
// agent is gone (a remote recovery record of the same incarnation folds into it); a
// `recovery` is any other record of the workstream. Each carries one `next`, a read-only
// preview. Reads the DB, local files and one mux probe per reservation (`reattachBlockers`,
// so the verb and its leftover agree); never a host command.

import { readFileSync } from "node:fs";
import { leaseJobFile, stopFailedPath } from "./agents/lease-carrier.js";
import { reattachBlockers } from "./agents/reattach-check.js";
import { type CarrierJob, listCarrierJobs } from "./carrier-jobs.js";
import type { Db } from "./db.js";
import { pc } from "./output.js";
import { listRemoteRecoveries } from "./remote-recovery.js";
import { shellWord } from "./shell-quote.js";

/** One leftover; keys follow SQL names (surface contract). */
export interface Leftover {
  kind: "lease-job" | "recovery";
  name: string;
  host: string;
  /** The reservation's handle (lease-job). */
  job: string | null;
  /** The reaped incarnation. */
  agent_id: number | null;
  /** The record folded in, or the record itself. */
  recovery_id: number | null;
  /** The stop-failure record's line, escaped, cut at 160 chars with ` cut=<n>`. */
  stop_failed: string | null;
  /** One command, executable as printed. */
  next: string;
}

/**
 * Every reservation whose agent is gone (its row deleted) or never bound (no row of the
 * name), in workstream `ws` or, without it, everywhere (doctor's `lease-job` hint). Read only.
 */
export function goneReservations(db: Db, ws?: string): CarrierJob[] {
  const agentIds = new Set(
    (db.prepare("SELECT id FROM agents").all() as { id: number }[]).map((r) => r.id),
  );
  const named = db.prepare(
    `SELECT 1 FROM agents a JOIN workstreams w ON w.id = a.workstream_id
      WHERE w.name = ? AND a.name = ?`,
  );
  return listCarrierJobs(db).filter(
    (j) =>
      (ws === undefined || j.workstream === ws) &&
      (j.agentId === null
        ? named.get(j.workstream, j.name) === undefined
        : !agentIds.has(j.agentId)),
  );
}

const STOP_FAILED_CHARS = 160;

/**
 * `job`'s stop-failure record, escaped and cut, or null when it is absent, unreadable or
 * does not start with `<job> ` (another id's content is never shown). Read only.
 */
export function readStopFailed(jobFile: string, job: string): string | null {
  let text: string;
  try {
    text = readFileSync(stopFailedPath(jobFile, job), "utf8");
  } catch {
    return null;
  }
  if (!text.startsWith(`${job} `)) return null;
  const chars = Array.from(JSON.stringify(text.replace(/\n$/, "")).slice(1, -1));
  if (chars.length <= STOP_FAILED_CHARS) return chars.join("");
  const cut = chars.length - STOP_FAILED_CHARS;
  return `${chars.slice(0, STOP_FAILED_CHARS).join("")} cut=${cut}`;
}

/** The leftovers of workstream `ws`: lease-jobs by reservation, then the unfolded records. */
export async function listLeftovers(db: Db, ws: string): Promise<Leftover[]> {
  const recs = listRemoteRecoveries(db).filter((r) => r.workstream === ws);
  const w = shellWord(ws);
  const close = (name: string, rec: number | undefined) =>
    `mu agent close ${shellWord(name)} -w ${w}${rec === undefined ? "" : ` --recovery ${rec}`}`;
  const folded = new Set<number>();
  const out: Leftover[] = [];
  for (const r of goneReservations(db, ws)) {
    const rec = recs.find((x) => r.agentId !== null && x.agentId === r.agentId);
    if (rec !== undefined) folded.add(rec.agentId);
    const clear = (await reattachBlockers(db, ws, r.name)).length === 0;
    // Several records of the name: name the folded one; with none folded the bare close lists them.
    const many = recs.filter((x) => x.name === r.name).length > 1;
    out.push({
      kind: "lease-job",
      name: r.name,
      host: r.host,
      job: r.job,
      agent_id: r.agentId,
      recovery_id: rec?.agentId ?? null,
      stop_failed: r.job === null ? null : readStopFailed(leaseJobFile(db, ws, r.name), r.job),
      next: clear
        ? `mu agent reattach ${shellWord(r.name)} -w ${w}`
        : close(r.name, many ? rec?.agentId : undefined),
    });
  }
  for (const rec of recs) {
    if (folded.has(rec.agentId)) continue;
    // Always `--recovery`: a bare close would address a live agent of the same name.
    out.push({
      kind: "recovery",
      name: rec.name,
      host: rec.host,
      job: null,
      agent_id: rec.agentId,
      recovery_id: rec.agentId,
      stop_failed: null,
      next: close(rec.name, rec.agentId),
    });
  }
  return out;
}

/** `agent list --table`'s section after the orphan panes; nothing when there are none. */
export function leftoverLines(items: readonly Leftover[]): string[] {
  if (items.length === 0) return [];
  const line = (l: Leftover) =>
    `  ${l.name}  ${l.kind} on ${l.host}${l.job === null ? "" : ` job=${l.job}`}${
      l.recovery_id === null ? "" : ` recovery=${l.recovery_id}`
    }${l.stop_failed === null ? "" : ` stop failed: ${l.stop_failed}`}  → ${l.next}`;
  return [
    "",
    pc.yellow(`Leftovers (${items.length})`),
    pc.dim("  Work of agents whose rows are gone. Run each one's next."),
    ...items.map(line),
  ];
}
