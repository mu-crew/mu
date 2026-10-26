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
  // ── task verbs (src/cli/tasks/*) ──
  "task.add_titles": (ids: readonly string[], titles: number) =>
    `${ids.length} id(s) (${ids.join(" ")}) need ${ids.length} -t/--title, got ${titles}. If text was split by an apostrophe inside '...', pass long text with a quoted heredoc: --note - <<'EOF'`,
  "task.add_nothing": () => "task add: nothing to add",
  "task.add_truncated": (id: string) =>
    `hint: id '${id}' truncated from a longer slug; pass <id> positional to override (mu task add <id> --title ... ).\n`,
  "task.note_twice": (names: readonly string[]) =>
    `note text given twice (${names.join(" and ")}): pass it once, positionally or via -m/--message/--note/--text`,
  "task.note_required": () =>
    'note text required: mu task note <id> "..." (or -m/--message/--note/--text "...")',
  "task.note_kind_twice": () => "--report and --kind both set the note kind: pass one",
  "task.note_unseen": (owner: string, ws: string) =>
    `${owner} will not see this note: send it (mu agent send ${owner} -w ${ws} --steer, or --interrupt if the note makes the current work wasted)`,
  "task.notes_all_from": () =>
    "--all/--from pick a page of the whole history; they do not combine with --tail/--since/--since-claim",
  "task.notes_all_is_from": () => "--all is --from 1; pass one of them",
  "task.notes_since_twice": () =>
    "--since and --since-claim are mutually exclusive (both define a cutoff); pick one",
  "task.notes_tail": (tail: unknown) =>
    `--tail must be a positive integer (got ${JSON.stringify(tail)})`,
  "task.notes_since": (since: unknown) =>
    `--since must be an ISO 8601 timestamp (got ${JSON.stringify(since)})`,
  "task.update_nothing": () =>
    "nothing to update; pass at least one of --title, --impact, --effort-days",
  "task.by_required": () => "-b/--by requires at least one blocker task id",
  "task.claim_and_wait": () =>
    "--and-wait needs --for <worker>: a dispatch has something to wait on; --self and a worker's own claim would wait on the caller's own work",
  "task.claim_actor": () => "--actor only meaningful with --self (it overrides the actor name)",
  "task.wait_ids": () => "mu task wait: at least one task id is required",
  "task.close_note_alias": () => "--note is an alias of --evidence: pass one of them",
  "task.close_done_evidence": (id: string, ws: string) =>
    `closing ${id} as done needs evidence: mu task close ${id} -w ${ws} --evidence "<command + result>"`,
  "task.close_uncommitted": (path: string, commit: string) =>
    `uncommitted changes in ${path}; don't forget to commit: ${commit}`,
  "task.list_owner_mine": () => "--owner and --mine pick the owner two ways; pass one of them",

  // ── agent verbs (src/cli/agents.ts, agent-collect.ts, src/agents/*) ──
  "agent.spawn_cwd_worktree": () => "--cwd conflicts with --worktree (the worktree is the cwd)",
  "agent.spawn_needs_worktree": (flag: string) => `--${flag} requires --worktree`,
  "agent.spawn_gate_flag": (flag: string) =>
    `--${flag} cannot be used with a remote command gate (--host with a non-pi --command): it runs one command and reports its exit; wait on it`,
  "agent.spawn_gate_worktree": () =>
    "--worktree cannot be used with a remote command gate (--host with a non-pi --command): a gate runs in the profile's repo or --cwd",
  "agent.spawn_attempt_task": () => "--attempt needs --task",
  "agent.spawn_task_send": () => "--task needs --send: the sent text is the task's brief",
  "agent.spawn_name_hint": (name: string) =>
    `hint: agent name "${name}" does not match the smallest-unused-suffix convention (<role>-<n>; e.g. worker-1, reviewer-2). Accepted; consider renaming if you spawn additional workers.\n`,
  "agent.spawn_trust_warning": (name: string, skipped: boolean) =>
    `${name} is showing Claude's folder-trust dialog (default "No, exit")${skipped ? "; --send skipped" : ""}`,
  "agent.send_interrupt_excl": (flag: string) => `--interrupt and ${flag} are mutually exclusive`,
  "agent.send_interrupt_slash": () => "--interrupt sends a prompt, not a slash command",
  "agent.send_interrupt_empty": () => "--interrupt needs a non-empty prompt",
  "agent.send_timeout": () => "--timeout only applies with --interrupt",
  "agent.send_force": () => "--force only applies with --fresh or a /new, /reload, /compact",
  "agent.send_fresh_steer": () => "--fresh and --steer are mutually exclusive",
  "agent.send_wait_sig": () => "--wait needs the wait's signal handlers",
  "agent.send_wait_slash": () =>
    "--wait waits for the run a prompt starts; a slash command starts none",
  "agent.send_undelivered": (why: string) =>
    `${why}; not waiting for a run that may never have started`,
  "agent.check_not_accepted": (name: string, msgId: string) =>
    `${name}: message ${msgId} was not accepted (an evicted or in-flight send reads the same): read the pane before any resend`,
  "agent.wait_names": () => "mu agent wait: at least one agent name is required",
  "agent.wait_after_runs_pi": (ref: string, cli: string) =>
    `--after-runs needs a pi agent (control socket); ${ref} runs ${cli}. Drop --after-runs to wait on its pane state.`,
  "agent.wait_inc_one": () => "--inc names one pi process: wait on one agent at a time",
  "agent.wait_inc_pi": (ref: string, cli: string) =>
    `--inc needs a pi agent (control socket); ${ref} runs ${cli}. Drop --inc.`,
  "agent.wait_unknown": (names: string, reasons: string) =>
    `mu agent wait: state unknown for ${names} (${reasons}); waiting until --timeout\n`,
  "agent.collect_cwd": () =>
    "agent collect fetches into the git repo of the current directory: cd into it",
  "agent.ctl_refused": (what: string, error: unknown) => `control socket refused ${what}: ${error}`,
  "agent.pi_refused": (cmd: string, error: unknown) => `pi refused /${cmd}: ${error}`,
} as const satisfies Record<string, (...facts: never[]) => string>;

export type MessageKey = keyof typeof MESSAGES;

/** The line for `key`, filled with the facts it names. */
export function say<K extends MessageKey>(
  key: K,
  ...facts: Parameters<(typeof MESSAGES)[K]>
): string {
  return (MESSAGES[key] as (...f: Parameters<(typeof MESSAGES)[K]>) => string)(...facts);
}
