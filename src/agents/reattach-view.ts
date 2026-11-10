// mu — a detached plugin job's view (plugins spec D3): the job outlives its pane.
// `agent reattach` on a row whose view is gone asks the kind for a new view
// (`job.attach`) and compares-and-sets `agents.pane_id`, keeping the
// incarnation and everything else the row holds. A no-row leftover of a plugin
// kind is never reattached: `agent close` stops it.

import { getAgent } from "../agents.js";
import { type CarrierJob, getCarrierJobByAgent } from "../carrier-jobs.js";
import type { Db } from "../db.js";
import { HostSpawnUnsupportedError } from "../hosts.js";
import { viewPresent } from "../jobs/view.js";
import { emitEvent } from "../logs.js";
import { activeMux } from "../mux.js";
import { type PluginJobKind, pluginJobKind, pluginJobRef } from "../plugins/job.js";
import { agentRevision, assertRevision } from "../revision.js";
import { shellWord } from "../shell-quote.js";
import { AgentReplacedError } from "./errors.js";
import { withAgentLock } from "./lock.js";
import { closeCommand, ReattachRefusedError } from "./reattach-check.js";
import { withSpawnLock } from "./spawn-lock.js";

/** The agent's detached plugin job: its record and kind; undefined for any other agent. */
export function detachedJob(
  db: Db,
  ws: string,
  name: string,
): { r: CarrierJob; kind: PluginJobKind; agentId: number; paneId: string } | undefined {
  const row = getAgent(db, name, ws);
  const r = row === undefined ? undefined : getCarrierJobByAgent(db, row.incarnation);
  const kind = r?.plugin == null ? undefined : pluginJobKind(db, r.plugin);
  if (row === undefined || r === undefined || kind?.caps.view !== "detached") return undefined;
  return { r, kind, agentId: row.incarnation, paneId: row.paneId };
}

const facts = (ws: string, d: NonNullable<ReturnType<typeof detachedJob>>) => ({
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
  const d = detachedJob(db, ws, name);
  if (d === undefined) return undefined;
  if (await viewPresent(d.paneId)) refuseOpen(db, ws, name, d.paneId);
  return { ...facts(ws, d), revision: agentRevision(db, ws, name) };
}

function refuseOpen(db: Db, ws: string, name: string, paneId: string): never {
  throw new ReattachRefusedError(
    name,
    [{ code: "row", detail: `its view ${paneId} is still open: attach to it` }],
    closeCommand(db, ws, name),
  );
}

/** The new view by `job.attach`, then the row's pane by compare-and-set. */
export async function reattachView(db: Db, ws: string, name: string, opts: { ifRevision: number }) {
  const session = `mu-${ws}`;
  return withAgentLock(db, ws, name, () =>
    withSpawnLock(session, async () => {
      const d = detachedJob(db, ws, name);
      if (d === undefined) throw new AgentReplacedError(name, ws);
      assertRevision(opts.ifRevision, agentRevision(db, ws, name), {
        subject: `agent ${name}`,
        previewCommand: `mu agent reattach ${shellWord(name)} -w ${shellWord(ws)}`,
      });
      if (await viewPresent(d.paneId)) refuseOpen(db, ws, name, d.paneId);
      const ref = pluginJobRef(db, d.r.token);
      if (ref === undefined) throw new AgentReplacedError(name, ws);
      const mux = await activeMux();
      // A view runs a command line: refused before any call where the backend cannot (D3).
      if (!mux.runsShellCommand) throw new HostSpawnUnsupportedError(d.r.host, mux.name);
      const view = await d.kind.attach(db, ref);
      let onCreated: (pid: string) => void = () => {};
      const created = new Promise<string>((res) => {
        onCreated = res;
      });
      const done = mux.spawnAgent({
        session,
        window: name,
        name,
        cli: getAgent(db, name, ws)?.cli ?? "pi",
        command: `exec </dev/null; ${view.command}`,
        commandSource: "explicit",
        ...(view.cwd !== undefined ? { cwd: view.cwd } : {}),
        env: view.env,
        onPaneCreated: onCreated,
      });
      done.catch(() => {});
      const pid = await Promise.race([created, done]);
      try {
        // The backend's own completion: a view that failed is never the row's pane.
        await done;
        db.transaction(() => {
          const row = db
            .prepare("UPDATE agents SET pane_id = ?, updated_at = ? WHERE id = ? AND pane_id = ?")
            .run(pid, new Date().toISOString(), d.agentId, d.paneId);
          const job = db
            .prepare("UPDATE carrier_jobs SET pane_id = ? WHERE token = ? AND agent_id = ?")
            .run(pid, d.r.token, d.agentId);
          if (row.changes !== 1 || job.changes !== 1) throw new AgentReplacedError(name, ws);
        }).immediate();
      } catch (e) {
        await mux.killPane(pid).catch(() => {});
        throw e;
      }
      emitEvent(
        db,
        ws,
        "agent.reattach",
        `agent reattach ${name} (host=${d.r.host}, job=${d.r.job}, pane=${pid}, view)`,
      );
      return {
        ...facts(ws, d),
        agent_id: d.agentId,
        pane_id: pid,
        ready: true,
        ctl: "skipped" as const,
        claims: [],
      };
    }),
  );
}
