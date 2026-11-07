// mu — the message table: most error and hint lines an agent reads, in ONE place.
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
    `title yields empty slug: ${JSON.stringify(title)} (no ASCII letter or digit to derive an id from); pass one: mu task add <id> -t "..."`,
  "task.exists": (id: string) => `task already exists: ${id}`,
  "task.not_in_workstream": (id: string, expected: string, actual: string) =>
    `task ${id} is in workstream ${actual}, not ${expected}; pass -w ${actual}`,
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
  "task.close_needs_evidence": (id: string, ws: string) =>
    `closing ${id} needs evidence: mu task close ${id} -w ${ws} --evidence "<command + result>"`,
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
  "task.not_open": (id: string, status: string, owner: string | null) =>
    `task ${id} is ${status}${owner === null ? "" : ` (owned by ${owner})`}, not OPEN`,
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
  "task.claim_self_and_for": () => "--self and --for are mutually exclusive",
  "task.claim_no_claimer": () =>
    "no claimer: pass --for <worker> (dispatch), --self (orchestrator), or run in a mu-spawned pane",
  "task.claim_no_agent": () =>
    "no agent name (pass opts.agentName, run inside an mu-spawned pane with $MU_AGENT_NAME set, or pass --self for an anonymous claim)",
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
    `agent ${name} is in workstream ${actual}, not ${expected}; pass -w ${actual}`,
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
  "agent.pane_still_alive": (
    name: string,
    ws: string,
    pane: string,
    state: true | "unknown",
    reason?: string,
  ) =>
    state === true
      ? `agent ${name}: pane ${pane} is still alive after the kill; its row is kept. Close the pane in your multiplexer, then preview: mu agent close ${name} -w ${ws}`
      : `agent ${name}: pane ${pane} could not be checked${reason === undefined ? "" : ` (${reason})`}; its row, tasks and worktree are kept. Retry once the multiplexer answers, or if you know the pane is gone preview with --force: mu agent close ${name} -w ${ws} --force`,
  "agent.replaced": (
    name: string,
    ws: string,
    during: "closed" | "sent to" | "collected" | "reattached",
  ) =>
    during === "closed"
      ? `agent ${name} was replaced while it was being closed; the replacement was left alone. Preview it: mu agent close ${name} -w ${ws}`
      : during === "reattached"
        ? `agent ${name}'s lease reservation kept changing while its reattach was planned; nothing was changed. Preview again: mu agent reattach ${name} -w ${ws}`
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
  "agent.fresh_unconfirmed": (name: string, ws: string, command: string, ms: number) =>
    `pasted ${command} to agent ${name}, but no new session started within ${ms}ms: the text was not sent and ${command} is not resent; read the pane (mu agent read ${name} -w ${ws}) before trying again`,
  "agent.fresh_text_unconfirmed": (name: string, command: string, ms: number) =>
    `pasted ${command} and the text to agent ${name}, but no run in a new session showed within ${ms}ms: the send is unconfirmed (it may have reached the old session) and is not resent; read the pane before sending again`,
  "agent.interrupt_unconfirmed": (name: string) =>
    `agent ${name}'s harness reports no interrupt: mu pressed Escape and recorded it as idle? (unconfirmed); if the Escape only closed an overlay, the send that follows reads unknown`,
  "agent.interrupt_unrecorded": (name: string, ws: string) =>
    `pressed Escape on agent ${name}, whose harness reports no interrupt, but murmur did not record mu's interrupted event (murmur absent, older than murmur hook mu, or it refused it): the agent still reads running, and nothing was sent; read the pane (mu agent read ${name} -w ${ws}) before trying again`,
  "agent.fresh_remote": (name: string, ws: string, command: string) =>
    `agent ${name} runs on a host: a fresh session there is confirmed only by polling its node, which mu never does; nothing was sent. Send ${command} first (mu agent send ${name} ${command} -w ${ws}), then the text once the pane shows the new session (mu agent read ${name} -w ${ws})`,
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
    `agent ${name} runs ${cli}, not pi: tmux has no reliable send for it; spawn it on herdr (MU_MUX=herdr), start it with the prompt as an argument (--command "${cli} '<prompt>'"), or use pi`,
  "agent.send_refused": (reason: string) => `control socket refused the send: ${reason}`,
  "agent.empty_send_hooks": (name: string) =>
    `agent ${name} is on the hooks channel: an empty message submits nothing; press Enter in the pane yourself`,
  "agent.task_brief_hooks": (name: string) =>
    `agent ${name} is on the hooks channel and has no cwd to write its task brief file in: nothing was sent`,
  "agent.remote_brief_too_large": (
    name: string,
    host: string,
    bytes: number,
    cap: number,
    escaped: number,
  ) =>
    `the task brief for ${name} is ${bytes} bytes${escaped === bytes ? "" : ` (${escaped} with its \\ and ' escaped)`}; on ${host} it is written through the host's exec template as one argument, which takes at most ${cap} bytes (${cap / 1024} KB) of brief: nothing was sent; shorten the brief and point at files in the repo for the rest`,
  "agent.remote_brief_command_too_large": (
    name: string,
    host: string,
    bytes: number,
    cap: number,
    command: number,
  ) =>
    `the task brief for ${name} is ${bytes} bytes, and the command that writes it on ${host} through the host's exec template comes to ${command} bytes as one argument, over the ${cap}-byte limit: nothing was sent; shorten the brief (or the exec template or the cwd)`,
  "agent.task_brief_hooks_unseen": (name: string) =>
    `the brief pointer was pasted to ${name}, but its inbox shows no run since: still unknown, never resent (if it never started, send the pointer yourself)`,
  "agent.fence_unsupported": (name: string, channel: string) =>
    `agent ${name} is on the ${channel} channel, which has no write fence: nothing was sent`,
  "agent.steer_unsupported": (name: string, ws: string, channel: string) =>
    `agent ${name} is on the ${channel} channel, which has no mid-turn steer: nothing was sent; send it once the turn ends (mu agent wait ${name} -w ${ws}), or interrupt the turn`,
  "agent.send_gate": (name: string, ws: string, state: string, reason: string) =>
    state === "blocked"
      ? `agent ${name} is blocked on a permission dialog (${reason}): nothing was sent; answer it with mu agent answer ${name} <choice> -w ${ws}`
      : state === "running"
        ? `agent ${name} is running a turn (${reason}): nothing was sent; wait for it (mu agent wait ${name} -w ${ws}), or paste anyway with --force`
        : `agent ${name}'s state is unknown (${reason}): nothing was sent; read the pane (mu agent read ${name} -w ${ws}), then paste anyway with --force`,
  "agent.send_unconfirmed": (name: string, ms: number, submitRetry = false) =>
    `pasted to agent ${name}, but its run count did not rise within ${ms}ms${submitRetry ? " (its text sat unsubmitted in the input line, so the submit key was pressed once more)" : ""}: the send is unconfirmed and is not resent; read the pane before sending again`,
  "agent.not_blocked": (name: string, ws: string, state: string) =>
    `agent ${name} has no pending permission dialog (state ${state}): nothing was sent; read the pane (mu agent read ${name} -w ${ws}), or type the keys anyway with --force`,
  "agent.answer_keys": () =>
    "give the answer as one or more keys, each one line (e.g. mu agent answer worker-1 1)",
  "agent.answer_unconfirmed": (name: string, ws: string) =>
    `no event confirmed the answer: read the pane (mu agent read ${name} -w ${ws}) before answering again`,
  "agent.answer_unsupported": (name: string, channel: string) =>
    channel === "ctl"
      ? `agent ${name} runs pi on the ctl channel: answer its dialog in the pane`
      : `agent ${name} is on the ${channel} channel, and this multiplexer cannot type keys into its pane: answer the dialog in the pane`,
  "agent.attempt_busy": (task: string, key: string) =>
    `spawn attempt ${key} of task ${task} is running in another mu process; nothing was done. Retry when it finishes (the replay returns its outcome)`,
  "agent.attempt_failed": (task: string, key: string, reason: string) =>
    `attempt ${key} of task ${task} cannot run: ${reason}; nothing was sent`,
  "agent.attempt_stopped": (task: string, key: string, reason: string) =>
    `attempt ${key} of task ${task} was stopped: ${reason}`,
  "agent.task_state": (task: string, reason: string) => `task ${task} ${reason}; nothing was sent`,
  "agent.attempt_ended": (
    task: string,
    key: string,
    agent: string,
    stale: "deleted" | "replaced",
    nextKey: string,
  ) =>
    `attempt ${key} of task ${task} already delivered its prompt and has ended: ${
      stale === "deleted"
        ? `its agent ${agent} is gone (closed or reaped)`
        : `the name ${agent} now belongs to another agent, left alone`
    }. Nothing was started. To start the task again: pass --attempt ${nextKey}`,
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
  // By the owner's channel: only ctl steers mid-turn; hooks interrupts or waits for the turn; mux only sends.
  "task.note_unseen": (owner: string, ws: string, channel: "ctl" | "hooks" | "mux") => {
    const send = `mu agent send ${owner} -w ${ws}`;
    const text = "- <<'EOF' (the note text, then EOF)";
    if (channel === "ctl")
      return `${owner} will not see this note: send it into the running turn (${send} --steer ${text}), or pass --interrupt instead of --steer if the note makes the current work wasted`;
    if (channel === "hooks")
      return `${owner} will not see this note, and its hooks channel has no mid-turn steer: send it once the turn ends (mu agent wait ${owner} -w ${ws}, then ${send} ${text}), or ${send} --interrupt ${text} if the note makes the current work wasted`;
    return `${owner} will not see this note: send it (${send} ${text})`;
  },
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
  "task.close_uncommitted": (path: string, commit: string) =>
    `uncommitted changes in ${path}; don't forget to commit: ${commit}`,
  "task.list_owner_mine": () => "--owner and --mine pick the owner two ways; pass one of them",

  // ── agent verbs (src/cli/agents.ts, agent-collect.ts, src/agents/*) ──
  "agent.spawn_cwd_worktree": () => "--cwd conflicts with --worktree (the worktree is the cwd)",
  "agent.spawn_needs_worktree": (flag: string) => `--${flag} requires --worktree`,
  "agent.spawn_gate_flag": (flag: string) =>
    `--${flag} cannot be used with a remote command gate (--host with a non-pi --command): it runs one command and reports its exit; wait on it`,
  "agent.spawn_gate_worktree": () =>
    "--worktree cannot be used with a remote command gate (--host with a non-pi --command): a gate runs in --cwd, else the profile's default repo",
  "agent.spawn_model_unknown_cli": (cli: string) =>
    `--model goes through a harness's own model flag, and ${cli} is not claude, codex, cursor-agent, muse or pi: put the model in --command or MU_<KEY>_COMMAND instead`,
  "agent.spawn_attempt_task": () => "--attempt needs --task",
  "agent.spawn_task_default": (task: string, ws: string, title: string) =>
    `Task ${task} (workstream ${ws}): ${title}. Read: mu task notes ${task} -w ${ws}`,
  "agent.spawn_name_hint": (name: string) =>
    `hint: agent name "${name}" does not match the smallest-unused-suffix convention (<role>-<n>; e.g. worker-1, reviewer-2). Accepted; consider renaming if you spawn additional workers.\n`,
  "agent.spawn_trust_warning": (name: string, skipped: boolean) =>
    `${name} is showing Claude's folder-trust dialog (default "No, exit")${skipped ? "; --send skipped" : ""}`,
  "agent.send_interrupt_excl": (flag: string) => `--interrupt and ${flag} are mutually exclusive`,
  "agent.send_interrupt_slash": () => "--interrupt sends a prompt, not a slash command",
  "agent.send_interrupt_empty": () => "--interrupt needs a non-empty prompt",
  "agent.send_timeout": () => "--timeout only applies with --interrupt",
  "agent.send_force": () =>
    "--force only applies with --fresh or a /new, /reload, /compact, or to an agent on the hooks channel",
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
  // ── db, mux, sync, host, remote, workstream, worktree (src/*.ts, src/mux/*) ──
  "db.test_real_db": (realDb: string) =>
    `openDb refused: tests must NEVER write to the user DB (${realDb}). Set MU_DB_PATH to a per-test temp path (test/_runCli.ts does this automatically) or pass an explicit { path } argument. The leak source is the call site of openDb in this stack frame.`,
  "db.schema_old": (detected: number, required: number) =>
    `Detected v${detected} schema; v${required} is required. mu ships NO in-place migration — your v${detected} DB is untouched. Back it up or move it aside, then start a fresh v${required} DB.`,
  "db.schema_new": (detected: number, supported: number, stamp: "schema" | "capture") =>
    stamp === "schema"
      ? `DB is v${detected}; this mu understands up to v${supported}. Upgrade mu.`
      : `DB's capture triggers are revision ${detected}; this mu understands up to ${supported}. Upgrade mu.`,
  "db.sqlite_old": (version: string) =>
    `SQLite ${version} is too old; mu needs >= 3.42 (unixepoch('subsec') for the op clock). The DB was not touched.`,
  "workstream.not_found": (ws: string, near: readonly string[] = [], init = false) =>
    `no such workstream: ${ws}${near.length > 0 ? ` (did you mean ${near.join(", ")}?)` : ""}${
      init ? `; \`mu workstream init ${ws}\` creates it` : ""
    }`,
  "workstream.torn_down": (ws: string, at: string) =>
    `workstream ${ws} is torn down (at ${at}); \`mu workstream init ${ws}\` to reuse the name`,
  "workstream.exists": (ws: string) => `workstream already exists: ${ws}`,
  "workstream.name_invalid": (attempted: string, reservedPrefix: boolean) =>
    `invalid workstream name ${JSON.stringify(attempted)}: ${
      reservedPrefix
        ? `the 'mu-' prefix is reserved (mu adds it to the tmux session name, so '${attempted}' would be double-prefixed as 'mu-${attempted}'). Drop the 'mu-' from the name.`
        : `use [a-z][a-z0-9_-]{0,31}`
    }`,
  "workstream.name_reserved": (attempted: string) =>
    `workstream name ${JSON.stringify(attempted)} is reserved: it is the off-the-cuff bucket and auto-creates on first spawn. Don't 'init' it.`,
  "workstream.changed": (ws: string, expected: number, actual: number, preview: string) =>
    `workstream ${ws} changed since preview (rev ${expected} → ${actual}); preview again: ${preview}`,
  "workstream.has_agents": (ws: string, agents: readonly string[]) =>
    `torn-down workstream ${ws} still has ${agents.length} local agent row${agents.length === 1 ? "" : "s"} (${agents.join(", ")}); close each once its pane is gone (preview, then apply with --if): mu agent close ${agents[0]} -w ${ws}`,
  "workstream.panes_live": (ws: string, agents: readonly string[]) =>
    `workstream ${ws} has live panes outside its session (${agents.join(", ")}); close them first (preview, then apply with --if): mu agent close ${agents[0]} -w ${ws}`,
  "workstream.session_live": (ws: string, session: string) =>
    `torn-down workstream ${ws} still has a live mux session ${session}; kill it first: mu workstream teardown ${ws}`,
  "worktree.vcs_required": (root: string) =>
    `--worktree requires a git repository; ${root} is not inside one`,
  "worktree.dirty": (agent: string, path: string, shown: readonly string[], more: number) =>
    `agent ${agent} has uncommitted work in ${path}; refusing to close: ${
      shown.length > 0 ? shown.join(", ") : "git status unreadable"
    }${more > 0 ? ` (+${more} more)` : ""}`,
  "worktree.path_not_empty": (agent: string, path: string, why: string) =>
    `worktree dir already on disk for agent ${agent} (${path}): ${why}; refusing to overwrite`,
  "worktree.branch_exists": (agent: string, ws: string, path: string, branch: string) =>
    `agent ${agent}: branch ${branch} already exists at another commit; ${path} was kept and nothing was moved. Rename that branch, then preview: mu agent close ${agent} -w ${ws}`,
  "worktree.held": (
    agent: string,
    ws: string,
    path: string,
    writer: { pid: number; command: string } | undefined,
  ) =>
    writer === undefined
      ? `agent ${agent}: nothing could prove that no process is writing in ${path} (no /proc, no lsof); it was kept. If you know none is, preview with --force: mu agent close ${agent} -w ${ws} --force`
      : `agent ${agent}: process ${writer.pid}${writer.command === "" ? "" : ` (${writer.command})`} has a file in ${path} open for writing; it was kept. Stop it and preview again, or to remove the tree under it preview with --force: mu agent close ${agent} -w ${ws} --force`,
  "worktree.holder_left": (path: string, h: { pid: number; command: string; writer: boolean }) =>
    `process ${h.pid}${h.command === "" ? "" : ` (${h.command})`} was still ${h.writer ? "writing in" : "inside"} ${path} (${h.writer ? "a file open for writing; --force" : "its cwd or a file open for reading"}); the tree was removed under it`,
  "worktree.holders_unproven": (path: string) =>
    `nothing could check for processes in ${path} (no /proc, no lsof); it was removed without git's --force`,
  "worktree.holders_hidden": (path: string, pids: readonly number[]) =>
    `could not inspect ${pids.length} process${pids.length === 1 ? "" : "es"} of yours (${pids.slice(0, 5).join(", ")}${pids.length > 5 ? ", ..." : ""}; /proc refused: non-dumpable or another namespace); mu cannot say whether ${pids.length === 1 ? "it was" : "they were"} in ${path}`,
  "worktree.unmerged_repo_gone": (path: string) =>
    `worktree ${path} has unmerged commits and its repo is gone; nothing can keep them (use --discard to drop them)`,
  "revision.changed": (subject: string, expected: number, current: number, preview: string) =>
    `${subject} changed since preview (rev ${expected} → ${current}); preview again: ${preview}`,
  "mux.pane_not_found": (backend: string, pane: string) => `${backend} pane not found: ${pane}`,
  "mux.none_found": (tried: readonly string[]) =>
    `no supported multiplexer found (tried: ${tried.join(", ")}); install tmux ≥ 3.0 (task, DAG and sql verbs work without one)`,
  "mux.tmux_no_server_in_agent": () =>
    "no tmux server is running, and mu will not start one from inside an agent: every pane would inherit this agent's sandbox. Start tmux from a terminal (tmux new-session -d), then retry",
  "mux.tmux_failed": (args: readonly string[], exit: number | null, detail: string) =>
    `tmux ${args.join(" ")} failed (exit ${exit}): ${detail}`,
  "mux.herdr_failed": (args: readonly string[], exit: number | null, detail: string) =>
    `herdr ${args.join(" ")} failed (exit ${exit}): ${detail}`,
  "mux.herdr_syntax": (args: readonly string[], firstLine: string) =>
    `herdr rejected the command line (exit 2) — this is a bug in mu, not a herdr outage. Ran: herdr ${args.join(" ")}. herdr said: ${firstLine}`,
  "mux.herdr_unsupported_cli": (cli: string, detail: string) =>
    `herdr does not recognise --cli ${cli} as an interactive agent kind, so it cannot classify that pane's status. herdr said: ${detail}`,
  "mux.herdr_command_override": (cli: string, what: string) =>
    `${what} cannot be honoured on the herdr backend: 'herdr agent start --kind ${cli}' resolves the executable itself and has no override flag. mu refuses rather than starting a different binary than you asked for.`,
  "mux.herdr_group_close": (workspaceId: string, session: string, detail: string) =>
    `herdr refused to close workspace ${workspaceId} (${session}): it has linked worktree workspaces, which mu did not create and will not close on your behalf. herdr said: ${detail}`,
  "mux.herdr_no_panes": (tab: string, session: string) =>
    `spawnAgent: tab ${tab} in session ${session} has no panes to split (it vanished mid-spawn?)`,
  "mux.rex_failed": (args: readonly string[], exit: number | null, detail: string) =>
    `rex ${args.join(" ")} failed (exit ${exit}): ${detail}`,
  "mux.rex_no_bracketed_paste": (pane: string) =>
    `rex pane ${pane} has not turned on bracketed paste, so a multi-line send would submit line by line; send one line, or start the agent with a CLI that reads pastes`,
  "mux.unknown_backend": (name: string) => `unknown mux backend: ${name}`,
  "sync.peer_not_found": (ref: string, known: readonly string[]) =>
    `no peer matches ${JSON.stringify(ref)}${
      known.length === 0 ? " (no peers discovered)" : ` (known peers: ${known.join(", ")})`
    }`,
  "sync.peer_ambiguous": (ref: string, candidates: readonly string[]) =>
    `peer ref ${JSON.stringify(ref)} matches ${candidates.length} peers (${candidates.join(", ")}); pass more characters`,
  "sync.source_missing": (path: string) => `--from: no such file: ${path}`,
  "sync.source_too_new": (path: string, detected: number, supported: number) =>
    `--from: ${path} is schema v${detected}; this mu understands up to v${supported}. Upgrade mu.`,
  "host.not_found": (host: string) => `no host profile named ${host}`,
  "host.exists": (host: string) =>
    `host profile ${host} already exists: remove it first (mu host rm ${host})`,
  "host.in_use": (host: string, holders: readonly string[]) =>
    `host ${host} still holds channels (${holders.join(", ")}): close those agents first`,
  "host.spawn_unsupported": (host: string, mux: string) =>
    `--host ${host} needs a multiplexer that runs a shell command in its pane; ${mux} starts agents itself and cannot run the profile's shell template (use tmux)`,
  "host.harness_missing": (host: string, harness: string, probedAt: string) =>
    `host ${host} has no ${harness}: mu host check ${host} (${probedAt}) found no ${harness} command in the profile's shell, where a spawn's command runs; nothing was spawned. Install ${harness} there (and log it in), run mu host check ${host} again, or spawn another harness`,
  "host.check_failed": (host: string, failed: readonly string[]) =>
    `host ${host} check failed: ${failed.join(", ")}`,
  "host.handback": (host: string, field: string, detail: string) =>
    `host ${host}: its ${field} template exited 3, a hand-back (a human must act, e.g. a hardware key)${detail === "" ? "" : `: ${detail}`}. Do not retry or ssh yourself: stop and ask`,
  "carrier.stop_refused": (host: string, handle: string, why: string) =>
    why === "stop-changed"
      ? `host ${host}: the stop template changed since job ${handle} was recorded; stop it by hand with the old template, or mu agent close <name> --abandon-job`
      : why === "no-host"
        ? `host ${host} has no profile; job ${handle} was not stopped: stop it by hand, or mu agent close <name> --abandon-job`
        : `job handle ${JSON.stringify(handle)} on host ${host} is not a valid handle (A-Z a-z 0-9 . _ : @ -, 1 to 128 bytes); nothing was run`,
  "carrier.stop_failed": (host: string, handle: string, detail: string) =>
    `host ${host}: stopping job ${handle} failed${detail === "" ? "" : `: ${detail}`}; its handle is kept`,
  "carrier.job_unstopped": (
    name: string,
    handle: string,
    host: string,
    reason: string | null = null,
  ) =>
    reason === null
      ? `${name} has an unstopped job ${handle} on ${host}: mu agent close ${name}`
      : `${name} has job ${handle} on ${host} kept with its reservation (${reason}): mu agent close ${name}`,
  "carrier.job_reserved": (
    name: string,
    host: string,
    launch: string,
    pane: string | null,
    reason: string | null = null,
  ) =>
    launch === "none"
      ? reason !== null
        ? `${name} is reserved by a lease spawn on ${host} that failed before launching its carrier and kept the reservation as the only pointer to what it left: ${reason}. Remove that on the host if it is still there, then drop the reservation: mu agent close ${name} --abandon-job`
        : `${name} is reserved by a lease spawn on ${host} that has not launched its carrier (in progress, or its spawn was killed): mu agent close ${name}`
      : `${name} is reserved by a lease spawn on ${host} whose carrier may have been launched (pane ${pane ?? "unknown"}) and whose job handle is unknown${reason === null ? "" : ` (${reason})`}: mu agent close ${name}, or mu agent close ${name} --abandon-job once that job is dealt with`,
  "carrier.job_unresolved": (
    name: string,
    ws: string,
    host: string,
    facts: string,
    keptForTree: boolean,
  ) =>
    keptForTree
      ? `${name}: its lease spawn on ${host} failed before launching a carrier and kept the reservation for what it left (${facts}); nothing was closed. Remove that on the host if it is still there, then: mu agent close ${name} -w ${ws} --abandon-job`
      : `${name}: spawn in progress, or its lease carrier on ${host} may still publish a job handle (${facts}); nothing was closed. Retry once the spawn settles; once that job is dealt with: mu agent close ${name} -w ${ws} --abandon-job`,
  "carrier.job_kept": (name: string, ws: string, host: string, why: string) =>
    `${name}: ${why}; its reservation on ${host} is kept: check that job, then mu agent close ${name} -w ${ws} again, or --abandon-job`,
  "carrier.job_unreadable": (name: string, file: string, detail: string) =>
    `agent ${name}: the job file ${file} exists but cannot be read (${detail}); rolled back, its reservation and any remote worktree kept`,
  "carrier.rollback_reserved": (name: string, ws: string, host: string, why: string) =>
    `the lease spawn's carrier on ${host} may have dispatched a job (${why}): the reservation and any remote worktree are kept; mu agent close ${name} -w ${ws}, or --abandon-job once that job is dealt with`,
  "carrier.reservation_abandoned": (name: string, host: string, file: string, facts: string) =>
    `agent close ${name} --abandon-job: reservation on ${host} dropped without a stop (${facts}); a late job handle would be in ${file}, left in place`,
  "carrier.lease_gate": (host: string) =>
    `host ${host} is a lease profile, which runs no command gates (a carrier's exit is not a gate result): use a session profile, or run the command through the carrier directly`,
  "carrier.job_timeout": (name: string, host: string, ms: number, file: string) =>
    `agent ${name} on ${host}: its carrier wrote no job handle to ${file} within ${ms}ms (MU_SPAWN_JOB_MS); rolled back. Does the profile's shell pass {job_file} to the carrier?`,
  "carrier.job_invalid": (name: string, file: string, line: string) =>
    `agent ${name}: the job file ${file} holds ${JSON.stringify(line.slice(0, 80))}, not a handle (A-Z a-z 0-9 . _ : @ -, 1 to 128 bytes); rolled back, its reservation and any remote worktree kept`,
  "carrier.job_unrecorded": (name: string, handle: string) =>
    `agent ${name}: job ${handle} could not be recorded (the spawn's reservation was abandoned or holds another handle); rolled back, nothing stopped`,
  "carrier.transport_changed": (host: string) =>
    `host ${host}: its transport changed while the spawn was admitted; nothing was launched, try again`,
  "carrier.rollback_kept": (name: string, ws: string, host: string, handle: string, why: string) =>
    `job ${handle} on ${host} was not stopped (${why}): its handle and any remote worktree are kept; once the host answers: mu agent close ${name} -w ${ws}`,
  "carrier.dead_worker": (name: string, host: string, handle: string | null) =>
    handle === null
      ? `remote worker ${name} on ${host} has no pane, and its carrier may have dispatched a job whose handle is unknown: mu agent close ${name} (mu agent collect first keeps its commits)`
      : `remote worker ${name} on ${host} has no pane, but its job ${handle} may still run there: mu agent close ${name} stops it (mu agent collect first keeps its commits)`,
  "host.channel_lost": (host: string, holder: string) => `host ${host}: channel ${holder} was lost`,
  "remote.prepare": (host: string, what: string, detail: string) =>
    `host ${host}: ${what}${detail === "" ? "" : `: ${detail}`}`,
  "remote.worktree_kept": (agent: string, detail: string) =>
    `agent ${agent}: remote worktree kept: ${detail}`,
  "remote.no_worktree": (agent: string) => `agent ${agent} has no remote worktree`,
  "remote.collect_unsupported": (agent: string, why: string) =>
    `agent ${agent}: nothing to collect: ${why}`,
  "remote.collect_failed": (host: string, detail: string) =>
    `host ${host}: collect failed: ${detail}`,
  "agent.reattach_refused": (name: string, why: string, close: string) =>
    `agent ${name} cannot be reattached: ${why}; nothing was changed. Preview its close: ${close}`,
  "agent.reattach_failed": (
    name: string,
    rollback: string,
    why: string,
    close: string,
    tail = "",
  ) =>
    `agent ${name} was not reattached (rollback: ${rollback}): ${why}. Preview its close: ${close}${tail}`,
  "remote.recovery_refused": (ws: string, agent: string, detail: string) =>
    `agent ${ws}/${agent}: remote recovery refused: ${detail}`,
  "remote.recovery_pending": (
    ws: string,
    agent: string,
    host: string,
    ids: readonly number[],
    total: number,
  ) => {
    // collect and close select across every host, so any second record needs --recovery.
    const pick = total <= 1 ? "" : ids.length === 1 ? ` --recovery ${ids[0]}` : " --recovery <id>";
    return `agent ${ws}/${agent}: a removed agent's remote worktree on ${host} is still recorded (recovery ${ids.join(", ")}); a new --worktree spawn of the name there could land beside it. Keep its commits with mu agent collect ${agent} -w ${ws}${pick}, then mu agent close ${agent} -w ${ws}${pick}`;
  },
  // A remote spawn into a path another owner holds (src/remote-recovery.ts RemotePathOwnedError).
  "remote.path_owned_agent": (
    ws: string,
    agent: string,
    host: string,
    cwd: string,
    owner: { workstream: string; name: string; repo: string | null },
    next: readonly string[],
    gate: string | undefined,
  ) =>
    `agent ${ws}/${agent}: ${cwd} on ${host} is the managed remote worktree of ${owner.workstream}/${owner.name}; a second agent there could lose its work or its commits' attribution. Close it first: ${next[0]}${next[1] === undefined ? ` (its repo ${owner.repo} is itself a managed tree)` : `, or ${gate !== undefined ? "run the gate in an unmanaged checkout" : "give this agent its own tree"}: ${next[1]}`}`,
  "remote.path_owned_recovery": (
    ws: string,
    agent: string,
    host: string,
    cwd: string,
    rec: { agentId: number; workstream: string; name: string; cwd: string },
    next: readonly string[],
  ) =>
    `agent ${ws}/${agent}: ${cwd} on ${host} is ${rec.cwd === cwd ? "" : "the parked aside of "}the worktree of recovery ${rec.agentId} (removed agent ${rec.workstream}/${rec.name}); a second agent there could lose its work. Keep its commits with ${next[0]}, then ${next[1]}`,
  "remote.path_owned_pane": (
    host: string,
    pane: { id: string; backend: string; gone: boolean; heldBy?: string; kill: string } | undefined,
  ) => {
    if (pane === undefined) return ". The agent was not started";
    const at = `. Found after its pane opened: ${pane.backend} pane ${pane.id}`;
    if (pane.heldBy !== undefined)
      return `${at} now belongs to ${pane.heldBy} and was left alone; this spawn's transport may still run in it. No agent was registered`;
    return pane.gone
      ? `${at} was killed; no agent was registered`
      : `${at} (host ${host}) is not proven gone and may still run its transport; no agent was registered. Kill it: ${pane.kill}`;
  },
  "rebuild.target_exists": (path: string) => `rebuild target already exists: ${path}`,
  "rebuild.target_is_source": (path: string) => `rebuild target is the source DB: ${path}`,
  "rebuild.no_identity": () => "source DB has no machine_identity row; not a mu DB",
  "log.group_ambiguous": (prefix: string, count: number, shown: readonly string[], more: boolean) =>
    `group id ${JSON.stringify(prefix)} is ambiguous: matches ${count} groups (${shown.join(", ")}${more ? ", …" : ""})`,
  "log.group_not_found": (prefix: string) => `no op group matching ${JSON.stringify(prefix)}`,
  "log.kind_reserved": (kind: string, reserved: readonly string[]) =>
    `--kind ${JSON.stringify(kind)} is reserved: ${reserved.join(", ")} name projectable op entities, and a log line under one would be synced and replayed as a real ${kind} change`,
  "delegate.conflict": (callId: string, field: string) =>
    `delegate call ${callId} already exists with a different ${field}; a call id names one request. Use a new call id for a changed request`,
  "delegate.state": (callId: string, from: string, to: string) =>
    `delegate call ${callId} is ${from}; it cannot go to ${to}`,
  "delegate.not_found": (callId: string) => `no such delegate call: ${callId}`,
  "wait.wave_not_found": (wave: string, yours: readonly (string | null)[]) => {
    const names = [...new Set(yours.filter((w): w is string => w !== null))].sort();
    return `no such wave: ${wave} (your waves: ${names.length > 0 ? names.join(", ") : "none"})`;
  },
  "wait.resume_not_found": (id: string, days: number) =>
    `no such wait resume handle: ${id} (a handle is kept ${days} days; name the refs again with \`mu wait <ref>...\`)`,
  "task.brief_missing": (task: string, reason: string) =>
    `task ${task} cannot be briefed: ${reason}`,
  // ── checks (src/checks.ts) ──
  "check.not_found": (id: string, task: string) =>
    `no check ${id} on task ${task} (\`mu state\` lists the checks still without a verdict)`,
  "check.by_invalid": (by: string, harnesses: readonly string[]) =>
    `--by needs <harness> or <harness>/<model> (e.g. --by codex, --by claude/opus), harness one of ${harnesses.join(", ")}; got ${JSON.stringify(by)}`,
  "check.brief_empty": () => "the check's brief is empty; pass it with --brief - <<'EOF'",
  "check.verdict_line": () =>
    "a verdict needs a line `VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED <line>`, then the EVIDENCE: lines",
} as const satisfies Record<string, (...facts: never[]) => string>;

export type MessageKey = keyof typeof MESSAGES;

/** The line for `key`, filled with the facts it names. */
export function say<K extends MessageKey>(
  key: K,
  ...facts: Parameters<(typeof MESSAGES)[K]>
): string {
  return (MESSAGES[key] as (...f: Parameters<(typeof MESSAGES)[K]>) => string)(...facts);
}
