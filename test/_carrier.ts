// Test helper: a FILLED carrier_jobs reservation (launched, handle known), as a lease
// spawn's handshake leaves it. Optionally bound to an agent incarnation.

import {
  bindCarrierJobAgent,
  type CarrierJob,
  fillCarrierJob,
  getCarrierJob,
  markCarrierLaunch,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import type { Db } from "../src/db.js";

export function filledReservation(
  db: Db,
  a: {
    workstream: string;
    name: string;
    host: string;
    job: string;
    hostStop: string;
    agentId?: number;
    paneId?: string;
  },
): CarrierJob {
  const r = reserveCarrierJob(db, a);
  if (r === undefined) throw new Error(`${a.workstream}/${a.name} is reserved already`);
  markCarrierLaunch(db, r.token);
  if (a.agentId !== undefined) bindCarrierJobAgent(db, r.token, a.agentId, a.paneId ?? "%1");
  fillCarrierJob(db, r.token, a.job);
  const out = getCarrierJob(db, r.token);
  if (out === undefined) throw new Error("reservation vanished");
  return out;
}
