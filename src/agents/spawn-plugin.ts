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
//
// An at-start kind (D8 G1) folds the first delivery into `job.start`: its placeholder row
// comes first, stamped with what the finished row will hold, and a task spawn claims for
// it and journals `sending` (`opts.firstTurn.begin`) before the start. A start whose outcome
// is unknown keeps the placeholder, the claim and the record (`FirstPromptUnknownError`);
// `resolveFirstTurn` resolves it by the rule table and finishes the view (G1a).

import { randomUUID } from "node:crypto";
import {
  type AgentRow,
  getAgent,
  insertAgent,
  isPendingPaneId,
  pendingPaneIdFor,
} from "../agents.js";
import {
  bindCarrierJobAgent,
  getCarrierJob,
  getCarrierJobByName,
  recordCarrierPane,
  recordJobTree,
  reserveCarrierJob,
} from "../carrier-jobs.js";
import { channelTarget } from "../channels/dispatch.js";
import { agentChannel } from "../channels/index.js";
import type { RunBaseline, SendResult } from "../channels/types.js";
import type { Db } from "../db.js";
import { harnessOfCli } from "../harnesses.js";
import { type HostView, resolveHost } from "../host-provider.js";
import { reserveProviderJob } from "../host-records.js";
import { HostProfileError, HostSpawnUnsupportedError, releaseHostChannel } from "../hosts.js";
import { defaultSpawnJobMs } from "../jobs/lease.js";
import type { JobSpec, JobStart, PaneCommand } from "../jobs/types.js";
import { emitEvent } from "../logs.js";
import type { CommandSource } from "../mux/types.js";
import { activeMux } from "../mux.js";
import { EffectOutcomeUnknownError } from "../plugins/errors.js";
import { type PluginJobKind, pluginJobKind, pluginJobRef } from "../plugins/job.js";
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
  const atStart = kind.caps.firstTurn === "at-start";
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
  /** An at-start spawn's placeholder, once `firstTurn.begin` runs on it. */
  let begun: AgentRow | undefined;
  /** The start's outcome is unknown: placeholder, claim and record are kept. */
  let kept = false;
  const placeholder = () =>
    withAgentLock(db, ws, name, async () =>
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
  try {
    if (opts.worktree && provider && localRepo !== undefined) {
      const row = await placeholder();
      owned = row.incarnation;
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
        incarnation: row.incarnation,
        host: host.name,
      };
      recordJobTree(db, token, {
        path: site.cwd,
        base: staged.base,
        agentId: row.incarnation,
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
    if (atStart) {
      // D8 G1: the placeholder first, stamped as the row will be; a task spawn claims for it.
      if (owned === undefined) owned = (await placeholder()).incarnation;
      const row = stampPlaceholder(db, owned, name, ws, {
        cwd,
        base: staged?.base ?? null,
        repo: staged?.host !== undefined ? staged.root : null,
        command,
        commandSource,
        channel: kind.caps.channel ?? "",
        plugin: kind.plugin,
      });
      opts.onIdentity?.(row);
      begun = row;
      await opts.firstTurn?.begin(row);
    }
    const harness = harnessOfCli(cli, command) ?? cli;
    const h = kind.caps.honours;
    const prompt =
      atStart && opts.firstPrompt !== undefined
        ? { text: opts.firstPrompt, msgId: opts.firstTurn?.msgId ?? randomUUID() }
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
    let started: JobStart;
    try {
      started = await kind.start(host, spec, token);
    } catch (e) {
      const r = getCarrierJob(db, token);
      // The first prompt may be running: nothing is rolled back or resent (D8 G1b).
      if (prompt === undefined || r?.launch !== "intent" || r.job !== null) throw e;
      kept = true;
      throw new FirstPromptUnknownError(kind.plugin, name, ws, prompt.msgId, token, e);
    }
    const row = await openView(
      db,
      { opts, cli, command, commandSource, cwd, staged, spawner, host, kind, token },
      started.view,
      (pid) => {
        paneId = pid;
      },
      (r) => {
        owned = r.incarnation;
      },
      atStart ? owned : undefined,
    );
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
    if (kept) throw err;
    try {
      if (begun !== undefined) opts.firstTurn?.undo(begun);
      await rollbackSpawn(db, name, paneId, staged, owned, ws, undefined, carrier);
    } catch {
      // best-effort: never mask the spawn's error
    }
    throw err;
  }
}

/** What an at-start placeholder is stamped with before its start: the finished row's facts. */
function stampPlaceholder(
  db: Db,
  id: number,
  name: string,
  ws: string,
  f: {
    cwd: string;
    base: string | null;
    repo: string | null;
    command: string;
    commandSource: string;
    channel: string;
    plugin: string;
  },
): AgentRow {
  db.prepare(
    "UPDATE agents SET cwd = ?, base = ?, repo = ?, command = ?, command_source = ?, channel = ?, channel_plugin = ? WHERE id = ? AND pane_id = ?",
  ).run(
    f.cwd,
    f.base,
    f.repo,
    f.command,
    f.commandSource,
    f.channel,
    f.plugin,
    id,
    pendingPaneIdFor(name),
  );
  const row = getAgent(db, name, ws);
  if (row?.incarnation !== id) throw new AgentExistsError(name);
  return row;
}

interface ViewOf {
  opts: Pick<SpawnAgentOptions, "name" | "workstream" | "tab" | "role" | "tmuxSession"> &
    Partial<SpawnAgentOptions>;
  cli: string;
  command: string;
  commandSource: CommandSource;
  cwd: string;
  staged: StagedWorktree | undefined;
  spawner: string | null;
  host: HostView;
  kind: PluginJobKind;
  token: string;
}

/**
 * The view pane of a started job and its finished row, the kind's channel recorded; a
 * placeholder (`placeholder`, or the staged tree's) is patched. A view the backend fails to
 * start, even after it reported the pane, throws.
 */
async function openView(
  db: Db,
  v: ViewOf,
  view: PaneCommand,
  onPane: (paneId: string) => void,
  onRow: (row: AgentRow) => void,
  placeholder?: number,
): Promise<AgentRow> {
  const { opts, kind } = v;
  const session = opts.tmuxSession ?? `mu-${opts.workstream}`;
  let viewDone: Promise<unknown> = Promise.resolve();
  const row = await withAgentLock(db, opts.workstream, opts.name, () =>
    withSpawnLock(session, async () => {
      const mux = await activeMux();
      let onCreated: (pid: string) => void = () => {};
      const created = new Promise<string>((res) => {
        onCreated = res;
      });
      const done = mux.spawnAgent({
        session,
        window: opts.tab ?? opts.name,
        name: opts.name,
        cli: v.cli,
        command: viewLine(view.command),
        // mu's own command line, never the harness's: a backend that starts its agent kinds itself refuses it.
        commandSource: "explicit",
        ...(view.cwd !== undefined ? { cwd: view.cwd } : {}),
        env: view.env,
        onPaneCreated: onCreated,
      });
      done.catch(() => {});
      const pid = await Promise.race([created, done]);
      onPane(pid);
      viewDone = done;
      recordCarrierPane(db, v.token, pid);
      const r: AgentRow = finalizeAgentRow(db, {
        opts: opts as SpawnAgentOptions,
        cli: v.cli,
        paneId: pid,
        cwd: v.cwd,
        staged: v.staged,
        command: v.command,
        commandSource: v.commandSource,
        spawner: v.spawner,
        host: v.host.name,
        hostTransport: undefined,
        gateToken: undefined,
        reservation: v.token,
        hooks: false,
        piHooks: false,
        channel: kind.caps.channel,
        channelPlugin: kind.plugin,
        ...(v.staged === undefined && placeholder !== undefined ? { placeholder } : {}),
      });
      onRow(r);
      if (!bindCarrierJobAgent(db, v.token, r.incarnation, pid)) {
        throw new Error(`carrier_jobs: the job record of ${opts.workstream}/${opts.name} is gone`);
      }
      opts.onIdentity?.(r);
      return r;
    }),
  );
  // The backend's own completion: a view that failed after it reported its pane rolls back.
  await viewDone;
  return row;
}

/** An at-start kind's job.start whose outcome is unknown: its first prompt may be running. Exit 1. */
export class FirstPromptUnknownError extends EffectOutcomeUnknownError {
  constructor(
    plugin: string,
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly msgId: string,
    /** The job.start effect's key (the job record's token). */
    public readonly key: string,
    cause: unknown,
  ) {
    super(
      plugin,
      "job.start",
      `${cause instanceof EffectOutcomeUnknownError ? cause.reason : cause instanceof Error ? cause.message : String(cause)} (effect ${key}); its first prompt ${msgId} may be running and is never resent: mu agent check ${agentName} ${msgId} -w ${workstream} resolves it`,
    );
  }
}

export type FirstTurnCheck =
  | { state: "accepted"; runs: 0; incarnation?: string; agent: AgentRow }
  | { state: "unreachable"; reason: string }
  /** The start provably never happened: the msgId is no first prompt of a job. */
  | { state: "never" };

/**
 * `msgId` as agent `row`'s first prompt (D8 G1a, G1b): undefined unless its job record's
 * `first_msg_id`. An unresolved `job.start` is resolved by the rule table first; a found start
 * records its handle and `first_inc`, and a placeholder still waiting for its view gets it (the
 * start's `view`, else `job.attach`).
 */
export async function resolveFirstTurn(
  db: Db,
  row: AgentRow,
  msgId: string,
): Promise<FirstTurnCheck | undefined> {
  const rec = getCarrierJobByName(db, row.workstreamName, row.name);
  if (rec?.plugin == null || rec.firstMsgId !== msgId) return undefined;
  const unresolved = (why: string): FirstTurnCheck => ({
    state: "unreachable",
    reason: `its job.start (effect ${rec.token}) is unresolved: ${why}`,
  });
  const kind = pluginJobKind(db, rec.plugin);
  if (kind === undefined) return unresolved(`plugin ${rec.plugin} has no job seam`);
  let view: PaneCommand | undefined;
  if (rec.job === null && rec.launch === "intent") {
    try {
      for (const r of await kind.resolve(rec.token)) {
        if (r.state === "unknown") return unresolved(r.reason);
        if (r.state === "recorded") view = (r.result as Partial<JobStart> | null)?.view ?? view;
      }
    } catch (e) {
      return unresolved(e instanceof Error ? e.message : String(e));
    }
  }
  const now = getCarrierJob(db, rec.token);
  if (now?.job == null) {
    return now?.launch === "intent" ? unresolved("no answer yet") : { state: "never" };
  }
  let agent = getAgent(db, row.name, row.workstreamName) ?? row;
  if (isPendingPaneId(agent.paneId) && agent.host !== null) {
    const ref = pluginJobRef(db, now.token);
    try {
      view ??= ref === undefined ? undefined : await kind.attach(db, ref);
      if (view === undefined) return unresolved("no view to open");
      const staged: StagedWorktree | undefined =
        agent.base !== null && agent.cwd !== null
          ? {
              path: agent.cwd,
              base: agent.base,
              root: agent.repo ?? "",
              createdAt: agent.createdAt,
              incarnation: agent.incarnation,
              host: agent.host,
            }
          : undefined;
      let opened: string | undefined;
      try {
        agent = await openView(
          db,
          {
            opts: {
              name: agent.name,
              workstream: agent.workstreamName,
              tab: agent.tab ?? undefined,
              role: agent.role,
            },
            cli: agent.cli,
            command: agent.command ?? agent.cli,
            commandSource: agent.commandSource ?? "cli-key",
            cwd: agent.cwd ?? ".",
            staged,
            spawner: agent.spawner,
            host: resolveHost(db, agent.host),
            kind,
            token: now.token,
          },
          view,
          (pid) => {
            opened = pid;
          },
          () => {},
          agent.incarnation,
        );
      } catch (e) {
        // Only the pane this call opened: the row keeps its placeholder for the next try.
        if (opened !== undefined) await (await activeMux()).killPane(opened).catch(() => {});
        throw e;
      }
    } catch (e) {
      return {
        state: "unreachable",
        reason: `its job started, but its view did not open: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return {
    state: "accepted",
    runs: 0,
    ...(now.firstInc !== null ? { incarnation: now.firstInc } : {}),
    agent,
  };
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
