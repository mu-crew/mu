// mu — the message table: every error and hint line an agent reads, in ONE place.
//
// A line is `MESSAGES["<domain>.<what>"]`, a function of the facts it names, rendered
// with `say(key, ...facts)`. The key is stable; the wording is free to change (t_errors
// hill-climbs one line at a time). Classification, exit codes, typed error classes,
// structured fields and guards never read the prose: they live at the throw site.
// Leaf module: it imports nothing, so any file may use it.

export const MESSAGES = {
  // ── task errors (src/tasks/errors.ts, id.ts, claim.ts, task-auto.ts) ──
  "task.not_found": (id: string) => `no such task: ${id}`,
  "task.id_invalid": (attempted: string) =>
    `invalid task id: ${JSON.stringify(attempted)} (expected /^[a-z][a-z0-9_-]{0,63}$/)`,
  "task.slug_empty": (title: string) =>
    `title yields empty slug: ${JSON.stringify(title)} (no ASCII letter or digit to derive an id from)`,
  "task.exists": (id: string) => `task already exists: ${id}`,
  "task.not_in_workstream": (id: string, expected: string, actual: string) =>
    `task ${id} is in workstream ${actual}, not ${expected}`,
  "task.owned": (id: string, owner: string) => `task ${id} is already owned by ${owner}`,
  "task.owned_sql": () =>
    "a claim in this SQL would take an owned task; release it first: mu task release <id> -w <ws>",
  "task.claimer_unregistered": (name: string, pane: string | null) =>
    `claimer '${name}'${pane !== null ? ` (pane ${pane})` : ""} is not a registered mu agent (no row in agents table)`,
  "task.cycle": (from: string, to: string, path: readonly string[]) =>
    path.length > 1
      ? `adding edge ${from} -> ${to} would create a cycle: ${[from, ...path].join(" -> ")}`
      : `adding edge ${from} -> ${to} would create a cycle`,
  "task.cross_workstream_edge": (blocker: string, bws: string, dependent: string, dws: string) =>
    `cross-workstream edge: blocker '${blocker}' is in workstream '${bws}', dependent '${dependent}' is in workstream '${dws}'`,
  "task.close_reason_needed": (verb: "close" | "park", id: string, substate: string) =>
    verb === "close"
      ? `closing ${id} as ${substate} needs a reason (--why "...")`
      : `parking ${id} needs a reason (--why "...")`,
  "task.close_needs_evidence": (id: string) =>
    `closing ${id} needs evidence (--evidence "<command + result>")`,
  "task.close_needs_evidence_sql": () =>
    'a close in this SQL has no close note; close with: mu task close <id> -w <ws> --evidence "<command + result>"',
  "task.open_blockers": (id: string, blockers: readonly string[]) =>
    `task ${id} has open blockers: ${blockers.join(", ")}`,
  "task.open_blockers_sql": () =>
    "a task in this SQL closed as done with open blockers; inspect with: mu task tree <id> -w <ws>",
  "task.park_state": (id: string, status: "IN_PROGRESS" | "CLOSED") =>
    status === "IN_PROGRESS"
      ? `cannot park ${id}: it is IN_PROGRESS (release it first)`
      : `cannot park ${id}: it is CLOSED (open it first)`,
  "task.in_triage": (id: string) =>
    `task ${id} is in triage (OPEN/triage); accept it or claim with --force`,
  "task.parked": (id: string) =>
    `task ${id} is parked (OPEN/parked); unpark it or claim with --force`,
  "task.human": (id: string, ws: string, action: string) =>
    `task ${id} is a human task: ${action} refused; it resolves only by an explicit \`mu task close ${id} -w ${ws}\``,
  "task.invalid_substate": (status: string, substate: string, expected: readonly string[]) =>
    `invalid substate for ${status}: ${JSON.stringify(substate)} (expected one of: ${expected.join(", ")})`,
  "task.note_range": (id: string, n: number, total: number) =>
    total === 0
      ? `${id} has no notes; note ${n} does not exist`
      : `note ${n} is not one of ${id}'s notes (1..${total})`,
  "task.claim_self_and_for": () => "claimTask: --self and --for are mutually exclusive",
  "task.claim_no_agent": () =>
    "claimTask: no agent name (pass opts.agentName, run inside an mu-spawned pane with $MU_AGENT_NAME set, or pass --self for an anonymous claim)",
  "task.auto_cli_required": () =>
    "--cli <key> is required (the model key `mu next` spawns); or --off",
  "task.auto_reserved_ws": (ws: string) =>
    `workstream '${ws}' is the delegate queue; it is never auto-dispatched`,
  "task.auto_cli_key": (cli: string) =>
    `--cli must be a model key like pi or pi-big (got ${JSON.stringify(cli)})`,
  "task.auto_max": (max: number) => `--max must be an integer >= 1 (got ${max})`,
  "task.auto_no_blockers": (umbrella: string) => `${umbrella} has no open blockers to authorise`,
  "task.auto_none_given": () => "no tasks given",

  // ── agent errors (src/agents/errors.ts) ──
  "agent.cli_not_found": (cli: string, binary: string, envVar: string) =>
    `--cli ${cli} resolved to binary "${binary}" which is not on PATH (and not an executable absolute/relative path). Refusing to spawn — would create a pane that dies immediately on "command not found". For a custom alias, set ${envVar} to its real path.`,
  "agent.exists": (name: string) => `agent already exists in this workstream: ${name}`,
  "agent.name_exhausted": (name: string, reason: string) =>
    `no free agent name after ${name}: ${reason}`,
  "agent.not_found": (name: string, ws: string | undefined) =>
    ws === undefined ? `no such agent: ${name}` : `no such agent: ${name} (in workstream ${ws})`,
  "agent.not_in_workstream": (name: string, expected: string, actual: string) =>
    `agent ${name} is in workstream ${actual}, not ${expected}`,
  "agent.scrollback": (text: string) =>
    `\n\n--- pane scrollback ---\n${text}\n--- end scrollback ---`,
  "agent.died_cause_remote": (host: string | undefined) =>
    `The pane is a remote transport${host === undefined ? "" : ` (host ${host})`}, so the likely causes are remote: the remote binary is missing, or its env (PATH, provider keys) is absent because a non-interactive shell skips ~/.zshrc / ~/.bashrc (the profile's shell template should run \`$SHELL -ilc\`); or the host refused the socket forward (check AllowStreamLocalForwarding).`,
  "agent.died_cause_local": () =>
    "Most common cause: the spawned CLI exited immediately (e.g. a wrapper CLI blocking on its instance lock; set MU_<UPPER_CLI>_COMMAND to a non-blocking variant to bypass).",
  "agent.died_on_spawn": (
    name: string,
    when: string,
    pane: string,
    cause: string,
    detail: string,
  ) => `agent ${name} died ${when} (pane ${pane}). ${cause}${detail}`,
  "agent.startup_error": (name: string, when: string, pane: string, line: string, scroll: string) =>
    `agent ${name} reported a startup error ${when} (pane ${pane}). The pane is alive but the spawned CLI parked at an error prompt instead of becoming a working agent.\n\nMatched line: ${line}${scroll}`,
  "agent.ctl_unreachable": (name: string, kind: string, socket: string) =>
    `agent ${name} has no control socket (ctl: ${kind}) at ${socket}; mu cannot send to or wait on it exactly`,
  "agent.send_indeterminate": (name: string, op: string, reason: string, msgId?: string) =>
    `agent ${name}: ${op} was written to its control socket but no reply arrived (${reason}); delivery unknown${msgId === undefined ? "" : `, msgId ${msgId}`}. Never resend blindly`,
  "agent.restarted": (name: string, expected: string, actual: string | undefined) =>
    `agent ${name} restarted (incarnation ${expected} → ${actual ?? "unknown"}); its earlier run is gone: re-send the brief`,
  "agent.pane_still_alive": (name: string, ws: string, pane: string, state: true | "unknown") =>
    `agent ${name}: pane ${pane} ${state === true ? "is still alive after the kill" : "could not be checked"}; its row is kept. Close the pane in your multiplexer, then preview: mu agent close ${name} -w ${ws}`,
  "agent.replaced": (name: string, ws: string, during: "closed" | "sent to" | "collected") =>
    during === "closed"
      ? `agent ${name} was replaced while it was being closed; the replacement was left alone. Preview it: mu agent close ${name} -w ${ws}`
      : during === "collected"
        ? `agent ${name} was replaced while its commits were being collected; the replacement's record was left alone. Look at it: mu agent list -w ${ws}`
        : `agent ${name} was replaced before the prompt was written; nothing was sent to the replacement. Look at it: mu agent list -w ${ws}`,
  "agent.lock_busy": (name: string, ws: string) =>
    `agent ${name} is being changed by another mu process (its lock is held); nothing was done. Retry: mu agent close ${name} -w ${ws}`,
  "agent.pane_dead": (name: string, pane: string, msgId?: string) =>
    `agent ${name} is dead: its pane ${pane} no longer exists, so its control socket is gone${msgId === undefined ? "" : `; a send (msgId ${msgId}) was written first, so delivery is unknown`}`,
  "agent.abort_needs_ctl": (name: string, cli: string) =>
    `agent ${name} runs ${cli}, not pi: abort needs the mu pi extension; close the agent instead`,
  "agent.abort_timeout": (name: string, ms: number) =>
    `agent ${name} was still busy ${ms}ms after the abort`,
  "agent.fresh_needs_ctl": (name: string, cli: string) =>
    `agent ${name} runs ${cli} without a control socket: --fresh needs the mu pi extension`,
  "agent.extension_outdated": (name: string, version: string, feature: boolean, op: string) =>
    `agent ${name}'s mu pi extension (${version}) predates ${feature ? "feature" : "op"} ${op}: its pi loaded an older mu build; reload or respawn it`,
  "agent.busy": (name: string, command: string) =>
    `agent ${name} is busy: ${command} would abandon its running turn`,
  "agent.slash_unsupported": (name: string, supported: readonly string[], text: string) =>
    `agent ${name} runs pi: over the control socket mu runs only ${supported.join(", ")}; ${JSON.stringify(text.split("\n")[0])} is not one of them; type it in the pane yourself`,
  "agent.empty_send": (name: string) =>
    `agent ${name} runs pi: an empty message cannot go over the control socket; press Enter in the pane yourself`,
  "agent.send_unsupported": (name: string, cli: string) =>
    `agent ${name} runs ${cli}, not pi: tmux has no reliable send for it; spawn it on herdr (MU_MUX=herdr) or use pi`,
  "agent.send_refused": (reason: string) => `control socket refused the send: ${reason}`,
  "agent.attempt_busy": (task: string, key: string) =>
    `spawn attempt ${key} of task ${task} is running in another mu process; nothing was done. Retry when it finishes (the replay returns its outcome)`,
  "agent.attempt_failed": (task: string, key: string, reason: string) =>
    `attempt ${key} of task ${task} cannot run: ${reason}; nothing was sent`,
  "agent.attempt_stopped": (task: string, key: string, reason: string) =>
    `attempt ${key} of task ${task} was stopped: ${reason}`,
  "agent.task_state": (task: string, reason: string) => `task ${task} ${reason}; nothing was sent`,
  "agent.receipt_conflict": (task: string, key: string, savedName: string) =>
    `attempt ${key} of task ${task} already ran with a different request (agent ${savedName}); a second prompt is a new attempt: pass --attempt <new key>`,
  "agent.trust_dialog": (name: string) =>
    `agent ${name} is showing Claude's folder-trust dialog (default "No, exit"); the task prompt was not sent and the spawn was rolled back`,
} as const satisfies Record<string, (...facts: never[]) => string>;

export type MessageKey = keyof typeof MESSAGES;

/** The line for `key`, filled with the facts it names. */
export function say<K extends MessageKey>(
  key: K,
  ...facts: Parameters<(typeof MESSAGES)[K]>
): string {
  return (MESSAGES[key] as (...f: Parameters<(typeof MESSAGES)[K]>) => string)(...facts);
}
