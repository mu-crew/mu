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
// stop) before the tree and the record go. On a kind's own channel the view's stdin is
// /dev/null: every delivery goes through the channel's effects.
//
// An at-start kind (D8 G1) folds the first delivery into `job.start`: its placeholder row
// comes first, stamped with what the finished row will hold, and a task spawn claims for
// it and journals `sending` (`opts.firstTurn.begin`) before the start. A start whose outcome
// is unknown keeps the placeholder, the claim and the record (`FirstPromptUnknownError`);
// `resolveFirstTurn` resolves it by the rule table and finishes the view (G1a).

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AgentRow,
  getAgent,
  insertAgent,
  isPendingPaneId,
  pendingPaneIdFor,
} from "../agents.js";
import { newRemoteKey, remoteAnchorWrapper } from "../anchors.js";
import {
  bindCarrierJobAgent,
  type CarrierJob,
  getCarrierJob,
  getCarrierJobByName,
  recordCarrierPane,
  recordJobTree,
  reserveCarrierJob,
} from "../carrier-jobs.js";
import { channelTarget } from "../channels/dispatch.js";
import { agentChannel } from "../channels/index.js";
import type { ChannelName, RunBaseline, SendResult } from "../channels/types.js";
import { ctlSocketPath, remoteCtlSocketPath } from "../ctl/path.js";
import type { Db } from "../db.js";
import { effectOwner } from "../effects.js";
import { harnessOfCli } from "../harnesses.js";
import { type HostView, resolveHost } from "../host-provider.js";
import { reserveProviderJob } from "../host-records.js";
import { HostProfileError, pidProvenGone, releaseHostChannel } from "../hosts.js";
import { defaultSpawnJobMs } from "../jobs/lease.js";
import type { JobSpec, JobStart, PaneCommand } from "../jobs/types.js";
import { emitEvent } from "../logs.js";
import { type CommandSource, markPaneHost } from "../mux/types.js";
import { activeMux } from "../mux.js";
import { EffectOutcomeUnknownError } from "../plugins/errors.js";
import { type PluginJobKind, pluginJobKind, pluginJobRef } from "../plugins/job.js";
import { LOCAL_ONLY_ENV } from "../remote-agent.js";
import { prepareProviderWorktree } from "../remote-worktree.js";
import { shellQuote } from "../shell-quote.js";
import { gitToplevel } from "../vcs/git.js";
import { AgentExistsError } from "./errors.js";
import { withAgentLock } from "./lock.js";
import { type ReceiptActor, repointReceipts } from "./receipts.js";
import {
  finalizeAgentRow,
  type SpawnAgentOptions,
  type SpawnedAgent,
  type StagedWorktree,
  speaksMuCtl,
} from "./spawn.js";
import { withSpawnLock } from "./spawn-lock.js";
import { launchCommand } from "./spawn-presets.js";
import {
  awaitCtlHandshake,
  awaitSpawnLiveness,
  checkSpawnHealth,
  defaultSpawnCtlMs,
  defaultSpawnLivenessMs,
  type SpawnCtl,
} from "./spawn-ready.js";
import {
  admitRemoteSpawn,
  isCommandGate,
  JobSpecUnsupportedError,
  refuseUnhonoured,
  requireHostSpawn,
} from "./spawn-remote.js";
import { rollbackSpawn } from "./spawn-rollback.js";

/**
 * The built-in channel an agent of a kind without a channel of its own is on (ladder placement
 * spec §A): its harness's, as on a template host. pi is on `ctl` (the kind forwards the socket
 * pair); a hook harness on a backend that anchors and pastes (tmux) on remote `hooks`, read
 * through the host's link; any other harness on `mux`.
 */
export interface BuiltInChannel {
  channel: "ctl" | "hooks" | "mux";
  /** pi on ctl: the kind gets the socket pair. */
  ctl: boolean;
  /** A hook harness on remote hooks: it gets a remote key. */
  hooks: boolean;
}

/**
 * Refused before any effect (D8 honour or refuse). A `--plugin`
 * profile also takes the remote spawn's refusals (`requireHostSpawn`: the harness probe, a
 * repo for `--worktree`, a recovered tree at the name). Returns the built-in channel of a kind
 * without its own.
 */
async function refuse(
  db: Db,
  host: HostView,
  kind: PluginJobKind,
  opts: SpawnAgentOptions,
): Promise<BuiltInChannel | undefined> {
  if (host.record === undefined) await requireHostSpawn(db, opts);
  else refuseUnhonoured(host, kind, opts);
  const { caps } = kind;
  if (caps.firstTurn === "at-start" && caps.channel === undefined) {
    // Its first prompt goes in job.start, so only its own channel can tell its turns (§A).
    throw new HostProfileError(
      `host ${host.name}'s job kind ${kind.name} starts its first turn at start but has no channel: such a kind needs its own channel`,
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
  if (caps.channel !== undefined) return undefined;
  const mux = await activeMux();
  if (isCommandGate(opts)) {
    throw new HostProfileError(
      `host ${host.name}'s job kind ${kind.name} runs agents, not command gates: a --command that runs no harness needs a session profile`,
    );
  }
  const cli = opts.cli ?? "pi";
  const command = opts.command ?? cli;
  if (speaksMuCtl(cli, command)) return { channel: "ctl", ctl: true, hooks: false };
  // Only a hook harness emits the hooks a remote `hooks` channel reads (as a template spawn).
  const harness = harnessOfCli(cli, command);
  return harness !== undefined &&
    harness !== "pi" &&
    mux.anchorsPanes &&
    mux.pasteToPane !== undefined
    ? { channel: "hooks", ctl: false, hooks: true }
    : { channel: "mux", ctl: false, hooks: false };
}

/**
 * The view's command line. On a plugin channel stdin is /dev/null: nothing reaches the job but
 * the channel. On a built-in one it is interactive (`hooks` pastes, `mux` types, a pi on ctl is
 * a TUI), and runs without the local-only mu variables a tmux pane inherits (R5: only
 * `HOST_ENV_KEYS` reach the worker, through the JobSpec).
 */
export const viewLine = (command: string, interactive: boolean): string =>
  interactive
    ? `exec env ${LOCAL_ONLY_ENV.map((k) => `-u ${k}`).join(" ")} /bin/sh -c ${shellQuote(command)}`
    : `exec </dev/null; ${command}`;

export async function spawnPluginAgent(
  db: Db,
  opts: SpawnAgentOptions,
  host: HostView,
  kind: PluginJobKind,
  spawner: string | null,
): Promise<SpawnedAgent> {
  const builtIn = await refuse(db, host, kind, opts);
  const { name, workstream: ws } = opts;
  const cli = opts.cli ?? "pi";
  const command = opts.command ?? cli;
  const commandSource = opts.command !== undefined ? "explicit" : "cli-key";
  const channel: ChannelName = kind.caps.channel ?? builtIn?.channel ?? "";
  // A pi on the built-in ctl: the derived local socket the kind's view forwards to the remote one.
  const sockets =
    builtIn?.ctl === true
      ? {
          local: ctlSocketPath(ws, name, dirname(db.name)),
          remote: remoteCtlSocketPath(ws, name, process.getuid?.() ?? 0),
        }
      : undefined;
  if (sockets !== undefined) mkdirSync(dirname(sockets.local), { recursive: true, mode: 0o700 });
  // A remote hook harness's key on its node (spec D11): in its anchor and its env.
  const remoteKey = builtIn?.hooks === true ? newRemoteKey(ws, name) : undefined;
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
          // The creating process: while it lives, others only read its first turn (D8).
          creatorPid: effectOwner().pid,
          creatorStart: effectOwner().start,
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
      // The job record names its tree too (§10.4); the placeholder, stamped at prepare, is its owner.
      if (staged !== undefined) {
        recordJobTree(db, token, {
          path: staged.path,
          base: staged.base,
          agentId: staged.incarnation,
          collectRepo: null,
        });
      }
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
    const harnessRow = harnessOfCli(cli, command);
    const harness = harnessRow ?? cli;
    const h = kind.caps.honours;
    // On a built-in channel mu launches the harness as on a template host: its spawn presets,
    // and a hook harness's remote anchor. The row keeps the command as given.
    const launch =
      builtIn === undefined ? command : launchCommand(command, harnessRow, opts, { remote: true });
    const cmd =
      remoteKey === undefined
        ? launch
        : remoteAnchorWrapper(launch, {
            agent_name: name,
            workstream: ws,
            role: "worker",
            cli: harness,
            orchestrator: false,
            remote_key: remoteKey,
          });
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
      cmd,
      commandSource,
      cwd,
      // Only HOST_ENV_KEYS (R5).
      env:
        h?.env === false
          ? {}
          : {
              MU_MANAGED_AGENT: "1",
              MU_AGENT_NAME: name,
              MU_WORKSTREAM: ws,
              MU_REMOTE: "1",
              MU_AGENT_CLI: harness,
              ...(sockets !== undefined ? { MU_CTL_SOCK: sockets.remote } : {}),
              ...(remoteKey !== undefined ? { MU_REMOTE_KEY: remoteKey } : {}),
            },
      ...(sockets !== undefined ? { sockets } : {}),
      ...(prompt !== undefined ? { firstPrompt: prompt } : {}),
    };
    opts.signal?.throwIfAborted();
    let started: JobStart;
    try {
      started = await kind.start(host, spec, token);
    } catch (e) {
      const r = getCarrierJob(db, token);
      // The first prompt may be running (or, resolved meanwhile, ran): never rolled back or
      // resent (D8 G1b). Only a start proven never to have happened is unsent.
      if (prompt === undefined || r?.launch !== "intent") throw e;
      kept = true;
      throw new FirstPromptUnknownError(kind.plugin, name, ws, prompt.msgId, token, e);
    }
    // An at-start start that carried the prompt delivered it: a later failure stops the job,
    // never makes it unsent. An on-send kind's start delivers nothing (its baseline is readiness).
    if (prompt !== undefined && started.baseline !== undefined) {
      opts.firstTurn?.delivered(started.baseline);
    }
    const row = await openView(
      db,
      {
        opts,
        cli,
        command,
        commandSource,
        cwd,
        staged,
        spawner,
        host,
        kind,
        token,
        channel,
        ...(builtIn !== undefined ? { builtIn } : {}),
        ...(sockets !== undefined ? { localSock: sockets.local } : {}),
        ...(remoteKey !== undefined ? { remoteKey } : {}),
      },
      started.view,
      (pid) => {
        paneId = pid;
      },
      (r) => {
        owned = r.incarnation;
      },
      atStart ? owned : undefined,
    );
    if (builtIn !== undefined) {
      const ready = await builtInReadiness(row, command, host.name, sockets?.local, opts);
      emitEvent(
        db,
        ws,
        "agent.spawn",
        `agent spawn ${name} (cli=${cli}, role=${opts.role ?? "full-access"}, pane=${row.paneId}, host=${host.name}, job=${kind.plugin}:${kind.name}, channel=${channel}, ctl=${ready.ctl})`,
      );
      return {
        ...row,
        ctl: ready.ctl,
        ctlSocket: sockets?.local ?? "",
        ...(ready.incarnation !== undefined ? { ctlIncarnation: ready.incarnation } : {}),
        ...(ready.trustDialog ? { trustDialog: true as const } : {}),
      };
    }
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
  /** The row's channel: the kind's own, or the built-in one. */
  channel: ChannelName;
  /** Set on a built-in channel: the view is interactive. */
  builtIn?: BuiltInChannel;
  /** A pi on ctl: the local socket the view binds (a stale file of the name is removed first). */
  localSock?: string;
  /** A remote hook harness's key. */
  remoteKey?: string;
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
      // The name is ours: no live agent owns a socket at this path; the view's forward binds it.
      if (v.localSock !== undefined) rmSync(v.localSock, { force: true });
      let onCreated: (pid: string) => void = () => {};
      const created = new Promise<string>((res) => {
        onCreated = res;
      });
      const done = mux.spawnAgent({
        session,
        window: opts.tab ?? opts.name,
        name: opts.name,
        cli: v.cli,
        command: viewLine(view.command, v.builtIn !== undefined),
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
      await markPaneHost(mux, pid, v.host.name);
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
        hooks: v.builtIn?.hooks === true,
        piHooks: false,
        channel: v.channel,
        ...(v.builtIn === undefined ? { channelPlugin: kind.plugin } : {}),
        ...(v.remoteKey !== undefined ? { remoteKey: v.remoteKey } : {}),
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
  /** `actor`: who answered (the creator itself, or another once the creator is gone). */
  | { state: "accepted"; runs: 0; incarnation?: string; agent: AgentRow; actor: ReceiptActor }
  | { state: "unreachable"; reason: string }
  /** The spawn that created the job still runs in another process: read only, nothing moved. */
  | { state: "held"; reason: string }
  /** The start provably never happened: the msgId is no first prompt of a job. */
  | { state: "never"; actor: ReceiptActor };

/** Who this invocation is to job record `r`'s receipts: its first turn, its view (D8 owner-only rule). */
export function jobRecordActor(r: CarrierJob): ReceiptActor {
  const me = effectOwner();
  if (r.creatorPid === null) return "other-gone";
  if (r.creatorPid === me.pid && r.creatorStart === me.start) return "creator";
  return pidProvenGone(r.creatorPid, r.creatorStart) ? "other-gone" : "other-alive";
}

/** A recovery's view failed after the row took its pane: back to the placeholder for the next try. */
function unfinalize(db: Db, agent: AgentRow, pane: string, token: string): void {
  db.prepare("UPDATE agents SET pane_id = ? WHERE id = ? AND pane_id = ?").run(
    pendingPaneIdFor(agent.name),
    agent.incarnation,
    pane,
  );
  db.prepare("UPDATE carrier_jobs SET pane_id = NULL WHERE token = ? AND pane_id = ?").run(
    token,
    pane,
  );
}

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
  const actor = jobRecordActor(rec);
  if (actor === "other-alive") {
    // Owner-only (D8): while its spawn runs, a check or replay never resolves or moves anything.
    const live = getAgent(db, row.name, row.workstreamName);
    if (rec.job !== null && live !== undefined && !isPendingPaneId(live.paneId)) {
      return {
        state: "accepted",
        runs: 0,
        ...(rec.firstInc !== null ? { incarnation: rec.firstInc } : {}),
        agent: live,
        actor,
      };
    }
    return {
      state: "held",
      reason: `its spawn (pid ${rec.creatorPid}) is still running: ask again once it ends (job.start effect ${rec.token})`,
    };
  }
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
    return now?.launch === "intent" ? unresolved("no answer yet") : { state: "never", actor };
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
            channel: kind.caps.channel ?? agent.channel ?? "",
          },
          view,
          (pid) => {
            opened = pid;
          },
          () => {},
          agent.incarnation,
        );
      } catch (e) {
        // Only the pane this call opened; the row goes back to its placeholder for the next try,
        // and the receipt stays as it was (D8, review 2 of P6e2).
        if (opened !== undefined) {
          await (await activeMux()).killPane(opened).catch(() => {});
          unfinalize(db, agent, opened, now.token);
        }
        throw e;
      }
      // The view opened: only now does the receipt follow it.
      repointReceipts(db, agent.incarnation, { msgId }, agent.paneId, actor);
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
    actor,
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

/**
 * Readiness on a built-in channel, as on a template host: pi's ctl handshake on the local socket
 * (its view's death or a known fatal startup error meanwhile rolls back at once; a timeout with
 * a live, clean view is only control missing, the job runs), then the startup-health check;
 * else the view's liveness window (also when the handshake is skipped).
 */
async function builtInReadiness(
  row: AgentRow,
  command: string,
  host: string,
  localSock: string | undefined,
  opts: SpawnAgentOptions,
): Promise<{ ctl: SpawnCtl; incarnation?: string; trustDialog: boolean }> {
  // No handshake (no socket, --no-ctl, MU_SPAWN_CTL_MS=0) still proves the view alive.
  if (localSock === undefined || opts.ctl === false || defaultSpawnCtlMs() === 0) {
    const trustDialog = await awaitSpawnLiveness(row.paneId, row.name, command, host);
    return { ctl: "skipped", trustDialog };
  }
  const check = defaultSpawnLivenessMs() !== 0;
  const when = `during the ctl handshake (up to ${defaultSpawnCtlMs()}ms after spawn)`;
  // Each tick: the view gone, or parked at a fatal startup error, ends the wait.
  const health = async (): Promise<void> => {
    await checkSpawnHealth(row.paneId, row.name, command, when, false, host);
  };
  const hs = await awaitCtlHandshake(localSock, check ? health : undefined, opts.signal);
  // The final check: an ok handshake proves pi ran, so only provider/auth patterns apply.
  const trustDialog = check
    ? await checkSpawnHealth(row.paneId, row.name, command, when, hs.ctl === "ok", host)
    : false;
  return {
    ctl: hs.ctl,
    ...(hs.incarnation !== undefined ? { incarnation: hs.incarnation } : {}),
    trustDialog,
  };
}

export type { PluginJobKind };
