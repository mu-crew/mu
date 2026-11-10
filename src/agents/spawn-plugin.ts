// mu — the plugin spawn path (plugins spec D8): an agent on a host whose job kind
// is a plugin's (a provider host, or a `--plugin` profile whose plugin declares a
// job seam).
//
// Order, each step before the next one's effect:
//   refuse (honour or refuse, a kind with no channel, a view the backend cannot run, an
//   at-start kind with no prompt) -> the job record (the name fence; a provider host's
//   atomic admission) -> a placeholder row -> the site (a --worktree: pushed and made
//   from the caller's commit on a provider host) -> the `job.start` effect, written ahead
//   with the whole JobSpec (and an at-start kind's first prompt) -> the read-only view
//   pane and the row, the kind's channel recorded -> readiness: the start's baseline (an
//   at-start kind) or the channel's `baseline` within MU_SPAWN_JOB_MS.
// A failure after the start stops the job by its handle (`rollbackSpawn`, the job adapter's
// stop) before the tree and the record go. The view's stdin is /dev/null: every delivery
// goes through the channel's effects.

import { randomUUID } from "node:crypto";
import { type AgentRow, insertAgent, pendingPaneIdFor } from "../agents.js";
import {
  bindCarrierJobAgent,
  recordCarrierPane,
  recordJobTree,
  reserveCarrierJob,
} from "../carrier-jobs.js";
import { channelTarget } from "../channels/dispatch.js";
import { agentChannel } from "../channels/index.js";
import type { RunBaseline, SendResult } from "../channels/types.js";
import type { Db } from "../db.js";
import { harnessOfCli } from "../harnesses.js";
import type { HostView } from "../host-provider.js";
import { reserveProviderJob } from "../host-records.js";
import { HostProfileError, HostSpawnUnsupportedError, releaseHostChannel } from "../hosts.js";
import { defaultSpawnJobMs } from "../jobs/lease.js";
import type { JobSpec } from "../jobs/types.js";
import { emitEvent } from "../logs.js";
import { activeMux } from "../mux.js";
import type { PluginJobKind } from "../plugins/job.js";
import { prepareProviderWorktree } from "../remote-worktree.js";
import { gitToplevel } from "../vcs/git.js";
import { AgentExistsError } from "./errors.js";
import { withAgentLock } from "./lock.js";
import {
  finalizeAgentRow,
  type SpawnAgentOptions,
  type SpawnedAgent,
  type StagedWorktree,
} from "./spawn.js";
import { withSpawnLock } from "./spawn-lock.js";
import { admitRemoteSpawn, JobSpecUnsupportedError, refuseUnhonoured } from "./spawn-remote.js";
import { rollbackSpawn } from "./spawn-rollback.js";

/** The host's job kind when it is a plugin's: then spawn takes this path. */
export function pluginKindOf(host: HostView): PluginJobKind | undefined {
  const k = host.jobKind as Partial<PluginJobKind> | undefined;
  return typeof k?.plugin === "string" ? (host.jobKind as PluginJobKind) : undefined;
}

/** Refused before any effect (D8 honour or refuse, D3 where a view can run). */
async function refuse(host: HostView, kind: PluginJobKind, opts: SpawnAgentOptions): Promise<void> {
  refuseUnhonoured(host, kind, opts);
  const { caps } = kind;
  if (caps.channel === undefined) {
    throw new HostProfileError(
      `host ${host.name}'s job kind ${kind.name} has no channel: spawning a plugin kind whose agents use their harness's own channel is not supported yet`,
    );
  }
  if (caps.firstTurn === "at-start" && opts.firstPrompt === undefined) {
    throw new JobSpecUnsupportedError(
      host.name,
      kind.name,
      "prompt",
      "a spawn without a first prompt (its jobs start with one: pass --send)",
    );
  }
  const mux = await activeMux();
  if (!mux.runsShellCommand) throw new HostSpawnUnsupportedError(host.name, mux.name);
}

/** The view's command line: stdin /dev/null, so nothing reaches the job but the channel. */
const viewLine = (command: string): string => `exec </dev/null; ${command}`;

export async function spawnPluginAgent(
  db: Db,
  opts: SpawnAgentOptions,
  host: HostView,
  kind: PluginJobKind,
  spawner: string | null,
): Promise<SpawnedAgent> {
  await refuse(host, kind, opts);
  const { name, workstream: ws } = opts;
  const cli = opts.cli ?? "pi";
  const command = opts.command ?? cli;
  const commandSource = opts.command !== undefined ? "explicit" : "cli-key";
  const provider = host.record !== undefined;
  // A --worktree on a provider host starts from the caller's commit (D7 G3).
  const localRepo = provider && opts.worktree ? await gitToplevel(process.cwd()) : undefined;
  if (provider && opts.worktree && localRepo === undefined) {
    throw new HostProfileError(
      `--worktree on provider host ${host.name} needs a local git checkout: run it inside one`,
    );
  }
  const job = await withAgentLock(db, ws, name, async () =>
    provider
      ? reserveProviderJob(db, host.name, {
          workstream: ws,
          name,
          kind: kind.name,
          plugin: kind.plugin,
          worktree: opts.worktree === true,
        })
      : reserveCarrierJob(db, {
          workstream: ws,
          name,
          host: host.name,
          hostStop: null,
          plugin: { kind: kind.name, name: kind.plugin },
        }),
  );
  if (job === undefined) throw new AgentExistsError(name);
  const token = job.token;
  const carrier = { token };
  let staged: StagedWorktree | undefined;
  let cwd = opts.cwd ?? host.record?.repo ?? host.profile?.repo ?? ".";
  let paneId: string | undefined;
  let owned: number | undefined;
  let viewDone: Promise<unknown> = Promise.resolve();
  try {
    if (opts.worktree && provider && localRepo !== undefined) {
      const placeholder = await withAgentLock(db, ws, name, async () =>
        insertAgent(db, {
          reservation: token,
          name,
          workstream: ws,
          cli,
          paneId: pendingPaneIdFor(name),
          role: opts.role,
          tab: opts.tab ?? null,
          cwd: null,
          spawner,
          host: host.name,
        }),
      );
      owned = placeholder.incarnation;
      const site = await prepareProviderWorktree(host, {
        workstream: ws,
        name,
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        reclaim: true,
        localRepo,
      });
      staged = {
        path: site.cwd,
        base: site.base ?? "",
        root: site.repo ?? "",
        createdAt: new Date().toISOString(),
        incarnation: placeholder.incarnation,
        host: host.name,
      };
      recordJobTree(db, token, {
        path: site.cwd,
        base: staged.base,
        agentId: placeholder.incarnation,
        collectRepo: localRepo,
      });
    } else if (host.profile !== undefined) {
      // A --plugin profile: today's remote prepare under the link (a worktree, or the cwd).
      const admitted = await admitRemoteSpawn(
        db,
        opts,
        cli,
        spawner,
        host.profile,
        undefined,
        token,
      );
      if (admitted.lease !== undefined) releaseHostChannel(db, admitted.lease); // the view holds no link
      staged = admitted.staged;
      owned = staged?.incarnation;
      if (admitted.site !== undefined) cwd = admitted.site.cwd;
    }
    if (staged !== undefined) cwd = staged.path;
    const harness = harnessOfCli(cli, command) ?? cli;
    const h = kind.caps.honours;
    const prompt =
      kind.caps.firstTurn === "at-start" && opts.firstPrompt !== undefined
        ? { text: opts.firstPrompt, msgId: randomUUID() }
        : undefined;
    const spec: JobSpec = {
      workstream: ws,
      name,
      harness,
      role: opts.role === "read-only" ? "read-only" : "full-access",
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      cmd: command,
      commandSource,
      cwd,
      env:
        h?.env === false
          ? {}
          : {
              MU_MANAGED_AGENT: "1",
              MU_AGENT_NAME: name,
              MU_WORKSTREAM: ws,
              MU_REMOTE: "1",
              MU_AGENT_CLI: harness,
            },
      ...(prompt !== undefined ? { firstPrompt: prompt } : {}),
    };
    opts.signal?.throwIfAborted();
    const started = await kind.start(host, spec, token);
    const session = opts.tmuxSession ?? `mu-${ws}`;
    const row = await withAgentLock(db, ws, name, () =>
      withSpawnLock(session, async () => {
        const mux = await activeMux();
        let onCreated: (pid: string) => void = () => {};
        const created = new Promise<string>((res) => {
          onCreated = res;
        });
        const done = mux.spawnAgent({
          session,
          window: opts.tab ?? name,
          name,
          cli,
          command: viewLine(started.view.command),
          // mu's own command line, never the harness's: a backend that starts its agent kinds itself refuses it.
          commandSource: "explicit",
          ...(started.view.cwd !== undefined ? { cwd: started.view.cwd } : {}),
          env: started.view.env,
          onPaneCreated: onCreated,
        });
        done.catch(() => {});
        const pid = await Promise.race([created, done]);
        paneId = pid;
        viewDone = done;
        recordCarrierPane(db, token, pid);
        const r: AgentRow = finalizeAgentRow(db, {
          opts,
          cli,
          paneId: pid,
          cwd,
          staged,
          command,
          commandSource,
          spawner,
          host: host.name,
          hostTransport: undefined,
          gateToken: undefined,
          reservation: token,
          hooks: false,
          piHooks: false,
          channel: kind.caps.channel,
          channelPlugin: kind.plugin,
        });
        owned = r.incarnation;
        if (!bindCarrierJobAgent(db, token, r.incarnation, pid)) {
          throw new Error(`carrier_jobs: the job record of ${ws}/${name} is gone`);
        }
        opts.onIdentity?.(r);
        return r;
      }),
    );
    // The backend's own completion: a view that failed after it reported its pane rolls back.
    await viewDone;
    const baseline = started.baseline ?? (await readiness(db, row));
    emitEvent(
      db,
      ws,
      "agent.spawn",
      `agent spawn ${name} (cli=${cli}, role=${opts.role ?? "full-access"}, pane=${row.paneId}, host=${host.name}, job=${kind.plugin}:${kind.name}, channel=${kind.caps.channel})`,
    );
    // An at-start kind's first prompt, delivered by the start; no control socket.
    const firstSend: SendResult = { transport: kind.caps.channel ?? "", ...baseline };
    if (prompt !== undefined) firstSend.msgId = prompt.msgId;
    return { ...row, ctl: "skipped", ctlSocket: "", ...(prompt ? { firstSend } : {}) };
  } catch (err) {
    try {
      await rollbackSpawn(db, name, paneId, staged, owned, ws, undefined, carrier);
    } catch {
      // best-effort: never mask the spawn's error
    }
    throw err;
  }
}

/** A started plugin job's channel gave no baseline within MU_SPAWN_JOB_MS. Exit 1 (rolled back). */
export class PluginJobNotReadyError extends Error {
  override readonly name = "PluginJobNotReadyError";
  constructor(
    public readonly agentName: string,
    public readonly host: string,
    public readonly channel: string,
    public readonly budgetMs: number,
  ) {
    super(
      `agent ${agentName} on ${host}: its channel ${channel} gave no baseline within ${budgetMs}ms (MU_SPAWN_JOB_MS); its job was stopped and the spawn rolled back`,
    );
  }
}

/** Readiness (D8): the channel's baseline answering within MU_SPAWN_JOB_MS. */
async function readiness(db: Db, row: AgentRow): Promise<RunBaseline> {
  const target = channelTarget(db, row);
  const channel = agentChannel(target);
  const until = Date.now() + defaultSpawnJobMs();
  for (;;) {
    const b = await channel.baseline(target);
    if (b !== undefined) return b;
    if (Date.now() >= until) {
      throw new PluginJobNotReadyError(row.name, row.host ?? "", channel.name, defaultSpawnJobMs());
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
