// mu — a plugin job's view when the job outlives its pane (plugins spec D3): a detached kind,
// or a bound file kind whose view (its job's dispatcher, ladder placement §10) died while the
// job runs, as a SIGKILLed mule carrier does. `agent reattach` on a row whose view is gone
// asks the kind for a new view (`job.attach`) and compares-and-sets `agents.pane_id`, keeping the
// incarnation and everything else the row holds; the spawn receipts naming the
// old view follow it (`repoint`), refused while the spawn that made it runs. A no-row leftover of a plugin
// kind is never reattached: `agent close` stops it.

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { getAgent } from "../agents.js";
import { type CarrierJob, getCarrierJobByAgent } from "../carrier-jobs.js";
import { bindView, dispatchView } from "../carrier-wire.js";
import { expectsCtl } from "../channels/select.js";
import { ctlSocketPath, remoteCtlSocketPath } from "../ctl/path.js";
import type { Db } from "../db.js";
import { proveViewGone } from "../host-policy.js";
import { HostHandbackError, HostSpawnUnsupportedError } from "../hosts.js";
import { jobLiveness, outlivesView } from "../jobs/kinds.js";
import {
  birthIdentity,
  birthServer,
  killView,
  serverBeforeBirth,
  viewPresent,
  viewRef,
} from "../jobs/view.js";
import { emitEvent } from "../logs.js";
import { type MuxBackend, markPaneHost } from "../mux/types.js";
import { activeMux } from "../mux.js";
import { PluginCallError } from "../plugins/errors.js";
import { type PluginJobKind, pluginJobKind, pluginJobRef } from "../plugins/job.js";
import { agentRevision, assertRevision } from "../revision.js";
import { shellWord } from "../shell-quote.js";
import { AgentReplacedError } from "./errors.js";
import { leaseJobFile } from "./lease-carrier.js";
import { withAgentLock } from "./lock.js";
import { closeCommand, ReattachFailedError, ReattachRefusedError } from "./reattach-check.js";
import { repointReceipts } from "./receipts.js";
import { withSpawnLock } from "./spawn-lock.js";
import { jobRecordActor, viewLine } from "./spawn-plugin.js";
import { awaitCtlHandshake } from "./spawn-ready.js";
import { refuseCarrierViewMux } from "./spawn-remote.js";

type ViewJob = {
  r: CarrierJob;
  kind: PluginJobKind;
  agentId: number;
  paneId: string;
  paneIdentity?: string;
};

function pluginJobOf(db: Db, ws: string, name: string): ViewJob | undefined {
  const row = getAgent(db, name, ws);
  const r = row === undefined ? undefined : getCarrierJobByAgent(db, row.incarnation);
  const kind = r?.plugin == null ? undefined : pluginJobKind(db, r.plugin);
  if (row === undefined || r === undefined || kind === undefined) return undefined;
  return { r, kind, agentId: row.incarnation, paneId: row.paneId, paneIdentity: row.paneIdentity };
}

/** The agent's detached plugin job: its record and kind; undefined for any other agent. */
export function detachedJob(db: Db, ws: string, name: string): ViewJob | undefined {
  const d = pluginJobOf(db, ws, name);
  return d?.kind.caps.view === "detached" ? d : undefined;
}

/**
 * The agent's plugin job whose view a reattach may replace (`outlivesView`): a detached kind,
 * or a bound file kind with its handle recorded (its view is the job's dispatcher, ladder
 * placement §10). Undefined for any other agent.
 */
export function viewJob(db: Db, ws: string, name: string): ViewJob | undefined {
  const d = pluginJobOf(db, ws, name);
  return d !== undefined && outlivesView(d.kind.caps, d.r) ? d : undefined;
}

async function detachedViewMux(host: string) {
  const mux = await activeMux();
  if (!mux.runsShellCommand) {
    throw new HostSpawnUnsupportedError(host, mux.name, "detached job view command");
  }
  refuseCarrierViewMux(mux, host, "a reattach");
  return mux;
}

const facts = (ws: string, d: ViewJob) => ({
  name: d.r.name,
  workstream: ws,
  host: d.r.host,
  job: d.r.job ?? "",
  previous_agent_id: d.agentId,
  previous_pane_id: d.paneId,
  recovery_id: null,
  cwd: null,
  base: null,
});

/** The preview: refused while the view is still there. */
export async function previewViewReattach(db: Db, ws: string, name: string) {
  const d = viewJob(db, ws, name);
  if (d === undefined) return undefined;
  const mux = await detachedViewMux(d.r.host);
  if (await viewPresent(d.paneId, mux, d.paneIdentity)) refuseOpen(db, ws, name, d.paneId);
  await refuseUnprovenView(db, ws, name, d, mux);
  await refuseEnded(db, ws, name, d);
  return { ...facts(ws, d), revision: agentRevision(db, ws, name) };
}

/**
 * A job that reads ended or lost has no view to open: refused before `job.attach`. A `human`
 * answer to the read (mule's job.status names the SSH master to open) is the host's hand-back,
 * as `job.attach`'s is: its remedy reaches the caller.
 */
async function refuseEnded(db: Db, ws: string, name: string, d: ViewJob): Promise<void> {
  const ref = pluginJobRef(db, d.r.token);
  if (ref === undefined) throw new AgentReplacedError(name, ws);
  const l = await jobLiveness(db, ref).catch((e: unknown) => {
    if (e instanceof PluginCallError && e.kind === "human") {
      throw new HostHandbackError(d.r.host, "exec", e.remedy ?? e.detail);
    }
    throw e;
  });
  if (l.state !== "ended" && l.state !== "lost") return;
  throw new ReattachRefusedError(
    name,
    [{ code: "carrier", detail: `its job ${d.r.job ?? "?"} on ${d.r.host} is ${l.state}` }],
    closeCommand(db, ws, name),
  );
}

/**
 * A file kind's view is its job's dispatcher (ladder placement §10): a replacement only once
 * every view its record knows of (a failed attempt's included) is proven gone.
 */
async function refuseUnprovenView(
  db: Db,
  ws: string,
  name: string,
  d: ViewJob,
  mux: MuxBackend,
): Promise<void> {
  if (d.kind.caps.handle !== "file") return;
  const p = await proveViewGone(d.r, mux);
  if (p.state === "gone") return;
  throw new ReattachRefusedError(
    name,
    [{ code: "row", detail: p.why }],
    closeCommand(db, ws, name),
  );
}

function refuseOpen(db: Db, ws: string, name: string, paneId: string): never {
  throw new ReattachRefusedError(
    name,
    [{ code: "row", detail: `its view ${paneId} is still open: attach to it` }],
    closeCommand(db, ws, name),
  );
}

/**
 * The new view by `job.attach`, then the row's pane by compare-and-set. A view on the built-in
 * ctl is ready only once its forward answers the handshake on the local socket.
 */
export async function reattachView(
  db: Db,
  ws: string,
  name: string,
  opts: { ifRevision: number; signal?: AbortSignal },
) {
  const prior = viewJob(db, ws, name);
  if (prior === undefined) throw new AgentReplacedError(name, ws);
  const mux = await detachedViewMux(prior.r.host);
  const session = `mu-${ws}`;
  const sock = ctlSocketPath(ws, name, dirname(db.name));
  const row = getAgent(db, name, ws);
  const onCtl = row !== undefined && expectsCtl(row, sock);
  const { d, pid, born } = await withAgentLock(db, ws, name, () =>
    withSpawnLock(session, async () => {
      const d = viewJob(db, ws, name);
      if (d === undefined) throw new AgentReplacedError(name, ws);
      assertRevision(opts.ifRevision, agentRevision(db, ws, name), {
        subject: `agent ${name}`,
        previewCommand: `mu agent reattach ${shellWord(name)} -w ${shellWord(ws)}`,
      });
      if (await viewPresent(d.paneId, mux, d.paneIdentity)) refuseOpen(db, ws, name, d.paneId);
      const file = d.kind.caps.handle === "file";
      await refuseUnprovenView(db, ws, name, d, mux);
      // Owner-only (D8): while its spawn runs, the spawn's receipts are its own to move.
      const actor = jobRecordActor(d.r);
      if (actor === "other-alive") {
        throw new ReattachRefusedError(
          name,
          [{ code: "carrier", detail: `its spawn's process ${d.r.creatorPid} is still running` }],
          closeCommand(db, ws, name),
        );
      }
      await refuseEnded(db, ws, name, d);
      // The old view is proved gone: a socket file it left (a SIGKILLed forward) is stale, and
      // would refuse the new forward's bind.
      if (onCtl) rmSync(sock, { force: true });
      const ref = pluginJobRef(db, d.r.token);
      if (ref === undefined) throw new AgentReplacedError(name, ws);
      // A file kind gets its job file again and, on ctl, the socket pair for this view (§10).
      const view = await d.kind.attach(db, ref, {
        jobFile: leaseJobFile(db, ws, name),
        ...(onCtl
          ? {
              sockets: {
                local: sock,
                remote: remoteCtlSocketPath(ws, name, process.getuid?.() ?? 0),
              },
            }
          : {}),
      });
      // `dispatching` before the mux is asked, in this locked section, on the revision the proof
      // above read: a backend may open the view and fail before reporting its id (unknown until
      // bound), and a rollback that began releasing the record since (it runs unlocked) wins.
      const rev = file ? dispatchView(db, d.r, ["claimed", "bound"]) : undefined;
      if (file && rev === undefined) {
        throw new ReattachRefusedError(
          name,
          [
            {
              code: "carrier",
              detail:
                "its job record moved during the reattach (a close or rollback is releasing it)",
            },
          ],
          closeCommand(db, ws, name),
        );
      }
      const before = rev === undefined ? undefined : await serverBeforeBirth(mux);
      let born: string | undefined;
      let onCreated: (pid: string) => void = () => {};
      const created = new Promise<string>((res) => {
        onCreated = res;
      });
      const done = mux.spawnAgent({
        session,
        window: name,
        name,
        cli: getAgent(db, name, ws)?.cli ?? "pi",
        // A kind with its own channel: stdin /dev/null. On a built-in channel the view stays
        // interactive, as at spawn (`hooks` pastes into it, `mux` types).
        command: viewLine(view.command, d.kind.caps.channel === undefined),
        commandSource: "explicit",
        ...(view.cwd !== undefined ? { cwd: view.cwd } : {}),
        env: view.env,
        onPaneCreated: (id, identity) => {
          born = identity;
          onCreated(id);
        },
      });
      done.catch(() => {});
      const pid = await Promise.race([created, done]);
      const identity = birthIdentity(mux, pid, born);
      // The attempted view is the record's from here (a file kind), with the server its creation
      // reported: what a close or the next reattach must prove gone, whatever becomes of the row.
      if (rev !== undefined) {
        const server = await birthServer(mux, born, before);
        if (bindView(db, { token: d.r.token, wireRev: rev }, pid, server) === undefined) {
          await killView(mux, pid, identity).catch(() => {});
          throw new AgentReplacedError(name, ws);
        }
      }
      await markPaneHost(mux, viewRef(mux, pid, born), d.r.host);
      try {
        // The backend's own completion: a view that failed is never the row's pane.
        await done;
        db.transaction(() => {
          const row = db
            .prepare(
              "UPDATE agents SET pane_id = ?, pane_identity = ?, updated_at = ? WHERE id = ? AND pane_id = ?",
            )
            .run(pid, identity ?? null, new Date().toISOString(), d.agentId, d.paneId);
          const job = db
            .prepare("UPDATE carrier_jobs SET pane_id = ? WHERE token = ? AND agent_id = ?")
            .run(pid, d.r.token, d.agentId);
          if (row.changes !== 1 || job.changes !== 1) throw new AgentReplacedError(name, ws);
          // The spawn receipts follow the view, as a lookup recovery's do: a replay still
          // names this incarnation, never a replaced one.
          repointReceipts(db, d.agentId, { pane: d.paneId }, pid, actor);
        }).immediate();
      } catch (e) {
        await killView(mux, pid, identity).catch(() => {});
        throw e;
      }
      return { d, pid, born };
    }),
  );
  let ctl: "skipped" | "ok" | "missing" | "refused" | "unknown" = "skipped";
  if (onCtl) {
    let scrollback: string | undefined;
    const alive = async (): Promise<void> => {
      scrollback =
        (await mux.capture(viewRef(mux, pid, born), { lines: 50 }).catch(() => undefined)) ??
        scrollback;
      if (!(await viewPresent(pid, mux, born))) throw new ViewGone();
    };
    try {
      ctl = (await awaitCtlHandshake(sock, alive, opts.signal)).ctl;
      if (ctl === "ok") await alive(); // the final check: a handshake ok on a dying view
    } catch (e) {
      if (opts.signal?.aborted === true) throw e;
      if (!(e instanceof ViewGone))
        ctl = "unknown"; // the mux probe threw: kept
      else {
        // The row names a gone view again, as before: its job runs, a reattach may retry.
        const why = `its new view ${pid} exited during the ctl handshake; job ${d.r.job} on ${d.r.host} still runs`;
        throw new ReattachFailedError(
          name,
          "view-gone",
          why,
          closeCommand(db, ws, name),
          scrollback,
        );
      }
    }
  }
  const ready = ctl === "ok" || ctl === "skipped";
  emitEvent(
    db,
    ws,
    "agent.reattach",
    `agent reattach ${name} (host=${d.r.host}, job=${d.r.job}, pane=${pid}, view, ctl=${ctl})`,
  );
  return { ...facts(ws, d), agent_id: d.agentId, pane_id: pid, ready, ctl, claims: [] };
}

class ViewGone extends Error {}
