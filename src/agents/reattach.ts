// mu — `mu agent reattach <name> --if <rev>` (spec docs/specs/2026-11-04-lease-adopt.md
// § mu_adopt): under the agent and spawn locks, the profile's `attach` in a new pane, then ONE
// transaction installs the row, rebinds the reservation and drops the tree's record. A pane
// then proven not running is rolled back, compare-and-set on the new incarnation.

import { rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { deleteAgent, insertAgent } from "../agents.js";
import { rebindCarrierJobAgent } from "../carrier-jobs.js";
import { ctlSocketPath, remoteCtlSocketPath } from "../ctl/path.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { say } from "../messages.js";
import { activeMux } from "../mux.js";
import { attachCommand, localPaneAlive } from "../remote-agent.js";
import { deleteRemoteRecovery, restoreRemoteRecovery } from "../remote-recovery.js";
import { assertRevision } from "../revision.js";
import { isScratchWorkstream } from "../workstream.js";
import { withAgentLock } from "./lock.js";
import {
  type Blocker,
  closeCommand,
  factsOf,
  type Plan,
  planSnapshot,
  ReattachRefusedError,
  recoveryBlocker,
} from "./reattach-check.js";
import { clearMarker, markerPane, markerPath, publishMarker } from "./reattach-marker.js";
import { spawnerFromEnv } from "./spawn.js";
import { withSpawnLock } from "./spawn-lock.js";
import { awaitCtlHandshake } from "./spawn-ready.js";

export * from "./reattach-check.js";

type Rollback = "pane-killed" | "pane-unknown" | "restored" | "already-handled" | "left-for-reap";

/** The new carrier did not take; `rollback` says what mu did about it. Exit 4. */
export class ReattachFailedError extends Error {
  override readonly name = "ReattachFailedError";
  constructor(
    public readonly agentName: string,
    public readonly rollback: Rollback,
    why: string,
    close: string,
    scrollback = "",
  ) {
    const tail = scrollback.trim() === "" ? "" : say("agent.scrollback", scrollback.trim());
    super(say("agent.reattach_failed", agentName, rollback, why, close, tail));
  }
}

class PaneGone extends Error {}

/** Install found the recovery's path owned or claimed: the preflight's blocker, found late. */
class InstallBlocked extends Error {
  constructor(readonly blocker: Blocker) {
    super(blocker.detail);
  }
}

/**
 * `agent reattach --if <rev>`. Refuses (ReattachRefusedError, AgentExistsError,
 * RevisionMismatchError) before any effect, and ReattachRefusedError too when install finds
 * the recovery's path taken and the new pane is proven killed; ReattachFailedError when the
 * new carrier did not take. A signal during readiness rethrows with the row kept.
 */
export async function reattachAgent(
  db: Db,
  ws: string,
  name: string,
  opts: { ifRevision: number; signal?: AbortSignal },
) {
  const sock = ctlSocketPath(ws, name, dirname(db.name));
  const mux = await activeMux();
  const session = `mu-${ws}`;
  const { p, pid, row } = await withAgentLock(db, ws, name, () =>
    withSpawnLock(session, async () => {
      const { p, revision } = await planSnapshot(db, ws, name);
      assertRevision(opts.ifRevision, revision, {
        subject: `agent ${name}`,
        previewCommand: `mu agent reattach ${name} -w ${ws}`,
      });
      opts.signal?.throwIfAborted();
      rmSync(sock, { force: true });
      const remoteSock = remoteCtlSocketPath(ws, name, process.getuid?.() ?? 0);
      const a = { job: p.r.job, jobFile: p.jobFile, localSock: sock, remoteSock };
      // As spawn: forward the caller's ssh agent (a file-type check, never a probe).
      const ssh = process.env.SSH_AUTH_SOCK ?? "";
      const env: Record<string, string> = statSync(ssh, { throwIfNoEntry: false })?.isSocket()
        ? { SSH_AUTH_SOCK: ssh }
        : {};
      if (isScratchWorkstream(ws)) await mux.ensureSession(session);
      // The pending-carrier marker, before the pane is requested: no pane without it.
      try {
        publishMarker(db, ws, name, p.r.job, p.staleMarker);
      } catch (e) {
        const detail = `its pending-carrier marker could not be written, so no pane was opened (${e instanceof Error ? e.message : e})`;
        throw new ReattachRefusedError(
          name,
          [{ code: "carrier", detail }],
          closeCommand(db, ws, name),
        );
      }
      let onPaneCreated: (id: string) => void = () => {};
      const created = new Promise<string>((res) => {
        onPaneCreated = (id) => {
          markerPane(db, ws, name, p.r.job, id);
          res(id);
        };
      });
      const done = mux.spawnAgent({
        ...{ session, window: name, name, cli: "pi", env, onPaneCreated },
        ...{ command: attachCommand(p.profile, a), commandSource: "cli-key" },
      });
      done.catch(() => {});
      const pid = await Promise.race([created, done]);
      try {
        const row = install(db, ws, p, pid);
        clearMarker(db, ws, name); // the row and the reservation name the pane now
        return { p, pid, row };
      } catch (e) {
        // A carrier must not hold a job with no row: its death stops the job (its signal path).
        // The reservation names the new pane first (the old one is proven dead), so while the
        // kill is unproven the next preflight probes THIS pane and refuses while it may run.
        // The fence can fail on the very writer lock that failed install: it never skips the
        // kill, and an unproven kill retries it once (the writer may be done by then).
        const fence = (): boolean => {
          try {
            return rebindCarrierJobAgent(db, p.r, p.r, { agentId: p.r.agentId, paneId: pid });
          } catch {
            return false;
          }
        };
        let fenced = fence();
        await mux.killPane(pid).catch(() => {});
        const gone = (await localPaneAlive(pid).catch(() => undefined)) === false;
        if (!gone && !fenced) fenced = fence();
        // Named on the reservation or proven gone: the next preflight sees it without the marker.
        if (gone || fenced) clearMarker(db, ws, name);
        if (e instanceof InstallBlocked && gone) {
          // The new pane is gone and nothing else moved: the preflight's refusal, found late.
          const detail = `${e.blocker.detail} (found at install; its new pane ${pid} was killed)`;
          const blockers = [{ ...e.blocker, detail }];
          throw new ReattachRefusedError(name, blockers, closeCommand(db, ws, name));
        }
        const failed = `install failed (${e instanceof Error ? e.message : e})`;
        const why = gone
          ? `${failed}; its pane ${pid} was killed, so its signal path stops job ${p.r.job}`
          : fenced
            ? `${failed}; its pane ${pid} may still run job ${p.r.job} (the kill is not proven): close that pane, then reattach or close`
            : `${failed}; its pane ${pid} may still run job ${p.r.job} (the kill is not proven) and the reservation does not name it; the marker ${markerPath(db, ws, name)} makes a reattach refuse while it may run: close that pane`;
        const rollback = gone ? "pane-killed" : "pane-unknown";
        throw new ReattachFailedError(name, rollback, why, closeCommand(db, ws, name));
      }
    }),
  );
  let scrollback: string | undefined;
  const assertAlive = async (): Promise<void> => {
    scrollback = (await mux.capture(pid, { lines: 50 }).catch(() => undefined)) ?? scrollback;
    if (!(await localPaneAlive(pid))) throw new PaneGone();
  };
  let ctl: "ok" | "missing" | "refused" | "unknown";
  try {
    ctl = (await awaitCtlHandshake(sock, assertAlive, opts.signal)).ctl;
    if (ctl === "ok") await assertAlive(); // the final check: a handshake ok on a dying pane
  } catch (e) {
    if (opts.signal?.aborted === true) throw e;
    if (!(e instanceof PaneGone))
      ctl = "unknown"; // the mux probe threw: kept, reconcile decides
    else {
      const rollback = await rollbackReattach(db, p, row, pid);
      const why = `its new carrier ${pid} is not running (job ${p.r.job} on ${p.r.host} ended, or no master)`;
      throw new ReattachFailedError(name, rollback, why, closeCommand(db, ws, name), scrollback);
    }
  }
  const ready = ctl === "ok";
  if (ready) rmSync(`${p.jobFile}.${p.r.job}.stop-failed`, { force: true });
  const what = `host=${p.r.host}, job=${p.r.job}, pane=${pid}, ctl=${ctl}`;
  emitEvent(db, ws, "agent.reattach", `agent reattach ${name} (${what})`);
  return { ...factsOf(ws, p), agent_id: row, pane_id: pid, ready, ctl };
}
export type ReattachResult = Awaited<ReturnType<typeof reattachAgent>>;

/**
 * The install, one immediate transaction: the recovery's admission re-checked, then the row,
 * the reservation's rebind, the record's delete.
 */
function install(db: Db, ws: string, p: Plan, pid: string): number {
  const { r, rec } = p;
  return db
    .transaction(() => {
      const live = db.prepare("SELECT id FROM workstreams WHERE name = ? AND torn_down_at IS NULL");
      if ((live.get(ws) as { id: number } | undefined)?.id !== p.wsId) {
        throw new Error(`workstream ${ws} was torn down or created again`);
      }
      // Before the row: preflight 7 again, under the writer lock (its same-name check would
      // see the new row). Another workstream's spawn may have taken the path meanwhile.
      const blocked = recoveryBlocker(db, { name: r.name, host: r.host, wsId: p.wsId, rec });
      if (blocked !== undefined) throw new InstallBlocked(blocked);
      const { incarnation } = insertAgent(db, {
        ...{ reservation: r.token, name: r.name, workstream: ws, cli: "pi", paneId: pid },
        ...{ tab: r.name, cwd: rec?.cwd ?? null, base: rec?.base ?? null },
        ...{ collectedHead: rec?.collectedHead ?? null, repo: rec?.hostRepo ?? null },
        ...{ command: "pi", commandSource: "cli-key", spawner: spawnerFromEnv() },
        ...{ host: r.host, hostTransport: "lease" },
      });
      if (!rebindCarrierJobAgent(db, r, r, { agentId: incarnation, paneId: pid })) {
        throw new Error("the reservation changed");
      }
      if (rec !== undefined && !deleteRemoteRecovery(db, rec)) {
        throw new Error(`recovery ${rec.agentId} changed`);
      }
      return incarnation;
    })
    .immediate();
}

/** The readiness rollback: the new pane is proven not running, so it kills nothing. */
async function rollbackReattach(db: Db, p: Plan, incarnation: number, paneId: string) {
  const { r, rec } = p;
  try {
    return await withAgentLock(db, r.workstream, r.name, async () =>
      db
        .transaction((): Rollback => {
          // Gone already: a reap or close of the new row left everything consistent by agent id.
          const mine = { incarnation, paneId };
          if (!deleteAgent(db, r.name, r.workstream, mine, { preserve: false })) {
            return "already-handled";
          }
          if (rec !== undefined) restoreRemoteRecovery(db, rec);
          if (!rebindCarrierJobAgent(db, r, { agentId: incarnation, paneId }, r)) {
            throw new Error("the reservation moved");
          }
          return "restored";
        })
        .immediate(),
    );
  } catch {
    return "left-for-reap" as const; // rolled back: the new row stays; its reap keeps the tree
  }
}
