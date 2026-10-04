// mu — every `mu agent ...` verb + spawn / send / read / list / show /
// close / adopt + the top-level `mu me` agent-self
// verb (default + `tasks` / `next` subcommands).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.
//
// `whoami` / `my-tasks` / `my-next` were merged into `mu me` /
// `mu me tasks` / `mu me next` in audit_merge_self_verbs_into_mu_me
// (audit_cleanups_post_schema_v5_wave). The three old verbs are
// gone; the three cmd functions (`cmdMe`, `cmdMyTasks`, `cmdMyNext`)
// stayed (with `cmdMe` formerly `cmdWhoami`).

import { dirname } from "node:path";
import { agentKey, ctlRuntimeState, readAgentStates } from "../agent-state.js";
import {
  type AdoptAgentOptions,
  type AdoptAgentResult,
  AgentCtlUnreachableError,
  AgentNotFoundError,
  type AgentStatusSnapshot,
  type AgentWatch,
  abortAgent,
  adoptAgent,
  agentCtlSocket,
  closeAgent,
  delegateOutcome,
  expectsCtl,
  getAgent,
  isKickSignal,
  type KickSignal,
  kickAgent,
  listLiveAgents,
  parseSessionCommand,
  readAgent,
  refreshAgentTitle,
  resolveCliCommand,
  resolveCliCommandWithSource,
  sendToAgent,
  spawnAgent,
  type Transport,
  waitForAgents,
} from "../agents.js";
import {
  applyQualifiedRef,
  assertAgentInWorkstream,
  emitJson,
  formatAgentsTable,
  formatTaskListTable,
  resolveEntityRef,
  resolveSelf,
  resolveWorkstream,
  statusIcon,
  UsageError,
} from "../cli.js";
import { ctlProbe, ctlRequest } from "../ctl/client.js";
import type { Db } from "../db.js";
import { activeMux, type SendWarning } from "../mux.js";
import { type NextStep, pc, printNextSteps, printNextStepsTo } from "../output.js";
import { listTasksByOwner } from "../tasks.js";
import { detectBackend, type VcsBackendName } from "../vcs.js";
import { getWorkspaceForAgent } from "../workspace.js";
import { abortHint, dispatchHint, plainSendHints } from "./dispatch-hints.js";
import { checkWorkspaceStalenessForDispatch } from "./staleness.js";

interface SpawnOpts {
  cli?: string;
  command?: string;
  tab?: string;
  role?: string;
  cwd?: string;
  workstream?: string;
  workspace?: boolean;
  workspaceBackend?: VcsBackendName;
  workspaceFrom?: string;
  workspaceProjectRoot?: string;
  /** commander's `--no-ctl` negation: false skips the ctl handshake. */
  ctl?: boolean;
  json?: boolean;
}
// Preflight: when --workspace is set, resolve+announce the backend
// and projectRoot BEFORE the long-running git-worktree-add /
// jj-workspace-add / cp -a, so the operator can ctrl-c if the
// detected backend is wrong (e.g. cp -a falling through to a
// 60GB project tree because --workspace-project-root pointed at a
// non-VCS dir; surfaced by bug_agent_spawn_workspace_aborts_without_status).
// Skipped on --json so machine consumers get a single structured
// output, not preflight chatter.
async function maybePrintWorkspacePreflight(opts: SpawnOpts): Promise<void> {
  if (!opts.workspace || opts.json) return;
  const projectRoot = opts.workspaceProjectRoot ?? process.cwd();
  const backend: VcsBackendName = opts.workspaceBackend ?? (await detectBackend(projectRoot)).name;
  const warn =
    backend === "none"
      ? pc.yellow(
          " — WARNING: 'none' backend will cp -a the entire projectRoot. Verify --workspace-project-root.",
        )
      : "";
  console.log(
    pc.dim(
      `[mu] workspace preflight: backend=${pc.bold(backend)} projectRoot=${pc.bold(projectRoot)}${warn}`,
    ),
  );
}

export async function cmdSpawn(db: Db, name: string, opts: SpawnOpts): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);

  await maybePrintWorkspacePreflight(opts);

  const agent = await spawnAgent(db, {
    name,
    workstream,
    ...(opts.cli !== undefined ? { cli: opts.cli } : {}),
    ...(opts.command !== undefined ? { command: opts.command } : {}),
    ...(opts.tab !== undefined ? { tab: opts.tab } : {}),
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    ...(opts.workspaceBackend !== undefined ? { workspaceBackend: opts.workspaceBackend } : {}),
    ...(opts.workspaceFrom !== undefined ? { workspaceFrom: opts.workspaceFrom } : {}),
    ...(opts.workspaceProjectRoot !== undefined
      ? { workspaceProjectRoot: opts.workspaceProjectRoot }
      : {}),
    ...(opts.ctl === false ? { ctl: false } : {}),
  });
  // A pi agent whose control socket never answered still spawned (the
  // pane is usable by hand), but say so loudly on stderr: every exact
  // send / wait on it will fail until the extension answers.
  if (agent.ctl === "missing" || agent.ctl === "refused") {
    const warn = new AgentCtlUnreachableError(name, workstream, agent.ctlSocket, agent.ctl);
    console.error(pc.yellow(`warning: ${warn.message}`));
    printNextStepsTo(warn.errorNextSteps(), "stderr");
  }
  const workspace = opts.workspace ? getWorkspaceForAgent(db, name, workstream) : undefined;
  // Resolve the actual command that landed in the pane, so the operator
  // can confirm `--command 'pi-meta --no-solo'` (etc.) took effect.
  // Mirrors the resolution chain in spawnAgent: explicit --command >
  // $MU_<UPPER_CLI>_COMMAND > the cli value itself. Surfaced from
  // mufeedback note #159: 'Spawned ... (pi)' was misleading when
  // --command overrode the binary.
  const resolvedCommand = opts.command ?? resolveCliCommand(agent.cli);
  const commandOverridden = resolvedCommand !== agent.cli;
  // fb_agent_spawn_no_validation part C: when the override came from
  // an env var (no explicit --command), surface the env-var name in
  // the success line so config issues ("Spawned ... (pi-meta)" but I
  // never set $MU_PI_META_COMMAND — wait, I did, and it's stale")
  // are visible without `mu agent show`. Explicit --command takes
  // priority and is shown via the existing `(cmd: ...)` suffix below.
  const envSourced =
    opts.command === undefined ? resolveCliCommandWithSource(agent.cli) : undefined;
  const nextSteps: NextStep[] = [
    dispatchHint(agent),
    { intent: "Read pane", command: `mu agent read ${name} -w ${workstream}` },
    { intent: "Watch live events", command: `mu log -w ${workstream} --tail` },
    {
      intent: "Close (drops registry row, kills pane)",
      command: `mu agent close ${name} -w ${workstream}`,
    },
  ];
  // Best-effort: the pane exists, so a mux is up; the hint is decoration.
  try {
    const mux = await activeMux();
    nextSteps.push({
      intent: "Attach the pane",
      command: mux.attachHint({
        session: `mu-${workstream}`,
        window: agent.tab ?? name,
        inside: Boolean(process.env.TMUX),
      }),
    });
  } catch {
    // no hint
  }
  if (opts.json) {
    emitJson({
      agent,
      workspace: workspace ?? null,
      resolvedCommand,
      commandOverridden,
      // env-var attribution for machine consumers: present iff the
      // resolution came from $MU_<UPPER_CLI>_COMMAND. Mirrors the
      // human `(via $MU_PI_META_COMMAND)` suffix below.
      ...(envSourced?.resolvedFromEnv ? { resolvedFromEnvVar: envSourced.envVar } : {}),
      ctl: agent.ctl,
      ctlSocket: agent.ctlSocket,
      nextSteps,
    });
    return;
  }
  const wsBit = opts.workspace ? pc.dim(" with auto-workspace") : "";
  // Three display modes (precedence top-down):
  //   1. --command was explicit       → 'pi (cmd: pi-meta --no-solo)'
  //   2. resolved via env var override → 'pi (via $MU_PI_COMMAND)'
  //   3. bare CLI name on PATH         → 'pi'
  // Env-var attribution is preferred over the generic '(cmd: ...)'
  // suffix because the env-var name is the actionable knob the
  // operator can grep for / unset (fb_agent_spawn_no_validation pt C).
  const cliDisplay =
    opts.command !== undefined
      ? `${agent.cli} ${pc.dim(`(cmd: ${resolvedCommand})`)}`
      : envSourced?.resolvedFromEnv
        ? `${agent.cli} ${pc.dim(`(via $${envSourced.envVar})`)}`
        : agent.cli;
  console.log(
    `Spawned ${pc.bold(agent.name)} (${cliDisplay}) in window ${pc.bold(agent.tab ?? agent.name)} of ${pc.bold(`mu-${workstream}`)}, pane ${pc.dim(agent.paneId)}${wsBit}`,
  );
  if (workspace) console.log(pc.dim(`  workspace: ${workspace.path} (${workspace.backend})`));
  console.log(pc.dim(`  ctl: ${agent.ctl} (${agent.ctlSocket})`));
  printNextSteps(nextSteps);
}

function parseVia(raw: string | undefined): Transport | undefined {
  if (raw === undefined || raw === "ctl" || raw === "mux") return raw;
  throw new UsageError(`--via must be ctl or mux (got ${JSON.stringify(raw)})`);
}

export async function cmdSend(
  db: Db,
  rawName: string,
  text: string,
  opts: {
    workstream?: string;
    json?: boolean;
    strictStaleness?: boolean;
    steer?: boolean;
    via?: string;
    fresh?: boolean;
    force?: boolean;
  } = {},
): Promise<void> {
  const via = parseVia(opts.via);
  if (opts.force && !opts.fresh && parseSessionCommand(text) === undefined) {
    throw new UsageError("--force only applies with --fresh or a /new, /reload, /compact");
  }
  if (opts.fresh && opts.steer) throw new UsageError("--fresh and --steer are mutually exclusive");
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const stalenessCheck = await checkWorkspaceStalenessForDispatch(db, name, ws, {
    strict: opts.strictStaleness === true,
  });
  // dogfood_send_after_new_dropped: capture the undelivered warning
  // rather than letting it print raw, so it lands in the JSON payload
  // too. `exit 0` must not be able to mean "silently dropped".
  let undelivered: SendWarning | undefined;
  const agentRow = getAgent(db, name, ws);
  const sent = await sendToAgent(db, name, text, {
    workstream: ws,
    ...(opts.steer ? { mode: "steer" as const } : {}),
    ...(via !== undefined ? { via } : {}),
    ...(opts.fresh ? { fresh: true } : {}),
    ...(opts.force ? { force: true } : {}),
    onUndelivered: (w) => {
      undelivered = w;
    },
  });
  // A ctl reply with runs gives the exact wait baseline: the wait
  // returns the run's final text, so no pane read is needed.
  const nextSteps: NextStep[] = [
    sent.transport === "ctl" && sent.runs !== undefined
      ? {
          intent: "Wait for the response (returns its final text)",
          command: `mu agent wait ${name} --after-runs ${sent.runs} --json -w ${ws}`,
        }
      : { intent: "Read response", command: `mu agent read ${name} -n 50 -w ${ws}` },
    { intent: "Watch live events", command: `mu log -w ${ws} --tail` },
  ];
  // A plain ctl send: the reply carries pi's status from before the
  // dispatch, so the hints can tell a queued follow-up (busy) from a new
  // task landing in an old context (idle after a settled run). An older
  // extension replies without runs and its state is post-dispatch: no hints.
  const plainCtl =
    sent.transport === "ctl" && !opts.fresh && !opts.steer && sent.command === undefined;
  if (agentRow !== undefined && plainCtl && sent.state !== undefined && sent.runs !== undefined) {
    nextSteps.push(...plainSendHints(agentRow, { state: sent.state, runs: sent.runs }));
  }
  if (stalenessCheck.warned && stalenessCheck.nextStep !== null) {
    nextSteps.push(stalenessCheck.nextStep);
  }
  if (undelivered !== undefined) {
    nextSteps.unshift({
      intent: "VERIFY the prompt landed before waiting on it",
      command: `mu agent read ${name} -n 30 -w ${ws}`,
    });
  }
  if (opts.json) {
    emitJson({
      agentName: name,
      sentBytes: text.length,
      transport: sent.transport,
      fresh: opts.fresh === true,
      ...(sent.command !== undefined ? { command: sent.command } : {}),
      ...(sent.state !== undefined ? { state: sent.state } : {}),
      ...(sent.runs !== undefined ? { runs: sent.runs } : {}),
      delivered: undelivered === undefined,
      ...(undelivered !== undefined
        ? { undelivered: { reason: undelivered.reason, message: undelivered.message } }
        : {}),
      staleness: stalenessCheck.staleness,
      nextSteps,
    });
    return;
  }
  if (undelivered !== undefined) {
    console.error(pc.yellow(`warning: ${undelivered.message}`));
  } else {
    const how =
      sent.transport === "mux"
        ? "via mux paste"
        : opts.fresh
          ? "via ctl, fresh session"
          : sent.command !== undefined
            ? `via ctl, pi ran /${sent.command}`
            : sent.runs !== undefined
              ? `via ctl, pi was ${sent.state ?? "?"}, runs ${sent.runs}`
              : `via ctl, pi ${sent.state ?? "?"}`;
    console.log(pc.dim(`sent ${text.length} bytes to ${name} (${how})`));
  }
  printNextSteps(nextSteps);
}

export async function cmdRead(
  db: Db,
  rawName: string,
  opts: { lines?: number; workstream?: string; json?: boolean },
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const text = await readAgent(db, name, {
    workstream: ws,
    ...(opts.lines !== undefined ? { lines: opts.lines } : {}),
  });
  if (opts.json) {
    emitJson({
      agentName: name,
      lines: opts.lines ?? null,
      scrollback: text,
      scrollbackLines: text.split("\n").length,
    });
    return;
  }
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

export async function cmdList(
  db: Db,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const view = await listLiveAgents(db, { workstream });
  if (opts.json) {
    emitJson({ workstreamName: workstream, agents: view.agents, orphans: view.orphans });
    return;
  }
  console.log(pc.bold(`mu-${workstream}`));
  console.log(formatAgentsTable(view.agents));
  if (view.orphans.length > 0) {
    console.log("");
    console.log(pc.yellow(`Orphan panes (${view.orphans.length})`));
    console.log(pc.dim("  Panes that look like agents but aren't in the registry."));
    console.log(
      pc.dim(
        "  Run `mu agent adopt <pane-id>` to register one as a managed agent (e.g. `mu agent adopt %15`).",
      ),
    );
    for (const orphan of view.orphans) {
      console.log(
        `  ${pc.dim(orphan.paneId)} title=${pc.bold(orphan.title)} cli=${orphan.command}`,
      );
    }
  }
}

export async function cmdAgentShow(
  db: Db,
  rawName: string,
  opts: { lines?: number; json?: boolean; workstream?: string },
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  // v5: agents.name is per-workstream unique. Resolve the operator's
  // workstream up front so the lookup scopes correctly.
  const ws = await resolveWorkstream(opts.workstream);
  const agent = getAgent(db, name, ws);
  if (!agent) throw new AgentNotFoundError(name);
  const lines = opts.lines ?? 20;
  let scrollback: string;
  try {
    // Best-effort: `mu agent show` still has a registry row to print
    // when the mux is unreachable. Empty scrollback degrades the
    // status refresh below, it doesn't fail the verb.
    scrollback = await (await activeMux()).capturePane(agent.paneId, { lines });
  } catch {
    scrollback = "";
  }

  const reading = (await readAgentStates([agent], { stateDir: dirname(db.name) })).get(
    agentKey(agent),
  );
  const displayed = {
    ...agent,
    state: reading?.state ?? ("unknown" as const),
    source: reading?.source ?? ("none" as const),
    ctl: reading?.ctl ?? ("n/a" as const),
    since:
      reading?.since === null || reading?.since === undefined
        ? null
        : new Date(reading.since).toISOString(),
    ...(reading?.reason !== undefined ? { reason: reading.reason } : {}),
  };

  if (opts.json) {
    emitJson({ agent: displayed, scrollback, scrollbackLines: lines });
    return;
  }

  console.log(pc.bold(`${displayed.name}  ${statusIcon(displayed.state)} ${displayed.state}`));
  console.log(`  workstream : ${agent.workstreamName}`);
  console.log(`  cli        : ${agent.cli}`);
  console.log(`  pane       : ${pc.dim(agent.paneId)}`);
  console.log(`  window     : ${agent.tab ?? agent.name}`);
  console.log(`  role       : ${agent.role}`);
  console.log(`  created    : ${pc.dim(agent.createdAt)}`);
  console.log(`  updated    : ${pc.dim(agent.updatedAt)}`);

  console.log("");
  console.log(pc.bold(`Recent scrollback (last ${lines} lines)`));
  if (scrollback.trim() === "") {
    console.log(pc.dim("  (pane gone or empty)"));
    return;
  }
  for (const line of scrollback.replace(/\n+$/, "").split("\n")) {
    console.log(`  ${line}`);
  }
}

export async function cmdMe(
  db: Db,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const self = resolveSelf(db);
  const reading = (await readAgentStates([self], { stateDir: dirname(db.name) })).get(
    agentKey(self),
  );
  const displayed = {
    ...self,
    state: reading?.state ?? ("unknown" as const),
    source: reading?.source ?? ("none" as const),
    ctl: reading?.ctl ?? ("n/a" as const),
    since:
      reading?.since === null || reading?.since === undefined
        ? null
        : new Date(reading.since).toISOString(),
    ...(reading?.reason !== undefined ? { reason: reading.reason } : {}),
  };
  const owned = listTasksByOwner(db, self.workstreamName, self.name, {
    includeClosed: opts.includeClosed ?? false,
  });

  if (opts.json) {
    emitJson({ agent: displayed, ownedTasks: owned });
    return;
  }

  console.log(pc.bold(`${self.name}  ${statusIcon(displayed.state)} ${displayed.state}`));
  console.log(`  workstream : ${self.workstreamName}`);
  console.log(`  cli        : ${self.cli}`);
  console.log(`  pane       : ${pc.dim(self.paneId)}`);
  console.log(`  role       : ${self.role}`);
  console.log("");
  if (owned.length === 0) {
    console.log(pc.dim("Currently owns no tasks. Try `mu me next` for a recommendation."));
    return;
  }
  console.log(pc.bold(`Currently owns ${owned.length} task${owned.length === 1 ? "" : "s"}`));
  console.log(formatTaskListTable(owned));
}

export async function cmdClose(
  db: Db,
  rawName: string,
  opts: { workstream?: string; json?: boolean; discardWorkspace?: boolean } = {},
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const result = await closeAgent(db, name, {
    workstream: ws,
    ...(opts.discardWorkspace === true ? { discardWorkspace: true } : {}),
  });
  const next: NextStep[] = [];
  if (result.workspaceFreed) {
    next.push({
      intent: result.workspaceAutoFreedClean
        ? "Workspace was clean (no uncommitted changes, no commits since fork) so it was auto-freed alongside the agent"
        : "Workspace was freed alongside the agent (--discard-workspace)",
      command: "cd /  # the workspace dir is gone",
    });
  }
  next.push({
    intent: "Re-spawn under the same name",
    command: `mu agent spawn ${name} -w <workstream>`,
  });
  if (opts.json) {
    emitJson({ agentName: name, ...result, nextSteps: next });
    return;
  }
  if (!result.killedPane && !result.deletedRow) {
    console.log(pc.dim(`no agent named ${name} (already closed?)`));
    printNextSteps(next);
    return;
  }
  const wsBit = result.workspaceFreed
    ? pc.dim(result.workspaceAutoFreedClean ? " (workspace auto-freed)" : " (workspace discarded)")
    : "";
  console.log(`Closed ${pc.bold(name)}${wsBit}`);
  printNextSteps(next);
}

interface AdoptCliOpts {
  workstream?: string;
  name?: string;
  cli?: string;
  role?: string;
  json?: boolean;
}

export async function cmdAdopt(db: Db, paneOrTitle: string, opts: AdoptCliOpts): Promise<void> {
  const ws = await resolveWorkstream(opts.workstream);

  // Allow `mu agent adopt <pane-id>` (literal '%15') OR `mu agent adopt <pane-title>`
  // (a string that looks like an agent name; we look it up in the
  // workstream's tmux session). Pane-id form is preferred for scripting;
  // pane-title form is the ergonomic form for interactive use.
  let paneId: string;
  if (paneOrTitle.startsWith("%")) {
    paneId = paneOrTitle;
  } else {
    const session = `mu-${ws}`;
    // Load-bearing: resolving the title to a pane id IS the verb's input.
    const panes = await (await activeMux()).listPanesInSession(session);
    const match = panes.find((p) => p.title === paneOrTitle);
    if (!match) {
      throw new UsageError(
        `no pane with title '${paneOrTitle}' in session ${session} (try \`mu agent list -w ${ws}\` and pass the pane id)`,
      );
    }
    paneId = match.paneId;
  }

  const adoptOpts: AdoptAgentOptions = {
    paneId,
    workstream: ws,
    name: opts.name,
    cli: opts.cli,
    role: opts.role,
  };
  const result: AdoptAgentResult = await adoptAgent(db, adoptOpts);
  // Refresh title with composed state. Adopt may have set it to just
  // the agent name; this re-renders with status emoji etc.
  await refreshAgentTitle(db, result.agent.name, ws);

  // Window-scoped border for the adopted pane's window. (cmdInit set
  // it on _mu but adopted panes can be in any window.) Self-checks
  // MU_BANNER_QUIET; best-effort.
  await activeMux()
    .then((mux) => mux.enableMuPaneBordersForPane(paneId))
    .catch(() => {});

  const nextSteps: NextStep[] = [];
  // An adopted pi pane was started without MU_CTL_SOCK, so sends to it
  // fail loud. Say how to fix that before anything else.
  const ctlDown = result.ctl === "missing" || result.ctl === "refused";
  if (ctlDown) {
    nextSteps.push(
      {
        intent: "Restart pi in that pane with the control socket",
        command: `MU_CTL_SOCK=${result.ctlSocket} pi`,
      },
      {
        intent: "Or paste into the pane explicitly",
        command: `mu agent send ${result.agent.name} "..." --via mux -w ${ws}`,
      },
    );
  }
  nextSteps.push(
    dispatchHint(result.agent, { plain: ctlDown }),
    { intent: "Read pane", command: `mu agent read ${result.agent.name} -w ${ws}` },
    { intent: "Verify in agent list", command: `mu agent list -w ${ws}` },
  );

  if (opts.json) {
    emitJson({
      adopted: !result.alreadyAdopted,
      alreadyAdopted: result.alreadyAdopted,
      agent: result.agent,
      previousTitle: result.previousTitle,
      paneTitleSetTo: result.paneTitleSetTo,
      ctl: result.ctl,
      ctlSocket: result.ctlSocket,
      nextSteps,
    });
    return;
  }
  if (ctlDown) {
    console.error(
      pc.yellow(
        `warning: adopted pi agent ${result.agent.name} has no control socket (ctl: ${result.ctl}) at ${result.ctlSocket}; \`mu agent send\` will fail until pi runs with MU_CTL_SOCK set (or use --via mux)`,
      ),
    );
  }

  if (result.alreadyAdopted) {
    console.log(pc.dim(`already adopted: ${result.agent.name} (pane ${result.agent.paneId})`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(
    `Adopted ${pc.bold(result.agent.name)} ${pc.dim(`(pane ${result.agent.paneId}, workstream ${result.agent.workstreamName})`)}`,
  );
  if (result.previousTitle !== null && result.previousTitle !== result.paneTitleSetTo) {
    console.log(pc.dim(`  pane title: '${result.previousTitle}' -> '${result.paneTitleSetTo}'`));
  }
  printNextSteps(nextSteps);
}

export async function cmdKick(
  db: Db,
  rawName: string,
  opts: { workstream?: string; signal?: string; json?: boolean } = {},
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const sigRaw = opts.signal ?? "SIGINT";
  if (!isKickSignal(sigRaw)) {
    throw new UsageError(
      `--signal must be one of SIGINT, SIGTERM, SIGKILL (got ${JSON.stringify(sigRaw)})`,
    );
  }
  const signal: KickSignal = sigRaw;
  const result = await kickAgent(db, name, { workstream: ws, signal });
  const agentRow = getAgent(db, name, ws);
  const abort = agentRow === undefined ? null : abortHint(agentRow);
  const nextSteps: NextStep[] = [
    ...(abort === null ? [] : [abort]),
    {
      intent: "Read the pane to confirm the tool aborted",
      command: `mu agent read ${name} -n 30 -w ${ws}`,
    },
    {
      intent: "Send follow-up steering once the prompt returns",
      command: `mu agent send ${name} '...' -w ${ws}`,
    },
    {
      intent: "Escalate (graceful → polite → hammer)",
      command: `mu agent kick ${name} --signal SIGTERM -w ${ws}`,
    },
  ];
  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }
  console.log(
    `Kicked ${pc.bold(name)} ${pc.dim(`(signal=${result.signal}, pgid=${result.signaledPgid}, comm=${result.foregroundComm}, tty=${result.tty})`)}`,
  );
  printNextSteps(nextSteps);
}

export async function cmdAbort(
  db: Db,
  rawName: string,
  opts: { workstream?: string; timeout?: number; json?: boolean } = {},
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const result = await abortAgent(db, name, {
    workstream: ws,
    ...(opts.timeout === undefined ? {} : { timeoutMs: Math.round(opts.timeout * 1000) }),
  });
  // An abort that reported idle is the exact after state: no pane read.
  const nextSteps: NextStep[] = [
    {
      intent: "Steer it with the next instruction",
      command: `mu agent send ${name} '...' -w ${ws}`,
    },
    ...(result.after === "idle"
      ? []
      : [{ intent: "Read the pane", command: `mu agent read ${name} -n 30 -w ${ws}` }]),
  ];
  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }
  console.log(
    result.aborted
      ? `Aborted ${pc.bold(name)} ${pc.dim(`(${result.before} → ${result.after} in ${result.elapsedMs}ms)`)}`
      : `${pc.bold(name)} was ${result.before}; nothing to abort`,
  );
  printNextSteps(nextSteps);
}

/**
 * `mu agent wait <names...>` — block until agents finish working.
 *
 * The task-less counterpart to `mu task wait`: scratch / off-the-cuff
 * helpers have no task in the DAG, so the only "done" signal is the
 * agent's own runtime status. An agent fires when it goes **busy → any
 * other state** (it must be observed busy first, so an already-idle
 * agent doesn't fire instantly — you're waiting for THIS work to end).
 *
 * Mirrors `mu task wait` output/exit shape:
 *   exit 0 = condition met; 5 = timeout; 6 = a watched agent's pane died.
 * `--any`/`--first` fire on the first agent; default = all must fire.
 * `--first` additionally prints the firing agent's qualified ref.
 */
export async function cmdAgentWait(
  db: Db,
  rawNames: readonly string[],
  opts: {
    any?: boolean;
    first?: boolean;
    timeout?: number;
    afterRuns?: number;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  if (rawNames.length === 0) {
    throw new UsageError("mu agent wait: at least one agent name is required");
  }
  // --first is a CLI alias for --any with a richer output shape.
  const wantAny = opts.any === true || opts.first === true;
  const wantFirstShape = opts.first === true;

  // Resolve each ref — cross-workstream-aware via `<ws>/<name>`; bare
  // names resolve through the standard -w / $MU_SESSION / tmux chain.
  const refs = await Promise.all(
    rawNames.map(async (raw) => {
      const local: { workstream?: string } = { workstream: opts.workstream };
      const name = applyQualifiedRef(raw, local);
      const workstreamName = await resolveWorkstream(local.workstream);
      return { name, workstreamName };
    }),
  );

  // --after-runs is a ctl run count: refuse an agent that has none
  // rather than silently polling it with no baseline.
  if (opts.afterRuns !== undefined) {
    for (const ref of refs) {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      if (agent !== undefined && !expectsCtl(agent, agentCtlSocket(db, agent))) {
        throw new UsageError(
          `--after-runs needs a pi agent (control socket); ${ref.workstreamName}/${ref.name} runs ${agent.cli}. Drop --after-runs to wait on its pane state.`,
        );
      }
    }
  }

  const readStatuses = async (
    pending: readonly { name: string; workstreamName: string }[],
  ): Promise<
    Map<
      string,
      {
        status: "busy" | "needs_input" | "needs_permission" | "unknown" | null;
        unknownReason?: string;
      }
    >
  > => {
    const agents = pending.flatMap((ref) => {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      return agent === undefined ? [] : [agent];
    });
    const readings = await readAgentStates(agents, { stateDir: dirname(db.name) });
    const snapshots = new Map<
      string,
      {
        status: "busy" | "needs_input" | "needs_permission" | "unknown" | null;
        unknownReason?: string;
      }
    >();
    for (const ref of pending) {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      const reading = agent === undefined ? undefined : readings.get(agentKey(agent));
      snapshots.set(agentKey(ref), {
        status: reading?.alive === false ? null : (reading?.state ?? "unknown"),
        ...(reading?.reason !== undefined ? { unknownReason: reading.reason } : {}),
      });
    }
    return snapshots;
  };

  // pi agents: one ctl `wait` per agent, resolved by the extension on
  // agent_settled. `afterRuns` is --after-runs (the `runs` a send
  // replied with, so a run that settled before this wait still counts),
  // else a status read taken BEFORE the wait starts: a followUp queued
  // while busy runs in the same pi run.
  const watch = async (
    ref: { name: string; workstreamName: string },
    signal: AbortSignal,
  ): Promise<AgentWatch | undefined> => {
    const agent = getAgent(db, ref.name, ref.workstreamName);
    if (agent === undefined) return undefined;
    const sock = agentCtlSocket(db, agent);
    if (!expectsCtl(agent, sock)) return undefined;
    // With --after-runs the run past the baseline is the pending work:
    // read as busy until the wait settles; no status probe needed.
    let initial: AgentStatusSnapshot = { status: "busy" };
    let afterRuns = opts.afterRuns;
    if (afterRuns === undefined) {
      const probe = await ctlProbe(sock);
      if (probe.kind !== "ok") return undefined;
      afterRuns = probe.status.runs;
      initial = { status: ctlRuntimeState(probe.status.state) };
    }
    const settled = ctlRequest(sock, { op: "wait", afterRuns }, { signal }).then(
      (reply): AgentStatusSnapshot =>
        reply.ok && reply.state !== undefined
          ? {
              status: ctlRuntimeState(reply.state),
              ...(reply.lastText !== undefined ? { lastText: reply.lastText } : {}),
              ...(reply.lastError !== undefined ? { lastError: reply.lastError } : {}),
            }
          : { status: "unknown", unknownReason: reply.ok ? "ctl wait: no state" : reply.error },
      // The connection dropped. A socket that still answers (pi's /new
      // restarts the session) hands back to polling; one that does not
      // means the pi that served it is gone.
      async (): Promise<AgentStatusSnapshot> => {
        if (signal.aborted) return { status: "unknown" };
        const again = await ctlProbe(sock);
        return again.kind === "ok"
          ? { status: "unknown", unknownReason: "ctl wait interrupted" }
          : { status: null };
      },
    );
    return { initial, settled };
  };

  const timeoutMs = (opts.timeout ?? 600) * 1000;
  const result = await waitForAgents(db, refs, {
    any: wantAny,
    timeoutMs,
    readStatuses,
    watch,
    onInitialUnknown: (agents) => {
      const names = agents.map((agent) => `${agent.workstreamName}/${agent.name}`).join(", ");
      const reasons = [...new Set(agents.map((agent) => agent.unknownReason ?? "no reason"))].join(
        ", ",
      );
      process.stderr.write(
        `mu agent wait: state unknown for ${names} (${reasons}); waiting until --timeout\n`,
      );
    },
  });

  const dead = result.agents.filter((a) => a.dead);
  const fired = result.agents.filter((a) => a.fired);
  const firing = wantFirstShape && fired.length > 0 ? fired[0] : null;
  const qualified = (a: { workstreamName: string; name: string }): string =>
    `${a.workstreamName}/${a.name}`;
  // A pi run that settled with its final text already returned it:
  // read the pane only when the text is empty or the run errored.
  const readHint: NextStep[] =
    firing && (!firing.lastText || firing.lastError !== undefined)
      ? [
          {
            intent: "Read the finished agent",
            command: `mu agent read ${firing.name} -w ${firing.workstreamName}`,
          },
        ]
      : [];

  if (opts.json) {
    emitJson({
      agents: result.agents.map((a) => ({
        ...a,
        outcome: delegateOutcome(a, result.timedOut),
      })),
      timedOut: result.timedOut,
      ...(firing ? { firing: { workstream: firing.workstreamName, name: firing.name } } : {}),
      ...(dead.length > 0 ? { dead: dead.map(qualified) } : {}),
      nextSteps: readHint,
    });
  } else if (result.timedOut) {
    console.log(
      pc.yellow(
        `Timed out after ${opts.timeout ?? 600}s; ${fired.length}/${result.agents.length} finished`,
      ),
    );
  } else if (dead.length > 0 && fired.length === 0) {
    console.log(pc.red(`Agent pane(s) died: ${dead.map(qualified).join(", ")}`));
  } else if (firing) {
    console.log(`${pc.bold(qualified(firing))} finished`);
    printNextSteps(readHint);
  } else {
    console.log(`All ${result.agents.length} agent(s) finished`);
  }

  // Exit-code mapping mirrors `mu task wait`: 6 (a watched pane died)
  // wins over 5 (timeout); a clean met-condition is 0.
  if (dead.length > 0 && fired.length === 0) {
    process.exitCode = 6;
  } else if (result.timedOut) {
    process.exitCode = 5;
  }
}

// ─── commander wiring ──────────────────────────────────────────
//
// wireAgentCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import {
  handle,
  JSON_OPT,
  normalizeInheritedWorkstream,
  parseLines,
  parseNonNegativeInt,
  parsePositiveNumber,
  WORKSTREAM_OPT,
} from "../cli.js";
// wireSelfCommands needs cmdMyTasks / cmdMyNext which live in cli/tasks.ts
// (they're task queries scoped to the resolved-self agent). Lateral
// cluster→cluster import documented as the single intentional edge.
import { wireRemoteEnvCommand } from "./agents-remote.js";
import { cmdMyNext, cmdMyTasks } from "./tasks.js";

export function wireAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent-level commands");

  agent
    .command("spawn <name>")
    .description("Spawn a new agent in a mux pane")
    .option(
      "--cli <cli>",
      "agent CLI key (default: pi); also used as the lookup key for $MU_<UPPER_CLI>_COMMAND, e.g. --cli pi_big resolves $MU_PI_BIG_COMMAND",
      "pi",
    )
    .option(
      "--command <cmd>",
      "executable to run in the pane (defaults to $MU_<CLI>_COMMAND or the cli value)",
    )
    .option("--tab <tab>", "mux window/tab name to group under (defaults to agent name)")
    .option("--role <role>", "full-access | read-only", "full-access")
    .option("--cwd <cwd>", "initial working directory (ignored when --workspace is set)")
    .option("--workspace", "auto-create a VCS workspace for this agent and use its path as cwd")
    .option(
      "--workspace-backend <name>",
      "force a specific VCS backend for --workspace (jj | sl | git | none)",
    )
    .option(
      "--workspace-from <ref>",
      "base the workspace on a specific commit / branch / changeset",
    )
    .option(
      "--workspace-project-root <path>",
      "override the project root the workspace branches from (default: cwd)",
    )
    .option("--no-ctl", "skip the control-socket handshake with the mu pi extension")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        cli?: string;
        command?: string;
        tab?: string;
        role?: string;
        cwd?: string;
        workstream?: string;
        workspace?: boolean;
        workspaceBackend?: VcsBackendName;
        workspaceFrom?: string;
        workspaceProjectRoot?: string;
        ctl?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdSpawn(db, name, opts), this as Command)();
    });

  agent
    .command("send <name> <text>")
    .description(
      "Send text to an agent. pi agents: through the control socket (fails loud if it does not answer; no paste fallback); '/new', '/reload' and '/compact [instructions]' run inside pi over the socket (refused while busy unless --force), any other slash command is refused (--via mux types it into the pane). Non-pi CLIs: pasted into the pane (atomic on herdr; bracketed-paste on tmux). --fresh (pi only): start a new session and send the text into it as one operation; returns once the prompt's run has started, so an immediate next send cannot be lost. Use it instead of sending '/new' then the prompt",
    )
    .option(
      "--strict-staleness",
      "refuse send when the target agent's workspace is stale (default: warn and proceed)",
    )
    .option("--steer", "if pi is busy, interrupt the current run (default: queue as a follow-up)")
    .option("--via <transport>", "force the transport: ctl or mux (mux = paste into the pane)")
    .option(
      "--fresh",
      "pi only: new session + this prompt, one operation (refused with exit 4 while pi is busy)",
    )
    .option(
      "--force",
      "with --fresh or a pi /new, /reload, /compact: abandon a running turn instead of refusing",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string, text: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        strictStaleness?: boolean;
        steer?: boolean;
        via?: string;
        fresh?: boolean;
        force?: boolean;
      };
      return handle((db) => cmdSend(db, name, text, opts), this as Command)();
    });

  agent
    .command("read <name>")
    .description("Read an agent's pane scrollback")
    .option("-n, --lines <n>", "show last N lines (default: full scrollback)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        lines?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdRead(db, name, opts), this as Command)();
    });

  agent
    .command("list")
    .description("List agents in the current workstream (reconciled with the active mux)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdList(db, opts), this as Command)();
    });

  agent
    .command("show <name>")
    .description("Show an agent: registry row + recent scrollback (last N lines, default 20)")
    .option("-n, --lines <n>", "how many scrollback lines to show (default 20)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        lines?: number;
        json?: boolean;
        workstream?: string;
      };
      return handle((db) => cmdAgentShow(db, name, opts), this as Command)();
    });

  agent
    .command("close <name>")
    .description(
      "Kill an agent's pane and remove its registry row. If the agent has a clean workspace (no uncommitted changes AND no commits since fork) it is auto-freed alongside the close; otherwise close refuses (would orphan or lose work) — pass --discard-workspace to free both anyway (lossy), or run `mu workspace free <agent>` first.",
    )
    .option(
      "--discard-workspace",
      "free the agent's workspace alongside close (lossy: pending changes are gone)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        discardWorkspace?: boolean;
      };
      return handle((db) => cmdClose(db, name, opts), this as Command)();
    });

  agent
    .command("kick <name>")
    .description(
      "Signal the foreground process group of an agent's pane TTY (escape hatch for a worker wedged on an unbounded `find` / busy-wait loop). For a pi agent try `mu agent abort` first: it stops the turn through the control socket. Default --signal SIGINT (graceful, matches Ctrl-C). Refuses when the foreground is the wrapping CLI itself — use `mu agent close` to close the agent.",
    )
    .option(
      "--signal <sig>",
      "signal to send: SIGINT (default; graceful), SIGTERM (polite), SIGKILL (hammer)",
      "SIGINT",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        signal?: string;
        json?: boolean;
      };
      return handle((db) => cmdKick(db, name, opts), this as Command)();
    });

  // `mu agent abort` — stop a pi agent's turn through its control socket.
  agent
    .command("abort <name>")
    .description(
      "Stop a pi agent's current turn through its control socket (what Esc does in the pane), then wait until pi settles. Kills the running tool. A follow-up queued before the abort does not run: pi puts it back into the pane's editor unsent. Idle agents are left alone (exit 0). Exit 5 when still busy after --timeout; then use `mu agent kick`. Works for remote agents through the forwarded socket. Non-pi agents have no socket: use `mu agent kick`.",
    )
    .option(
      "--timeout <seconds>",
      "max seconds to wait for pi to settle (default 30)",
      parsePositiveNumber,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        timeout?: number;
        json?: boolean;
      };
      return handle((db) => cmdAbort(db, name, opts), this as Command)();
    });

  wireRemoteEnvCommand(agent);

  // `mu agent wait` — the task-less counterpart to `mu task wait`. Block
  // until agents finish (busy → any other state). For scratch /
  // off-the-cuff helpers that own no task to wait on.
  agent
    .command("wait <names...>")
    .description(
      "Block until agents finish working (busy → any other state). Keys on AGENTS, so it fires on needs_input too — a worker that stopped to ask a question satisfies it. For task-driven work prefer `mu task wait`, which keys on the task reaching CLOSED and has `--stuck-after` / `--on-stall` for the needs_input case; reach for this verb when the agent owns no task to wait on.",
    )
    .option("--any", "succeed as soon as ONE listed agent finishes (default: all)")
    .option("--first", "alias for --any that also prints the firing agent's ref")
    .option(
      "--timeout <seconds>",
      "max seconds to wait (0 = forever, default 600)",
      parseNonNegativeInt,
    )
    .option(
      "--after-runs <n>",
      "pi agents only: fire on the first run settled past N (the `runs` that `mu agent send --json` printed), even one that settled before this wait started",
      parseNonNegativeInt,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (names: string[]) {
      const opts = (this as Command).optsWithGlobals() as {
        any?: boolean;
        first?: boolean;
        timeout?: number;
        afterRuns?: number;
        workstream?: string | string[];
        json?: boolean;
      };
      return handle(
        (db) =>
          cmdAgentWait(db, names, {
            ...opts,
            workstream: normalizeInheritedWorkstream(opts.workstream),
          }),
        this as Command,
      )();
    });

  // `mu agent adopt` — register an existing mux pane as a managed agent.
  // Lives under `mu agent` like every other agent-lifecycle verb
  // (mu_adopt_should_be_mu_agent_adopt_for).
  agent
    .command("adopt <pane-or-title>")
    .description(
      "Register an existing mux pane as a managed mu agent (the inverse of `mu agent list`'s 'orphan' state). Pane id form '%15' or pane title form 'worker-2'.",
    )
    .option("--name <name>", "agent name (defaults to the pane's current title)")
    .option("--cli <cli>", "agent CLI key (default: pi)")
    .option("--role <role>", "full-access | read-only", "full-access")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (paneOrTitle: string) {
      const opts = (this as Command).optsWithGlobals() as Omit<AdoptCliOpts, "workstream"> & {
        workstream?: string | string[];
      };
      return handle(
        (db) =>
          cmdAdopt(db, paneOrTitle, {
            ...opts,
            workstream: normalizeInheritedWorkstream(opts.workstream),
          }),
        this as Command,
      )();
    });

  // ─── task ───────────────────────────────────────────────────────────
}

export function wireSelfCommands(program: Command): void {
  // `mu me` is the merged self-identity verb (audit_merge_self_verbs_into_mu_me).
  // Default action: identity block + owned tasks (was `mu whoami`).
  // Subcommands:
  //   mu me tasks       — just the owned-tasks table (was `mu my-tasks`)
  //   mu me next [-n K] — top-K ready in self.workstream (was `mu my-next`)
  const me = program
    .command("me")
    .description(
      "Identify the agent running this process (via $TMUX_PANE) plus its currently-owned tasks (excludes CLOSED by default). Subcommands: `mu me tasks` for just the owned-tasks table; `mu me next [-n K]` for the top-K ready tasks in this agent's workstream.",
    )
    .option("--include-closed", "include CLOSED tasks in the owned-tasks list")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean; includeClosed?: boolean };
      return handle((db) => cmdMe(db, opts), this as Command)();
    });

  me.command("tasks")
    .description(
      "List tasks owned by the current agent (the second half of `mu me`'s output). Excludes CLOSED by default.",
    )
    .option("--include-closed", "include CLOSED tasks in the list")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean; includeClosed?: boolean };
      return handle((db) => cmdMyTasks(db, opts), this as Command)();
    });

  me.command("next")
    .description(
      "Top-K ready tasks in the current agent's workstream (alias for `task next -w <self.workstream>`)",
    )
    .option(
      "-n, --lines <k>",
      "how many top-K tasks to return (default 1; 0 = all ready)",
      parseLines,
    )
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { lines?: number; json?: boolean };
      return handle((db) => cmdMyNext(db, opts), this as Command)();
    });
}
