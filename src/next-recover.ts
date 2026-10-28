// mu — `executeNext` slice B (recovery): which authorised workers died and
// which stopped on an API error, and the one safe move for each.
//
// A worker that DIED (its pane is gone: `status null`, an authoritative
// liveness reading) is reaped through `deleteAgent` with the saved registry id
// + pane as the compare-and-swap, never a new reaper: the task reopens with
// the reaper's note, and the ordinary allocation then retries it as a NEW
// attempt (a new charge, a brief that says the previous attempt died). A
// worker that is ALIVE but whose last settled run ended in an API error is
// never reaped, replaced or duplicated: it is retried IN PLACE (`reserveRetry`
// in src/auto-attempt.ts): one run charged, the stored brief sent again to the
// same pane under a reserved msgId bound to pi's incarnation, over the
// journaled send of `spawnAutoAttempt` (a send that may have landed is only
// ever probed, never resent). The error text lives only on the ctl `wait`
// reply (a status read does not carry it), so it is read there, bounded.
//
// Never acted on, only reported (`attention`): a remote worker (its tree and
// host channel are not ours to reap or collect; the recovery record keeps
// the tree), an error at the run ceiling or with no run baseline, and any
// reading that is not authoritative (`unknown` is degraded observation, never
// permission). A busy, pending, dialog-blocked or merely idle worker is left
// to the wait engine (steer, input). Pure observation here: the effects are
// executeNext's, each re-validated in its own transaction.

import type { RuntimeState } from "./agent-state.js";
import { observeAgentStates, watchAgentRun } from "./agents/observe.js";
import { savedIdentity } from "./agents/task-spawn.js";
import { agentCtlSocket, expectsCtl } from "./agents/transport.js";
import type { AgentRow } from "./agents.js";
import { deliveredOf, type RetryTarget } from "./auto-attempt.js";
import { getCarrierJob } from "./carrier-jobs.js";
import type { CtlBlocked } from "./ctl/protocol.js";
import type { Db } from "./db.js";
import { say } from "./messages.js";
import { localMachineId } from "./segments.js";
import { autoPermitted, getAutoConfig } from "./task-auto.js";

/** What one observation of a worker says (only what the decision uses). */
export interface WorkerFacts {
  /** null = the pane is gone. */
  status: RuntimeState | null;
  ctl?: "ok" | "missing" | "refused";
  pending?: boolean;
  blocked?: CtlBlocked;
  /** pi's process incarnation. */
  incarnation?: string;
  /** The settled run's count when `lastError` was read, else the current count. */
  runs?: number;
  /** The error that ended the latest settled run (ctl `wait` reply only). */
  lastError?: string;
}

/** Reads the facts of `agents` (keyed `<workstream>/<name>`), within `ms`. Injected by tests. */
export type ObserveWorkers = (
  agents: readonly AgentRow[],
  opts: { signal?: AbortSignal; ms: number },
) => Promise<ReadonlyMap<string, WorkerFacts>>;

/** The ctl `wait` that reads a settled run's error: a reply is immediate, so this only bounds a dead socket. */
export const OBSERVE_MS = 3000;

/** Idle on a healthy control socket: nothing queued, no dialog. The only state a worker's last error is acted on from. */
export const idleOnCtl = (
  f: Pick<WorkerFacts, "status" | "ctl" | "pending" | "blocked">,
): boolean =>
  f.status === "needs_input" && f.ctl === "ok" && f.pending !== true && f.blocked === undefined;

export const workerKey = (a: Pick<AgentRow, "workstreamName" | "name">): string =>
  `${a.workstreamName}/${a.name}`;

/** The production reader: one batched state read, then the error of each idle pi worker. */
export const observeWorkers =
  (db: Db): ObserveWorkers =>
  async (agents, { signal, ms }) => {
    const states = await observeAgentStates(db, agents);
    const out = new Map<string, WorkerFacts>();
    await Promise.all(
      agents.map(async (agent) => {
        const key = workerKey(agent);
        const s = states.get(key);
        if (s === undefined) return;
        const facts: WorkerFacts = {
          status: s.status,
          ...(s.ctl !== undefined ? { ctl: s.ctl } : {}),
          ...(s.pending !== undefined ? { pending: s.pending } : {}),
          ...(s.blocked !== undefined ? { blocked: s.blocked } : {}),
          ...(s.incarnation !== undefined ? { incarnation: s.incarnation } : {}),
          ...(s.runs !== undefined ? { runs: s.runs } : {}),
        };
        out.set(key, facts);
        const sock = agentCtlSocket(db, agent);
        if (!idleOnCtl(s) || s.runs === undefined || s.runs < 1 || !expectsCtl(agent, sock)) return;
        // A settled run is answered at once: the bound only covers a socket that stops answering.
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), ms);
        const onAbort = (): void => stop.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const watch = await watchAgentRun(agent, sock, stop.signal, {
            afterRuns: s.runs - 1,
            ...(s.incarnation !== undefined ? { inc: s.incarnation } : {}),
          });
          if (watch === undefined) return;
          const settled = await watch.settled;
          if (settled.settled) {
            out.set(key, {
              ...facts,
              ...(settled.runs !== undefined ? { runs: settled.runs } : {}),
              ...(settled.incarnation !== undefined ? { incarnation: settled.incarnation } : {}),
              ...(settled.lastError !== undefined ? { lastError: settled.lastError } : {}),
            });
          }
        } catch {
          // A restarted pi, a dropped socket: no error read, and no action on a guess.
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      }),
    );
    return out;
  };

export type RecoveryAction =
  | { kind: "reap"; task: string; agent: AgentRow; why: string }
  | { kind: "retry"; task: string; target: RetryTarget; error: string }
  | { kind: "attention"; task: string; reason: string; agent?: string };

/** A task whose delivered attempt's worker still owns it. */
export interface InFlightWorker {
  task: string;
  taskId: number;
  agent: AgentRow;
  /** The delivered attempt's run baseline and pi process, for a receipt-bound wait. */
  runs: number | null;
  incarnation: string | null;
}

/**
 * The permitted IN_PROGRESS tasks of `workstream` held by the very registry row
 * (id + pane) their latest DELIVERED attempt saved. Anything else (not ours,
 * replaced, ended, a task a human claimed) is not recovered here.
 */
export function inFlightWorkers(db: Db, workstream: string): InFlightWorker[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.local_id AS local_id
         FROM task_auto a
         JOIN tasks t ON t.id = a.task_id
         JOIN workstreams w ON w.id = t.workstream_id AND w.name = ?
        WHERE a.enabled = 1 AND t.kind = 'work' AND t.dispatch_host = ?
          AND t.status = 'IN_PROGRESS' AND t.owner_id IS NOT NULL
        ORDER BY t.id`,
    )
    .all(workstream, localMachineId(db)) as { id: number; local_id: string }[];
  const out: InFlightWorker[] = [];
  for (const r of rows) {
    if (!autoPermitted(db, r.id)) continue;
    const delivered = deliveredOf(db, r.id);
    if (delivered === undefined) continue;
    const { receipt } = delivered;
    const id = savedIdentity(db, receipt);
    if (id.agent === undefined) continue;
    const owner = db.prepare("SELECT owner_id FROM tasks WHERE id = ?").get(r.id) as {
      owner_id: number | null;
    };
    if (owner.owner_id !== id.agent.incarnation) continue;
    out.push({
      task: r.local_id,
      taskId: r.id,
      agent: id.agent,
      runs: receipt.runs,
      incarnation: receipt.incarnation,
    });
  }
  return out;
}

/** Delivered attempts whose worker is gone and whose task is open again, but with no run left: the retry that cannot happen. */
export function exhaustedAfterDeath(
  db: Db,
  workstream: string,
): { task: string; reason: string }[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.local_id AS local_id, a.max_runs AS max
         FROM task_auto a
         JOIN tasks t ON t.id = a.task_id
         JOIN workstreams w ON w.id = t.workstream_id AND w.name = ?
        WHERE a.enabled = 1 AND t.kind = 'work' AND t.dispatch_host = ?
          AND t.status = 'OPEN' AND a.runs >= a.max_runs
        ORDER BY t.id`,
    )
    .all(workstream, localMachineId(db)) as { id: number; local_id: string; max: number }[];
  const out: { task: string; reason: string }[] = [];
  for (const r of rows) {
    if (!autoPermitted(db, r.id)) continue;
    const delivered = deliveredOf(db, r.id);
    if (delivered === undefined) continue;
    if (savedIdentity(db, delivered.receipt).stale === undefined) continue;
    out.push({
      task: r.local_id,
      reason: `its worker is gone and it used its ${r.max} run(s): raise the ceiling (mu task auto --max) or take it over`,
    });
  }
  return out;
}

/**
 * Observe every in-flight worker once and decide (no writes, no mux effects
 * beyond the reads). The decision, per worker:
 *   pane gone, local            reap (the CAS is deleteAgent's, at the effect)
 *   pane gone, remote           attention: the tree is not ours to touch
 *   alive, last run API error   retry in place (needs a run baseline, a pi
 *                               incarnation, a free run and a local host)
 *   anything else               nothing (busy, dialog, pending, idle, unknown)
 */
export async function scanRecovery(
  db: Db,
  workstream: string,
  observe: ObserveWorkers,
  opts: { signal?: AbortSignal; ms?: number } = {},
): Promise<RecoveryAction[]> {
  const workers = inFlightWorkers(db, workstream);
  const out: RecoveryAction[] = [];
  if (workers.length > 0) {
    const facts = await observe(
      workers.map((w) => w.agent),
      { ...(opts.signal !== undefined ? { signal: opts.signal } : {}), ms: opts.ms ?? OBSERVE_MS },
    );
    for (const w of workers) {
      const f = facts.get(workerKey(w.agent));
      if (f === undefined) continue;
      if (f.status === null) {
        if (w.agent.host !== null) {
          // A lease worker's pane death is not its job's death: name the handle to stop.
          const job = getCarrierJob(db, w.agent.incarnation);
          out.push({
            kind: "attention",
            task: w.task,
            agent: w.agent.name,
            reason:
              job !== undefined
                ? say("carrier.dead_worker", w.agent.name, job.host, job.job)
                : `remote worker ${w.agent.name} on ${w.agent.host} has no pane: its tree is kept, not reaped (mu agent collect, then close it)`,
          });
        } else {
          out.push({
            kind: "reap",
            task: w.task,
            agent: w.agent,
            why: "its pane is gone",
          });
        }
        continue;
      }
      if (f.lastError === undefined) continue;
      if (!idleOnCtl(f)) continue;
      const attention = (reason: string): void => {
        out.push({ kind: "attention", task: w.task, agent: w.agent.name, reason });
      };
      if (w.agent.host !== null) {
        attention(`remote worker ${w.agent.name} stopped on an API error: not retried from here`);
        continue;
      }
      if (f.incarnation === undefined || f.runs === undefined || w.runs === null) {
        attention(
          `${w.agent.name} stopped on an API error but no run baseline or pi incarnation is known: not retried`,
        );
        continue;
      }
      if (f.runs <= w.runs) continue; // the error run was already answered
      const auto = getAutoConfig(db, w.taskId);
      if (auto !== undefined && auto.runs >= auto.maxRuns) {
        attention(
          `${w.agent.name} stopped on an API error and ${w.task} used its ${auto.maxRuns} run(s): raise the ceiling (mu task auto --max) or take it over`,
        );
        continue;
      }
      out.push({
        kind: "retry",
        task: w.task,
        error: f.lastError,
        target: {
          agent: { incarnation: w.agent.incarnation, paneId: w.agent.paneId, name: w.agent.name },
          pi: f.incarnation,
          errorRuns: f.runs,
        },
      });
    }
  }
  return out;
}

/**
 * Workers occupying a slot of `workstream`: registered agents that own an
 * IN_PROGRESS task, or hold an executor attempt in flight (pane up, not yet
 * delivered or unconfirmed) for a task that is not CLOSED. An idle worker whose
 * task is CLOSED (its close not yet reaped) is FREE: the slot is what is
 * working, not what still has a pane. A dead pane counts until reaped (the
 * recovery scan runs first).
 */
export function liveWorkers(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agents a
         JOIN workstreams w ON w.id = a.workstream_id AND w.name = ?
        WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.owner_id = a.id AND t.status = 'IN_PROGRESS')
           OR EXISTS (SELECT 1 FROM spawn_receipts r JOIN tasks t ON t.id = r.task_id
                       WHERE r.agent_id = a.id AND r.pane_id = a.pane_id
                         AND r.attempt_key LIKE 'auto:%'
                         AND r.state IN ('pane', 'claimed', 'sending', 'unknown')
                         AND t.status != 'CLOSED')`,
    )
    .get(workstream) as { n: number };
  return row.n;
}
